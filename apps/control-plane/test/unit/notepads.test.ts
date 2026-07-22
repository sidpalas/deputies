import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotepadService, NotepadServiceError, notepadMaxBytes } from '../../src/notepads/service.js';
import type { RequestAuthorization } from '../../src/auth/authorization.js';
import { MemoryStore } from '../../src/store/memory.js';
import { EventService } from '../../src/events/service.js';
import {
  defaultGroupId,
  notepadRevisionRetentionLimit,
  StoreConflictError,
  type AuthUserRecord,
  type GroupRole,
  type SessionRecord,
} from '../../src/store/types.js';

const now = new Date('2026-07-21T00:00:00Z');
const auth: RequestAuthorization = { bypass: true, user: null, memberships: [] };
const actor = { kind: 'system' } as const;

describe('NotepadService with MemoryStore', () => {
  let store: MemoryStore;
  let service: NotepadService;
  let session: SessionRecord;

  beforeEach(async () => {
    store = new MemoryStore();
    service = new NotepadService(store);
    session = {
      id: 'session-1',
      status: 'idle',
      spawnDepth: 0,
      ownerGroupId: defaultGroupId,
      visibility: 'group',
      writePolicy: 'group_members',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      tags: [],
    };
    await store.createSession(session);
  });

  it('returns virtual revision zero and lazily creates on an exact replace', async () => {
    await expect(service.readSession(auth, session.id)).resolves.toMatchObject({
      revision: 0,
      content: '',
      sizeBytes: 0,
    });
    expect(await store.getSessionNotepad(session.id)).toBeNull();
    await expect(
      service.mutateSession(auth, session.id, { content: 'hello', expectedRevision: 0 }, actor),
    ).resolves.toMatchObject({ revision: 1, content: 'hello', sizeBytes: 5 });
    await expect(
      service.mutateSession(auth, session.id, { content: 'stale', expectedRevision: 0 }, actor),
    ).rejects.toMatchObject({ code: 'stale_revision' });
  });

  it('keeps empty creates at revision zero and rejects oversized initial content', async () => {
    await expect(service.create(auth, { ownerGroupId: defaultGroupId, title: 'Empty' }, actor)).resolves.toMatchObject({
      revision: 0,
      content: '',
      sizeBytes: 0,
    });
    await expect(
      service.create(
        auth,
        { ownerGroupId: defaultGroupId, title: 'Too large', content: '界'.repeat(Math.ceil(notepadMaxBytes / 3) + 1) },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('publishes content-change metadata without including Notepad content', async () => {
    const events = new EventService(store);
    service = new NotepadService(store, events);

    await service.mutateSession(auth, session.id, { content: 'private content', expectedRevision: 0 }, actor);

    await expect(events.list(session.id)).resolves.toMatchObject([
      {
        type: 'notepad_changed',
        payload: { notepadKind: 'session', notepadId: session.id, revision: 1 },
      },
    ]);
    expect(JSON.stringify(await events.list(session.id))).not.toContain('private content');
  });

  it('does not report a committed mutation as failed when notification publication fails', async () => {
    const events = new EventService(store);
    vi.spyOn(events, 'append').mockRejectedValue(new Error('event store unavailable'));
    service = new NotepadService(store, events);

    await expect(
      service.mutateSession(auth, session.id, { content: 'committed', expectedRevision: 0 }, actor),
    ).resolves.toMatchObject({ revision: 1, content: 'committed' });
    await expect(store.getSessionNotepad(session.id)).resolves.toMatchObject({ revision: 1, content: 'committed' });
  });

  it('publishes an Explicit Notepad change to every associated Session', async () => {
    const otherSession = await store.createSession({ ...session, id: 'session-2' });
    const events = new EventService(store);
    service = new NotepadService(store, events);
    const notepad = await service.create(auth, { ownerGroupId: defaultGroupId, title: 'Shared' }, actor);
    await service.putAssociation(auth, notepad.id, session.id, actor);
    await service.putAssociation(auth, notepad.id, otherSession.id, actor);

    await service.mutateExplicit(auth, notepad.id, { content: 'shared content', expectedRevision: 0 }, actor);

    for (const target of [session.id, otherSession.id]) {
      await expect(events.list(target)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'notepad_changed',
            payload: { notepadKind: 'explicit', notepadId: notepad.id, revision: 1 },
          }),
        ]),
      );
    }
  });

  it('publishes association-list invalidations without Notepad content', async () => {
    const events = new EventService(store);
    service = new NotepadService(store, events);

    const created = await service.createForSessionAgent(session.id, { title: 'Agent notes' }, actor);
    await expect(events.list(session.id)).resolves.toMatchObject([
      { type: 'notepad_associations_changed', payload: {} },
    ]);

    await service.removeAssociation(auth, created.id, session.id, actor);
    await expect(events.list(session.id)).resolves.toMatchObject([
      { type: 'notepad_associations_changed', payload: {} },
      { type: 'notepad_associations_changed', payload: {} },
    ]);
    expect(JSON.stringify(await events.list(session.id))).not.toContain('Agent notes');
  });

  it('does not report a committed association as failed when invalidation publication fails', async () => {
    const events = new EventService(store);
    vi.spyOn(events, 'append').mockRejectedValue(new Error('event store unavailable'));
    service = new NotepadService(store, events);
    const notepad = await service.create(auth, { ownerGroupId: defaultGroupId, title: 'Shared' }, actor);

    await expect(service.putAssociation(auth, notepad.id, session.id, actor)).resolves.toMatchObject({
      notepadId: notepad.id,
      sessionId: session.id,
    });
    await expect(store.listSessionNotepadAssociations(session.id, 50, 0)).resolves.toMatchObject({
      items: [expect.objectContaining({ notepadId: notepad.id })],
    });
  });

  it('fans Explicit Notepad changes out across bounded keyset pages', async () => {
    const events = new EventService(store);
    service = new NotepadService(store, events);
    const notepad = await service.create(auth, { ownerGroupId: defaultGroupId, title: 'Widely shared' }, actor);
    const sessionIds: string[] = [];
    for (let index = 0; index < 55; index++) {
      const target = await store.createSession({ ...session, id: `session-${String(index).padStart(3, '0')}` });
      sessionIds.push(target.id);
      await store.putNotepadAssociation({
        record: {
          notepadId: notepad.id,
          sessionId: target.id,
          createdAt: new Date(now.getTime() + index),
        },
        actor,
        activityId: `association-${index}`,
      });
    }

    await service.mutateExplicit(auth, notepad.id, { content: 'broadcast', expectedRevision: 0 }, actor);

    for (const target of [sessionIds[0]!, sessionIds[49]!, sessionIds[54]!]) {
      await expect(events.list(target)).resolves.toMatchObject([
        { type: 'notepad_changed', payload: { notepadId: notepad.id, revision: 1 } },
      ]);
    }
  });

  it('patches exactly one target and rejects absent or duplicate targets', async () => {
    await service.mutateSession(auth, session.id, { content: 'one two', expectedRevision: 0 }, actor);
    await expect(
      service.mutateSession(auth, session.id, { oldText: 'two', newText: 'three', expectedRevision: 1 }, actor),
    ).resolves.toMatchObject({ content: 'one three', revision: 2 });
    await expect(
      service.mutateSession(auth, session.id, { oldText: 'missing', newText: '', expectedRevision: 2 }, actor),
    ).rejects.toMatchObject({ code: 'patch_not_found' });
    await service.mutateSession(auth, session.id, { content: 'x x', expectedRevision: 2 }, actor);
    await expect(
      service.mutateSession(auth, session.id, { oldText: 'x', newText: 'y', expectedRevision: 3 }, actor),
    ).rejects.toMatchObject({ code: 'patch_ambiguous' });
  });

  it('serializes revisionless appends and enforces the UTF-8 256 KiB limit', async () => {
    await Promise.all([
      service.mutateSession(auth, session.id, { append: 'α' }, actor),
      service.mutateSession(auth, session.id, { append: 'β' }, actor),
    ]);
    const result = await service.readSession(auth, session.id);
    expect([...result.content].sort()).toEqual(['α', 'β']);
    expect(result.revision).toBe(2);
    await expect(
      service.mutateSession(
        auth,
        session.id,
        { content: '💥'.repeat(notepadMaxBytes / 4 + 1), expectedRevision: 2 },
        actor,
      ),
    ).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('records attributed history and restores old content as a new revision', async () => {
    await service.mutateSession(
      auth,
      session.id,
      { content: 'first', expectedRevision: 0 },
      { kind: 'agent', sessionId: session.id, runId: 'run-1' },
    );
    await service.mutateSession(auth, session.id, { content: 'second', expectedRevision: 1 }, actor);
    expect(await service.history(auth, 'session', session.id)).toMatchObject({
      items: [{ revision: 2 }, { revision: 1, actor: { kind: 'agent' } }],
      hasMore: false,
    });
    expect(await service.readRevision(auth, 'session', session.id, 1)).toMatchObject({
      revision: 1,
      content: 'first',
      actor: { kind: 'agent' },
    });
    await expect(service.restoreRevision(auth, 'session', session.id, 1, 2, actor)).resolves.toMatchObject({
      revision: 3,
      content: 'first',
    });
  });

  it('retains, restores, and keyset-paginates only the latest Session revisions', async () => {
    for (let revision = 0; revision < notepadRevisionRetentionLimit + 2; revision++) {
      await service.mutateSession(
        auth,
        session.id,
        { content: String(revision + 1), expectedRevision: revision },
        actor,
      );
    }
    const history = await store.listNotepadRevisions('session', session.id, notepadRevisionRetentionLimit + 1, 0);
    expect(history.items).toHaveLength(notepadRevisionRetentionLimit);
    expect(history.items[0]?.revision).toBe(notepadRevisionRetentionLimit + 2);
    expect(history.items.at(-1)?.revision).toBe(3);
    await expect(store.getNotepadRevision('session', session.id, 2)).resolves.toBeNull();
    const beforeFailedMutation = await store.getSessionNotepad(session.id);
    await expect(
      service.mutateSession(
        auth,
        session.id,
        { content: 'stale', expectedRevision: notepadRevisionRetentionLimit + 1 },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(await store.getSessionNotepad(session.id)).toEqual(beforeFailedMutation);
    expect(await store.listNotepadRevisions('session', session.id, notepadRevisionRetentionLimit + 1, 0)).toEqual(
      history,
    );
    const firstPage = await store.listNotepadRevisions('session', session.id, 10, 0);
    expect(firstPage.nextCursor).toBe('43');

    await expect(
      service.restoreRevision(auth, 'session', session.id, 3, notepadRevisionRetentionLimit + 2, actor),
    ).resolves.toMatchObject({ revision: notepadRevisionRetentionLimit + 3, content: '3' });
    const retained = await store.listNotepadRevisions('session', session.id, notepadRevisionRetentionLimit + 1, 0);
    expect(retained.items).toHaveLength(notepadRevisionRetentionLimit);
    expect(retained.items[0]).toMatchObject({
      revision: notepadRevisionRetentionLimit + 3,
      mutationKind: 'restore',
      actor,
    });
    await expect(store.getNotepadRevision('session', session.id, 3)).resolves.toBeNull();
    const secondPage = await store.listNotepadRevisions('session', session.id, 10, Number(firstPage.nextCursor));
    expect(secondPage.items.map((item) => item.revision)).toEqual([42, 41, 40, 39, 38, 37, 36, 35, 34, 33]);

    await expect(
      service.restoreRevision(auth, 'session', session.id, 2, notepadRevisionRetentionLimit + 2, actor),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    await expect(
      service.restoreRevision(auth, 'session', session.id, 2, notepadRevisionRetentionLimit + 3, actor),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('applies the same retention and restore semantics to Explicit Notepads', async () => {
    const notepad = await service.create(auth, { ownerGroupId: defaultGroupId, title: 'Retained' }, actor);
    for (let revision = 0; revision < notepadRevisionRetentionLimit + 2; revision++) {
      await service.mutateExplicit(
        auth,
        notepad.id,
        { content: String(revision + 1), expectedRevision: revision },
        actor,
      );
    }
    await expect(
      store.restoreExplicitNotepadRevision({
        id: notepad.id,
        revision: 3,
        expectedRevision: notepadRevisionRetentionLimit + 2,
        actor,
        activityId: 'restore-retained',
        now,
      }),
    ).resolves.toMatchObject({ revision: notepadRevisionRetentionLimit + 3, content: '3' });
    const retained = await store.listNotepadRevisions('explicit', notepad.id, notepadRevisionRetentionLimit + 1, 0);
    expect(retained.items).toHaveLength(notepadRevisionRetentionLimit);
    expect(retained.items[0]).toMatchObject({ mutationKind: 'restore', actor });
    await expect(store.getNotepadRevision('explicit', notepad.id, 3)).resolves.toBeNull();
    await expect(
      store.restoreExplicitNotepadRevision({
        id: notepad.id,
        revision: 2,
        expectedRevision: notepadRevisionRetentionLimit + 2,
        actor,
        activityId: 'stale-restore',
        now,
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    await expect(
      store.restoreExplicitNotepadRevision({
        id: notepad.id,
        revision: 2,
        expectedRevision: notepadRevisionRetentionLimit + 3,
        actor,
        activityId: 'missing-restore',
        now,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reveals revision actor IDs only to human managers', async () => {
    await store.updateSession({ ...session, visibility: 'organization' });
    const fullActor = { kind: 'agent', sessionId: session.id, runId: 'run-secret' } as const;
    await service.mutateSession(auth, session.id, { content: 'secret', expectedRevision: 0 }, fullActor);
    const member = humanAuth('member', 'member');
    const outside = humanAuth('outside', undefined);
    const admin = humanAuth('admin', 'admin');
    const superAdmin = humanAuth('super', undefined, 'super_admin');

    for (const reader of [auth, member, outside]) {
      expect((await service.history(reader, 'session', session.id)).items[0]!.actor).toEqual({ kind: 'agent' });
      expect((await service.readRevision(reader, 'session', session.id, 1)).actor).toEqual({ kind: 'agent' });
    }
    for (const manager of [admin, superAdmin]) {
      expect((await service.history(manager, 'session', session.id)).items[0]!.actor).toEqual(fullActor);
      expect((await service.readRevision(manager, 'session', session.id, 1)).actor).toEqual(fullActor);
    }
  });

  it('reads and fully restores a near-limit multibyte revision', async () => {
    const content = '界'.repeat(Math.floor((notepadMaxBytes - 2) / 3));
    await service.mutateSession(auth, session.id, { content, expectedRevision: 0 }, actor);
    await service.mutateSession(auth, session.id, { content: 'small', expectedRevision: 1 }, actor);
    expect((await service.readRevision(auth, 'session', session.id, 1)).content).toBe(content);
    await service.restoreRevision(auth, 'session', session.id, 1, 2, actor);
    expect((await service.readSession(auth, session.id)).content).toBe(content);
  });

  it('rejects a coordinated mutation by an archived agent actor', async () => {
    const other = { ...session, id: 'session-2' };
    await store.createSession(other);
    await store.archiveSession({ sessionId: session.id, archivedAt: now });
    await expect(
      store.mutateSessionNotepad({
        sessionId: other.id,
        content: 'cross-session',
        expectedRevision: 0,
        actor: { kind: 'agent', sessionId: session.id, runId: 'run-1' },
        mutationKind: 'replace',
        now,
      }),
    ).rejects.toMatchObject({ code: 'session_archived' });
  });

  it('atomically rejects direct cross-group coordination even for a super-admin grantor', async () => {
    const otherGroup = { ...(await store.getGroup(defaultGroupId))!, id: 'other-group', name: 'Other group' };
    await store.createGroup(otherGroup);
    const target = { ...session, id: 'cross-group-target', ownerGroupId: otherGroup.id };
    await store.createSession(target);
    await store.upsertAuthUserForAccount({
      userId: 'super-grantor',
      accountId: 'super-account',
      provider: 'test',
      providerAccountId: 'super',
      username: 'super',
      role: 'super_admin',
      profile: {},
      now,
    });
    await store.putSessionNotepadCapability({
      sessionId: session.id,
      kind: 'session_notepad_coordination',
      grantedByUserId: 'super-grantor',
      createdAt: now,
    });
    await expect(store.readCoordinatedSessionNotepad(session.id, target.id, 'super-grantor')).rejects.toMatchObject({
      code: 'not_found',
    });
    const before = await store.mutateSessionNotepad({
      sessionId: target.id,
      content: 'unchanged',
      expectedRevision: 0,
      actor: { kind: 'system' },
      mutationKind: 'replace',
      now,
    });

    await expect(
      store.mutateSessionNotepad({
        sessionId: target.id,
        append: ' forbidden',
        actor: { kind: 'agent', sessionId: session.id, runId: 'run-1' },
        expectedCoordinationGrantorUserId: 'super-grantor',
        mutationKind: 'append',
        now,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await store.getSessionNotepad(target.id)).toEqual(before);
    expect((await store.listNotepadRevisions('session', target.id, 50, 0)).items).toHaveLength(1);
  });

  it('defensively clones Sessions on write and read', async () => {
    const input = { ...session, tags: ['one'], context: { nested: { value: 1 } } };
    const created = await store.updateSession(input);
    created.ownerGroupId = 'mutated';
    created.tags.push('two');
    (created.context as { nested: { value: number } }).nested.value = 2;
    input.tags.push('input-mutation');
    input.context.nested.value = 3;

    expect(await store.getSession(session.id)).toMatchObject({
      ownerGroupId: defaultGroupId,
      tags: ['one'],
      context: { nested: { value: 1 } },
    });
  });

  it('defensively clones Notepad mutation inputs, history, activity, and returns', async () => {
    const mutationNow = new Date(now);
    const mutationActor = { kind: 'agent', sessionId: session.id, runId: 'run-original' } as const;
    const returned = await store.mutateSessionNotepad({
      sessionId: session.id,
      content: 'original',
      expectedRevision: 0,
      actor: mutationActor,
      mutationKind: 'replace',
      now: mutationNow,
    });
    mutationNow.setUTCFullYear(2040);
    (mutationActor as { runId: string }).runId = 'mutated';
    returned.updatedAt.setUTCFullYear(2041);
    returned.content = 'mutated';

    expect(await store.getSessionNotepad(session.id)).toMatchObject({ content: 'original', updatedAt: now });
    expect((await store.getNotepadRevision('session', session.id, 1))!).toMatchObject({
      actor: { runId: 'run-original' },
      createdAt: now,
    });
  });

  it('derives ordinary discovery from a non-archived Session association', async () => {
    const pad = await service.create(auth, { ownerGroupId: defaultGroupId, title: 'Dormant memory' }, actor);
    await expect(service.list(auth, defaultGroupId)).resolves.toMatchObject({ items: [] });
    await expect(service.inventory(auth, defaultGroupId)).resolves.toMatchObject({ items: [{ id: pad.id }] });

    await service.putAssociation(auth, pad.id, session.id, actor);
    await expect(service.list(auth, defaultGroupId)).resolves.toMatchObject({ items: [{ id: pad.id }] });
    await expect(service.search(auth, defaultGroupId, 'Dormant')).resolves.toMatchObject([{ id: pad.id }]);

    await store.archiveSession({ sessionId: session.id, archivedAt: now });
    await expect(service.list(auth, defaultGroupId)).resolves.toMatchObject({ items: [] });
    await expect(service.search(auth, defaultGroupId, 'Dormant')).resolves.toEqual([]);
    await expect(service.requireReadable(auth, pad.id)).resolves.toMatchObject({ id: pad.id });
    await expect(service.sessionAssociations(auth, session.id)).resolves.toMatchObject({
      items: [{ notepadId: pad.id, canWrite: false }],
    });

    await store.unarchiveSession({ sessionId: session.id, unarchivedAt: new Date(now.getTime() + 1) });
    await expect(service.list(auth, defaultGroupId)).resolves.toMatchObject({ items: [{ id: pad.id }] });
  });

  it('filters authorization visibility before explicit Notepad pagination', async () => {
    const outside = 'outside-group';
    await store.createGroup({
      id: outside,
      name: outside,
      defaultVisibility: 'group',
      defaultWritePolicy: 'group_members',
      automationCreateRequiredRole: 'member',
      createdAt: now,
      updatedAt: now,
    });
    const outsideSession = await store.createSession({
      ...session,
      id: 'outside-list-session',
      ownerGroupId: outside,
    });
    for (let index = 0; index < 4; index++) {
      const privatePad = await service.create(
        auth,
        { ownerGroupId: outside, title: `Private ${index}`, visibility: 'group' },
        actor,
      );
      await service.putAssociation(auth, privatePad.id, outsideSession.id, actor);
    }
    const visible = await service.create(
      auth,
      { ownerGroupId: defaultGroupId, title: 'Visible', visibility: 'organization' },
      actor,
    );
    await service.putAssociation(auth, visible.id, session.id, actor);
    const reader = humanAuth('reader', undefined);
    await expect(service.list(reader, undefined, 1, 0)).resolves.toEqual({
      items: [expect.objectContaining({ id: visible.id })],
      hasMore: false,
      nextCursor: null,
    });
  });

  it('rejects service and direct-store creation in an archived owner group', async () => {
    const group = (await store.getGroup(defaultGroupId))!;
    await store.updateGroup({ ...group, archivedAt: now, updatedAt: now });

    await expect(service.create(auth, { ownerGroupId: defaultGroupId, title: 'Denied' }, actor)).rejects.toMatchObject({
      code: 'archived_group',
    });
    await expect(service.createForSessionAgent(session.id, { title: 'Denied' }, actor)).rejects.toMatchObject({
      code: 'archived_group',
    });
    await expect(
      store.createExplicitNotepad({
        record: {
          id: 'direct-denied',
          title: 'Denied',
          ownerGroupId: defaultGroupId,
          visibility: 'group',
          writePolicy: 'group_members',
          revision: 0,
          content: '',
          sizeBytes: 0,
          createdAt: now,
          updatedAt: now,
        },
        actor,
        activityId: 'direct-denied',
      }),
    ).rejects.toMatchObject({ code: 'archived_group' });
  });

  it('rejects mismatched and oversized direct explicit Notepad records', async () => {
    const direct = (content: string, sizeBytes: number) =>
      store.createExplicitNotepad({
        record: {
          id: `direct-${sizeBytes}`,
          title: 'Direct',
          ownerGroupId: defaultGroupId,
          visibility: 'group',
          writePolicy: 'group_members',
          revision: 0,
          content,
          sizeBytes,
          createdAt: now,
          updatedAt: now,
        },
        actor,
        activityId: `activity-${sizeBytes}`,
      });

    await expect(direct('界', 1)).rejects.toMatchObject({ code: 'invalid_notepad_size' });
    await expect(direct('x'.repeat(notepadMaxBytes + 1), notepadMaxBytes + 1)).rejects.toMatchObject({
      code: 'notepad_too_large',
    });
  });

  it('applies search visibility before its limit', async () => {
    const outside = 'outside-search-group';
    await store.createGroup({
      id: outside,
      name: outside,
      defaultVisibility: 'group',
      defaultWritePolicy: 'group_members',
      automationCreateRequiredRole: 'member',
      createdAt: now,
      updatedAt: now,
    });
    const outsideSession = await store.createSession({
      ...session,
      id: 'outside-search-session',
      ownerGroupId: outside,
    });
    const visible = await service.create(
      auth,
      { ownerGroupId: outside, title: 'needle visible', visibility: 'organization' },
      actor,
    );
    await service.putAssociation(auth, visible.id, outsideSession.id, actor);
    for (let index = 0; index < 3; index++) {
      const privatePad = await service.create(
        auth,
        { ownerGroupId: outside, title: `needle private ${index}`, visibility: 'group' },
        actor,
      );
      await service.putAssociation(auth, privatePad.id, outsideSession.id, actor);
    }

    await expect(service.search(humanAuth('outsider'), outside, 'needle', 1)).resolves.toEqual([
      expect.objectContaining({ id: visible.id }),
    ]);
  });

  it('checks the current writable association for agent metadata commands', async () => {
    const pad = await service.create(auth, { ownerGroupId: defaultGroupId, title: 'Metadata' }, actor);
    const agent = { kind: 'agent', sessionId: session.id, runId: 'run-1' } as const;
    await store.putNotepadAssociation({
      record: { notepadId: pad.id, sessionId: session.id, createdAt: now },
      actor,
      activityId: 'grant',
    });
    await store.removeNotepadAssociation({
      notepadId: pad.id,
      sessionId: session.id,
      actor,
      activityId: 'revoke',
      now,
    });
    await expect(
      store.updateExplicitNotepadMetadata({
        id: pad.id,
        ownerGroupId: defaultGroupId,
        title: 'Denied',
        actor: agent,
        activityId: 'metadata',
        now,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('trims titles, applies defaults, rejects owner moves, and makes archived Sessions read-only', async () => {
    const pad = await service.create(auth, { ownerGroupId: defaultGroupId, title: '  Notes  ' }, actor);
    expect(pad).toMatchObject({ title: 'Notes', visibility: 'organization', writePolicy: 'group_members' });
    await expect(service.metadata(auth, pad.id, { ownerGroupId: 'elsewhere' })).rejects.toBeInstanceOf(
      NotepadServiceError,
    );
    await store.archiveSession({ sessionId: session.id, archivedAt: now });
    await expect(service.mutateSession(auth, session.id, { append: 'x' }, actor)).rejects.toMatchObject({
      code: 'archived',
    });
  });
});

function humanAuth(id: string, role?: GroupRole, userRole: AuthUserRecord['role'] = 'user'): RequestAuthorization {
  const user: AuthUserRecord = { id, username: id, role: userRole, createdAt: now, updatedAt: now };
  return {
    bypass: false,
    user,
    memberships: role ? [{ groupId: defaultGroupId, userId: id, role, createdAt: now, updatedAt: now }] : [],
  };
}
