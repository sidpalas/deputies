ALTER TABLE events DROP CONSTRAINT IF EXISTS events_message_id_fkey;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_session_id_fkey;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_session_id_fkey;
ALTER TABLE session_sequence_counters DROP CONSTRAINT IF EXISTS session_sequence_counters_session_id_fkey;

ALTER TABLE sessions
  ALTER COLUMN id TYPE uuid USING id::uuid;

ALTER TABLE messages
  ALTER COLUMN id TYPE uuid USING id::uuid,
  ALTER COLUMN session_id TYPE uuid USING session_id::uuid,
  ALTER COLUMN sequence TYPE bigint;

ALTER TABLE events
  ALTER COLUMN session_id TYPE uuid USING session_id::uuid,
  ALTER COLUMN run_id TYPE uuid USING run_id::uuid,
  ALTER COLUMN message_id TYPE uuid USING message_id::uuid,
  ALTER COLUMN sequence TYPE bigint;

ALTER TABLE session_sequence_counters
  ALTER COLUMN session_id TYPE uuid USING session_id::uuid,
  ALTER COLUMN next_sequence TYPE bigint;

ALTER TABLE messages
  ADD CONSTRAINT messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE events
  ADD CONSTRAINT events_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  ADD CONSTRAINT events_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL;

ALTER TABLE session_sequence_counters
  ADD CONSTRAINT session_sequence_counters_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
