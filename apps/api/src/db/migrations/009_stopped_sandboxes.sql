ALTER TABLE sandboxes DROP CONSTRAINT IF EXISTS sandboxes_status_check;
ALTER TABLE sandboxes
  ADD CONSTRAINT sandboxes_status_check CHECK (status IN ('ready', 'stopped', 'unhealthy', 'destroyed', 'failed'));

DROP INDEX IF EXISTS sandboxes_session_provider_active_idx;
CREATE INDEX IF NOT EXISTS sandboxes_session_provider_active_idx
  ON sandboxes (session_id, provider, updated_at DESC)
  WHERE destroyed_at IS NULL AND status IN ('ready', 'stopped', 'unhealthy');
