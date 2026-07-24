import type { Context, Hono } from 'hono';
import { AutomationServiceError } from '../automations/service.js';
import {
  canManageAutomation,
  canReadAutomation,
  canUseEnvironment,
  canReadSession,
  readRequestAuthorization,
  type RequestAuthorization,
} from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import { EnvironmentServiceError, type EnvironmentBranchOverride } from '../environments/service.js';
import { StoreConflictError } from '../store/types.js';
import type { AutomationInvocationRecord, AutomationRecord, SessionRecord } from '../store/types.js';
import type { AppServices, AppVariables } from './server.js';
import { writeError } from './http-error.js';
import {
  HttpRequestError,
  optionalString,
  parseBranchBody,
  parseModelBody,
  parseReasoningLevelBody,
  parseRepositoryBody,
  readJsonBody,
} from './request.js';

const defaultAutomationInvocationLimit = 20;
const maxAutomationInvocationLimit = 200;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerAutomationRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
  options: { serializeSession: (session: SessionRecord) => Promise<unknown> },
): void {
  app.post('/automations', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const name = optionalString(body.name);
    const prompt = optionalString(body.prompt);
    const scheduleCron = optionalString(body.scheduleCron);
    if (!name) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: name');
    if (!prompt) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: prompt');
    if (!scheduleCron) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: scheduleCron');
    if (!canManageAutomation(auth)) return writeError(c, 403, 'forbidden', 'Member access is required');
    rejectStaleAutomationFields(body);

    try {
      const environmentId = await parseAutomationEnvironmentId(body, auth, services);
      const revisionSelection = await parseEnvironmentRevisionSelection(body, environmentId, services);
      const environmentBranchOverrides = await parseAutomationEnvironmentBranchOverrides(
        body,
        environmentId,
        revisionSelection.environmentRevisionId,
        services,
      );
      const context = parseAutomationCreateContextBody(
        body,
        config,
        services,
        Boolean(environmentId),
        environmentBranchOverrides ?? [],
      );
      const automation = await services.automations.createScheduled({
        name,
        prompt,
        scheduleCron,
        enabled: body.enabled === undefined ? true : parseBooleanBody(body.enabled, 'enabled'),
        ...(auth.bypass ? {} : { createdByUserId: auth.user.id }),
        ...(environmentId ? { environmentId } : {}),
        ...revisionSelection,
        ...(Object.keys(context).length ? { context } : {}),
      });
      return c.json({ automation: await serializeAutomation(services, automation, auth) }, 201);
    } catch (error) {
      if (error instanceof AutomationServiceError) return automationServiceErrorResponse(c, error);
      if (error instanceof StoreConflictError) return automationStoreConflictResponse(c, error);
      throw error;
    }
  });

  app.get('/automations', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const automations = (await services.automations.list()).filter((automation) => canReadAutomation(auth, automation));
    return c.json({
      automations: await Promise.all(automations.map((automation) => serializeAutomation(services, automation, auth))),
    });
  });

  app.get('/automations/:automationId', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const automation = await services.automations.get(c.req.param('automationId'));
    if (!automation) return writeError(c, 404, 'not_found', 'Automation not found');
    if (!canReadAutomation(auth, automation)) return writeError(c, 403, 'forbidden', 'Automation access is required');
    return c.json({ automation: await serializeAutomation(services, automation, auth) });
  });

  app.patch('/automations/:automationId', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const automation = await services.automations.get(c.req.param('automationId'));
    if (!automation) return writeError(c, 404, 'not_found', 'Automation not found');
    if (!canManageAutomation(auth, automation)) {
      return writeError(c, 403, 'forbidden', 'Automation management access is required');
    }
    if (automation.archivedAt) {
      return writeError(c, 409, 'automation_archived', 'Restore this automation before editing it');
    }

    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    rejectStaleAutomationFields(body);

    try {
      const environmentId = await parseAutomationUpdateEnvironmentId(body, automation, auth, services);
      const effectiveEnvironmentId = environmentId === undefined ? automation.environmentId : environmentId;
      const revisionSelection = await parseEnvironmentRevisionSelection(
        body,
        effectiveEnvironmentId,
        services,
        automation,
      );
      const effectiveRevisionId =
        revisionSelection.environmentRevisionPolicy === 'pinned'
          ? revisionSelection.environmentRevisionId
          : revisionSelection.environmentRevisionPolicy === 'follow_latest'
            ? undefined
            : automation.environmentRevisionId;
      const environmentBranchOverrides = await parseAutomationEnvironmentBranchOverrides(
        body,
        effectiveEnvironmentId,
        effectiveRevisionId,
        services,
      );
      const context = parseAutomationUpdateContextBody(
        body,
        config,
        services,
        automation.context,
        effectiveEnvironmentId,
        {
          environmentChanged: environmentId !== undefined && environmentId !== automation.environmentId,
          environmentBranchOverridesProvided: Object.prototype.hasOwnProperty.call(body, 'environmentBranchOverrides'),
          ...(environmentBranchOverrides !== undefined ? { environmentBranchOverrides } : {}),
        },
      );
      const updated = await services.automations.updateScheduled({
        id: automation.id,
        ...(body.name !== undefined ? { name: optionalString(body.name) ?? '' } : {}),
        ...(body.prompt !== undefined ? { prompt: optionalString(body.prompt) ?? '' } : {}),
        ...(body.scheduleCron !== undefined ? { scheduleCron: optionalString(body.scheduleCron) ?? '' } : {}),
        ...(body.enabled !== undefined ? { enabled: parseBooleanBody(body.enabled, 'enabled') } : {}),
        ...(environmentId !== undefined ? { environmentId } : {}),
        ...revisionSelection,
        ...(context.changed ? { context: context.value } : {}),
      });
      return c.json({ automation: await serializeAutomation(services, updated, auth) });
    } catch (error) {
      if (error instanceof AutomationServiceError) return automationServiceErrorResponse(c, error);
      if (error instanceof StoreConflictError) return automationStoreConflictResponse(c, error);
      throw error;
    }
  });

  app.post('/automations/:automationId/archive', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const automation = await services.automations.get(c.req.param('automationId'));
    if (!automation) return writeError(c, 404, 'not_found', 'Automation not found');
    if (!canManageAutomation(auth, automation)) {
      return writeError(c, 403, 'forbidden', 'Automation management access is required');
    }
    try {
      const archived = await services.automations.archive(automation.id);
      return c.json({ automation: await serializeAutomation(services, archived, auth) });
    } catch (error) {
      if (error instanceof AutomationServiceError) return automationServiceErrorResponse(c, error);
      if (error instanceof StoreConflictError) return automationStoreConflictResponse(c, error);
      throw error;
    }
  });

  app.post('/automations/:automationId/unarchive', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const automation = await services.automations.get(c.req.param('automationId'));
    if (!automation) return writeError(c, 404, 'not_found', 'Automation not found');
    if (!canManageAutomation(auth, automation)) {
      return writeError(c, 403, 'forbidden', 'Automation management access is required');
    }
    try {
      const unarchived = await services.automations.unarchive(automation.id);
      return c.json({ automation: await serializeAutomation(services, unarchived, auth) });
    } catch (error) {
      if (error instanceof AutomationServiceError) return automationServiceErrorResponse(c, error);
      if (error instanceof StoreConflictError) return automationStoreConflictResponse(c, error);
      throw error;
    }
  });

  app.get('/automations/:automationId/invocations', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const automation = await services.automations.get(c.req.param('automationId'));
    if (!automation) return writeError(c, 404, 'not_found', 'Automation not found');
    if (!canReadAutomation(auth, automation)) return writeError(c, 403, 'forbidden', 'Automation access is required');
    const page = await services.automations.listInvocationPage({
      automationId: automation.id,
      limit: parseAutomationInvocationLimit(c.req.query('limit')),
      ...(c.req.query('cursor') ? { before: parseAutomationInvocationCursor(c.req.query('cursor')) } : {}),
    });
    return c.json({
      invocations: await Promise.all(
        page.invocations.map((invocation) => serializeAutomationInvocation(services, invocation, auth)),
      ),
      ...(page.nextCursor ? { nextCursor: encodeAutomationInvocationCursor(page.nextCursor) } : {}),
    });
  });

  app.post('/automations/:automationId/invoke', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const automation = await services.automations.get(c.req.param('automationId'));
    if (!automation) return writeError(c, 404, 'not_found', 'Automation not found');
    if (!canManageAutomation(auth, automation)) {
      return writeError(c, 403, 'forbidden', 'Automation management access is required');
    }
    const body = await readJsonBody(c, config.maxJsonBodyBytes);

    try {
      const result = await services.automations.invokeManual({
        automationId: automation.id,
        ...(auth.bypass ? {} : { requestedByUserId: auth.user.id }),
        allowDisabled: body.allowDisabled === undefined ? false : parseBooleanBody(body.allowDisabled, 'allowDisabled'),
        allowOverlap: body.allowOverlap === undefined ? false : parseBooleanBody(body.allowOverlap, 'allowOverlap'),
      });
      const refreshed = (await services.automations.get(automation.id)) ?? automation;
      return c.json(
        {
          automation: await serializeAutomation(services, refreshed, auth),
          invocation: await serializeAutomationInvocation(services, result.invocation, auth),
          ...(result.session ? { session: await options.serializeSession(result.session) } : {}),
          ...(result.message ? { message: result.message } : {}),
        },
        202,
      );
    } catch (error) {
      if (error instanceof AutomationServiceError) return automationServiceErrorResponse(c, error);
      throw error;
    }
  });
}

