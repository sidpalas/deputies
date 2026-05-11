import type { NormalizedEvent } from '../events/types.js';

export type SessionStatus = 'created' | 'queued' | 'active' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'archived';
export type MessageStatus = 'pending' | 'processing' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'stale';
export type IntegrationDeliveryStatus = 'received' | 'processed' | 'failed';
export type SandboxStatus = 'ready' | 'stopped' | 'unhealthy' | 'destroyed' | 'failed';
export type CallbackDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed';

export type AuthUserRecord = {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AuthAccountRecord = {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  username: string;
  profile: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type AuthSessionRecord = {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
};

export type UpsertAuthUserForAccountRecord = {
  userId: string;
  accountId: string;
  provider: string;
  providerAccountId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  profile: Record<string, unknown>;
  now: Date;
};

export type SessionRecord = {
  id: string;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  title?: string;
  queuePausedAt?: Date;
  context?: Record<string, unknown>;
};

export type MessageRecord = {
  id: string;
  sessionId: string;
  sequence: number;
  status: MessageStatus;
  prompt: string;
  createdAt: Date;
  source?: string;
  context?: Record<string, unknown>;
};

export type RunRecord = {
  id: string;
  sessionId: string;
  messageId: string;
  status: RunStatus;
  runnerType: string;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  heartbeatAt?: Date;
  attempt: number;
  startedAt: Date;
  completedAt?: Date;
  failedAt?: Date;
  error?: string;
  metadata: Record<string, unknown>;
};

export type ClaimedMessage = {
  message: MessageRecord;
  run: RunRecord;
};

export type ClaimedMessageBatch = {
  messages: MessageRecord[];
  run: RunRecord;
};

export type RecoveredRun = {
  message: MessageRecord;
  run: RunRecord;
};

export type WebhookSourceRecord = {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  bearerToken: string;
  promptPrefix?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ExternalThreadRecord = {
  id: string;
  source: string;
  externalId: string;
  sessionId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type IntegrationDeliveryRecord = {
  id: string;
  source: string;
  dedupeKey: string;
  status: IntegrationDeliveryStatus;
  receivedAt: Date;
  processedAt?: Date;
  error?: string;
  metadata: Record<string, unknown>;
};

export type SandboxRecord = {
  id: string;
  sessionId: string;
  provider: string;
  providerSandboxId: string;
  status: SandboxStatus;
  workspacePath: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  lastHealthCheckAt?: Date;
  destroyedAt?: Date;
};

export type ArtifactRecord = {
  id: string;
  sessionId: string;
  runId?: string;
  messageId?: string;
  type: string;
  createdAt: Date;
  title?: string;
  url?: string;
  storageKey?: string;
  payload: Record<string, unknown>;
};

export type CallbackDeliveryRecord = {
  id: string;
  sessionId: string;
  targetType: 'http' | 'slack' | 'github';
  target: Record<string, unknown>;
  status: CallbackDeliveryStatus;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  runId?: string;
  messageId?: string;
  lastError?: string;
  nextAttemptAt?: Date;
  lastAttemptAt?: Date;
  deliveredAt?: Date;
};

export type CreateSessionRecord = {
  id: string;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  title?: string;
  context?: Record<string, unknown>;
};

export type CreateMessageRecord = {
  id: string;
  sessionId: string;
  sequence: number;
  status: MessageStatus;
  prompt: string;
  createdAt: Date;
  source?: string;
  context?: Record<string, unknown>;
};

export type CreateWebhookSourceRecord = {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  bearerToken: string;
  promptPrefix?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSandboxRecord = {
  id: string;
  sessionId: string;
  provider: string;
  providerSandboxId: string;
  status: SandboxStatus;
  workspacePath: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateArtifactRecord = {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  runId?: string;
  messageId?: string;
  title?: string;
  url?: string;
  storageKey?: string;
};

export type CreateCallbackDeliveryRecord = {
  id: string;
  sessionId: string;
  targetType: 'http' | 'slack' | 'github';
  target: Record<string, unknown>;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  nextAttemptAt: Date;
  maxAttempts?: number;
  runId?: string;
  messageId?: string;
};

export interface SessionStore {
  createSession(record: CreateSessionRecord): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessions(): Promise<SessionRecord[]>;
  updateSession(record: SessionRecord): Promise<SessionRecord>;
  pauseSessionQueue(input: { sessionId: string; pausedAt: Date }): Promise<SessionRecord>;
  resumeSessionQueue(input: { sessionId: string }): Promise<SessionRecord>;
}

export interface MessageStore {
  getSession(id: string): Promise<SessionRecord | null>;
  updateSession(record: SessionRecord): Promise<SessionRecord>;
  nextMessageSequence(sessionId: string): Promise<number>;
  createMessage(record: CreateMessageRecord): Promise<MessageRecord>;
  getMessages(sessionId: string): Promise<MessageRecord[]>;
  updatePendingMessage(input: { sessionId: string; messageId: string; prompt: string }): Promise<MessageRecord | null>;
  cancelPendingMessage(input: { sessionId: string; messageId: string; cancelledAt: Date }): Promise<MessageRecord | null>;
  requestRunCancellation(input: { sessionId: string; requestedAt: Date; error: string }): Promise<ClaimedMessageBatch | null>;
}

export interface RunStore {
  claimNextPendingMessage(input: {
    runId: string;
    runnerType: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessage | null>;
  claimNextPendingMessageBatch(input: {
    runId: string;
    runnerType: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessageBatch | null>;
  renewRunLease(input: { runId: string; leaseOwner: string; leaseExpiresAt: Date; heartbeatAt: Date }): Promise<RunRecord | null>;
  getRun(runId: string): Promise<RunRecord | null>;
  recoverStaleRuns(input: { now: Date; limit: number }): Promise<RecoveredRun[]>;
  requestRunCancellation(input: { sessionId: string; requestedAt: Date; error: string }): Promise<ClaimedMessageBatch | null>;
  finalizeRunCancellation(input: { runId: string; cancelledAt: Date; error: string }): Promise<ClaimedMessageBatch>;
  completeRun(input: { runId: string; completedAt: Date }): Promise<ClaimedMessage>;
  failRun(input: { runId: string; failedAt: Date; error: string }): Promise<ClaimedMessage>;
  completeRunBatch(input: { runId: string; completedAt: Date }): Promise<ClaimedMessageBatch>;
  failRunBatch(input: { runId: string; failedAt: Date; error: string }): Promise<ClaimedMessageBatch>;
}

export interface SandboxStore {
  getActiveSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null>;
  listActiveSandboxes(sessionId: string, provider: string): Promise<SandboxRecord[]>;
  listIdleSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]>;
  listStoppableSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]>;
  createSandbox(record: CreateSandboxRecord): Promise<SandboxRecord>;
  updateSandbox(record: SandboxRecord): Promise<SandboxRecord>;
}

export interface CallbackStore {
  createCallbackDelivery(record: CreateCallbackDeliveryRecord): Promise<CallbackDeliveryRecord>;
  listCallbackDeliveries(input: { sessionId: string; messageId?: string }): Promise<CallbackDeliveryRecord[]>;
  claimDueCallbackDeliveries(input: { now: Date; limit: number }): Promise<CallbackDeliveryRecord[]>;
  markCallbackDeliverySent(input: { id: string; deliveredAt: Date }): Promise<CallbackDeliveryRecord>;
  markCallbackDeliveryFailed(input: { id: string; failedAt: Date; error: string; terminal: boolean; nextAttemptAt?: Date }): Promise<CallbackDeliveryRecord>;
  requestCallbackReplay(input: { sessionId: string; deliveryId: string; requestedAt: Date }): Promise<CallbackDeliveryRecord | null>;
}

export interface EventStore {
  nextEventSequence(sessionId: string): Promise<number>;
  appendEvent(event: NormalizedEvent & { sequence: number }): Promise<EventRecord>;
  appendEventWithNextSequence(event: NormalizedEvent): Promise<EventRecord>;
  getEvents(sessionId: string, afterSequence?: number): Promise<EventRecord[]>;
  listEvents(afterId?: number): Promise<EventRecord[]>;
}

export type EventRecord = NormalizedEvent & { id: number; sequence: number };

export interface AppStore extends SessionStore, MessageStore, RunStore, SandboxStore, CallbackStore, EventStore {
  upsertAuthUserForAccount(record: UpsertAuthUserForAccountRecord): Promise<AuthUserRecord>;
  createAuthSession(record: AuthSessionRecord): Promise<AuthSessionRecord>;
  getAuthUserBySession(input: { sessionId: string; now: Date }): Promise<AuthUserRecord | null>;
  deleteAuthSession(sessionId: string): Promise<void>;

  createArtifact(record: CreateArtifactRecord): Promise<ArtifactRecord>;
  getArtifacts(sessionId: string): Promise<ArtifactRecord[]>;

  createWebhookSource(record: CreateWebhookSourceRecord): Promise<WebhookSourceRecord>;
  getWebhookSource(key: string): Promise<WebhookSourceRecord | null>;
  withExternalThreadLock?<T>(source: string, externalId: string, fn: () => Promise<T>): Promise<T>;
  getExternalThread(source: string, externalId: string): Promise<ExternalThreadRecord | null>;
  createExternalThread(input: {
    id: string;
    source: string;
    externalId: string;
    sessionId: string;
    metadata: Record<string, unknown>;
    now: Date;
  }): Promise<ExternalThreadRecord>;
  createIntegrationDelivery(input: {
    id: string;
    source: string;
    dedupeKey: string;
    receivedAt: Date;
    metadata: Record<string, unknown>;
  }): Promise<IntegrationDeliveryRecord | null>;
  markIntegrationDeliveryProcessed(input: { source: string; dedupeKey: string; processedAt: Date }): Promise<void>;
  markIntegrationDeliveryFailed(input: { source: string; dedupeKey: string; failedAt: Date; error: string }): Promise<void>;
}
