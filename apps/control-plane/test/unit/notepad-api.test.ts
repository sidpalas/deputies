import { beforeEach, describe, expect, it } from 'vitest';
import type { RequestAuthorization } from '../../src/auth/authorization.js';
import { NotepadService } from '../../src/notepads/service.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { AuthRole, AuthUserRecord, SessionRecord } from '../../src/store/types.js';

const now = new Date('2026-07-21T00:00:00Z');
const actor = { kind: 'system' } as const;

describe('Notepad API policy', () => {
  let store: MemoryStore;
  let api: NotepadService;
  let admin: RequestAuthorization;
  let member: RequestAuthorization;
  let otherMember: RequestAuthorization;
  let viewer: RequestAuthorization;
  let session: SessionRecord;

  beforeEach(async () => {
    store = new MemoryStore();
    api = new NotepadService(store);
    admin = await auth('admin', 'admin');
    member = await auth('member', 'member');
    otherMember = await auth('other-member', 'member');
    viewer = await auth('viewer', 'viewer');
    session = await store.createSession(sessionRecord('session-a', 'member'));
  });

  it('allows viewers to read and members/admins to mutate any human Session, but rejects archived mutations', async () => {
    await expect(api.readSession(viewer, session.id)).resolves.toMatchObject({ revision: 0 });
    await expect(api.mutateSession(viewer, session.id, { append: 'no' }, actor)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(api.mutateSession(otherMember, session.id, { append: 'member' }, actor)).resolves.toMatchObject({
      content: 'member',
    });
    await expect(api.mutateSession(admin, session.id, { append: '-admin' }, actor)).resolves.toMatchObject({
      content: 'member-admin',
    });
    await store.archiveSession({ sessionId: session.id, archivedAt: now });
    await expect(api.mutateSession(member, session.id, { append: 'no' }, actor)).rejects.toMatchObject({
      code: 'archived',
    });
  });

  it('rejects obsolete ownership/visibility/write-policy fields and permits member metadata changes', async () => {
    const pad = await api.create(member, { title: 'Default' });
    await expect(api.create(member, { title: 'No', ownerGroupId: 'old-group' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(api.create(admin, { title: 'No', visibility: 'organization' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(api.metadata(otherMember, pad.id, { title: 'Renamed' })).resolves.toMatchObject({ title: 'Renamed' });
    await expect(api.metadata(admin, pad.id, { writePolicy: 'creator_only' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(api.metadata(viewer, pad.id, { title: 'No' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps associated Notepad read/write/history/restore authority tied to the Session', async () => {
    const pad = await api.create(member, { title: 'Shared' });
    const target = await store.createSession(sessionRecord('target', 'member'));
    await expect(api.putAssociation(member, pad.id, target.id, actor)).resolves.toMatchObject({ notepadId: pad.id });
    expect((await api.sessionAssociations(viewer, target.id)).items[0]).toMatchObject({ canWrite: false });
    expect((await api.sessionAssociations(otherMember, target.id)).items[0]).toMatchObject({ canWrite: true });
    await api.mutateExplicit(otherMember, pad.id, { append: 'one' }, actor, target.id);
    await api.mutateExplicit(otherMember, pad.id, { append: ' two' }, actor, target.id);
    await expect(api.history(viewer, 'explicit', pad.id, 50, 0, target.id)).resolves.toMatchObject({
      items: [{ revision: 2 }, { revision: 1 }],
    });
    await expect(api.readRevision(viewer, 'explicit', pad.id, 1, target.id)).resolves.toMatchObject({ content: 'one' });
    await expect(api.restoreRevision(viewer, 'explicit', pad.id, 1, 2, actor, target.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(api.restoreRevision(otherMember, 'explicit', pad.id, 1, 2, actor, target.id)).resolves.toMatchObject({
      revision: 3,
      content: 'one',
    });
    await expect(api.removeAssociation(admin, pad.id, target.id, actor)).resolves.toBe(true);
  });

  it('lists and searches tenant-wide metadata for viewers without exposing content', async () => {
    const visible = await api.create(admin, { title: 'Visible' });
    await api.mutateExplicit(admin, visible.id, { content: 'before needle after', expectedRevision: 0 }, actor);
    await api.putAssociation(admin, visible.id, session.id, actor);
    const dormant = await api.create(member, { title: 'Dormant' });
    await expect(api.list(viewer)).resolves.toMatchObject({ items: [{ id: visible.id }] });
    await expect(api.inventory(viewer)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.inventory(member)).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: visible.id }),
        expect.objectContaining({ id: dormant.id }),
      ]),
    });
    const results = await api.search(viewer, 'needle');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: visible.id, snippet: expect.stringContaining('needle') });
    expect(results[0]).not.toHaveProperty('content');
  });

  it('archives and restores explicit Notepads while preserving content and filtering inventories', async () => {
    const pad = await api.create(member, { title: 'Archive me', content: 'durable' }, actor);
    await expect(api.archive(viewer, pad.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.archive(member, pad.id)).resolves.toMatchObject({ archivedAt: expect.any(Date), revision: 1 });
    await expect(api.mutateExplicit(admin, pad.id, { append: 'no' }, actor)).rejects.toMatchObject({
      code: 'archived',
    });
    await expect(api.inventory(admin)).resolves.toMatchObject({ items: [] });
    await expect(api.inventory(admin, 50, 0, true)).resolves.toMatchObject({ items: [{ id: pad.id }] });
    await expect(api.restore(admin, pad.id)).resolves.toMatchObject({ id: pad.id, content: 'durable', revision: 1 });
  });

  it('validates capability kinds, records/replaces/revokes the human grantor, and rejects archived sessions', async () => {
    await expect(api.putCapability(member, session.id, 'explicit_search')).resolves.toMatchObject({
      grantedByUserId: 'member',
    });
    await expect(api.putCapability(admin, session.id, 'explicit_search')).resolves.toMatchObject({
      grantedByUserId: 'admin',
    });
    await expect(api.removeCapability(viewer, session.id, 'explicit_search')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(api.removeCapability(member, session.id, 'explicit_search')).resolves.toBe(true);
    await expect(api.putCapability(member, session.id, 'bad')).rejects.toMatchObject({ code: 'invalid' });
    await store.archiveSession({ sessionId: session.id, archivedAt: now });
    await expect(api.putCapability(admin, session.id, 'explicit_search')).rejects.toMatchObject({ code: 'archived' });
  });

  it('rejects malformed and NaN revisions', async () => {
    await expect(
      api.mutateSession(member, session.id, { content: 'x', expectedRevision: Number.NaN }, actor),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.restoreRevision(member, 'session', session.id, Number.NaN, 0, actor)).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(api.readRevision(member, 'session', session.id, 0)).rejects.toMatchObject({ code: 'invalid' });
  });

  async function auth(id: string, role: AuthRole): Promise<RequestAuthorization> {
    const user: AuthUserRecord = { id, username: id, role, createdAt: now, updatedAt: now };
    await store.upsertAuthUserForAccount({
      userId: id,
      accountId: `${id}-account`,
      provider: 'test',
      providerAccountId: id,
      username: id,
      role,
      profile: {},
      now,
    });
    return { bypass: false, user };
  }
});

function sessionRecord(id: string, createdByUserId: string): SessionRecord {
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
