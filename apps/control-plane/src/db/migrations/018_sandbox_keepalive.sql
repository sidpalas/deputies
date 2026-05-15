ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS keepalive_until timestamptz;

CREATE INDEX IF NOT EXISTS sandboxes_provider_keepalive_idx
  ON sandboxes (provider, keepalive_until)
  WHERE destroyed_at IS NULL AND keepalive_until IS NOT NULL;
