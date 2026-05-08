import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { FetchGitHubOAuthClient, type GitHubOAuthClient } from '../auth/github.js';
import { apiAuthMiddleware } from '../auth/middleware.js';
import { clearSessionCookie, createSessionCookie, createSessionId, readSessionId, sessionMaxAgeSeconds, signOAuthState, verifyOAuthState } from '../auth/session.js';
import { CallbackService, CallbackServiceError } from '../callbacks/service.js';
import { requireAuthSessionSecret, requireGitHubOAuthCredentials, requireSlackSigningSecret, requireStaticCredentials, type AppConfig } from '../config/index.js';
import { EventService } from '../events/service.js';
import { GenericWebhookError, GenericWebhookService } from '../integrations/generic-webhook/service.js';
import { type GitHubArchivedSessionNotifier } from '../integrations/github/archived-session-notifier.js';
import { verifyGitHubWebhookSignature } from '../integrations/github/webhook-auth.js';
import { GitHubWebhookService } from '../integrations/github/webhook-service.js';
import { type GitHubIssueContextFetcher } from '../integrations/github/issue-context-fetcher.js';
import { type GitHubReactionSender } from '../integrations/github/reaction-sender.js';
import { SlackClient } from '../integrations/slack/client.js';
import { verifySlackSignature } from '../integrations/slack/auth.js';
import { SlackIntegrationError, SlackIntegrationService } from '../integrations/slack/service.js';
import type { SlackEventEnvelope } from '../integrations/slack/types.js';
import { MessageService, MessageServiceError } from '../messages/service.js';
import { extractRepositoryReference, type RepositoryReference } from '../repositories/extract.js';
import { SandboxCleanupService } from '../sandbox/service.js';
import type { SandboxProvider } from '../sandbox/types.js';
import { SessionService, SessionServiceError } from '../sessions/service.js';
import { MemoryStore } from '../store/memory.js';
import type { AppStore, AuthUserRecord } from '../store/types.js';

type AppVariables = {
  requestId: string;
};

export type AppServices = {
  store: AppStore;
  events: EventService;
  sessions: SessionService;
  messages: MessageService;
  genericWebhooks: GenericWebhookService;
  callbacks: CallbackService;
  sandboxCleanup?: SandboxCleanupService;
  githubReactionSender?: Pick<GitHubReactionSender, 'addEyes'>;
  githubIssueContextFetcher?: Pick<GitHubIssueContextFetcher, 'listIssueComments'>;
  githubArchivedSessionNotifier?: Pick<GitHubArchivedSessionNotifier, 'postNotice' | 'postRecoveryAcknowledgement'>;
  githubOAuthClient?: GitHubOAuthClient;
};

export function createServices(store: AppStore = new MemoryStore(), options: { sandboxProvider?: SandboxProvider } = {}): AppServices {
  const events = new EventService(store);
  const sessions = new SessionService(store, events);
  const messages = new MessageService(store, events);
  const services: AppServices = {
    store,
    events,
    sessions,
    messages,
    genericWebhooks: new GenericWebhookService(store, sessions, messages),
    callbacks: new CallbackService(store, events),
  };
  if (options.sandboxProvider) services.sandboxCleanup = new SandboxCleanupService(store, events, options.sandboxProvider);
  return services;
}

