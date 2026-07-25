import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { normalizeAppendInput } from '../../src/events/service.js';
import type { RequestAuthorization } from '../../src/auth/authorization.js';
import { runMigrations } from '../../src/db/migrate.js';
import { NotepadService, notepadMaxBytes } from '../../src/notepads/service.js';
import {
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

describe.skipIf(!testDatabaseUrl)('Postgres Notepad persistence', () => {
  let pool: Pool;
  let store: PostgresStore;
  let databaseUrl: string;

  setupPostgresStoreSuite('postgres_notepads', (context) => {
    databaseUrl = context.databaseUrl;
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
      role: 'member',
      profile: {},
      now: t(0),
    });
    await store.updateAuthUserRole({ userId, role: 'member', updatedAt: t(0) });
    const session: SessionRecord = {
      id: sessionId,
      status: 'idle',
      spawnDepth: 0,
      createdByUserId: userId,
      createdAt: t(0),
      updatedAt: t(0),
      lastActivityAt: t(0),
      tags: [],
    };
    await store.createSession(session);
    return session;
  }

  async function seedCrossSessionNotepad() {
    const acting = await seed();
    const target = await store.createSession({
      ...acting,
      id: targetSessionId,
      createdByUserId: userId,
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

  function explicit(overrides: Partial<ExplicitNotepadRecord> = {}): ExplicitNotepadRecord {
    return {
      id: notepadId,
      title: 'Postgres notes',
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
    ).toEqual([{ column_name: 'archived_at' }]);
  });

  it('drops the legacy capability table when upgrading an existing installation', async () => {
    await seed();
    await store.mutateSessionNotepad({
      sessionId,
      content: 'preserved',
      expectedRevision: 0,
      actor: { kind: 'system' },
      mutationKind: 'replace',
      now: t(1),
    });
    await pool.query(`
      CREATE TABLE session_notepad_capabilities (
        session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind text NOT NULL,
        granted_by_user_id uuid NOT NULL REFERENCES auth_users(id),
        created_at timestamptz NOT NULL,
        PRIMARY KEY(session_id, kind)
      )
    `);
    await pool.query(
      `INSERT INTO session_notepad_capabilities(session_id,kind,granted_by_user_id,created_at)
       VALUES($1,'explicit_search',$2,$3)`,
      [sessionId, userId, t(1)],
    );
    await pool.query("DELETE FROM app_migrations WHERE id='024_remove_session_notepad_capabilities.sql'");

    await runMigrations(databaseUrl);

    expect(
      (await pool.query("SELECT id FROM app_migrations WHERE id='024_remove_session_notepad_capabilities.sql'")).rows,
    ).toEqual([{ id: '024_remove_session_notepad_capabilities.sql' }]);
    expect((await pool.query("SELECT to_regclass('session_notepad_capabilities') AS name")).rows[0].name).toBeNull();
    await expect(store.getSessionNotepad(sessionId)).resolves.toMatchObject({ content: 'preserved', revision: 1 });
  });

  it('commits updateSessionWithEvent after migration without changing ownership', async () => {
    const original = await seed();
    const result = await store.updateSessionWithEvent(
      { ...original, title: 'Updated after migration', updatedAt: t(2) },
      normalizeAppendInput({
        sessionId,
        type: 'session_updated',
        payload: { title: 'Updated after migration' },
      }),
    );

    expect(result.session).toMatchObject({ title: 'Updated after migration' });
    expect(result.event).toMatchObject({ sessionId, type: 'session_updated' });
    expect(await store.getSession(sessionId)).toMatchObject({
      title: 'Updated after migration',
    });
    expect(
      (await store.listEvents()).some((event) => event.id === result.event.id && event.sessionId === sessionId),
    ).toBe(true);
  });

  it('lazily persists session mutations, exact patches, conflicts, concurrent appends, and atomic size rejection', async () => {
    await seed();
    const service = new NotepadService(store);
    const auth: RequestAuthorization = { bypass: true, user: null };
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
    await expect(store.searchExplicitNotepads({ query: 'needle', limit: 20 })).resolves.toMatchObject([
      { id: notepadId },
    ]);
    await expect(
      store.searchExplicitNotepadsForAgent({ actorSessionId: sessionId, query: 'needle', limit: 20 }),
    ).resolves.toMatchObject([{ id: notepadId }]);

    await store.archiveSession({ sessionId, archivedAt: t(2) });

    await expect(store.listExplicitNotepads({ limit: 50, offset: 0 })).resolves.toMatchObject({ items: [] });
    await expect(store.searchExplicitNotepads({ query: 'needle', limit: 20 })).resolves.toEqual([]);
    await expect(
      store.searchExplicitNotepadsForAgent({ actorSessionId: sessionId, query: 'needle', limit: 20 }),
    ).resolves.toEqual([]);
    await expect(store.readExplicitNotepadForAgent({ actorSessionId: sessionId, notepadId })).resolves.toMatchObject({
      id: notepadId,
      content,
    });
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
    await store.archiveExplicitNotepad({ id: notepadId, archivedAt: t(4) });
    await expect(
      store.searchExplicitNotepadsForAgent({ actorSessionId: sessionId, query: 'needle', limit: 20 }),
    ).resolves.toEqual([]);
    await expect(store.readExplicitNotepadForAgent({ actorSessionId: sessionId, notepadId })).resolves.toMatchObject({
      id: notepadId,
      content,
    });
  });

  it('round-trips explicit records, optional fields, associations, activity, ordering, and cascades', async () => {
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
      title: 'Renamed',
      actor,
      activityId: '00000000-0000-4000-8000-000000000810',
      now: t(4),
    });
    expect(updated).toEqual({ ...created, title: 'Renamed', updatedAt: t(4) });
    expect((await store.listNotepadAssociations(notepadId, 50, 0)).items).toEqual([
      { notepadId, sessionId, createdAt: t(1) },
    ]);
    expect((await store.listNotepadActivity(notepadId, 50, 0)).items.map((a) => a.kind).sort()).toEqual([
      'association_granted',
      'created',
      'metadata_changed',
    ]);

    await pool.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
    expect((await store.listNotepadAssociations(notepadId, 50, 0)).items).toEqual([]);
    await pool.query('DELETE FROM explicit_notepads WHERE id=$1', [notepadId]);
    expect((await store.listNotepadActivity(notepadId, 50, 0)).items).toEqual([]);
  });

  it('reads through a visible association without waiting on the reverse-order Notepad lock', async () => {
    await seed();
    await store.createExplicitNotepad({
      record: explicit({ content: 'shared', sizeBytes: 6, revision: 1 }),
      actor: { kind: 'system' },
      activityId: '00000000-0000-4000-8000-000000000811',
    });
    await store.putNotepadAssociation({
      record: { notepadId, sessionId, createdAt: t(1) },
      actor: { kind: 'system' },
      activityId: '00000000-0000-4000-8000-000000000812',
    });
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM explicit_notepads WHERE id=$1 FOR UPDATE', [notepadId]);
      const result = await Promise.race([
        store.readExplicitNotepadForAgent({
          actorSessionId: sessionId,
          notepadId,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('associated read waited on Notepad lock')), 1_000),
        ),
      ]);
      expect(result).toMatchObject({ id: notepadId, content: 'shared' });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('serializes Explicit Notepad writes with association revocation', async () => {
    await seed();
    const service = new NotepadService(store);
    const pad = await service.createForSessionAgent(sessionId, { title: 'revocation race', content: 'before' }, actor);
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query('SELECT 1 FROM explicit_notepads WHERE id=$1 FOR UPDATE', [pad.id]);
      await revoker.query('DELETE FROM notepad_associations WHERE notepad_id=$1 AND session_id=$2', [
        pad.id,
        sessionId,
      ]);
      const blockedWrite = store.mutateExplicitNotepad({
        id: pad.id,
        append: ' blocked',
        actor,
        mutationKind: 'append',
        now: t(2),
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await revoker.query('COMMIT');
      await expect(blockedWrite).rejects.toMatchObject({ code: 'not_found' });
      await expect(store.getExplicitNotepad(pad.id)).resolves.toMatchObject({ content: 'before', revision: 1 });
      expect((await store.listNotepadRevisions('explicit', pad.id, 50, 0)).items).toHaveLength(1);
    } finally {
      await revoker.query('ROLLBACK').catch(() => undefined);
      revoker.release();
    }

    await store.putNotepadAssociation({
      record: { notepadId: pad.id, sessionId, createdAt: t(3) },
      actor: { kind: 'system' },
      activityId: '00000000-0000-4000-8000-000000000881',
    });
    await expect(
      store.mutateExplicitNotepad({
        id: pad.id,
        append: ' committed',
        actor,
        mutationKind: 'append',
        now: t(4),
      }),
    ).resolves.toMatchObject({ content: 'before committed', revision: 2 });
    await store.removeNotepadAssociation({
      notepadId: pad.id,
      sessionId,
      actor,
      activityId: '00000000-0000-4000-8000-000000000882',
      now: t(5),
    });
    await expect(
      store.mutateExplicitNotepad({
        id: pad.id,
        append: ' blocked later',
        actor,
        mutationKind: 'append',
        now: t(6),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('filters Explicit Notepad search and reads through private Session ownership', async () => {
    const base = await seed();
    const privateActorId = '00000000-0000-4000-8000-000000000870';
    const sameOwnerTargetId = '00000000-0000-4000-8000-000000000871';
    const otherOwnerId = '00000000-0000-4000-8000-000000000872';
    const otherOwnerTargetId = '00000000-0000-4000-8000-000000000873';
    const sameOwnerPadId = '00000000-0000-4000-8000-000000000874';
    const otherOwnerPadId = '00000000-0000-4000-8000-000000000875';
    await store.upsertAuthUserForAccount({
      userId: otherOwnerId,
      accountId: '00000000-0000-4000-8000-000000000876',
      provider: 'notepad-test',
      providerAccountId: 'other-private-owner',
      username: 'other-private-owner',
      role: 'member',
      profile: {},
      now: t(0),
    });
    await store.createSession({ ...base, id: privateActorId, visibility: 'private', ownerUserId: userId });
    await store.createSession({ ...base, id: sameOwnerTargetId, visibility: 'private', ownerUserId: userId });
    await store.createSession({
      ...base,
      id: otherOwnerTargetId,
      visibility: 'private',
      ownerUserId: otherOwnerId,
      createdByUserId: otherOwnerId,
    });
    await store.createExplicitNotepad({
      record: explicit({ id: sameOwnerPadId, title: 'same-private-needle' }),
      actor: { kind: 'system' },
      activityId: '00000000-0000-4000-8000-000000000877',
    });
    await store.createExplicitNotepad({
      record: explicit({ id: otherOwnerPadId, title: 'other-private-needle' }),
      actor: { kind: 'system' },
      activityId: '00000000-0000-4000-8000-000000000878',
    });
    await store.putNotepadAssociation({
      record: { notepadId: sameOwnerPadId, sessionId: sameOwnerTargetId, createdAt: t(1) },
      actor: { kind: 'system' },
      activityId: '00000000-0000-4000-8000-000000000879',
    });
    await store.putNotepadAssociation({
      record: { notepadId: otherOwnerPadId, sessionId: otherOwnerTargetId, createdAt: t(1) },
      actor: { kind: 'system' },
      activityId: '00000000-0000-4000-8000-000000000880',
    });

    await expect(
      store.searchExplicitNotepadsForAgent({ actorSessionId: sessionId, query: 'private-needle', limit: 20 }),
    ).resolves.toEqual([]);
    await expect(
      store.readExplicitNotepadForAgent({ actorSessionId: sessionId, notepadId: sameOwnerPadId }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      store.searchExplicitNotepadsForAgent({ actorSessionId: privateActorId, query: 'private-needle', limit: 20 }),
    ).resolves.toMatchObject([{ id: sameOwnerPadId }]);
    await expect(
      store.readExplicitNotepadForAgent({ actorSessionId: privateActorId, notepadId: sameOwnerPadId }),
    ).resolves.toMatchObject({ id: sameOwnerPadId });
    await expect(
      store.readExplicitNotepadForAgent({ actorSessionId: privateActorId, notepadId: otherOwnerPadId }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('enforces foreign keys for explicit notepad associations', async () => {
    await seed();
    await expect(
      store.putNotepadAssociation({
        record: { notepadId, sessionId, createdAt: t(1) },
        actor,
        activityId: '00000000-0000-4000-8000-000000000830',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await store.createExplicitNotepad({
      record: explicit(),
      actor,
      activityId: '00000000-0000-4000-8000-000000000831',
    });
    await expect(
      store.putNotepadAssociation({
        record: {
          notepadId,
          sessionId: '00000000-0000-4000-8000-000000000899',
          createdAt: t(1),
        },
        actor,
        activityId: '00000000-0000-4000-8000-000000000832',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
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

  it('allows a Session agent to read and update another tenant Session Notepad without a capability', async () => {
    await seedCrossSessionNotepad();
    await expect(store.readSessionNotepadForAgent(sessionId, targetSessionId)).resolves.toMatchObject({
      revision: 1,
      content: 'baseline',
    });
    await expect(
      store.mutateSessionNotepad({
        sessionId: targetSessionId,
        append: ' shared',
        actor,
        mutationKind: 'append',
        now: t(2),
      }),
    ).resolves.toMatchObject({ revision: 2, content: 'baseline shared' });
  });

  it('reads archived Session Notepads while keeping cross-session writes blocked', async () => {
    await seedCrossSessionNotepad();
    await store.archiveSession({ sessionId: targetSessionId, archivedAt: t(2) });
    await expect(store.readSessionNotepadForAgent(sessionId, targetSessionId)).resolves.toMatchObject({
      revision: 1,
      content: 'baseline',
    });
    await expect(
      store.mutateSessionNotepad({
        sessionId: targetSessionId,
        append: ' blocked',
        actor,
        mutationKind: 'append',
        now: t(3),
      }),
    ).rejects.toMatchObject({ code: 'session_archived' });

    await store.unarchiveSession({ sessionId: targetSessionId, unarchivedAt: t(3) });
    await store.archiveSession({ sessionId, archivedAt: t(4) });
    await expect(store.readSessionNotepadForAgent(sessionId, targetSessionId)).resolves.toMatchObject({
      content: 'baseline',
    });
  });
});