async function requireRequestAuthorization(
  config: AppConfig,
  services: AppServices,
  c: Context,
): Promise<RequestAuthorization | null> {
  return readRequestAuthorization(config, services.store, c);
}

async function serializeAutomation(services: AppServices, automation: AutomationRecord, auth: RequestAuthorization) {
  const [invocationPage, environmentRevision] = await Promise.all([
    services.automations.listInvocationPage({ automationId: automation.id, limit: 1 }),
    automation.environmentRevisionId
      ? services.store.getEnvironmentRevision(automation.environmentRevisionId)
      : Promise.resolve(null),
  ]);
  const lastInvocation = invocationPage.invocations[0];
  return {
    id: automation.id,
    kind: automation.kind,
    name: automation.name,
    prompt: automation.prompt,
    scheduleCron: automation.scheduleCron,
    scheduleTimezone: 'UTC',
    enabled: automation.enabled,
    ...(automation.createdByUserId ? { createdByUserId: automation.createdByUserId } : {}),
    ...(automation.environmentId ? { environmentId: automation.environmentId } : {}),
    ...(automation.environmentRevisionPolicy
      ? { environmentRevisionPolicy: automation.environmentRevisionPolicy }
      : {}),
    ...(automation.environmentRevisionId ? { environmentRevisionId: automation.environmentRevisionId } : {}),
    ...(environmentRevision ? { environmentRevisionNumber: environmentRevision.revisionNumber } : {}),
    ...(automation.context ? { context: automation.context } : {}),
    ...(automation.archivedAt ? { archivedAt: automation.archivedAt } : {}),
    ...(automation.nextInvocationAt ? { nextInvocationAt: automation.nextInvocationAt } : {}),
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    canManage: canManageAutomation(auth, automation),
    ...(lastInvocation ? { lastInvocation: await serializeAutomationInvocation(services, lastInvocation, auth) } : {}),
  };
}

