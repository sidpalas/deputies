-- The session list joins each session to its latest sandbox regardless of
-- status, which the partial active-only indexes from 003 cannot serve.
CREATE INDEX IF NOT EXISTS sandboxes_session_provider_updated_idx
  ON sandboxes (session_id, provider, updated_at DESC);
