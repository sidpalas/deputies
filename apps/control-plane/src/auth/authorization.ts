import type { Context } from 'hono';
import type { AppConfig } from '../config/index.js';
import type {
  AuthStore,
  AuthUserRecord,
  AutomationRecord,
  EnvironmentWithDetailsRecord,
  GroupStore,
  GroupMemberRecord,
  GroupRecord,
  GroupRole,
  SessionRecord,
  SkillRecord,
} from '../store/types.js';
import { readSessionId } from './session.js';

export type RequestAuthorization =
  | { bypass: true; user: null; memberships: GroupMemberRecord[] }
  | { bypass: false; user: AuthUserRecord; memberships: GroupMemberRecord[] };

const groupRoleRank: Record<GroupRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
};

// Auth state is resolved by middlewares and handlers independently, so memoize the
// underlying lookups per request to avoid repeating the same store queries.
const requestAuthUserCache = new WeakMap<Request, Promise<AuthUserRecord | null>>();
const requestAuthorizationCache = new WeakMap<Request, Promise<RequestAuthorization | null>>();

export function readRequestAuthUser(config: AppConfig, store: AuthStore, c: Context): Promise<AuthUserRecord | null> {
  const request = c.req.raw;
  let user = requestAuthUserCache.get(request);
  if (!user) {
    const sessionId = readSessionId(config, c);
    user = sessionId ? store.getAuthUserBySession({ sessionId, now: new Date() }) : Promise.resolve(null);
    requestAuthUserCache.set(request, user);
  }
  return user;
}

export function readRequestAuthorization(
  config: AppConfig,
  store: AuthStore & GroupStore,
  c: Context,
): Promise<RequestAuthorization | null> {
  if (config.apiAuthMode !== 'session') return Promise.resolve({ bypass: true, user: null, memberships: [] });
  const request = c.req.raw;
  let authorization = requestAuthorizationCache.get(request);
  if (!authorization) {
    authorization = (async (): Promise<RequestAuthorization | null> => {
      const user = await readRequestAuthUser(config, store, c);
      if (!user) return null;
      return { bypass: false, user, memberships: await activeGroupMemberships(store, user.id) };
    })();
    requestAuthorizationCache.set(request, authorization);
  }
  return authorization;
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

export function canCreateAutomationInGroup(
  auth: RequestAuthorization,
  group: Pick<GroupRecord, 'id' | 'automationCreateRequiredRole'>,
): boolean {
  if (group.automationCreateRequiredRole === 'admin') return canManageGroup(auth, group.id);
  return canCreateSessionInGroup(auth, group.id);
}

export function canReadAutomation(auth: RequestAuthorization, automation: AutomationRecord): boolean {
  return canCreateSessionInGroup(auth, automation.ownerGroupId);
}

export function canManageAutomation(auth: RequestAuthorization, automation: AutomationRecord): boolean {
  if (canManageGroup(auth, automation.ownerGroupId)) return true;
  return (
    !auth.bypass &&
    automation.createdByUserId === auth.user.id &&
    canCreateSessionInGroup(auth, automation.ownerGroupId)
  );
}

export function canCreateSkillInGroup(auth: RequestAuthorization, groupId: string): boolean {
  return canCreateSessionInGroup(auth, groupId);
}

export function canReadSkill(auth: RequestAuthorization, skill: SkillRecord): boolean {
  if (auth.bypass || isSuperAdmin(auth)) return true;
  if (skill.ownerKind === 'user') return skill.ownerUserId === auth.user.id;
  if (skill.ownerGroupId && groupRole(auth, skill.ownerGroupId)) return true;
  if (skill.shareMode === 'all_groups') return auth.memberships.length > 0;
  return skill.shareMode === 'specific' && skill.shareGroupIds.some((groupId) => Boolean(groupRole(auth, groupId)));
}

export function canManageSkill(auth: RequestAuthorization, skill: SkillRecord): boolean {
  if (auth.bypass || isSuperAdmin(auth)) return true;
  if (skill.ownerKind === 'user') return skill.ownerUserId === auth.user.id;
  if (skill.ownerGroupId && canManageGroup(auth, skill.ownerGroupId)) return true;
  return (
    skill.createdByUserId === auth.user.id &&
    Boolean(skill.ownerGroupId && canCreateSkillInGroup(auth, skill.ownerGroupId))
  );
}

export function canInvokeSkillInSession(
  auth: RequestAuthorization,
  skill: SkillRecord,
  session: Pick<SessionRecord, 'ownerGroupId'>,
  authorUserId: string | undefined = auth.bypass ? undefined : auth.user.id,
): boolean {
  if (!skill.enabled || skill.archivedAt || !canReadSkill(auth, skill)) return false;
  if (skill.ownerKind === 'user') return Boolean(authorUserId && skill.ownerUserId === authorUserId);
  return (
    skill.ownerGroupId === session.ownerGroupId ||
    skill.shareMode === 'all_groups' ||
    (skill.shareMode === 'specific' && skill.shareGroupIds.includes(session.ownerGroupId))
  );
}

export function canReadEnvironment(auth: RequestAuthorization, environment: EnvironmentWithDetailsRecord): boolean {
  if (auth.bypass || isSuperAdmin(auth)) return true;
  if (groupRole(auth, environment.ownerGroupId)) return true;
  if (environment.shareMode === 'all_groups') return auth.memberships.length > 0;
  if (environment.shareMode === 'selected_groups') {
    return environment.sharedGroupIds.some((groupId) => Boolean(groupRole(auth, groupId)));
  }
  return false;
}

export function canUseEnvironmentInGroup(
  auth: RequestAuthorization,
  environment: EnvironmentWithDetailsRecord,
  groupId: string,
): boolean {
  if (!canCreateSessionInGroup(auth, groupId)) return false;
  return environmentAvailableToGroup(environment, groupId);
}

export function canManageEnvironment(auth: RequestAuthorization, environment: EnvironmentWithDetailsRecord): boolean {
  return canManageGroup(auth, environment.ownerGroupId);
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

function environmentAvailableToGroup(environment: EnvironmentWithDetailsRecord, groupId: string): boolean {
  return (
    environment.ownerGroupId === groupId ||
    environment.shareMode === 'all_groups' ||
    (environment.shareMode === 'selected_groups' && environment.sharedGroupIds.includes(groupId))
  );
}

async function activeGroupMemberships(store: GroupStore, userId: string): Promise<GroupMemberRecord[]> {
  const memberships = await store.listUserGroupMemberships(userId);
  const groups = await Promise.all(memberships.map((membership) => store.getGroup(membership.groupId)));
  return memberships.filter((_, index) => !groups[index]?.archivedAt);
}

export function strongestGroupRole(roles: GroupRole[]): GroupRole | null {
  return roles.reduce<GroupRole | null>((best, role) => {
    if (!best || groupRoleRank[role] > groupRoleRank[best]) return role;
    return best;
  }, null);
}