export function createApp(config: AppConfig, services = createServices()) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', requestIdMiddleware());
  app.use('*', cors({ origin: allowedCorsOrigin(config), credentials: true, allowHeaders: ['authorization', 'content-type', 'x-request-id'], allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'] }));

  app.onError((error, c) => {
    if (error instanceof HttpRequestError) {
      return writeError(c, error.statusCode, error.code, error.message);
    }
    return writeError(c, 500, 'internal_error', error instanceof Error ? error.message : 'Unknown error');
  });

  app.notFound((c) => c.json({ error: 'not_found', message: 'Route not found' }, 404));

  app.get('/health', (c) => c.json({
    status: 'ok',
    runMode: config.runMode,
    apiAuthMode: config.apiAuthMode,
    authProvider: config.apiAuthMode === 'session' ? config.authProvider : undefined,
    sandboxProvider: config.sandboxProvider,
  }));

  app.get('/auth/config', (c) => c.json({
    apiAuthMode: config.apiAuthMode,
    provider: config.apiAuthMode === 'session' ? config.authProvider : undefined,
  }));

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
      profile: {},
      now: new Date(),
    });
    await setAuthSessionCookie(c, config, services.store, user.id);
    return c.json({ user: serializeAuthUser(user) });
  });

  app.get('/auth/oauth/github/start', (c) => {
    if (config.apiAuthMode !== 'session' || config.authProvider !== 'github') return writeError(c, 404, 'not_found', 'Route not found');
    const { clientId } = requireGitHubOAuthCredentials(config);
    const redirectUri = githubOAuthCallbackUrl(c, config);
    const state = signOAuthState({ provider: 'github', exp: Math.floor(Date.now() / 1000) + 10 * 60 }, requireAuthSessionSecret(config));
    const authorizeUrl = new URL('/login/oauth/authorize', config.githubOAuthBaseUrl);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('scope', 'read:user read:org');
    return c.redirect(authorizeUrl.toString(), 302);
  });

  app.get('/auth/oauth/github/callback', async (c) => {
    if (config.apiAuthMode !== 'session' || config.authProvider !== 'github') return writeError(c, 404, 'not_found', 'Route not found');
    const state = c.req.query('state');
    const code = c.req.query('code');
    if (!state || !verifyOAuthState(state, requireAuthSessionSecret(config)) || !code) {
      return writeError(c, 400, 'invalid_request', 'Invalid GitHub OAuth callback');
    }

    const credentials = requireGitHubOAuthCredentials(config);
    const client = services.githubOAuthClient ?? new FetchGitHubOAuthClient({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      oauthBaseUrl: config.githubOAuthBaseUrl,
      apiBaseUrl: config.githubApiBaseUrl,
    });
    const accessToken = await client.exchangeCode({ code, redirectUri: githubOAuthCallbackUrl(c, config) });
    const githubUser = await client.getUser(accessToken);
    const organizations = config.authGithubAllowedOrganizations.length ? await client.listOrganizations(accessToken) : [];
    if (!isAllowedGitHubLogin(githubUser.login, organizations, config)) {
      return writeError(c, 403, 'forbidden', 'GitHub user is not allowed');
    }

    const user = await services.store.upsertAuthUserForAccount({
      userId: randomUUID(),
      accountId: randomUUID(),
      provider: 'github',
      providerAccountId: String(githubUser.id),
      username: githubUser.login,
      ...(githubUser.name ? { displayName: githubUser.name } : {}),
      ...(githubUser.avatar_url ? { avatarUrl: githubUser.avatar_url } : {}),
      profile: { login: githubUser.login, id: githubUser.id },
      now: new Date(),
    });
    await setAuthSessionCookie(c, config, services.store, user.id);
    return c.redirect(config.authSuccessRedirectUrl ?? '/', 302);
  });

  app.post('/auth/logout', async (c) => {
    if (config.apiAuthMode === 'session') {
      const sessionId = readSessionId(c);
      if (sessionId) await services.store.deleteAuthSession(sessionId);
      c.header('set-cookie', clearSessionCookie(config));
    }
    return c.json({ ok: true });
  });

  app.get('/auth/me', async (c) => {
    if (config.apiAuthMode === 'none') return c.json({ user: null });
    if (config.apiAuthMode === 'bearer') return c.json({ user: null });
    const sessionId = readSessionId(c);
    const user = sessionId ? await services.store.getAuthUserBySession({ sessionId, now: new Date() }) : null;
    if (!user) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    return c.json({ user: serializeAuthUser(user) });
  });

  app.use('/sessions/*', apiAuthMiddleware(config, services.store));
  app.use('/sessions', apiAuthMiddleware(config, services.store));
  app.use('/events/*', apiAuthMiddleware(config, services.store));
  app.use('/events', apiAuthMiddleware(config, services.store));

  app.post('/sessions', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const title = optionalString(body.title);
    const session = await services.sessions.create(title ? { title } : {});
    return c.json({ session }, 201);
  });

  app.get('/sessions', async (c) => {
    const sessions = await services.sessions.list();
    return c.json({ sessions });
  });

  app.get('/events', async (c) => {
    const after = parseCursor(c.req.query('after') ?? null);
    const includeAll = c.req.query('include') === 'all';
    const events = includeAll ? await services.events.listAllEvents(after) : await services.events.listAll(after);
    return c.json({ events });
  });

  app.get('/events/stream', async (c) => {
    const after = parseCursor(c.req.query('after') ?? c.req.header('last-event-id') ?? null) ?? 0;
    const includeAll = c.req.query('include') === 'all';
    return writeGlobalEventStream(c, services, after, c.req.query('replay') !== 'false', includeAll);
  });

  app.post('/webhooks/generic/:sourceKey', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);

    try {
      const result = await services.genericWebhooks.handle({
        sourceKey: c.req.param('sourceKey'),
        authorization: c.req.header('authorization'),
        payload: body,
      });
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof GenericWebhookError) {
        const status = error.code === 'unauthorized' ? 401 : error.code === 'not_found' ? 404 : 400;
        return writeError(c, status, error.code, error.message);
      }
      throw error;
    }
  });

  app.post('/webhooks/slack/events', async (c) => {
    const body = await readRawBody(c, config.maxJsonBodyBytes, 'Slack body');
    const signingSecret = requireSlackSigningSecret(config);
    const signatureValid = verifySlackSignature({
      signature: c.req.header('x-slack-signature'),
      timestamp: c.req.header('x-slack-request-timestamp'),
      body,
      signingSecret,
    });
    if (!signatureValid) return writeError(c, 401, 'unauthorized', 'Invalid Slack signature');

    let payload: SlackEventEnvelope;
    try {
      payload = JSON.parse(body) as SlackEventEnvelope;
    } catch {
      return writeError(c, 400, 'invalid_json', 'Expected valid Slack JSON payload');
    }

    try {
      const slackClient = config.slackBotToken ? new SlackClient({ apiBaseUrl: config.slackApiBaseUrl, botToken: config.slackBotToken }) : null;
      const slackOptions = config.slackBotToken
        ? {
            reactionClient: slackClient!,
            replyClient: slackClient!,
            threadClient: slackClient!,
            infoClient: slackClient!,
            allowedTeamIds: config.slackAllowedTeamIds,
            allowedChannelIds: config.slackAllowedChannelIds,
            allowedUserIds: config.slackAllowedUserIds,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          }
        : {
            allowedTeamIds: config.slackAllowedTeamIds,
            allowedChannelIds: config.slackAllowedChannelIds,
            allowedUserIds: config.slackAllowedUserIds,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          };
      const result = await new SlackIntegrationService(services.store, services.sessions, services.messages, slackOptions).handle(payload);
      if (result.type === 'challenge') return c.json({ challenge: result.challenge });
      return c.json({ ok: true, type: result.type });
    } catch (error) {
      if (error instanceof SlackIntegrationError) return writeError(c, 400, error.code, error.message);
      throw error;
    }
  });

  app.post('/webhooks/github/events', async (c) => {
    const body = await readRawBody(c, config.maxJsonBodyBytes, 'GitHub body');
    if (!config.githubWebhookSecret) return writeError(c, 500, 'configuration_error', 'GITHUB_WEBHOOK_SECRET is required for GitHub webhooks');
    const signatureValid = verifyGitHubWebhookSignature({
      signature: c.req.header('x-hub-signature-256'),
      body,
      secret: config.githubWebhookSecret,
    });
    if (!signatureValid) return writeError(c, 401, 'unauthorized', 'Invalid GitHub signature');

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return writeError(c, 400, 'invalid_json', 'Expected valid GitHub JSON payload');
    }

    const headers: { deliveryId?: string; event?: string } = {};
    const deliveryId = c.req.header('x-github-delivery');
    const event = c.req.header('x-github-event');
    if (deliveryId) headers.deliveryId = deliveryId;
    if (event) headers.event = event;

    const result = await new GitHubWebhookService(services.store, services.sessions, services.messages, {
      allowedUsers: config.githubAllowedUsers,
      allowedOrganizations: config.githubAllowedOrganizations,
      allowedRepositories: config.githubAllowedRepositories,
      triggerPhrases: config.githubTriggerPhrases,
      ...(services.githubReactionSender ? { reactionSender: services.githubReactionSender } : {}),
      ...(services.githubIssueContextFetcher ? { issueContextFetcher: services.githubIssueContextFetcher } : {}),
      ...(services.githubArchivedSessionNotifier ? { archivedSessionNotifier: services.githubArchivedSessionNotifier } : {}),
      ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
    }).handle({ headers, payload });
    return c.json({ ok: true, type: result.type, ...('reason' in result ? { reason: result.reason } : {}) }, result.type === 'accepted' ? 202 : 200);
  });

  app.get('/sessions/:sessionId', async (c) => {
    const session = await services.sessions.get(c.req.param('sessionId'));
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    return c.json({ session });
  });

  app.patch('/sessions/:sessionId', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const title = optionalString(body.title);
    if (body.title !== undefined && !title) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: title');

    try {
      const session = await services.sessions.update({ id: c.req.param('sessionId'), ...(title ? { title } : {}) });
      return c.json({ session });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found') {
        return writeError(c, 404, 'not_found', 'Session not found');
      }
      throw error;
    }
  });

  app.post('/sessions/:sessionId/archive', async (c) => {
    try {
      const session = await services.sessions.archive(c.req.param('sessionId'));
      await services.sandboxCleanup?.destroySessionSandboxes(session.id);
      return c.json({ session });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found') {
        return writeError(c, 404, 'not_found', 'Session not found');
      }
      throw error;
    }
  });

  app.post('/sessions/:sessionId/unarchive', async (c) => {
    try {
      const session = await services.sessions.unarchive(c.req.param('sessionId'));
      return c.json({ session });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found') {
        return writeError(c, 404, 'not_found', 'Session not found');
      }
      throw error;
    }
  });

  app.post('/sessions/:sessionId/queue/pause', async (c) => {
    try {
      const session = await services.sessions.pauseQueue(c.req.param('sessionId'));
      return c.json({ session });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found') return writeError(c, 404, 'not_found', 'Session not found');
      throw error;
    }
  });

  app.post('/sessions/:sessionId/queue/resume', async (c) => {
    try {
      const session = await services.sessions.resumeQueue(c.req.param('sessionId'));
      return c.json({ session });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found') return writeError(c, 404, 'not_found', 'Session not found');
      throw error;
    }
  });

  app.post('/sessions/:sessionId/runs/current/cancel', async (c) => {
    try {
      const messages = await services.messages.cancelActiveRun({ sessionId: c.req.param('sessionId') });
      return c.json({ messages });
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'not_found') return writeError(c, 404, 'not_found', 'Session not found');
      if (error instanceof MessageServiceError && error.code === 'conflict') return writeError(c, 409, 'conflict', error.message);
      throw error;
    }
  });

  app.post('/sessions/:sessionId/messages', async (c) => {
    const sessionId = c.req.param('sessionId');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const prompt = optionalString(body.prompt);
    if (!prompt) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: prompt');

    try {
      const repository = parseRepositoryBody(body.repository);
      const message = await services.messages.enqueue({
        sessionId,
        prompt,
        ...(repository ? { context: { repository } } : {}),
      });
      return c.json({ message }, 202);
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'not_found') {
        return writeError(c, 404, 'not_found', 'Session not found');
      }
      if (error instanceof MessageServiceError && error.code === 'conflict') return writeError(c, 409, 'conflict', error.message);
      throw error;
    }
  });

  app.get('/sessions/:sessionId/messages', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const messages = await services.messages.list(sessionId);
    return c.json({ messages });
  });

  app.patch('/sessions/:sessionId/messages/:messageId', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const prompt = optionalString(body.prompt);
    if (!prompt) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: prompt');
    try {
      const message = await services.messages.updatePending({ sessionId: c.req.param('sessionId'), messageId: c.req.param('messageId'), prompt });
      return c.json({ message });
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'conflict') return writeError(c, 409, 'conflict', error.message);
      throw error;
    }
  });

  app.post('/sessions/:sessionId/messages/:messageId/cancel', async (c) => {
    try {
      const message = await services.messages.cancelPending({ sessionId: c.req.param('sessionId'), messageId: c.req.param('messageId') });
      return c.json({ message });
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'conflict') return writeError(c, 409, 'conflict', error.message);
      throw error;
    }
  });

  app.get('/sessions/:sessionId/events', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const after = parseCursor(c.req.query('after') ?? null);
    const events = await services.events.list(sessionId, after);
    return c.json({ events });
  });

  app.get('/sessions/:sessionId/artifacts', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const artifacts = await services.store.getArtifacts(sessionId);
    return c.json({ artifacts });
  });

  app.get('/sessions/:sessionId/callbacks', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const messageId = optionalString(c.req.query('messageId'));
    const callbacks = await services.callbacks.list({ sessionId, ...(messageId ? { messageId } : {}) });
    return c.json({ callbacks });
  });

  app.post('/sessions/:sessionId/callbacks/:deliveryId/replay', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    try {
      const callback = await services.callbacks.requestReplay({ sessionId, deliveryId: c.req.param('deliveryId') });
      return c.json({ callback });
    } catch (error) {
      if (error instanceof CallbackServiceError && error.code === 'conflict') return writeError(c, 409, 'conflict', error.message);
      throw error;
    }
  });

  app.get('/sessions/:sessionId/events/stream', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const after = parseCursor(c.req.query('after') ?? c.req.header('last-event-id') ?? null) ?? 0;
    return writeSessionEventStream(c, services, sessionId, after);
  });

  return app;
}

