import type { Context, Hono } from 'hono';
import { canAdministerTenant, readRequestAuthorization, type RequestAuthorization } from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import { StoreConflictError, type AppStore, type AuthRole } from '../store/types.js';
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
    if (!canAdministerTenant(auth)) return writeError(c, 403, 'forbidden', 'Admin access is required');
    const query = optionalString(c.req.query('query'));
    const users = await services.store.listAuthUsers(query ? { query } : {});
    return c.json({ users: users.map(serializeBasicAuthUser) });
  });

  app.patch('/users/:userId', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    if (!canAdministerTenant(auth)) return writeError(c, 403, 'forbidden', 'Admin access is required');

    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const role = parseAuthRole(body.role);
    if (!role) return writeError(c, 400, 'invalid_request', 'Expected valid user role');
    const userId = c.req.param('userId');
    let user;
    try {
      user = await services.store.updateAuthUserRole({ userId, role, updatedAt: new Date() });
    } catch (error) {
      if (error instanceof StoreConflictError && error.code === 'last_admin') {
        return writeError(c, 409, 'last_admin', error.message);
      }
      throw error;
    }
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

function parseAuthRole(value: unknown): AuthRole | null {
  return value === 'viewer' || value === 'member' || value === 'admin' ? value : null;
}
