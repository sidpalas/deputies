import type { Context, Hono } from 'hono';
import { canWriteSession, readRequestAuthorization } from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import { ScheduledFollowUpServiceError } from '../scheduled-follow-ups/service.js';
import type { ScheduledFollowUpSchedule } from '../scheduled-follow-ups/recurrence.js';
import type { ScheduledFollowUpRecord } from '../store/types.js';
import type { AppServices, AppVariables } from './server.js';
import { readJsonBody } from './request.js';
import { writeError } from './http-error.js';

const int4Max = 2_147_483_647;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerScheduledFollowUpRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
) {
  const base = '/sessions/:sessionId/scheduled-follow-ups';
  const auth = async (c: Context<{ Variables: AppVariables }>, write = false) => {
    const a = await readRequestAuthorization(config, services.store, c),
      s = c.get('authorizedSession');
    if (!a || !s) return null;
    if (write && !canWriteSession(a, s)) return null;
    return a;
  };
  const fail = (c: Context<{ Variables: AppVariables }>, e: unknown) =>
    e instanceof ScheduledFollowUpServiceError
      ? writeError(
          c,
          e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : e.code === 'archived' ? 409 : 400,
          e.code,
          e.message,
        )
      : Promise.reject(e instanceof Error ? e : new Error(String(e)));
  app.post(`${base}/preview`, async (c) => {
    if (!(await auth(c))) return writeError(c, 403, 'forbidden', 'Session access required');
    const b = await readJsonBody(c, config.maxJsonBodyBytes);
    try {
      return c.json(services.scheduledFollowUps.preview(parseSchedule(b.schedule)));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post(base, async (c) => {
    const a = await auth(c, true);
    if (!a) return writeError(c, 403, 'forbidden', 'Member access required');
    const b = await readJsonBody(c, config.maxJsonBodyBytes);
    try {
      return c.json(
        {
          scheduledFollowUp: serialize(
            await services.scheduledFollowUps.create({
              sessionId: c.req.param('sessionId'),
              prompt: requiredString(b.prompt, 'prompt'),
              schedule: parseSchedule(b.schedule),
              ...(b.contextOverrides !== undefined
                ? { contextOverrides: parseObject(b.contextOverrides, 'contextOverrides') }
                : {}),
              ...(a.bypass ? {} : { createdByUserId: a.user.id }),
            }),
            true,
          ),
        },
        201,
      );
    } catch (e) {
      return fail(c, e);
    }
  });
  app.get(base, async (c) => {
    const a = await auth(c);
    if (!a) return writeError(c, 403, 'forbidden', 'Session access required');
    const limit = parsePositiveInteger(c.req.query('limit'), 50, 100);
    if (!limit) return writeError(c, 400, 'invalid_request', 'limit must be an integer between 1 and 100');
    const cursor = parseListCursor(c.req.query('cursor'));
    if (cursor === null) return writeError(c, 400, 'invalid_request', 'cursor is invalid');
    const items = await services.scheduledFollowUps.list(c.req.param('sessionId'), limit + 1, cursor);
    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    return c.json({
      scheduledFollowUps: page.map((x) => serialize(x, canWriteSession(a, c.get('authorizedSession')!))),
      hasMore,
      ...(hasMore ? { nextCursor: encodeListCursor(page.at(-1)!) } : {}),
    });
  });
  app.get(`${base}/:followUpId`, async (c) => {
    if (!uuidPattern.test(c.req.param('followUpId')))
      return writeError(c, 400, 'invalid_request', 'followUpId must be a UUID');
    const a = await auth(c);
    if (!a) return writeError(c, 403, 'forbidden', 'Session access required');
    try {
      return c.json({
        scheduledFollowUp: serialize(
          await services.scheduledFollowUps.get(c.req.param('sessionId'), c.req.param('followUpId')),
          canWriteSession(a, c.get('authorizedSession')!),
        ),
      });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.patch(`${base}/:followUpId`, async (c) => {
    if (!uuidPattern.test(c.req.param('followUpId')))
      return writeError(c, 400, 'invalid_request', 'followUpId must be a UUID');
    if (!(await auth(c, true))) return writeError(c, 403, 'forbidden', 'Member access required');
    const b = await readJsonBody(c, config.maxJsonBodyBytes);
    try {
      const expectedRevision = requiredPositiveInteger(b.definitionRevision, 'definitionRevision', int4Max);
      if (b.prompt !== undefined && (typeof b.prompt !== 'string' || !b.prompt.trim()))
        throw new ScheduledFollowUpServiceError('invalid_request', 'prompt must be a non-empty string');
      return c.json({
        scheduledFollowUp: serialize(
          await services.scheduledFollowUps.update({
            sessionId: c.req.param('sessionId'),
            id: c.req.param('followUpId'),
            expectedRevision,
            ...(b.prompt !== undefined ? { prompt: b.prompt } : {}),
            ...(b.schedule !== undefined ? { schedule: parseSchedule(b.schedule) } : {}),
            ...(b.contextOverrides !== undefined
              ? { contextOverrides: parseNullableObject(b.contextOverrides, 'contextOverrides') }
              : {}),
          }),
          true,
        ),
      });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.delete(`${base}/:followUpId`, async (c) => {
    if (!uuidPattern.test(c.req.param('followUpId')))
      return writeError(c, 400, 'invalid_request', 'followUpId must be a UUID');
    if (!(await auth(c, true))) return writeError(c, 403, 'forbidden', 'Member access required');
    try {
      const revision = requiredPositiveInteger(c.req.query('definitionRevision'), 'definitionRevision', int4Max);
      return c.json({
        scheduledFollowUp: serialize(
          await services.scheduledFollowUps.cancel(c.req.param('sessionId'), c.req.param('followUpId'), revision),
          true,
        ),
      });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.get(`${base}/:followUpId/occurrences`, async (c) => {
    if (!uuidPattern.test(c.req.param('followUpId')))
      return writeError(c, 400, 'invalid_request', 'followUpId must be a UUID');
    if (!(await auth(c))) return writeError(c, 403, 'forbidden', 'Session access required');
    try {
      await services.scheduledFollowUps.get(c.req.param('sessionId'), c.req.param('followUpId'));
      const limit = parsePositiveInteger(c.req.query('limit'), 50, 100);
      if (!limit) throw new ScheduledFollowUpServiceError('invalid_request', 'limit must be 1..100');
      const cursor = c.req.query('cursor') ? requiredPositiveInteger(c.req.query('cursor'), 'cursor', 100) : undefined;
      const items = await services.scheduledFollowUps.occurrences(c.req.param('followUpId'), limit + 1, cursor);
      const hasMore = items.length > limit;
      const page = items.slice(0, limit);
      return c.json({
        occurrences: page,
        hasMore,
        ...(hasMore ? { nextCursor: String(page.at(-1)!.occurrenceNumber) } : {}),
      });
    } catch (e) {
      return fail(c, e);
    }
  });
}
function serialize(v: ScheduledFollowUpRecord, canManage = false) {
  return {
    ...v,
    runAt: v.runAt?.toISOString(),
    endsAt: v.endsAt?.toISOString(),
    nextDueAt: v.nextDueAt?.toISOString(),
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    completedAt: v.completedAt?.toISOString(),
    cancelledAt: v.cancelledAt?.toISOString(),
    canManage,
  };
}

function parseSchedule(value: unknown): ScheduledFollowUpSchedule {
  if (!isObject(value) || (value.kind !== 'once' && value.kind !== 'recurring'))
    throw new ScheduledFollowUpServiceError('invalid_request', 'schedule must be a valid discriminated schedule');
  if (value.kind === 'once') {
    return {
      kind: 'once',
      runAt: requiredString(value.runAt, 'schedule.runAt'),
      ...(value.displayTimezone !== undefined
        ? { displayTimezone: requiredString(value.displayTimezone, 'schedule.displayTimezone') }
        : {}),
    };
  }
  return {
    kind: 'recurring',
    dtstartLocal: requiredString(value.dtstartLocal, 'schedule.dtstartLocal'),
    timezone: requiredString(value.timezone, 'schedule.timezone'),
    rrule: requiredString(value.rrule, 'schedule.rrule'),
    ...(value.endsAt !== undefined ? { endsAt: requiredString(value.endsAt, 'schedule.endsAt') } : {}),
    ...(value.maxOccurrences !== undefined
      ? { maxOccurrences: requiredPositiveInteger(value.maxOccurrences, 'schedule.maxOccurrences') }
      : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new ScheduledFollowUpServiceError('invalid_request', `${field} must be a non-empty string`);
  return value;
}
function requiredPositiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new ScheduledFollowUpServiceError('invalid_request', `${field} must be an integer between 1 and ${maximum}`);
  return parsed;
}
function parsePositiveInteger(value: string | undefined, fallback: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}
function parseNullableObject(value: unknown, field: string): Record<string, unknown> | null {
  if (value === null) return null;
  if (!isObject(value))
    throw new ScheduledFollowUpServiceError('invalid_request', `${field} must be an object or null`);
  return value;
}
function parseObject(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) throw new ScheduledFollowUpServiceError('invalid_request', `${field} must be an object`);
  return value;
}
function parseListCursor(value: string | undefined): { createdAt: Date; id: string } | undefined | null {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!isObject(parsed) || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    const createdAt = new Date(parsed.createdAt);
    return Number.isNaN(createdAt.getTime()) || !uuidPattern.test(parsed.id) ? null : { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}
function encodeListCursor(value: ScheduledFollowUpRecord): string {
  return Buffer.from(JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id })).toString('base64url');
}
function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
