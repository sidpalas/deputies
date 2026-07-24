import type { Context, MiddlewareHandler } from 'hono';
import { requireApiBearerToken } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import type { AppStore } from '../store/types.js';
import { readRequestAuthUser } from './authorization.js';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const trustedDevOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

export function apiAuthMiddleware(config: AppConfig, store: AppStore): MiddlewareHandler {
  return async (c, next) => {
    if (config.apiAuthMode === 'none') {
      await next();
      return;
    }

    if (config.apiAuthMode === 'session') {
      const user = await readRequestAuthUser(config, store, c);
      if (!user) return writeAuthError(c, 'Missing or invalid session');
      if (!isTrustedCookieAuthRequest(c, config)) return writeCsrfError(c);
      await next();
      return;
    }

    const authorization = c.req.header('authorization');
    if (authorization !== `Bearer ${requireApiBearerToken(config)}`) {
      return writeAuthError(c, 'Missing or invalid bearer token');
    }

    await next();
  };
}

export function apiAdminMiddleware(config: AppConfig, store: AppStore): MiddlewareHandler {
  return async (c, next) => {
    if (config.apiAuthMode !== 'session') {
      await next();
      return;
    }

    const user = await readRequestAuthUser(config, store, c);
    if (!user) return writeAuthError(c, 'Missing or invalid session');
    if (user.role !== 'admin') return c.json({ error: 'forbidden', message: 'Super admin access is required' }, 403);
    await next();
  };
}

export function apiUnsafeMethodAdminMiddleware(config: AppConfig, store: AppStore): MiddlewareHandler {
  return async (c, next) => {
    if (!unsafeMethods.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }
    return apiAdminMiddleware(config, store)(c, next);
  };
}

function writeAuthError(c: Context, message: string) {
  return c.json({ error: 'unauthorized', message }, 401);
}

function writeCsrfError(c: Context) {
  return c.json({ error: 'forbidden', message: 'Untrusted browser request' }, 403);
}

export function isTrustedCookieAuthRequest(c: Context, config: AppConfig): boolean {
  if (!unsafeMethods.has(c.req.method.toUpperCase())) return true;

  const secFetchSite = c.req.header('sec-fetch-site')?.toLowerCase();
  if (secFetchSite === 'cross-site') return false;

  const origin = c.req.header('origin');
  if (!origin) return true;
  return trustedOrigins(c, config).has(origin);
}

function trustedOrigins(c: Context, config: AppConfig): Set<string> {
  const origins = new Set(trustedDevOrigins);
  origins.add(new URL(c.req.url).origin);
  if (config.webBaseUrl) origins.add(new URL(config.webBaseUrl).origin);
  return origins;
}
