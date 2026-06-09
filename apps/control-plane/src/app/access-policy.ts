import { canCreateAutomationInGroup, canCreateSessionInGroup, groupRole } from '../auth/authorization.js';
import type { RequestAuthorization } from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import { defaultGroupId } from '../store/types.js';
import type { AppStore, GroupRecord, SessionVisibility, SessionWritePolicy } from '../store/types.js';
import { optionalString } from './request.js';

export async function resolveSessionCreateGroup(
  store: AppStore,
  auth: RequestAuthorization,
  requestedGroupId: unknown,
): Promise<GroupRecord | null> {
  const groupId = optionalString(requestedGroupId);
  if (groupId) return store.getGroup(groupId);

  const groups = await store.listGroups();
  const activeGroups = groups.filter((group) => !group.archivedAt);
  const defaultGroup = activeGroups.find((group) => group.id === defaultGroupId) ?? activeGroups[0];
  if (auth.bypass || !defaultGroup) return defaultGroup ?? null;

  const creatable = activeGroups.find((group) => canCreateSessionInGroup(auth, group.id));
  return creatable ?? defaultGroup;
}

export async function resolveAutomationCreateGroup(
  store: AppStore,
  auth: RequestAuthorization,
  requestedGroupId: unknown,
): Promise<GroupRecord | null> {
  const groupId = optionalString(requestedGroupId);
  if (groupId) return store.getGroup(groupId);

  const groups = await store.listGroups();
  const activeGroups = groups.filter((group) => !group.archivedAt);
  const defaultGroup = activeGroups.find((group) => group.id === defaultGroupId) ?? activeGroups[0];
  if (auth.bypass || !defaultGroup) return defaultGroup ?? null;

  const creatable = activeGroups.find((group) => canCreateAutomationInGroup(auth, group));
  return creatable ?? defaultGroup;
}

export function sessionCreateDefaults(
  config: AppConfig,
  auth: RequestAuthorization,
  group: GroupRecord,
): { visibility: SessionVisibility; writePolicy: SessionWritePolicy } {
  const publicTrialMember =
    config.unsafeAuthGithubAllowAll &&
    group.id === defaultGroupId &&
    !auth.bypass &&
    auth.user.role !== 'super_admin' &&
    groupRole(auth, group.id) === 'member';
  return {
    visibility: group.defaultVisibility,
    writePolicy: publicTrialMember ? 'creator_only' : group.defaultWritePolicy,
  };
}

export function parseSessionVisibility(value: unknown): SessionVisibility | null {
  return value === 'group' || value === 'organization' ? value : null;
}

export function parseSessionWritePolicy(value: unknown): SessionWritePolicy | null {
  return value === 'group_members' || value === 'creator_only' ? value : null;
}
