import { agentCanManageSession, type AgentPrincipal } from '../auth/agent-authorization.js';
import type { AppStore, ScheduledFollowUpRecord } from '../store/types.js';
import type { ScheduledFollowUpSchedule } from './recurrence.js';
import type { ScheduledFollowUpService } from './service.js';

export type ScheduledFollowUpToolBaseServices = {
  store: Pick<AppStore, 'getSession' | 'withAgentSessionLease'>;
  scheduledFollowUps: ScheduledFollowUpService;
};
export type ScheduledFollowUpToolServices = ScheduledFollowUpToolBaseServices & {
  sessionId: string;
  runId: string;
  messageId: string;
  shouldPersist?: () => Promise<boolean>;
};
type Action = 'create' | 'preview' | 'list' | 'get' | 'update' | 'cancel' | 'list_occurrences';
const actions: Action[] = ['create', 'preview', 'list', 'get', 'update', 'cancel', 'list_occurrences'];
const contextProperties = {
  environmentId: { type: 'string' },
  environmentRevisionId: { type: 'string' },
  environmentRevisionPolicy: { type: 'string' },
  repository: {
    type: 'object',
    additionalProperties: false,
    required: ['owner', 'repo'],
    properties: { owner: { type: 'string' }, repo: { type: 'string' } },
  },
  branch: { type: 'string' },
  model: { type: 'string' },
  reasoningLevel: { type: 'string' },
  skills: { type: 'array', items: { type: 'string' } },
  skillRefs: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name'],
      properties: { id: { type: 'string' }, name: { type: 'string' }, revisionId: { type: 'string' } },
    },
  },
} as const;
const schedule = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'runAt'],
      properties: { kind: { const: 'once' }, runAt: { type: 'string' }, displayTimezone: { type: 'string' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'dtstartLocal', 'timezone', 'rrule'],
      properties: {
        kind: { const: 'recurring' },
        dtstartLocal: { type: 'string' },
        timezone: { type: 'string' },
        rrule: { type: 'string' },
        endsAt: { type: 'string' },
        maxOccurrences: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  ],
} as const;
export const scheduledFollowUpsToolDescription =
  'Create and manage bounded scheduled prompts in non-archived sessions available to the acting session.';
export const scheduledFollowUpsToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: actions },
    sessionId: { type: 'string' },
    followUpId: { type: 'string' },
    prompt: { type: 'string' },
    schedule,
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
    expectedRevision: { type: 'integer', minimum: 1 },
    contextOverrides: { type: ['object', 'null'], additionalProperties: false, properties: contextProperties },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    beforeCreatedAt: { type: 'string' },
    beforeId: { type: 'string' },
    beforeOccurrenceNumber: { type: 'integer', minimum: 1 },
  },
} as const;

