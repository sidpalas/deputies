import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { AutomationService } from '../automations/service.js';
import { ArtifactService, ArtifactServiceError } from '../artifacts/service.js';
import type { ArtifactObjectStorage } from '../artifacts/storage.js';
import {
  canInvokeSkillInSession,
  canReadSession,
  canUseEnvironment,
  canWriteSession,
  readRequestAuthorization,
  readRequestAuthUser,
  type RequestAuthorization,
} from '../auth/authorization.js';
import type { GitHubOAuthClient } from '../auth/github.js';
import { apiAdminMiddleware, apiAuthMiddleware } from '../auth/middleware.js';
import { readSessionId } from '../auth/session.js';
import { CallbackService, CallbackServiceError } from '../callbacks/service.js';
import { requireApiBearerToken, type AppConfig } from '../config/index.js';
import { EventService } from '../events/service.js';
import { EnvironmentService } from '../environments/service.js';
import { ExternalResourceService } from '../external-resources/service.js';
import { GenericWebhookService } from '../integrations/generic-webhook/service.js';
import { type GitHubArchivedSessionNotifier } from '../integrations/github/archived-session-notifier.js';
import { type GitHubRepositoryAccessService } from '../integrations/github/repository-access.js';
import { type GitHubIssueContextFetcher } from '../integrations/github/issue-context-fetcher.js';
import { type GitHubReactionSender } from '../integrations/github/reaction-sender.js';
import { MessageService, MessageServiceError } from '../messages/service.js';
import { SandboxCleanupService, SandboxKeepaliveService, SandboxLifecycleService } from '../sandbox/service.js';
import { SnippetService } from '../snippets/service.js';
import { NotepadService } from '../notepads/service.js';
import { sandboxRuntimeId } from '../sandbox/runtime.js';
import type { SandboxProvider } from '../sandbox/types.js';
import { registerSnippetRoutes } from './snippet-routes.js';
import { registerNotepadRoutes } from './notepad-routes.js';
import { readServices } from '../sessions/services.js';
import { SessionService, SessionServiceError } from '../sessions/service.js';
import { SkillService } from '../skills/service.js';
import { canonicalizeMessageSkillContext, SkillContextError } from '../skills/invocation.js';
import { normalizeSessionTags } from '../sessions/tags.js';
import { MemoryStore } from '../store/memory.js';
import {
  StoreConflictError,
  type AppStore,
  type SandboxRecord,
  type SessionListCursor,
  type SessionRecord,
} from '../store/types.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerAutomationRoutes } from './automation-routes.js';
import { registerEnvironmentRoutes } from './environment-routes.js';
import { registerEventRoutes } from './event-routes.js';
import { writeSessionEventStream } from './event-stream.js';
import { writeError } from './http-error.js';
import { ModelAvailabilityService } from './model-availability.js';
import { registerModelRoutes } from './model-routes.js';
import { registerRepositoryRoutes } from './repository-routes.js';
import { registerSetupRoutes } from './setup-routes.js';
import { registerSkillRoutes } from './skill-routes.js';
import { routeTelemetryMiddleware } from './telemetry-middleware.js';
import { registerTelemetryRoutes } from './telemetry-routes.js';
import { registerUserRoutes } from './user-routes.js';
import { registerWebhookRoutes } from './webhook-routes.js';
import {
  appendPreviewCookie,
  authorizePreviewToken,
  authorizePreviewRequest,
  createPreviewAuthToken,
  getSessionService,
  handleServiceUpgrade,
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
  parseReasoningLevelBody,
  parseRepositoryBody,
  readJsonBody,
} from './request.js';
import {
  destroyedSandboxWorkspaceMessage,
  publishWorkspaceToolService,
  startWorkspaceTool,
  type WorkspaceToolPublishInput,
  workspaceTool,
  workspaceToolKeepaliveMs,
  workspaceToolServiceMetadata,
  workspaceToolServicePath,
  workspaceToolWorkingDirectory,
} from './workspace-tools.js';

export type AppVariables = {
  requestId: string;
  authorizedSession?: SessionRecord;
  privateWriteLeaseActive?: boolean;
};

export type AppServices = {
  store: AppStore;
  events: EventService;
  environments: EnvironmentService;
  sessions: SessionService;
  messages: MessageService;
  automations: AutomationService;
  skills: SkillService;
  snippets: SnippetService;
  notepads: NotepadService;
  artifacts: ArtifactService;
  externalResources: ExternalResourceService;
  genericWebhooks: GenericWebhookService;
  callbacks: CallbackService;
  sandboxProvider?: SandboxProvider;
  sandboxCleanup?: SandboxCleanupService;
  sandboxKeepalive?: SandboxKeepaliveService;
  sandboxLifecycle?: SandboxLifecycleService;
  githubReactionSender?: Pick<GitHubReactionSender, 'addEyes'>;
  githubIssueContextFetcher?: Pick<GitHubIssueContextFetcher, 'listIssueComments'>;
  githubArchivedSessionNotifier?: Pick<GitHubArchivedSessionNotifier, 'postNotice' | 'postRecoveryAcknowledgement'>;
  githubRepositoryAccess?: Pick<GitHubRepositoryAccessService, 'listRepositories' | 'listBranches'>;
  githubOAuthClient?: GitHubOAuthClient;
  modelAvailability: ModelAvailabilityService;
};

