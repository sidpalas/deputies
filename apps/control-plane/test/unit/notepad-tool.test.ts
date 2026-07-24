import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotepadService } from '../../src/notepads/service.js';
import { executeNotepadTool, notepadToolDescription } from '../../src/notepads/tool.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { ExplicitNotepadRecord, SessionRecord } from '../../src/store/types.js';

const now = new Date('2026-07-21T00:00:00Z');
const system = { bypass: true, user: null } as const;

describe('Pi Notepad tool', () => {
  let store: MemoryStore;
  let service: NotepadService;
  let own: SessionRecord;
  const run = (params: unknown) =>
    executeNotepadTool({ store, notepads: service, sessionId: own.id, runId: 'run-7', messageId: 'message-8' }, params);
  beforeEach(async () => {
    store = new MemoryStore();
    service = new NotepadService(store);
    await store.upsertAuthUserForAccount({
      userId: 'owner',
      accountId: 'owner-account',
      provider: 'test',
      providerAccountId: 'owner',
      username: 'owner',
      role: 'member',
      profile: {},
      now,
    });
    own = await store.createSession(session('own', 'owner'));
  });

  it('lazily reads/mutates its own Session Notepad with run attribution', async () => {
    await expect(run({ action: 'read' })).resolves.toMatchObject({ ok: true, result: { revision: 0, content: '' } });
    expect(await store.getSessionNotepad(own.id)).toBeNull();
    await expect(run({ action: 'replace', content: 'memory', expectedRevision: 0 })).resolves.toMatchObject({
      ok: true,
      result: { revision: 1 },
    });
    expect((await store.listNotepadRevisions('session', own.id, 50, 0)).items[0]).toMatchObject({
      actor: { kind: 'agent', sessionId: own.id, runId: 'run-7' },
    });
  });

  it('supports own history/read/restore and explicit self-target actions without capabilities', async () => {
    await run({ action: 'replace', content: 'first', expectedRevision: 0 });
    await run({ action: 'replace', content: 'second', expectedRevision: 1 });
    await expect(run({ action: 'history' })).resolves.toMatchObject({
      result: { revisions: [{ revision: 2 }, { revision: 1 }] },
    });
    await expect(run({ action: 'read_revision', revision: 1 })).resolves.toMatchObject({
      result: { content: 'first' },
    });
    await expect(run({ action: 'restore_revision', revision: 1, expectedRevision: 2 })).resolves.toMatchObject({
      result: { revision: 3 },
    });
    await expect(run({ action: 'append_session', sessionId: own.id, append: '!' })).resolves.toMatchObject({
      ok: true,
      result: { revision: 4 },
    });
  });

  it('creates explicit content atomically, associates it, and allows associated writes', async () => {
    const created = await run({ action: 'create', title: 'Plan', content: '# Plan' });
    const id = (created.result as ExplicitNotepadRecord).id;
    expect(created).toMatchObject({ ok: true, result: { revision: 1, sizeBytes: 6 } });
    await expect(run({ action: 'list' })).resolves.toMatchObject({ result: { notepads: [{ notepadId: id }] } });
    await expect(run({ action: 'append', notepadId: id, append: '!' })).resolves.toMatchObject({
      result: { revision: 2 },
    });
    await expect(store.getNotepadRevision('explicit', id, 1)).resolves.toMatchObject({
      content: '# Plan',
      actor: { kind: 'agent' },
    });
  });

  it('denies unassociated access, rechecks association, and grants another Session', async () => {
    const pad = await service.create(system, { title: 'pad' });
    await expect(run({ action: 'read', notepadId: pad.id })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('not associated'),
    });
    await service.putAssociation(system, pad.id, own.id, { kind: 'system' });
    const association = await store.getNotepadAssociation(pad.id, own.id);
    vi.spyOn(store, 'getNotepadAssociation').mockResolvedValueOnce(association).mockResolvedValueOnce(null);
    await expect(run({ action: 'read', notepadId: pad.id })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('authorization'),
    });
    vi.restoreAllMocks();
    const peer = await store.createSession({ ...session('peer', 'owner'), parentSessionId: own.id, spawnDepth: 1 });
    await expect(run({ action: 'grant', notepadId: pad.id, sessionId: peer.id })).resolves.toMatchObject({
      ok: true,
      result: { sessionId: peer.id },
    });
  });

  it('uses explicit_search for broad reads only and reauthorizes member/admin grantors after viewer demotion', async () => {
    const pad = await service.create(system, { title: 'searchable needle' });
    const peer = await store.createSession(session('search-peer', 'owner'));
    await service.putAssociation(system, pad.id, peer.id, { kind: 'system' });
    await store.putSessionNotepadCapability({
      sessionId: own.id,
      kind: 'explicit_search',
      grantedByUserId: 'owner',
      createdAt: now,
    });
    await expect(run({ action: 'search', query: 'needle' })).resolves.toMatchObject({
      ok: true,
      result: { results: [{ id: pad.id }] },
    });
    await expect(run({ action: 'read', notepadId: pad.id })).resolves.toMatchObject({ ok: true });
    await expect(run({ action: 'append', notepadId: pad.id, append: 'no' })).resolves.toMatchObject({ ok: false });
    await store.updateAuthUserRole({ userId: 'owner', role: 'viewer', updatedAt: now });
    await expect(run({ action: 'search', query: 'needle' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('authorization'),
    });
  });

  it('coordinates Session Notepads while capability and live grantor mutation authority remain valid', async () => {
    const peer = await store.createSession(session('peer', 'someone'));
    await expect(run({ action: 'append_session', sessionId: peer.id, append: 'no' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('capability'),
    });
    await store.putSessionNotepadCapability({
      sessionId: own.id,
      kind: 'session_notepad_coordination',
      grantedByUserId: 'owner',
      createdAt: now,
    });
    await expect(run({ action: 'append_session', sessionId: peer.id, append: 'handoff' })).resolves.toMatchObject({
      ok: true,
    });
    await store.updateAuthUserRole({ userId: 'owner', role: 'viewer', updatedAt: now });
    await expect(run({ action: 'read_session', sessionId: peer.id })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('authorization'),
    });
    await expect(run({ action: 'append_session', sessionId: peer.id, append: 'no' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('authorization'),
    });
  });

  it('uses the current replacement capability and rejects stale grantor authority', async () => {
    const peer = await store.createSession(session('peer', 'owner'));
    await store.upsertAuthUserForAccount({
      userId: 'admin',
      accountId: 'admin-account',
      provider: 'test',
      providerAccountId: 'admin',
      username: 'admin',
      role: 'admin',
      profile: {},
      now,
    });
    await store.putSessionNotepadCapability({
      sessionId: own.id,
      kind: 'session_notepad_coordination',
      grantedByUserId: 'owner',
      createdAt: now,
    });
    await store.putSessionNotepadCapability({
      sessionId: own.id,
      kind: 'session_notepad_coordination',
      grantedByUserId: 'admin',
      createdAt: now,
    });
    await expect(run({ action: 'append_session', sessionId: peer.id, append: 'admin' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      store.mutateSessionNotepad({
        sessionId: peer.id,
        append: 'stale',
        actor: { kind: 'agent', sessionId: own.id, runId: 'run-7' },
        expectedCoordinationGrantorUserId: 'owner',
        mutationKind: 'append',
        now,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cannot commit a coordinated patch after capability revocation', async () => {
    const peer = await store.createSession(session('peer-race', 'owner'));
    await store.putSessionNotepadCapability({
      sessionId: own.id,
      kind: 'session_notepad_coordination',
      grantedByUserId: 'owner',
      createdAt: now,
    });
    await service.mutateSession(system, peer.id, { content: 'before', expectedRevision: 0 }, { kind: 'system' });
    const mutate = store.mutateSessionNotepad.bind(store);
    store.mutateSessionNotepad = async (input) => {
      await store.removeSessionNotepadCapability(own.id, 'session_notepad_coordination');
      return mutate(input);
    };
    await expect(
      run({ action: 'patch_session', sessionId: peer.id, oldText: 'before', newText: 'after', expectedRevision: 1 }),
    ).resolves.toMatchObject({ ok: false });
    await expect(store.getSessionNotepad(peer.id)).resolves.toMatchObject({ revision: 1, content: 'before' });
  });

  it('rejects archived actors/targets, invalid actions, and bounds multibyte reads/history', async () => {
    const pad = await service.createForSessionAgent(
      own.id,
      { title: 'large' },
      { kind: 'agent', sessionId: own.id, runId: 'r' },
    );
    await run({ action: 'replace', notepadId: pad.id, content: '💥'.repeat(9_000), expectedRevision: 0 });
    const read = await run({ action: 'read', notepadId: pad.id });
    expect(Buffer.byteLength((read.result as { content: string }).content)).toBeLessThanOrEqual(32 * 1024);
    for (let i = 0; i < 55; i++) await run({ action: 'append', notepadId: pad.id, append: 'x' });
    expect(
      ((await run({ action: 'history', notepadId: pad.id })).result as { revisions: unknown[] }).revisions,
    ).toHaveLength(50);
    await store.archiveSession({ sessionId: own.id, archivedAt: now });
    await expect(run({ action: 'append', append: 'no' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Archived'),
    });
    await expect(run({ action: 'bogus' })).resolves.toMatchObject({ ok: false, error: 'Invalid notepad action' });
  });

  it('guidance promises durable memory without chain-of-thought or wake semantics', () => {
    expect(notepadToolDescription).toMatch(/Durable external memory/i);
    expect(notepadToolDescription).toMatch(/do not .*wake/i);
    expect(notepadToolDescription).not.toMatch(/chain[- ]of[- ]thought|reasoning trace/i);
  });
});

function session(id: string, createdByUserId: string): SessionRecord {
  return {
    id,
    createdByUserId,
    status: 'idle',
    spawnDepth: 0,
    tags: [],
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  };
}
