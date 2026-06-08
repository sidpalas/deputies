import { randomUUID } from 'node:crypto';
import type { MessageService } from '../messages/service.js';
import type { SessionService } from '../sessions/service.js';
import type {
  AppStore,
  AutomationInvocationRecord,
  AutomationInvocationTrigger,
  AutomationRecord,
  MessageRecord,
  SessionRecord,
  SessionVisibility,
  SessionWritePolicy,
} from '../store/types.js';
import { CronExpressionError, nextUtcCronInvocation, validateUtcCronExpression } from './cron.js';

export type CreateScheduledAutomationInput = {
  name: string;
  prompt: string;
  scheduleCron: string;
  ownerGroupId: string;
  visibility: SessionVisibility;
  writePolicy: SessionWritePolicy;
  enabled?: boolean;
  createdByUserId?: string;
  context?: Record<string, unknown>;
};

export type UpdateScheduledAutomationInput = {
  id: string;
  name?: string;
  prompt?: string;
  scheduleCron?: string;
  enabled?: boolean;
  ownerGroupId?: string;
  visibility?: SessionVisibility;
  writePolicy?: SessionWritePolicy;
  context?: Record<string, unknown> | null;
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

export class AutomationServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_schedule' | 'invalid_request' | 'disabled' | 'overlap',
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
  ) {}

  async createScheduled(input: CreateScheduledAutomationInput): Promise<AutomationRecord> {
    const now = new Date();
    const name = requiredTrimmed(input.name, 'name');
    const prompt = requiredTrimmed(input.prompt, 'prompt');
    const scheduleCron = parseScheduleCron(input.scheduleCron);
    const nextInvocationAt = nextScheduledInvocation(scheduleCron, now);
    return this.store.createAutomation({
      id: randomUUID(),
      kind: 'scheduled',
      name,
      prompt,
      scheduleCron,
      enabled: input.enabled ?? true,
      ownerGroupId: input.ownerGroupId,
      visibility: input.visibility,
      writePolicy: input.writePolicy,
      createdAt: now,
      updatedAt: now,
      nextInvocationAt,
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      ...(input.context ? { context: input.context } : {}),
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

    const now = new Date();
    const scheduleCron =
      input.scheduleCron === undefined ? existing.scheduleCron : parseScheduleCron(input.scheduleCron);
    const enabled = input.enabled ?? existing.enabled;
    const scheduleChanged = scheduleCron !== existing.scheduleCron;
    const enabledChanged = input.enabled !== undefined && input.enabled !== existing.enabled;
    const shouldRecalculateNextInvocation =
      scheduleChanged || (enabled && enabledChanged) || !existing.nextInvocationAt;

    const updated: AutomationRecord = {
      ...existing,
      name: input.name === undefined ? existing.name : requiredTrimmed(input.name, 'name'),
      prompt: input.prompt === undefined ? existing.prompt : requiredTrimmed(input.prompt, 'prompt'),
      scheduleCron,
      enabled,
      ownerGroupId: input.ownerGroupId ?? existing.ownerGroupId,
      visibility: input.visibility ?? existing.visibility,
      writePolicy: input.writePolicy ?? existing.writePolicy,
      updatedAt: now,
      ...(shouldRecalculateNextInvocation ? { nextInvocationAt: nextScheduledInvocation(scheduleCron, now) } : {}),
    };

    if (input.context !== undefined) {
      if (input.context) updated.context = input.context;
      else delete updated.context;
    }

    return this.store.updateAutomation(updated);
  }

  async listInvocations(automationId: string): Promise<AutomationInvocationRecord[]> {
    return this.store.listAutomationInvocations(automationId);
  }

  async invokeManual(input: ManualAutomationInvocationInput): Promise<AutomationInvocationResult> {
    const automation = await this.store.getAutomation(input.automationId);
    if (!automation) throw new AutomationServiceError('not_found', 'Automation not found');
    if (!automation.enabled && !input.allowDisabled) {
      throw new AutomationServiceError('disabled', 'Automation is disabled', { requiresAllowDisabled: true });
    }

    const blockingSession = await this.activeAutomationSession(automation);
    if (blockingSession && !input.allowOverlap) {
      throw new AutomationServiceError('overlap', 'Automation already has a queued or active session', {
        blockingSessionId: blockingSession.id,
        requiresAllowOverlap: true,
      });
    }

    return this.createSessionInvocation({
      automation,
      trigger: 'manual',
      metadata: {
        ...(input.allowDisabled && !automation.enabled ? { disabledOverride: true } : {}),
        ...(input.allowOverlap && blockingSession
          ? { overlapOverride: true, blockingSessionId: blockingSession.id }
          : {}),
      },
      ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
    });
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
      if (await this.hasScheduledInvocation(automation.id, scheduledAt)) {
        // A prior scheduler attempt may have created the invocation but crashed before advancing the schedule.
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
        const blockingSession = await this.activeAutomationSession(automation);
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
        nextInvocationAt,
        updatedAt: new Date(),
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
  }): Promise<AutomationInvocationResult> {
    const now = new Date();
    const invocation = await this.store.createAutomationInvocation({
      id: randomUUID(),
      automationId: input.automation.id,
      trigger: input.trigger,
      status: 'creating',
      createdAt: now,
      metadata: input.metadata ?? {},
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
    });

    try {
      await this.assertAutomationGroupIsActive(input.automation);
      const createdSession = await this.sessions.create({
        title: automationSessionTitle(input.automation, input.scheduledAt ?? now),
        ownerGroupId: input.automation.ownerGroupId,
        visibility: input.automation.visibility,
        writePolicy: input.automation.writePolicy,
      });
      const message = await this.messages.enqueue({
        sessionId: createdSession.id,
        prompt: input.automation.prompt,
        source: 'automation',
        authorName: `Automation: ${input.automation.name}`,
        ...(input.automation.context ? { context: input.automation.context } : {}),
      });
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
      const failed = await this.store.updateAutomationInvocation({
        ...invocation,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown automation invocation error',
        completedAt: new Date(),
      });
      return { invocation: failed };
    }
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
    return this.store.createAutomationInvocation({
      id: randomUUID(),
      automationId: input.automation.id,
      trigger: input.trigger,
      status: input.status,
      createdAt: now,
      completedAt: now,
      metadata: input.metadata ?? {},
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.error ? { error: input.error } : {}),
    });
  }

  private async activeAutomationSession(automation: AutomationRecord): Promise<SessionRecord | null> {
    const invocations = await this.store.listAutomationInvocations(automation.id);
    for (const invocation of invocations) {
      if (invocation.status !== 'created' || !invocation.sessionId) continue;
      const session = await this.store.getSession(invocation.sessionId);
      if (session?.status === 'queued' || session?.status === 'active') return session;
    }
    return null;
  }

  private async hasScheduledInvocation(automationId: string, scheduledAt: Date): Promise<boolean> {
    const invocations = await this.store.listAutomationInvocations(automationId);
    return invocations.some(
      (invocation) => invocation.trigger === 'scheduled' && invocation.scheduledAt?.getTime() === scheduledAt.getTime(),
    );
  }

  private async assertAutomationGroupIsActive(automation: AutomationRecord): Promise<void> {
    const group = await this.store.getGroup(automation.ownerGroupId);
    if (!group) throw new Error(`Group not found: ${automation.ownerGroupId}`);
    if (group.archivedAt) throw new Error('Cannot invoke automation owned by an archived group');
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

function formatUtcMinute(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}
