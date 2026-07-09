CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  owner_group_id uuid NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  share_mode text NOT NULL DEFAULT 'private' CHECK (share_mode IN ('private', 'selected_groups', 'all_groups')),
  current_revision_id uuid NOT NULL,
  current_revision_number integer NOT NULL CHECK (current_revision_number > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS environments_owner_group_name_active_unique_idx
  ON environments(owner_group_id, lower(btrim(name)))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS environments_owner_group_updated_idx
  ON environments(owner_group_id, updated_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS environment_revisions (
  id uuid PRIMARY KEY,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(environment_id, revision_number),
  UNIQUE(environment_id, id)
);

ALTER TABLE environments
  ADD CONSTRAINT environments_current_revision_fk
  FOREIGN KEY (id, current_revision_id) REFERENCES environment_revisions(environment_id, id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS environment_revisions_environment_created_idx
  ON environment_revisions(environment_id, revision_number DESC);

CREATE TABLE IF NOT EXISTS environment_revision_repositories (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES environment_revisions(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  branch text,
  is_primary boolean NOT NULL DEFAULT false,
  position integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (provider IN ('github'))
);

CREATE UNIQUE INDEX IF NOT EXISTS environment_revision_repositories_identity_unique_idx
  ON environment_revision_repositories(revision_id, provider, lower(owner), lower(repo));

CREATE UNIQUE INDEX IF NOT EXISTS environment_revision_repositories_primary_unique_idx
  ON environment_revision_repositories(revision_id)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS environment_revision_repositories_revision_position_idx
  ON environment_revision_repositories(revision_id, position ASC);

CREATE TABLE IF NOT EXISTS environment_group_shares (
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (environment_id, group_id)
);

CREATE INDEX IF NOT EXISTS environment_group_shares_group_id_idx
  ON environment_group_shares(group_id);

CREATE TABLE IF NOT EXISTS environment_activity (
  id uuid PRIMARY KEY,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (type IN (
    'environment_created',
    'revision_published',
    'sharing_changed',
    'owner_transferred',
    'environment_renamed',
    'environment_archived',
    'environment_unarchived'
  )),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  revision_id uuid REFERENCES environment_revisions(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS environment_activity_environment_created_idx
  ON environment_activity(environment_id, created_at DESC, id DESC);

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments(id) ON DELETE RESTRICT;

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS environment_revision_policy text;

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS environment_revision_id uuid REFERENCES environment_revisions(id) ON DELETE RESTRICT;

ALTER TABLE automations
  ADD CONSTRAINT automations_environment_revision_policy_check CHECK (
    (environment_id IS NULL AND environment_revision_policy IS NULL AND environment_revision_id IS NULL)
    OR
    (environment_id IS NOT NULL AND environment_revision_policy = 'follow_latest' AND environment_revision_id IS NULL)
    OR
    (environment_id IS NOT NULL AND environment_revision_policy = 'pinned' AND environment_revision_id IS NOT NULL)
  );

ALTER TABLE automations
  ADD CONSTRAINT automations_environment_revision_belongs_to_environment_fk
  FOREIGN KEY (environment_id, environment_revision_id)
  REFERENCES environment_revisions(environment_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS automations_environment_id_idx
  ON automations(environment_id)
  WHERE environment_id IS NOT NULL;

ALTER TABLE automation_invocations
  ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments(id) ON DELETE RESTRICT;

ALTER TABLE automation_invocations
  ADD COLUMN IF NOT EXISTS environment_revision_id uuid REFERENCES environment_revisions(id) ON DELETE RESTRICT;

ALTER TABLE automation_invocations
  ADD CONSTRAINT automation_invocations_environment_revision_pair_check CHECK (
    (environment_id IS NULL AND environment_revision_id IS NULL)
    OR (environment_id IS NOT NULL AND environment_revision_id IS NOT NULL)
  );

ALTER TABLE automation_invocations
  ADD CONSTRAINT automation_invocations_environment_revision_belongs_to_environment_fk
  FOREIGN KEY (environment_id, environment_revision_id)
  REFERENCES environment_revisions(environment_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS automation_invocations_environment_revision_idx
  ON automation_invocations(environment_id, environment_revision_id)
  WHERE environment_id IS NOT NULL;