async function serializeAutomationInvocation(
  services: AppServices,
  invocation: AutomationInvocationRecord,
  auth: RequestAuthorization,
) {
  const session = invocation.sessionId ? await services.store.getSession(invocation.sessionId) : null;
  const readableSession = session && canReadSession(auth, session) ? session : null;
  const messages = await (readableSession && invocation.messageId
    ? services.store.getMessages(readableSession.id)
    : Promise.resolve([]));
  const message = invocation.messageId ? messages.find((candidate) => candidate.id === invocation.messageId) : null;
  return {
    id: invocation.id,
    automationId: invocation.automationId,
    trigger: invocation.trigger,
    status: invocation.status,
    createdAt: invocation.createdAt,
    metadata: publicAutomationInvocationMetadata(invocation.metadata),
    ...(invocation.completedAt ? { completedAt: invocation.completedAt } : {}),
    ...(invocation.scheduledAt ? { scheduledAt: invocation.scheduledAt } : {}),
    ...(readableSession ? { sessionId: readableSession.id } : {}),
    ...(readableSession ? { sessionStatus: readableSession.status } : {}),
    ...(readableSession?.title ? { sessionTitle: readableSession.title } : {}),
    ...(message ? { messageId: message.id } : {}),
    ...(message ? { messageStatus: message.status } : {}),
    ...(invocation.requestedByUserId ? { requestedByUserId: invocation.requestedByUserId } : {}),
    ...(invocation.environmentId ? { environmentId: invocation.environmentId } : {}),
    ...(invocation.environmentRevisionId ? { environmentRevisionId: invocation.environmentRevisionId } : {}),
    ...(invocation.reason ? { reason: invocation.reason } : {}),
    ...(invocation.error ? { error: invocation.error } : {}),
  };
}

function publicAutomationInvocationMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const { reservedSessionId: _reservedSessionId, reservedMessageId: _reservedMessageId, ...publicMetadata } = metadata;
  return publicMetadata;
}

function automationServiceErrorResponse(c: Context, error: AutomationServiceError): Response {
  if (error.code === 'not_found') return writeError(c, 404, 'not_found', error.message);
  if (error.code === 'disabled') return writeError(c, 409, 'automation_disabled', error.message, error.details);
  if (error.code === 'archived') return writeError(c, 409, 'automation_archived', error.message, error.details);
  if (error.code === 'overlap') return writeError(c, 409, 'automation_overlap', error.message, error.details);
  if (error.code === 'invalid_schedule') return writeError(c, 400, 'invalid_schedule', error.message);
  return writeError(c, 400, 'invalid_request', error.message);
}

function automationStoreConflictResponse(c: Context, error: StoreConflictError): Response {
  if (error.code === 'automation_environment_unavailable') {
    return writeError(c, 409, error.code, error.message, error.details);
  }
  throw error;
}

function parseAutomationInvocationLimit(value: string | undefined): number {
  if (!value) return defaultAutomationInvocationLimit;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new HttpRequestError(400, 'invalid_request', 'Expected positive integer invocation limit');
  }
  return Math.min(limit, maxAutomationInvocationLimit);
}

function parseAutomationInvocationCursor(value: string | undefined): { createdAt: Date; id: string } {
  const [createdAtValue, id, extra] = (value ?? '').split('|');
  const createdAt = createdAtValue ? new Date(createdAtValue) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || !id || extra !== undefined || !uuidPattern.test(id)) {
    throw new HttpRequestError(400, 'invalid_request', 'Invalid automation invocation cursor');
  }
  return { createdAt, id };
}

function encodeAutomationInvocationCursor(cursor: { createdAt: Date; id: string }): string {
  return `${cursor.createdAt.toISOString()}|${cursor.id}`;
}

function parseBooleanBody(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpRequestError(400, 'invalid_request', `Expected boolean field: ${field}`);
  }
  return value;
}

