import { randomUUID, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { ArtifactService, ArtifactServiceError } from '../artifacts/service.js';
import type { ArtifactObjectStorage } from '../artifacts/storage.js';
import { FetchGitHubOAuthClient, type GitHubOAuthClient } from '../auth/github.js';
import { apiAuthMiddleware } from '../auth/middleware.js';
import {
  clearSessionCookie,
  createSessionCookie,
  createSessionId,
  readSessionId,
  sessionCookieName,
  sessionMaxAgeSeconds,
  signOAuthState,
  verifyOAuthState,
} from '../auth/session.js';
import { CallbackService, CallbackServiceError } from '../callbacks/service.js';
import {
  requireAuthSessionSecret,
  requireApiBearerToken,
  requireGitHubOAuthCredentials,
  requireSlackSigningSecret,
  requireStaticCredentials,
  type AppConfig,
} from '../config/index.js';
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
import { readPreviews } from '../runner-flue/preview-tool.js';
import { SandboxCleanupService } from '../sandbox/service.js';
import type { SandboxPreviewUrl, SandboxProvider } from '../sandbox/types.js';
import { SessionService, SessionServiceError } from '../sessions/service.js';
import { MemoryStore } from '../store/memory.js';
import type { AppStore, AuthUserRecord } from '../store/types.js';
import { writeGlobalEventStream, writeSessionEventStream } from './event-stream.js';
import {
  HttpRequestError,
  optionalString,
  parseCursor,
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
  genericWebhooks: GenericWebhookService;
  callbacks: CallbackService;
  sandboxProvider?: SandboxProvider;
  sandboxCleanup?: SandboxCleanupService;
  githubReactionSender?: Pick<GitHubReactionSender, 'addEyes'>;
  githubIssueContextFetcher?: Pick<GitHubIssueContextFetcher, 'listIssueComments'>;
  githubArchivedSessionNotifier?: Pick<GitHubArchivedSessionNotifier, 'postNotice' | 'postRecoveryAcknowledgement'>;
  githubOAuthClient?: GitHubOAuthClient;
};

export function createServices(
  store: AppStore = new MemoryStore(),
  options: { sandboxProvider?: SandboxProvider; artifactObjectStorage?: ArtifactObjectStorage } = {},
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
    genericWebhooks: new GenericWebhookService(store, sessions, messages),
    callbacks: new CallbackService(store, events),
  };
  if (options.sandboxProvider) {
    services.sandboxProvider = options.sandboxProvider;
    services.sandboxCleanup = new SandboxCleanupService(store, events, options.sandboxProvider);
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

  app.use('*', async (c, next) => {
    const previewHost = parsePreviewHostFromRequest(config, c);
    if (!previewHost) {
      await next();
      return;
    }
    if (!(await isAuthorizedRequest(config, services.store, c)))
      return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const session = await services.sessions.get(previewHost.sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    const preview = await getSessionPreview(config, services, previewHost.sessionId, previewHost.port);
    if (!preview) return writeError(c, 404, 'not_found', 'Preview URL is not available for this sandbox');
    return proxyPreview(c, config, previewHost.sessionId, previewHost.port, preview);
  });

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
    return c.json({ session });
  });

  app.patch('/sessions/:sessionId', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const title = optionalString(body.title);
    if (body.title !== undefined && !title)
      return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: title');

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
      if (error instanceof SessionServiceError && error.code === 'not_found')
        return writeError(c, 404, 'not_found', 'Session not found');
      throw error;
    }
  });

  app.post('/sessions/:sessionId/queue/resume', async (c) => {
    try {
      const session = await services.sessions.resumeQueue(c.req.param('sessionId'));
      return c.json({ session });
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

  app.get('/sessions/:sessionId/artifacts/:artifactId/download', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    try {
      const download = await services.artifacts.getDownload({ sessionId, artifactId: c.req.param('artifactId') });
      return new Response(download.body, {
        headers: {
          'content-type': download.contentType,
          'content-length': String(download.body.byteLength),
          'content-disposition': contentDisposition(download.fileName),
        },
      });
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

  app.get('/sessions/:sessionId/previews', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const requestedPort = parsePreviewPort(c.req.query('port'));
    const published = readPreviews(session.context ?? {});
    const requested = requestedPort ? [{ port: requestedPort }] : published;
    const previews = [];
    for (const item of requested) {
      if (item.providerSandboxId && !(await isActivePreviewSandbox(services, sessionId, item.providerSandboxId)))
        continue;
      const preview = await getSessionPreview(config, services, sessionId, item.port);
      if (preview) previews.push(serializePreview(c, config, sessionId, preview, item));
    }
    return c.json({ previews });
  });

  const handlePreviewProxy = async (c: Context) => {
    const sessionId = c.req.param('sessionId');
    if (!sessionId) return writeError(c, 400, 'invalid_request', 'Missing session ID');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const port = parsePreviewPort(c.req.param('port'));
    if (!port) return writeError(c, 400, 'invalid_request', 'Invalid preview port');
    const preview = await getSessionPreview(config, services, sessionId, port);
    if (!preview) return writeError(c, 404, 'not_found', 'Preview URL is not available for this sandbox');
    return proxyPreview(c, config, sessionId, port, preview);
  };

  app.all('/sessions/:sessionId/previews/:port', handlePreviewProxy);
  app.all('/sessions/:sessionId/previews/:port/*', handlePreviewProxy);

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
    handlePreviewUpgrade(config, services, request, socket, head).catch(() => socket.destroy());
  });
  return server;
}

function contentDisposition(fileName: string): string {
  const fallback = fileName
    .replace(/[\\/\r\n\t\0]/g, '_')
    .replace(/[";]/g, '')
    .trim()
    .slice(0, 120);
  const safeFallback = fallback || 'artifact';
  return `attachment; filename="${safeFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
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

async function getSessionPreview(
  config: AppConfig,
  services: AppServices,
  sessionId: string,
  port: number,
): Promise<SandboxPreviewUrl | null> {
  const provider = services.sandboxProvider;
  if (!provider?.getPreviewUrl || !provider.capabilities.previewUrls) return null;
  const sandbox = await services.store.getActiveSandbox(sessionId, provider.name);
  if (!sandbox) return null;
  const health = await provider.health(sandbox);
  if (health.status !== 'ready') return null;
  const preview = await provider.getPreviewUrl({
    providerSandboxId: sandbox.providerSandboxId,
    sessionId,
    port,
  });
  return preview && isAllowedPreviewTarget(config, provider.name, preview.targetUrl) ? preview : null;
}

async function isActivePreviewSandbox(
  services: AppServices,
  sessionId: string,
  providerSandboxId: string,
): Promise<boolean> {
  const provider = services.sandboxProvider;
  if (!provider) return false;
  const sandbox = await services.store.getActiveSandbox(sessionId, provider.name);
  return sandbox?.providerSandboxId === providerSandboxId;
}

function isAllowedPreviewTarget(config: AppConfig, provider: string, value: string): boolean {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (provider === 'fake') return target.protocol === 'http:';
  if (provider === 'docker') return isAllowedDockerPreviewTarget(config, target);
  if (provider === 'daytona') return target.protocol === 'https:' && !isLocalOrPrivateHostname(target.hostname);
  return !isLocalOrPrivateHostname(target.hostname);
}

function isAllowedDockerPreviewTarget(config: AppConfig, target: URL): boolean {
  const allowedHosts = new Set(['localhost', '127.0.0.1', config.dockerSandboxBridgeHost]);
  return target.protocol === 'http:' && allowedHosts.has(target.hostname.toLowerCase());
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.'))
    return true;
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
    const first = parts[0]!;
    const second = parts[1]!;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 169 && second === 254) return true;
  }
  return host === '::1' || host.startsWith('fc') || host.startsWith('fd');
}

function serializePreview(
  c: Context,
  config: AppConfig,
  sessionId: string,
  preview: SandboxPreviewUrl,
  metadata: { label?: string; path?: string } = {},
) {
  const url = previewUrl(c, config, sessionId, preview.port, metadata.path);
  return {
    port: preview.port,
    url,
    status: 'available',
    ...(metadata.label ? { label: metadata.label } : {}),
    ...(metadata.path ? { path: metadata.path } : {}),
  };
}

async function proxyPreview(
  c: Context,
  config: AppConfig,
  sessionId: string,
  port: number,
  preview: SandboxPreviewUrl,
): Promise<Response> {
  const isHostPreview = Boolean(parsePreviewHostFromRequest(config, c));
  const target = previewTargetUrl(c, sessionId, port, preview.targetUrl, isHostPreview);
  const request = c.req.raw;
  const response = await fetch(target, {
    method: request.method,
    headers: previewRequestHeaders(request.headers, preview.targetHeaders),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const headers = previewResponseHeaders(response.headers, sessionId, port, !isHostPreview);
  if (!isHostPreview && isHtmlResponse(headers)) {
    const text = rewritePreviewHtml(await response.text(), previewBasePath(sessionId, port));
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function previewTargetUrl(
  c: Context,
  sessionId: string,
  port: number,
  targetUrl: string,
  isHostPreview: boolean,
): string {
  return previewTargetUrlFromUrl(new URL(c.req.url), isHostPreview, sessionId, port, targetUrl);
}

function previewTargetUrlFromUrl(
  incoming: URL,
  isHostPreview: boolean,
  sessionId: string,
  port: number,
  targetUrl: string,
): string {
  const prefix = `/sessions/${sessionId}/previews/${port}`;
  let suffix = '/';
  if (isHostPreview) {
    suffix = incoming.pathname || '/';
  } else if (incoming.pathname.startsWith(prefix)) {
    suffix = incoming.pathname.slice(prefix.length) || '/';
  }
  const target = new URL(targetUrl);
  target.pathname = joinUrlPath(target.pathname, suffix);
  target.search = incoming.search;
  return target.toString();
}

function previewUrl(c: Context, config: AppConfig, sessionId: string, port: number, path = '/'): string {
  const baseUrl = config.webBaseUrl ? new URL(config.webBaseUrl) : null;
  const requestUrl = new URL(c.req.url);
  const requestHost = baseUrl?.host ?? previewRequestHost(config, c) ?? requestUrl.host;
  const protocol =
    baseUrl?.protocol.replace(/:$/, '') ?? c.req.header('x-forwarded-proto') ?? requestUrl.protocol.replace(/:$/, '');
  const domain = config.previewBaseDomain ?? previewDomainFromHost(requestHost);
  const suffix = path.startsWith('/') ? path.slice(1) : path;
  if (!domain) return `${previewBasePath(sessionId, port)}${suffix}`;
  return `${protocol}://${previewHostLabel(sessionId, port)}.${domain}/${suffix}`;
}

function previewDomainFromHost(host: string): string | null {
  const hostname = host.split(':')[0] ?? '';
  const port = host.includes(':') ? `:${host.split(':').pop()}` : '';
  if (hostname === 'deputies.localhost' || hostname.endsWith('.deputies.localhost')) return `${hostname}${port}`;
  return null;
}

function previewHostLabel(sessionId: string, port: number): string {
  return `p-${port}-${sessionId}`;
}

function parsePreviewHost(
  host: string | undefined,
  allowedDomains?: string[],
): { sessionId: string; port: number } | null {
  const hostname = host?.split(':')[0]?.toLowerCase();
  if (!hostname) return null;
  if (allowedDomains?.length && !allowedDomains.some((domain) => hostname.endsWith(`.${domain}`))) return null;
  const label = hostname.split('.')[0];
  const match = label?.match(/^p-(\d+)-(.+)$/);
  if (!match) return null;
  const port = parsePreviewPort(match[1]);
  if (!port) return null;
  return { port, sessionId: match[2]! };
}

function parsePreviewHostFromRequest(config: AppConfig, c: Context): { sessionId: string; port: number } | null {
  return parsePreviewHostFromHosts(previewRequestHosts(config, c), previewAllowedDomains(config, c));
}

function parsePreviewHostFromNodeRequest(
  config: AppConfig,
  request: IncomingMessage,
): { sessionId: string; port: number } | null {
  return parsePreviewHostFromHosts(previewNodeRequestHosts(config, request), previewAllowedDomains(config, request));
}

function parsePreviewHostFromHosts(
  hosts: string[],
  allowedDomains: string[],
): { sessionId: string; port: number } | null {
  for (const host of hosts) {
    const parsed = parsePreviewHost(host, allowedDomains);
    if (parsed) return parsed;
  }
  return null;
}

function previewRequestHost(config: AppConfig, c: Context): string | undefined {
  return previewRequestHosts(config, c)[0];
}

function previewRequestHosts(config: AppConfig, c: Context): string[] {
  return previewHeaderHosts(
    previewHostHeaderValues(
      config,
      c.req.header('host'),
      c.req.header('x-forwarded-host'),
      c.req.header('x-original-host'),
    ),
  );
}

function previewNodeRequestHosts(config: AppConfig, request: IncomingMessage): string[] {
  return previewHeaderHosts(
    previewHostHeaderValues(
      config,
      request.headers.host,
      request.headers['x-forwarded-host'],
      request.headers['x-original-host'],
    ),
  );
}

function previewHostHeaderValues(
  config: AppConfig,
  host: string | string[] | undefined,
  forwardedHost: string | string[] | undefined,
  originalHost: string | string[] | undefined,
): Array<string | string[] | undefined> {
  return config.previewTrustForwardedHosts ? [forwardedHost, originalHost, host] : [host];
}

function previewHeaderHosts(values: Array<string | string[] | undefined>): string[] {
  return values.flatMap((value) => {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items.flatMap((item) =>
      item
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean),
    );
  });
}

function previewAllowedDomains(config: AppConfig, request?: Context | IncomingMessage): string[] {
  const domains = new Set<string>();
  if (config.previewBaseDomain) domains.add(stripPort(config.previewBaseDomain));
  if (config.webBaseUrl) {
    const derived = previewDomainFromHost(new URL(config.webBaseUrl).host);
    if (derived) domains.add(stripPort(derived));
  }
  const host = previewAllowedDomainRequestHost(request);
  const firstHost = Array.isArray(host) ? host[0] : host;
  if (firstHost) {
    const derived = previewDomainFromHost(firstHost);
    if (derived) domains.add(stripPort(derived));
  }
  return Array.from(domains);
}

function previewAllowedDomainRequestHost(request?: Context | IncomingMessage): string | string[] | undefined {
  if (!request) return undefined;
  if ('req' in request) return request.req.header('host');
  return request.headers.host;
}

function stripPort(host: string): string {
  return host.split(':')[0]?.toLowerCase() ?? host.toLowerCase();
}

async function handlePreviewUpgrade(
  config: AppConfig,
  services: AppServices,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const incoming = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const hostPreview = parsePreviewHostFromNodeRequest(config, request);
  const pathMatch = incoming.pathname.match(/^\/sessions\/([^/]+)\/previews\/(\d+)(?:\/.*)?$/);
  if (!hostPreview && !pathMatch) {
    socket.destroy();
    return;
  }

  const sessionId = hostPreview?.sessionId ?? decodeURIComponent(pathMatch?.[1] ?? '');
  const port = hostPreview?.port ?? parsePreviewPort(pathMatch?.[2]);
  if (!port || !(await isAuthorizedUpgrade(config, services, request))) {
    socket.destroy();
    return;
  }
  const session = await services.sessions.get(sessionId);
  if (!session) {
    socket.destroy();
    return;
  }
  const preview = await getSessionPreview(config, services, sessionId, port);
  if (!preview) {
    socket.destroy();
    return;
  }

  const upgradeInput: {
    request: IncomingMessage;
    socket: Duplex;
    head: Buffer;
    targetUrl: string;
    targetHeaders?: Record<string, string>;
    preserveOrigin: boolean;
  } = {
    request,
    socket,
    head,
    targetUrl: previewTargetUrlFromUrl(incoming, Boolean(hostPreview), sessionId, port, preview.targetUrl),
    preserveOrigin: Boolean(hostPreview),
  };
  if (preview.targetHeaders) upgradeInput.targetHeaders = preview.targetHeaders;
  proxyPreviewUpgrade(upgradeInput);
}

async function isAuthorizedUpgrade(
  config: AppConfig,
  services: AppServices,
  request: IncomingMessage,
): Promise<boolean> {
  if (config.apiAuthMode === 'none') return true;
  if (config.apiAuthMode === 'bearer')
    return request.headers.authorization === `Bearer ${requireApiBearerToken(config)}`;
  const authSessionId = parseCookieHeader(request.headers.cookie ?? '')[sessionCookieName];
  return Boolean(
    authSessionId && (await services.store.getAuthUserBySession({ sessionId: authSessionId, now: new Date() })),
  );
}

async function isAuthorizedRequest(config: AppConfig, store: AppStore, c: Context): Promise<boolean> {
  if (config.apiAuthMode === 'none') return true;
  if (config.apiAuthMode === 'bearer')
    return c.req.header('authorization') === `Bearer ${requireApiBearerToken(config)}`;
  const authSessionId = readSessionId(c);
  return Boolean(authSessionId && (await store.getAuthUserBySession({ sessionId: authSessionId, now: new Date() })));
}

function proxyPreviewUpgrade(input: {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  targetUrl: string;
  targetHeaders?: Record<string, string>;
  preserveOrigin: boolean;
}): void {
  const target = new URL(input.targetUrl);
  const secure = target.protocol === 'https:' || target.protocol === 'wss:';
  const port = Number(target.port || (secure ? 443 : 80));
  const upstream = secure
    ? tls.connect({ host: target.hostname, port, servername: target.hostname })
    : net.connect({ host: target.hostname, port });
  let connected = false;
  const start = () => {
    if (connected) return;
    connected = true;
    upstream.write(upgradeRequestHead(input.request, target, input.targetHeaders, input.preserveOrigin));
    if (input.head.length) upstream.write(input.head);
    upstream.pipe(input.socket);
    input.socket.pipe(upstream);
  };
  const close = () => {
    upstream.destroy();
    input.socket.destroy();
  };
  if (secure) upstream.once('secureConnect', start);
  else upstream.once('connect', start);
  upstream.once('error', close);
  input.socket.once('error', close);
}

function upgradeRequestHead(
  request: IncomingMessage,
  target: URL,
  injected: Record<string, string> = {},
  preserveOrigin = false,
): string {
  const headers = previewUpgradeHeaders(request, target, injected, preserveOrigin);
  const path = `${target.pathname || '/'}${target.search}`;
  return [
    `${request.method ?? 'GET'} ${path} HTTP/1.1`,
    ...headers.map(([key, value]) => `${key}: ${value}`),
    '',
    '',
  ].join('\r\n');
}

function previewUpgradeHeaders(
  request: IncomingMessage,
  target: URL,
  injected: Record<string, string>,
  preserveOrigin: boolean,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [['host', target.host]];
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (['authorization', 'cookie', 'host', 'content-length'].includes(lower)) continue;
    if (lower === 'origin' && !preserveOrigin) continue;
    if (Array.isArray(value)) for (const item of value) headers.push([key, item]);
    else if (value !== undefined) headers.push([key, value]);
  }
  const origin = previewUpstreamOrigin(target);
  if (!preserveOrigin && origin) headers.push(['origin', origin]);
  for (const [key, value] of Object.entries(injected)) headers.push([key, value]);
  return headers;
}

function previewUpstreamOrigin(target: URL): string | null {
  if (target.protocol === 'http:' || target.protocol === 'https:') return target.origin;
  if (target.protocol === 'ws:') return `http://${target.host}`;
  if (target.protocol === 'wss:') return `https://${target.host}`;
  return null;
}

function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name || !rest.length) continue;
    cookies[name] = rest.join('=');
  }
  return cookies;
}

