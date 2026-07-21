ALTER TABLE messages
ADD COLUMN steering boolean NOT NULL DEFAULT false;

DROP INDEX runs_one_active_per_session_idx;
CREATE UNIQUE INDEX runs_one_active_per_session_idx
  ON runs(session_id)
  WHERE status IN ('starting', 'running', 'completing', 'cancelling');

CREATE UNIQUE INDEX events_one_final_response_per_run_message_idx
  ON events(run_id, message_id, type)
  WHERE type = 'agent_response_final';

CREATE UNIQUE INDEX events_one_message_completed_per_run_message_idx
  ON events(run_id, message_id, type)
  WHERE type = 'message_completed';
