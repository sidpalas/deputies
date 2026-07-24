import type { QueryResultRow } from 'pg';
import type { NormalizedEventPayload, NormalizedEventType } from '../../events/types.js';
import type {
  ArtifactRecord,
  AutomationInvocationRecord,
  AutomationInvocationStatus,
  AuditActorType,
  AutomationInvocationTrigger,
  AutomationKind,
  AutomationRecord,
  AuthSessionRecord,
  AuthUserRecord,
  CallbackDeliveryRecord,
  CallbackDeliveryStatus,
  EnvironmentRecord,
  EnvironmentActivityRecord,
  EnvironmentRepositoryRecord,
  EnvironmentRevisionRecord,
  EnvironmentRevisionPolicy,
  EnvironmentRevisionRepository,
  EnvironmentActivityType,
  EventRecord,
  ExternalResourceRecord,
  ExternalThreadRecord,
  IntegrationDeliveryRecord,
  MessageRecord,
  MessageStatus,
  RunRecord,
  RunStatus,
  SandboxRecord,
  SandboxStatus,
  SessionRecord,
  SessionStatus,
  SessionWithSandboxRecord,
  WebhookSourceRecord,
} from '../types.js';

export type PgInteger = number | string;

export type SessionRow = QueryResultRow & {
  id: string;
  visibility: 'tenant' | 'private';
  owner_user_id: string | null;
  status: SessionStatus;
  title: string | null;
  context: Record<string, unknown> | null;
  parent_session_id: string | null;
  spawn_depth: PgInteger;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
  tags: string[];
  queue_paused_at: Date | null;
};

export const sessionSelectColumns =
  'id, visibility, owner_user_id, status, title, context, parent_session_id, spawn_depth, created_by_user_id, created_at, updated_at, last_activity_at, tags, queue_paused_at';

