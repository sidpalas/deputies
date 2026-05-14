CREATE TABLE IF NOT EXISTS external_resources (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  type text NOT NULL,
  title text,
  url text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS external_resources_session_created_idx ON external_resources (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS external_resources_run_created_idx ON external_resources (run_id, created_at DESC);
