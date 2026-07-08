CREATE INDEX IF NOT EXISTS sessions_active_updated_idx
  ON sessions (updated_at DESC, created_at DESC, id DESC)
  WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS sessions_archived_updated_idx
  ON sessions (updated_at DESC, created_at DESC, id DESC)
  WHERE status = 'archived';

CREATE INDEX IF NOT EXISTS sessions_active_owner_group_updated_idx
  ON sessions (owner_group_id, updated_at DESC, created_at DESC, id DESC)
  WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS sessions_archived_owner_group_updated_idx
  ON sessions (owner_group_id, updated_at DESC, created_at DESC, id DESC)
  WHERE status = 'archived';