export type AuthUserRow = QueryResultRow & {
  id: string;
  username: string;
  role: AuthUserRecord['role'];
  display_name: string | null;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AuthSessionRow = QueryResultRow & {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
};

export type MessageRow = QueryResultRow & {
  id: string;
  session_id: string;
  sequence: PgInteger;
  status: MessageStatus;
  prompt: string;
  steering: boolean;
  author_user_id: string | null;
  author_name: string | null;
  source: string | null;
  context: Record<string, unknown> | null;
  created_at: Date;
};

export type EventRow = QueryResultRow & {
  id: PgInteger;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  sequence: PgInteger;
  type: NormalizedEventType;
  payload: Record<string, unknown>;
  created_at: Date;
};

export type RunRow = QueryResultRow & {
  id: string;
  session_id: string;
  message_id: string;
  status: RunStatus;
  runner_type: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  attempt: number;
  started_at: Date;
  completed_at: Date | null;
  failed_at: Date | null;
  error: string | null;
  metadata: Record<string, unknown>;
};

export type SandboxRow = QueryResultRow & {
  id: string;
  session_id: string;
  provider: string;
  provider_sandbox_id: string;
  status: SandboxStatus;
  workspace_path: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  last_health_check_at: Date | null;
  keepalive_until: Date | null;
  destroyed_at: Date | null;
};

export type SessionWithSandboxRow = SessionRow & {
  direct_child_count?: string | number;
  sandbox_id: string | null;
  sandbox_provider: string | null;
  sandbox_provider_sandbox_id: string | null;
  sandbox_status: SandboxStatus | null;
  sandbox_workspace_path: string | null;
  sandbox_metadata: Record<string, unknown> | null;
  sandbox_created_at: Date | null;
  sandbox_updated_at: Date | null;
  sandbox_last_health_check_at: Date | null;
  sandbox_keepalive_until: Date | null;
  sandbox_destroyed_at: Date | null;
};

export type ArtifactRow = QueryResultRow & {
  id: string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  type: string;
  title: string | null;
  url: string | null;
  storage_key: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
};

export type ExternalResourceRow = QueryResultRow & {
  id: string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  type: string;
  title: string | null;
  url: string;
  metadata: Record<string, unknown>;
  created_at: Date;
};

export type CallbackDeliveryRow = QueryResultRow & {
  id: string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  target_type: 'http' | 'slack' | 'github';
  target: Record<string, unknown>;
  status: CallbackDeliveryStatus;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  delivered_at: Date | null;
};

export type AutomationRow = QueryResultRow & {
  id: string;
  kind: AutomationKind;
  name: string;
  prompt: string;
  schedule_cron: string;
  enabled: boolean;
  context: Record<string, unknown> | null;
  created_by_user_id: string | null;
  archived_at: Date | null;
  environment_id: string | null;
  environment_revision_policy: EnvironmentRevisionPolicy | null;
  environment_revision_id: string | null;
  next_invocation_at: Date | null;
  scheduler_lock_owner: string | null;
  scheduler_locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
};

export const automationSelectColumns =
  'id, kind, name, prompt, schedule_cron, enabled, context, created_by_user_id, archived_at, environment_id, environment_revision_policy, environment_revision_id, next_invocation_at, scheduler_lock_owner, scheduler_locked_until, created_at, updated_at';

export type EnvironmentRow = QueryResultRow & {
  id: string;
  name: string;
  current_revision_id: string;
  current_revision_number: PgInteger;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export const environmentSelectColumns =
  'id, name, current_revision_id, current_revision_number, archived_at, created_at, updated_at';

export type EnvironmentRevisionRow = QueryResultRow & {
  id: string;
  environment_id: string;
  revision_number: PgInteger;
  actor_type: AuditActorType;
  actor_user_id: string | null;
  created_at: Date;
};

export const environmentRevisionSelectColumns =
  'id, environment_id, revision_number, actor_type, actor_user_id, created_at';

export type EnvironmentActivityRow = QueryResultRow & {
  id: string;
  environment_id: string;
  type: EnvironmentActivityType;
  actor_type: AuditActorType;
  actor_user_id: string | null;
  revision_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
};

export const environmentActivitySelectColumns =
  'id, environment_id, type, actor_type, actor_user_id, revision_id, payload, created_at';

export type EnvironmentRepositoryRow = QueryResultRow & {
  id: string;
  revision_id: string;
  provider: EnvironmentRepositoryRecord['provider'];
  owner: string;
  repo: string;
  branch: string | null;
  is_primary: boolean;
  position: PgInteger;
  created_at: Date;
  updated_at: Date;
};

export const environmentRepositorySelectColumns =
  'id, revision_id, provider, owner, repo, branch, is_primary, position, created_at, updated_at';

export type AutomationInvocationRow = QueryResultRow & {
  id: string;
  automation_id: string;
  trigger: AutomationInvocationTrigger;
  status: AutomationInvocationStatus;
  scheduled_at: Date | null;
  session_id: string | null;
  message_id: string | null;
  reserved_session_id: string | null;
  reserved_message_id: string | null;
  requested_by_user_id: string | null;
  environment_id: string | null;
  environment_revision_id: string | null;
  reason: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  completed_at: Date | null;
};

export const automationInvocationSelectColumns =
  'id, automation_id, trigger, status, scheduled_at, session_id, message_id, reserved_session_id, reserved_message_id, requested_by_user_id, environment_id, environment_revision_id, reason, error, metadata, created_at, completed_at';

export type WebhookSourceRow = QueryResultRow & {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  bearer_token: string;
  prompt_prefix: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ExternalThreadRow = QueryResultRow & {
  id: string;
  source: string;
  external_id: string;
  session_id: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export type IntegrationDeliveryRow = QueryResultRow & {
  id: string;
  source: string;
  dedupe_key: string;
  status: 'received' | 'processed' | 'failed';
  received_at: Date;
  processed_at: Date | null;
  error: string | null;
  metadata: Record<string, unknown>;
};

export function toAuthUser(row: AuthUserRow): AuthUserRecord {
  const user: AuthUserRecord = {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.display_name) user.displayName = row.display_name;
  if (row.avatar_url) user.avatarUrl = row.avatar_url;
  return user;
}

export function toAuthSession(row: AuthSessionRow): AuthSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function toSession(row: SessionRow): SessionRecord {
  const record: SessionRecord = {
    id: row.id,
    visibility: row.visibility,
    status: row.status,
    spawnDepth: Number(row.spawn_depth ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at ?? row.updated_at,
    tags: row.tags ?? [],
  };
  if (row.owner_user_id) record.ownerUserId = row.owner_user_id;
  if (row.parent_session_id) record.parentSessionId = row.parent_session_id;
  if (row.title) record.title = row.title;
  if (row.queue_paused_at) record.queuePausedAt = row.queue_paused_at;
  if (row.created_by_user_id) record.createdByUserId = row.created_by_user_id;
  if (row.context) record.context = row.context;
  return record;
}

export function getRunMessageIds(run: RunRecord): string[] {
  const messageIds = run.metadata.messageIds;
  if (Array.isArray(messageIds) && messageIds.every((id) => typeof id === 'string')) return messageIds;
  return [run.messageId];
}

export function toMessage(row: MessageRow): MessageRecord {
  const record: MessageRecord = {
    id: row.id,
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    status: row.status,
    prompt: row.prompt,
    steering: row.steering,
    createdAt: row.created_at,
  };
  if (row.author_user_id) record.authorUserId = row.author_user_id;
  if (row.source) record.source = row.source;
  if (row.author_name) record.authorName = row.author_name;
  if (row.context) record.context = row.context;
  return record;
}

export function toEvent(row: EventRow): EventRecord {
  const event = {
    id: Number(row.id),
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    type: row.type,
    payload: row.payload as NormalizedEventPayload,
    createdAt: row.created_at,
  } as EventRecord;
  if (row.run_id) event.runId = row.run_id;
  if (row.message_id) event.messageId = row.message_id;
  return event;
}

export function toRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    status: row.status,
    runnerType: row.runner_type,
    attempt: row.attempt,
    startedAt: row.started_at,
    metadata: row.metadata,
  };
  if (row.lease_owner) run.leaseOwner = row.lease_owner;
  if (row.lease_expires_at) run.leaseExpiresAt = row.lease_expires_at;
  if (row.heartbeat_at) run.heartbeatAt = row.heartbeat_at;
  if (row.completed_at) run.completedAt = row.completed_at;
  if (row.failed_at) run.failedAt = row.failed_at;
  if (row.error) run.error = row.error;
  return run;
}

export function toSandbox(row: SandboxRow): SandboxRecord {
  const record: SandboxRecord = {
    id: row.id,
    sessionId: row.session_id,
    provider: row.provider,
    providerSandboxId: row.provider_sandbox_id,
    status: row.status,
    workspacePath: row.workspace_path,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.last_health_check_at) record.lastHealthCheckAt = row.last_health_check_at;
  if (row.keepalive_until) record.keepaliveUntil = row.keepalive_until;
  if (row.destroyed_at) record.destroyedAt = row.destroyed_at;
  return record;
}

export function toSessionWithSandbox(row: SessionWithSandboxRow): SessionWithSandboxRecord {
  const record: SessionWithSandboxRecord = {
    session: toSession(row),
    sandbox: row.sandbox_id
      ? toSandbox({
          id: row.sandbox_id,
          session_id: row.id,
          provider: row.sandbox_provider!,
          provider_sandbox_id: row.sandbox_provider_sandbox_id!,
          status: row.sandbox_status!,
          workspace_path: row.sandbox_workspace_path!,
          metadata: row.sandbox_metadata!,
          created_at: row.sandbox_created_at!,
          updated_at: row.sandbox_updated_at!,
          last_health_check_at: row.sandbox_last_health_check_at,
          keepalive_until: row.sandbox_keepalive_until,
          destroyed_at: row.sandbox_destroyed_at,
        })
      : null,
  };
  if (row.direct_child_count !== undefined) record.directChildCount = Number(row.direct_child_count);
  return record;
}

export function toArtifact(row: ArtifactRow): ArtifactRecord {
  const record: ArtifactRecord = {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  };
  if (row.run_id) record.runId = row.run_id;
  if (row.message_id) record.messageId = row.message_id;
  if (row.title) record.title = row.title;
  if (row.url) record.url = row.url;
  if (row.storage_key) record.storageKey = row.storage_key;
  return record;
}

export function toExternalResource(row: ExternalResourceRow): ExternalResourceRecord {
  const record: ExternalResourceRecord = {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    url: row.url,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
  if (row.run_id) record.runId = row.run_id;
  if (row.message_id) record.messageId = row.message_id;
  if (row.title) record.title = row.title;
  return record;
}

export function toCallbackDelivery(row: CallbackDeliveryRow): CallbackDeliveryRecord {
  const record: CallbackDeliveryRecord = {
    id: row.id,
    sessionId: row.session_id,
    targetType: row.target_type,
    target: row.target,
    status: row.status,
    eventType: row.event_type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.run_id) record.runId = row.run_id;
  if (row.message_id) record.messageId = row.message_id;
  if (row.last_error) record.lastError = row.last_error;
  if (row.next_attempt_at) record.nextAttemptAt = row.next_attempt_at;
  if (row.last_attempt_at) record.lastAttemptAt = row.last_attempt_at;
  if (row.delivered_at) record.deliveredAt = row.delivered_at;
  return record;
}

export function toAutomation(row: AutomationRow): AutomationRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    prompt: row.prompt,
    scheduleCron: row.schedule_cron,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    ...(row.environment_id ? { environmentId: row.environment_id } : {}),
    ...(row.environment_revision_policy ? { environmentRevisionPolicy: row.environment_revision_policy } : {}),
    ...(row.environment_revision_id ? { environmentRevisionId: row.environment_revision_id } : {}),
    ...(row.next_invocation_at ? { nextInvocationAt: row.next_invocation_at } : {}),
    ...(row.created_by_user_id ? { createdByUserId: row.created_by_user_id } : {}),
    ...(row.context ? { context: row.context } : {}),
    ...(row.scheduler_lock_owner ? { schedulerLockOwner: row.scheduler_lock_owner } : {}),
    ...(row.scheduler_locked_until ? { schedulerLockedUntil: row.scheduler_locked_until } : {}),
  };
}

export function toEnvironment(row: EnvironmentRow): EnvironmentRecord {
  return {
    id: row.id,
    name: row.name,
    currentRevisionId: row.current_revision_id,
    currentRevisionNumber: Number(row.current_revision_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}

export function toEnvironmentRepository(row: EnvironmentRepositoryRow): EnvironmentRepositoryRecord {
  return {
    id: row.id,
    revisionId: row.revision_id,
    provider: row.provider,
    owner: row.owner,
    repo: row.repo,
    isPrimary: row.is_primary,
    position: Number(row.position),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.branch ? { branch: row.branch } : {}),
  };
}

export function toEnvironmentRevision(
  row: EnvironmentRevisionRow,
  repositories: EnvironmentRevisionRepository[],
): EnvironmentRevisionRecord {
  return {
    id: row.id,
    environmentId: row.environment_id,
    revisionNumber: Number(row.revision_number),
    repositories: repositories.map((repository) => ({ ...repository })),
    actorType: row.actor_type,
    createdAt: row.created_at,
    ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}),
  };
}

export function toEnvironmentActivity(row: EnvironmentActivityRow): EnvironmentActivityRecord {
  return {
    id: row.id,
    environmentId: row.environment_id,
    type: row.type,
    actorType: row.actor_type,
    payload: row.payload,
    createdAt: row.created_at,
    ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}),
    ...(row.revision_id ? { revisionId: row.revision_id } : {}),
  };
}

