CREATE INDEX IF NOT EXISTS events_agent_text_delta_compaction_idx
  ON events (id, session_id, message_id, sequence, created_at)
  WHERE type = 'agent_text_delta' AND message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_agent_response_final_compaction_idx
  ON events (session_id, message_id, sequence, created_at)
  WHERE type = 'agent_response_final'
    AND message_id IS NOT NULL
    AND jsonb_typeof(payload->'text') = 'string';
