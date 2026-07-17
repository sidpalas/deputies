import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import {
  canCreateAutomationInGroup,
  canCreateSessionInGroup,
  canCreateSkillInGroup,
  canManageAllGroups,
  canManageGroup,
  groupRole,
  readRequestAuthorization,
  type RequestAuthorization,
} from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import { StoreConflictError } from '../store/types.js';
import type {
  AppStore,
  AuthUserRecord,
  AutomationCreateRequiredRole,
  GroupMemberRecord,
  GroupRecord,
  GroupRole,
} from '../store/types.js';
import { parseSessionVisibility, parseSessionWritePolicy } from './access-policy.js';
import { writeError } from './http-error.js';
import { optionalString, readJsonBody } from './request.js';
import type { AppServices, AppVariables } from './server.js';

export function registerGroupRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
  options: { serializeBasicAuthUser: (user: AuthUserRecord) => unknown },
): void {
  app.get('/groups', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const groups = await visibleGroups(services.store, auth);
    return c.json({ groups: groups.map((group) => serializeGroupForAuth(group, auth)) });
  });

  app.post('/groups', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    if (!canManageAllGroups(auth)) return writeError(c, 403, 'forbidden', 'Super admin access is required');

    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const name = optionalString(body.name)?.trim();
    if (!name) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: name');
    const automationCreateRequiredRole =
      body.automationCreateRequiredRole === undefined
        ? 'member'
        : parseAutomationCreateRequiredRole(body.automationCreateRequiredRole);
    if (!automationCreateRequiredRole) {
      return writeError(c, 400, 'invalid_request', 'Expected valid automationCreateRequiredRole');
    }

    const now = new Date();
    try {
      const group = await services.store.createGroup({
        id: randomUUID(),
        name,
        defaultVisibility: parseSessionVisibility(body.defaultVisibility) ?? 'organization',
        defaultWritePolicy: parseSessionWritePolicy(body.defaultWritePolicy) ?? 'group_members',
        automationCreateRequiredRole,
        createdAt: now,
        updatedAt: now,
      });
      return c.json({ group: serializeGroupForAuth(group, auth) }, 201);
    } catch (error) {
      if (error instanceof StoreConflictError && error.code === 'group_name_exists') {
        return writeError(c, 409, error.code, error.message);
      }
      throw error;
    }
  });

  app.patch('/groups/:groupId', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const group = await services.store.getGroup(c.req.param('groupId'));
    if (!group) return writeError(c, 404, 'not_found', 'Group not found');
    if (!canManageGroup(auth, group.id)) return writeError(c, 403, 'forbidden', 'Group admin access is required');

    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const name = body.name === undefined ? group.name : optionalString(body.name)?.trim();
    if (!name) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: name');
    const visibility =
      body.defaultVisibility === undefined ? group.defaultVisibility : parseSessionVisibility(body.defaultVisibility);
    const writePolicy =
      body.defaultWritePolicy === undefined
        ? group.defaultWritePolicy
        : parseSessionWritePolicy(body.defaultWritePolicy);
    const automationCreateRequiredRole =
      body.automationCreateRequiredRole === undefined
        ? group.automationCreateRequiredRole
        : parseAutomationCreateRequiredRole(body.automationCreateRequiredRole);
    const archived = typeof body.archived === 'boolean' ? body.archived : undefined;
    if (!visibility) return writeError(c, 400, 'invalid_request', 'Expected valid defaultVisibility');
    if (!writePolicy) return writeError(c, 400, 'invalid_request', 'Expected valid defaultWritePolicy');
    if (!automationCreateRequiredRole) {
      return writeError(c, 400, 'invalid_request', 'Expected valid automationCreateRequiredRole');
    }

    const now = new Date();
    const nextGroup: GroupRecord = {
      ...group,
      name,
      defaultVisibility: visibility,
      defaultWritePolicy: writePolicy,
      automationCreateRequiredRole,
      updatedAt: now,
    };
    if (archived === true) nextGroup.archivedAt = group.archivedAt ?? now;
    if (archived === false) delete nextGroup.archivedAt;

    try {
      const updated = await services.store.updateGroup(nextGroup);
      return c.json({ group: serializeGroupForAuth(updated, auth) });
    } catch (error) {
      if (error instanceof StoreConflictError && error.code === 'group_name_exists') {
        return writeError(c, 409, error.code, error.message);
      }
      throw error;
    }
  });

  app.get('/groups/:groupId/members', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const group = await services.store.getGroup(c.req.param('groupId'));
    if (!group) return writeError(c, 404, 'not_found', 'Group not found');
    if (!canManageGroup(auth, group.id)) return writeError(c, 403, 'forbidden', 'Group admin access is required');
    const members = await services.store.listGroupMembers(group.id);
    return c.json({ members: members.map((member) => serializeGroupMemberWithUser(member, options)) });
  });

  app.post('/groups/:groupId/members', async (c) => upsertGroupMemberRoute(c, config, services.store));
  app.patch('/groups/:groupId/members/:userId', async (c) => upsertGroupMemberRoute(c, config, services.store));

  app.delete('/groups/:groupId/members/:userId', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const groupId = c.req.param('groupId');
    const userId = c.req.param('userId');
    if (!groupId) return writeError(c, 400, 'invalid_request', 'Expected groupId');
    if (!userId) return writeError(c, 400, 'invalid_request', 'Expected userId');
    const group = await services.store.getGroup(groupId);
    if (!group) return writeError(c, 404, 'not_found', 'Group not found');
    if (!canManageGroup(auth, group.id)) return writeError(c, 403, 'forbidden', 'Group admin access is required');
    if (!canManageAllGroups(auth) && (await wouldRemoveLastGroupAdmin(services.store, group.id, userId))) {
      return writeError(c, 409, 'last_group_admin', 'Cannot remove the last group admin');
    }
    await services.store.deleteGroupMember({ groupId: group.id, userId });
    return c.json({ ok: true });
  });
}

