import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestAuthorization } from '../../src/auth/authorization.js';
import { NotepadService } from '../../src/notepads/service.js';
import { executeNotepadTool, notepadToolDescription } from '../../src/notepads/tool.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { ExplicitNotepadRecord, SessionRecord } from '../../src/store/types.js';

const now = new Date('2026-07-21T00:00:00Z');
const groupA = 'group-a';
const groupB = 'group-b';

describe('Pi Notepad tool', () => {
  let store: MemoryStore;
  let service: NotepadService;
  let own: SessionRecord;
  const run = (params: unknown) =>
    executeNotepadTool({ store, notepads: service, sessionId: own.id, runId: 'run-7', messageId: 'message-8' }, params);

  beforeEach(async () => {
    store = new MemoryStore();
    service = new NotepadService(store);
    await store.createGroup(group(groupA));
    await store.createGroup(group(groupB));
    await store.upsertAuthUserForAccount({
      userId: 'owner',
      accountId: 'owner-account',
      provider: 'test',
      providerAccountId: 'owner',
      username: 'owner',
      role: 'user',
      profile: {},
      now,
    });
    await store.upsertGroupMember({ groupId: groupA, userId: 'owner', role: 'member', createdAt: now, updatedAt: now });
    own = await store.createSession(session('own', groupA, 'owner'));
  });

  it('lazily reads and mutates its own Session Notepad with run attribution', async () => {
    await expect(run({ action: 'read' })).resolves.toMatchObject({ ok: true, result: { revision: 0, content: '' } });
    expect(await store.getSessionNotepad(own.id)).toBeNull();
    await expect(run({ action: 'replace', content: 'memory', expectedRevision: 0 })).resolves.toMatchObject({
      ok: true,
      result: { revision: 1 },
    });
    expect((await store.listNotepadRevisions('session', own.id, 50, 0)).items).toMatchObject([
      { actor: { kind: 'agent', sessionId: 'own', runId: 'run-7' } },
    ]);
  });

  it('uses its own Session Notepad for revision actions without a notepadId', async () => {
    await run({ action: 'replace', content: 'first', expectedRevision: 0 });
    await run({ action: 'replace', content: 'second', expectedRevision: 1 });

    await expect(run({ action: 'history' })).resolves.toMatchObject({
      ok: true,
      result: { revisions: [{ revision: 2 }, { revision: 1 }] },
    });
    await expect(run({ action: 'read_revision', revision: 1 })).resolves.toMatchObject({
      ok: true,
      result: { revision: 1, content: 'first' },
    });
    await expect(run({ action: 'restore_revision', revision: 1, expectedRevision: 2 })).resolves.toMatchObject({
      ok: true,
      result: { revision: 3 },
    });
    await expect(run({ action: 'read' })).resolves.toMatchObject({ result: { revision: 3, content: 'first' } });
  });

  it('treats Session actions targeting itself as own-Session access without a coordination capability', async () => {
    const { createdByUserId: _creator, ...creatorless } = own;
    await store.updateSession(creatorless);
    own = creatorless;

    await expect(run({ action: 'read_session', sessionId: own.id })).resolves.toMatchObject({
      ok: true,
      result: { revision: 0, content: '' },
    });
    await expect(run({ action: 'append_session', sessionId: own.id, append: 'one' })).resolves.toMatchObject({
      ok: true,
      result: { revision: 1 },
    });
    await expect(
      run({ action: 'patch_session', oldText: 'one', newText: 'two', expectedRevision: 1 }),
    ).resolves.toMatchObject({ ok: true, result: { revision: 2 } });
    await expect(run({ action: 'replace_session', content: 'three', expectedRevision: 2 })).resolves.toMatchObject({
      ok: true,
      result: { revision: 3 },
    });
    await expect(store.getSessionNotepad(own.id)).resolves.toMatchObject({
      sessionId: own.id,
      revision: 3,
      content: 'three',
    });
    await expect(store.listExplicitNotepads({ groupId: groupA, limit: 50, offset: 0 })).resolves.toMatchObject({
      items: [],
    });
  });

  it('still requires coordination capability for another Session Notepad', async () => {
    const peer = await store.createSession(session('uncoordinated-peer', groupA, 'owner'));
    await expect(run({ action: 'append_session', sessionId: peer.id, append: 'no' })).resolves.toMatchObject({
      ok: false,
      error: 'Session Notepad coordination capability is required',
    });
  });

  it('supports creatorless integration Sessions without resolving human authorization', async () => {
    const { createdByUserId: _creator, ...creatorless } = own;
    await store.updateSession(creatorless);
    own = creatorless;
    await expect(run({ action: 'append', append: 'automation' })).resolves.toMatchObject({ ok: true });
    const created = await run({ action: 'create', title: 'Automation notes' });
    const id = (created.result as ExplicitNotepadRecord).id;
    await expect(run({ action: 'append', notepadId: id, append: 'ok' })).resolves.toMatchObject({ ok: true });
  });

  it('creates an explicit pad, automatically associates it writable, and lists associations', async () => {
    const created = await run({ action: 'create', title: 'Plan' });
    const id = (created.result as ExplicitNotepadRecord).id;
    await expect(run({ action: 'list' })).resolves.toMatchObject({
      ok: true,
      result: { notepads: [{ notepadId: id }] },
    });
    expect(((await run({ action: 'list' })).result as { notepads: object[] }).notepads[0]).not.toHaveProperty('access');
    await expect(run({ action: 'append', notepadId: id, append: '!' })).resolves.toMatchObject({
      ok: true,
      result: { revision: 1 },
    });
  });

  it('atomically creates an Explicit Notepad with initial content and revision history', async () => {
    const created = await run({ action: 'create', title: 'Initialized plan', content: '# Plan\n\nStart here.' });
    expect(created).toMatchObject({ ok: true, result: { revision: 1, sizeBytes: 19 } });
    const id = (created.result as { id: string }).id;
    await expect(store.getExplicitNotepad(id)).resolves.toMatchObject({
      revision: 1,
      content: '# Plan\n\nStart here.',
      sizeBytes: 19,
    });
    await expect(store.listNotepadRevisions('explicit', id, 50, 0)).resolves.toMatchObject({
      items: [
        {
          revision: 1,
          actor: { kind: 'agent', sessionId: own.id, runId: 'run-7' },
          mutationKind: 'replace',
        },
      ],
    });
    await expect(store.getNotepadRevision('explicit', id, 1)).resolves.toMatchObject({
      content: '# Plan\n\nStart here.',
    });
    await expect(store.getNotepadAssociation(id, own.id)).resolves.toMatchObject({ notepadId: id, sessionId: own.id });
  });

  it('denies unassociated access, inherits Session write access, and delegates only within the group', async () => {
    const pad = await explicit('pad');
    expect(await run({ action: 'read', notepadId: pad.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not associated'),
    });
    await service.putAssociation({ bypass: true, user: null, memberships: [] }, pad.id, own.id, {
      kind: 'system',
    });
    expect(await run({ action: 'read', notepadId: pad.id })).toMatchObject({ ok: true });
    expect(await run({ action: 'append', notepadId: pad.id, append: 'x' })).toMatchObject({
      ok: true,
      result: { revision: 1, sizeBytes: 1 },
    });
    const peer = await store.createSession(session('peer', groupA, 'owner'));
    await expect(run({ action: 'grant', notepadId: pad.id, sessionId: peer.id })).resolves.toMatchObject({
      ok: true,
      result: { sessionId: peer.id },
    });
    const cross = await store.createSession(session('cross', groupB, 'owner'));
    expect(await run({ action: 'grant', notepadId: pad.id, sessionId: cross.id })).toMatchObject({
      ok: false,
      error: 'Target unavailable',
    });
  });

  it('rechecks an associated read through the Session context', async () => {
    const pad = await explicit('racy');
    await service.putAssociation({ bypass: true, user: null, memberships: [] }, pad.id, own.id, {
      kind: 'system',
    });
    const association = await store.getNotepadAssociation(pad.id, own.id);
    vi.spyOn(store, 'getNotepadAssociation').mockResolvedValueOnce(association).mockResolvedValueOnce(null);

    await expect(run({ action: 'read', notepadId: pad.id })).resolves.toMatchObject({
      ok: false,
      error: 'Notepad access denied by current grantor authorization',
    });
  });

  it('uses explicit_search only for broad search/read and never broad writes', async () => {
    const pad = await explicit('searchable needle');
    const peer = await store.createSession(session('search-peer', groupA, 'owner'));
    await service.putAssociation({ bypass: true, user: null, memberships: [] }, pad.id, peer.id, {
      kind: 'system',
    });
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
    expect(await run({ action: 'append', notepadId: pad.id, append: 'no' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not associated'),
    });
    await store.deleteGroupMember({ groupId: groupA, userId: 'owner' });
    await expect(run({ action: 'search', query: 'needle' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('authorization'),
    });
    await expect(run({ action: 'read', notepadId: pad.id })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('authorization'),
    });
  });

  it('enforces the exact broad-tool grantor and cross-group matrix', async () => {
    const crossOrganization = await service.create(
      { bypass: true, user: null, memberships: [] },
      { ownerGroupId: groupB, title: 'cross organization', visibility: 'organization' },
    );
    const crossPrivate = await service.create(
      { bypass: true, user: null, memberships: [] },
      { ownerGroupId: groupB, title: 'cross private', visibility: 'group' },
    );
    await store.putSessionNotepadCapability({
      sessionId: own.id,
      kind: 'explicit_search',
      grantedByUserId: 'owner',
      createdAt: now,
    });
    await expect(run({ action: 'read', notepadId: crossOrganization.id })).resolves.toMatchObject({
      ok: false,
      error: 'Notepad access denied by current grantor authorization',
    });

    await store.upsertAuthUserForAccount({
      userId: 'super',
      accountId: 'super-account',
      provider: 'test',
      providerAccountId: 'super',
      username: 'super',
      role: 'super_admin',
      profile: {},
      now,
    });
    await store.putSessionNotepadCapability({
      sessionId: own.id,
      kind: 'explicit_search',
      grantedByUserId: 'super',
      createdAt: now,
    });
    const sameGroup = await explicit('same-group searchable');
    const peer = await store.createSession(session('broad-search-peer', groupA, 'owner'));
    await service.putAssociation({ bypass: true, user: null, memberships: [] }, sameGroup.id, peer.id, {
      kind: 'system',
    });
    await expect(run({ action: 'search', query: 'searchable' })).resolves.toMatchObject({
      ok: true,
      result: { results: [{ id: sameGroup.id }] },
    });
    await expect(run({ action: 'read', notepadId: sameGroup.id })).resolves.toMatchObject({ ok: true });
    for (const pad of [crossPrivate, crossOrganization]) {
      await expect(run({ action: 'read', notepadId: pad.id })).resolves.toMatchObject({
        ok: false,
        error: 'Notepad access denied by current grantor authorization',
      });
    }
    await service.putAssociation({ bypass: true, user: null, memberships: [] }, sameGroup.id, own.id, {
      kind: 'system',
    });
    const crossSession = await store.createSession(session('cross-delegation', groupB, 'owner'));
    await expect(run({ action: 'grant', notepadId: sameGroup.id, sessionId: crossSession.id })).resolves.toMatchObject({
      ok: false,
      error: 'Target unavailable',
    });
  });

  it('coordinates Session Notepads with live grantor authorization and group boundary', async () => {
    const peer = await store.createSession(session('peer', groupA, 'owner'));
    await store.putSessionNotepadCapability({
      sessionId: own.id,
      kind: 'session_notepad_coordination',
      grantedByUserId: 'owner',
      createdAt: now,
    });
    await expect(run({ action: 'append_session', sessionId: peer.id, append: 'handoff' })).resolves.toMatchObject({
      ok: true,
    });
    const cross = await store.createSession(session('cross', groupB, 'owner'));
    expect(await run({ action: 'read_session', sessionId: cross.id })).toMatchObject({
      ok: false,
      error: 'Target unavailable',
    });
    await store.deleteGroupMember({ groupId: groupA, userId: 'owner' });
    await store.updateSession({ ...peer, visibility: 'organization' });
    expect(await run({ action: 'read_session', sessionId: peer.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('authorization'),
    });
    expect(await run({ action: 'append_session', sessionId: peer.id, append: 'no' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('authorization'),
    });
    await store.updateSession({ ...peer, writePolicy: 'creator_only', createdByUserId: 'other' });
    expect(await run({ action: 'read_session', sessionId: peer.id })).toMatchObject({
      ok: false,
      error: expect.stringContaining('authorization'),
    });
    await store.updateSession({ ...peer, writePolicy: 'creator_only' });
    await expect(run({ action: 'read_session', sessionId: peer.id })).resolves.toMatchObject({ ok: true });
    await expect(run({ action: 'append_session', sessionId: peer.id, append: 'creator' })).resolves.toMatchObject({
      ok: true,
    });
    await store.updateGroup({ ...group(groupA), archivedAt: now });
    await expect(
      run({ action: 'append_session', sessionId: peer.id, append: 'archived creator' }),
    ).resolves.toMatchObject({
      ok: true,
    });
  });

  it('derives coordinated patches only from an authorized coordinated read', async () => {
    const peer = await store.createSession(session('peer-patch', groupA, 'owner'));
    await store.putSessionNotepadCapability({
      sessionId: own.id,
      kind: 'session_notepad_coordination',
      grantedByUserId: 'owner',
      createdAt: now,
    });
    await service.mutateSession(
      { bypass: true, user: null, memberships: [] },
      peer.id,
      { content: 'alpha beta', expectedRevision: 0 },
      { kind: 'system' },
    );
    await expect(
      run({ action: 'patch_session', sessionId: peer.id, oldText: 'beta', newText: 'gamma', expectedRevision: 1 }),
    ).resolves.toMatchObject({ ok: true, result: { revision: 2 } });
    await expect(store.getSessionNotepad(peer.id)).resolves.toMatchObject({ content: 'alpha gamma' });

    await store.deleteGroupMember({ groupId: groupA, userId: 'owner' });
    await expect(
      run({ action: 'patch_session', sessionId: peer.id, oldText: 'missing', newText: 'no', expectedRevision: 2 }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Notepad access denied by current grantor authorization',
    });
    await store.upsertGroupMember({ groupId: groupA, userId: 'owner', role: 'member', createdAt: now, updatedAt: now });
    await store.removeSessionNotepadCapability(own.id, 'session_notepad_coordination');
    await expect(
      run({ action: 'patch_session', sessionId: peer.id, oldText: 'missing', newText: 'no', expectedRevision: 2 }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Notepad access denied by current grantor authorization',
    });
  });

  it('cannot commit a coordinated patch when authority is revoked after its read', async () => {
    const peer = await store.createSession(session('peer-race', groupA, 'owner'));
    await store.putSessionNotepadCapability({
      sessionId: own.id,
      kind: 'session_notepad_coordination',
      grantedByUserId: 'owner',
      createdAt: now,
    });
    await service.mutateSession(
      { bypass: true, user: null, memberships: [] },
      peer.id,
      { content: 'before', expectedRevision: 0 },
      { kind: 'system' },
    );
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

  it('uses the current capability and permits a super-admin grantor without membership', async () => {
    const peer = await store.createSession(session('peer', groupA, 'owner'));
    await store.upsertAuthUserForAccount({
      userId: 'super',
      accountId: 'super-account',
      provider: 'test',
      providerAccountId: 'super',
      username: 'super',
      role: 'super_admin',
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
      grantedByUserId: 'super',
      createdAt: now,
    });
    await store.deleteGroupMember({ groupId: groupA, userId: 'owner' });
    await expect(run({ action: 'read_session', sessionId: peer.id })).resolves.toMatchObject({ ok: true });
    await expect(run({ action: 'append_session', sessionId: peer.id, append: 'super' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      store.mutateSessionNotepad({
        sessionId: peer.id,
        append: 'stale preflight',
        actor: { kind: 'agent', sessionId: own.id, runId: 'run-7' },
        expectedCoordinationGrantorUserId: 'owner',
        mutationKind: 'append',
        now,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects archived targets and invalid actions', async () => {
    await store.archiveSession({ sessionId: own.id, archivedAt: now });
    expect(await run({ action: 'append', append: 'no' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Archived'),
    });
    expect(await run({ action: 'bogus' })).toMatchObject({ ok: false, error: 'Invalid notepad action' });
  });

  it('bounds history to 50 and returns 32-KiB line-safe, valid multibyte chunks', async () => {
    const pad = await explicit('large');
    await service.putAssociation({ bypass: true, user: null, memberships: [] }, pad.id, own.id, {
      kind: 'system',
    });
    const content = '💥'.repeat(9_000);
    await run({ action: 'replace', notepadId: pad.id, content, expectedRevision: 0 });
    const read = await run({ action: 'read', notepadId: pad.id });
    const chunk = (read.result as { content: string }).content;
    expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(32 * 1024);
    expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
    for (let i = 0; i < 55; i++) await run({ action: 'append', notepadId: pad.id, append: 'x' });
    await expect(run({ action: 'history', notepadId: pad.id })).resolves.toMatchObject({
      result: { revisions: expect.any(Array) },
    });
    const history = await run({ action: 'history', notepadId: pad.id });
    expect((history.result as { revisions: unknown[] }).revisions).toHaveLength(50);
  });

  it('guidance promises durable memory without chain-of-thought or wake semantics', () => {
    expect(notepadToolDescription).toMatch(/Durable external memory/i);
    expect(notepadToolDescription).toMatch(/do not .*wake/i);
    expect(notepadToolDescription).not.toMatch(/chain[- ]of[- ]thought|reasoning trace/i);
  });

  async function explicit(title: string) {
    const auth: RequestAuthorization = { bypass: true, user: null, memberships: [] };
    return service.create(auth, { ownerGroupId: groupA, title });
  }
});

function group(id: string) {
  return {
    id,
    name: id,
    defaultVisibility: 'organization' as const,
    defaultWritePolicy: 'group_members' as const,
    automationCreateRequiredRole: 'member' as const,
    createdAt: now,
    updatedAt: now,
  };
}
function session(id: string, ownerGroupId: string, createdByUserId: string): SessionRecord {
  return {
    id,
    ownerGroupId,
    createdByUserId,
    visibility: 'group',
    writePolicy: 'group_members',
    status: 'idle',
    spawnDepth: 0,
    tags: [],
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  };
}
