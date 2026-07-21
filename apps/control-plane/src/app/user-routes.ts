import type { Context, Hono } from 'hono';
import { canManageAllGroups, readRequestAuthorization, type RequestAuthorization } from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import type { AppStore, AuthRole, AuthUserRecord } from '../store/types.js';
import { serializeBasicAuthUser } from './auth-routes.js';
import { writeError } from './http-error.js';
import { optionalString, readJsonBody } from './request.js';
import type { AppServices, AppVariables } from './server.js';

export function registerUserRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  app.get('/users', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    if (!canManageAllGroups(auth) && !auth.memberships.some((membership) => membership.role === 'admin')) {
      return writeError(c, 403, 'forbidden', 'Group admin access is required');
    }
    const users = await visibleUsersForGroupManager(services.store, auth, optionalString(c.req.query('query')));
    return c.json({ users: users.map(serializeBasicAuthUser) });
  });

  app.patch('/users/:userId', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    if (!canManageAllGroups(auth)) return writeError(c, 403, 'forbidden', 'Super admin access is required');

    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const role = parseAuthRole(body.role);
    if (!role) return writeError(c, 400, 'invalid_request', 'Expected valid user role');
    const userId = c.req.param('userId');
    if (!auth.bypass && role === 'user' && userId === auth.user.id) {
      return writeError(c, 409, 'self_super_admin', 'Cannot remove your own super admin access');
    }

    const user = await services.store.updateAuthUserRole({
      userId,
      role,
      updatedAt: new Date(),
    });
    if (!user) return writeError(c, 404, 'not_found', 'User not found');
    return c.json({ user: serializeBasicAuthUser(user) });
  });
}

async function requireRequestAuthorization(
  config: AppConfig,
  store: AppStore,
  c: Context,
): Promise<RequestAuthorization | null> {
  return readRequestAuthorization(config, store, c);
}

async function visibleUsersForGroupManager(
  store: AppStore,
  auth: RequestAuthorization,
  query: string | undefined,
): Promise<AuthUserRecord[]> {
  if (canManageAllGroups(auth)) return store.listAuthUsers(query ? { query } : {});
  const normalized = query?.trim().toLowerCase();
  if (normalized && normalized.length >= 2) return store.listAuthUsers({ query: normalized });

  const managedGroupIds = auth.memberships
    .filter((membership) => membership.role === 'admin')
    .map((membership) => membership.groupId);
  const users = new Map<string, AuthUserRecord>();
  for (const member of await store.listGroupMembersForGroups(managedGroupIds)) {
    users.set(member.user.id, member.user);
  }

  return [...users.values()]
    .filter(
      (user) =>
        !normalized ||
        user.id.toLowerCase() === normalized ||
        user.username.toLowerCase().includes(normalized) ||
        user.displayName?.toLowerCase().includes(normalized),
    )
    .sort((a, b) => a.username.localeCompare(b.username));
}

function parseAuthRole(value: unknown): AuthRole | null {
  return value === 'user' || value === 'super_admin' ? value : null;
}
