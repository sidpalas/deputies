CREATE TABLE IF NOT EXISTS sandboxes (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_sandbox_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'stopped', 'unhealthy', 'destroyed', 'failed')),
  workspace_path text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_health_check_at timestamptz,
  keepalive_until timestamptz,
  destroyed_at timestamptz,
  UNIQUE (provider, provider_sandbox_id)
);

CREATE INDEX IF NOT EXISTS sandboxes_session_provider_active_idx
  ON sandboxes (session_id, provider, updated_at DESC)
  WHERE destroyed_at IS NULL AND status IN ('ready', 'stopped', 'unhealthy');

CREATE INDEX IF NOT EXISTS sandboxes_provider_active_updated_idx
  ON sandboxes (provider, updated_at ASC)
  WHERE destroyed_at IS NULL AND status IN ('ready', 'stopped', 'unhealthy');

CREATE INDEX IF NOT EXISTS sandboxes_provider_ready_updated_idx
  ON sandboxes (provider, updated_at ASC)
  WHERE destroyed_at IS NULL AND status = 'ready';

CREATE INDEX IF NOT EXISTS sandboxes_provider_keepalive_idx
  ON sandboxes (provider, keepalive_until)
  WHERE destroyed_at IS NULL AND keepalive_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS sandbox_secrets (
  sandbox_id uuid NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  name text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  tag text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (sandbox_id, name)
);
