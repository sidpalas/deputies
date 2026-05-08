CREATE TABLE IF NOT EXISTS session_sequence_counters (
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  next_sequence integer NOT NULL,
  PRIMARY KEY (session_id, kind)
);
