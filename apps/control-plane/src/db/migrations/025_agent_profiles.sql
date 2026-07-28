CREATE TABLE agent_profiles (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  current_revision_id uuid NOT NULL,
  current_revision_number integer NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX agent_profiles_active_name_unique_idx
  ON agent_profiles (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE agent_profile_revisions (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  instructions text NOT NULL,
  default_model text,
  default_reasoning_level text,
  supported_invocations text[] NOT NULL CHECK (
    cardinality(supported_invocations) > 0
    AND supported_invocations <@ ARRAY['agent', 'subagent']::text[]
  ),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(profile_id, id),
  UNIQUE(profile_id, revision_number)
);

ALTER TABLE agent_profile_revisions ADD CONSTRAINT agent_profile_reasoning_level_check
  CHECK (default_reasoning_level IS NULL OR default_reasoning_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_current_revision_fk
  FOREIGN KEY (id, current_revision_id) REFERENCES agent_profile_revisions(profile_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE builtin_agent_profile_settings (
  profile_id text PRIMARY KEY,
  enabled boolean NOT NULL,
  default_model text,
  default_reasoning_level text CHECK (
    default_reasoning_level IS NULL
    OR default_reasoning_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
  ),
  updated_by_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE tenant_agent_profile_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  default_profile_id text,
  updated_by_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE automations
  ADD COLUMN profile_id text NOT NULL DEFAULT 'builtin:general';

ALTER TABLE automation_invocations
  ADD COLUMN session_context jsonb;