export async function executeScheduledFollowUpsTool(s: ScheduledFollowUpToolServices, value: unknown) {
  let action: Action | undefined;
  try {
    const p = object(value);
    action = readAction(p.action);
    const selectedAction = action;
    const mutating = selectedAction === 'create' || selectedAction === 'update' || selectedAction === 'cancel';
    if (mutating && s.shouldPersist && !(await s.shouldPersist()))
      throw new Error('run_inactive: the acting run no longer holds its persistence lease');
    return await s.store.withAgentSessionLease(s.sessionId, async () => {
      if (mutating && s.shouldPersist && !(await s.shouldPersist()))
        throw new Error('run_inactive: the acting run no longer holds its persistence lease');
      const target = await targetSession(s, optionalString(p.sessionId) ?? s.sessionId);
      if (selectedAction === 'preview')
        return ok(selectedAction, s.scheduledFollowUps.preview(readSchedule(p.schedule)));
      if (selectedAction === 'create') {
        const key = string(p.idempotencyKey, 'idempotencyKey').trim();
        if (!key) throw new Error('invalid_request: idempotencyKey must be nonempty');
        return ok(
          selectedAction,
          await s.scheduledFollowUps.create({
            sessionId: target.id,
            prompt: string(p.prompt, 'prompt'),
            schedule: readSchedule(p.schedule),
            ...(p.contextOverrides ? { contextOverrides: object(p.contextOverrides) } : {}),
            createdBySessionId: s.sessionId,
            createdByRunId: s.runId,
            createdByMessageId: s.messageId,
            idempotencyKey: key,
            maxNewForRun: 10,
          }),
        );
      }
      if (selectedAction === 'list') {
        const records = await s.scheduledFollowUps.list(target.id, limit(p.limit), cursor(p));
        return ok(selectedAction, { followUps: records.map(summary) });
      }
      const id = string(p.followUpId, 'followUpId');
      if (selectedAction === 'get') return ok(selectedAction, await s.scheduledFollowUps.get(target.id, id));
      if (selectedAction === 'list_occurrences') {
        await s.scheduledFollowUps.get(target.id, id);
        return ok(selectedAction, {
          occurrences: await s.scheduledFollowUps.occurrences(
            id,
            limit(p.limit),
            optionalNumber(p.beforeOccurrenceNumber),
          ),
        });
      }
      const revision = number(p.expectedRevision, 'expectedRevision');
      if (selectedAction === 'cancel')
        return ok(selectedAction, await s.scheduledFollowUps.cancel(target.id, id, revision));
      return ok(
        selectedAction,
        await s.scheduledFollowUps.update({
          sessionId: target.id,
          id,
          expectedRevision: revision,
          ...(p.prompt !== undefined ? { prompt: string(p.prompt, 'prompt') } : {}),
          ...(p.schedule !== undefined ? { schedule: readSchedule(p.schedule) } : {}),
          ...(p.contextOverrides !== undefined
            ? { contextOverrides: p.contextOverrides === null ? null : object(p.contextOverrides) }
            : {}),
        }),
      );
    });
  } catch (error) {
    return { ok: false, ...(action ? { action } : {}), error: error instanceof Error ? error.message : String(error) };
  }
}
async function targetSession(s: ScheduledFollowUpToolServices, id: string) {
  const acting = await s.store.getSession(s.sessionId);
  if (!acting) throw new Error('acting_session_not_found: acting session does not exist');
  const target = await s.store.getSession(id);
  const principal: AgentPrincipal = {
    kind: 'session_agent',
    sessionId: acting.id,
    spawnDepth: acting.spawnDepth,
    ...(acting.visibility === 'private' && acting.ownerUserId ? { ownerUserId: acting.ownerUserId } : {}),
  };
  if (!target || target.status === 'archived' || !agentCanManageSession(principal, target))
    throw new Error('target_forbidden: target is not available to the acting session');
  return target;
}
function summary({ prompt: _prompt, ...record }: ScheduledFollowUpRecord) {
  return record;
}
function ok(action: Action, data: unknown) {
  return { ok: true, action, data };
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid_request: params must be an object');
  return v as Record<string, unknown>;
}
function string(v: unknown, n: string) {
  if (typeof v !== 'string') throw new Error(`invalid_request: ${n} is required`);
  return v;
}
function optionalString(v: unknown) {
  return v === undefined ? undefined : string(v, 'value');
}
function number(v: unknown, n: string) {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`invalid_request: ${n} is required`);
  return v;
}
function optionalNumber(v: unknown) {
  return v === undefined ? undefined : number(v, 'value');
}
function limit(v: unknown) {
  return v === undefined ? 20 : number(v, 'limit');
}
function readAction(v: unknown): Action {
  if (typeof v !== 'string' || !actions.includes(v as Action))
    throw new Error('invalid_action: unsupported scheduled follow-up action');
  return v as Action;
}
function readSchedule(v: unknown) {
  const x = object(v);
  if (x.kind === 'once') {
    return {
      kind: 'once',
      runAt: string(x.runAt, 'schedule.runAt'),
      ...(x.displayTimezone === undefined
        ? {}
        : { displayTimezone: string(x.displayTimezone, 'schedule.displayTimezone') }),
    } satisfies ScheduledFollowUpSchedule;
  }
  if (x.kind === 'recurring') {
    return {
      kind: 'recurring',
      dtstartLocal: string(x.dtstartLocal, 'schedule.dtstartLocal'),
      timezone: string(x.timezone, 'schedule.timezone'),
      rrule: string(x.rrule, 'schedule.rrule'),
      ...(x.endsAt === undefined ? {} : { endsAt: string(x.endsAt, 'schedule.endsAt') }),
      ...(x.maxOccurrences === undefined
        ? {}
        : { maxOccurrences: number(x.maxOccurrences, 'schedule.maxOccurrences') }),
    } satisfies ScheduledFollowUpSchedule;
  }
  throw new Error('invalid_request: schedule.kind must be once or recurring');
}
function cursor(p: Record<string, unknown>) {
  if (p.beforeCreatedAt === undefined && p.beforeId === undefined) return undefined;
  if (typeof p.beforeCreatedAt !== 'string' || typeof p.beforeId !== 'string')
    throw new Error('invalid_request: beforeCreatedAt and beforeId must be supplied together');
  const date = new Date(p.beforeCreatedAt);
  if (Number.isNaN(date.getTime())) throw new Error('invalid_request: beforeCreatedAt is invalid');
  return { createdAt: date, id: p.beforeId };
}
