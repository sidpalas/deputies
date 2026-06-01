CREATE TABLE IF NOT EXISTS pi_sessions (
  id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
