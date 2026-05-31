import type { Context } from 'hono';
import type { AppConfig } from '../config/index.js';
import type { AppStore, AuthUserRecord, GroupMemberRecord, GroupRole, SessionRecord } from '../store/types.js';
import { readSessionId } from './session.js';

export type RequestAuthorization =
  | { bypass: true; user: null; memberships: GroupMemberRecord[] }
  | { bypass: false; user: AuthUserRecord; memberships: GroupMemberRecord[] };

const groupRoleRank: Record<GroupRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
};

export async function readRequestAuthorization(
  config: AppConfig,
  store: AppStore,
  c: Context,
): Promise<RequestAuthorization | null> {
  if (config.apiAuthMode !== 'session') return { bypass: true, user: null, memberships: [] };
  const sessionId = readSessionId(c);
  const user = sessionId ? await store.getAuthUserBySession({ sessionId, now: new Date() }) : null;
  if (!user) return null;
  return { bypass: false, user, memberships: await store.listUserGroupMemberships(user.id) };
}

export function canReadSession(auth: RequestAuthorization, session: SessionRecord): boolean {
  if (auth.bypass || isSuperAdmin(auth)) return true;
  if (session.visibility === 'organization') return true;
  return Boolean(groupRole(auth, session.ownerGroupId));
}

export function canWriteSession(auth: RequestAuthorization, session: SessionRecord): boolean {
  if (auth.bypass || isSuperAdmin(auth)) return true;
  if (session.createdByUserId === auth.user.id && session.writePolicy === 'creator_only') return true;
  const role = groupRole(auth, session.ownerGroupId);
  if (role === 'admin') return true;
  return session.writePolicy === 'group_members' && role === 'member';
}

export function canCreateSessionInGroup(auth: RequestAuthorization, groupId: string): boolean {
  if (auth.bypass || isSuperAdmin(auth)) return true;
  const role = groupRole(auth, groupId);
  return role === 'member' || role === 'admin';
}

export function canManageGroup(auth: RequestAuthorization, groupId: string): boolean {
  if (auth.bypass || isSuperAdmin(auth)) return true;
  return groupRole(auth, groupId) === 'admin';
}

export function canMoveSession(auth: RequestAuthorization, session: SessionRecord, targetGroupId: string): boolean {
  if (auth.bypass || isSuperAdmin(auth)) return true;
  return groupRole(auth, session.ownerGroupId) === 'admin' && groupRole(auth, targetGroupId) === 'admin';
}

export function canManageAllGroups(auth: RequestAuthorization): boolean {
  return auth.bypass || isSuperAdmin(auth);
}

export function isSuperAdmin(auth: RequestAuthorization): boolean {
  return !auth.bypass && auth.user.role === 'super_admin';
}

export function groupRole(auth: RequestAuthorization, groupId: string): GroupRole | null {
  if (auth.bypass) return 'admin';
  const roles = auth.memberships.filter((member) => member.groupId === groupId).map((member) => member.role);
  return strongestGroupRole(roles);
}

export function strongestGroupRole(roles: GroupRole[]): GroupRole | null {
  return roles.reduce<GroupRole | null>((best, role) => {
    if (!best || groupRoleRank[role] > groupRoleRank[best]) return role;
    return best;
  }, null);
}
