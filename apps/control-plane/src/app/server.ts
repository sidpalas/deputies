import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { ArtifactService, ArtifactServiceError } from '../artifacts/service.js';
import type { ArtifactObjectStorage } from '../artifacts/storage.js';
import { FetchGitHubOAuthClient, type GitHubOAuthClient } from '../auth/github.js';
import { apiAuthMiddleware, isTrustedCookieAuthRequest } from '../auth/middleware.js';
import { oauthSuccessHtml } from '../auth/oauth-success-page.js';
import {
  clearSessionCookie,
  clearHostSessionCookie,
  createSessionCookie,
  createSessionId,
  readSessionId,
  sessionMaxAgeSeconds,
  signOAuthState,
  verifyOAuthState,
} from '../auth/session.js';
import { CallbackService, CallbackServiceError } from '../callbacks/service.js';
import {
  requireAuthSessionSecret,
  requireGitHubOAuthCredentials,
  requireSlackSigningSecret,
  requireStaticCredentials,
  type AppConfig,
} from '../config/index.js';
import { EventService } from '../events/service.js';
import { ExternalResourceService } from '../external-resources/service.js';
import { GenericWebhookError, GenericWebhookService } from '../integrations/generic-webhook/service.js';
import { type GitHubArchivedSessionNotifier } from '../integrations/github/archived-session-notifier.js';
import {
  GitHubRepositoryAccessError,
  type GitHubRepositoryAccessService,
} from '../integrations/github/repository-access.js';
import { GitHubApiError } from '../integrations/github/client.js';
import { verifyGitHubWebhookSignature } from '../integrations/github/webhook-auth.js';
import { GitHubWebhookService } from '../integrations/github/webhook-service.js';
import { type GitHubIssueContextFetcher } from '../integrations/github/issue-context-fetcher.js';
import { type GitHubReactionSender } from '../integrations/github/reaction-sender.js';
import { SlackClient } from '../integrations/slack/client.js';
import { verifySlackSignature } from '../integrations/slack/auth.js';
import { SlackIntegrationError, SlackIntegrationService } from '../integrations/slack/service.js';
import type { SlackEventEnvelope } from '../integrations/slack/types.js';
import { MessageService, MessageServiceError } from '../messages/service.js';
import { SandboxCleanupService, SandboxKeepaliveService } from '../sandbox/service.js';
import { sandboxRuntimeId } from '../sandbox/runtime.js';
import type { SandboxProvider } from '../sandbox/types.js';
import { readServices } from '../sessions/services.js';
import { SessionService, SessionServiceError } from '../sessions/service.js';
import { MemoryStore } from '../store/memory.js';
import type { AppStore, AuthUserRecord, SandboxRecord, SessionRecord } from '../store/types.js';
import { writeGlobalEventStream, writeSessionEventStream } from './event-stream.js';
import {
  getSessionService,
  handleServiceUpgrade,
  isAuthorizedRequest,
  parseServiceHostFromRequest,
  parseServicePort,
  proxyService,
  serializeService,
} from './service-proxy.js';
import {
  HttpRequestError,
  optionalString,
  parseBranchBody,
  parseCursor,
  parseModelBody,
  parseRepositoryBody,
  readJsonBody,
  readRawBody,
} from './request.js';

type AppVariables = {
  requestId: string;
};

export type AppServices = {
  store: AppStore;
  events: EventService;
  sessions: SessionService;
  messages: MessageService;
  artifacts: ArtifactService;
  externalResources: ExternalResourceService;
  genericWebhooks: GenericWebhookService;
  callbacks: CallbackService;
  sandboxProvider?: SandboxProvider;
  sandboxCleanup?: SandboxCleanupService;
  sandboxKeepalive?: SandboxKeepaliveService;
  githubReactionSender?: Pick<GitHubReactionSender, 'addEyes'>;
  githubIssueContextFetcher?: Pick<GitHubIssueContextFetcher, 'listIssueComments'>;
  githubArchivedSessionNotifier?: Pick<GitHubArchivedSessionNotifier, 'postNotice' | 'postRecoveryAcknowledgement'>;
  githubRepositoryAccess?: Pick<GitHubRepositoryAccessService, 'listRepositories' | 'listBranches'>;
  githubOAuthClient?: GitHubOAuthClient;
};

