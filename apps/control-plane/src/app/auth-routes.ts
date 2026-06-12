import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { FetchGitHubOAuthClient } from '../auth/github.js';
import { isTrustedCookieAuthRequest } from '../auth/middleware.js';
import { oauthSuccessHtml } from '../auth/oauth-success-page.js';
import {
  clearSessionCookie,
  createSessionCookie,
  createSessionId,
  readSessionId,
  sessionMaxAgeSeconds,
  signOAuthState,
  verifyOAuthState,
} from '../auth/session.js';
import {
  requireAuthSessionSecret,
  requireGitHubOAuthCredentials,
  requireStaticCredentials,
  type AppConfig,
} from '../config/index.js';
import { defaultGroupId, type AppStore, type AuthRole, type AuthUserRecord, type GroupRole } from '../store/types.js';
import { serializeGroupMember } from './group-routes.js';
import { writeError } from './http-error.js';
import { optionalString, readJsonBody } from './request.js';
import type { AppServices, AppVariables } from './server.js';

export function registerAuthRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  app.get('/auth/config', (c) =>
    c.json({
      apiAuthMode: config.apiAuthMode,
      provider: config.apiAuthMode === 'session' ? config.authProvider : undefined,
    }),
  );

  app.post('/auth/login', async (c) => {
    if (config.apiAuthMode !== 'session') return writeError(c, 404, 'not_found', 'Route not found');
    if (config.authProvider !== 'static') return writeError(c, 404, 'not_found', 'Route not found');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const username = optionalString(body.username);
    const password = optionalString(body.password);
    if (!username || !password) return writeError(c, 400, 'invalid_request', 'Expected username and password');

    const credentials = requireStaticCredentials(config);
    if (!safeStringEqual(username, credentials.username) || !safeStringEqual(password, credentials.password)) {
      return writeError(c, 401, 'unauthorized', 'Invalid username or password');
    }

    const user = await services.store.upsertAuthUserForAccount({
      userId: randomUUID(),
      accountId: randomUUID(),
      provider: 'static',
      providerAccountId: username,
      username,
      role: 'super_admin',
      profile: {},
      now: new Date(),
    });
    await ensureDefaultGroupMembership(services.store, user.id, 'admin');
    await setAuthSessionCookie(c, config, services.store, user.id);
    return c.json({ user: await serializeAuthUser(services.store, user) });
  });

  app.get('/auth/oauth/github/start', (c) => {
    if (config.apiAuthMode !== 'session' || config.authProvider !== 'github') {
      return writeError(c, 404, 'not_found', 'Route not found');
    }
    const { clientId } = requireGitHubOAuthCredentials(config);
    const redirectUri = githubOAuthCallbackUrl(c, config);
    const state = signOAuthState(
      { provider: 'github', exp: Math.floor(Date.now() / 1000) + 10 * 60 },
      requireAuthSessionSecret(config),
    );
    const authorizeUrl = new URL('/login/oauth/authorize', config.githubOAuthBaseUrl);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('scope', 'read:user read:org');
    return c.redirect(authorizeUrl.toString(), 302);
  });

  app.get('/auth/oauth/github/callback', async (c) => {
    if (config.apiAuthMode !== 'session' || config.authProvider !== 'github') {
      return writeError(c, 404, 'not_found', 'Route not found');
    }
    const state = c.req.query('state');
    const code = c.req.query('code');
    if (!state || !verifyOAuthState(state, requireAuthSessionSecret(config)) || !code) {
      return writeError(c, 400, 'invalid_request', 'Invalid GitHub OAuth callback');
    }

    const credentials = requireGitHubOAuthCredentials(config);
    const client =
      services.githubOAuthClient ??
      new FetchGitHubOAuthClient({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        oauthBaseUrl: config.githubOAuthBaseUrl,
        apiBaseUrl: config.githubApiBaseUrl,
      });
    const accessToken = await client.exchangeCode({ code, redirectUri: githubOAuthCallbackUrl(c, config) });
    const githubUser = await client.getUser(accessToken);
    const organizations = hasGitHubOrganizationRoleAllowlist(config) ? await client.listOrganizations(accessToken) : [];
    const authAssignment = githubAuthAssignment(githubUser.login, organizations, config);
    if (!authAssignment) {
      return writeError(c, 403, 'forbidden', 'GitHub user is not allowed');
    }

    const user = await services.store.upsertAuthUserForAccount({
      userId: randomUUID(),
      accountId: randomUUID(),
      provider: 'github',
      providerAccountId: String(githubUser.id),
      username: githubUser.login,
      role: authAssignment.role,
      ...(githubUser.name ? { displayName: githubUser.name } : {}),
      ...(githubUser.avatar_url ? { avatarUrl: githubUser.avatar_url } : {}),
      profile: { login: githubUser.login, id: githubUser.id },
      now: new Date(),
    });
    await ensureDefaultGroupMembership(services.store, user.id, authAssignment.defaultGroupRole);
    await setAuthSessionCookie(c, config, services.store, user.id);
    return c.html(oauthSuccessHtml(config.webBaseUrl ?? '/'));
  });

  app.post('/auth/logout', async (c) => {
    if (config.apiAuthMode === 'session') {
      const sessionId = readSessionId(config, c);
      if (sessionId && !isTrustedCookieAuthRequest(c, config)) {
        return writeError(c, 403, 'forbidden', 'Untrusted browser request');
      }
      if (sessionId) await services.store.deleteAuthSession(sessionId);
      clearSessionCookies(c, config);
    }
    return c.json({ ok: true });
  });

  app.get('/auth/logout', async (c) => c.redirect(config.webBaseUrl ?? '/', 302));

  app.get('/auth/me', async (c) => {
    if (config.apiAuthMode === 'none') return c.json({ user: null });
    if (config.apiAuthMode === 'bearer') return c.json({ user: null });
    const sessionId = readSessionId(config, c);
    const user = sessionId ? await services.store.getAuthUserBySession({ sessionId, now: new Date() }) : null;
    if (!user) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    return c.json({ user: await serializeAuthUser(services.store, user) });
  });
}