function parseAutomationCreateContextBody(
  body: Record<string, unknown>,
  config: AppConfig,
  services: AppServices,
  hasEnvironment: boolean,
  environmentBranchOverrides: EnvironmentBranchOverride[],
): Record<string, unknown> {
  if (hasEnvironment && (body.repository !== undefined || body.branch !== undefined)) {
    throw new HttpRequestError(400, 'invalid_request', 'Use either environmentId or repository, not both');
  }
  const repository = parseRepositoryBody(body.repository);
  const model = parseModelBody(body.model, config);
  const reasoningLevel = parseReasoningLevelBody(body.reasoningLevel);
  const unavailable = services.modelAvailability.unavailableFor(model || config.runnerModelDefault);
  if (unavailable) throw new HttpRequestError(409, 'model_unavailable', unavailable.reason);
  const branch = repository && !hasEnvironment ? parseBranchBody(body.branch) : undefined;
  return {
    ...(!hasEnvironment && repository ? { repository } : {}),
    ...(model ? { model } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(!hasEnvironment && repository && branch ? { branch } : {}),
    ...(hasEnvironment && environmentBranchOverrides.length ? { environmentBranchOverrides } : {}),
  };
}

function parseAutomationUpdateContextBody(
  body: Record<string, unknown>,
  config: AppConfig,
  services: AppServices,
  currentContext: Record<string, unknown> | undefined,
  environmentId: string | null | undefined,
  options: {
    environmentChanged: boolean;
    environmentBranchOverrides?: EnvironmentBranchOverride[];
    environmentBranchOverridesProvided: boolean;
  },
): { changed: boolean; value: Record<string, unknown> | null } {
  const hasRepository = Object.prototype.hasOwnProperty.call(body, 'repository');
  const hasModel = Object.prototype.hasOwnProperty.call(body, 'model');
  const hasReasoningLevel = Object.prototype.hasOwnProperty.call(body, 'reasoningLevel');
  const hasBranch = Object.prototype.hasOwnProperty.call(body, 'branch');
  const hasEnvironment = Boolean(environmentId);
  if (hasEnvironment && (hasRepository || hasBranch)) {
    throw new HttpRequestError(400, 'invalid_request', 'Use either environmentId or repository, not both');
  }
  if (!hasEnvironment && options.environmentBranchOverridesProvided) {
    throw new HttpRequestError(400, 'invalid_request', 'environmentBranchOverrides require environmentId');
  }
  if (
    !hasRepository &&
    !hasModel &&
    !hasReasoningLevel &&
    !hasBranch &&
    !options.environmentBranchOverridesProvided &&
    !options.environmentChanged
  ) {
    return { changed: false, value: null };
  }

  const next = { ...(currentContext ?? {}) };
  if (hasEnvironment) {
    delete next.repository;
    delete next.branch;
    if (options.environmentChanged && !options.environmentBranchOverridesProvided) {
      delete next.environmentBranchOverrides;
    }
  } else {
    delete next.environmentBranchOverrides;
  }
  if (hasRepository) {
    const repository = parseRepositoryBody(body.repository);
    if (repository) next.repository = repository;
    else {
      delete next.repository;
      delete next.branch;
    }
  }
  if (hasModel) {
    const model = parseModelBody(body.model, config);
    const unavailable = services.modelAvailability.unavailableFor(model || config.runnerModelDefault);
    if (unavailable) throw new HttpRequestError(409, 'model_unavailable', unavailable.reason);
    if (model) next.model = model;
    else delete next.model;
  }
  if (hasReasoningLevel) {
    const reasoningLevel = parseReasoningLevelBody(body.reasoningLevel);
    if (reasoningLevel) next.reasoningLevel = reasoningLevel;
    else delete next.reasoningLevel;
  }
  if (hasBranch) {
    const branch = parseBranchBody(body.branch);
    if (branch) next.branch = branch;
    else delete next.branch;
  }
  if (options.environmentBranchOverridesProvided) {
    if (options.environmentBranchOverrides?.length) {
      next.environmentBranchOverrides = options.environmentBranchOverrides;
    } else {
      delete next.environmentBranchOverrides;
    }
  }

  return { changed: true, value: Object.keys(next).length ? next : null };
}

async function parseAutomationEnvironmentBranchOverrides(
  body: Record<string, unknown>,
  environmentId: string | null | undefined,
  environmentRevisionId: string | undefined,
  services: AppServices,
): Promise<EnvironmentBranchOverride[] | undefined> {
  if (!Object.prototype.hasOwnProperty.call(body, 'environmentBranchOverrides')) return undefined;
  const branchOverrides = parseEnvironmentBranchOverrides(body.environmentBranchOverrides);
  if (!environmentId) {
    throw new HttpRequestError(400, 'invalid_request', 'environmentBranchOverrides require environmentId');
  }
  try {
    await services.environments.resolve({
      environmentId,
      ...(environmentRevisionId ? { revisionId: environmentRevisionId } : {}),
      branchOverrides,
    });
  } catch (error) {
    if (error instanceof EnvironmentServiceError) {
      throw new HttpRequestError(error.code === 'invalid_request' ? 400 : 404, error.code, error.message);
    }
    throw error;
  }
  return branchOverrides;
}

function parseEnvironmentBranchOverrides(value: unknown): EnvironmentBranchOverride[] {
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

async function parseAutomationEnvironmentId(
  body: Record<string, unknown>,
  auth: RequestAuthorization,
  services: AppServices,
): Promise<string | undefined> {
  const environmentId = optionalString(body.environmentId);
  if (!environmentId) return undefined;
  await assertEnvironmentUsable(environmentId, auth, services);
  return environmentId;
}

async function parseEnvironmentRevisionSelection(
  body: Record<string, unknown>,
  environmentId: string | null | undefined,
  services: AppServices,
  existing?: AutomationRecord,
) {
  const policyProvided = Object.prototype.hasOwnProperty.call(body, 'environmentRevisionPolicy');
  const revisionProvided = Object.prototype.hasOwnProperty.call(body, 'environmentRevisionId');
  if (!policyProvided && !revisionProvided) return {};
  if (!environmentId) {
    throw new HttpRequestError(400, 'invalid_request', 'Environment revision selection requires environmentId');
  }
  const rawPolicy = optionalString(body.environmentRevisionPolicy);
  const policy = rawPolicy ?? existing?.environmentRevisionPolicy ?? 'follow_latest';
  if (policy !== 'follow_latest' && policy !== 'pinned') {
    throw new HttpRequestError(400, 'invalid_request', 'Expected valid environmentRevisionPolicy');
  }
  if (policy === 'follow_latest') {
    if (optionalString(body.environmentRevisionId)) {
      throw new HttpRequestError(400, 'invalid_request', 'Follow-latest automations cannot pin a revision');
    }
    return { environmentRevisionPolicy: 'follow_latest' as const };
  }
  let revisionId = optionalString(body.environmentRevisionId);
  if (!revisionId) {
    const environment = await services.environments.get(environmentId);
    if (!environment) throw new HttpRequestError(404, 'not_found', 'Environment not found');
    revisionId = environment.currentRevisionId;
  }
  return { environmentRevisionPolicy: 'pinned' as const, environmentRevisionId: revisionId };
}

async function parseAutomationUpdateEnvironmentId(
  body: Record<string, unknown>,
  automation: AutomationRecord,
  auth: RequestAuthorization,
  services: AppServices,
): Promise<string | null | undefined> {
  if (!Object.prototype.hasOwnProperty.call(body, 'environmentId')) {
    if (automation.environmentId) await assertEnvironmentUsable(automation.environmentId, auth, services);
    return undefined;
  }
  const environmentId = optionalString(body.environmentId);
  if (!environmentId) return null;
  await assertEnvironmentUsable(environmentId, auth, services);
  return environmentId;
}

async function assertEnvironmentUsable(
  environmentId: string,
  auth: RequestAuthorization,
  services: AppServices,
): Promise<void> {
  const environment = await services.environments.get(environmentId);
  if (!environment || environment.archivedAt) {
    throw new HttpRequestError(404, 'not_found', 'Environment not found');
  }
  if (!canUseEnvironment(auth, environment)) {
    throw new HttpRequestError(403, 'forbidden', 'Environment use access is required');
  }
}

function rejectStaleAutomationFields(body: Record<string, unknown>): void {
  const staleField = ['ownerGroupId', 'visibility', 'writePolicy', 'groupId', 'access'].find((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (staleField) {
    throw new HttpRequestError(400, 'invalid_request', `Unsupported automation field: ${staleField}`);
  }
}
