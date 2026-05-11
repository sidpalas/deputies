CREATE INDEX IF NOT EXISTS sessions_updated_created_idx
  ON sessions (updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_pending_created_sequence_idx
  ON messages (created_at ASC, sequence ASC, session_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS messages_session_pending_idx
  ON messages (session_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS sandboxes_provider_active_updated_idx
  ON sandboxes (provider, updated_at ASC)
  WHERE destroyed_at IS NULL AND status IN ('ready', 'stopped', 'unhealthy');

CREATE INDEX IF NOT EXISTS sandboxes_provider_ready_updated_idx
  ON sandboxes (provider, updated_at ASC)
  WHERE destroyed_at IS NULL AND status = 'ready';

CREATE INDEX IF NOT EXISTS callback_deliveries_sending_last_attempt_idx
  ON callback_deliveries (last_attempt_at, created_at)
  WHERE status = 'sending';
