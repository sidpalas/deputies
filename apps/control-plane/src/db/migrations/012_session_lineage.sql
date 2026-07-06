ALTER TABLE sessions
  ADD COLUMN parent_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN spawn_depth integer NOT NULL DEFAULT 0;

CREATE INDEX sessions_parent_session_id_idx ON sessions(parent_session_id);
CREATE INDEX sessions_parent_non_archived_idx ON sessions(parent_session_id) WHERE status <> 'archived';
CREATE INDEX runs_session_started_idx ON runs(session_id, started_at DESC, id DESC);
CREATE INDEX events_session_type_sequence_idx ON events(session_id, type, sequence DESC);
