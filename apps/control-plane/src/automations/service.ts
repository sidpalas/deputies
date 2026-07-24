import { randomUUID } from 'node:crypto';
import type { MessageService } from '../messages/service.js';
import type { SessionService } from '../sessions/service.js';
import type { EnvironmentBranchOverride, EnvironmentService } from '../environments/service.js';
import type {
  AppStore,
  AutomationInvocationCursor,
  AutomationInvocationRecord,
  AutomationInvocationTrigger,
  AutomationRecord,
  EnvironmentRevisionPolicy,
  MessageRecord,
  SessionRecord,
} from '../store/types.js';
import { CronExpressionError, nextUtcCronInvocation, validateUtcCronExpression } from './cron.js';

export type CreateScheduledAutomationInput = {
  name: string;
  prompt: string;
  scheduleCron: string;
  enabled?: boolean;
  createdByUserId?: string;
  context?: Record<string, unknown>;
  environmentId?: string;
  environmentRevisionPolicy?: EnvironmentRevisionPolicy;
  environmentRevisionId?: string;
};

export type UpdateScheduledAutomationInput = {
  id: string;
  name?: string;
  prompt?: string;
  scheduleCron?: string;
  enabled?: boolean;
  context?: Record<string, unknown> | null;
  environmentId?: string | null;
  environmentRevisionPolicy?: EnvironmentRevisionPolicy | null;
  environmentRevisionId?: string | null;
};

export type ManualAutomationInvocationInput = {
  automationId: string;
  requestedByUserId?: string;
  allowDisabled?: boolean;
  allowOverlap?: boolean;
};

export type AutomationInvocationResult = {
  invocation: AutomationInvocationRecord;
  session?: SessionRecord;
  message?: MessageRecord;
};

export type AutomationInvocationPage = {
  invocations: AutomationInvocationRecord[];
  nextCursor?: AutomationInvocationCursor;
};

type InvocationReservation = {
  sessionId: string;
  messageId: string;
};