const maxSearchOffset = 500;

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
  const environments = new EnvironmentService(store);
  const automations = new AutomationService(store, sessions, messages, environments);
  const skills = new SkillService(store);
  const snippets = new SnippetService(store);
  const notepads = new NotepadService(store, events);
  const services: AppServices = {
    store,
    events,
    environments,
    sessions,
    messages,
    automations,
    skills,
    snippets,
    notepads,
    artifacts: new ArtifactService(store, events, options.artifactObjectStorage),
    externalResources: new ExternalResourceService(store, events),
    genericWebhooks: new GenericWebhookService(store, sessions, messages, skills, {
      unsafeAllowLocalHttpCallbacks: Boolean(options.unsafeAllowLocalHttpCallbacks),
    }),
    callbacks: new CallbackService(store, events),
    modelAvailability: new ModelAvailabilityService(),
  };
  if (options.sandboxProvider) {
    services.sandboxProvider = options.sandboxProvider;
    services.sandboxLifecycle = new SandboxLifecycleService(store, options.sandboxProvider);
    services.sandboxCleanup = new SandboxCleanupService(store, events, options.sandboxProvider);
    services.sandboxKeepalive = new SandboxKeepaliveService(store, events, options.sandboxProvider);
  }
  return services;
}

export function createApp(config: AppConfig, services = createServices()) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', requestIdMiddleware());
  app.use('*', routeTelemetryMiddleware(config));
  app.use(
    '*',
    cors({
      origin: allowedCorsOrigin(config),
      credentials: true,
      allowHeaders: ['authorization', 'content-type', 'traceparent', 'tracestate', 'x-request-id'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );

  app.onError((error, c) => {
    if (error instanceof HttpRequestError) {
      return writeError(c, error.statusCode, error.code, error.message);
    }
    return writeError(c, 500, 'internal_error', error instanceof Error ? error.message : 'Unknown error');
  });

  app.notFound((c) => c.json({ error: 'not_found', message: 'Route not found' }, 404));

  // Service-host requests must take precedence over product API routes so paths
  // like /auth/login on a service host proxy into the sandbox instead.
  app.use('*', servicePreviewMiddleware(config, services));

  app.get('/health', (c) => {
    const notices = services.modelAvailability.notices();
    return c.json({
      status: notices.length ? 'degraded' : 'ok',
      runMode: config.runMode,
      apiAuthMode: config.apiAuthMode,
      authProvider: config.apiAuthMode === 'session' ? config.authProvider : undefined,
      sandboxProvider: config.sandboxProvider,
      privateSessionsEnabled: config.privateSessionsEnabled,
      hideSetupPage: config.hideSetupPage,
      ...(notices.length ? { notices } : {}),
    });
  });

  registerAuthRoutes(app, config, services);

  app.use('/sessions/*', apiAuthMiddleware(config, services.store));
  app.use('/sessions', apiAuthMiddleware(config, services.store));
  app.use('/automations/*', apiAuthMiddleware(config, services.store));
  app.use('/automations', apiAuthMiddleware(config, services.store));
  if (config.skillsEnabled) {
    app.use('/skills/*', apiAuthMiddleware(config, services.store));
    app.use('/skills', apiAuthMiddleware(config, services.store));
  }
  app.use('/snippets/*', apiAuthMiddleware(config, services.store));
  app.use('/snippets', apiAuthMiddleware(config, services.store));
  app.use('/notepads/*', apiAuthMiddleware(config, services.store));
  app.use('/notepads', apiAuthMiddleware(config, services.store));
  app.use('/environments/*', apiAuthMiddleware(config, services.store));
  app.use('/environments', apiAuthMiddleware(config, services.store));
  app.use('/repositories/*', apiAuthMiddleware(config, services.store));
  app.use('/repositories', apiAuthMiddleware(config, services.store));
  app.use('/models', apiAuthMiddleware(config, services.store));
  app.use('/users/*', apiAuthMiddleware(config, services.store));
  app.use('/users', apiAuthMiddleware(config, services.store));
  app.use('/setup/*', apiAuthMiddleware(config, services.store));
  app.use('/setup', apiAuthMiddleware(config, services.store));
  app.use('/events/*', apiAuthMiddleware(config, services.store));
  app.use('/events', apiAuthMiddleware(config, services.store));
  app.use('/telemetry/*', apiAuthMiddleware(config, services.store));
  app.use('/telemetry', apiAuthMiddleware(config, services.store));

  app.use('/setup/*', apiAdminMiddleware(config, services.store));
  app.use('/setup', apiAdminMiddleware(config, services.store));

  app.use('/sessions/:sessionId/*', sessionAuthorizationMiddleware(config, services));
  app.use('/sessions/:sessionId', sessionAuthorizationMiddleware(config, services));

  app.post('/sessions', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const title = optionalString(body.title);
    const visibility = body.visibility ?? 'tenant';
    if (visibility !== 'tenant' && visibility !== 'private') {
      return writeError(c, 400, 'invalid_request', 'Expected visibility to be tenant or private');
    }
    if (visibility === 'private' && !config.privateSessionsEnabled) {
      return writeError(c, 409, 'feature_disabled', 'Private session creation is not enabled');
    }
    if (
      body.ownerGroupId !== undefined ||
      body.ownerGroupName !== undefined ||
      body.ownerUserId !== undefined ||
      body.writePolicy !== undefined
    ) {
      return writeError(c, 400, 'invalid_request', 'Session access policy fields are no longer supported');
    }
    if (!auth.bypass && auth.user.role === 'viewer') {
      return writeError(c, 403, 'forbidden', 'Member access is required');
    }
    if (visibility === 'private' && auth.bypass) {
      return writeError(c, 400, 'invalid_request', 'Private sessions require a user session');
    }
    const create = () =>
      services.sessions.create({
        ...(title ? { title } : {}),
        ...(auth.bypass ? {} : { createdByUserId: auth.user.id }),
        visibility,
        ...(visibility === 'private' && !auth.bypass ? { ownerUserId: auth.user.id } : {}),
      });
    let session: SessionRecord;
    try {
      session =
        visibility === 'private' && !auth.bypass
          ? await services.store.withUserWriteLease(auth.user.id, create)
          : await create();
    } catch (error) {
      if (error instanceof StoreConflictError && error.code === 'not_found') {
        return writeError(c, 403, 'forbidden', 'Member access is required');
      }
      throw error;
    }
    return c.json({ session: await serializeSessionWithSandbox(config, services, session) }, 201);
  });

  app.get('/sessions', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const limit = parseBoundedInteger(c.req.query('limit'), 50, 1, 200);
    const cursor = decodeSessionListCursor(c.req.query('cursor'));
    const archived = parseOptionalBoolean(c.req.query('archived')) ?? false;
    if (c.req.query('groupId') !== undefined) {
      return writeError(c, 400, 'invalid_request', 'groupId is no longer supported');
    }
    const parentSessionId = optionalString(c.req.query('parentSessionId'));
    if (parentSessionId && !isUuid(parentSessionId)) {
      return writeError(c, 400, 'invalid_request', 'Expected valid parentSessionId');
    }
    const filters = parseSessionListFilters(c, auth);
    const sessionsWithSandbox = await services.store.listSessionsWithLatestSandbox(config.sandboxProvider, {
      archived,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...filters,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    const starredSessionIds = await listStarredSessionIdsForAuth(
      services.store,
      auth,
      sessionsWithSandbox.items.map(({ session }) => session.id),
    );
    // Keyset pagination is ordered by activity. A session updated while a client
    // pages can move ahead of the current cursor; the global event stream and
    // first-page refresh path upsert those live changes back into the sidebar.
    const visibleSessions = sessionsWithSandbox.items.map(({ session, sandbox, directChildCount }) =>
      serializeSessionView(session, sandbox, starredSessionIds?.has(session.id), directChildCount),
    );
    return c.json({
      sessions: visibleSessions,
      nextCursor: encodeSessionListCursor(sessionsWithSandbox.nextCursor),
    });
  });

  app.get('/sessions/search', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const query = optionalString(c.req.query('q'))?.trim() ?? '';
    const limit = parseBoundedInteger(c.req.query('limit'), 20, 1, 50);
    const cursor = decodeOffsetCursor(c.req.query('cursor'));
    if (c.req.query('groupId') !== undefined) {
      return writeError(c, 400, 'invalid_request', 'groupId is no longer supported');
    }
    const filters = parseSessionListFilters(c, auth);
    if (!query) return c.json({ results: [], nextCursor: null });
    const page = await services.store.searchSessions(config.sandboxProvider, {
      query,
      ...filters,
      limit,
      ...(cursor !== null ? { cursor } : {}),
    });
    const starredSessionIds = await listStarredSessionIdsForAuth(
      services.store,
      auth,
      page.items.map(({ item }) => item.session.id),
    );
    return c.json({
      results: page.items.map(({ item, snippet, matchKind, score }) => ({
        session: serializeSessionView(item.session, item.sandbox, starredSessionIds?.has(item.session.id)),
        snippet,
        matchKind,
        score,
      })),
      nextCursor: encodeSearchOffsetCursor(page.nextCursor),
    });
  });

  registerAutomationRoutes(app, config, services, {
    serializeSession: (session) => serializeSessionWithSandbox(config, services, session),
  });
  registerEnvironmentRoutes(app, config, services);
  registerSkillRoutes(app, config, services);
  registerSnippetRoutes(app, config, services);
  registerNotepadRoutes(app, config, services);
  registerTelemetryRoutes(app, config);

  registerRepositoryRoutes(app, config, services);

  registerModelRoutes(app, config, services);
  registerSetupRoutes(app, config, services);

  registerUserRoutes(app, config, services);

  registerEventRoutes(app, config, services);

  registerWebhookRoutes(app, config, services);

  app.get('/sessions/tags', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const tags = await services.store.listSessionTags({
      limit: 100,
      ...(auth.bypass ? {} : { visibleToUserId: auth.user.id }),
    });
    return c.json({ tags });
  });

  app.get('/sessions/:sessionId', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const session = getAuthorizedSession(c, c.req.param('sessionId'));
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    return c.json({
      session: await serializeSessionWithSandbox(
        config,
        services,
        session,
        await readSessionStarredForAuth(services.store, auth, session.id),
      ),
    });
  });

  app.patch('/sessions/:sessionId', async (c) => {
    const session = getAuthorizedSession(c, c.req.param('sessionId'));
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    if (session.status === 'archived') return writeError(c, 409, 'conflict', 'Archived sessions are read-only');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    if (
      body.ownerGroupId !== undefined ||
      body.ownerGroupName !== undefined ||
      body.ownerUserId !== undefined ||
      body.writePolicy !== undefined
    ) {
      return writeError(c, 400, 'invalid_request', 'Session access policy fields are no longer supported');
    }
    if (body.visibility !== undefined && body.visibility !== 'tenant') {
      return writeError(c, 400, 'invalid_request', 'Sessions can only be promoted to tenant visibility');
    }
    if (body.visibility === 'tenant' && session.visibility !== 'private') {
      return writeError(c, 400, 'invalid_request', 'Tenant session visibility cannot be changed');
    }
    if (body.visibility === 'tenant' && (body.title !== undefined || body.tags !== undefined)) {
      return writeError(c, 400, 'invalid_request', 'Promote session visibility in a separate request');
    }
    const title = optionalString(body.title);
    if (body.title !== undefined && !title)
      return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: title');
    let tags: string[] | undefined;
    if (body.tags !== undefined) {
      const normalizedTags = normalizeSessionTags(body.tags);
      if (!normalizedTags) {
        return writeError(
          c,
          400,
          'invalid_request',
          'Expected tags to be an array of strings with at most 20 tags, 64 characters each, and no commas, control, or invisible format characters',
        );
      }
      tags = normalizedTags;
    }

    try {
      const updated = await services.sessions.update({
        id: session.id,
        requireNonArchived: true,
        ...(title ? { title } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(body.visibility === 'tenant' ? { promoteToTenant: true } : {}),
      });
      const auth = await requireRequestAuthorization(config, services.store, c);
      return c.json({
        session: await serializeSessionWithSandbox(
          config,
          services,
          updated,
          auth ? await readSessionStarredForAuth(services.store, auth, updated.id) : undefined,
        ),
      });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found') {
        return writeError(c, 404, 'not_found', 'Session not found');
      }
      if (error instanceof SessionServiceError && error.code === 'archived') {
        return writeError(c, 409, 'conflict', 'Archived sessions are read-only');
      }
      throw error;
    }
  });

  app.put('/sessions/:sessionId/star', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    if (auth.bypass) return writeError(c, 400, 'invalid_request', 'Starring sessions requires a user session');
    const session = getAuthorizedSession(c, c.req.param('sessionId'));
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    await services.store.starSession({ sessionId: session.id, userId: auth.user.id, now: new Date() });
    return c.json({ starred: true });
  });

  app.delete('/sessions/:sessionId/star', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    if (auth.bypass) return writeError(c, 400, 'invalid_request', 'Starring sessions requires a user session');
    const session = getAuthorizedSession(c, c.req.param('sessionId'));
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    await services.store.unstarSession({ sessionId: session.id, userId: auth.user.id });
    return c.json({ starred: false });
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
      if (error instanceof SessionServiceError && error.code === 'archived')
        return writeError(c, 409, 'conflict', 'Archived sessions are read-only');
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
      if (error instanceof SessionServiceError && error.code === 'archived')
        return writeError(c, 409, 'conflict', 'Archived sessions are read-only');
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
    const session = getAuthorizedSession(c, sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    if (typeof body.prompt !== 'string') return writeError(c, 400, 'invalid_request', 'Expected string field: prompt');
    if (body.generateTitle !== undefined && typeof body.generateTitle !== 'boolean') {
      return writeError(c, 400, 'invalid_request', 'Expected boolean field: generateTitle');
    }
    const prompt = optionalString(body.prompt) ?? '';
    if (body.generateTitle === true && !prompt) {
      return writeError(c, 400, 'invalid_request', 'Title generation requires a non-empty prompt');
    }
    if (body.generateTitle === true && session.status !== 'created') {
      return writeError(c, 409, 'conflict', 'Title generation is only available for the first message');
    }

    try {
      const model = parseModelBody(body.model, config);
      const reasoningLevel = parseReasoningLevelBody(body.reasoningLevel);
      const unavailable = services.modelAvailability.unavailableFor(model || config.runnerModelDefault);
      if (unavailable) throw new HttpRequestError(409, 'model_unavailable', unavailable.reason);
      const environmentId = optionalString(body.environmentId);
      const baseContext = environmentId
        ? await environmentMessageContext(c, config, services, session, environmentId, body, model, reasoningLevel)
        : directRepositoryMessageContext(body, model, reasoningLevel);
      const auth = await requireRequestAuthorization(config, services.store, c);
      if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
      const authorUserId = auth.bypass ? undefined : auth.user.id;
      const skillContext = await canonicalizeMessageSkillContext({
        skills: services.skills,
        events: services.store,
        sessionId: session.id,
        ...(authorUserId ? { userId: authorUserId } : {}),
        skillsEnabled: config.skillsEnabled,
        repoSkillsEnabled: config.repoSkillsEnabled,
        canUse: (skill) => canInvokeSkillInSession(auth, skill, session, authorUserId),
        value: body.context,
      });
      if (!prompt && !skillContext?.skills.length) {
        return writeError(c, 400, 'invalid_request', 'Expected prompt text or at least one invoked skill');
      }
      const context = {
        ...baseContext,
        ...skillContext,
        ...(body.generateTitle === true && session.title ? { titleGeneration: { fallbackTitle: session.title } } : {}),
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
      if (error instanceof SkillContextError) return writeError(c, 400, error.code, error.message);
      throw error;
    }
  });

  app.get('/sessions/:sessionId/messages', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = getAuthorizedSession(c, sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const messages = await services.messages.list(sessionId);
    return c.json({ messages });
  });

  app.patch('/sessions/:sessionId/messages/:messageId', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const hasPrompt = Object.hasOwn(body, 'prompt');
    const hasContext = Object.hasOwn(body, 'context');
    const hasSteering = Object.hasOwn(body, 'steering');
    if (!hasPrompt && !hasContext && !hasSteering)
      return writeError(c, 400, 'invalid_request', 'Expected prompt, context, or steering update');
    if (hasPrompt && typeof body.prompt !== 'string')
      return writeError(c, 400, 'invalid_request', 'Expected string field: prompt');
    if (hasSteering && typeof body.steering !== 'boolean')
      return writeError(c, 400, 'invalid_request', 'Expected boolean field: steering');
    const prompt = hasPrompt ? (optionalString(body.prompt) ?? '') : undefined;
    try {
      const session = getAuthorizedSession(c, c.req.param('sessionId'));
      if (!session) return writeError(c, 404, 'not_found', 'Session not found');
      const auth = await requireRequestAuthorization(config, services.store, c);
      if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
      const existing = await services.store.getMessage({ sessionId: session.id, messageId: c.req.param('messageId') });
      const skillContext =
        hasPrompt || hasContext
          ? await canonicalizeMessageSkillContext({
              skills: services.skills,
              events: services.store,
              sessionId: session.id,
              ...(existing?.authorUserId ? { userId: existing.authorUserId } : {}),
              skillsEnabled: config.skillsEnabled,
              repoSkillsEnabled: config.repoSkillsEnabled,
              canUse: (skill) => canInvokeSkillInSession(auth, skill, session, existing?.authorUserId),
              value: body.context,
            })
          : undefined;
      const effectiveSkills = skillContext?.skills ?? existing?.context?.skills;
      const effectivePrompt = prompt ?? existing?.prompt ?? '';
      if (
        (hasPrompt || hasContext) &&
        !effectivePrompt &&
        (!Array.isArray(effectiveSkills) || !effectiveSkills.length)
      ) {
        return writeError(c, 400, 'invalid_request', 'Expected prompt text or at least one invoked skill');
      }
      const context = skillContext ? { ...(existing?.context ?? {}), ...skillContext } : undefined;
      const message = await services.messages.updatePending({
        sessionId: c.req.param('sessionId'),
        messageId: c.req.param('messageId'),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(hasSteering ? { steering: body.steering as boolean } : {}),
        ...(context ? { context } : {}),
      });
      return c.json({ message });
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'conflict')
        return writeError(c, 409, 'conflict', error.message);
      if (error instanceof SkillContextError) return writeError(c, 400, error.code, error.message);
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
    const session = getAuthorizedSession(c, sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const after = parseCursor(c.req.query('after') ?? null);
    const limitParam = c.req.query('limit');
    let limit = 1000;
    if (limitParam !== undefined) {
      const parsedLimit = Number(limitParam);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        return writeError(c, 400, 'invalid_request', 'Expected a positive integer limit');
      }
      limit = Math.min(parsedLimit, 2000);
    }

    const batch = await services.events.listBatch(sessionId, after ?? 0, limit);
    return c.json({
      events: batch.events,
      cursor: batch.cursor,
      hasMore: batch.hasMore,
    });
  });

  app.get('/sessions/:sessionId/artifacts', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = getAuthorizedSession(c, sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const artifacts = await services.artifacts.list(sessionId);
    return c.json({ artifacts });
  });

  app.get('/sessions/:sessionId/external-resources', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = getAuthorizedSession(c, sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const externalResources = await services.externalResources.list(sessionId);
    return c.json({ externalResources });
  });

  app.get('/sessions/:sessionId/artifacts/:artifactId/download', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = getAuthorizedSession(c, sessionId);
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
    const session = getAuthorizedSession(c, sessionId);
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
    const session = getAuthorizedSession(c, sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const auth = await requireRequestAuthorization(config, services.store, c);
    const canRequestPort = auth ? canWriteSession(auth, session) : false;
    const requestedPort = canRequestPort ? parseServicePort(c.req.query('port')) : undefined;
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
        liveServices.push(
          serializeService(
            c,
            config,
            sessionId,
            service,
            item,
            sandboxTiming(config, sandbox),
            await previewAuthTokenForRequest(c, config, services.store, sessionId, item.port),
          ),
        );
    }
    return c.json({ services: liveServices });
  });

  app.post('/sessions/:sessionId/sandbox/extend', async (c) => {
    if (!services.sandboxKeepalive) return writeError(c, 404, 'not_found', 'Sandbox provider is not configured');
    const sessionId = c.req.param('sessionId');
    const session = getAuthorizedSession(c, sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const seconds = parseKeepaliveSeconds(body.seconds ?? body.ttlSeconds);
    const port =
      body.port === undefined || (typeof body.port !== 'string' && typeof body.port !== 'number')
        ? undefined
        : parseServicePort(String(body.port));
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

  app.post('/sessions/:sessionId/workspace-tools/:toolId/open', async (c) => {
    if (!services.sandboxProvider || !services.sandboxLifecycle || !services.sandboxKeepalive) {
      return writeError(c, 404, 'not_found', 'Sandbox provider is not configured');
    }
    const sessionId = c.req.param('sessionId');
    const session = getAuthorizedSession(c, sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const tool = workspaceTool(c.req.param('toolId'));
    if (!tool) return writeError(c, 404, 'not_found', 'Workspace tool not found');

    const latest = await services.store.getLatestSandbox(sessionId, services.sandboxProvider.name);
    if (!latest)
      return writeError(c, 409, 'sandbox_unavailable', 'No sandbox workspace is available yet. Start a run first.');
    if (latest.status === 'destroyed') {
      return writeError(c, 409, 'sandbox_destroyed', destroyedSandboxWorkspaceMessage);
    }
    const latestHealth = await services.sandboxProvider.health(latest);
    if (latestHealth.status === 'missing') {
      const destroyedAt = new Date();
      await services.store.updateSandbox({ ...latest, status: 'destroyed', updatedAt: destroyedAt, destroyedAt });
      return writeError(c, 409, 'sandbox_destroyed', destroyedSandboxWorkspaceMessage);
    }

    const ensured = await services.sandboxLifecycle.ensure(sessionId, { allowCreate: false });
    if (!ensured) {
      const health = await services.sandboxProvider.health(latest);
      if (health.status === 'missing') {
        const destroyedAt = new Date();
        await services.store.updateSandbox({ ...latest, status: 'destroyed', updatedAt: destroyedAt, destroyedAt });
        return writeError(c, 409, 'sandbox_destroyed', destroyedSandboxWorkspaceMessage);
      }
      return writeError(c, 404, 'not_found', 'Active sandbox is not available');
    }
    await startWorkspaceTool(
      ensured.sandbox,
      tool,
      workspaceToolWorkingDirectory(tool, session.context ?? {}, ensured.sandbox.workspacePath),
    );
    const keepalive = await services.sandboxKeepalive.extend({
      sessionId,
      durationMs: workspaceToolKeepaliveMs,
      maxDurationMs: config.sandboxKeepaliveMaxExtensionMs,
      port: tool.port,
    });
    if (!keepalive) return writeError(c, 404, 'not_found', 'Active sandbox is not available');

    const publishInput: WorkspaceToolPublishInput = {
      session,
      store: services.store,
      tool,
      providerSandboxId: ensured.record.providerSandboxId,
    };
    const servicePath = workspaceToolServicePath(tool, ensured.sandbox.workspacePath);
    if (servicePath) publishInput.path = servicePath;
    const runtimeId = sandboxRuntimeId(ensured.record);
    if (runtimeId) publishInput.runtimeId = runtimeId;
    const updatedSession = await publishWorkspaceToolService(publishInput);
    const preview = await getSessionService(config, services, sessionId, tool.port);
    if (!preview) {
      return writeError(
        c,
        503,
        'service_unreachable',
        'Workspace tool service is unreachable. The process may still be starting, exited, or listening on another port.',
      );
    }

    return c.json({
      tool: { id: tool.id, label: tool.label },
      service: serializeService(
        c,
        config,
        sessionId,
        preview,
        workspaceToolServiceMetadata(tool, servicePath),
        sandboxTiming(config, keepalive.record),
        await previewAuthTokenForRequest(c, config, services.store, sessionId, tool.port),
      ),
      session: await serializeSessionWithSandbox(config, services, updatedSession),
    });
  });

  app.get('/sessions/:sessionId/callbacks', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = getAuthorizedSession(c, sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const messageId = optionalString(c.req.query('messageId'));
    const callbacks = await services.callbacks.list({ sessionId, ...(messageId ? { messageId } : {}) });
    return c.json({ callbacks });
  });

  app.post('/sessions/:sessionId/callbacks/:deliveryId/replay', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = getAuthorizedSession(c, sessionId);
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
    const session = getAuthorizedSession(c, sessionId);
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
      privateSessionsEnabled: config.privateSessionsEnabled,
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
    const requestId = safeRequestId(c.req.header('x-request-id')) ?? randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    try {
      await next();
    } finally {
      c.header('x-request-id', requestId);
    }
  };
}

function safeRequestId(value: string | undefined): string | null {
  if (!value || value.length > 128) return null;
  return /^[\x20-\x7e]+$/.test(value) ? value : null;
}

function allowedCorsOrigin(config: AppConfig): (origin: string) => string | undefined {
  const allowed = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
  if (config.webBaseUrl) allowed.add(new URL(config.webBaseUrl).origin);
  return (origin) => (allowed.has(origin) ? origin : undefined);
}

// Proxies requests whose host is a sandbox service host (s-<port>-<session-id>)
// into the sandbox. Registered before all product API routes so a service host
// never reaches this instance's own API handlers. Non-service hosts fall through.
function servicePreviewMiddleware(
  config: AppConfig,
  services: AppServices,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const serviceHost = parseServiceHostFromRequest(config, c);
    if (!serviceHost) {
      await next();
      return;
    }
    if (new URL(c.req.url).pathname === '/__preview_auth') {
      return authorizePreviewToken(config, services.store, c, serviceHost.sessionId, serviceHost.port);
    }
    const authorization = await authorizePreviewRequest(config, services.store, c);
    if (config.apiAuthMode === 'session' && !authorization) {
      return writeError(c, 403, 'forbidden', 'Preview access is required');
    }
    const session = await services.sessions.get(serviceHost.sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    if (session.visibility === 'private' && config.apiAuthMode !== 'session') {
      return writeError(c, 404, 'not_found', 'Session not found');
    }
    const service = await getSessionService(config, services, serviceHost.sessionId, serviceHost.port);
    if (!service) return writeError(c, 404, 'not_found', 'Service URL is not available for this sandbox');
    if (config.apiAuthMode === 'bearer') {
      const serviceAuthorized = c.req.header('authorization') === `Bearer ${requireApiBearerToken(config)}`;
      if (!serviceAuthorized) return writeError(c, 403, 'forbidden', 'Preview access is required');
    }
    return appendPreviewCookie(await proxyService(c, config, service), authorization?.cookie);
  };
}

function sessionAuthorizationMiddleware(
  config: AppConfig,
  services: AppServices,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const sessionId = c.req.param('sessionId');
    if (!sessionId) return writeError(c, 400, 'invalid_request', 'Expected sessionId');
    if (sessionId === 'search' || sessionId === 'tags') {
      await next();
      return;
    }
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const method = c.req.method.toUpperCase();
    const pathname = new URL(c.req.url).pathname;
    const isStarRoute = pathname === `/sessions/${sessionId}/star`;
    const allowed =
      unsafeMethods.has(method) && !isStarRoute ? canWriteSession(auth, session) : canReadSession(auth, session);
    if (!allowed) {
      if (session.visibility === 'private') return writeError(c, 404, 'not_found', 'Session not found');
      return writeError(c, 403, 'forbidden', 'Session access is required');
    }
    c.set('authorizedSession', session);
    if (
      unsafeMethods.has(method) &&
      !isStarRoute &&
      session.visibility === 'private' &&
      !auth.bypass &&
      !c.get('privateWriteLeaseActive')
    ) {
      try {
        c.set('privateWriteLeaseActive', true);
        await services.store.withPrivateSessionWriteLease(auth.user.id, session.id, next);
      } catch (error) {
        if (error instanceof StoreConflictError && error.code === 'not_found') {
          return writeError(c, 404, 'not_found', 'Session not found');
        }
        throw error;
      }
      return;
    }
    await next();
  };
}

// Only returns the session resolved by sessionAuthorizationMiddleware. There is
// deliberately no store fallback: a route that reaches this without the middleware
// has skipped authorization and must not see the session.
function getAuthorizedSession(c: Context<{ Variables: AppVariables }>, sessionId: string): SessionRecord | null {
  const session = c.get('authorizedSession');
  return session && session.id === sessionId ? session : null;
}

function parseBoundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpRequestError(400, 'invalid_request', `Expected integer between ${min} and ${max}`);
  }
  return value;
}

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new HttpRequestError(400, 'invalid_request', 'Expected boolean query parameter');
}

