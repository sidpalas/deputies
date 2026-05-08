CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status text NOT NULL,
  runner_type text NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  failed_at timestamptz,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_session_idx
  ON runs(session_id)
  WHERE status IN ('starting', 'running');

CREATE INDEX IF NOT EXISTS runs_message_idx ON runs(message_id);
CREATE INDEX IF NOT EXISTS runs_lease_idx ON runs(status, lease_expires_at);
