ALTER TABLE callback_deliveries DROP CONSTRAINT IF EXISTS callback_deliveries_status_check;
ALTER TABLE callback_deliveries
  ADD CONSTRAINT callback_deliveries_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed'));

ALTER TABLE callback_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE callback_deliveries ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE callback_deliveries ADD COLUMN IF NOT EXISTS max_attempts int NOT NULL DEFAULT 5;

UPDATE callback_deliveries
SET next_attempt_at = created_at
WHERE next_attempt_at IS NULL AND status = 'pending';

CREATE INDEX IF NOT EXISTS callback_deliveries_due_idx
  ON callback_deliveries (next_attempt_at, created_at)
  WHERE status = 'pending';