export function createServices(
  store: AppStore = new MemoryStore(),
  options: {
    sandboxProvider?: SandboxProvider;
    artifactObjectStorage?: ArtifactObjectStorage;
    unsafeAllowLocalHttpCallbacks?: boolean;
  } = {},
): AppServices {
  const events = new EventService(store);
  const sessions = new SessionService(store, events);
  const messages = new MessageService(store, events);
  const services: AppServices = {
    store,
    events,
    sessions,
    messages,
    artifacts: new ArtifactService(store, events, options.artifactObjectStorage),
    externalResources: new ExternalResourceService(store, events),
    genericWebhooks: new GenericWebhookService(store, sessions, messages, {
      unsafeAllowLocalHttpCallbacks: Boolean(options.unsafeAllowLocalHttpCallbacks),
    }),
    callbacks: new CallbackService(store, events),
  };
  if (options.sandboxProvider) {
    services.sandboxProvider = options.sandboxProvider;
    services.sandboxCleanup = new SandboxCleanupService(store, events, options.sandboxProvider);
    services.sandboxKeepalive = new SandboxKeepaliveService(store, events, options.sandboxProvider);
  }
  return services;
}

export function createApp(config: AppConfig, services = createServices()) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', requestIdMiddleware());
  app.use(
    '*',
    cors({
      origin: allowedCorsOrigin(config),
      credentials: true,
      allowHeaders: ['authorization', 'content-type', 'x-request-id'],
      allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    }),
  );

  app.onError((error, c) => {
    if (error instanceof HttpRequestError) {
      return writeError(c, error.statusCode, error.code, error.message);
    }
    return writeError(c, 500, 'internal_error', error instanceof Error ? error.message : 'Unknown error');
  });

  app.notFound((c) => c.json({ error: 'not_found', message: 'Route not found' }, 404));

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      runMode: config.runMode,
      apiAuthMode: config.apiAuthMode,
      authProvider: config.apiAuthMode === 'session' ? config.authProvider : undefined,
      sandboxProvider: config.sandboxProvider,
    }),
  );

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
      profile: {},
      now: new Date(),
    });
    await setAuthSessionCookie(c, config, services.store, user.id);
    return c.json({ user: serializeAuthUser(user) });
  });

  app.get('/auth/oauth/github/start', (c) => {
    if (config.apiAuthMode !== 'session' || config.authProvider !== 'github')
      return writeError(c, 404, 'not_found', 'Route not found');
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
    if (config.apiAuthMode !== 'session' || config.authProvider !== 'github')
      return writeError(c, 404, 'not_found', 'Route not found');
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
    const organizations = config.authGithubAllowedOrganizations.length
      ? await client.listOrganizations(accessToken)
      : [];
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
    return c.html(oauthSuccessHtml(config.authSuccessRedirectUrl ?? '/'));
  });

  app.post('/auth/logout', async (c) => {
    if (config.apiAuthMode === 'session') {
      const sessionId = readSessionId(c);
      if (sessionId && !isTrustedCookieAuthRequest(c, config)) {
        return writeError(c, 403, 'forbidden', 'Untrusted browser request');
      }
      if (sessionId) await services.store.deleteAuthSession(sessionId);
      clearSessionCookies(c, config);
    }
    return c.json({ ok: true });
  });

  app.get('/auth/logout', async (c) => {
    if (config.apiAuthMode === 'session') {
      const sessionId = readSessionId(c);
      if (sessionId) await services.store.deleteAuthSession(sessionId);
      clearSessionCookies(c, config);
    }
    return c.redirect(config.authSuccessRedirectUrl ?? '/', 302);
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
  app.use('/repositories/*', apiAuthMiddleware(config, services.store));
  app.use('/repositories', apiAuthMiddleware(config, services.store));
  app.use('/models', apiAuthMiddleware(config, services.store));
  app.use('/events/*', apiAuthMiddleware(config, services.store));
  app.use('/events', apiAuthMiddleware(config, services.store));

  app.use('*', async (c, next) => {
    const serviceHost = parseServiceHostFromRequest(config, c);
    if (!serviceHost) {
      await next();
      return;
    }
    if (!(await isAuthorizedRequest(config, services.store, c)))
      return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const session = await services.sessions.get(serviceHost.sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    const service = await getSessionService(config, services, serviceHost.sessionId, serviceHost.port);
    if (!service) return writeError(c, 404, 'not_found', 'Service URL is not available for this sandbox');
    return proxyService(c, config, serviceHost.sessionId, serviceHost.port, service);
  });

  app.post('/sessions', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const title = optionalString(body.title);
    const session = await services.sessions.create(title ? { title } : {});
    return c.json({ session: await serializeSessionWithSandbox(config, services, session) }, 201);
  });

  app.get('/sessions', async (c) => {
    const sessions = await services.sessions.list();
    return c.json({
      sessions: await Promise.all(sessions.map((session) => serializeSessionWithSandbox(config, services, session))),
    });
  });

  app.get('/repositories', async (c) => {
    let repositories = configuredRepositoryOptions(config);
    if (services.githubRepositoryAccess) {
      try {
        const installedRepositories = await services.githubRepositoryAccess.listRepositories();
        if (installedRepositories.length) {
          repositories = installedRepositories.map((repository) => ({
            fullName: repository.fullName,
            owner: repository.owner,
            name: repository.repo,
            description: repository.description,
            private: repository.private,
            defaultBranch: repository.defaultBranch,
          }));
        }
      } catch {
        // Keep the picker useful when GitHub installation listing is temporarily unavailable.
      }
    }
    return c.json({ repositories });
  });

  app.get('/repositories/:owner/:repo/branches', async (c) => {
    if (!services.githubRepositoryAccess) return c.json({ branches: [] });
    try {
      const branches = await services.githubRepositoryAccess.listBranches({
        owner: c.req.param('owner'),
        repo: c.req.param('repo'),
      });
      return c.json({ branches });
    } catch (error) {
      return writeGitHubRepositoryError(c, error);
    }
  });

  app.get('/models', async (c) => {
    const models = config.flueModelOptions.length
      ? config.flueModelOptions
      : config.flueModel
        ? [config.flueModel]
        : [];
    return c.json({ models, defaultModel: config.flueModel ?? models[0] ?? null });
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
    return writeGlobalEventStream(c, services.events, after, c.req.query('replay') !== 'false', includeAll);
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
      const slackClient = config.slackBotToken
        ? new SlackClient({ apiBaseUrl: config.slackApiBaseUrl, botToken: config.slackBotToken })
        : null;
      const slackOptions = config.slackBotToken
        ? {
            assistantThreadClient: slackClient!,
            replyClient: slackClient!,
            reactionClient: slackClient!,
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
      const result = await new SlackIntegrationService(
        services.store,
        services.sessions,
        services.messages,
        slackOptions,
      ).handle(payload);
      if (result.type === 'challenge') return c.json({ challenge: result.challenge });
      return c.json({ ok: true, type: result.type });
    } catch (error) {
      if (error instanceof SlackIntegrationError) return writeError(c, 400, error.code, error.message);
      throw error;
    }
  });

  app.post('/webhooks/github/events', async (c) => {
    const body = await readRawBody(c, config.maxJsonBodyBytes, 'GitHub body');
    if (!config.githubWebhookSecret)
      return writeError(c, 500, 'configuration_error', 'GITHUB_WEBHOOK_SECRET is required for GitHub webhooks');
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
      ...(services.githubArchivedSessionNotifier
        ? { archivedSessionNotifier: services.githubArchivedSessionNotifier }
        : {}),
      ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
    }).handle({ headers, payload });
    return c.json(
      { ok: true, type: result.type, ...('reason' in result ? { reason: result.reason } : {}) },
      result.type === 'accepted' ? 202 : 200,
    );
  });

  app.get('/sessions/:sessionId', async (c) => {
    const session = await services.sessions.get(c.req.param('sessionId'));
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    return c.json({ session: await serializeSessionWithSandbox(config, services, session) });
  });

  app.patch('/sessions/:sessionId', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const title = optionalString(body.title);
    if (body.title !== undefined && !title)
      return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: title');

    try {
      const session = await services.sessions.update({ id: c.req.param('sessionId'), ...(title ? { title } : {}) });
      return c.json({ session: await serializeSessionWithSandbox(config, services, session) });
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
      return c.json({ session: await serializeSessionWithSandbox(config, services, session) });
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
      return c.json({ session: await serializeSessionWithSandbox(config, services, session) });
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
      return c.json({ session: await serializeSessionWithSandbox(config, services, session) });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found')
        return writeError(c, 404, 'not_found', 'Session not found');
      throw error;
    }
  });

  app.post('/sessions/:sessionId/queue/resume', async (c) => {
    try {
      const session = await services.sessions.resumeQueue(c.req.param('sessionId'));
      return c.json({ session: await serializeSessionWithSandbox(config, services, session) });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found')
        return writeError(c, 404, 'not_found', 'Session not found');
      throw error;
    }
  });

  app.post('/sessions/:sessionId/runs/current/cancel', async (c) => {
    try {
      const messages = await services.messages.cancelActiveRun({ sessionId: c.req.param('sessionId') });
      return c.json({ messages });
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'not_found')
        return writeError(c, 404, 'not_found', 'Session not found');
      if (error instanceof MessageServiceError && error.code === 'conflict')
        return writeError(c, 409, 'conflict', error.message);
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
      const model = parseModelBody(body.model, config);
      const branch = repository ? parseBranchBody(body.branch) : undefined;
      const context = {
        ...(repository ? { repository } : {}),
        ...(model ? { model } : {}),
        ...(repository && branch ? { branch } : {}),
      };
      const message = await services.messages.enqueue({
        sessionId,
        prompt,
        ...(await messageAuthor(c, config, services.store)),
        ...(Object.keys(context).length ? { context } : {}),
      });
      return c.json({ message }, 202);
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'not_found') {
        return writeError(c, 404, 'not_found', 'Session not found');
      }
      if (error instanceof MessageServiceError && error.code === 'conflict')
        return writeError(c, 409, 'conflict', error.message);
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
      const message = await services.messages.updatePending({
        sessionId: c.req.param('sessionId'),
        messageId: c.req.param('messageId'),
        prompt,
      });
      return c.json({ message });
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'conflict')
        return writeError(c, 409, 'conflict', error.message);
      throw error;
    }
  });

  app.post('/sessions/:sessionId/messages/:messageId/cancel', async (c) => {
    try {
      const message = await services.messages.cancelPending({
        sessionId: c.req.param('sessionId'),
        messageId: c.req.param('messageId'),
      });
      return c.json({ message });
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'conflict')
        return writeError(c, 409, 'conflict', error.message);
      throw error;
    }
  });

  app.post('/sessions/:sessionId/messages/:messageId/retry', async (c) => {
    try {
      const message = await services.messages.retryFailed({
        sessionId: c.req.param('sessionId'),
        messageId: c.req.param('messageId'),
      });
      return c.json({ message }, 202);
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'not_found')
        return writeError(c, 404, 'not_found', error.message);
      if (error instanceof MessageServiceError && error.code === 'conflict')
        return writeError(c, 409, 'conflict', error.message);
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

    const artifacts = await services.artifacts.list(sessionId);
    return c.json({ artifacts });
  });

  app.get('/sessions/:sessionId/external-resources', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const externalResources = await services.externalResources.list(sessionId);
    return c.json({ externalResources });
  });

  app.get('/sessions/:sessionId/artifacts/:artifactId/download', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    try {
      const download = await services.artifacts.getDownload({ sessionId, artifactId: c.req.param('artifactId') });
      const disposition = artifactDownloadDisposition(download.contentType, c.req.query('disposition'));
      const headers: Record<string, string> = {
        'content-type': download.contentType,
        'content-length': String(download.body.byteLength),
        'content-disposition': contentDisposition(download.fileName, disposition),
        'x-content-type-options': 'nosniff',
      };
      if (disposition === 'inline') headers['content-security-policy'] = inlineArtifactContentSecurityPolicy;
      return new Response(download.body, { headers });
    } catch (error) {
      if (error instanceof ArtifactServiceError && error.code === 'not_found')
        return writeError(c, 404, 'not_found', error.message);
      if (error instanceof ArtifactServiceError && error.code === 'storage_disabled')
        return writeError(c, 409, 'storage_disabled', error.message);
      throw error;
    }
  });

  app.get('/sessions/:sessionId/artifacts/:artifactId/preview', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    try {
      const preview = await services.artifacts.getPreview({ sessionId, artifactId: c.req.param('artifactId') });
      return c.json({
        artifact: preview.artifact,
        preview: {
          text: preview.text,
          contentType: preview.contentType,
          truncated: preview.truncated,
          sizeBytes: preview.sizeBytes,
        },
      });
    } catch (error) {
      if (error instanceof ArtifactServiceError && error.code === 'not_found')
        return writeError(c, 404, 'not_found', error.message);
      if (error instanceof ArtifactServiceError && error.code === 'storage_disabled')
        return writeError(c, 409, 'storage_disabled', error.message);
      if (error instanceof ArtifactServiceError && error.code === 'unsupported_preview')
        return writeError(c, 415, 'unsupported_preview', error.message);
      throw error;
    }
  });

  app.get('/sessions/:sessionId/services', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const requestedPort = parseServicePort(c.req.query('port'));
    const published = readServices(session.context ?? {});
    const requested = requestedPort ? [{ port: requestedPort }] : published;
    const liveServices = [];
    const sandbox = services.sandboxProvider
      ? await services.store.getActiveSandbox(sessionId, services.sandboxProvider.name)
      : null;
    const runtimeId = sandbox ? sandboxRuntimeId(sandbox) : undefined;
    for (const item of requested) {
      if (
        !requestedPort &&
        (!item.providerSandboxId ||
          item.providerSandboxId !== sandbox?.providerSandboxId ||
          !item.runtimeId ||
          item.runtimeId !== runtimeId)
      )
        continue;
      const service = await getSessionService(config, services, sessionId, item.port);
      if (service)
        liveServices.push(serializeService(c, config, sessionId, service, item, sandboxTiming(config, sandbox)));
    }
    return c.json({ services: liveServices });
  });

  app.post('/sessions/:sessionId/sandbox/extend', async (c) => {
    if (!services.sandboxKeepalive) return writeError(c, 404, 'not_found', 'Sandbox provider is not configured');
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const seconds = parseKeepaliveSeconds(body.seconds ?? body.ttlSeconds);
    const port = body.port === undefined ? undefined : parseServicePort(String(body.port));
    if (body.port !== undefined && !port) return writeError(c, 400, 'invalid_request', 'Invalid service port');

    const result = await services.sandboxKeepalive.extend({
      sessionId,
      durationMs: seconds * 1000,
      maxDurationMs: config.sandboxKeepaliveMaxExtensionMs,
      ...(port ? { port } : {}),
    });
    if (!result) return writeError(c, 404, 'not_found', 'Active sandbox is not available');
    return c.json({ sandbox: serializeSandboxKeepalive(config, result.record, result.providerSync) });
  });

  const handleServiceProxy = async (c: Context) => {
    const sessionId = c.req.param('sessionId');
    if (!sessionId) return writeError(c, 400, 'invalid_request', 'Missing session ID');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const port = parseServicePort(c.req.param('port'));
    if (!port) return writeError(c, 400, 'invalid_request', 'Invalid service port');
    const service = await getSessionService(config, services, sessionId, port);
    if (!service) return writeError(c, 404, 'not_found', 'Service URL is not available for this sandbox');
    return proxyService(c, config, sessionId, port, service);
  };

  app.all('/sessions/:sessionId/services/:port', handleServiceProxy);
  app.all('/sessions/:sessionId/services/:port/*', handleServiceProxy);

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
      if (error instanceof CallbackServiceError && error.code === 'conflict')
        return writeError(c, 409, 'conflict', error.message);
      throw error;
    }
  });

  app.get('/sessions/:sessionId/events/stream', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const after = parseCursor(c.req.query('after') ?? c.req.header('last-event-id') ?? null) ?? 0;
    return writeSessionEventStream(c, services.events, sessionId, after);
  });

  return app;
}

