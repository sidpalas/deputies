import type { NormalizedEvent, NormalizedEventType } from '../events/types.js';

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
  | 'completing'
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
export type SkillSource = 'managed';
export type EnvironmentRevisionPolicy = 'follow_latest' | 'pinned';
export type EnvironmentActivityType =
  | 'environment_created'
  | 'revision_published'
  | 'sharing_changed'
  | 'owner_transferred'
  | 'environment_renamed'
  | 'environment_archived'
  | 'environment_unarchived';
export type AuditActorType = 'user' | 'system';
export type RepositoryProvider = 'github';

export type AuthRole = 'viewer' | 'member' | 'admin';

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

export class StoreConflictError extends Error {
  constructor(
    readonly code:
      | 'environment_name_exists'
      | 'environment_update_conflict'
      | 'environment_archived'
      | 'environment_automation_conflict'
      | 'automation_environment_unavailable'
      | 'automation_archived'
      | 'automation_invocation_active'
      | 'skill_name_exists'
      | 'skill_update_conflict'
      | 'skill_archived'
      | 'snippet_name_exists'
      | 'session_archived'
      | 'not_found'
      | 'notepad_exists'
      | 'stale_revision'
      | 'invalid_notepad_size'
      | 'invalid_notepad_revision'
      | 'notepad_too_large'
      | 'notepad_association_forbidden'
      | 'last_admin',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

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
  lastActivityAt: Date;
  tags: string[];
  parentSessionId?: string;
  spawnDepth: number;
  title?: string;
  queuePausedAt?: Date;
  createdByUserId?: string;
  context?: Record<string, unknown>;
};

export type NotepadActor =
  | { kind: 'human'; userId: string }
  | { kind: 'agent'; sessionId: string; runId: string }
  | { kind: 'system' };
export const notepadRevisionRetentionLimit = 50;
export type NotepadMutationKind = 'replace' | 'patch' | 'append' | 'restore';
export type ExplicitNotepadRecord = {
  id: string;
  title: string;
  revision: number;
  content: string;
  sizeBytes: number;
  createdByUserId?: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
};
export type SessionNotepadRecord = {
  sessionId: string;
  revision: number;
  content: string;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
};
export type NotepadRevisionRecord = {
  notepadKind: 'session' | 'explicit';
  notepadId: string;
  revision: number;
  content: string;
  sizeBytes: number;
  actor: NotepadActor;
  mutationKind: NotepadMutationKind;
  createdAt: Date;
};
export type NotepadRevisionMetadata = Omit<NotepadRevisionRecord, 'content'>;
export type ExplicitNotepadMetadata = Omit<ExplicitNotepadRecord, 'content'>;
export type ExplicitNotepadSearchResult = ExplicitNotepadMetadata & { snippet: string };
export type NotepadPage<T> = { items: T[]; hasMore: boolean; nextCursor: string | null };
export type NotepadAssociationRecord = {
  notepadId: string;
  sessionId: string;
  createdByUserId?: string;
  createdAt: Date;
};
export type AssociatedNotepadAuthority = { associatedSessionId: string; expectedUserId: string };
export type InitialNotepadAssociation =
  | { initialAssociation?: never; associationActivityId?: never }
  | { initialAssociation: NotepadAssociationRecord; associationActivityId: string };
export type SessionNotepadCapabilityRecord = {
  sessionId: string;
  kind: 'explicit_search' | 'session_notepad_coordination';
  grantedByUserId: string;
  createdAt: Date;
};
export type NotepadActivityKind =
  | 'created'
  | 'metadata_changed'
  | 'revision_restored'
  | 'association_granted'
  | 'association_changed'
  | 'association_revoked';
export type NotepadActivityRecord = {
  id: string;
  notepadId: string;
  actor: NotepadActor;
  kind: NotepadActivityKind;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type MessageRecord = {
  id: string;
  sessionId: string;
  sequence: number;
  status: MessageStatus;
  prompt: string;
  steering: boolean;
  createdAt: Date;
  authorUserId?: string;
  authorName?: string;
  source?: string;
  context?: Record<string, unknown>;
};

export type SnippetRecord = {
  id: string;
  ownerUserId: string;
  name: string;
  body: string;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSnippetRecord = SnippetRecord;
export type UpdateSnippetRecord = Pick<SnippetRecord, 'id' | 'ownerUserId' | 'updatedAt'> &
  Partial<Pick<SnippetRecord, 'name' | 'body'>>;

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
  events?: EventRecord[];
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
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
  environmentId?: string;
  environmentRevisionPolicy?: EnvironmentRevisionPolicy;
  environmentRevisionId?: string;
  nextInvocationAt?: Date;
  createdByUserId?: string;
  context?: Record<string, unknown>;
  schedulerLockOwner?: string;
  schedulerLockedUntil?: Date;
};

export type EnvironmentRecord = {
  id: string;
  name: string;
  currentRevisionId: string;
  currentRevisionNumber: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
};

export type EnvironmentRepositoryRecord = {
  id: string;
  revisionId: string;
  provider: RepositoryProvider;
  owner: string;
  repo: string;
  isPrimary: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  branch?: string;
};

export type EnvironmentRevisionRepository = {
  provider: RepositoryProvider;
  owner: string;
  repo: string;
  primary: boolean;
  position: number;
  branch?: string;
};

export type EnvironmentRevisionRecord = {
  id: string;
  environmentId: string;
  revisionNumber: number;
  repositories: EnvironmentRevisionRepository[];
  createdAt: Date;
  actorType: AuditActorType;
  actorUserId?: string;
};

export type EnvironmentActivityRecord = {
  id: string;
  environmentId: string;
  type: EnvironmentActivityType;
  actorType: AuditActorType;
  actorUserId?: string;
  revisionId?: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type EnvironmentWithDetailsRecord = EnvironmentRecord & {
  repositories: EnvironmentRepositoryRecord[];
};

type SkillRecordBase = {
  id: string;
  name: string;
  description: string;
  body: string;
  currentRevisionId: string;
  currentRevisionNumber: number;
  autoLoad: boolean;
  enabled: boolean;
  createdByUserId?: string;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type SkillRecord = SkillRecordBase &
  ({ scope: 'tenant'; ownerUserId?: never } | { scope: 'personal'; ownerUserId: string });

type SkillRevisionRecordBase = {
  id: string;
  skillId: string;
  revisionNumber: number;
  name: string;
  description: string;
  body: string;
  createdAt: Date;
};

export type SkillRevisionRecord = SkillRevisionRecordBase &
  ({ actorType: 'user'; actorUserId: string } | { actorType: 'system'; actorUserId?: never });

export type SkillRevisionWrite = Omit<SkillRevisionRecordBase, 'skillId' | 'revisionNumber'> &
  ({ actorType: 'user'; actorUserId: string } | { actorType: 'system'; actorUserId?: never });

export type SkillRunCandidate = SkillRecord & {
  source: SkillSource;
  resolvedRevisionId: string;
  resolvedRevisionNumber: number;
};

export type SkillRevisionSelection = {
  skillId: string;
  revisionId: string;
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
  environmentId?: string;
  environmentRevisionId?: string;
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
  lastActivityAt?: Date;
  tags?: string[];
  parentSessionId?: string;
  spawnDepth?: number;
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
  steering?: boolean;
  createdAt: Date;
  authorUserId?: string;
  authorName?: string;
  source?: string;
  context?: Record<string, unknown>;
};

export type CreateSessionWithFirstMessageInput = {
  session: CreateSessionRecord;
  message: Omit<CreateMessageRecord, 'sessionId' | 'sequence' | 'status'>;
  sessionCreatedEvent: NormalizedEvent<'session_created'>;
  messageCreatedEvent: Omit<NormalizedEvent<'message_created'>, 'sessionId' | 'messageId'>;
  parentSpawnedEvent?: NormalizedEvent<'session_spawned'>;
  parentChildLimit?: {
    parentSessionId: string;
    maxNonArchivedChildren: number;
  };
};

export type CreateSessionWithFirstMessageResult = {
  session: SessionRecord;
  message: MessageRecord;
  events: EventRecord[];
  created: boolean;
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
  createdAt: Date;
  updatedAt: Date;
  nextInvocationAt?: Date;
  environmentId?: string;
  environmentRevisionPolicy?: EnvironmentRevisionPolicy;
  environmentRevisionId?: string;
  createdByUserId?: string;
  context?: Record<string, unknown>;
};

export type CreateEnvironmentRecord = {
  environment: EnvironmentRecord;
  repositories: EnvironmentRepositoryRecord[];
  revision: EnvironmentRevisionRecord;
  activities: EnvironmentActivityRecord[];
};

type CreateSkillRecordBase = {
  id: string;
  revision: SkillRevisionWrite;
  autoLoad?: boolean;
  enabled?: boolean;
  createdByUserId?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSkillRecord = CreateSkillRecordBase &
  ({ scope: 'tenant'; ownerUserId?: never } | { scope: 'personal'; ownerUserId: string });

export type UpdateSkillRecord = {
  id: string;
  expectedCurrentRevisionId: string;
  updatedAt: Date;
  revision?: SkillRevisionWrite;
  autoLoad?: boolean;
  enabled?: boolean;
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
  environmentId?: string;
  environmentRevisionId?: string;
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
  context?: Record<string, unknown> | null;
  environmentId?: string | null;
  environmentRevisionPolicy?: EnvironmentRevisionPolicy | null;
  environmentRevisionId?: string | null;
  nextInvocationAt?: Date | null;
};

export type UpdateEnvironmentRecord = {
  expectedUpdatedAt: Date;
  environment: EnvironmentRecord;
  repositories: EnvironmentRepositoryRecord[];
  revision?: EnvironmentRevisionRecord;
  activities: EnvironmentActivityRecord[];
};

export type SessionWithSandboxRecord = {
  session: SessionRecord;
  sandbox: SandboxRecord | null;
  directChildCount?: number;
};

export type AgentSessionListScope = 'children' | 'tenant';

export type AgentSessionListOptions = {
  actingSessionId: string;
  scope: AgentSessionListScope;
  limit: number;
  status?: SessionStatus;
};

export type ChildSessionListOptions = {
  parentSessionId: string;
  limit: number;
};

export type SessionMessageSummary = {
  count: number;
  lastMessage: MessageRecord | null;
};

export type SessionTranscriptOptions = {
  sessionId: string;
  limit: number;
  beforeSequence?: number;
};

export type SessionTranscriptEntry = {
  message: MessageRecord;
  finalResponse: EventRecord | null;
};

export type SessionTranscriptPage = {
  entries: SessionTranscriptEntry[];
  hasMore: boolean;
  nextBeforeSequence?: number;
};

export type SessionListCursor = {
  lastActivityAt: Date;
  createdAt: Date;
  id: string;
};

export type SessionListOptions = {
  archived: boolean;
  parentSessionId?: string;
  tags?: string[];
  createdByUserId?: string;
  participantUserId?: string;
  starredByUserId?: string;
  limit: number;
  cursor?: SessionListCursor;
};

export type SessionWithSandboxPage = {
  items: SessionWithSandboxRecord[];
  nextCursor: SessionListCursor | null;
};

export type SessionSearchMatchKind = 'title' | 'prompt' | 'response';

export type SessionSearchOptions = {
  query: string;
  tags?: string[];
  createdByUserId?: string;
  participantUserId?: string;
  starredByUserId?: string;
  limit: number;
  cursor?: number;
};

export type SessionTagSummary = {
  tag: string;
  sessionCount: number;
};

export type SessionSearchResult = {
  item: SessionWithSandboxRecord;
  snippet: string;
  matchKind: SessionSearchMatchKind;
  score: number;
};

export type SessionSearchPage = {
  items: SessionSearchResult[];
  nextCursor: number | null;
};

export type SessionSearchDocInput = {
  sessionId: string;
  kind: SessionSearchMatchKind;
  sourceId: string;
  content: string;
  createdAt: Date;
};

export type SessionMetadataUpdateInput = {
  id: string;
  updatedAt: Date;
  requireNonArchived?: boolean;
  title?: string;
  tags?: string[];
};

export type SessionTitleUpdateInput = {
  id: string;
  expectedTitle: string;
  title: string;
  updatedAt: Date;
  runId: string;
  leaseOwner: string;
  now: Date;
};

export type SessionContextUpdateInput = {
  id: string;
  context?: Record<string, unknown>;
  updatedAt: Date;
};

export interface SessionStore {
  createSession(record: CreateSessionRecord): Promise<SessionRecord>;
  createSessionWithFirstMessage(
    input: CreateSessionWithFirstMessageInput,
  ): Promise<CreateSessionWithFirstMessageResult>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessions(): Promise<SessionRecord[]>;
  listSessionsForAgent(input: AgentSessionListOptions): Promise<SessionRecord[]>;
  listChildSessions(input: ChildSessionListOptions): Promise<SessionRecord[]>;
  listSessionsWithLatestSandbox(provider: string, options: SessionListOptions): Promise<SessionWithSandboxPage>;
  searchSessions(provider: string, options: SessionSearchOptions): Promise<SessionSearchPage>;
  listSessionTags(options: { limit: number }): Promise<SessionTagSummary[]>;
  starSession(input: { sessionId: string; userId: string; now: Date }): Promise<void>;
  unstarSession(input: { sessionId: string; userId: string }): Promise<void>;
  listStarredSessionIds(input: { userId: string; sessionIds: string[] }): Promise<Set<string>>;
  getSearchIndexCursor(): Promise<number>;
  setSearchIndexCursor(lastEventId: number): Promise<void>;
  upsertSessionSearchDocs(docs: SessionSearchDocInput[]): Promise<void>;
  updateSession(record: SessionRecord): Promise<SessionRecord>;
  updateSessionContext(input: SessionContextUpdateInput): Promise<SessionRecord>;
  // Commits the session update and its event atomically, so no event committed
  // after an access change can be notified ahead of the change itself.
  updateSessionWithEvent(
    record: SessionRecord,
    event: NormalizedEvent,
    options?: { preserveTags?: boolean },
  ): Promise<{ session: SessionRecord; event: EventRecord }>;
  updateSessionMetadataWithEvent(
    input: SessionMetadataUpdateInput,
  ): Promise<{ session: SessionRecord; event: EventRecord }>;
  updateSessionTitleIfCurrent(
    input: SessionTitleUpdateInput,
  ): Promise<{ session: SessionRecord; event: EventRecord } | null>;
  archiveSession(input: { sessionId: string; archivedAt: Date }): Promise<{
    session: SessionRecord;
    cancelledMessages: MessageRecord[];
    events: EventRecord[];
  }>;
  unarchiveSession(input: { sessionId: string; unarchivedAt: Date }): Promise<{
    session: SessionRecord;
    events: EventRecord[];
  }>;
  updateSessionForRun(input: {
    id: string;
    context: Record<string, unknown>;
    updatedAt: Date;
    runId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<SessionRecord | null>;
  pauseSessionQueue(input: { sessionId: string; pausedAt: Date }): Promise<SessionRecord>;
  resumeSessionQueue(input: { sessionId: string }): Promise<SessionRecord>;
}

export interface NotepadStore {
  getSessionNotepad(sessionId: string): Promise<SessionNotepadRecord | null>;
  readCoordinatedSessionNotepad(
    actorSessionId: string,
    targetSessionId: string,
    expectedGrantorUserId: string,
  ): Promise<SessionNotepadRecord>;
  mutateSessionNotepad(input: {
    sessionId: string;
    content?: string;
    append?: string;
    expectedRevision?: number;
    actor: NotepadActor;
    expectedCoordinationGrantorUserId?: string;
    mutationKind: NotepadMutationKind;
    now: Date;
  }): Promise<SessionNotepadRecord>;
  restoreSessionNotepadRevision(input: {
    sessionId: string;
    revision: number;
    expectedRevision: number;
    actor: NotepadActor;
    expectedCoordinationGrantorUserId?: string;
    now: Date;
  }): Promise<SessionNotepadRecord>;
  createExplicitNotepad(
    input: {
      record: ExplicitNotepadRecord;
      actor: NotepadActor;
      activityId: string;
    } & InitialNotepadAssociation,
  ): Promise<ExplicitNotepadRecord>;
  getExplicitNotepad(id: string): Promise<ExplicitNotepadRecord | null>;
  getExplicitNotepadMetadata(id: string): Promise<ExplicitNotepadMetadata | null>;
  listExplicitNotepads(input: {
    limit: number;
    offset: number;
    includeDormant?: boolean;
    archived?: boolean;
  }): Promise<NotepadPage<ExplicitNotepadMetadata>>;
  searchExplicitNotepads(input: {
    query: string;
    limit: number;
    archived?: boolean;
  }): Promise<ExplicitNotepadSearchResult[]>;
  searchExplicitNotepadsWithCapability(input: {
    actorSessionId: string;
    expectedGrantorUserId: string;
    query: string;
    limit: number;
  }): Promise<ExplicitNotepadSearchResult[]>;
  readExplicitNotepadWithCapability(input: {
    actorSessionId: string;
    expectedGrantorUserId: string;
    notepadId: string;
  }): Promise<ExplicitNotepadRecord>;
  updateExplicitNotepadMetadata(input: {
    id: string;
    title?: string;
    actor: NotepadActor;
    activityId: string;
    now: Date;
  }): Promise<ExplicitNotepadRecord>;
  archiveExplicitNotepad(input: { id: string; archivedAt: Date }): Promise<ExplicitNotepadRecord | null>;
  restoreExplicitNotepad(input: { id: string; updatedAt: Date }): Promise<ExplicitNotepadRecord | null>;
  mutateExplicitNotepad(input: {
    id: string;
    content?: string;
    append?: string;
    expectedRevision?: number;
    actor: NotepadActor;
    associatedAuthority?: AssociatedNotepadAuthority;
    mutationKind: NotepadMutationKind;
    now: Date;
  }): Promise<ExplicitNotepadRecord>;
  restoreExplicitNotepadRevision(input: {
    id: string;
    revision: number;
    expectedRevision: number;
    actor: NotepadActor;
    associatedAuthority?: AssociatedNotepadAuthority;
    activityId: string;
    now: Date;
  }): Promise<ExplicitNotepadRecord>;
  listNotepadRevisions(
    kind: 'session' | 'explicit',
    id: string,
    limit: number,
    beforeRevision: number,
  ): Promise<NotepadPage<NotepadRevisionMetadata>>;
  getNotepadRevision(kind: 'session' | 'explicit', id: string, revision: number): Promise<NotepadRevisionRecord | null>;
  putNotepadAssociation(input: {
    record: NotepadAssociationRecord;
    actor: NotepadActor;
    activityId: string;
  }): Promise<NotepadAssociationRecord>;
  removeNotepadAssociation(input: {
    notepadId: string;
    sessionId: string;
    actor: NotepadActor;
    activityId: string;
    now: Date;
  }): Promise<boolean>;
  listNotepadAssociations(
    notepadId: string,
    limit: number,
    offset: number,
  ): Promise<NotepadPage<NotepadAssociationRecord>>;
  listNotepadAssociationSessionIdsAfter(
    notepadId: string,
    afterSessionId: string | null,
    limit: number,
  ): Promise<string[]>;
  getNotepadAssociation(notepadId: string, sessionId: string): Promise<NotepadAssociationRecord | null>;
  listSessionNotepadAssociations(
    sessionId: string,
    limit: number,
    offset: number,
  ): Promise<NotepadPage<NotepadAssociationRecord & { notepad: ExplicitNotepadMetadata }>>;
  putSessionNotepadCapability(record: SessionNotepadCapabilityRecord): Promise<SessionNotepadCapabilityRecord>;
  removeSessionNotepadCapability(
    sessionId: string,
    kind: SessionNotepadCapabilityRecord['kind'],
    expectedGrantedByUserId?: string,
  ): Promise<boolean>;
  listSessionNotepadCapabilities(sessionId: string): Promise<SessionNotepadCapabilityRecord[]>;
  listNotepadActivity(notepadId: string, limit: number, offset: number): Promise<NotepadPage<NotepadActivityRecord>>;
}

export interface MessageStore {
  getSession(id: string): Promise<SessionRecord | null>;
  updateSession(record: SessionRecord): Promise<SessionRecord>;
  updateSessionContext(input: SessionContextUpdateInput): Promise<SessionRecord>;
  nextMessageSequence(sessionId: string): Promise<number>;
  createMessage(record: CreateMessageRecord): Promise<MessageRecord>;
  getMessage(input: { sessionId: string; messageId: string }): Promise<MessageRecord | null>;
  getMessages(sessionId: string): Promise<MessageRecord[]>;
  getMessagesByIds(messageIds: string[]): Promise<MessageRecord[]>;
  getSessionMessageSummary(sessionId: string): Promise<SessionMessageSummary>;
  getSessionTranscript(input: SessionTranscriptOptions): Promise<SessionTranscriptPage>;
  updatePendingMessage(input: {
    sessionId: string;
    messageId: string;
    prompt?: string;
    steering?: boolean;
    context?: Record<string, unknown>;
  }): Promise<MessageRecord | null>;
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
  persistActiveRunExecutionSignature(input: {
    runId: string;
    leaseOwner: string;
    now: Date;
    signature: Record<string, unknown>;
  }): Promise<RunRecord | null>;
  claimPendingSteeringMessages(input: { runId: string; leaseOwner: string; now: Date }): Promise<MessageRecord[]>;
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
  getLatestRunForSession(sessionId: string): Promise<RunRecord | null>;
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
  beginRunCompletion(input: {
    runId: string;
    leaseOwner: string;
    now: Date;
    result: Record<string, unknown>;
  }): Promise<ClaimedMessageBatch | null>;
  claimExpiredRunCompletion(input: {
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
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
  getLatestSandboxForSession(sessionId: string, preferredProvider?: string): Promise<SandboxRecord | null>;
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

export interface EnvironmentStore {
  createEnvironment(record: CreateEnvironmentRecord): Promise<EnvironmentWithDetailsRecord>;
  getEnvironment(id: string): Promise<EnvironmentWithDetailsRecord | null>;
  listEnvironments(): Promise<EnvironmentWithDetailsRecord[]>;
  getEnvironmentRevision(id: string): Promise<EnvironmentRevisionRecord | null>;
  listEnvironmentRevisions(environmentId: string): Promise<EnvironmentRevisionRecord[]>;
  listEnvironmentActivity(environmentId: string): Promise<EnvironmentActivityRecord[]>;
  updateEnvironment(record: UpdateEnvironmentRecord): Promise<EnvironmentWithDetailsRecord>;
  archiveEnvironment(input: {
    environmentId: string;
    archivedAt: Date;
    activity: EnvironmentActivityRecord;
  }): Promise<EnvironmentWithDetailsRecord | null>;
  unarchiveEnvironment(input: {
    environmentId: string;
    updatedAt: Date;
    activity: EnvironmentActivityRecord;
  }): Promise<EnvironmentWithDetailsRecord | null>;
}

export interface SkillStore {
  createSkill(record: CreateSkillRecord): Promise<SkillRecord>;
  getSkill(id: string): Promise<SkillRecord | null>;
  listSkillRevisions(skillId: string): Promise<SkillRevisionRecord[]>;
  updateSkill(input: UpdateSkillRecord): Promise<SkillRecord>;
  archiveSkill(input: { skillId: string; archivedAt: Date }): Promise<SkillRecord | null>;
  restoreSkill(input: { skillId: string; updatedAt: Date }): Promise<SkillRecord | null>;
  listSkills(input: { userId?: string }): Promise<SkillRecord[]>;
  listSkillInvocationCandidates(input: { userId?: string }): Promise<SkillRunCandidate[]>;
  listSkillsForRun(input: {
    userId?: string;
    invokedNames?: string[];
    invokedRevisions?: SkillRevisionSelection[];
  }): Promise<SkillRunCandidate[]>;
}

export interface SnippetStore {
  createSnippet(record: CreateSnippetRecord): Promise<SnippetRecord>;
  getSnippetForUser(id: string, ownerUserId: string): Promise<SnippetRecord | null>;
  listSnippetsForUser(ownerUserId: string): Promise<SnippetRecord[]>;
  updateSnippet(record: UpdateSnippetRecord): Promise<SnippetRecord | null>;
  archiveSnippet(id: string, ownerUserId: string, archivedAt: Date): Promise<SnippetRecord | null>;
  restoreSnippet(id: string, ownerUserId: string, updatedAt: Date): Promise<SnippetRecord | null>;
}

export interface EventStore {
  nextEventSequence(sessionId: string): Promise<number>;
  appendEvent(event: NormalizedEvent & { sequence: number }): Promise<EventRecord>;
  appendEventWithNextSequence(event: NormalizedEvent): Promise<EventRecord>;
  appendEventWithNextSequenceForRun(
    event: Omit<NormalizedEvent, 'runId'> & { runId: string },
    guard: { runId: string; leaseOwner: string; now: Date },
  ): Promise<EventRecord | null>;
  getEvents(sessionId: string, afterSequence?: number, limit?: number): Promise<EventRecord[]>;
  getLatestEventByType(sessionId: string, type: NormalizedEventType): Promise<EventRecord | null>;
  listEvents(afterId?: number, limit?: number): Promise<EventRecord[]>;
  compactFinalizedAgentTextDeltas(input: EventDeltaCompactionInput): Promise<number>;
}

export type EventRecord = NormalizedEvent & { id: number; sequence: number };
export type EventDeltaCompactionInput = { finalizedBefore: Date; limit: number };

export interface AuthStore {
  upsertAuthUserForAccount(record: UpsertAuthUserForAccountRecord): Promise<AuthUserRecord>;
  createAuthSession(record: AuthSessionRecord): Promise<AuthSessionRecord>;
  getAuthUserBySession(input: { sessionId: string; now: Date }): Promise<AuthUserRecord | null>;
  getAuthUser(id: string): Promise<AuthUserRecord | null>;
  deleteAuthSession(sessionId: string): Promise<void>;
  listAuthUsers(input?: { query?: string }): Promise<AuthUserRecord[]>;
  updateAuthUserRole(input: { userId: string; role: AuthRole; updatedAt: Date }): Promise<AuthUserRecord | null>;
}

export interface ArtifactStore {
  createArtifact(record: CreateArtifactRecord): Promise<ArtifactRecord>;
  getArtifacts(sessionId: string): Promise<ArtifactRecord[]>;
}

export interface ExternalResourceStore {
  createExternalResource(record: CreateExternalResourceRecord): Promise<ExternalResourceRecord>;
  getExternalResources(sessionId: string): Promise<ExternalResourceRecord[]>;
}

export interface IntegrationStore {
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

export interface AppStore
  extends
    SessionStore,
    MessageStore,
    RunStore,
    SandboxStore,
    CallbackStore,
    AutomationStore,
    EnvironmentStore,
    SkillStore,
    SnippetStore,
    NotepadStore,
    EventStore,
    AuthStore,
    ArtifactStore,
    ExternalResourceStore,
    IntegrationStore {}
