type EmptyEventPayload = Record<string, never>;

export type NormalizedEvent<T extends NormalizedEventType = NormalizedEventType> = T extends NormalizedEventType
  ? {
      sessionId: string;
      runId?: string;
      messageId?: string;
      sequence?: number;
      type: T;
      payload: NormalizedEventPayload<T>;
      createdAt: Date;
    }
  : never;

export type NormalizedEventPayload<T extends NormalizedEventType = NormalizedEventType> = NormalizedEventPayloadMap[T];

export type NormalizedEventPayloadMap = {
  session_created: {
    title: string | null;
    parentSessionId?: string;
    spawnDepth?: number;
    spawnedBy?: { sessionId: string; runId: string; messageId: string };
    ownerGroupId?: string;
    visibility?: 'group' | 'organization';
    writePolicy?: 'group_members' | 'creator_only';
  };
  session_spawned: {
    childSessionId: string;
    title: string | null;
    ownerGroupId: string;
    spawnDepth: number;
  };
  session_archived: EmptyEventPayload;
  session_unarchived: EmptyEventPayload;
  session_updated: {
    title: string | null;
    tags?: string[];
    context?: Record<string, unknown> | null;
    ownerGroupId?: string;
    visibility?: 'group' | 'organization';
    writePolicy?: 'group_members' | 'creator_only';
  };
  session_queue_paused: EmptyEventPayload;
  session_queue_resumed: EmptyEventPayload;
  message_created: { sequence: number; source: string | null; transcriptOnly?: true };
  message_updated: { sequence: number };
  message_cancelled: { sequence: number; transcriptOnly?: true; reason?: 'session_archived' };
  message_started: { sequences: number[]; batchSize: number };
  run_started: { runner: string };
  sandbox_starting: { provider: string };
  sandbox_ready: {
    provider: string;
    providerSandboxId: string;
    created: boolean;
    restarted?: boolean;
    workspacePath: string;
  };
  sandbox_keepalive_extended: SandboxLifecyclePayload & {
    keepaliveUntil: string;
    extendedBySeconds: number;
    providerSync: 'not_supported' | 'ok' | 'failed';
    port?: number;
  };
  sandbox_destroyed: SandboxLifecyclePayload;
  sandbox_destroy_failed: SandboxLifecyclePayload & { error: string };
  sandbox_stopped: SandboxLifecyclePayload;
  sandbox_stop_failed: SandboxLifecyclePayload & { error: string };
  repository_ready: {
    provider: string;
    owner: string;
    repo: string;
    branch?: string;
    workspacePath: string;
    environmentId?: string;
    environmentName?: string;
    primary?: boolean;
    expiresAt: string;
  };
  skills_loaded: {
    skills: SkillLoadEventItem[];
    shadowed: SkillLoadEventItem[];
    diagnostics: string[];
  };
  skill_invoked: {
    name: string;
    source: 'personal' | 'group' | 'shared' | 'repo';
    trigger: 'user' | 'model';
    ref: string;
    filePath: string;
    repo?: string;
    ownerGroupId?: string;
    ownerGroupName?: string;
    skillId?: string;
    revisionId?: string;
    revisionNumber?: number;
  };
  setup_script_started: {
    path: string;
    workspacePath: string;
    reason: 'cloned' | 'no_stamp' | 'script_changed';
  };
  setup_script_finished: {
    path: string;
    phase: 'probe' | 'script';
    workspacePath: string;
    exitCode: number;
    durationMs: number;
    isError: boolean;
    timedOut?: true;
    stdoutTail: string;
    stderrTail: string;
  };
  agent_text_delta: { text: string };
  agent_response_final: { text: string; model?: string; usage?: ModelUsagePayload };
  tool_started: ToolStartedPayload;
  tool_finished: ToolFinishedPayload;
  artifact_created: { artifact: ArtifactPayload };
  external_resource_created: { resource: ExternalResourcePayload };
  notepad_changed: { notepadKind: 'session' | 'explicit'; notepadId: string; revision: number };
  notepad_associations_changed: EmptyEventPayload;
  run_completed: { runner: string; model?: string; usage?: ModelUsagePayload };
  run_failed: { error: string; recovered?: true };
  run_cancel_requested: { sequences: number[]; batchSize: number };
  run_cancelled: { sequences: number[]; batchSize: number };
  message_completed: { sequence: number };
  message_failed: { error: string };
  callback_sent: CallbackPayload;
  callback_retry_scheduled: CallbackPayload & { error: string; nextAttemptAt?: string };
  callback_failed: CallbackPayload & { error: string; nextAttemptAt?: string };
  callback_replay_requested: CallbackPayload;
};

type SkillLoadEventItem = {
  name: string;
  source: 'personal' | 'group' | 'shared' | 'repo';
  repo?: string;
  ownerGroupId?: string;
  ownerGroupName?: string;
  skillId?: string;
  revisionId?: string;
  revisionNumber?: number;
  ref?: string;
  invoked?: true;
  advertised?: false;
};

type SandboxLifecyclePayload = {
  reason: string;
  provider: string;
  providerSandboxId: string;
};

type ToolStartedPayload = {
  toolName: string;
  toolCallId?: string | undefined;
  command?: string;
  args?: unknown;
  taskId?: string | undefined;
  prompt?: string | undefined;
  agent?: string | undefined;
  role?: string | undefined;
  cwd?: string | undefined;
  parentSessionId?: string | undefined;
};

type ToolFinishedPayload = {
  toolName: string;
  toolCallId?: string | undefined;
  isError?: boolean | undefined;
  result?: unknown;
  command?: string | undefined;
  exitCode?: number | undefined;
  taskId?: string | undefined;
  agent?: string | undefined;
  parentSessionId?: string | undefined;
  error?: unknown;
};

type ArtifactPayload = {
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

type ExternalResourcePayload = {
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

export type ModelUsagePayload = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

type CallbackPayload = {
  deliveryId: string;
  targetType: string;
  attempts: number;
};

export type NormalizedEventType =
  | 'session_created'
  | 'session_spawned'
  | 'session_archived'
  | 'session_unarchived'
  | 'session_updated'
  | 'session_queue_paused'
  | 'session_queue_resumed'
  | 'message_created'
  | 'message_updated'
  | 'message_cancelled'
  | 'message_started'
  | 'run_started'
  | 'sandbox_starting'
  | 'sandbox_ready'
  | 'sandbox_keepalive_extended'
  | 'sandbox_destroyed'
  | 'sandbox_destroy_failed'
  | 'sandbox_stopped'
  | 'sandbox_stop_failed'
  | 'repository_ready'
  | 'skills_loaded'
  | 'skill_invoked'
  | 'setup_script_started'
  | 'setup_script_finished'
  | 'agent_text_delta'
  | 'agent_response_final'
  | 'tool_started'
  | 'tool_finished'
  | 'artifact_created'
  | 'external_resource_created'
  | 'notepad_changed'
  | 'notepad_associations_changed'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancel_requested'
  | 'run_cancelled'
  | 'message_completed'
  | 'message_failed'
  | 'callback_sent'
  | 'callback_retry_scheduled'
  | 'callback_failed'
  | 'callback_replay_requested';

export type NormalizedEmptyEventType =
  | 'session_archived'
  | 'session_unarchived'
  | 'session_queue_paused'
  | 'session_queue_resumed';