async function environmentMessageContext(
  c: Context,
  config: AppConfig,
  services: AppServices,
  session: SessionRecord,
  environmentId: string,
  body: Record<string, unknown>,
  model: string | undefined,
  reasoningLevel: ReturnType<typeof parseReasoningLevelBody>,
): Promise<Record<string, unknown>> {
  if (body.repository !== undefined || body.branch !== undefined) {
    throw new HttpRequestError(400, 'invalid_request', 'Use either environmentId or repository, not both');
  }
  const auth = await requireRequestAuthorization(config, services.store, c);
  if (!auth) throw new HttpRequestError(401, 'unauthorized', 'Missing or invalid session');
  const environment = await services.environments.get(environmentId);
  if (!environment || environment.archivedAt) throw new HttpRequestError(404, 'not_found', 'Environment not found');
  if (!canUseEnvironment(auth, environment)) {
    throw new HttpRequestError(403, 'forbidden', 'Environment use access is required');
  }
  const snapshot = await services.environments.resolve({
    environmentId,
    branchOverrides: parseEnvironmentBranchOverrides(body.environmentBranchOverrides),
  });
  return {
    environment: snapshot,
    ...(model ? { model } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
  };
}

function directRepositoryMessageContext(
  body: Record<string, unknown>,
  model: string | undefined,
  reasoningLevel: ReturnType<typeof parseReasoningLevelBody>,
): Record<string, unknown> {
  if (body.environmentBranchOverrides !== undefined) {
    throw new HttpRequestError(400, 'invalid_request', 'environmentBranchOverrides require environmentId');
  }
  const repository = parseRepositoryBody(body.repository);
  const branch = repository ? parseBranchBody(body.branch) : undefined;
  return {
    ...(repository ? { repository } : {}),
    ...(model ? { model } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(repository && branch ? { branch } : {}),
  };
}

function parseEnvironmentBranchOverrides(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpRequestError(400, 'invalid_request', 'Expected environmentBranchOverrides array');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpRequestError(400, 'invalid_request', 'Expected branch override object');
    }
    const record = item as Record<string, unknown>;
    if (record.provider !== undefined && record.provider !== 'github') {
      throw new HttpRequestError(400, 'invalid_request', 'Only GitHub repositories are supported');
    }
    const owner = optionalString(record.owner);
    const repo = optionalString(record.repo);
    if (!owner || !repo) {
      throw new HttpRequestError(400, 'invalid_request', 'Expected branch override owner and repo');
    }
    return {
      provider: 'github' as const,
      owner,
      repo,
      ...(record.branch !== undefined ? { branch: parseBranchBody(record.branch) ?? '' } : {}),
    };
  });
}

