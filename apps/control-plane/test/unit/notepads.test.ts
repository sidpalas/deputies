import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotepadService, notepadMaxBytes } from '../../src/notepads/service.js';
import { MemoryStore } from '../../src/store/memory.js';
import { EventService } from '../../src/events/service.js';
import { notepadRevisionRetentionLimit, StoreConflictError, type SessionRecord } from '../../src/store/types.js';
import type { RequestAuthorization } from '../../src/auth/authorization.js';

const now = new Date('2026-07-21T00:00:00Z');
const auth: RequestAuthorization = { bypass: true, user: null };
const actor = { kind: 'system' } as const;

describe('NotepadService with MemoryStore', () => {
  let store: MemoryStore;
  let service: NotepadService;
  let session: SessionRecord;
  beforeEach(async () => {
    store = new MemoryStore();
    service = new NotepadService(store);
    session = await store.createSession({
      id: 'session-1',
      status: 'idle',
      spawnDepth: 0,
      tags: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });
  });

  it('returns virtual revision zero, lazily creates, and detects stale writes', async () => {
    await expect(service.readSession(auth, session.id)).resolves.toMatchObject({
      revision: 0,
      content: '',
      sizeBytes: 0,
    });
    expect(await store.getSessionNotepad(session.id)).toBeNull();
    await expect(
      service.mutateSession(auth, session.id, { content: 'hello', expectedRevision: 0 }, actor),
    ).resolves.toMatchObject({ revision: 1, sizeBytes: 5 });
    await expect(
      service.mutateSession(auth, session.id, { content: 'stale', expectedRevision: 0 }, actor),
    ).rejects.toMatchObject({ code: 'stale_revision' });
  });

  it('keeps empty creates at revision zero and rejects oversized UTF-8 content', async () => {
    await expect(service.create(auth, { title: 'Empty' }, actor)).resolves.toMatchObject({ revision: 0, sizeBytes: 0 });
    await expect(
      service.create(auth, { title: 'Large', content: '界'.repeat(Math.ceil(notepadMaxBytes / 3) + 1) }, actor),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('patches one target, serializes appends, and enforces size', async () => {
    await service.mutateSession(auth, session.id, { content: 'one two', expectedRevision: 0 }, actor);
    await expect(
      service.mutateSession(auth, session.id, { oldText: 'two', newText: 'three', expectedRevision: 1 }, actor),
    ).resolves.toMatchObject({ content: 'one three' });
    await expect(
      service.mutateSession(auth, session.id, { oldText: 'missing', newText: '', expectedRevision: 2 }, actor),
    ).rejects.toMatchObject({ code: 'patch_not_found' });
    await service.mutateSession(auth, session.id, { content: 'x x', expectedRevision: 2 }, actor);
    await expect(
      service.mutateSession(auth, session.id, { oldText: 'x', newText: 'y', expectedRevision: 3 }, actor),
    ).rejects.toMatchObject({ code: 'patch_ambiguous' });
    await Promise.all([
      service.mutateSession(auth, session.id, { append: 'α' }, actor),
      service.mutateSession(auth, session.id, { append: 'β' }, actor),
    ]);
    await expect(
      service.mutateSession(
        auth,
        session.id,
        { content: '💥'.repeat(notepadMaxBytes / 4 + 1), expectedRevision: 6 },
        actor,
      ),
    ).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('records attributed history and restores content as a new revision', async () => {
    const agent = { kind: 'agent', sessionId: session.id, runId: 'run-1' } as const;
    await service.mutateSession(auth, session.id, { content: 'first', expectedRevision: 0 }, agent);
    await service.mutateSession(auth, session.id, { content: 'second', expectedRevision: 1 }, actor);
    await expect(service.history(auth, 'session', session.id)).resolves.toMatchObject({
      items: [{ revision: 2 }, { revision: 1, actor: { kind: 'agent' } }],
    });
    await expect(service.readRevision(auth, 'session', session.id, 1)).resolves.toMatchObject({ content: 'first' });
    await expect(service.restoreRevision(auth, 'session', session.id, 1, 2, actor)).resolves.toMatchObject({
      revision: 3,
      content: 'first',
    });
  });

  it('retains and paginates only the latest revisions for both kinds', async () => {
    const pad = await service.create(auth, { title: 'Retained' }, actor);
    for (let revision = 0; revision < notepadRevisionRetentionLimit + 2; revision++) {
      await service.mutateSession(auth, session.id, { content: String(revision), expectedRevision: revision }, actor);
      await service.mutateExplicit(auth, pad.id, { content: String(revision), expectedRevision: revision }, actor);
    }
    for (const [kind, id] of [
      ['session', session.id],
      ['explicit', pad.id],
    ] as const) {
      const history = await store.listNotepadRevisions(kind, id, 51, 0);
      expect(history.items).toHaveLength(50);
      expect(history.items.at(-1)?.revision).toBe(3);
      expect((await store.listNotepadRevisions(kind, id, 10, 0)).nextCursor).toBe('43');
    }
  });

  it('publishes content and association invalidations without content, despite notification failure', async () => {
    const events = new EventService(store);
    service = new NotepadService(store, events);
    const pad = await service.create(auth, { title: 'Shared' }, actor);
    await service.putAssociation(auth, pad.id, session.id, actor);
    await service.mutateExplicit(auth, pad.id, { content: 'private', expectedRevision: 0 }, actor);
    expect(await events.list(session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'notepad_associations_changed' }),
        expect.objectContaining({
          type: 'notepad_changed',
          payload: { notepadKind: 'explicit', notepadId: pad.id, revision: 1 },
        }),
      ]),
    );
    expect(JSON.stringify(await events.list(session.id))).not.toContain('private');
    vi.spyOn(events, 'append').mockRejectedValue(new Error('down'));
    await expect(service.mutateExplicit(auth, pad.id, { append: ' committed' }, actor)).resolves.toMatchObject({
      revision: 2,
    });
  });

  it('fans explicit changes across bounded association pages', async () => {
    const events = new EventService(store);
    service = new NotepadService(store, events);
    const pad = await service.create(auth, { title: 'Wide' }, actor);
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const s = await store.createSession({ ...session, id: `fanout-session-${i}` });
      ids.push(s.id);
      await store.putNotepadAssociation({
        record: { notepadId: pad.id, sessionId: s.id, createdAt: now },
        actor,
        activityId: `a-${i}`,
      });
    }
    await service.mutateExplicit(auth, pad.id, { append: 'x' }, actor);
    for (const id of [ids[0]!, ids[49]!, ids[54]!])
      await expect(events.list(id)).resolves.toMatchObject([{ type: 'notepad_changed' }]);
  });

  it('archives/restores explicit pads without losing revisions, content, associations, or activity', async () => {
    const pad = await service.create(auth, { title: 'Durable', content: 'one' }, actor);
    await service.putAssociation(auth, pad.id, session.id, actor);
    const beforeActivity = (await service.activityList(auth, pad.id)).items.length;
    await service.archive(auth, pad.id);
    await expect(service.mutateExplicit(auth, pad.id, { append: 'no' }, actor)).rejects.toMatchObject({
      code: 'archived',
    });
    await expect(service.restore(auth, pad.id)).resolves.toMatchObject({ content: 'one', revision: 1 });
    await expect(store.getNotepadAssociation(pad.id, session.id)).resolves.toBeTruthy();
    expect((await service.activityList(auth, pad.id)).items.length).toBe(beforeActivity);
  });

  it('rejects archived agent actors and preserves defensive clones', async () => {
    const other = await store.createSession({ ...session, id: 'other' });
    await store.archiveSession({ sessionId: session.id, archivedAt: now });
    await expect(
      store.mutateSessionNotepad({
        sessionId: other.id,
        append: 'x',
        actor: { kind: 'agent', sessionId: session.id, runId: 'r' },
        mutationKind: 'append',
        now,
      }),
    ).rejects.toMatchObject({ code: 'session_archived' });
    const input = { ...other, tags: ['one'], context: { nested: 1 } };
    const returned = await store.updateSession(input);
    returned.tags.push('two');
    input.tags.push('three');
    await expect(store.getSession(other.id)).resolves.toMatchObject({ tags: ['one'], context: { nested: 1 } });
  });
});
