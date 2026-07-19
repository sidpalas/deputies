import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import { defaultGroupId, StoreConflictError } from '../store/types.js';
import type { SessionRecord, SessionStore, SessionVisibility, SessionWritePolicy } from '../store/types.js';

export type CreateSessionInput = {
  id?: string;
  title?: string;
  tags?: string[];
  parentSessionId?: string;
  spawnDepth?: number;
  ownerGroupId?: string;
  visibility?: SessionVisibility;
  writePolicy?: SessionWritePolicy;
  createdByUserId?: string;
};

export type UpdateSessionInput = {
  id: string;
  requireNonArchived?: boolean;
  title?: string;
  tags?: string[];
  ownerGroupId?: string;
  visibility?: SessionVisibility;
  writePolicy?: SessionWritePolicy;
};

export function sessionTitleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 61)}...`;
}

export function sessionTitleFromGeneratedResponse(response: string): string {
  const line = response
    .trim()
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('```'));
  if (!line) return '';
  const wrapper = line[0];
  const unwrapped =
    wrapper && (wrapper === '"' || wrapper === "'" || wrapper === '`') && line.endsWith(wrapper)
      ? line.slice(1, -1).trim()
      : line;
  return sessionTitleFromPrompt(unwrapped);
}

export class SessionServiceError extends Error {
  constructor(readonly code: 'not_found' | 'archived') {
    super(code === 'not_found' ? 'Session not found' : 'Archived sessions are read-only');
  }
}

export class SessionService {
  constructor(
    private readonly store: SessionStore,
    private readonly events: EventService,
  ) {}

  async create(input: CreateSessionInput = {}): Promise<SessionRecord> {
    const now = new Date();
    // Session list cursors round-trip JS Date millisecond precision. Do not write
    // session timestamps with database now(), or keyset pagination can skip rows.
    const record: SessionRecord = {
      id: input.id ?? randomUUID(),
      status: 'created',
      spawnDepth: input.spawnDepth ?? 0,
      ownerGroupId: input.ownerGroupId ?? defaultGroupId,
      visibility: input.visibility ?? 'organization',
      writePolicy: input.writePolicy ?? 'group_members',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      tags: input.tags ?? [],
    };

    if (input.title) record.title = input.title;
    if (input.parentSessionId) record.parentSessionId = input.parentSessionId;
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

    // Commit the update and its session_updated event atomically: stream filters
    // refresh access decisions on session_updated, so no event committed after an
    // access change may be notified ahead of the change itself.
    let result;
    try {
      result = await this.store.updateSessionMetadataWithEvent({
        id: existing.id,
        // Keep session write timestamps in JS Date precision for list cursor stability.
        updatedAt: new Date(),
        ...(input.requireNonArchived ? { requireNonArchived: true } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.ownerGroupId !== undefined ? { ownerGroupId: input.ownerGroupId } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.writePolicy !== undefined ? { writePolicy: input.writePolicy } : {}),
      });
    } catch (error) {
      if (error instanceof StoreConflictError && error.code === 'session_archived') {
        throw new SessionServiceError('archived');
      }
      throw error;
    }
    const { session, event } = result;
    this.events.publishExternal(event);
    return session;
  }

  async archive(id: string): Promise<SessionRecord> {
    const existing = await this.store.getSession(id);
    if (!existing) throw new SessionServiceError('not_found');

    const { session, events } = await this.store.archiveSession({ sessionId: id, archivedAt: new Date() });
    for (const event of events) this.events.publishExternal(event);
    return session;
  }

  async unarchive(id: string): Promise<SessionRecord> {
    const existing = await this.store.getSession(id);
    if (!existing) throw new SessionServiceError('not_found');

    const { session, events } = await this.store.unarchiveSession({ sessionId: id, unarchivedAt: new Date() });
    for (const event of events) this.events.publishExternal(event);
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
