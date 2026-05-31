import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import { defaultGroupId } from '../store/types.js';
import type { SessionRecord, SessionStore, SessionVisibility, SessionWritePolicy } from '../store/types.js';

export type CreateSessionInput = {
  title?: string;
  ownerGroupId?: string;
  visibility?: SessionVisibility;
  writePolicy?: SessionWritePolicy;
  createdByUserId?: string;
};

export type UpdateSessionInput = {
  id: string;
  title?: string;
  ownerGroupId?: string;
  visibility?: SessionVisibility;
  writePolicy?: SessionWritePolicy;
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
      ownerGroupId: input.ownerGroupId ?? defaultGroupId,
      visibility: input.visibility ?? 'organization',
      writePolicy: input.writePolicy ?? 'group_members',
      createdAt: now,
      updatedAt: now,
    };

    if (input.title) record.title = input.title;
    if (input.createdByUserId) record.createdByUserId = input.createdByUserId;

    const session = await this.store.createSession(record);
    await this.events.append({
      sessionId: session.id,
      type: 'session_created',
      payload: {
        title: session.title ?? null,
        ownerGroupId: session.ownerGroupId,
        visibility: session.visibility,
        writePolicy: session.writePolicy,
      },
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
    if (input.ownerGroupId) next.ownerGroupId = input.ownerGroupId;
    if (input.visibility) next.visibility = input.visibility;
    if (input.writePolicy) next.writePolicy = input.writePolicy;

    const session = await this.store.updateSession(next);
    await this.events.append({
      sessionId: session.id,
      type: 'session_updated',
      payload: {
        title: session.title ?? null,
        ownerGroupId: session.ownerGroupId,
        visibility: session.visibility,
        writePolicy: session.writePolicy,
      },
    });
    return session;
  }

  async archive(id: string): Promise<SessionRecord> {
    const existing = await this.store.getSession(id);
    if (!existing) throw new SessionServiceError('not_found');

    const { session, cancelledMessages } = await this.store.archiveSession({ sessionId: id, archivedAt: new Date() });
    for (const message of cancelledMessages) {
      await this.events.append({
        sessionId: session.id,
        messageId: message.id,
        type: 'message_cancelled',
        payload: { sequence: message.sequence, reason: 'session_archived' },
      });
    }
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