export function serializeGroupMember(member: GroupMemberRecord) {
  return {
    groupId: member.groupId,
    userId: member.userId,
    role: member.role,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

async function requireRequestAuthorization(
  config: AppConfig,
  store: AppStore,
  c: Context,
): Promise<RequestAuthorization | null> {
  return readRequestAuthorization(config, store, c);
}

function serializeGroupMemberWithUser(
  member: GroupMemberRecord & { user: AuthUserRecord },
  options: { serializeBasicAuthUser: (user: AuthUserRecord) => unknown },
) {
  return {
    ...serializeGroupMember(member),
    user: options.serializeBasicAuthUser(member.user),
  };
}

function serializeGroupForAuth(group: GroupRecord, auth: RequestAuthorization) {
  return {
    id: group.id,
    name: group.name,
    defaultVisibility: group.defaultVisibility,
    defaultWritePolicy: group.defaultWritePolicy,
    automationCreateRequiredRole: group.automationCreateRequiredRole,
    ...(group.archivedAt ? { archivedAt: group.archivedAt } : {}),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    membershipRole: groupRole(auth, group.id),
    canCreateSessions: canCreateSessionInGroup(auth, group.id),
    canCreateAutomations: canCreateAutomationInGroup(auth, group),
    canCreateSkills: canCreateSkillInGroup(auth, group.id),
    canManage: canManageGroup(auth, group.id),
  };
}

async function visibleGroups(store: AppStore, auth: RequestAuthorization): Promise<GroupRecord[]> {
  const groups = await store.listGroups();
  if (canManageAllGroups(auth)) return groups;
  const groupIds = new Set(auth.memberships.map((membership) => membership.groupId));
  return groups.filter((group) => groupIds.has(group.id));
}

async function upsertGroupMemberRoute(c: Context, config: AppConfig, store: AppStore): Promise<Response> {
  const auth = await requireRequestAuthorization(config, store, c);
  if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
  const groupId = c.req.param('groupId');
  if (!groupId) return writeError(c, 400, 'invalid_request', 'Expected groupId');
  const group = await store.getGroup(groupId);
  if (!group) return writeError(c, 404, 'not_found', 'Group not found');
  if (!canManageGroup(auth, group.id)) return writeError(c, 403, 'forbidden', 'Group admin access is required');

  const body = await readJsonBody(c, config.maxJsonBodyBytes);
  const userId = c.req.param('userId') || optionalString(body.userId);
  const role = parseGroupRole(body.role);
  if (!userId) return writeError(c, 400, 'invalid_request', 'Expected userId');
  if (!role) return writeError(c, 400, 'invalid_request', 'Expected valid group role');
  if (!(await store.listAuthUsers({ query: userId })).some((user) => user.id === userId)) {
    return writeError(c, 404, 'not_found', 'User not found');
  }
  if (!canManageAllGroups(auth) && role !== 'admin' && (await wouldRemoveLastGroupAdmin(store, group.id, userId))) {
    return writeError(c, 409, 'last_group_admin', 'Cannot remove the last group admin');
  }
  const now = new Date();
  const member = await store.upsertGroupMember({ groupId: group.id, userId, role, createdAt: now, updatedAt: now });
  return c.json({ member: serializeGroupMember(member) });
}

async function wouldRemoveLastGroupAdmin(store: AppStore, groupId: string, userId: string): Promise<boolean> {
  const members = await store.listGroupMembers(groupId);
  const member = members.find((candidate) => candidate.userId === userId);
  if (member?.role !== 'admin') return false;
  return members.filter((candidate) => candidate.role === 'admin').length <= 1;
}

function parseGroupRole(value: unknown): GroupRole | null {
  return value === 'viewer' || value === 'member' || value === 'admin' ? value : null;
}

function parseAutomationCreateRequiredRole(value: unknown): AutomationCreateRequiredRole | null {
  return value === 'member' || value === 'admin' ? value : null;
}