export function createServer(config: AppConfig, services = createServices()) {
  const server = createAdaptorServer({ fetch: createApp(config, services).fetch }) as Server;
  server.on('upgrade', (request, socket, head) => {
    handleServiceUpgrade(config, services, request, socket, head).catch(() => socket.destroy());
  });
  return server;
}

export function createWorkerHealthServer(config: AppConfig) {
  const app = new Hono();

  app.notFound((c) => c.json({ error: 'not_found', message: 'Route not found' }, 404));
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      runMode: config.runMode,
      apiAuthMode: config.apiAuthMode,
      authProvider: config.apiAuthMode === 'session' ? config.authProvider : undefined,
      sandboxProvider: config.sandboxProvider,
    }),
  );

  return createAdaptorServer({ fetch: app.fetch }) as Server;
}

function contentDisposition(fileName: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const fallback = fileName
    .replace(/[\\/\r\n\t\0]/g, '_')
    .replace(/[";]/g, '')
    .trim()
    .slice(0, 120);
  const safeFallback = fallback || 'artifact';
  return `${disposition}; filename="${safeFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

const inlineArtifactContentSecurityPolicy =
  "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

const inlineArtifactContentTypes = new Set([
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

function artifactDownloadDisposition(
  contentType: string,
  requestedDisposition: string | undefined,
): 'attachment' | 'inline' {
  if (requestedDisposition !== 'inline') return 'attachment';
  return inlineArtifactContentTypes.has(normalizeContentType(contentType)) ? 'inline' : 'attachment';
}

function normalizeContentType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
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

function writeGitHubRepositoryError(c: Context, error: unknown) {
  if (error instanceof GitHubRepositoryAccessError) {
    return writeError(c, 403, error.code, error.message);
  }
  if (error instanceof GitHubApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return writeError(c, 403, 'github_authorization_failed', 'GitHub authorization failed for this repository');
    }
    if (error.statusCode === 404) {
      return writeError(c, 404, 'github_repository_not_found', 'GitHub repository or installation was not found');
    }
    return writeError(c, 502, 'github_api_error', 'GitHub API request failed');
  }
  throw error;
}

function configuredRepositoryOptions(config: AppConfig) {
  return config.githubAllowedRepositories
    .filter((repository) => repository.includes('/') && !repository.includes('*'))
    .map((fullName) => {
      const [owner, name] = fullName.split('/');
      return { fullName, owner, name };
    });
}

function parseKeepaliveSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HttpRequestError(400, 'invalid_request', 'Expected positive integer seconds');
  }
  return value;
}

function sandboxTiming(
  config: AppConfig,
  sandbox: SandboxRecord | null,
): { shutdownAt?: Date; keepaliveUntil?: Date; maxKeepaliveUntil?: Date } {
  if (!sandbox || sandbox.status !== 'ready') return {};
  const now = new Date();
  const stopAt = new Date(sandbox.updatedAt.getTime() + config.sandboxStopDelayMs);
  const shutdownAt = sandbox.keepaliveUntil ?? stopAt;
  return {
    shutdownAt,
    maxKeepaliveUntil: new Date(now.getTime() + config.sandboxKeepaliveMaxExtensionMs),
    ...(sandbox.keepaliveUntil ? { keepaliveUntil: sandbox.keepaliveUntil } : {}),
  };
}

function serializeSandboxKeepalive(
  config: AppConfig,
  sandbox: SandboxRecord,
  providerSync: 'not_supported' | 'ok' | 'failed',
) {
  return {
    id: sandbox.id,
    provider: sandbox.provider,
    providerSandboxId: sandbox.providerSandboxId,
    status: sandbox.status,
    providerSync,
    ...serializeSandboxTiming(config, sandbox),
  };
}

type SessionDisplayStatus = { status: string; tooltip: string };

async function serializeSessionWithSandbox(config: AppConfig, services: AppServices, session: SessionRecord) {
  const sandbox = await services.store.getLatestSandbox(session.id, config.sandboxProvider);
  const display = sessionDisplayStatus(session, sandbox);
  const serialized = {
    ...session,
    displayStatus: display.status,
    displayStatusTooltip: display.tooltip,
  };

  if (!sandbox) return serialized;
  return { ...serialized, sandbox: serializeSandboxSummary(sandbox) };
}

function serializeSandboxSummary(sandbox: SandboxRecord) {
  return {
    id: sandbox.id,
    provider: sandbox.provider,
    providerSandboxId: sandbox.providerSandboxId,
    status: sandbox.status,
    updatedAt: sandbox.updatedAt,
    ...(sandbox.destroyedAt ? { destroyedAt: sandbox.destroyedAt } : {}),
  };
}

const sessionDisplayTooltips: Partial<Record<SessionRecord['status'], string>> = {
  archived: 'This session is archived and read-only until restored.',
  active: 'Deputy is working on the current message.',
  cancelled: 'The latest message was cancelled.',
  failed: 'The latest message failed.',
  queued: 'Waiting for a worker to pick up the next message.',
};

const sandboxDisplayStatus: Partial<Record<SandboxRecord['status'], SessionDisplayStatus>> = {
  destroyed: { status: 'expired', tooltip: 'Sandbox expired to control costs. Filesystem state was not preserved.' },
  ready: { status: 'ready', tooltip: 'Sandbox is active. Filesystem state and exposed services are available.' },
  stopped: { status: 'stopped', tooltip: 'Sandbox stopped to control costs. Exposed services are not running.' },
};

function sessionDisplayStatus(session: SessionRecord, sandbox: SandboxRecord | null): SessionDisplayStatus {
  const sessionTooltip = sessionDisplayTooltips[session.status];
  if (sessionTooltip) return { status: session.status, tooltip: sessionTooltip };

  const sandboxDisplay = sandbox ? sandboxDisplayStatus[sandbox.status] : undefined;
  if (sandboxDisplay) return sandboxDisplay;

  return { status: session.status, tooltip: `Session is ${session.status}.` };
}

function serializeSandboxTiming(config: AppConfig, sandbox: SandboxRecord) {
  const timing = sandboxTiming(config, sandbox);
  return {
    ...(timing.shutdownAt ? { shutdownAt: timing.shutdownAt.toISOString() } : {}),
    ...(timing.keepaliveUntil ? { keepaliveUntil: timing.keepaliveUntil.toISOString() } : {}),
    ...(timing.maxKeepaliveUntil ? { maxKeepaliveUntil: timing.maxKeepaliveUntil.toISOString() } : {}),
  };
}

function clearSessionCookies(c: Context, config: AppConfig): void {
  c.header('set-cookie', clearSessionCookie(config));
  if (config.authCookieDomain) c.header('set-cookie', clearHostSessionCookie(config), { append: true });
}

async function messageAuthor(
  c: Context,
  config: AppConfig,
  store: AppStore,
): Promise<{ authorUserId: string; authorName: string } | Record<string, never>> {
  if (config.apiAuthMode !== 'session') return {};
  const sessionId = readSessionId(c);
  const user = sessionId ? await store.getAuthUserBySession({ sessionId, now: new Date() }) : null;
  return user ? { authorUserId: user.id, authorName: user.username } : {};
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
