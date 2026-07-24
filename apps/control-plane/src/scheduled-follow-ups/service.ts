import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import {
  StoreConflictError,
  type AppStore,
  type EventRecord,
  type ScheduledFollowUpContextOverrides,
  type ScheduledFollowUpRecord,
  type ScheduledFollowUpResolvedContext,
} from '../store/types.js';
import type { EnvironmentService } from '../environments/service.js';
import { EnvironmentServiceError } from '../environments/service.js';
import {
  HttpRequestError,
  parseBranchBody,
  parseModelBody,
  parseReasoningLevelBody,
  parseRepositoryBody,
} from '../app/request.js';
import {
  canonicalizeMessageSkillContext,
  listSkillInvocationCandidates,
  SkillContextError,
} from '../skills/invocation.js';
import type { SkillService } from '../skills/service.js';
import type { ModelAvailabilityService } from '../app/model-availability.js';
import { GitHubRepositoryAccessError } from '../integrations/github/repository-access.js';
import {
  normalizeSchedule,
  nextOccurrence,
  ScheduleValidationError,
  type NormalizedSchedule,
  type ScheduledFollowUpSchedule,
} from './recurrence.js';
import {
  ExternalBindingInvalidError,
  resolveExternalCallback,
  type ExternalCallbackResolverConfig,
} from './external-callback-resolver.js';

const pastToleranceMs = 30_000;
const contextKeys = new Set([
  'environmentId',
  'environmentRevisionId',
  'environmentRevisionPolicy',
  'repository',
  'branch',
  'model',
  'reasoningLevel',
  'skills',
  'skillRefs',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class ScheduledFollowUpServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_request' | 'archived' | 'conflict' | 'external_binding_invalid',
    message: string,
  ) {
    super(message);
  }
}
export class ScheduledFollowUpService {
  private githubAccessVerifier?: (repository: { owner: string; repo: string }) => Promise<unknown>;

