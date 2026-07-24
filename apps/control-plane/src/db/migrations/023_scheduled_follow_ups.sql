-- Scheduled Follow-ups are installed after the private-Session migrations.
ALTER TABLE messages
  ADD COLUMN scheduled_follow_up_id uuid,
  ADD COLUMN scheduled_follow_up_occurrence_id uuid;

-- Fences callback attempts reclaimed from a crashed or slow dispatcher.
ALTER TABLE callback_deliveries ADD COLUMN claim_token uuid;

CREATE TABLE scheduled_follow_ups (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id),
  status text NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  schedule_kind text NOT NULL CHECK (schedule_kind IN ('once', 'recurring')),
  prompt text NOT NULL CHECK (length(prompt) > 0),
  context_overrides jsonb,
  run_at timestamptz,
  dtstart_local timestamp,
  timezone text,
  rrule text,
  ends_at timestamptz,
  max_occurrences integer CHECK (max_occurrences BETWEEN 1 AND 100),
  next_due_at timestamptz,
  definition_revision integer NOT NULL DEFAULT 1 CHECK (definition_revision > 0),
  scheduler_lock_owner text,
  scheduler_locked_until timestamptz,
  created_by_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  created_by_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  created_by_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  created_by_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  cancelled_at timestamptz,
  CHECK ((schedule_kind = 'once' AND run_at IS NOT NULL AND dtstart_local IS NULL AND timezone IS NULL AND rrule IS NULL AND ends_at IS NULL AND max_occurrences IS NULL)
      OR (schedule_kind = 'recurring' AND run_at IS NULL AND dtstart_local IS NOT NULL AND timezone IS NOT NULL AND rrule IS NOT NULL AND max_occurrences IS NOT NULL)),
  CHECK ((scheduler_lock_owner IS NULL) = (scheduler_locked_until IS NULL))
);
CREATE UNIQUE INDEX scheduled_follow_ups_agent_idempotency_idx
  ON scheduled_follow_ups (created_by_run_id, idempotency_key)
  WHERE created_by_run_id IS NOT NULL AND idempotency_key IS NOT NULL;
CREATE INDEX scheduled_follow_ups_due_idx ON scheduled_follow_ups (next_due_at, created_at)
  WHERE status = 'active';
CREATE INDEX scheduled_follow_ups_session_status_idx ON scheduled_follow_ups (session_id, status, created_at DESC);

CREATE TABLE scheduled_follow_up_occurrences (
  id uuid PRIMARY KEY,
  scheduled_follow_up_id uuid NOT NULL REFERENCES scheduled_follow_ups(id),
  occurrence_number integer NOT NULL CHECK (occurrence_number > 0),
  definition_revision integer NOT NULL CHECK (definition_revision > 0),
  scheduled_at timestamptz NOT NULL,
  activated_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('message_created', 'skipped', 'pre_message_failed')),
  reason text,
  error text,
  message_id uuid REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED,
  effective_context jsonb,
  delivery_metadata jsonb,
  UNIQUE (scheduled_follow_up_id, occurrence_number),
  UNIQUE (scheduled_follow_up_id, scheduled_at),
  CHECK ((outcome = 'message_created' AND message_id IS NOT NULL AND reason IS NULL AND error IS NULL)
      OR (outcome = 'skipped' AND message_id IS NULL AND reason IS NOT NULL AND error IS NULL)
      OR (outcome = 'pre_message_failed' AND message_id IS NULL AND reason IS NOT NULL AND error IS NOT NULL))
);
ALTER TABLE messages ADD CONSTRAINT messages_scheduled_follow_up_fk
  FOREIGN KEY (scheduled_follow_up_id) REFERENCES scheduled_follow_ups(id);
ALTER TABLE messages ADD CONSTRAINT messages_scheduled_follow_up_occurrence_fk
  FOREIGN KEY (scheduled_follow_up_occurrence_id) REFERENCES scheduled_follow_up_occurrences(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE messages ADD CONSTRAINT messages_scheduled_follow_up_provenance_check
  CHECK ((scheduled_follow_up_id IS NULL) = (scheduled_follow_up_occurrence_id IS NULL));
CREATE UNIQUE INDEX messages_one_unfinished_scheduled_follow_up_idx ON messages (scheduled_follow_up_id)
  WHERE scheduled_follow_up_id IS NOT NULL AND status IN ('pending', 'processing', 'cancelling');
CREATE UNIQUE INDEX messages_scheduled_follow_up_occurrence_idx ON messages (scheduled_follow_up_occurrence_id)
  WHERE scheduled_follow_up_occurrence_id IS NOT NULL;
