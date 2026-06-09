import type { Context, Hono } from 'hono';
import { AutomationServiceError } from '../automations/service.js';
import {
  canCreateAutomationInGroup,
  canManageAutomation,
  canManageGroup,
  canReadAutomation,
  canReadSession,
  readRequestAuthorization,
  type RequestAuthorization,
} from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import type { AutomationInvocationRecord, AutomationRecord, SessionRecord } from '../store/types.js';
import type { AppServices, AppVariables } from './server.js';
import {
  parseSessionVisibility,
  parseSessionWritePolicy,
  resolveAutomationCreateGroup,
  sessionCreateDefaults,
} from './access-policy.js';
import { writeError } from './http-error.js';
import {
  HttpRequestError,
  optionalString,
  parseBranchBody,
  parseModelBody,
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

    const group = await resolveAutomationCreateGroup(services.store, auth, body.ownerGroupId);
    if (!group) return writeError(c, 404, 'not_found', 'Group not found');
    if (group.archivedAt) return writeError(c, 409, 'archived_group', 'Cannot create automations in an archived group');
    if (!canCreateAutomationInGroup(auth, group)) {
      const required = group.automationCreateRequiredRole === 'admin' ? 'admin' : 'member';
      return writeError(c, 403, 'forbidden', `Group ${required} access is required to create automations`);
    }

    const requestedVisibility = body.visibility === undefined ? undefined : parseSessionVisibility(body.visibility);
    const requestedWritePolicy = body.writePolicy === undefined ? undefined : parseSessionWritePolicy(body.writePolicy);
    if (body.visibility !== undefined && !requestedVisibility) {
      return writeError(c, 400, 'invalid_request', 'Expected valid visibility');
    }
    if (body.writePolicy !== undefined && !requestedWritePolicy) {
      return writeError(c, 400, 'invalid_request', 'Expected valid writePolicy');
    }
    const defaults = sessionCreateDefaults(config, auth, group);
    const canOverrideAccessDefaults = canManageGroup(auth, group.id);
    if (
      !canOverrideAccessDefaults &&
      ((requestedVisibility && requestedVisibility !== defaults.visibility) ||
        (requestedWritePolicy && requestedWritePolicy !== defaults.writePolicy))
    ) {
      return writeError(c, 403, 'forbidden', 'Group admin access is required to override access defaults');
    }

    try {
      const context = parseAutomationCreateContextBody(body, config, services);
      const automation = await services.automations.createScheduled({
        name,
        prompt,
        scheduleCron,
        ownerGroupId: group.id,
        visibility: requestedVisibility ?? defaults.visibility,
        writePolicy: requestedWritePolicy ?? defaults.writePolicy,
        enabled: body.enabled === undefined ? true : parseBooleanBody(body.enabled, 'enabled'),
        ...(auth.bypass ? {} : { createdByUserId: auth.user.id }),
        ...(Object.keys(context).length ? { context } : {}),
      });
      return c.json({ automation: await serializeAutomation(services, automation, auth) }, 201);
    } catch (error) {
      if (error instanceof AutomationServiceError) return automationServiceErrorResponse(c, error);
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
    const accessChangeRequested =
      body.ownerGroupId !== undefined || body.visibility !== undefined || body.writePolicy !== undefined;
    if (accessChangeRequested && !canManageGroup(auth, automation.ownerGroupId)) {
      return writeError(c, 403, 'forbidden', 'Group admin access is required to change automation access');
    }

    const nextOwnerGroupId = optionalString(body.ownerGroupId) ?? automation.ownerGroupId;
    const nextGroup = await services.store.getGroup(nextOwnerGroupId);
    if (!nextGroup) return writeError(c, 404, 'not_found', 'Group not found');
    if (nextOwnerGroupId !== automation.ownerGroupId && !canManageGroup(auth, nextOwnerGroupId)) {
      return writeError(c, 403, 'forbidden', 'Group admin access is required for both groups');
    }
    if (nextOwnerGroupId !== automation.ownerGroupId && nextGroup.archivedAt) {
      return writeError(c, 409, 'archived_group', 'Cannot move automations to an archived group');
    }

    const visibility = body.visibility === undefined ? undefined : parseSessionVisibility(body.visibility);
    const writePolicy = body.writePolicy === undefined ? undefined : parseSessionWritePolicy(body.writePolicy);
    if (body.visibility !== undefined && !visibility) {
      return writeError(c, 400, 'invalid_request', 'Expected valid visibility');
    }
    if (body.writePolicy !== undefined && !writePolicy) {
      return writeError(c, 400, 'invalid_request', 'Expected valid writePolicy');
    }

    try {
      const context = parseAutomationUpdateContextBody(body, config, services, automation.context);
      const updated = await services.automations.updateScheduled({
        id: automation.id,
        ...(body.name !== undefined ? { name: optionalString(body.name) ?? '' } : {}),
        ...(body.prompt !== undefined ? { prompt: optionalString(body.prompt) ?? '' } : {}),
        ...(body.scheduleCron !== undefined ? { scheduleCron: optionalString(body.scheduleCron) ?? '' } : {}),
        ...(body.enabled !== undefined ? { enabled: parseBooleanBody(body.enabled, 'enabled') } : {}),
        ...(accessChangeRequested ? { ownerGroupId: nextOwnerGroupId } : {}),
        ...(visibility ? { visibility } : {}),
        ...(writePolicy ? { writePolicy } : {}),
        ...(context.changed ? { context: context.value } : {}),
      });
      return c.json({ automation: await serializeAutomation(services, updated, auth) });
    } catch (error) {
      if (error instanceof AutomationServiceError) return automationServiceErrorResponse(c, error);
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
  const [ownerGroup, invocationPage] = await Promise.all([
    services.store.getGroup(automation.ownerGroupId),
    services.automations.listInvocationPage({ automationId: automation.id, limit: 1 }),
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
    ownerGroupId: automation.ownerGroupId,
    ...(ownerGroup ? { ownerGroupName: ownerGroup.name } : {}),
    ...(ownerGroup?.archivedAt ? { ownerGroupArchivedAt: ownerGroup.archivedAt } : {}),
    visibility: automation.visibility,
    writePolicy: automation.writePolicy,
    ...(automation.createdByUserId ? { createdByUserId: automation.createdByUserId } : {}),
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
  if (error.code === 'archived_group') return writeError(c, 409, 'archived_group', error.message, error.details);
  if (error.code === 'overlap') return writeError(c, 409, 'automation_overlap', error.message, error.details);
  if (error.code === 'invalid_schedule') return writeError(c, 400, 'invalid_schedule', error.message);
  return writeError(c, 400, 'invalid_request', error.message);
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
): Record<string, unknown> {
  const repository = parseRepositoryBody(body.repository);
  const model = parseModelBody(body.model, config);
  const unavailable = services.modelAvailability.unavailableFor(model || config.runnerModelDefault);
  if (unavailable) throw new HttpRequestError(409, 'model_unavailable', unavailable.reason);
  const branch = repository ? parseBranchBody(body.branch) : undefined;
  return {
    ...(repository ? { repository } : {}),
    ...(model ? { model } : {}),
    ...(repository && branch ? { branch } : {}),
  };
}

function parseAutomationUpdateContextBody(
  body: Record<string, unknown>,
  config: AppConfig,
  services: AppServices,
  currentContext: Record<string, unknown> | undefined,
): { changed: boolean; value: Record<string, unknown> | null } {
  const hasRepository = Object.prototype.hasOwnProperty.call(body, 'repository');
  const hasModel = Object.prototype.hasOwnProperty.call(body, 'model');
  const hasBranch = Object.prototype.hasOwnProperty.call(body, 'branch');
  if (!hasRepository && !hasModel && !hasBranch) return { changed: false, value: null };

  const next = { ...(currentContext ?? {}) };
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
  if (hasBranch) {
    const branch = parseBranchBody(body.branch);
    if (branch) next.branch = branch;
    else delete next.branch;
  }

  return { changed: true, value: Object.keys(next).length ? next : null };
}
