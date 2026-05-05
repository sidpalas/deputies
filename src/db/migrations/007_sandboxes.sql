CREATE TABLE IF NOT EXISTS sandboxes (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_sandbox_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'unhealthy', 'destroyed', 'failed')),
  workspace_path text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_health_check_at timestamptz,
  destroyed_at timestamptz,
  UNIQUE (provider, provider_sandbox_id)
);

CREATE INDEX IF NOT EXISTS sandboxes_session_provider_active_idx
  ON sandboxes (session_id, provider, updated_at DESC)
  WHERE destroyed_at IS NULL AND status IN ('ready', 'unhealthy');
