DROP INDEX IF EXISTS runs_one_active_per_session_idx;

CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_session_idx
  ON runs(session_id)
  WHERE status IN ('starting', 'running', 'cancelling');
