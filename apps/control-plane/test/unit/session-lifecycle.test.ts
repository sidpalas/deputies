import { EventService } from '../../src/events/service.js';
import { MessageService } from '../../src/messages/service.js';
import {
  SessionService,
  SessionServiceError,
  sessionTitleFromGeneratedResponse,
  sessionTitleFromPrompt,
} from '../../src/sessions/service.js';
import { MemoryStore } from '../../src/store/memory.js';
import { type SessionRecord } from '../../src/store/types.js';

describe('session lifecycle transitions', () => {
  it('derives bounded titles from normalized initial prompts', () => {
    expect(sessionTitleFromPrompt('  Investigate   the\ncache miss.  ')).toBe('Investigate the cache miss.');
    expect(sessionTitleFromPrompt('x'.repeat(65))).toBe(`${'x'.repeat(61)}...`);
    expect(sessionTitleFromGeneratedResponse('  "Production cache miss"  ')).toBe('Production cache miss');
    expect(sessionTitleFromGeneratedResponse('\n```text\nProduction cache miss\n```')).toBe('Production cache miss');
    expect(sessionTitleFromGeneratedResponse('First title\nUnrequested explanation')).toBe('First title');
    expect(sessionTitleFromGeneratedResponse(' \n```\n ')).toBe('');
  });

  it('only replaces a generated-title fallback while it is still current', async () => {
    const store = new MemoryStore();
    const now = new Date('2026-01-01T00:00:00.000Z');
    await store.createSession({
      id: 'session-title',
      status: 'idle',
      title: 'Fallback title',
      tags: [],
      spawnDepth: 0,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });
    await store.createMessage({
      id: 'message-title',
      sessionId: 'session-title',
      sequence: 1,
      status: 'pending',
      prompt: 'Fallback title',
      createdAt: now,
    });
    await store.claimNextPendingMessage({
      runId: 'run-title',
      runnerType: 'test',
      leaseOwner: 'test-worker',
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      now,
    });

    const updated = await store.updateSessionTitleIfCurrent({
      id: 'session-title',
      expectedTitle: 'Fallback title',
      title: 'Generated title',
      updatedAt: new Date(now.getTime() + 1),
      runId: 'run-title',
      leaseOwner: 'test-worker',
      now: new Date(now.getTime() + 1),
    });
    expect(updated?.session.title).toBe('Generated title');
    await expect(
      store.updateSessionTitleIfCurrent({
        id: 'session-title',
        expectedTitle: 'Fallback title',
        title: 'Late generated title',
        updatedAt: new Date(now.getTime() + 2),
        runId: 'run-title',
        leaseOwner: 'test-worker',
        now: new Date(now.getTime() + 2),
      }),
    ).resolves.toBeNull();
    await expect(store.getSession('session-title')).resolves.toMatchObject({ title: 'Generated title' });
  });

  it('rejects a generated title after run cancellation begins', async () => {
    const store = new MemoryStore();
    const events = new EventService(store);
    const sessions = new SessionService(store, events);
    const messages = new MessageService(store, events);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const session = await sessions.create({ title: 'Fallback title' });
    await messages.enqueue({ sessionId: session.id, prompt: 'Fallback title' });
    await store.claimNextPendingMessage({
      runId: 'run-cancelled-title',
      runnerType: 'test',
      leaseOwner: 'test-worker',
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    await store.requestRunCancellation({
      sessionId: session.id,
      requestedAt: new Date(now.getTime() + 1),
      error: 'cancelled by test',
    });

    await expect(
      store.updateSessionTitleIfCurrent({
        id: session.id,
        expectedTitle: 'Fallback title',
        title: 'Late generated title',
        updatedAt: new Date(now.getTime() + 2),
        runId: 'run-cancelled-title',
        leaseOwner: 'test-worker',
        now: new Date(now.getTime() + 2),
      }),
    ).resolves.toBeNull();
    await expect(store.getSession(session.id)).resolves.toMatchObject({ title: 'Fallback title' });
  });

  it('atomically orders cancellation before archive, preserves metadata on restore, and is idempotent', async () => {
    const store = new MemoryStore();
    const events = new EventService(store);
    const sessions = new SessionService(store, events);
    const createdAt = new Date('2026-01-01T00:00:00.123Z');
    const record: SessionRecord = {
      id: 'session-1',
      status: 'queued',
      title: 'Keep me',
      tags: ['one', 'two'],
      context: { nested: { value: true } },
      createdByUserId: 'user-1',
      parentSessionId: 'parent-1',
      spawnDepth: 2,
      queuePausedAt: new Date('2026-01-02T00:00:00.456Z'),
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: createdAt,
    };
    await store.createSession(record);
    await store.createMessage({
      id: 'message-1',
      sessionId: record.id,
      sequence: 1,
      status: 'pending',
      prompt: 'pending',
      createdAt,
    });

    const published: string[] = [];
    events.subscribe(record.id, (event) => published.push(event.type));

    const archived = await sessions.archive(record.id);
    expect(archived.status).toBe('archived');
    await expect(sessions.update({ id: record.id, title: 'Blocked', requireNonArchived: true })).rejects.toEqual(
      expect.objectContaining<Partial<SessionServiceError>>({ code: 'archived' }),
    );
    await sessions.archive(record.id);
    const restored = await sessions.unarchive(record.id);
    await sessions.unarchive(record.id);

    expect(restored).toMatchObject({
      status: 'idle',
      title: record.title,
      tags: record.tags,
      context: record.context,
      createdByUserId: record.createdByUserId,
      parentSessionId: record.parentSessionId,
      spawnDepth: record.spawnDepth,
      queuePausedAt: record.queuePausedAt,
    });
    expect(published).toEqual(['message_cancelled', 'session_archived', 'session_unarchived']);
    expect((await store.getEvents(record.id)).map((event) => event.type)).toEqual(published);
    expect(restored.title).toBe('Keep me');
  });

  it('keeps concurrent in-memory archive and restore events ordered with unique sequences', async () => {
    const store = new MemoryStore();
    const events = new EventService(store);
    const sessions = new SessionService(store, events);
    const createdAt = new Date('2026-01-01T00:00:00.123Z');
    await store.createSession({
      id: 'session-concurrent',
      status: 'queued',
      tags: [],
      spawnDepth: 0,
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: createdAt,
    });
    await store.createMessage({
      id: 'message-concurrent',
      sessionId: 'session-concurrent',
      sequence: 1,
      status: 'pending',
      prompt: 'pending',
      createdAt,
    });

    await Promise.all([sessions.archive('session-concurrent'), sessions.unarchive('session-concurrent')]);

    await expect(store.getSession('session-concurrent')).resolves.toMatchObject({ status: 'idle' });
    const lifecycleEvents = await store.getEvents('session-concurrent');
    expect(lifecycleEvents.map((event) => event.type)).toEqual([
      'message_cancelled',
      'session_archived',
      'session_unarchived',
    ]);
    expect(lifecycleEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
