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
  | 'message_created'
  | 'message_started'
  | 'run_started'
  | 'sandbox_starting'
  | 'sandbox_ready'
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
