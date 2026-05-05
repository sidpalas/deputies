CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  type text NOT NULL,
  title text,
  url text,
  storage_key text,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS artifacts_session_created_idx ON artifacts (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_run_created_idx ON artifacts (run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS callback_deliveries (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  target_type text NOT NULL,
  target jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS callback_deliveries_session_created_idx ON callback_deliveries (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS callback_deliveries_status_created_idx ON callback_deliveries (status, created_at);
