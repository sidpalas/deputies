import type { NormalizedEvent } from '../events/types.js';

export type SessionStatus =
  | 'created'
  | 'queued'
  | 'active'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'archived';
export type MessageStatus = 'pending' | 'processing' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type RunStatus =
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'stale';
export type IntegrationDeliveryStatus = 'received' | 'processed' | 'failed';
export type SandboxStatus = 'ready' | 'stopped' | 'unhealthy' | 'destroyed' | 'failed';
export type CallbackDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed';
export type AutomationKind = 'scheduled';
export type AutomationInvocationTrigger = 'scheduled' | 'manual';
export type AutomationInvocationStatus = 'creating' | 'created' | 'skipped' | 'failed';

export const defaultGroupId = '00000000-0000-4000-8000-000000000001';

export type AuthRole = 'user' | 'super_admin';
export type GroupRole = 'viewer' | 'member' | 'admin';
export type AutomationCreateRequiredRole = 'member' | 'admin';
export type SessionVisibility = 'group' | 'organization';
export type SessionWritePolicy = 'group_members' | 'creator_only';

export type AuthUserRecord = {
  id: string;
  username: string;
  role: AuthRole;
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

export type GroupRecord = {
  id: string;
  name: string;
  defaultVisibility: SessionVisibility;
  defaultWritePolicy: SessionWritePolicy;
  automationCreateRequiredRole: AutomationCreateRequiredRole;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export class StoreConflictError extends Error {
  constructor(
    readonly code: 'group_name_exists',
    message: string,
  ) {
    super(message);
  }
}

export type GroupMemberRecord = {
  groupId: string;
  userId: string;
  role: GroupRole;
  createdAt: Date;
  updatedAt: Date;
};

export type GroupMemberWithUserRecord = GroupMemberRecord & {
  user: AuthUserRecord;
};

export type UpsertAuthUserForAccountRecord = {
  userId: string;
  accountId: string;
  provider: string;
  providerAccountId: string;
  username: string;
  role: AuthRole;
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
  ownerGroupId: string;
  visibility: SessionVisibility;
  writePolicy: SessionWritePolicy;
  title?: string;
  queuePausedAt?: Date;
  createdByUserId?: string;
  context?: Record<string, unknown>;
};

export type MessageRecord = {
  id: string;
  sessionId: string;
  sequence: number;
  status: MessageStatus;
  prompt: string;
  createdAt: Date;
  authorUserId?: string;
  authorName?: string;
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
  messages: MessageRecord[];
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

export type IntegrationDeliveryLease = IntegrationDeliveryRef & {
  id: string;
};

export type IntegrationDeliveryRef = {
  source: string;
  dedupeKey: string;
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
  keepaliveUntil?: Date;
  destroyedAt?: Date;
};

export type SandboxSecrets = Record<string, string>;

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

export type ExternalResourceRecord = {
  id: string;
  sessionId: string;
  runId?: string;
  messageId?: string;
  type: string;
  title?: string;
  url: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
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

export type AutomationRecord = {
  id: string;
  kind: AutomationKind;
  name: string;
  prompt: string;
  scheduleCron: string;
  enabled: boolean;
  ownerGroupId: string;
  visibility: SessionVisibility;
  writePolicy: SessionWritePolicy;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
  nextInvocationAt?: Date;
  createdByUserId?: string;
  context?: Record<string, unknown>;
  schedulerLockOwner?: string;
  schedulerLockedUntil?: Date;
};

export type AutomationInvocationRecord = {
  id: string;
  automationId: string;
  trigger: AutomationInvocationTrigger;
  status: AutomationInvocationStatus;
  createdAt: Date;
  completedAt?: Date;
  scheduledAt?: Date;
  sessionId?: string;
  messageId?: string;
  reservedSessionId?: string;
  reservedMessageId?: string;
  requestedByUserId?: string;
  reason?: string;
  error?: string;
  metadata: Record<string, unknown>;
};

export type AutomationInvocationCursor = {
  createdAt: Date;
  id: string;
};

export type ListAutomationInvocationsOptions = {
  before?: AutomationInvocationCursor;
  limit?: number;
};

export type CreateSessionRecord = {
  id: string;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  ownerGroupId: string;
  visibility: SessionVisibility;
  writePolicy: SessionWritePolicy;
  title?: string;
  createdByUserId?: string;
  context?: Record<string, unknown>;
};

export type CreateMessageRecord = {
  id: string;
  sessionId: string;
  sequence: number;
  status: MessageStatus;
  prompt: string;
  createdAt: Date;
  authorUserId?: string;
  authorName?: string;
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
  keepaliveUntil?: Date;
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

export type CreateExternalResourceRecord = {
  id: string;
  sessionId: string;
  type: string;
  url: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  runId?: string;
  messageId?: string;
  title?: string;
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

export type CreateAutomationRecord = {
  id: string;
  kind: AutomationKind;
  name: string;
  prompt: string;
  scheduleCron: string;
  enabled: boolean;
  ownerGroupId: string;
  visibility: SessionVisibility;
  writePolicy: SessionWritePolicy;
  createdAt: Date;
  updatedAt: Date;
  nextInvocationAt?: Date;
  createdByUserId?: string;
  context?: Record<string, unknown>;
};

export type CreateAutomationInvocationRecord = {
  id: string;
  automationId: string;
  trigger: AutomationInvocationTrigger;
  status: AutomationInvocationStatus;
  createdAt: Date;
  metadata: Record<string, unknown>;
  completedAt?: Date;
  scheduledAt?: Date;
  sessionId?: string;
  messageId?: string;
  reservedSessionId?: string;
  reservedMessageId?: string;
  requestedByUserId?: string;
  reason?: string;
  error?: string;
};

export type UpdateAutomationRecord = {
  id: string;
  updatedAt: Date;
  name?: string;
  prompt?: string;
  scheduleCron?: string;
  enabled?: boolean;
  ownerGroupId?: string;
  visibility?: SessionVisibility;
  writePolicy?: SessionWritePolicy;
  context?: Record<string, unknown> | null;
  nextInvocationAt?: Date | null;
};

export interface SessionStore {
  createSession(record: CreateSessionRecord): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessions(): Promise<SessionRecord[]>;
  updateSession(record: SessionRecord): Promise<SessionRecord>;
  archiveSession(input: { sessionId: string; archivedAt: Date }): Promise<{
    session: SessionRecord;
    cancelledMessages: MessageRecord[];
  }>;
  updateSessionForRun(input: {
    record: SessionRecord;
    runId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<SessionRecord | null>;
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
  cancelPendingMessage(input: {
    sessionId: string;
    messageId: string;
    cancelledAt: Date;
  }): Promise<MessageRecord | null>;
  requestRunCancellation(input: {
    sessionId: string;
    requestedAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null>;
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
  renewRunLease(input: {
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    heartbeatAt: Date;
  }): Promise<RunRecord | null>;
  getRun(runId: string): Promise<RunRecord | null>;
  recoverStaleRuns(input: { now: Date; limit: number }): Promise<RecoveredRun[]>;
  requestRunCancellation(input: {
    sessionId: string;
    requestedAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null>;
  finalizeRunCancellation(input: {
    runId: string;
    leaseOwner: string;
    cancelledAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null>;
  completeRun(input: { runId: string; leaseOwner: string; completedAt: Date }): Promise<ClaimedMessage | null>;
  failRun(input: { runId: string; leaseOwner: string; failedAt: Date; error: string }): Promise<ClaimedMessage | null>;
  completeRunBatch(input: {
    runId: string;
    leaseOwner: string;
    completedAt: Date;
  }): Promise<ClaimedMessageBatch | null>;
  failRunBatch(input: {
    runId: string;
    leaseOwner: string;
    failedAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null>;
}

export interface SandboxStore {
  getActiveSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null>;
  getLatestSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null>;
  listActiveSandboxes(sessionId: string, provider: string): Promise<SandboxRecord[]>;
  listIdleSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]>;
  listStoppableSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]>;
  createSandbox(record: CreateSandboxRecord): Promise<SandboxRecord>;
  createSandboxWithSecrets(record: CreateSandboxRecord, secrets: SandboxSecrets): Promise<SandboxRecord>;
  updateSandbox(record: SandboxRecord): Promise<SandboxRecord>;
  getSandboxSecrets(sandboxId: string): Promise<SandboxSecrets>;
  setSandboxSecrets(sandboxId: string, secrets: SandboxSecrets): Promise<void>;
}

export interface CallbackStore {
  createCallbackDelivery(record: CreateCallbackDeliveryRecord): Promise<CallbackDeliveryRecord>;
  listCallbackDeliveries(input: { sessionId: string; messageId?: string }): Promise<CallbackDeliveryRecord[]>;
  claimDueCallbackDeliveries(input: { now: Date; limit: number }): Promise<CallbackDeliveryRecord[]>;
  markCallbackDeliverySent(input: { id: string; deliveredAt: Date }): Promise<CallbackDeliveryRecord>;
  markCallbackDeliveryFailed(input: {
    id: string;
    failedAt: Date;
    error: string;
    terminal: boolean;
    nextAttemptAt?: Date;
  }): Promise<CallbackDeliveryRecord>;
  requestCallbackReplay(input: {
    sessionId: string;
    deliveryId: string;
    requestedAt: Date;
  }): Promise<CallbackDeliveryRecord | null>;
}

export interface AutomationStore {
  createAutomation(record: CreateAutomationRecord): Promise<AutomationRecord>;
  getAutomation(id: string): Promise<AutomationRecord | null>;
  listAutomations(): Promise<AutomationRecord[]>;
  updateAutomation(input: UpdateAutomationRecord): Promise<AutomationRecord>;
  archiveAutomation(input: { automationId: string; archivedAt: Date }): Promise<AutomationRecord | null>;
  unarchiveAutomation(input: { automationId: string; updatedAt: Date }): Promise<AutomationRecord | null>;
  claimAutomation(input: {
    automationId: string;
    now: Date;
    lockOwner: string;
    lockedUntil: Date;
  }): Promise<AutomationRecord | null>;
  releaseAutomationClaim(input: { automationId: string; lockOwner: string }): Promise<AutomationRecord | null>;
  claimNextDueScheduledAutomation(input: {
    now: Date;
    lockOwner: string;
    lockedUntil: Date;
  }): Promise<AutomationRecord | null>;
  completeScheduledAutomationClaim(input: {
    automationId: string;
    lockOwner: string;
    claimedScheduleCron: string;
    nextInvocationAt: Date;
  }): Promise<AutomationRecord | null>;
  createAutomationInvocation(record: CreateAutomationInvocationRecord): Promise<AutomationInvocationRecord>;
  updateAutomationInvocation(record: AutomationInvocationRecord): Promise<AutomationInvocationRecord>;
  getAutomationInvocationBySchedule(input: {
    automationId: string;
    scheduledAt: Date;
  }): Promise<AutomationInvocationRecord | null>;
  getBlockingAutomationSession(automationId: string): Promise<SessionRecord | null>;
  listAutomationInvocations(
    automationId: string,
    options?: ListAutomationInvocationsOptions,
  ): Promise<AutomationInvocationRecord[]>;
}

export interface EventStore {
  nextEventSequence(sessionId: string): Promise<number>;
  appendEvent(event: NormalizedEvent & { sequence: number }): Promise<EventRecord>;
  appendEventWithNextSequence(event: NormalizedEvent): Promise<EventRecord>;
  appendEventWithNextSequenceForRun(
    event: Omit<NormalizedEvent, 'runId'> & { runId: string },
    guard: { runId: string; leaseOwner: string; now: Date },
  ): Promise<EventRecord | null>;
  getEvents(sessionId: string, afterSequence?: number): Promise<EventRecord[]>;
  listEvents(afterId?: number): Promise<EventRecord[]>;
}

export type EventRecord = NormalizedEvent & { id: number; sequence: number };

export interface AppStore
  extends SessionStore, MessageStore, RunStore, SandboxStore, CallbackStore, AutomationStore, EventStore {
  upsertAuthUserForAccount(record: UpsertAuthUserForAccountRecord): Promise<AuthUserRecord>;
  createAuthSession(record: AuthSessionRecord): Promise<AuthSessionRecord>;
  getAuthUserBySession(input: { sessionId: string; now: Date }): Promise<AuthUserRecord | null>;
  deleteAuthSession(sessionId: string): Promise<void>;
  listAuthUsers(input?: { query?: string }): Promise<AuthUserRecord[]>;
  updateAuthUserRole(input: { userId: string; role: AuthRole; updatedAt: Date }): Promise<AuthUserRecord | null>;

  createGroup(record: GroupRecord): Promise<GroupRecord>;
  getGroup(id: string): Promise<GroupRecord | null>;
  listGroups(): Promise<GroupRecord[]>;
  updateGroup(record: GroupRecord): Promise<GroupRecord>;
  upsertGroupMember(record: GroupMemberRecord): Promise<GroupMemberRecord>;
  deleteGroupMember(input: { groupId: string; userId: string }): Promise<void>;
  getGroupMember(input: { groupId: string; userId: string }): Promise<GroupMemberRecord | null>;
  listGroupMembers(groupId: string): Promise<GroupMemberWithUserRecord[]>;
  listUserGroupMemberships(userId: string): Promise<GroupMemberRecord[]>;

  createArtifact(record: CreateArtifactRecord): Promise<ArtifactRecord>;
  getArtifacts(sessionId: string): Promise<ArtifactRecord[]>;

  createExternalResource(record: CreateExternalResourceRecord): Promise<ExternalResourceRecord>;
  getExternalResources(sessionId: string): Promise<ExternalResourceRecord[]>;

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
  /** Returns null when the delivery is processed or currently being handled by another attempt. */
  createIntegrationDelivery(input: {
    id: string;
    source: string;
    dedupeKey: string;
    receivedAt: Date;
    staleReceivedBefore: Date;
    metadata: Record<string, unknown>;
  }): Promise<IntegrationDeliveryRecord | null>;
  markIntegrationDeliveryProcessed(input: IntegrationDeliveryLease & { processedAt: Date }): Promise<boolean>;
  markIntegrationDeliveryFailed(input: {
    id: string;
    source: string;
    dedupeKey: string;
    failedAt: Date;
    error: string;
  }): Promise<boolean>;
}
