CREATE TABLE IF NOT EXISTS automations (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('scheduled')),
  name text NOT NULL,
  prompt text NOT NULL,
  schedule_cron text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  owner_group_id uuid NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  visibility text NOT NULL CHECK (visibility IN ('group', 'organization')),
  write_policy text NOT NULL CHECK (write_policy IN ('group_members', 'creator_only')),
  context jsonb,
  created_by_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  next_invocation_at timestamptz,
  scheduler_lock_owner text,
  scheduler_locked_until timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS automations_owner_group_updated_idx
  ON automations(owner_group_id, updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS automations_due_scheduled_idx
  ON automations(next_invocation_at ASC)
  WHERE kind = 'scheduled' AND enabled = true;

CREATE TABLE IF NOT EXISTS automation_invocations (
  id uuid PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  status text NOT NULL CHECK (status IN ('creating', 'created', 'skipped', 'failed')),
  scheduled_at timestamptz,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  requested_by_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  reason text,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_invocations_scheduled_unique_idx
  ON automation_invocations(automation_id, scheduled_at)
  WHERE trigger = 'scheduled' AND scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS automation_invocations_automation_created_idx
  ON automation_invocations(automation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS automation_invocations_session_idx
  ON automation_invocations(session_id)
  WHERE session_id IS NOT NULL;
