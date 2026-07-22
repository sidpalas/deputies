import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { normalizeAppendInput } from '../../src/events/service.js';
import type { RequestAuthorization } from '../../src/auth/authorization.js';
import { NotepadService, notepadMaxBytes } from '../../src/notepads/service.js';
import {
  defaultGroupId,
  notepadRevisionRetentionLimit,
  type ExplicitNotepadRecord,
  type SessionRecord,
} from '../../src/store/types.js';
import { PostgresStore } from '../../src/store/postgres.js';
import { setupPostgresStoreSuite, testDatabaseUrl } from '../support/postgres-store-suite.js';

const t = (seconds: number) => new Date(`2026-07-21T00:00:${String(seconds).padStart(2, '0')}.000Z`);
const sessionId = '00000000-0000-4000-8000-000000000801';
const userId = '00000000-0000-4000-8000-000000000802';
const notepadId = '00000000-0000-4000-8000-000000000803';
const actor = { kind: 'agent', sessionId, runId: '00000000-0000-4000-8000-000000000804' } as const;
const targetSessionId = '00000000-0000-4000-8000-000000000806';
const replacementUserId = '00000000-0000-4000-8000-000000000807';

describe.skipIf(!testDatabaseUrl)('Postgres Notepad persistence', () => {
  let pool: Pool;
  let store: PostgresStore;

  setupPostgresStoreSuite('postgres_notepads', (context) => {
    pool = context.pool;
    store = context.store;
  });

  async function seed() {
    await store.upsertAuthUserForAccount({
      userId,
      accountId: '00000000-0000-4000-8000-000000000805',
      provider: 'notepad-test',
      providerAccountId: 'notepad-test',
      username: 'notepad-test',
      role: 'user',
      profile: {},
      now: t(0),
    });
    const session: SessionRecord = {
      id: sessionId,
      status: 'idle',
      spawnDepth: 0,
      ownerGroupId: defaultGroupId,
      visibility: 'group',
      writePolicy: 'group_members',
      createdByUserId: userId,
      createdAt: t(0),
      updatedAt: t(0),
      lastActivityAt: t(0),
      tags: [],
    };
    await store.createSession(session);
    return session;
  }

  async function seedCoordination(
    options: {
      superAdmin?: boolean;
      targetCreator?: string;
      writePolicy?: 'group_members' | 'creator_only';
      memberRole?: 'admin' | 'member';
    } = {},
  ) {
    const acting = await seed();
    await pool.query('UPDATE groups SET archived_at=NULL WHERE id=$1', [defaultGroupId]);
    await pool.query("UPDATE auth_users SET role='user' WHERE id=$1", [userId]);
    await store.upsertAuthUserForAccount({
      userId: replacementUserId,
      accountId: '00000000-0000-4000-8000-000000000817',
      provider: 'notepad-test',
      providerAccountId: 'replacement',
      username: 'replacement',
      role: 'user',
      profile: {},
      now: t(0),
    });
    if (options.superAdmin) {
      await pool.query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [defaultGroupId, userId]);
      await pool.query("UPDATE auth_users SET role='super_admin' WHERE id=$1", [userId]);
    } else
      await store.upsertGroupMember({
        groupId: defaultGroupId,
        userId,
        role: options.memberRole ?? 'admin',
        createdAt: t(0),
        updatedAt: t(0),
      });
    const target = await store.createSession({
      ...acting,
      id: targetSessionId,
      createdByUserId: options.targetCreator ?? userId,
      writePolicy: options.writePolicy ?? 'group_members',
    });
    await store.putSessionNotepadCapability({
      sessionId,
      kind: 'session_notepad_coordination',
      grantedByUserId: userId,
      createdAt: t(1),
    });
    await store.mutateSessionNotepad({
      sessionId: targetSessionId,
      content: 'baseline',
      expectedRevision: 0,
      actor: { kind: 'system' },
      mutationKind: 'replace',
      now: t(1),
    });
    return target;
  }

  const coordinatedAppend = () =>
    store.mutateSessionNotepad({
      sessionId: targetSessionId,
      append: ' forbidden',
      actor,
      expectedCoordinationGrantorUserId: userId,
      mutationKind: 'append',
      now: t(2),
    });

  function explicit(overrides: Partial<ExplicitNotepadRecord> = {}): ExplicitNotepadRecord {
    return {
      id: notepadId,
      title: 'Postgres notes',
      ownerGroupId: defaultGroupId,
      visibility: 'group',
      writePolicy: 'group_members',
      revision: 0,
      content: '',
      sizeBytes: 0,
      createdAt: t(1),
      updatedAt: t(1),
      ...overrides,
    };
  }

  it('applies migration 019 from the clean suite database', async () => {
    expect((await pool.query("SELECT id FROM app_migrations WHERE id='019_notepads.sql'")).rows).toEqual([
      { id: '019_notepads.sql' },
    ]);
    expect((await pool.query("SELECT to_regclass('session_notepads') AS name")).rows[0].name).toBe('session_notepads');
    expect(
      (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='explicit_notepads' AND column_name='archived_at'",
        )
      ).rows,
    ).toEqual([]);
  });

  it('commits updateSessionWithEvent after migration without changing ownership', async () => {
    const original = await seed();
    const result = await store.updateSessionWithEvent(
      { ...original, ownerGroupId: 'must-not-be-written', title: 'Updated after migration', updatedAt: t(2) },
      normalizeAppendInput({
        sessionId,
        type: 'session_updated',
        payload: { title: 'Updated after migration' },
      }),
    );

    expect(result.session).toMatchObject({ ownerGroupId: defaultGroupId, title: 'Updated after migration' });
    expect(result.event).toMatchObject({ sessionId, type: 'session_updated' });
    expect(await store.getSession(sessionId)).toMatchObject({
      ownerGroupId: defaultGroupId,
      title: 'Updated after migration',
    });
    expect(
      (await store.listEvents()).some((event) => event.id === result.event.id && event.sessionId === sessionId),
    ).toBe(true);
  });

  it('lazily persists session mutations, exact patches, conflicts, concurrent appends, and atomic size rejection', async () => {
    await seed();
    const service = new NotepadService(store);
    const auth: RequestAuthorization = { bypass: true, user: null, memberships: [] };
    expect(await store.getSessionNotepad(sessionId)).toBeNull();
    await service.mutateSession(auth, sessionId, { content: 'alpha target omega', expectedRevision: 0 }, actor);
    await service.mutateSession(auth, sessionId, { oldText: 'target', newText: 'exact', expectedRevision: 1 }, actor);
    await expect(
      service.mutateSession(auth, sessionId, { content: 'stale', expectedRevision: 1 }, actor),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    await Promise.all([
      service.mutateSession(auth, sessionId, { append: ' α' }, actor),
      service.mutateSession(auth, sessionId, { append: ' β' }, actor),
    ]);
    const before = await store.getSessionNotepad(sessionId);
    expect(before).toMatchObject({ revision: 4 });
    expect(before!.content.startsWith('alpha exact omega')).toBe(true);
    expect(before!.content).toContain(' α');
    expect(before!.content).toContain(' β');
    expect((await store.listNotepadRevisions('session', sessionId, 50, 0)).items.map((r) => r.revision)).toEqual([
      4, 3, 2, 1,
    ]);
    await expect(
      service.mutateSession(
        auth,
        sessionId,
        { content: '💥'.repeat(notepadMaxBytes / 4 + 1), expectedRevision: 4 },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'notepad_too_large' });
    expect(await store.getSessionNotepad(sessionId)).toEqual(before);
    expect((await store.listNotepadRevisions('session', sessionId, 50, 0)).items).toHaveLength(4);
    expect(await store.getNotepadRevision('session', sessionId, 2)).toMatchObject({
      content: 'alpha exact omega',
      mutationKind: 'patch',
      actor,
    });
  });

  it('atomically retains, restores, and keyset-paginates Session revisions', async () => {
    await seed();
    for (let revision = 0; revision < notepadRevisionRetentionLimit + 2; revision++) {
      await store.mutateSessionNotepad({
        sessionId,
        content: String(revision + 1),
        expectedRevision: revision,
        actor,
        mutationKind: 'replace',
        now: t(1),
      });
    }
    const rows = await pool.query(
      'SELECT revision FROM notepad_revisions WHERE notepad_kind=$1 AND notepad_id=$2 ORDER BY revision',
      ['session', sessionId],
    );
    expect(rows.rows.map((row) => row.revision)).toEqual(
      Array.from({ length: notepadRevisionRetentionLimit }, (_, index) => index + 3),
    );
    const beforeFailedMutation = await store.getSessionNotepad(sessionId);
    await expect(
      store.mutateSessionNotepad({
        sessionId,
        content: 'stale',
        expectedRevision: notepadRevisionRetentionLimit + 1,
        actor,
        mutationKind: 'replace',
        now: t(2),
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(await store.getSessionNotepad(sessionId)).toEqual(beforeFailedMutation);
    expect(
      (
        await pool.query(
          'SELECT revision FROM notepad_revisions WHERE notepad_kind=$1 AND notepad_id=$2 ORDER BY revision',
          ['session', sessionId],
        )
      ).rows.map((row) => row.revision),
    ).toEqual(rows.rows.map((row) => row.revision));
    const firstPage = await store.listNotepadRevisions('session', sessionId, 10, 0);
    expect(firstPage.nextCursor).toBe('43');
    await expect(
      store.restoreSessionNotepadRevision({
        sessionId,
        revision: 3,
        expectedRevision: notepadRevisionRetentionLimit + 2,
        actor,
        now: t(2),
      }),
    ).resolves.toMatchObject({ revision: notepadRevisionRetentionLimit + 3, content: '3' });
    const retained = await store.listNotepadRevisions('session', sessionId, notepadRevisionRetentionLimit + 1, 0);
    expect(retained.items).toHaveLength(notepadRevisionRetentionLimit);
    expect(retained.items[0]).toMatchObject({ mutationKind: 'restore', actor });
    await expect(store.getNotepadRevision('session', sessionId, 3)).resolves.toBeNull();
    const secondPage = await store.listNotepadRevisions('session', sessionId, 10, Number(firstPage.nextCursor));
    expect(secondPage.items.map((item) => item.revision)).toEqual([42, 41, 40, 39, 38, 37, 36, 35, 34, 33]);
    await expect(
      store.restoreSessionNotepadRevision({
        sessionId,
        revision: 2,
        expectedRevision: notepadRevisionRetentionLimit + 2,
        actor,
        now: t(3),
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    await expect(
      store.restoreSessionNotepadRevision({
        sessionId,
        revision: 2,
        expectedRevision: notepadRevisionRetentionLimit + 3,
        actor,
        now: t(3),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('applies the same retention and restore semantics to Explicit Notepads', async () => {
    await seed();
    await store.createExplicitNotepad({
      record: explicit(),
      actor,
      activityId: '00000000-0000-4000-8000-000000000890',
      initialAssociation: { notepadId, sessionId, createdAt: t(1) },
      associationActivityId: '00000000-0000-4000-8000-000000000891',
    });
    for (let revision = 0; revision < notepadRevisionRetentionLimit + 2; revision++) {
      await store.mutateExplicitNotepad({
        id: notepadId,
        content: String(revision + 1),
        expectedRevision: revision,
        actor,
        mutationKind: 'replace',
        now: t(1),
      });
    }
    await expect(
      store.restoreExplicitNotepadRevision({
        id: notepadId,
        revision: 3,
        expectedRevision: notepadRevisionRetentionLimit + 2,
        actor,
        activityId: '00000000-0000-4000-8000-000000000892',
        now: t(2),
      }),
    ).resolves.toMatchObject({ revision: notepadRevisionRetentionLimit + 3, content: '3' });
    const retained = await store.listNotepadRevisions('explicit', notepadId, notepadRevisionRetentionLimit + 1, 0);
    expect(retained.items).toHaveLength(notepadRevisionRetentionLimit);
    expect(retained.items[0]).toMatchObject({ mutationKind: 'restore', actor });
    await expect(store.getNotepadRevision('explicit', notepadId, 3)).resolves.toBeNull();
    await expect(
      store.restoreExplicitNotepadRevision({
        id: notepadId,
        revision: 2,
        expectedRevision: notepadRevisionRetentionLimit + 2,
        actor,
        activityId: '00000000-0000-4000-8000-000000000893',
        now: t(3),
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    await expect(
      store.restoreExplicitNotepadRevision({
        id: notepadId,
        revision: 2,
        expectedRevision: notepadRevisionRetentionLimit + 3,
        actor,
        activityId: '00000000-0000-4000-8000-000000000894',
        now: t(3),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('atomically persists initial Explicit Notepad content as revision one', async () => {
    await seed();
    const content = '# Initial notes';
    await expect(
      store.createExplicitNotepad({
        record: explicit({ revision: 1, content, sizeBytes: Buffer.byteLength(content) }),
        actor,
        activityId: '00000000-0000-4000-8000-000000000895',
        initialAssociation: { notepadId, sessionId, createdAt: t(1) },
        associationActivityId: '00000000-0000-4000-8000-000000000896',
      }),
    ).resolves.toMatchObject({ revision: 1, content });
    await expect(store.listNotepadRevisions('explicit', notepadId, 50, 0)).resolves.toMatchObject({
      items: [{ revision: 1, mutationKind: 'replace', actor }],
    });
    await expect(store.getNotepadRevision('explicit', notepadId, 1)).resolves.toMatchObject({ content });
    await expect(store.getNotepadAssociation(notepadId, sessionId)).resolves.toMatchObject({ notepadId, sessionId });
  });

  it('derives ordinary discovery from non-archived Session associations while retaining dormant Notepads', async () => {
    await seed();
    const content = 'discoverable needle';
    await store.createExplicitNotepad({
      record: explicit({ title: 'Discoverable', revision: 1, content, sizeBytes: Buffer.byteLength(content) }),
      actor,
      activityId: '00000000-0000-4000-8000-000000000897',
      initialAssociation: { notepadId, sessionId, createdAt: t(1) },
      associationActivityId: '00000000-0000-4000-8000-000000000898',
    });

    await expect(store.listExplicitNotepads({ limit: 50, offset: 0 })).resolves.toMatchObject({
      items: [{ id: notepadId }],
    });
    await expect(
      store.searchExplicitNotepads({ groupId: defaultGroupId, query: 'needle', limit: 20 }),
    ).resolves.toMatchObject([{ id: notepadId }]);

    await store.archiveSession({ sessionId, archivedAt: t(2) });

    await expect(store.listExplicitNotepads({ limit: 50, offset: 0 })).resolves.toMatchObject({ items: [] });
    await expect(
      store.searchExplicitNotepads({ groupId: defaultGroupId, query: 'needle', limit: 20 }),
    ).resolves.toEqual([]);
    await expect(store.listExplicitNotepads({ limit: 50, offset: 0, includeDormant: true })).resolves.toMatchObject({
      items: [{ id: notepadId }],
    });
    await expect(store.getExplicitNotepad(notepadId)).resolves.toMatchObject({ id: notepadId, content });
    await expect(store.listSessionNotepadAssociations(sessionId, 50, 0)).resolves.toMatchObject({
      items: [{ notepadId, sessionId }],
    });

    await store.unarchiveSession({ sessionId, unarchivedAt: t(3) });
    await expect(store.listExplicitNotepads({ limit: 50, offset: 0 })).resolves.toMatchObject({
      items: [{ id: notepadId }],
    });
  });

  it('round-trips explicit records, optional fields, associations, capabilities, activity, ordering, and cascades', async () => {
    await seed();
    const created = await store.createExplicitNotepad({
      record: explicit({ createdByUserId: userId }),
      actor,
      activityId: '00000000-0000-4000-8000-000000000809',
      initialAssociation: { notepadId, sessionId, createdAt: t(1) },
      associationActivityId: '00000000-0000-4000-8000-000000000808',
    });
    expect(created).toEqual(explicit({ createdByUserId: userId }));
    const updated = await store.updateExplicitNotepadMetadata({
      id: notepadId,
      ownerGroupId: defaultGroupId,
      title: 'Renamed',
      actor,
      activityId: '00000000-0000-4000-8000-000000000810',
      now: t(4),
    });
    expect(updated).toEqual({ ...created, title: 'Renamed', updatedAt: t(4) });
    await store.putSessionNotepadCapability({
      sessionId,
      kind: 'session_notepad_coordination',
      grantedByUserId: userId,
      createdAt: t(2),
    });
    await store.putSessionNotepadCapability({
      sessionId,
      kind: 'explicit_search',
      grantedByUserId: userId,
      createdAt: t(1),
    });
    expect((await store.listNotepadAssociations(notepadId, 50, 0)).items).toEqual([
      { notepadId, sessionId, createdAt: t(1) },
    ]);
    expect((await store.listSessionNotepadCapabilities(sessionId)).map((c) => c.kind)).toEqual([
      'explicit_search',
      'session_notepad_coordination',
    ]);
    expect((await store.listNotepadActivity(notepadId, 50, 0)).items.map((a) => a.kind).sort()).toEqual([
      'association_granted',
      'created',
      'metadata_changed',
    ]);

    await pool.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
    expect((await store.listNotepadAssociations(notepadId, 50, 0)).items).toEqual([]);
    expect(await store.listSessionNotepadCapabilities(sessionId)).toEqual([]);
    await pool.query('DELETE FROM explicit_notepads WHERE id=$1', [notepadId]);
    expect((await store.listNotepadActivity(notepadId, 50, 0)).items).toEqual([]);
  });

  it('reads by explicit-search capability without waiting on the reverse-order Notepad lock', async () => {
    await seed();
    await store.upsertGroupMember({
      groupId: defaultGroupId,
      userId,
      role: 'member',
      createdAt: t(0),
      updatedAt: t(0),
    });
    await store.createExplicitNotepad({
      record: explicit({ content: 'shared', sizeBytes: 6, revision: 1 }),
      actor: { kind: 'system' },
      activityId: '00000000-0000-4000-8000-000000000811',
    });
    await store.putSessionNotepadCapability({
      sessionId,
      kind: 'explicit_search',
      grantedByUserId: userId,
      createdAt: t(1),
    });
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM explicit_notepads WHERE id=$1 FOR UPDATE', [notepadId]);
      const result = await Promise.race([
        store.readExplicitNotepadWithCapability({
          actorSessionId: sessionId,
          expectedGrantorUserId: userId,
          notepadId,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('capability read waited on Notepad lock')), 1_000),
        ),
      ]);
      expect(result).toMatchObject({ id: notepadId, content: 'shared' });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('enforces foreign keys and service-level cross-group association invariants', async () => {
    await seed();
    await expect(
      store.createExplicitNotepad({
        record: explicit({ ownerGroupId: '00000000-0000-4000-8000-000000000899' }),
        actor,
        activityId: '00000000-0000-4000-8000-000000000830',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const otherGroup = '00000000-0000-4000-8000-000000000820';
    await store.createGroup({
      id: otherGroup,
      name: 'Other',
      defaultVisibility: 'group',
      defaultWritePolicy: 'group_members',
      automationCreateRequiredRole: 'member',
      createdAt: t(0),
      updatedAt: t(0),
    });
    await store.createExplicitNotepad({
      record: explicit({ ownerGroupId: otherGroup }),
      actor,
      activityId: '00000000-0000-4000-8000-000000000831',
    });
    const service = new NotepadService(store);
    await expect(
      service.putAssociation({ bypass: true, user: null, memberships: [] }, notepadId, sessionId, {
        kind: 'system',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects direct explicit creation in an archived group', async () => {
    await seed();
    const group = (await store.getGroup(defaultGroupId))!;
    await store.updateGroup({ ...group, archivedAt: t(2), updatedAt: t(2) });
    await expect(
      store.createExplicitNotepad({
        record: explicit(),
        actor,
        activityId: '00000000-0000-4000-8000-000000000850',
      }),
    ).rejects.toMatchObject({ code: 'archived_group' });
    expect(await store.getExplicitNotepad(notepadId)).toBeNull();
  });

  it('rejects mismatched and oversized direct records and database writes', async () => {
    await seed();
    await expect(
      store.createExplicitNotepad({
        record: explicit({ content: '界', sizeBytes: 1 }),
        actor,
        activityId: '00000000-0000-4000-8000-000000000860',
      }),
    ).rejects.toMatchObject({ code: 'invalid_notepad_size' });
    await expect(
      store.createExplicitNotepad({
        record: explicit({ content: 'x'.repeat(notepadMaxBytes + 1), sizeBytes: notepadMaxBytes + 1 }),
        actor,
        activityId: '00000000-0000-4000-8000-000000000861',
      }),
    ).rejects.toMatchObject({ code: 'notepad_too_large' });
    await expect(
      pool.query(
        `INSERT INTO session_notepads(session_id,revision,content,size_bytes,created_at,updated_at)
         VALUES($1,1,'界',1,$2,$2)`,
        [sessionId, t(2)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it.each([
    ['membership deletion', {}, 'DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [defaultGroupId, userId]],
    [
      'membership downgrade',
      { writePolicy: 'creator_only', targetCreator: replacementUserId },
      "UPDATE group_members SET role='member' WHERE group_id=$1 AND user_id=$2",
      [defaultGroupId, userId],
    ],
    ['group archive', {}, 'UPDATE groups SET archived_at=now() WHERE id=$1', [defaultGroupId]],
    ['super-admin demotion', { superAdmin: true }, "UPDATE auth_users SET role='user' WHERE id=$1", [userId]],
    [
      'target write-policy change',
      { memberRole: 'member' },
      "UPDATE sessions SET write_policy='creator_only',created_by_user_id=$1 WHERE id=$2",
      [replacementUserId, targetSessionId],
    ],
    ['acting Session archive', {}, "UPDATE sessions SET status='archived' WHERE id=$1", [sessionId]],
    ['target Session archive', {}, "UPDATE sessions SET status='archived' WHERE id=$1", [targetSessionId]],
    [
      'capability revoke',
      {},
      "DELETE FROM session_notepad_capabilities WHERE session_id=$1 AND kind='session_notepad_coordination'",
      [sessionId],
    ],
    [
      'capability replacement',
      {},
      "UPDATE session_notepad_capabilities SET granted_by_user_id=$1 WHERE session_id=$2 AND kind='session_notepad_coordination'",
      [replacementUserId, sessionId],
    ],
  ] as const)(
    'proves revocation-first blocks and rejects coordination: %s',
    async (_name, options, sql, parameters) => {
      await seedCoordination(options);
      const revoker = await pool.connect();
      try {
        await revoker.query('BEGIN');
        await revoker.query("SET LOCAL statement_timeout='5s'");
        await revoker.query(sql, [...parameters]);
        const revokerPid = Number((await revoker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
        const command = coordinatedAppend();
        const commandPid = await waitForBlockedBackend(pool, revokerPid);
        expect(commandPid).not.toBe(revokerPid);
        await revoker.query('COMMIT');
        await expect(command).rejects.toMatchObject({
          code: expect.stringMatching(/not_found|session_archived/),
        });
        expect(await store.getSessionNotepad(targetSessionId)).toMatchObject({ revision: 1, content: 'baseline' });
        expect((await store.listNotepadRevisions('session', targetSessionId, 50, 0)).items).toHaveLength(1);
      } finally {
        await revoker.query('ROLLBACK').catch(() => undefined);
        revoker.release();
      }
    },
    10_000,
  );

  it('deterministically serializes a coordination mutation before a later revocation', async () => {
    await seedCoordination();
    const blocker = await pool.connect();
    const revoker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SET LOCAL statement_timeout='3s'");
      await blocker.query('SELECT 1 FROM session_notepads WHERE session_id=$1 FOR UPDATE', [targetSessionId]);
      const command = coordinatedAppend();
      const commandPid = await waitForNotepadLock(pool);
      await revoker.query('BEGIN');
      await revoker.query("SET LOCAL statement_timeout='3s'");
      const revokerPid = Number((await revoker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
      const revoke = revoker.query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [
        defaultGroupId,
        userId,
      ]);
      expect(await waitForBlockedBackend(pool, commandPid)).toBe(revokerPid);
      await blocker.query('COMMIT');
      await expect(command).resolves.toMatchObject({ revision: 2, content: 'baseline forbidden' });
      await revoke;
      await revoker.query('COMMIT');
      expect(await store.getSessionNotepad(targetSessionId)).toMatchObject({
        revision: 2,
        content: 'baseline forbidden',
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await revoker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      revoker.release();
    }
  }, 10_000);

  it('blocks a coordinated read behind revocation and rejects after commit', async () => {
    await seedCoordination();
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query("SET LOCAL statement_timeout='5s'");
      await revoker.query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [defaultGroupId, userId]);
      const revokerPid = Number((await revoker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
      const command = store.readCoordinatedSessionNotepad(sessionId, targetSessionId, userId);
      expect(await waitForBlockedBackend(pool, revokerPid)).not.toBe(revokerPid);
      await revoker.query('COMMIT');
      await expect(command).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await revoker.query('ROLLBACK').catch(() => undefined);
      revoker.release();
    }
  }, 10_000);
});

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForBlockedBackend(pool: Pool, revokerPid: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query(
      `SELECT pid
         FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND $1 = ANY(pg_blocking_pids(pid))
          AND query_start > now() - interval '5 seconds'`,
      [revokerPid],
    );
    if (result.rows[0]) return Number(result.rows[0].pid);
    await delay(10);
  }
  throw new Error(`store coordination command was not blocked by revoker backend ${revokerPid}`);
}

async function waitForNotepadLock(pool: Pool): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query(
      `SELECT waiting.pid
         FROM pg_locks waiting
         JOIN pg_stat_activity activity ON activity.pid=waiting.pid
        WHERE NOT waiting.granted AND activity.query LIKE '%session_notepads%'`,
    );
    if (result.rows[0]) return Number(result.rows[0].pid);
    await delay(10);
  }
  throw new Error('coordination command did not reach the notepad row barrier');
}
