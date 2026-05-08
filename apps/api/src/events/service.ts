import type { NormalizedEmptyEventType, NormalizedEvent, NormalizedEventPayload, NormalizedEventType } from './types.js';
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
  'callback_failed',
]);

type PersistedEvent<T extends NormalizedEventType = NormalizedEventType> = EventRecord & NormalizedEvent<T>;
type EventSubscriber = (event: PersistedEvent) => void;
type GlobalEventSubscriber = { handler: EventSubscriber; allEvents: boolean };

type AppendEventBase<T extends NormalizedEventType> = {
  sessionId: string;
  type: T;
  runId?: string;
  messageId?: string;
};

export type AppendEventInput<T extends NormalizedEventType = NormalizedEventType> = AppendEventBase<T> & (
  [T] extends [NormalizedEmptyEventType] ? { payload?: NormalizedEventPayload<T> } : { payload: NormalizedEventPayload<T> }
);

export class EventService {
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();
  private readonly globalSubscribers = new Set<GlobalEventSubscriber>();

  constructor(private readonly store: EventStore) {}

  async append<T extends NormalizedEventType>(input: AppendEventInput<T>): Promise<PersistedEvent<T>> {
    const sequence = await this.store.nextEventSequence(input.sessionId);
    const event = {
      sessionId: input.sessionId,
      sequence,
      type: input.type,
      payload: (input.payload ?? {}) as NormalizedEventPayload<T>,
      createdAt: new Date(),
    } as NormalizedEvent<T> & { sequence: number };

    if (input.runId) event.runId = input.runId;
    if (input.messageId) event.messageId = input.messageId;

    const persisted = await this.store.appendEvent(event);
    this.publish(persisted);
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
    this.publish(event);
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
    return this.subscribeGlobal(subscriber, false);
  }

  subscribeAllEvents(subscriber: EventSubscriber): () => void {
    return this.subscribeGlobal(subscriber, true);
  }

  private subscribeGlobal(subscriber: EventSubscriber, allEvents: boolean): () => void {
    const record = { handler: subscriber, allEvents };
    this.globalSubscribers.add(record);
    return () => {
      this.globalSubscribers.delete(record);
    };
  }

  private publish(event: PersistedEvent): void {
    for (const subscriber of this.globalSubscribers) {
      if (subscriber.allEvents || isGlobalEvent(event)) subscriber.handler(event);
    }
    for (const subscriber of this.subscribers.get(event.sessionId) ?? []) {
      subscriber(event);
    }
  }
}

function isGlobalEvent(event: Pick<EventRecord, 'type'>): boolean {
  return globalEventTypes.has(event.type);
}
