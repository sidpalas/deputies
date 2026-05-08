CREATE TABLE IF NOT EXISTS webhook_sources (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  bearer_token text NOT NULL,
  prompt_prefix text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS external_threads (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  external_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS integration_deliveries (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  dedupe_key text NOT NULL,
  status text NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source, dedupe_key)
);
