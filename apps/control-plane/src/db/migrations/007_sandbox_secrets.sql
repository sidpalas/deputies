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
