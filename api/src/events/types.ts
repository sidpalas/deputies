export type NormalizedEvent = {
  sessionId: string;
  runId?: string;
  messageId?: string;
  sequence?: number;
  type: NormalizedEventType;
  payload: Record<string, unknown>;
  createdAt: Date;
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
  | 'sandbox_destroyed'
  | 'sandbox_destroy_failed'
  | 'sandbox_stopped'
  | 'sandbox_stop_failed'
  | 'agent_text_delta'
  | 'tool_started'
  | 'tool_finished'
  | 'artifact_created'
  | 'run_completed'
  | 'run_failed'
  | 'message_completed'
  | 'message_failed'
  | 'callback_sent'
  | 'callback_failed';
