import { describe, expect, it } from 'vitest';
import {
  agentCanReadSession,
  agentCanCancelSession,
  agentCanSpawnInGroup,
  agentCanWriteSession,
  type AgentPrincipal,
} from '../../src/auth/agent-authorization.js';
import {
  canCreateSessionInGroup,
  canManageAllGroups,
  canManageGroup,
  canMoveSession,
  canReadSession,
  canWriteSession,
  type RequestAuthorization,
} from '../../src/auth/authorization.js';
import {
  defaultGroupId,
  type AuthUserRecord,
  type GroupMemberRecord,
  type SessionRecord,
} from '../../src/store/types.js';

const now = new Date('2026-05-01T00:00:00.000Z');
const otherGroupId = '00000000-0000-4000-8000-000000000002';

describe('authorization rules', () => {
  it('allows organization visibility reads without group membership', () => {
    const auth = authFor(user('reader'), []);

    expect(canReadSession(auth, session({ visibility: 'organization' }))).toBe(true);
    expect(canReadSession(auth, session({ visibility: 'group' }))).toBe(false);
  });

  it('separates group viewer, member, and admin write permissions', () => {
    const viewer = authFor(user('viewer'), [member('viewer')]);
    const groupMember = authFor(user('member'), [member('member')]);
    const admin = authFor(user('admin'), [member('admin')]);

    expect(canWriteSession(viewer, session({ writePolicy: 'group_members' }))).toBe(false);
    expect(canCreateSessionInGroup(viewer, defaultGroupId)).toBe(false);
    expect(canWriteSession(groupMember, session({ writePolicy: 'group_members' }))).toBe(true);
    expect(canCreateSessionInGroup(groupMember, defaultGroupId)).toBe(true);
    expect(canManageGroup(groupMember, defaultGroupId)).toBe(false);
    expect(canWriteSession(admin, session({ writePolicy: 'creator_only' }))).toBe(true);
    expect(canManageGroup(admin, defaultGroupId)).toBe(true);
  });

  it('allows creator-only writes only to the creator or an admin', () => {
    const creator = user('creator');
    const otherUser = user('other');
    const creatorAuth = authFor(creator, []);
    const otherAuth = authFor(otherUser, [member('member', otherUser.id)]);
    const creatorOnlySession = session({ createdByUserId: creator.id, writePolicy: 'creator_only' });

    expect(canWriteSession(creatorAuth, creatorOnlySession)).toBe(true);
    expect(canWriteSession(otherAuth, creatorOnlySession)).toBe(false);
  });

  it('requires admin access in both groups to move a session', () => {
    const dualAdmin = authFor(user('dual-admin'), [member('admin'), member('admin', 'dual-admin', otherGroupId)]);
    const sourceOnlyAdmin = authFor(user('source-admin'), [member('admin')]);
    const targetOnlyAdmin = authFor(user('target-admin'), [member('admin', 'target-admin', otherGroupId)]);
    const sourceMemberTargetAdmin = authFor(user('member-admin'), [
      member('member'),
      member('admin', 'member-admin', otherGroupId),
    ]);

    expect(canMoveSession(dualAdmin, session(), otherGroupId)).toBe(true);
    expect(canMoveSession(sourceOnlyAdmin, session(), otherGroupId)).toBe(false);
    expect(canMoveSession(targetOnlyAdmin, session(), otherGroupId)).toBe(false);
    expect(canMoveSession(sourceMemberTargetAdmin, session(), otherGroupId)).toBe(false);
  });

  it('allows bypass authorization to perform group-scoped operations', () => {
    const auth: RequestAuthorization = { bypass: true, user: null, memberships: [] };

    expect(canReadSession(auth, session({ visibility: 'group' }))).toBe(true);
    expect(canWriteSession(auth, session({ writePolicy: 'creator_only' }))).toBe(true);
    expect(canCreateSessionInGroup(auth, otherGroupId)).toBe(true);
    expect(canManageGroup(auth, otherGroupId)).toBe(true);
    expect(canManageAllGroups(auth)).toBe(true);
    expect(canMoveSession(auth, session(), otherGroupId)).toBe(true);
  });

  it('lets super admins bypass group-scoped restrictions', () => {
    const auth = authFor(user('root', 'super_admin'), []);

    expect(canReadSession(auth, session({ visibility: 'group' }))).toBe(true);
    expect(canWriteSession(auth, session({ writePolicy: 'creator_only' }))).toBe(true);
    expect(canCreateSessionInGroup(auth, otherGroupId)).toBe(true);
    expect(canManageGroup(auth, otherGroupId)).toBe(true);
    expect(canMoveSession(auth, session(), otherGroupId)).toBe(true);
  });
});

describe('agent authorization rules', () => {
  const agent: AgentPrincipal = {
    kind: 'session_agent',
    sessionId: 'parent-session',
    ownerGroupId: defaultGroupId,
    spawnDepth: 1,
  };

  it('reads organization-visible sessions and same-group private sessions only', () => {
    expect(agentCanReadSession(agent, session({ visibility: 'organization', ownerGroupId: otherGroupId }))).toBe(true);
    expect(agentCanReadSession(agent, session({ visibility: 'group', ownerGroupId: defaultGroupId }))).toBe(true);
    expect(agentCanReadSession(agent, session({ visibility: 'group', ownerGroupId: otherGroupId }))).toBe(false);
  });

  it('spawns only in the acting session group', () => {
    expect(agentCanSpawnInGroup(agent, defaultGroupId)).toBe(true);
    expect(agentCanSpawnInGroup(agent, otherGroupId)).toBe(false);
  });

  it('writes only to non-archived direct children', () => {
    expect(agentCanWriteSession(agent, session({ parentSessionId: agent.sessionId }))).toBe(true);
    expect(agentCanWriteSession(agent, session({ parentSessionId: 'other-parent' }))).toBe(false);
    expect(agentCanWriteSession(agent, session({ parentSessionId: agent.sessionId, status: 'archived' }))).toBe(false);
  });

  it('cancels only non-archived direct children', () => {
    expect(agentCanCancelSession(agent, session({ parentSessionId: agent.sessionId }))).toBe(true);
    expect(agentCanCancelSession(agent, session({ parentSessionId: 'other-parent' }))).toBe(false);
    expect(agentCanCancelSession(agent, session({ parentSessionId: agent.sessionId, status: 'archived' }))).toBe(false);
  });
});

function authFor(user: AuthUserRecord, memberships: GroupMemberRecord[]): RequestAuthorization {
  return { bypass: false, user, memberships };
}

function user(username: string, role: AuthUserRecord['role'] = 'user'): AuthUserRecord {
  return { id: username, username, role, createdAt: now, updatedAt: now };
}

function member(
  role: GroupMemberRecord['role'],
  userId: string = 'user-id',
  groupId = defaultGroupId,
): GroupMemberRecord {
  return { groupId, userId, role, createdAt: now, updatedAt: now };
}

function session(input: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    status: 'idle',
    spawnDepth: 0,
    ownerGroupId: defaultGroupId,
    visibility: 'group',
    writePolicy: 'group_members',
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}
