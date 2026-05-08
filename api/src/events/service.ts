import type { NormalizedEmptyEventType, NormalizedEvent, NormalizedEventPayload, NormalizedEventType } from './types.js';
import type { EventStore } from '../store/types.js';

type PersistedEvent<T extends NormalizedEventType = NormalizedEventType> = NormalizedEvent<T> & { sequence: number };
type EventSubscriber = (event: PersistedEvent) => void;

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

  subscribe(sessionId: string, subscriber: EventSubscriber): () => void {
    const sessionSubscribers = this.subscribers.get(sessionId) ?? new Set<EventSubscriber>();
    sessionSubscribers.add(subscriber);
    this.subscribers.set(sessionId, sessionSubscribers);

    return () => {
      sessionSubscribers.delete(subscriber);
      if (sessionSubscribers.size === 0) this.subscribers.delete(sessionId);
    };
  }

  private publish(event: PersistedEvent): void {
    for (const subscriber of this.subscribers.get(event.sessionId) ?? []) {
      subscriber(event);
    }
  }
}
