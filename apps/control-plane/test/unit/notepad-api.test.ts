import { beforeEach, describe, expect, it } from 'vitest';
import type { RequestAuthorization } from '../../src/auth/authorization.js';
import { NotepadService } from '../../src/notepads/service.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { AuthUserRecord, GroupRole, SessionRecord } from '../../src/store/types.js';

const now = new Date('2026-07-21T00:00:00Z');
const groupA = 'group-a';
const groupB = 'group-b';
const actor = { kind: 'system' } as const;

describe('Notepad API policy', () => {
  let store: MemoryStore;
  let api: NotepadService;
  let admin: RequestAuthorization;
  let member: RequestAuthorization;
  let otherMember: RequestAuthorization;
  let outsider: RequestAuthorization;
  let session: SessionRecord;

  beforeEach(async () => {
    store = new MemoryStore();
    api = new NotepadService(store);
    await store.createGroup(group(groupA, 'group', 'creator_only'));
    await store.createGroup(group(groupB, 'organization', 'group_members'));
    admin = await auth('admin', groupA, 'admin');
    member = await auth('member', groupA, 'member');
    otherMember = await auth('other-member', groupA, 'member');
    outsider = await auth('outsider', groupB, 'member');
    session = await store.createSession(sessionRecord('session-a', groupA, 'organization', 'creator_only', 'member'));
  });

  it('applies organization read independently from creator-only write and rejects archived mutations', async () => {
    await expect(api.readSession(outsider, session.id)).resolves.toMatchObject({ revision: 0 });
    await expect(api.mutateSession(outsider, session.id, { append: 'no' }, actor)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(api.mutateSession(member, session.id, { append: 'yes' }, actor)).resolves.toMatchObject({
      content: 'yes',
    });
    await store.archiveSession({ sessionId: session.id, archivedAt: now });
    await expect(api.mutateSession(member, session.id, { append: 'no' }, actor)).rejects.toMatchObject({
      code: 'archived',
    });
  });

  it('uses group defaults, permits only admins to override, and allows visibility/policy metadata but not ownership', async () => {
    const pad = await api.create(member, { ownerGroupId: groupA, title: 'Default' });
    expect(pad).toMatchObject({ visibility: 'group', writePolicy: 'creator_only' });
    await expect(
      api.create(member, { ownerGroupId: groupA, title: 'No', visibility: 'organization' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const overridden = await api.create(admin, {
      ownerGroupId: groupA,
      title: 'Admin',
      visibility: 'organization',
      writePolicy: 'group_members',
    });
    await expect(
      api.metadata(admin, overridden.id, { visibility: 'group', writePolicy: 'creator_only' }),
    ).resolves.toMatchObject({ visibility: 'group', writePolicy: 'creator_only' });
    await expect(api.metadata(admin, overridden.id, { ownerGroupId: groupB })).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('makes associated Notepads inherit Session read and write access', async () => {
    const pad = await api.create(member, { ownerGroupId: groupA, title: 'Private' });
    const target = await store.createSession(sessionRecord('target', groupA, 'group', 'group_members', 'member'));
    const granted = await api.putAssociation(member, pad.id, target.id, actor);
    expect(granted).toMatchObject({ notepadId: pad.id, sessionId: target.id });
    expect((await api.sessionAssociations(member, target.id)).items[0]).toMatchObject({ canWrite: true });
    expect((await api.sessionAssociations(otherMember, target.id)).items[0]).toMatchObject({ canWrite: true });
    await expect(api.mutateExplicit(otherMember, pad.id, { append: 'no' }, actor)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(api.mutateExplicit(otherMember, pad.id, { append: 'yes' }, actor, target.id)).resolves.toMatchObject({
      content: 'yes',
    });
    await api.mutateExplicit(otherMember, pad.id, { append: ' again' }, actor, target.id);
    await expect(api.history(otherMember, 'explicit', pad.id, 50, 0, target.id)).resolves.toMatchObject({
      items: [{ revision: 2 }, { revision: 1 }],
    });
    await expect(api.readRevision(otherMember, 'explicit', pad.id, 1, target.id)).resolves.toMatchObject({
      content: 'yes',
    });
    await expect(api.restoreRevision(otherMember, 'explicit', pad.id, 1, 2, actor)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(api.restoreRevision(otherMember, 'explicit', pad.id, 1, 2, actor, target.id)).resolves.toMatchObject({
      content: 'yes',
      revision: 3,
    });
    expect((await api.sessionAssociations(admin, target.id)).items[0]).toMatchObject({ canWrite: true });
    const restricted = await api.sessionAssociations(outsider, target.id).catch(() => []);
    expect(restricted).toEqual([]); // A group-private Session itself is not visible.
    const orgTarget = await store.createSession(
      sessionRecord('org-target', groupA, 'organization', 'group_members', 'member'),
    );
    await api.putAssociation(admin, pad.id, orgTarget.id, { kind: 'system' });
    const [association] = (await api.sessionAssociations(outsider, orgTarget.id)).items;
    expect(association).toMatchObject({ notepadId: pad.id, notepad: { title: 'Private' }, canWrite: false });
    await expect(api.requireReadable(outsider, pad.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.requireReadable(outsider, pad.id, orgTarget.id)).resolves.toMatchObject({ id: pad.id });
    await expect(api.history(outsider, 'explicit', pad.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.history(outsider, 'explicit', pad.id, 50, 0, orgTarget.id)).resolves.toMatchObject({
      items: [{ revision: 3 }, { revision: 2 }, { revision: 1 }],
    });
    await expect(api.readRevision(outsider, 'explicit', pad.id, 1)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.readRevision(outsider, 'explicit', pad.id, 1, orgTarget.id)).resolves.toMatchObject({
      content: 'yes',
    });
    await store.putNotepadAssociation({
      record: {
        notepadId: pad.id,
        sessionId: orgTarget.id,
        createdAt: now,
      },
      actor,
      activityId: 'legacy-read-association',
    });
    const associationActivity = (await api.activityList(admin, pad.id)).items.find(
      (item) => item.id === 'legacy-read-association',
    );
    expect(associationActivity?.metadata).toEqual({ sessionId: orgTarget.id });
    await expect(api.removeAssociation(member, pad.id, target.id, actor)).resolves.toBe(true);
    const cross = await store.createSession(
      sessionRecord('cross', groupB, 'organization', 'group_members', 'outsider'),
    );
    await expect(api.putAssociation(admin, pad.id, cross.id, actor)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('restricts inventory to admins and filters search with snippets but no content', async () => {
    const visible = await api.create(admin, { ownerGroupId: groupA, title: 'Visible', visibility: 'organization' });
    await api.mutateExplicit(admin, visible.id, { content: 'before needle after', expectedRevision: 0 }, actor);
    await api.putAssociation(admin, visible.id, session.id, actor);
    await api.create(admin, { ownerGroupId: groupA, title: 'Hidden' });
    await expect(api.inventory(member, groupA)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.inventory(admin, groupA)).resolves.toMatchObject({ items: [{}, {}], hasMore: false });
    await expect(api.list(outsider, groupA)).resolves.toMatchObject({ items: [{ id: visible.id }] });
    const results = await api.search(outsider, groupA, 'needle');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: 'Visible', snippet: expect.stringContaining('needle') });
    expect(results[0]).not.toHaveProperty('content');

    await store.archiveSession({ sessionId: session.id, archivedAt: now });
    await expect(api.list(outsider, groupA)).resolves.toMatchObject({ items: [] });
    await expect(api.search(outsider, groupA, 'needle')).resolves.toEqual([]);
    await expect(api.requireReadable(outsider, visible.id)).resolves.toMatchObject({ id: visible.id });
    await expect(api.sessionAssociations(outsider, session.id)).resolves.toMatchObject({
      items: [{ notepadId: visible.id, canWrite: false }],
    });
    await expect(api.inventory(admin, groupA)).resolves.toMatchObject({ items: [{}, {}] });
  });

  it('validates capability grant/revoke kinds and records the human grantor', async () => {
    await expect(api.putCapability(member, session.id, 'explicit_search')).resolves.toMatchObject({
      grantedByUserId: 'member',
    });
    await expect(api.putCapability(member, session.id, 'bad')).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.removeCapability(member, session.id, 'explicit_search')).resolves.toBe(true);
    await api.putCapability(member, session.id, 'explicit_search');
    await expect(api.removeCapability(admin, session.id, 'explicit_search')).resolves.toBe(true);
  });

  it('rejects malformed and NaN revisions', async () => {
    await expect(
      api.mutateSession(member, session.id, { content: 'x', expectedRevision: Number.NaN }, actor),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.restoreRevision(member, 'session', session.id, Number.NaN, 0, actor)).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(api.readRevision(member, 'session', session.id, 0)).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.restoreRevision(member, 'session', session.id, 0, 0, actor)).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  async function auth(id: string, groupId: string, role: GroupRole): Promise<RequestAuthorization> {
    const user: AuthUserRecord = { id, username: id, role: 'user', createdAt: now, updatedAt: now };
    await store.upsertAuthUserForAccount({
      userId: id,
      accountId: `${id}-account`,
      provider: 'test',
      providerAccountId: id,
      username: id,
      role: 'user',
      profile: {},
      now,
    });
    const membership = await store.upsertGroupMember({ groupId, userId: id, role, createdAt: now, updatedAt: now });
    return { bypass: false, user, memberships: [membership] };
  }
});

function group(
  id: string,
  defaultVisibility: 'group' | 'organization',
  defaultWritePolicy: 'creator_only' | 'group_members',
) {
  return {
    id,
    name: id,
    defaultVisibility,
    defaultWritePolicy,
    automationCreateRequiredRole: 'member' as const,
    createdAt: now,
    updatedAt: now,
  };
}
function sessionRecord(
  id: string,
  ownerGroupId: string,
  visibility: 'group' | 'organization',
  writePolicy: 'creator_only' | 'group_members',
  createdByUserId: string,
): SessionRecord {
  return {
    id,
    ownerGroupId,
    visibility,
    writePolicy,
    createdByUserId,
    status: 'idle',
    spawnDepth: 0,
    tags: [],
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  };
}