async function setAuthSessionCookie(c: Context, config: AppConfig, store: AppStore, userId: string): Promise<void> {
  const now = new Date();
  const sessionId = createSessionId();
  await store.createAuthSession({
    id: sessionId,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + sessionMaxAgeSeconds * 1000),
  });
  c.header('set-cookie', createSessionCookie(config, sessionId));
}

async function serializeAuthUser(store: AppStore, user: AuthUserRecord) {
  return {
    ...serializeBasicAuthUser(user),
    memberships: (await store.listUserGroupMemberships(user.id)).map(serializeGroupMember),
  };
}

export function serializeBasicAuthUser(user: AuthUserRecord) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

function clearSessionCookies(c: Context, config: AppConfig): void {
  c.header('set-cookie', clearSessionCookie(config));
}

async function ensureDefaultGroupMembership(store: AppStore, userId: string, role: GroupRole): Promise<void> {
  const now = new Date();
  await store.upsertGroupMember({ groupId: defaultGroupId, userId, role, createdAt: now, updatedAt: now });
}

function githubOAuthCallbackUrl(c: Context, config: AppConfig): string {
  if (config.githubOAuthCallbackUrl) return config.githubOAuthCallbackUrl;
  return new URL('/auth/oauth/github/callback', c.req.url).toString();
}

function githubAuthAssignment(
  username: string,
  organizations: string[],
  config: AppConfig,
): { role: AuthRole; defaultGroupRole: GroupRole } | null {
  if (matchesGitHubUserAllowlist(username, config.authGithubAdminUsers)) {
    return { role: 'super_admin', defaultGroupRole: 'admin' };
  }
  if (
    matchesGitHubAllowlist(
      username,
      organizations,
      config.authGithubAllowedUsers,
      config.authGithubAllowedOrganizations,
    )
  ) {
    return { role: 'user', defaultGroupRole: config.authGithubDefaultGroupRole };
  }
  if (config.unsafeAuthGithubAllowAll) return { role: 'user', defaultGroupRole: 'member' };
  return null;
}

function hasGitHubOrganizationRoleAllowlist(config: AppConfig): boolean {
  return Boolean(config.authGithubAllowedOrganizations.length);
}

function matchesGitHubUserAllowlist(username: string, allowedUsers: string[]): boolean {
  return new Set(allowedUsers.map((user) => user.toLowerCase())).has(username.toLowerCase());
}

function matchesGitHubAllowlist(
  username: string,
  organizations: string[],
  allowedUsers: string[],
  allowedOrganizations: string[],
): boolean {
  const users = new Set(allowedUsers.map((user) => user.toLowerCase()));
  const orgs = new Set(allowedOrganizations.map((org) => org.toLowerCase()));
  if (users.has(username.toLowerCase())) return true;
  return organizations.some((org) => orgs.has(org.toLowerCase()));
}

function safeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
