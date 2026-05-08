import type { NormalizedEvent } from '../events/types.js';
import type {
  AppStore,
  ArtifactRecord,
  AuthAccountRecord,
  AuthSessionRecord,
  AuthUserRecord,
  CallbackDeliveryRecord,
  CreateArtifactRecord,
  CreateCallbackDeliveryRecord,
  CreateSandboxRecord,
  CreateWebhookSourceRecord,
  ExternalThreadRecord,
  IntegrationDeliveryRecord,
  CreateMessageRecord,
  CreateSessionRecord,
  ClaimedMessage,
  ClaimedMessageBatch,
  MessageRecord,
  RecoveredRun,
  RunRecord,
  SandboxRecord,
  SessionRecord,
  UpsertAuthUserForAccountRecord,
  WebhookSourceRecord,
} from './types.js';

const staleCallbackSendingMs = 15 * 60_000;

export class MemoryStore implements AppStore {
  private readonly authUsers = new Map<string, AuthUserRecord>();
  private readonly authAccounts = new Map<string, AuthAccountRecord>();
  private readonly authSessions = new Map<string, AuthSessionRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly events = new Map<string, Array<NormalizedEvent & { sequence: number }>>();
  private readonly sandboxes = new Map<string, SandboxRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly callbacks = new Map<string, CallbackDeliveryRecord>();
  private readonly webhookSources = new Map<string, WebhookSourceRecord>();
  private readonly externalThreads = new Map<string, ExternalThreadRecord>();
  private readonly integrationDeliveries = new Map<string, IntegrationDeliveryRecord>();

  async upsertAuthUserForAccount(record: UpsertAuthUserForAccountRecord): Promise<AuthUserRecord> {
    const accountKey = authAccountKey(record.provider, record.providerAccountId);
    const existingAccount = this.authAccounts.get(accountKey);
    const existingUser = existingAccount ? this.authUsers.get(existingAccount.userId) : undefined;
    const user: AuthUserRecord = {
      id: existingUser?.id ?? record.userId,
      username: record.username,
      createdAt: existingUser?.createdAt ?? record.now,
      updatedAt: record.now,
      ...(record.displayName ? { displayName: record.displayName } : {}),
      ...(record.avatarUrl ? { avatarUrl: record.avatarUrl } : {}),
    };
    const account: AuthAccountRecord = {
      id: existingAccount?.id ?? record.accountId,
      userId: user.id,
      provider: record.provider,
      providerAccountId: record.providerAccountId,
      username: record.username,
      profile: record.profile,
      createdAt: existingAccount?.createdAt ?? record.now,
      updatedAt: record.now,
    };

    this.authUsers.set(user.id, user);
    this.authAccounts.set(accountKey, account);
    return user;
  }

  async createAuthSession(record: AuthSessionRecord): Promise<AuthSessionRecord> {
    this.authSessions.set(record.id, record);
    return record;
  }

  async getAuthUserBySession(input: { sessionId: string; now: Date }): Promise<AuthUserRecord | null> {
    const session = this.authSessions.get(input.sessionId);
    if (!session || session.expiresAt <= input.now) return null;
    return this.authUsers.get(session.userId) ?? null;
  }

  async deleteAuthSession(sessionId: string): Promise<void> {
    this.authSessions.delete(sessionId);
  }

  async createSession(record: CreateSessionRecord): Promise<SessionRecord> {
    if (this.sessions.has(record.id)) {
      throw new Error(`Session already exists: ${record.id}`);
    }

    this.sessions.set(record.id, record);
    return record;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async updateSession(record: SessionRecord): Promise<SessionRecord> {
    if (!this.sessions.has(record.id)) {
      throw new Error(`Session does not exist: ${record.id}`);
    }

    this.sessions.set(record.id, record);
    return record;
  }

  async pauseSessionQueue(input: { sessionId: string; pausedAt: Date }): Promise<SessionRecord> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    const updated = { ...existing, queuePausedAt: input.pausedAt, updatedAt: input.pausedAt };
    this.sessions.set(input.sessionId, updated);
    return updated;
  }