function encodeSessionListCursor(cursor: SessionListCursor | null): string | null {
  if (!cursor) return null;
  return encodeCursor({
    lastActivityAt: cursor.lastActivityAt.toISOString(),
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
}

function decodeSessionListCursor(raw: string | undefined): SessionListCursor | undefined {
  if (!raw) return undefined;
  const parsed = decodeCursor(raw);
  const lastActivityAtValue = isRecord(parsed) ? (parsed.lastActivityAt ?? parsed.updatedAt) : undefined;
  if (
    !isRecord(parsed) ||
    typeof lastActivityAtValue !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.id !== 'string'
  ) {
    throw new HttpRequestError(400, 'invalid_request', 'Invalid session cursor');
  }
  const lastActivityAt = new Date(lastActivityAtValue);
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(lastActivityAt.getTime()) || Number.isNaN(createdAt.getTime()) || !isUuid(parsed.id)) {
    throw new HttpRequestError(400, 'invalid_request', 'Invalid session cursor');
  }
  return { lastActivityAt, createdAt, id: parsed.id };
}

function encodeOffsetCursor(cursor: number | null): string | null {
  return cursor === null ? null : encodeCursor({ offset: cursor });
}

function encodeSearchOffsetCursor(cursor: number | null): string | null {
  if (cursor === null || cursor >= maxSearchOffset) return null;
  return encodeOffsetCursor(cursor);
}

function decodeOffsetCursor(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = decodeCursor(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.offset !== 'number' ||
    !Number.isInteger(parsed.offset) ||
    parsed.offset < 0 ||
    parsed.offset >= maxSearchOffset
  ) {
    throw new HttpRequestError(400, 'invalid_request', 'Invalid search cursor');
  }
  return parsed.offset;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new HttpRequestError(400, 'invalid_request', 'Invalid cursor');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function requireRequestAuthorization(
  config: AppConfig,
  store: AppStore,
  c: Context,
): Promise<RequestAuthorization | null> {
  return readRequestAuthorization(config, store, c);
}

function parseSessionListFilters(c: Context, auth: RequestAuthorization) {
  const tags = parseSessionTagFilter(c.req.query('tags'));
  const createdByUserId = parseMeUserFilter(c.req.query('createdBy'), 'createdBy', auth);
  const participantUserId = parseMeUserFilter(c.req.query('participant'), 'participant', auth);
  const starredByUserId = parseMeUserFilter(c.req.query('starred'), 'starred', auth);
  return {
    ...(!auth.bypass ? { visibleToUserId: auth.user.id } : {}),
    ...(tags.length ? { tags } : {}),
    ...(createdByUserId ? { createdByUserId } : {}),
    ...(participantUserId ? { participantUserId } : {}),
    ...(starredByUserId ? { starredByUserId } : {}),
  };
}

function parseSessionTagFilter(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const tags = normalizeSessionTags(raw.split(','));
  if (!tags) {
    throw new HttpRequestError(
      400,
      'invalid_request',
      'Expected tags to be comma-separated strings with at most 20 tags, 64 characters each, and no control characters',
    );
  }
  return tags;
}

function parseMeUserFilter(raw: string | undefined, name: string, auth: RequestAuthorization): string | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'me') throw new HttpRequestError(400, 'invalid_request', `Expected ${name}=me`);
  if (auth.bypass) throw new HttpRequestError(400, 'invalid_request', `${name}=me requires a user session`);
  return auth.user.id;
}

