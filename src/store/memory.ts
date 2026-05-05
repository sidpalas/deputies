import type { NormalizedEvent } from '../events/types.js';
import type {
  AppStore,
  ArtifactRecord,
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
  MessageRecord,
  RecoveredRun,
  RunRecord,
  SandboxRecord,
  SessionRecord,
  WebhookSourceRecord,
} from './types.js';

export class MemoryStore implements AppStore {
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

  async claimNextPendingMessage(input: {
    runId: string;
    runnerType: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessage | null> {
    for (const [sessionId, sessionMessages] of this.messages) {
      if (this.hasActiveRun(sessionId, input.now)) continue;

      const message = sessionMessages.find((candidate) => candidate.status === 'pending');
      if (!message) continue;

      const processingMessage: MessageRecord = { ...message, status: 'processing' };
      sessionMessages[sessionMessages.indexOf(message)] = processingMessage;

      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session does not exist: ${sessionId}`);
      this.sessions.set(sessionId, { ...session, status: 'active', updatedAt: input.now });

      const run: RunRecord = {
        id: input.runId,
        sessionId,
        messageId: processingMessage.id,
        status: 'running',
        runnerType: input.runnerType,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        heartbeatAt: input.now,
        attempt: 1,
        startedAt: input.now,
        metadata: {},
      };
      this.runs.set(run.id, run);
      return { message: processingMessage, run };
    }

    return null;
  }

  async completeRun(input: { runId: string; completedAt: Date }): Promise<ClaimedMessage> {
    return this.finishRun(input.runId, input.completedAt, 'completed');
  }

  async renewRunLease(input: {
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    heartbeatAt: Date;
  }): Promise<RunRecord | null> {
    const run = this.runs.get(input.runId);
    if (!run || run.status !== 'running' || run.leaseOwner !== input.leaseOwner) return null;

    const renewed: RunRecord = {
      ...run,
      leaseExpiresAt: input.leaseExpiresAt,
      heartbeatAt: input.heartbeatAt,
    };
    this.runs.set(input.runId, renewed);
    return renewed;
  }

  async recoverStaleRuns(input: { now: Date; limit: number }): Promise<RecoveredRun[]> {
    const recovered: RecoveredRun[] = [];

    for (const run of this.runs.values()) {
      if (recovered.length >= input.limit) break;
      if (run.status !== 'running' && run.status !== 'starting') continue;
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
    const claimed = await this.finishRun(input.runId, input.failedAt, 'failed');
    this.runs.set(input.runId, { ...claimed.run, error: input.error });
    return { ...claimed, run: this.runs.get(input.runId)! };
  }

  async getActiveSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null> {
    const candidates = Array.from(this.sandboxes.values())
      .filter((sandbox) => sandbox.sessionId === sessionId && sandbox.provider === provider)
      .filter((sandbox) => !sandbox.destroyedAt && (sandbox.status === 'ready' || sandbox.status === 'unhealthy'))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return candidates[0] ?? null;
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
    const delivery: CallbackDeliveryRecord = { ...record, status: 'pending', attempts: 0 };
    this.callbacks.set(delivery.id, delivery);
    return delivery;
  }

  async markCallbackDeliverySent(input: { id: string; deliveredAt: Date }): Promise<CallbackDeliveryRecord> {
    const existing = this.requireCallback(input.id);
    const updated: CallbackDeliveryRecord = {
      ...existing,
      status: 'sent',
      attempts: existing.attempts + 1,
      deliveredAt: input.deliveredAt,
      updatedAt: input.deliveredAt,
    };
    this.callbacks.set(input.id, updated);
    return updated;
  }

  async markCallbackDeliveryFailed(input: { id: string; failedAt: Date; error: string }): Promise<CallbackDeliveryRecord> {
    const existing = this.requireCallback(input.id);
    const updated: CallbackDeliveryRecord = {
      ...existing,
      status: 'failed',
      attempts: existing.attempts + 1,
      lastError: input.error,
      updatedAt: input.failedAt,
    };
    this.callbacks.set(input.id, updated);
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

  private hasActiveRun(sessionId: string, now: Date): boolean {
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId) continue;
      if (run.status !== 'running' && run.status !== 'starting') continue;
      if (run.leaseExpiresAt && run.leaseExpiresAt <= now) continue;
      return true;
    }
    return false;
  }

  private finishRun(runId: string, finishedAt: Date, status: 'completed' | 'failed'): ClaimedMessage {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run does not exist: ${runId}`);

    const sessionMessages = this.messages.get(run.sessionId) ?? [];
    const message = sessionMessages.find((candidate) => candidate.id === run.messageId);
    if (!message) throw new Error(`Message does not exist: ${run.messageId}`);

    const terminalMessage: MessageRecord = { ...message, status };
    sessionMessages[sessionMessages.indexOf(message)] = terminalMessage;

    const { leaseExpiresAt: _leaseExpiresAt, leaseOwner: _leaseOwner, ...runWithoutLease } = run;
    const terminalRun: RunRecord = { ...runWithoutLease, status, heartbeatAt: finishedAt };
    if (status === 'completed') terminalRun.completedAt = finishedAt;
    if (status === 'failed') terminalRun.failedAt = finishedAt;
    this.runs.set(runId, terminalRun);

    const session = this.sessions.get(run.sessionId);
    if (!session) throw new Error(`Session does not exist: ${run.sessionId}`);
    this.sessions.set(run.sessionId, { ...session, status: status === 'completed' ? 'idle' : 'failed', updatedAt: finishedAt });

    return { message: terminalMessage, run: terminalRun };
  }

  private requireCallback(id: string): CallbackDeliveryRecord {
    const existing = this.callbacks.get(id);
    if (!existing) throw new Error(`Callback delivery does not exist: ${id}`);
    return existing;
  }
}

function externalThreadKey(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

function deliveryKey(source: string, dedupeKey: string): string {
  return `${source}:${dedupeKey}`;
}
