ALTER TABLE sessions ADD COLUMN IF NOT EXISTS queue_paused_at timestamptz;