export function toAutomationInvocation(row: AutomationInvocationRow): AutomationInvocationRecord {
  return {
    id: row.id,
    automationId: row.automation_id,
    trigger: row.trigger,
    status: row.status,
    createdAt: row.created_at,
    metadata: row.metadata,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.scheduled_at ? { scheduledAt: row.scheduled_at } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.reserved_session_id ? { reservedSessionId: row.reserved_session_id } : {}),
    ...(row.reserved_message_id ? { reservedMessageId: row.reserved_message_id } : {}),
    ...(row.requested_by_user_id ? { requestedByUserId: row.requested_by_user_id } : {}),
    ...(row.environment_id ? { environmentId: row.environment_id } : {}),
    ...(row.environment_revision_id ? { environmentRevisionId: row.environment_revision_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export function toWebhookSource(row: WebhookSourceRow): WebhookSourceRecord {
  const record: WebhookSourceRecord = {
    id: row.id,
    key: row.key,
    name: row.name,
    enabled: row.enabled,
    bearerToken: row.bearer_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.prompt_prefix) record.promptPrefix = row.prompt_prefix;
  return record;
}

export function toExternalThread(row: ExternalThreadRow): ExternalThreadRecord {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    sessionId: row.session_id,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toIntegrationDelivery(row: IntegrationDeliveryRow): IntegrationDeliveryRecord {
  const record: IntegrationDeliveryRecord = {
    id: row.id,
    source: row.source,
    dedupeKey: row.dedupe_key,
    status: row.status,
    receivedAt: row.received_at,
    metadata: row.metadata,
  };
  if (row.processed_at) record.processedAt = row.processed_at;
  if (row.error) record.error = row.error;
  return record;
}
