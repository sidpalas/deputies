import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import type { SessionRecord, SessionStore } from '../store/types.js';

export type CreateSessionInput = {
  title?: string;
};

export type UpdateSessionInput = {
  id: string;
  title?: string;
};

export class SessionServiceError extends Error {
  constructor(readonly code: 'not_found') {
    super(code === 'not_found' ? 'Session not found' : code);
  }
}

export class SessionService {
  constructor(
    private readonly store: SessionStore,
    private readonly events: EventService,
  ) {}

  async create(input: CreateSessionInput = {}): Promise<SessionRecord> {
    const now = new Date();
    const record: SessionRecord = {
      id: randomUUID(),
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };

    if (input.title) record.title = input.title;

    const session = await this.store.createSession(record);
    await this.events.append({
      sessionId: session.id,
      type: 'session_created',
      payload: { title: session.title ?? null },
    });

    return session;
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.store.getSession(id);
  }

  async list(): Promise<SessionRecord[]> {
    return this.store.listSessions();
  }

  async update(input: UpdateSessionInput): Promise<SessionRecord> {
    const existing = await this.store.getSession(input.id);
    if (!existing) throw new SessionServiceError('not_found');

    const next: SessionRecord = {
      ...existing,
      updatedAt: new Date(),
    };
    if (input.title) next.title = input.title;
    else delete next.title;

    const session = await this.store.updateSession(next);
    await this.events.append({
      sessionId: session.id,
      type: 'session_updated',
      payload: { title: session.title ?? null },
    });
    return session;
  }

  async archive(id: string): Promise<SessionRecord> {
    const existing = await this.store.getSession(id);
    if (!existing) throw new SessionServiceError('not_found');

    const session = await this.store.updateSession({
      ...existing,
      status: 'archived',
      updatedAt: new Date(),
    });
    await this.events.append({
      sessionId: session.id,
      type: 'session_archived',
      payload: {},
    });
    return session;
  }

  async unarchive(id: string): Promise<SessionRecord> {
    const existing = await this.store.getSession(id);
    if (!existing) throw new SessionServiceError('not_found');

    const session = await this.store.updateSession({
      ...existing,
      status: 'idle',
      updatedAt: new Date(),
    });
    await this.events.append({
      sessionId: session.id,
      type: 'session_unarchived',
      payload: {},
    });
    return session;
  }

  async pauseQueue(id: string): Promise<SessionRecord> {
    const existing = await this.store.getSession(id);
    if (!existing) throw new SessionServiceError('not_found');
    const session = await this.store.pauseSessionQueue({ sessionId: id, pausedAt: new Date() });
    await this.events.append({ sessionId: id, type: 'session_queue_paused', payload: {} });
    return session;
  }

  async resumeQueue(id: string): Promise<SessionRecord> {
    const existing = await this.store.getSession(id);
    if (!existing) throw new SessionServiceError('not_found');
    const session = await this.store.resumeSessionQueue({ sessionId: id });
    await this.events.append({ sessionId: id, type: 'session_queue_resumed', payload: {} });
    return session;
  }
}