export function createServer(config: AppConfig, services = createServices()) {
  return createAdaptorServer({ fetch: createApp(config, services).fetch }) as Server;
}

function requestIdMiddleware(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    c.set('requestId', c.req.header('x-request-id') ?? randomUUID());
    await next();
  };
}

function allowedCorsOrigin(config: AppConfig): (origin: string) => string | undefined {
  const allowed = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
  if (config.webBaseUrl) allowed.add(new URL(config.webBaseUrl).origin);
  return (origin) => (allowed.has(origin) ? origin : undefined);
}

function writeError(c: Context, statusCode: number, error: string, message: string) {
  return c.json({ error, message }, statusCode as never);
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
  c.header('set-cookie', createSessionCookie({ sessionId, secure: config.authCookieSecure }));
}

function serializeAuthUser(user: AuthUserRecord) {
  return {
    id: user.id,
    username: user.username,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

function githubOAuthCallbackUrl(c: Context, config: AppConfig): string {
  if (config.githubAppCallbackUrl) return config.githubAppCallbackUrl;
  return new URL('/auth/oauth/github/callback', c.req.url).toString();
}

function isAllowedGitHubLogin(username: string, organizations: string[], config: AppConfig): boolean {
  const allowedUsers = new Set(config.authGithubAllowedUsers.map((user) => user.toLowerCase()));
  const allowedOrganizations = new Set(config.authGithubAllowedOrganizations.map((org) => org.toLowerCase()));
  if (!allowedUsers.size && !allowedOrganizations.size) return true;
  if (allowedUsers.has(username.toLowerCase())) return true;
  return organizations.some((org) => allowedOrganizations.has(org.toLowerCase()));
}

function safeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function writeSessionEventStream(
  c: Context,
  services: AppServices,
  sessionId: string,
  afterSequence: number,
): Promise<Response> {
  return writeEventStream(c, {
    after: afterSequence,
    id: (event) => event.sequence,
    list: () => services.events.list(sessionId, afterSequence),
    subscribe: (writeEvent) => services.events.subscribe(sessionId, writeEvent),
  });
}

async function writeGlobalEventStream(
  c: Context,
  services: AppServices,
  afterId: number,
  replay: boolean,
  includeAll: boolean,
): Promise<Response> {
  return writeEventStream(c, {
    after: afterId,
    id: (event) => event.id,
    list: () => includeAll ? services.events.listAllEvents(afterId) : services.events.listAll(afterId),
    replay,
    subscribe: (writeEvent) => includeAll ? services.events.subscribeAllEvents(writeEvent) : services.events.subscribeAll(writeEvent),
  });
}

async function writeEventStream(
  c: Context,
  options: {
    after: number;
    id: (event: Awaited<ReturnType<EventService['listAll']>>[number]) => number;
    list: () => Promise<Awaited<ReturnType<EventService['listAll']>>>;
    replay?: boolean;
    subscribe: (writeEvent: (event: Awaited<ReturnType<EventService['listAll']>>[number]) => void) => () => void;
  },
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let cursor = options.after;

  const write = async (chunk: string) => {
    await writer.write(encoder.encode(chunk));
  };
  const writeEvent = (event: Awaited<ReturnType<EventService['list']>>[number]) => {
    const eventId = options.id(event);
    if (eventId <= cursor) return;
    cursor = eventId;
    write(`id: ${eventId}\n`)
      .then(() => write(`event: ${event.type}\n`))
      .then(() => write(`data: ${JSON.stringify(event)}\n\n`))
      .catch(() => {});
  };

  const unsubscribe = options.subscribe(writeEvent);
  const heartbeat = setInterval(() => {
    write(': keep-alive\n\n').catch(() => {});
  }, 15_000);

  c.req.raw.signal.addEventListener('abort', () => {
    clearInterval(heartbeat);
    unsubscribe();
    writer.close().catch(() => {});
  });

  void (async () => {
    try {
      await write(': connected\n\n');
      if (options.replay !== false) {
        for (const event of await options.list()) {
          writeEvent(event);
        }
      }
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

async function readJsonBody(c: Context, maxBytes: number): Promise<Record<string, unknown>> {
  const text = await readRawBody(c, maxBytes, 'JSON body');

  const trimmed = text.trim();
  if (!trimmed) return {};

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new HttpRequestError(400, 'invalid_json', 'Expected valid JSON request body');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpRequestError(400, 'invalid_request', 'Expected JSON object request body');
  }

  return value as Record<string, unknown>;
}

async function readRawBody(c: Context, maxBytes: number, label: string): Promise<string> {
  const text = await c.req.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new HttpRequestError(413, 'payload_too_large', `${label} exceeds ${maxBytes} bytes`);
  }
  return text;
}

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseRepositoryBody(value: unknown): RepositoryReference | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  if (typeof value === 'string') {
    const reference = extractRepositoryReference(value);
    if (!reference) throw new HttpRequestError(400, 'invalid_request', 'Expected repository as owner/repo or GitHub URL');
    return reference;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpRequestError(400, 'invalid_request', 'Expected repository as owner/repo, GitHub URL, or object');
  }

  const repository = value as Record<string, unknown>;
  if (repository.provider !== 'github') throw new HttpRequestError(400, 'invalid_request', 'Expected repository.provider to be github');
  const owner = optionalString(repository.owner);
  const repo = optionalString(repository.repo);
  if (!owner || !repo) throw new HttpRequestError(400, 'invalid_request', 'Expected repository.owner and repository.repo');

  const reference = extractRepositoryReference(`repo:${owner}/${repo}`);
  if (!reference) throw new HttpRequestError(400, 'invalid_request', 'Expected valid GitHub repository owner and name');
  return reference;
}

function parseCursor(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}
