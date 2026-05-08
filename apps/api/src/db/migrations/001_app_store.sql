CREATE TABLE IF NOT EXISTS app_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  status text NOT NULL,
  title text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  status text NOT NULL,
  prompt text NOT NULL,
  source text,
  context jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS messages_session_sequence_idx ON messages(session_id, sequence);

CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id text,
  message_id text REFERENCES messages(id) ON DELETE SET NULL,
  sequence integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS events_session_sequence_idx ON events(session_id, sequence);
