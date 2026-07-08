ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
-- Rolling-deploy safety net for old app versions inserting before they know this column.
-- New app code still writes JS millisecond-precision timestamps explicitly for stable cursors.
ALTER TABLE sessions ALTER COLUMN last_activity_at SET DEFAULT now();
UPDATE sessions SET last_activity_at = updated_at WHERE last_activity_at IS NULL;
ALTER TABLE sessions ALTER COLUMN last_activity_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_active_activity_idx
  ON sessions (last_activity_at DESC, created_at DESC, id DESC)
  WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS sessions_archived_activity_idx
  ON sessions (last_activity_at DESC, created_at DESC, id DESC)
  WHERE status = 'archived';
CREATE INDEX IF NOT EXISTS sessions_active_owner_group_activity_idx
  ON sessions (owner_group_id, last_activity_at DESC, created_at DESC, id DESC)
  WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS sessions_archived_owner_group_activity_idx
  ON sessions (owner_group_id, last_activity_at DESC, created_at DESC, id DESC)
  WHERE status = 'archived';

DROP INDEX IF EXISTS sessions_active_updated_idx;
DROP INDEX IF EXISTS sessions_archived_updated_idx;
DROP INDEX IF EXISTS sessions_active_owner_group_updated_idx;
DROP INDEX IF EXISTS sessions_archived_owner_group_updated_idx;
