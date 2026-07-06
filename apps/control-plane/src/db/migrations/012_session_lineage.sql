ALTER TABLE sessions
  ADD COLUMN parent_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN spawn_depth integer NOT NULL DEFAULT 0;

CREATE INDEX sessions_parent_session_id_idx ON sessions(parent_session_id);
