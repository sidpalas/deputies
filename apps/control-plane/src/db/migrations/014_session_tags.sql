ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS sessions_tags_gin_idx ON sessions USING gin (tags);

CREATE INDEX IF NOT EXISTS messages_author_session_idx
  ON messages (author_user_id, session_id)
  WHERE author_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_stars (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS session_stars_session_idx ON session_stars (session_id);
