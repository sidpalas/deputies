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
  session_created: { title: string | null };
  session_archived: EmptyEventPayload;
  session_unarchived: EmptyEventPayload;
  session_updated: { title: string | null; context?: Record<string, unknown> | null };
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
    expiresAt: string;
  };
  agent_text_delta: { text: string; flueSessionId?: string | undefined };
  agent_response_final: { text: string; model?: string; usage?: ModelUsagePayload };
  tool_started: ToolStartedPayload;
  tool_finished: ToolFinishedPayload;
  artifact_created: { artifact: ArtifactPayload };
  external_resource_created: { resource: ExternalResourcePayload };
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
  flueSessionId?: string | undefined;
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
  flueSessionId?: string | undefined;
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
  | 'agent_text_delta'
  | 'agent_response_final'
  | 'tool_started'
  | 'tool_finished'
  | 'artifact_created'
  | 'external_resource_created'
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