export class AutomationServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_schedule' | 'invalid_request' | 'disabled' | 'archived' | 'overlap',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class AutomationService {
  constructor(
    private readonly store: AppStore,
    private readonly sessions: SessionService,
    private readonly messages: MessageService,
    private readonly environments: EnvironmentService,
  ) {}

  async createScheduled(input: CreateScheduledAutomationInput): Promise<AutomationRecord> {
    const now = new Date();
    const name = requiredTrimmed(input.name, 'name');
    const prompt = requiredTrimmed(input.prompt, 'prompt');
    const scheduleCron = parseScheduleCron(input.scheduleCron);
    const nextInvocationAt = nextScheduledInvocation(scheduleCron, now);
    const revisionSelection = await this.validateEnvironmentRevisionSelection({
      environmentId: input.environmentId,
      policy: input.environmentRevisionPolicy,
      revisionId: input.environmentRevisionId,
    });
    return this.store.createAutomation({
      id: randomUUID(),
      kind: 'scheduled',
      name,
      prompt,
      scheduleCron,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      nextInvocationAt,
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      ...revisionSelection,
    });
  }

  async get(id: string): Promise<AutomationRecord | null> {
    return this.store.getAutomation(id);
  }

  async list(): Promise<AutomationRecord[]> {
    return this.store.listAutomations();
  }

  async updateScheduled(input: UpdateScheduledAutomationInput): Promise<AutomationRecord> {
    const existing = await this.store.getAutomation(input.id);
    if (!existing) throw new AutomationServiceError('not_found', 'Automation not found');
    if (existing.archivedAt) throw new AutomationServiceError('archived', 'Restore this automation before editing it');

    const now = new Date();
    const scheduleCron =
      input.scheduleCron === undefined ? existing.scheduleCron : parseScheduleCron(input.scheduleCron);
    const enabled = input.enabled ?? existing.enabled;
    const scheduleChanged = scheduleCron !== existing.scheduleCron;
    const enabledChanged = input.enabled !== undefined && input.enabled !== existing.enabled;
    const shouldRecalculateNextInvocation =
      scheduleChanged || (enabled && enabledChanged) || !existing.nextInvocationAt;
    const environmentId =
      input.environmentId === undefined ? existing.environmentId : (input.environmentId ?? undefined);
    const environmentChanged = input.environmentId !== undefined && environmentId !== existing.environmentId;
    const revisionSelection = await this.validateEnvironmentRevisionSelection({
      environmentId,
      policy:
        input.environmentRevisionPolicy === undefined
          ? environmentChanged
            ? undefined
            : existing.environmentRevisionPolicy
          : (input.environmentRevisionPolicy ?? undefined),
      revisionId:
        input.environmentRevisionId === undefined
          ? environmentChanged || input.environmentRevisionPolicy === 'follow_latest'
            ? undefined
            : existing.environmentRevisionId
          : (input.environmentRevisionId ?? undefined),
    });

    const update = {
      id: input.id,
      updatedAt: now,
      ...(input.name !== undefined ? { name: requiredTrimmed(input.name, 'name') } : {}),
      ...(input.prompt !== undefined ? { prompt: requiredTrimmed(input.prompt, 'prompt') } : {}),
      ...(input.scheduleCron !== undefined ? { scheduleCron } : {}),
      ...(input.enabled !== undefined ? { enabled } : {}),
      ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
      ...(input.environmentId !== undefined ||
      input.environmentRevisionPolicy !== undefined ||
      input.environmentRevisionId !== undefined
        ? {
            environmentRevisionPolicy: revisionSelection.environmentRevisionPolicy ?? null,
            environmentRevisionId: revisionSelection.environmentRevisionId ?? null,
          }
        : {}),
      ...(shouldRecalculateNextInvocation ? { nextInvocationAt: nextScheduledInvocation(scheduleCron, now) } : {}),
    };
    return this.store.updateAutomation({
      ...update,
      ...(input.context !== undefined ? { context: input.context } : {}),
    });
  }

  async archive(id: string): Promise<AutomationRecord> {
    const existing = await this.store.getAutomation(id);
    if (!existing) throw new AutomationServiceError('not_found', 'Automation not found');
    const archived = await this.store.archiveAutomation({ automationId: id, archivedAt: new Date() });
    if (!archived) throw new AutomationServiceError('not_found', 'Automation not found');
    return archived;
  }

  async unarchive(id: string): Promise<AutomationRecord> {
    const existing = await this.store.getAutomation(id);
    if (!existing) throw new AutomationServiceError('not_found', 'Automation not found');
    const unarchived = await this.store.unarchiveAutomation({ automationId: id, updatedAt: new Date() });
    if (!unarchived) throw new AutomationServiceError('not_found', 'Automation not found');
    return unarchived;
  }

  async listInvocations(automationId: string): Promise<AutomationInvocationRecord[]> {
    return this.store.listAutomationInvocations(automationId);
  }

  async listInvocationPage(input: {
    automationId: string;
    limit: number;
    before?: AutomationInvocationCursor;
  }): Promise<AutomationInvocationPage> {
    const records = await this.store.listAutomationInvocations(input.automationId, {
      ...(input.before ? { before: input.before } : {}),
      limit: input.limit + 1,
    });
    const invocations = records.slice(0, input.limit);
    const last = invocations.at(-1);
    return {
      invocations,
      ...(records.length > input.limit && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
    };
  }

  async invokeManual(input: ManualAutomationInvocationInput): Promise<AutomationInvocationResult> {
    const automation = await this.store.getAutomation(input.automationId);
    if (!automation) throw new AutomationServiceError('not_found', 'Automation not found');
    if (automation.archivedAt) {
      throw new AutomationServiceError('archived', 'Restore this automation before invoking it');
    }
    if (!automation.enabled && !input.allowDisabled) {
      throw new AutomationServiceError('disabled', 'Automation is disabled', { requiresAllowDisabled: true });
    }

    const lockOwner = `automation-manual-${randomUUID()}`;
    const locked = await this.store.claimAutomation({
      automationId: automation.id,
      now: new Date(),
      lockOwner,
      lockedUntil: new Date(Date.now() + 60_000),
    });
    if (!locked) {
      const current = await this.store.getAutomation(automation.id);
      if (current?.archivedAt)
        throw new AutomationServiceError('archived', 'Restore this automation before invoking it');
      if (current && !current.enabled && !input.allowDisabled) {
        throw new AutomationServiceError('disabled', 'Automation is disabled', { requiresAllowDisabled: true });
      }
      throw new AutomationServiceError('overlap', 'Automation is already being invoked', {
        requiresAllowOverlap: true,
      });
    }

    try {
      if (locked.archivedAt) throw new AutomationServiceError('archived', 'Restore this automation before invoking it');
      if (!locked.enabled && !input.allowDisabled) {
        throw new AutomationServiceError('disabled', 'Automation is disabled', { requiresAllowDisabled: true });
      }

      const blockingSession = await this.store.getBlockingAutomationSession(locked.id);
      if (blockingSession && !input.allowOverlap) {
        throw new AutomationServiceError('overlap', 'Automation already has a queued or active session', {
          blockingSessionId: blockingSession.id,
          requiresAllowOverlap: true,
        });
      }

      return await this.createSessionInvocation({
        automation: locked,
        trigger: 'manual',
        allowDisabled: input.allowDisabled === true,
        metadata: manualInvocationMetadata({
          allowDisabled: input.allowDisabled === true,
          allowOverlap: input.allowOverlap === true,
          automationEnabled: locked.enabled,
          blockingSession,
        }),
        ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
      });
    } finally {
      await this.store.releaseAutomationClaim({ automationId: locked.id, lockOwner });
    }
  }

  async processNextScheduled(input: { now?: Date; lockOwner: string; lockDurationMs?: number }): Promise<boolean> {
    const now = input.now ?? new Date();
    const automation = await this.store.claimNextDueScheduledAutomation({
      now,
      lockOwner: input.lockOwner,
      lockedUntil: new Date(now.getTime() + (input.lockDurationMs ?? 60_000)),
    });
    if (!automation) return false;

    const scheduledAt = automation.nextInvocationAt ?? now;
    const nextInvocationAt = nextUtcCronInvocation(automation.scheduleCron, now);
    try {
      const existingInvocation = await this.store.getAutomationInvocationBySchedule({
        automationId: automation.id,
        scheduledAt,
      });
      if (existingInvocation && existingInvocation.status !== 'creating') {
        // A prior scheduler attempt may have created the invocation but crashed before advancing the schedule.
      } else if (existingInvocation?.status === 'creating') {
        await this.createSessionInvocation({
          automation,
          trigger: 'scheduled',
          scheduledAt,
          invocation: existingInvocation,
        });
      } else if (isMissedScheduledTime(scheduledAt, now)) {
        await this.recordTerminalInvocation({
          automation,
          trigger: 'scheduled',
          status: 'skipped',
          scheduledAt,
          reason: 'missed_schedule',
          metadata: { now: now.toISOString() },
        });
      } else {
        const blockingSession = await this.store.getBlockingAutomationSession(automation.id);
        if (blockingSession) {
          await this.recordTerminalInvocation({
            automation,
            trigger: 'scheduled',
            status: 'skipped',
            scheduledAt,
            reason: 'previous_session_active',
            metadata: { blockingSessionId: blockingSession.id },
          });
        } else {
          await this.createSessionInvocation({ automation, trigger: 'scheduled', scheduledAt });
        }
      }
    } catch (error) {
      await this.recordTerminalInvocation({
        automation,
        trigger: 'scheduled',
        status: 'failed',
        scheduledAt,
        error: error instanceof Error ? error.message : 'Unknown automation scheduler error',
      });
    } finally {
      await this.store.completeScheduledAutomationClaim({
        automationId: automation.id,
        lockOwner: input.lockOwner,
        claimedScheduleCron: automation.scheduleCron,
        nextInvocationAt,
      });
    }

    return true;
  }

  private async createSessionInvocation(input: {
    automation: AutomationRecord;
    trigger: AutomationInvocationTrigger;
    scheduledAt?: Date;
    requestedByUserId?: string;
    metadata?: Record<string, unknown>;
    invocation?: AutomationInvocationRecord;
    allowDisabled?: boolean;
  }): Promise<AutomationInvocationResult> {
    const now = new Date();
    const environmentReference =
      input.invocation?.environmentId && input.invocation.environmentRevisionId
        ? {
            environmentId: input.invocation.environmentId,
            environmentRevisionId: input.invocation.environmentRevisionId,
          }
        : await this.resolveAutomationEnvironmentReference(input.automation);
    const initialInvocation =
      input.invocation ??
      (await this.store.createAutomationInvocation({
        id: randomUUID(),
        automationId: input.automation.id,
        trigger: input.trigger,
        status: 'creating',
        createdAt: now,
        metadata: input.metadata ?? {},
        ...environmentReference,
        reservedSessionId: randomUUID(),
        reservedMessageId: randomUUID(),
        ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
        ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
      }));
    const { invocation, reservation } = await this.ensureInvocationReservation(initialInvocation);
    const { sessionId, messageId } = reservation;

    try {
      await this.assertAutomationCanCreateSession(input.automation, { allowDisabled: input.allowDisabled === true });
      const existingSession = await this.store.getSession(sessionId);
      const createdSession =
        existingSession ??
        (await this.sessions.create({
          id: sessionId,
          title: automationSessionTitle(input.automation, input.scheduledAt ?? now),
          tags: ['automation'],
          ...effectiveSessionCreator(input.automation, input.requestedByUserId),
        }));
      const existingMessage = (await this.store.getMessages(createdSession.id)).find(
        (message) => message.id === messageId,
      );
      const messageContext = await this.resolveAutomationMessageContext(
        input.automation,
        invocation.environmentRevisionId,
      );
      const message =
        existingMessage ??
        (await this.messages.enqueue({
          id: messageId,
          sessionId: createdSession.id,
          prompt: input.automation.prompt,
          source: 'automation',
          authorName: `Automation: ${input.automation.name}`,
          ...(messageContext ? { context: messageContext } : {}),
        }));
      const session = (await this.store.getSession(createdSession.id)) ?? createdSession;
      const completed = await this.store.updateAutomationInvocation({
        ...invocation,
        status: 'created',
        sessionId: session.id,
        messageId: message.id,
        completedAt: new Date(),
      });
      return { invocation: completed, session, message };
    } catch (error) {
      const existingSession = await this.store.getSession(sessionId);
      const existingMessage = existingSession
        ? (await this.store.getMessages(existingSession.id)).find((message) => message.id === messageId)
        : null;
      if (existingSession && existingMessage) {
        const recovered = await this.store.updateAutomationInvocation({
          ...invocation,
          status: 'created',
          sessionId: existingSession.id,
          messageId: existingMessage.id,
          completedAt: new Date(),
        });
        return { invocation: recovered, session: existingSession, message: existingMessage };
      }

      const failed = await this.store.updateAutomationInvocation({
        ...invocation,
        status: 'failed',
        ...(existingSession ? { sessionId } : {}),
        error: error instanceof Error ? error.message : 'Unknown automation invocation error',
        completedAt: new Date(),
      });
      return { invocation: failed };
    }
  }

  private async ensureInvocationReservation(invocation: AutomationInvocationRecord): Promise<{
    invocation: AutomationInvocationRecord;
    reservation: InvocationReservation;
  }> {
    const reservation = {
      sessionId: invocation.reservedSessionId ?? invocation.sessionId ?? randomUUID(),
      messageId: invocation.reservedMessageId ?? invocation.messageId ?? randomUUID(),
    };
    if (invocation.reservedSessionId && invocation.reservedMessageId) return { invocation, reservation };
    return {
      invocation: await this.store.updateAutomationInvocation({
        ...invocation,
        reservedSessionId: reservation.sessionId,
        reservedMessageId: reservation.messageId,
      }),
      reservation,
    };
  }

  private async recordTerminalInvocation(input: {
    automation: AutomationRecord;
    trigger: AutomationInvocationTrigger;
    status: 'skipped' | 'failed';
    scheduledAt?: Date;
    reason?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AutomationInvocationRecord> {
    const now = new Date();
    const environmentReference = await this.resolveAutomationEnvironmentReference(input.automation);
    return this.store.createAutomationInvocation({
      id: randomUUID(),
      automationId: input.automation.id,
      trigger: input.trigger,
      status: input.status,
      createdAt: now,
      completedAt: now,
      metadata: input.metadata ?? {},
      ...environmentReference,
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.error ? { error: input.error } : {}),
    });
  }

  private async recordOrUpdateSkippedInvocation(input: {
    automation: AutomationRecord;
    invocation?: AutomationInvocationRecord;
    scheduledAt: Date;
    reason: string;
    metadata?: Record<string, unknown>;
  }): Promise<AutomationInvocationRecord> {
    const now = new Date();
    if (input.invocation) {
      const environmentReference =
        input.invocation.environmentId && input.invocation.environmentRevisionId
          ? {}
          : await this.resolveAutomationEnvironmentReference(input.automation);
      return this.store.updateAutomationInvocation({
        ...input.invocation,
        ...environmentReference,
        status: 'skipped',
        reason: input.reason,
        metadata: { ...input.invocation.metadata, ...(input.metadata ?? {}) },
        completedAt: now,
      });
    }
    return this.recordTerminalInvocation({
      automation: input.automation,
      trigger: 'scheduled',
      status: 'skipped',
      scheduledAt: input.scheduledAt,
      reason: input.reason,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  private async assertAutomationCanCreateSession(
    automation: AutomationRecord,
    options: { allowDisabled?: boolean } = {},
  ): Promise<void> {
    const current = await this.store.getAutomation(automation.id);
    if (!current) throw new Error(`Automation not found: ${automation.id}`);
    if (current.archivedAt) throw new Error('Cannot invoke an archived automation');
    if (!current.enabled && !options.allowDisabled)
      throw new Error('Cannot automatically invoke a disabled automation');
  }

  private async resolveAutomationMessageContext(
    automation: AutomationRecord,
    environmentRevisionId: string | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    if (!automation.environmentId) return automation.context;
    const context = automation.context ?? {};
    const environment = await this.environments.resolve({
      environmentId: automation.environmentId,
      ...(environmentRevisionId ? { revisionId: environmentRevisionId } : {}),
      branchOverrides: storedEnvironmentBranchOverrides(context.environmentBranchOverrides),
    });
    return {
      environment,
      ...(typeof context.model === 'string' && context.model ? { model: context.model } : {}),
      ...(typeof context.reasoningLevel === 'string' && context.reasoningLevel
        ? { reasoningLevel: context.reasoningLevel }
        : {}),
    };
  }

  private async validateEnvironmentRevisionSelection(input: {
    environmentId: string | undefined;
    policy: EnvironmentRevisionPolicy | undefined;
    revisionId: string | undefined;
  }): Promise<Pick<AutomationRecord, 'environmentRevisionPolicy' | 'environmentRevisionId'>> {
    if (!input.environmentId) {
      if (input.policy || input.revisionId) {
        throw new AutomationServiceError('invalid_request', 'Environment revision selection requires environmentId');
      }
      return {};
    }
    const policy = input.policy ?? 'follow_latest';
    if (policy === 'follow_latest') {
      if (input.revisionId) {
        throw new AutomationServiceError('invalid_request', 'Follow-latest automations cannot pin a revision');
      }
      return { environmentRevisionPolicy: policy };
    }
    if (!input.revisionId) {
      throw new AutomationServiceError('invalid_request', 'Pinned automations require environmentRevisionId');
    }
    const revision = await this.store.getEnvironmentRevision(input.revisionId);
    if (!revision || revision.environmentId !== input.environmentId) {
      throw new AutomationServiceError('invalid_request', 'Environment revision does not belong to the environment');
    }
    return { environmentRevisionPolicy: policy, environmentRevisionId: revision.id };
  }

  private async resolveAutomationEnvironmentReference(
    automation: AutomationRecord,
  ): Promise<Pick<AutomationInvocationRecord, 'environmentId' | 'environmentRevisionId'>> {
    if (!automation.environmentId) return {};
    if (automation.environmentRevisionPolicy === 'pinned') {
      if (!automation.environmentRevisionId) throw new Error('Pinned automation is missing its environment revision');
      return {
        environmentId: automation.environmentId,
        environmentRevisionId: automation.environmentRevisionId,
      };
    }
    const environment = await this.environments.get(automation.environmentId);
    if (!environment) throw new Error(`Environment not found: ${automation.environmentId}`);
    return {
      environmentId: environment.id,
      environmentRevisionId: environment.currentRevisionId,
    };
  }
}

function parseScheduleCron(value: string): string {
  const scheduleCron = requiredTrimmed(value, 'scheduleCron');
  try {
    validateUtcCronExpression(scheduleCron);
  } catch (error) {
    if (error instanceof CronExpressionError) {
      throw new AutomationServiceError('invalid_schedule', error.message);
    }
    throw error;
  }
  return scheduleCron;
}

function nextScheduledInvocation(scheduleCron: string, after: Date): Date {
  try {
    return nextUtcCronInvocation(scheduleCron, after);
  } catch (error) {
    if (error instanceof CronExpressionError) {
      throw new AutomationServiceError('invalid_schedule', error.message);
    }
    throw error;
  }
}

function requiredTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AutomationServiceError('invalid_request', `Expected non-empty string field: ${field}`);
  return trimmed;
}

function storedEnvironmentBranchOverrides(value: unknown): EnvironmentBranchOverride[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<EnvironmentBranchOverride[]>((overrides, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return overrides;
    const record = item as Record<string, unknown>;
    const owner = typeof record.owner === 'string' ? record.owner : '';
    const repo = typeof record.repo === 'string' ? record.repo : '';
    const branch = typeof record.branch === 'string' ? record.branch : '';
    if (!owner || !repo) return overrides;
    overrides.push({
      provider: 'github' as const,
      owner,
      repo,
      ...(branch ? { branch } : {}),
    });
    return overrides;
  }, []);
}

function isMissedScheduledTime(scheduledAt: Date, now: Date): boolean {
  return scheduledAt < currentUtcMinute(now);
}

function currentUtcMinute(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()),
  );
}

function automationSessionTitle(automation: AutomationRecord, invocationTime: Date): string {
  return `${automation.name} - ${formatUtcMinute(invocationTime)}`;
}

function manualInvocationMetadata(input: {
  allowDisabled: boolean;
  allowOverlap: boolean;
  automationEnabled: boolean;
  blockingSession: SessionRecord | null;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (input.allowDisabled && !input.automationEnabled) metadata.disabledOverride = true;
  if (input.allowOverlap && input.blockingSession) {
    metadata.overlapOverride = true;
    metadata.blockingSessionId = input.blockingSession.id;
  }
  return metadata;
}

function effectiveSessionCreator(
  automation: AutomationRecord,
  requestedByUserId: string | undefined,
): { createdByUserId: string } | Record<string, never> {
  const createdByUserId = requestedByUserId ?? automation.createdByUserId;
  return createdByUserId ? { createdByUserId } : {};
}

function formatUtcMinute(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}