function joinUrlPath(basePath: string, suffix: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const rest = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${base}${rest}` || '/';
}

function previewRequestHeaders(input: Headers, injected: Record<string, string> = {}): Headers {
  const headers = new Headers();
  for (const [key, value] of input.entries()) {
    const lower = key.toLowerCase();
    if (['authorization', 'cookie', 'host', 'connection', 'content-length'].includes(lower)) continue;
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(injected)) headers.set(key, value);
  return headers;
}

function previewResponseHeaders(input: Headers, sessionId: string, port: number, rewriteLocations: boolean): Headers {
  const headers = new Headers();
  for (const [key, value] of input.entries()) {
    const lower = key.toLowerCase();
    if (['connection', 'content-encoding', 'content-length', 'set-cookie', 'transfer-encoding'].includes(lower))
      continue;
    headers.set(key, lower === 'location' && rewriteLocations ? rewritePreviewLocation(value, sessionId, port) : value);
  }
  return headers;
}

function isHtmlResponse(headers: Headers): boolean {
  return headers.get('content-type')?.toLowerCase().includes('text/html') ?? false;
}

function rewritePreviewHtml(html: string, basePath: string): string {
  return html
    .replace(/(\s(?:src|href|action)=['"])\/(?!\/)/gi, `$1${basePath}`)
    .replace(/(\s(?:srcset)=['"])([^'"]*)(['"])/gi, (_match, prefix: string, value: string, suffix: string) => {
      return `${prefix}${rewriteSrcSet(value, basePath)}${suffix}`;
    })
    .replace(/([\s(['"])(\/(?!\/)[^\s)'"<]+)/g, `$1${basePath}$2`);
}

function rewriteSrcSet(value: string, basePath: string): string {
  return value
    .split(',')
    .map((part) => part.trimStart().replace(/^\/(?!\/)/, basePath))
    .join(', ');
}

function rewritePreviewLocation(location: string, sessionId: string, port: number): string {
  if (!location.startsWith('/')) return location;
  return `${previewBasePath(sessionId, port)}${location.replace(/^\//, '')}`;
}

function previewBasePath(sessionId: string, port: number): string {
  return `/sessions/${sessionId}/previews/${port}/`;
}

function parsePreviewPort(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
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

function oauthSuccessHtml(redirectUrl: string): string {
  const escapedUrl = escapeHtmlAttribute(redirectUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="refresh" content="0; url=${escapedUrl}">
    <title>Sign in complete</title>
  </head>
  <body>
    <p>Sign in complete. Redirecting to <a href="${escapedUrl}">Deputies</a>.</p>
    <script>window.location.replace(${JSON.stringify(redirectUrl)});</script>
  </body>
</html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