  async resumeSessionQueue(input: { sessionId: string }): Promise<SessionRecord> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    const { queuePausedAt: _queuePausedAt, ...updated } = { ...existing, updatedAt: new Date() };
    this.sessions.set(input.sessionId, updated);
    return updated;
  }

  async nextMessageSequence(sessionId: string): Promise<number> {
    return (this.messages.get(sessionId)?.length ?? 0) + 1;
  }

  async createMessage(record: CreateMessageRecord): Promise<MessageRecord> {
    const sessionMessages = this.messages.get(record.sessionId) ?? [];
    sessionMessages.push(record);
    this.messages.set(record.sessionId, sessionMessages);
    return record;
  }

  async getMessages(sessionId: string): Promise<MessageRecord[]> {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async updatePendingMessage(input: { sessionId: string; messageId: string; prompt: string }): Promise<MessageRecord | null> {
    const sessionMessages = this.messages.get(input.sessionId) ?? [];
    const message = sessionMessages.find((candidate) => candidate.id === input.messageId && candidate.status === 'pending');
    if (!message) return null;
    const updated = { ...message, prompt: input.prompt };
    sessionMessages[sessionMessages.indexOf(message)] = updated;
    return updated;
  }

  async cancelPendingMessage(input: { sessionId: string; messageId: string; cancelledAt: Date }): Promise<MessageRecord | null> {
    const sessionMessages = this.messages.get(input.sessionId) ?? [];
    const message = sessionMessages.find((candidate) => candidate.id === input.messageId && candidate.status === 'pending');
    if (!message) return null;
    const updated: MessageRecord = { ...message, status: 'cancelled' };
    sessionMessages[sessionMessages.indexOf(message)] = updated;
    return updated;
  }

  async claimNextPendingMessage(input: {
    runId: string;
    runnerType: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessage | null> {
    const batch = await this.claimNextPendingMessageBatch(input);
    return batch ? { message: batch.messages[0]!, run: batch.run } : null;
  }

  async claimNextPendingMessageBatch(input: {
    runId: string;
    runnerType: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessageBatch | null> {
    for (const [sessionId, sessionMessages] of this.messages) {
      const currentSession = this.sessions.get(sessionId);
      if (currentSession?.queuePausedAt || currentSession?.status === 'archived') continue;
      if (this.hasActiveRun(sessionId, input.now)) continue;

      const pendingMessages = sessionMessages.filter((candidate) => candidate.status === 'pending').sort((a, b) => a.sequence - b.sequence);
      if (!pendingMessages.length) continue;

      const processingMessages = pendingMessages.map((message) => ({ ...message, status: 'processing' as const }));
      for (const message of processingMessages) {
        const existing = sessionMessages.find((candidate) => candidate.id === message.id)!;
        sessionMessages[sessionMessages.indexOf(existing)] = message;
      }

      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session does not exist: ${sessionId}`);
      this.sessions.set(sessionId, { ...session, status: 'active', updatedAt: input.now });

      const run: RunRecord = {
        id: input.runId,
        sessionId,
        messageId: processingMessages[0]!.id,
        status: 'running',
        runnerType: input.runnerType,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        heartbeatAt: input.now,
        attempt: 1,
        startedAt: input.now,
        metadata: { messageIds: processingMessages.map((message) => message.id), sequences: processingMessages.map((message) => message.sequence) },
      };
      this.runs.set(run.id, run);
      return { messages: processingMessages, run };
    }

    return null;
  }

  async completeRun(input: { runId: string; completedAt: Date }): Promise<ClaimedMessage> {
    const batch = await this.completeRunBatch(input);
    return { message: batch.messages[0]!, run: batch.run };
  }

  async completeRunBatch(input: { runId: string; completedAt: Date }): Promise<ClaimedMessageBatch> {
    return this.finishRun(input.runId, input.completedAt, 'completed');
  }

  async renewRunLease(input: {
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    heartbeatAt: Date;
  }): Promise<RunRecord | null> {
    const run = this.runs.get(input.runId);
    if (!run || (run.status !== 'running' && run.status !== 'cancelling') || run.leaseOwner !== input.leaseOwner) return null;

    const renewed: RunRecord = {
      ...run,
      leaseExpiresAt: input.leaseExpiresAt,
      heartbeatAt: input.heartbeatAt,
    };
    this.runs.set(input.runId, renewed);
    return renewed;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async recoverStaleRuns(input: { now: Date; limit: number }): Promise<RecoveredRun[]> {
    const recovered: RecoveredRun[] = [];

    for (const run of this.runs.values()) {
      if (recovered.length >= input.limit) break;
      if (run.status !== 'running' && run.status !== 'starting' && run.status !== 'cancelling') continue;
      if (!run.leaseExpiresAt || run.leaseExpiresAt > input.now) continue;

      const sessionMessages = this.messages.get(run.sessionId) ?? [];
      const message = sessionMessages.find((candidate) => candidate.id === run.messageId);
      if (!message) continue;

      const pendingMessage: MessageRecord = { ...message, status: 'pending' };
      sessionMessages[sessionMessages.indexOf(message)] = pendingMessage;

      const { leaseExpiresAt: _leaseExpiresAt, leaseOwner: _leaseOwner, ...runWithoutLease } = run;
      const staleRun: RunRecord = {
        ...runWithoutLease,
        status: 'stale',
        failedAt: input.now,
        heartbeatAt: input.now,
        error: 'Run lease expired',
      };
      this.runs.set(run.id, staleRun);

      const session = this.sessions.get(run.sessionId);
      if (session) this.sessions.set(run.sessionId, { ...session, status: 'idle', updatedAt: input.now });

      recovered.push({ message: pendingMessage, run: staleRun });
    }

    return recovered;
  }

  async failRun(input: { runId: string; failedAt: Date; error: string }): Promise<ClaimedMessage> {
    const batch = await this.failRunBatch(input);
    return { message: batch.messages[0]!, run: batch.run };
  }

  async failRunBatch(input: { runId: string; failedAt: Date; error: string }): Promise<ClaimedMessageBatch> {
    const claimed = await this.finishRun(input.runId, input.failedAt, 'failed');
    this.runs.set(input.runId, { ...claimed.run, error: input.error });
    return { ...claimed, run: this.runs.get(input.runId)! };
  }

  async requestRunCancellation(input: { sessionId: string; requestedAt: Date; error: string }): Promise<ClaimedMessageBatch | null> {
    const run = [...this.runs.values()].find((candidate) => candidate.sessionId === input.sessionId && (candidate.status === 'running' || candidate.status === 'starting' || candidate.status === 'cancelling'));
    if (!run) return null;

    const sessionMessages = this.messages.get(run.sessionId) ?? [];
    const messages = getRunMessageIds(run).map((messageId) => {
      const message = sessionMessages.find((candidate) => candidate.id === messageId);
      if (!message) throw new Error(`Message does not exist: ${messageId}`);
      const cancellingMessage: MessageRecord = { ...message, status: message.status === 'cancelled' ? 'cancelled' : 'cancelling' };
      sessionMessages[sessionMessages.indexOf(message)] = cancellingMessage;
      return cancellingMessage;
    });
    const cancellingRun: RunRecord = { ...run, status: 'cancelling', heartbeatAt: input.requestedAt, error: input.error };
    this.runs.set(run.id, cancellingRun);
    return { messages, run: cancellingRun };
  }

  async finalizeRunCancellation(input: { runId: string; cancelledAt: Date; error: string }): Promise<ClaimedMessageBatch> {
    const claimed = this.finishRun(input.runId, input.cancelledAt, 'cancelled');
    const cancelledRun: RunRecord = { ...claimed.run, error: input.error };
    this.runs.set(input.runId, cancelledRun);
    return { ...claimed, run: cancelledRun };
  }

  async getActiveSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null> {
    return (await this.listActiveSandboxes(sessionId, provider))[0] ?? null;
  }

  async listActiveSandboxes(sessionId: string, provider: string): Promise<SandboxRecord[]> {
    return Array.from(this.sandboxes.values())
      .filter((sandbox) => sandbox.sessionId === sessionId && sandbox.provider === provider)
      .filter(isActiveSandbox)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async listIdleSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]> {
    return Array.from(this.sandboxes.values())
      .filter((sandbox) => sandbox.provider === input.provider)
      .filter(isActiveSandbox)
      .filter((sandbox) => sandbox.updatedAt <= input.idleBefore)
      .filter((sandbox) => this.sessions.get(sandbox.sessionId)?.status !== 'active')
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, input.limit);
  }

  async listStoppableSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]> {
    return Array.from(this.sandboxes.values())
      .filter((sandbox) => sandbox.provider === input.provider)
      .filter((sandbox) => !sandbox.destroyedAt && sandbox.status === 'ready')
      .filter((sandbox) => sandbox.updatedAt <= input.idleBefore)
      .filter((sandbox) => this.sessions.get(sandbox.sessionId)?.status !== 'active')
      .filter((sandbox) => !(this.messages.get(sandbox.sessionId) ?? []).some((message) => message.status === 'pending'))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, input.limit);
  }

  async createSandbox(record: CreateSandboxRecord): Promise<SandboxRecord> {
    if (this.sandboxes.has(record.id)) throw new Error(`Sandbox already exists: ${record.id}`);
    this.sandboxes.set(record.id, record);
    return record;
  }

  async updateSandbox(record: SandboxRecord): Promise<SandboxRecord> {
    if (!this.sandboxes.has(record.id)) throw new Error(`Sandbox does not exist: ${record.id}`);
    this.sandboxes.set(record.id, record);
    return record;
  }

  async createArtifact(record: CreateArtifactRecord): Promise<ArtifactRecord> {
    if (this.artifacts.has(record.id)) throw new Error(`Artifact already exists: ${record.id}`);
    this.artifacts.set(record.id, record);
    return record;
  }

  async getArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    return Array.from(this.artifacts.values()).filter((artifact) => artifact.sessionId === sessionId);
  }

  async createCallbackDelivery(record: CreateCallbackDeliveryRecord): Promise<CallbackDeliveryRecord> {
    const delivery: CallbackDeliveryRecord = { ...record, status: 'pending', attempts: 0, maxAttempts: record.maxAttempts ?? 5 };
    this.callbacks.set(delivery.id, delivery);
    return delivery;
  }

  async listCallbackDeliveries(input: { sessionId: string; messageId?: string }): Promise<CallbackDeliveryRecord[]> {
    return Array.from(this.callbacks.values())
      .filter((delivery) => delivery.sessionId === input.sessionId)
      .filter((delivery) => !input.messageId || delivery.messageId === input.messageId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async claimDueCallbackDeliveries(input: { now: Date; limit: number }): Promise<CallbackDeliveryRecord[]> {
    const staleSendingBefore = new Date(input.now.getTime() - staleCallbackSendingMs);
    const due = Array.from(this.callbacks.values())
      .filter((delivery) => delivery.status === 'pending' || isStaleSendingCallback(delivery, staleSendingBefore))
      .filter((delivery) => !delivery.nextAttemptAt || delivery.nextAttemptAt <= input.now)
      .filter((delivery) => delivery.attempts < delivery.maxAttempts)
      .sort((a, b) => (a.nextAttemptAt?.getTime() ?? a.createdAt.getTime()) - (b.nextAttemptAt?.getTime() ?? b.createdAt.getTime()))
      .slice(0, input.limit);
    const claimed = due.map((delivery) => {
      const updated: CallbackDeliveryRecord = {
        ...delivery,
        status: 'sending',
        attempts: delivery.attempts + 1,
        lastAttemptAt: input.now,
        updatedAt: input.now,
      };
      this.callbacks.set(delivery.id, updated);
      return updated;
    });
    return claimed;
  }

  async markCallbackDeliverySent(input: { id: string; deliveredAt: Date }): Promise<CallbackDeliveryRecord> {
    const existing = this.requireCallback(input.id);
    const { nextAttemptAt: _nextAttemptAt, lastError: _lastError, ...withoutRetryState } = existing;
    const updated: CallbackDeliveryRecord = {
      ...withoutRetryState,
      status: 'sent',
      deliveredAt: input.deliveredAt,
      updatedAt: input.deliveredAt,
    };
    this.callbacks.set(input.id, updated);
    return updated;
  }

  async markCallbackDeliveryFailed(input: { id: string; failedAt: Date; error: string; terminal: boolean; nextAttemptAt?: Date }): Promise<CallbackDeliveryRecord> {
    const existing = this.requireCallback(input.id);
    const { nextAttemptAt: _nextAttemptAt, ...withoutNextAttempt } = existing;
    const updated: CallbackDeliveryRecord = {
      ...withoutNextAttempt,
      status: input.terminal ? 'failed' : 'pending',
      lastError: input.error,
      updatedAt: input.failedAt,
    };
    if (input.nextAttemptAt) updated.nextAttemptAt = input.nextAttemptAt;
    this.callbacks.set(input.id, updated);
    return updated;
  }

  async requestCallbackReplay(input: { sessionId: string; deliveryId: string; requestedAt: Date }): Promise<CallbackDeliveryRecord | null> {
    const existing = this.callbacks.get(input.deliveryId);
    if (!existing || existing.sessionId !== input.sessionId || existing.status !== 'failed') return null;
    const { deliveredAt: _deliveredAt, nextAttemptAt: _nextAttemptAt, ...withoutTerminalFields } = existing;
    const updated: CallbackDeliveryRecord = {
      ...withoutTerminalFields,
      status: 'pending',
      maxAttempts: Math.max(existing.maxAttempts, existing.attempts + 1),
      updatedAt: input.requestedAt,
      nextAttemptAt: input.requestedAt,
    };
    this.callbacks.set(input.deliveryId, updated);
    return updated;
  }

  async nextEventSequence(sessionId: string): Promise<number> {
    return (this.events.get(sessionId)?.length ?? 0) + 1;
  }

  async appendEvent(
    event: NormalizedEvent & { sequence: number },
  ): Promise<NormalizedEvent & { sequence: number }> {
    const sessionEvents = this.events.get(event.sessionId) ?? [];
    sessionEvents.push(event);
    this.events.set(event.sessionId, sessionEvents);
    return event;
  }

  async getEvents(
    sessionId: string,
    afterSequence = 0,
  ): Promise<Array<NormalizedEvent & { sequence: number }>> {
    return (this.events.get(sessionId) ?? []).filter((event) => event.sequence > afterSequence);
  }

  async createWebhookSource(record: CreateWebhookSourceRecord): Promise<WebhookSourceRecord> {
    this.webhookSources.set(record.key, record);
    return record;
  }

  async getWebhookSource(key: string): Promise<WebhookSourceRecord | null> {
    return this.webhookSources.get(key) ?? null;
  }

  async getExternalThread(source: string, externalId: string): Promise<ExternalThreadRecord | null> {
    return this.externalThreads.get(externalThreadKey(source, externalId)) ?? null;
  }

  async createExternalThread(input: {
    id: string;
    source: string;
    externalId: string;
    sessionId: string;
    metadata: Record<string, unknown>;
    now: Date;
  }): Promise<ExternalThreadRecord> {
    const key = externalThreadKey(input.source, input.externalId);
    const existing = this.externalThreads.get(key);
    if (existing) return existing;

    const record: ExternalThreadRecord = {
      id: input.id,
      source: input.source,
      externalId: input.externalId,
      sessionId: input.sessionId,
      metadata: input.metadata,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.externalThreads.set(key, record);
    return record;
  }

  async createIntegrationDelivery(input: {
    id: string;
    source: string;
    dedupeKey: string;
    receivedAt: Date;
    metadata: Record<string, unknown>;
  }): Promise<IntegrationDeliveryRecord | null> {
    const key = deliveryKey(input.source, input.dedupeKey);
    if (this.integrationDeliveries.has(key)) return null;

    const record: IntegrationDeliveryRecord = {
      id: input.id,
      source: input.source,
      dedupeKey: input.dedupeKey,
      status: 'received',
      receivedAt: input.receivedAt,
      metadata: input.metadata,
    };
    this.integrationDeliveries.set(key, record);
    return record;
  }

  async markIntegrationDeliveryProcessed(input: { source: string; dedupeKey: string; processedAt: Date }): Promise<void> {
    const key = deliveryKey(input.source, input.dedupeKey);
    const existing = this.integrationDeliveries.get(key);
    if (!existing) return;
    this.integrationDeliveries.set(key, { ...existing, status: 'processed', processedAt: input.processedAt });
  }

  async markIntegrationDeliveryFailed(input: { source: string; dedupeKey: string; failedAt: Date; error: string }): Promise<void> {
    const key = deliveryKey(input.source, input.dedupeKey);
    const existing = this.integrationDeliveries.get(key);
    if (!existing) return;
    this.integrationDeliveries.set(key, { ...existing, status: 'failed', processedAt: input.failedAt, error: input.error });
  }

  private hasActiveRun(sessionId: string, now: Date): boolean {
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId) continue;
      if (run.status !== 'running' && run.status !== 'starting' && run.status !== 'cancelling') continue;
      if (run.leaseExpiresAt && run.leaseExpiresAt <= now) continue;
      return true;
    }
    return false;
  }

  private finishRun(runId: string, finishedAt: Date, status: 'completed' | 'failed' | 'cancelled'): ClaimedMessageBatch {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run does not exist: ${runId}`);

    const sessionMessages = this.messages.get(run.sessionId) ?? [];
    const messageIds = getRunMessageIds(run);
    const terminalMessages: MessageRecord[] = [];

    for (const messageId of messageIds) {
      const message = sessionMessages.find((candidate) => candidate.id === messageId);
      if (!message) throw new Error(`Message does not exist: ${messageId}`);
      const terminalMessage: MessageRecord = { ...message, status };
      sessionMessages[sessionMessages.indexOf(message)] = terminalMessage;
      terminalMessages.push(terminalMessage);
    }

    const { leaseExpiresAt: _leaseExpiresAt, leaseOwner: _leaseOwner, ...runWithoutLease } = run;
    const terminalRun: RunRecord = { ...runWithoutLease, status, heartbeatAt: finishedAt };
    if (status === 'completed') terminalRun.completedAt = finishedAt;
    if (status === 'failed' || status === 'cancelled') terminalRun.failedAt = finishedAt;
    this.runs.set(runId, terminalRun);

    const session = this.sessions.get(run.sessionId);
    if (!session) throw new Error(`Session does not exist: ${run.sessionId}`);
    this.sessions.set(run.sessionId, { ...session, status: session.status === 'archived' ? 'archived' : status === 'failed' ? 'failed' : 'idle', updatedAt: finishedAt });

    return { messages: terminalMessages, run: terminalRun };
  }

  private requireCallback(id: string): CallbackDeliveryRecord {
    const existing = this.callbacks.get(id);
    if (!existing) throw new Error(`Callback delivery does not exist: ${id}`);
    return existing;
  }
}

function authAccountKey(provider: string, providerAccountId: string): string {
  return `${provider}:${providerAccountId}`;
}

function isStaleSendingCallback(delivery: CallbackDeliveryRecord, staleSendingBefore: Date): boolean {
  const lastAttemptAt = delivery.lastAttemptAt;
  return delivery.status === 'sending' && lastAttemptAt !== undefined && lastAttemptAt <= staleSendingBefore;
}

function isActiveSandbox(sandbox: SandboxRecord): boolean {
  return !sandbox.destroyedAt && (sandbox.status === 'ready' || sandbox.status === 'stopped' || sandbox.status === 'unhealthy');
}

function getRunMessageIds(run: RunRecord): string[] {
  const messageIds = run.metadata.messageIds;
  if (Array.isArray(messageIds) && messageIds.every((id) => typeof id === 'string')) return messageIds;
  return [run.messageId];
}

function externalThreadKey(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

function deliveryKey(source: string, dedupeKey: string): string {
  return `${source}:${dedupeKey}`;
}
