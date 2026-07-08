DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'pg_trgm extension unavailable; title search will use unindexed ILIKE fallback';
END $$;

CREATE TABLE IF NOT EXISTS session_search_docs (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('title', 'prompt', 'response')),
  source_id text NOT NULL,
  content text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(content, 16384))) STORED,
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, kind, source_id)
);

CREATE INDEX IF NOT EXISTS session_search_docs_tsv_idx
  ON session_search_docs USING GIN (tsv);
CREATE INDEX IF NOT EXISTS session_search_docs_session_idx
  ON session_search_docs (session_id);

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS sessions_title_trgm_idx
    ON sessions USING GIN (title gin_trgm_ops)
    WHERE title IS NOT NULL;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file OR undefined_object THEN
    RAISE NOTICE 'pg_trgm title index unavailable; title search will use unindexed ILIKE fallback';
END $$;

CREATE TABLE IF NOT EXISTS search_index_cursor (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_event_id bigint NOT NULL DEFAULT 0
);

INSERT INTO search_index_cursor (id, last_event_id)
VALUES (true, 0)
ON CONFLICT (id) DO NOTHING;