  constructor(
    private store: AppStore,
    private events: EventService,
    private externalResolverConfig: ExternalCallbackResolverConfig = {
      slackBotConfigured: false,
      slackAllowedTeamIds: [],
      slackAllowedChannelIds: [],
      githubAppConfigured: false,
      githubAllowedRepositories: [],
    },
    private contextServices?: {
      environments: Pick<EnvironmentService, 'get' | 'resolve'>;
      skills: Pick<SkillService, 'listInvocationCandidates' | 'listForRun'>;
      modelConfig: { runnerModelDefault?: string; runnerModelChoices: string[] };
      modelAvailability: Pick<ModelAvailabilityService, 'unavailableFor'>;
      skillsEnabled: boolean;
      repoSkillsEnabled: boolean;
    },
  ) {}
  setGitHubAccessVerifier(verifier: (repository: { owner: string; repo: string }) => Promise<unknown>) {
    this.githubAccessVerifier = verifier;
  }
  preview(schedule: ScheduledFollowUpSchedule, now = new Date()) {
    const normalized = normalizeSchedule(schedule);
    const occurrences: Date[] = [];
    if (normalized.kind === 'once') {
      if (normalized.runAt > now) occurrences.push(normalized.runAt);
    } else {
      let cursor = now;
      while (occurrences.length < Math.min(10, normalized.maxOccurrences)) {
        const next = nextOccurrence(normalized, cursor);
        if (!next) break;
        occurrences.push(next);
        cursor = next;
      }
    }
    return {
      normalized,
      occurrences: occurrences.map((d) => d.toISOString()),
    };
  }
  async create(input: {
    sessionId: string;
    prompt: string;
    schedule: ScheduledFollowUpSchedule;
    contextOverrides?: ScheduledFollowUpContextOverrides;
    createdByUserId?: string;
    createdBySessionId?: string;
    createdByRunId?: string;
    createdByMessageId?: string;
    idempotencyKey?: string;
    maxNewForRun?: number;
  }) {
    if (input.createdByRunId && input.idempotencyKey) {
      const replay = await this.store.getScheduledFollowUpByCreatorKey(input.createdByRunId, input.idempotencyKey);
      if (replay) {
        if (replay.sessionId !== input.sessionId)
          throw new ScheduledFollowUpServiceError('conflict', 'Idempotency key belongs to a different session');
        return replay;
      }
    }
    const now = new Date(),
      prompt = input.prompt.trim();
    if (!prompt) throw new ScheduledFollowUpServiceError('invalid_request', 'prompt is required');
    const schedule = this.normalize(input.schedule);
    if (schedule.kind === 'once' && schedule.runAt.getTime() < now.getTime() - pastToleranceMs)
      throw new ScheduledFollowUpServiceError('invalid_request', 'runAt may not be more than 30 seconds in the past');
    const contextOverrides = await this.canonicalizeContext(input.sessionId, input.contextOverrides);
    await this.assertExternal(input.sessionId);
    const next = schedule.kind === 'once' ? schedule.runAt : nextOccurrence(schedule, now);
    if (!next) throw new ScheduledFollowUpServiceError('invalid_request', 'Schedule has no occurrences');
    try {
      const r = await this.store.createScheduledFollowUp({
        id: randomUUID(),
        sessionId: input.sessionId,
        scheduleKind: schedule.kind,
        prompt,
        ...(contextOverrides ? { contextOverrides } : {}),
        ...(schedule.kind === 'once'
          ? { runAt: schedule.runAt }
          : {
              dtstartLocal: schedule.dtstartLocal,
              timezone: schedule.timezone,
              rrule: schedule.rrule,
              maxOccurrences: schedule.maxOccurrences,
              ...(schedule.endsAt ? { endsAt: schedule.endsAt } : {}),
            }),
        nextDueAt: next,
        createdAt: now,
        updatedAt: now,
        ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
        ...(input.createdBySessionId ? { createdBySessionId: input.createdBySessionId } : {}),
        ...(input.createdByRunId ? { createdByRunId: input.createdByRunId } : {}),
        ...(input.createdByMessageId ? { createdByMessageId: input.createdByMessageId } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.maxNewForRun !== undefined ? { maxNewForRun: input.maxNewForRun } : {}),
      });
      this.publish(r.events);
      return r.followUp;
    } catch (e) {
      throw mapError(e);
    }
  }
  async get(sessionId: string, id: string) {
    const f = await this.store.getScheduledFollowUp(id);
    if (!f || f.sessionId !== sessionId)
      throw new ScheduledFollowUpServiceError('not_found', 'Scheduled follow-up not found');
    return f;
  }
  list(sessionId: string, limit: number, before?: { createdAt: Date; id: string }) {
    return this.store.listScheduledFollowUps({ sessionId, limit, ...(before ? { before } : {}) });
  }
  occurrences(id: string, limit: number, before?: number) {
    return this.store.listScheduledFollowUpOccurrences({
      followUpId: id,
      limit,
      ...(before ? { before: { occurrenceNumber: before } } : {}),
    });
  }
  async update(input: {
    sessionId: string;
    id: string;
    expectedRevision: number;
    prompt?: string;
    schedule?: ScheduledFollowUpSchedule;
    contextOverrides?: ScheduledFollowUpContextOverrides | null;
  }) {
    if (input.prompt !== undefined && !input.prompt.trim())
      throw new ScheduledFollowUpServiceError('invalid_request', 'prompt must be a non-empty string');
    const old = await this.get(input.sessionId, input.id);
    await this.assertExternal(input.sessionId);
    const contextOverrides =
      input.contextOverrides === null ? null : await this.canonicalizeContext(input.sessionId, input.contextOverrides);
    const now = new Date();
    const schedule = input.schedule ? this.normalize(input.schedule) : recordSchedule(old);
    try {
      const r = await this.store.updateScheduledFollowUp({
        id: input.id,
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        ...(input.prompt !== undefined ? { prompt: input.prompt.trim() } : {}),
        ...(input.contextOverrides !== undefined ? { contextOverrides: contextOverrides! } : {}),
        scheduleKind: schedule.kind,
        runAt: schedule.kind === 'once' ? schedule.runAt : null,
        dtstartLocal: schedule.kind === 'recurring' ? schedule.dtstartLocal : null,
        timezone: schedule.kind === 'recurring' ? schedule.timezone : null,
        rrule: schedule.kind === 'recurring' ? schedule.rrule : null,
        endsAt: schedule.kind === 'recurring' ? (schedule.endsAt ?? null) : null,
        maxOccurrences: schedule.kind === 'recurring' ? schedule.maxOccurrences : null,
        normalizedSchedule: schedule,
        updatedAt: now,
      });
      this.publish(r.events);
      return r.followUp;
    } catch (e) {
      throw mapError(e);
    }
  }
  async cancel(sessionId: string, id: string, revision: number) {
    try {
      const r = await this.store.cancelScheduledFollowUp({
        id,
        sessionId,
        expectedRevision: revision,
        now: new Date(),
      });
      this.publish(r.events);
      return r.followUp;
    } catch (e) {
      throw mapError(e);
    }
  }
  async processNext(input: { lockOwner: string; now?: Date }) {
    const now = input.now ?? new Date();
    const claim = await this.store.claimDueScheduledFollowUp({
      lockOwner: input.lockOwner,
      now,
      lockedUntil: new Date(now.getTime() + 60_000),
    });
    if (!claim) return false;
    const result = await this.store.activateDueScheduledFollowUp({
      id: claim.followUp.id,
      lockOwner: input.lockOwner,
      claimedRevision: claim.claimedRevision,
      now,
      resolvedContext: await this.resolveActivationContext(claim.followUp),
      ...(await this.activationExternalBinding(claim.followUp.sessionId)),
    });
    if (result) this.publish(result.events);
    return true;
  }
  private normalize(s: ScheduledFollowUpSchedule) {
    try {
      return normalizeSchedule(s);
    } catch (e) {
      if (e instanceof ScheduleValidationError) throw new ScheduledFollowUpServiceError('invalid_request', e.message);
      throw e;
    }
  }
  private async canonicalizeContext(
    sessionId: string,
    value?: ScheduledFollowUpContextOverrides,
  ): Promise<ScheduledFollowUpContextOverrides | undefined> {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) this.invalid('contextOverrides must be an object');
    for (const key of Object.keys(value))
      if (!contextKeys.has(key)) this.invalid(`Unsupported context override: ${key}`);
    try {
      const has = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
      const environmentId = has('environmentId') ? requiredUuid(value.environmentId, 'environmentId') : undefined;
      if (environmentId && (has('repository') || has('branch')))
        this.invalid('Use either environmentId or repository, not both');
      if (!environmentId && (has('environmentRevisionId') || has('environmentRevisionPolicy')))
        this.invalid('Environment revision selection requires environmentId');
      const policy = has('environmentRevisionPolicy') ? value.environmentRevisionPolicy : undefined;
      if (policy !== undefined && policy !== 'follow_latest' && policy !== 'pinned')
        this.invalid('environmentRevisionPolicy must be follow_latest or pinned');
      let revisionId = has('environmentRevisionId')
        ? requiredUuid(value.environmentRevisionId, 'environmentRevisionId')
        : undefined;
      if (environmentId && this.contextServices) {
        const environment = await this.contextServices.environments.get(environmentId);
        if (!environment || environment.archivedAt) this.invalid('Environment not found');
        if ((policy ?? (revisionId ? 'pinned' : 'follow_latest')) === 'pinned')
          revisionId ??= environment.currentRevisionId;
        await this.contextServices.environments.resolve({ environmentId, ...(revisionId ? { revisionId } : {}) });
      }
      const repository = has('repository') ? (parseRepositoryBody(value.repository) ?? null) : undefined;
      const branch = has('branch')
        ? value.branch === null
          ? null
          : (parseBranchBody(value.branch) ?? null)
        : undefined;
      if (branch && !repository) this.invalid('branch requires repository');
      const model = has('model')
        ? value.model === null
          ? null
          : (parseModelBody(value.model, this.contextServices?.modelConfig ?? { runnerModelChoices: [] }) ?? null)
        : undefined;
      if (model && this.contextServices?.modelAvailability.unavailableFor(model))
        this.invalid(`Model is unavailable: ${model}`);
      const reasoningLevel = has('reasoningLevel')
        ? value.reasoningLevel === null
          ? null
          : (parseReasoningLevelBody(value.reasoningLevel) ?? null)
        : undefined;
      let skillContext:
        | { skills: string[]; skillRefs: import('../skills/invocation.js').SkillInvocationRef[] }
        | undefined;
      if (has('skills') || has('skillRefs')) {
        const contextServices = this.contextServices;
        if (!contextServices) this.invalid('Skills are unavailable');
        skillContext = await canonicalizeMessageSkillContext({
          skills: contextServices.skills,
          events: this.store,
          sessionId,
          skillsEnabled: contextServices.skillsEnabled,
          repoSkillsEnabled: contextServices.repoSkillsEnabled,
          canUse: (skill) => skill.scope === 'tenant',
          value: { skills: value.skills, ...(has('skillRefs') ? { skillRefs: value.skillRefs } : {}) },
        });
      }
      return {
        ...(environmentId
          ? { environmentId, environmentRevisionPolicy: policy ?? (revisionId ? 'pinned' : 'follow_latest') }
          : {}),
        ...(revisionId ? { environmentRevisionId: revisionId } : {}),
        ...(has('repository') ? { repository: repository! } : {}),
        ...(has('branch') ? { branch: branch! } : {}),
        ...(has('model') ? { model: model! } : {}),
        ...(has('reasoningLevel') ? { reasoningLevel: reasoningLevel! } : {}),
        ...skillContext,
      };
    } catch (error) {
      if (error instanceof ScheduledFollowUpServiceError) throw error;
      if (error instanceof HttpRequestError || error instanceof SkillContextError)
        throw new ScheduledFollowUpServiceError('invalid_request', error.message);
      throw error;
    }
  }
  private async resolveActivationContext(followUp: ScheduledFollowUpRecord): Promise<ScheduledFollowUpResolvedContext> {
    try {
      const canonical = followUp.contextOverrides;
      await this.validateActivationSkills(followUp);
      const session = await this.store.getSession(followUp.sessionId);
      const inheritedModel = typeof session?.context?.model === 'string' ? session.context.model : undefined;
      const effectiveModel =
        canonical && Object.prototype.hasOwnProperty.call(canonical, 'model')
          ? (canonical.model ?? this.contextServices?.modelConfig.runnerModelDefault)
          : (inheritedModel ?? this.contextServices?.modelConfig.runnerModelDefault);
      if (this.contextServices?.modelAvailability.unavailableFor(effectiveModel))
        throw new ScheduledFollowUpServiceError('invalid_request', `Model is unavailable: ${effectiveModel}`);
      const overrides: Record<string, unknown> = {};
      const clear: string[] = [];
      if (canonical?.environmentId) {
        if (!this.contextServices) throw new Error('Environment service unavailable');
        overrides.environment = await this.contextServices.environments.resolve({
          environmentId: canonical.environmentId,
          ...(canonical.environmentRevisionPolicy === 'pinned' && canonical.environmentRevisionId
            ? { revisionId: canonical.environmentRevisionId }
            : {}),
        });
        clear.push('repository', 'branch');
      }
      for (const key of ['repository', 'branch', 'model', 'reasoningLevel'] as const) {
        if (!canonical || !Object.prototype.hasOwnProperty.call(canonical, key)) continue;
        if (canonical[key] === null) clear.push(key);
        else overrides[key] = canonical[key];
      }
      if (canonical && Object.prototype.hasOwnProperty.call(canonical, 'repository')) {
        clear.push('environment');
        if (!Object.prototype.hasOwnProperty.call(canonical, 'branch')) clear.push('branch');
      }
      if (canonical?.skills) {
        overrides.skills = canonical.skills;
        overrides.skillRefs = canonical.skillRefs ?? [];
      }
      return { status: 'valid', overrides, clear };
    } catch (error) {
      const unavailable =
        error instanceof EnvironmentServiceError ||
        (error instanceof ScheduledFollowUpServiceError && error.message.startsWith('Model is unavailable:')) ||
        (error instanceof ScheduledFollowUpServiceError && error.message === 'Environment not found');
      if (!unavailable && !(error instanceof ScheduledFollowUpServiceError)) throw error;
      return {
        status: 'invalid',
        reason: unavailable ? 'resource_unavailable' : 'invalid_context',
        error: error instanceof Error ? error.message : 'Invalid scheduled follow-up context',
      };
    }
  }
  private async validateActivationSkills(followUp: ScheduledFollowUpRecord): Promise<void> {
    const refs = followUp.contextOverrides?.skillRefs;
    if (!refs?.length) return;
    if (!this.contextServices) this.invalid('Skills are unavailable');
    const managed = refs.filter((ref) => ref.revisionId);
    const available = await this.contextServices.skills.listForRun({
      invokedNames: refs.map((ref) => ref.name),
      invokedRevisions: managed.map((ref) => ({ skillId: ref.id, revisionId: ref.revisionId! })),
    });
    if (
      managed.some(
        (ref) => !available.some((skill) => skill.id === ref.id && skill.resolvedRevisionId === ref.revisionId),
      )
    )
      this.invalid('Unknown or inaccessible pinned skill revision');
    const repositoryRefs = refs.filter((ref) => !ref.revisionId);
    if (repositoryRefs.length) {
      const candidates = await listSkillInvocationCandidates({
        skills: this.contextServices.skills,
        events: this.store,
        sessionId: followUp.sessionId,
        repoSkillsEnabled: this.contextServices.repoSkillsEnabled,
        canUse: (skill) => skill.scope === 'tenant',
      });
      if (
        repositoryRefs.some(
          (ref) =>
            !candidates.some((skill) => skill.source === 'repo' && skill.id === ref.id && skill.name === ref.name),
        )
      )
        this.invalid('Unknown or inaccessible skill');
    }
  }
  private invalid(message: string): never {
    throw new ScheduledFollowUpServiceError('invalid_request', message);
  }
  private async assertExternal(id: string) {
    const threads = await this.store.getExternalThreadsForSession(id);
    try {
      const callback = resolveExternalCallback(threads, id, this.externalResolverConfig);
      await this.verifyGitHubCallback(callback);
    } catch (error) {
      if (error instanceof ExternalBindingInvalidError)
        throw new ScheduledFollowUpServiceError('external_binding_invalid', error.message);
      throw error;
    }
  }
  private async activationExternalBinding(sessionId: string) {
    const threads = await this.store.getExternalThreadsForSession(sessionId);
    if (!threads.length) return { expectedExternalThreadId: null };
    try {
      const externalCallback = resolveExternalCallback(threads, sessionId, this.externalResolverConfig);
      await this.verifyGitHubCallback(externalCallback);
      return externalCallback
        ? { externalCallback, expectedExternalThreadId: threads[0]!.id }
        : { expectedExternalThreadId: null };
    } catch (error) {
      if (error instanceof ExternalBindingInvalidError)
        return { externalBindingError: error.message, expectedExternalThreadId: null };
      throw error;
    }
  }
  private async verifyGitHubCallback(callback: { type: string; target: Record<string, unknown> } | undefined) {
    if (callback?.type !== 'github' || !this.githubAccessVerifier) return;
    const owner = callback.target.owner;
    const repo = callback.target.repo;
    if (typeof owner !== 'string' || typeof repo !== 'string')
      throw new ExternalBindingInvalidError('GitHub external thread metadata is invalid');
    try {
      await this.githubAccessVerifier({ owner, repo });
    } catch (error) {
      if (error instanceof GitHubRepositoryAccessError)
        throw new ExternalBindingInvalidError('GitHub repository is not currently accessible');
      throw error;
    }
  }
  private publish(events: EventRecord[]) {
    for (const event of events) this.events.publishExternal(event);
  }
}
function mapError(e: unknown) {
  if (e instanceof ScheduledFollowUpServiceError) return e;
  if (e instanceof StoreConflictError)
    return new ScheduledFollowUpServiceError(
      e.code === 'session_archived' ? 'archived' : e.code === 'not_found' ? 'not_found' : 'conflict',
      e.message,
    );
  if (
    e &&
    typeof e === 'object' &&
    (e as { code?: string }).code === '23505' &&
    (e as { constraint?: string }).constraint === 'scheduled_follow_ups_created_by_run_id_idempotency_key_idx'
  )
    return new ScheduledFollowUpServiceError('conflict', 'Scheduled follow-up idempotency key already exists');
  return e;
}
function recordSchedule(f: ScheduledFollowUpRecord): NormalizedSchedule {
  return f.scheduleKind === 'once'
    ? { kind: 'once', runAt: f.runAt! }
    : {
        kind: 'recurring',
        dtstartLocal: f.dtstartLocal!,
        timezone: f.timezone!,
        rrule: f.rrule!,
        maxOccurrences: f.maxOccurrences!,
        ...(f.endsAt ? { endsAt: f.endsAt } : {}),
      };
}

function requiredUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value))
    throw new ScheduledFollowUpServiceError('invalid_request', `${field} must be a UUID`);
  return value;
}