async function listStarredSessionIdsForAuth(
  store: AppStore,
  auth: RequestAuthorization,
  sessionIds: string[],
): Promise<Set<string> | undefined> {
  if (auth.bypass) return undefined;
  return store.listStarredSessionIds({ userId: auth.user.id, sessionIds });
}

async function readSessionStarredForAuth(
  store: AppStore,
  auth: RequestAuthorization,
  sessionId: string,
): Promise<boolean | undefined> {
  const ids = await listStarredSessionIdsForAuth(store, auth, [sessionId]);
  return ids?.has(sessionId);
}

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

async function serializeSessionWithSandbox(
  config: AppConfig,
  services: AppServices,
  session: SessionRecord,
  starred?: boolean,
) {
  const sandbox = await services.store.getLatestSandboxForSession(session.id, config.sandboxProvider);
  return serializeSessionView(session, sandbox, starred);
}

function serializeSessionView(
  session: SessionRecord,
  sandbox: SandboxRecord | null,
  starred?: boolean,
  directChildCount?: number,
) {
  const display = sessionDisplayStatus(session, sandbox);
  const serialized = {
    ...session,
    ...(starred !== undefined ? { starred } : {}),
    ...(directChildCount !== undefined ? { directChildCount } : {}),
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

async function previewAuthTokenForRequest(
  c: Context,
  config: AppConfig,
  store: AppStore,
  previewSessionId: string,
  port: number,
): Promise<string | undefined> {
  if (config.apiAuthMode !== 'session') return undefined;
  const authSessionId = readSessionId(config, c);
  const [auth, session] = await Promise.all([
    readRequestAuthorization(config, store, c),
    store.getSession(previewSessionId),
  ]);
  if (!authSessionId || !auth || auth.bypass || !session) return undefined;
  if (!canReadSession(auth, session)) return undefined;
  return createPreviewAuthToken(config, { authSessionId, previewSessionId, port, userId: auth.user.id });
}

async function messageAuthor(
  c: Context,
  config: AppConfig,
  store: AppStore,
): Promise<{ authorUserId: string; authorName: string } | Record<string, never>> {
  if (config.apiAuthMode !== 'session') return {};
  const user = await readRequestAuthUser(config, store, c);
  return user ? { authorUserId: user.id, authorName: user.username } : {};
}
