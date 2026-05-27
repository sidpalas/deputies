import type {
  NormalizedEmptyEventType,
  NormalizedEvent,
  NormalizedEventPayload,
  NormalizedEventType,
} from './types.js';
import type { EventRecord, EventStore } from '../store/types.js';

const globalEventTypes = new Set<NormalizedEventType>([
  'session_created',
  'session_updated',
  'session_archived',
  'session_unarchived',
  'session_queue_paused',
  'session_queue_resumed',
  'message_created',
  'message_started',
  'message_completed',
  'message_failed',
  'message_cancelled',
  'run_started',
  'run_completed',
  'run_failed',
  'run_cancel_requested',
  'run_cancelled',
  'artifact_created',
  'external_resource_created',
  'callback_failed',
]);

type PersistedEvent<T extends NormalizedEventType = NormalizedEventType> = EventRecord & NormalizedEvent<T>;
type EventSubscriber = (event: PersistedEvent) => void;
type GlobalEventSubscriber = { handler: EventSubscriber; allEvents: boolean; localOnly: boolean };
type EventSource = 'local' | 'external';

type AppendEventBase<T extends NormalizedEventType> = {
  sessionId: string;
  type: T;
  runId?: string;
  messageId?: string;
};

export type AppendEventInput<T extends NormalizedEventType = NormalizedEventType> = AppendEventBase<T> &
  ([T] extends [NormalizedEmptyEventType]
    ? { payload?: NormalizedEventPayload<T> }
    : { payload: NormalizedEventPayload<T> });

export class EventService {
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();
  private readonly globalSubscribers = new Set<GlobalEventSubscriber>();

  constructor(private readonly store: EventStore) {}

  async append<T extends NormalizedEventType>(input: AppendEventInput<T>): Promise<PersistedEvent<T>> {
    const event = normalizeAppendInput(input);

    const persisted = await this.store.appendEventWithNextSequence(event);
    this.publish(persisted, 'local');
    return persisted as PersistedEvent<T>;
  }

  async appendForRun<T extends NormalizedEventType>(
    input: AppendEventInput<T> & { runId: string },
    guard: { runId: string; leaseOwner: string; now: Date },
  ): Promise<PersistedEvent<T> | null> {
    const event = { ...normalizeAppendInput(input), runId: input.runId } as Omit<NormalizedEvent, 'runId'> & {
      runId: string;
    };
    const persisted = await this.store.appendEventWithNextSequenceForRun(event, guard);
    if (!persisted) return null;
    this.publish(persisted, 'local');
    return persisted as PersistedEvent<T>;
  }

  async list(sessionId: string, afterSequence?: number) {
    return this.store.getEvents(sessionId, afterSequence);
  }

  async listAll(afterId?: number): Promise<EventRecord[]> {
    return (await this.store.listEvents(afterId)).filter(isGlobalEvent);
  }

  async listAllEvents(afterId?: number): Promise<EventRecord[]> {
    return this.store.listEvents(afterId);
  }

  publishExternal(event: EventRecord): void {
    this.publish(event, 'external');
  }

  subscribe(sessionId: string, subscriber: EventSubscriber): () => void {
    const sessionSubscribers = this.subscribers.get(sessionId) ?? new Set<EventSubscriber>();
    sessionSubscribers.add(subscriber);
    this.subscribers.set(sessionId, sessionSubscribers);

    return () => {
      sessionSubscribers.delete(subscriber);
      if (sessionSubscribers.size === 0) this.subscribers.delete(sessionId);
    };
  }

  subscribeAll(subscriber: EventSubscriber): () => void {
    return this.subscribeGlobal(subscriber, false, false);
  }

  subscribeAllEvents(subscriber: EventSubscriber): () => void {
    return this.subscribeGlobal(subscriber, true, false);
  }

  subscribeLocalEvents(subscriber: EventSubscriber): () => void {
    return this.subscribeGlobal(subscriber, true, true);
  }

  subscriberCount(): number {
    let sessionSubscriberCount = 0;
    for (const subscribers of this.subscribers.values()) sessionSubscriberCount += subscribers.size;
    return sessionSubscriberCount + this.globalSubscribers.size;
  }

  private subscribeGlobal(subscriber: EventSubscriber, allEvents: boolean, localOnly: boolean): () => void {
    const record = { handler: subscriber, allEvents, localOnly };
    this.globalSubscribers.add(record);
    return () => {
      this.globalSubscribers.delete(record);
    };
  }

  private publish(event: PersistedEvent, source: EventSource): void {
    for (const subscriber of this.globalSubscribers) {
      if (subscriber.localOnly && source !== 'local') continue;
      if (subscriber.allEvents || isGlobalEvent(event)) subscriber.handler(event);
    }
    for (const subscriber of this.subscribers.get(event.sessionId) ?? []) {
      subscriber(event);
    }
  }
}

function sanitizeJsonPayload(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(sanitizeJsonPayload);

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJsonPayload(item)]));
}

function normalizeAppendInput<T extends NormalizedEventType>(input: AppendEventInput<T>): NormalizedEvent<T> {
  const event = {
    sessionId: input.sessionId,
    type: input.type,
    payload: sanitizeJsonPayload(input.payload ?? {}) as NormalizedEventPayload<T>,
    createdAt: new Date(),
  } as NormalizedEvent<T>;

  if (input.runId) event.runId = input.runId;
  if (input.messageId) event.messageId = input.messageId;
  return event;
}

function isGlobalEvent(event: Pick<EventRecord, 'type'>): boolean {
  return globalEventTypes.has(event.type);
}
