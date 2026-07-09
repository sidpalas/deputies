CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  owner_group_id uuid NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  share_mode text NOT NULL DEFAULT 'private' CHECK (share_mode IN ('private', 'selected_groups', 'all_groups')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS environments_owner_group_name_active_unique_idx
  ON environments(owner_group_id, lower(btrim(name)))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS environments_owner_group_updated_idx
  ON environments(owner_group_id, updated_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS environment_repositories (
  id uuid PRIMARY KEY,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
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

CREATE UNIQUE INDEX IF NOT EXISTS environment_repositories_identity_unique_idx
  ON environment_repositories(environment_id, provider, lower(owner), lower(repo));

CREATE UNIQUE INDEX IF NOT EXISTS environment_repositories_primary_unique_idx
  ON environment_repositories(environment_id)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS environment_repositories_environment_position_idx
  ON environment_repositories(environment_id, position ASC);

CREATE TABLE IF NOT EXISTS environment_group_shares (
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (environment_id, group_id)
);

CREATE INDEX IF NOT EXISTS environment_group_shares_group_id_idx
  ON environment_group_shares(group_id);

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS automations_environment_id_idx
  ON automations(environment_id)
  WHERE environment_id IS NOT NULL;
