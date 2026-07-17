CREATE TABLE IF NOT EXISTS skills (
  id uuid PRIMARY KEY,
  owner_kind text NOT NULL CHECK (owner_kind IN ('user', 'group')),
  owner_group_id uuid REFERENCES groups(id) ON DELETE RESTRICT,
  owner_user_id uuid REFERENCES auth_users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  current_revision_id uuid NOT NULL,
  current_revision_number integer NOT NULL CHECK (current_revision_number > 0),
  auto_load boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  share_mode text NOT NULL DEFAULT 'none' CHECK (share_mode IN ('none', 'specific', 'all_groups')),
  created_by_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((owner_kind = 'group') = (owner_group_id IS NOT NULL)),
  CHECK ((owner_kind = 'user') = (owner_user_id IS NOT NULL)),
  CHECK (owner_kind = 'group' OR share_mode = 'none')
);

CREATE UNIQUE INDEX IF NOT EXISTS skills_group_name_idx
  ON skills (owner_group_id, lower(name)) WHERE owner_group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS skills_user_name_idx
  ON skills (owner_user_id, lower(name)) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS skills_share_mode_idx ON skills (share_mode) WHERE share_mode <> 'none';

CREATE TABLE IF NOT EXISTS skill_revisions (
  id uuid PRIMARY KEY,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  name text NOT NULL,
  description text NOT NULL,
  body text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(skill_id, revision_number),
  UNIQUE(skill_id, id)
);

CREATE INDEX IF NOT EXISTS skill_revisions_skill_number_idx
  ON skill_revisions(skill_id, revision_number DESC);

ALTER TABLE skills
  ADD CONSTRAINT skills_current_revision_fk
  FOREIGN KEY (id, current_revision_id)
  REFERENCES skill_revisions(skill_id, id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS skill_group_shares (
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (skill_id, group_id)
);

CREATE INDEX IF NOT EXISTS skill_group_shares_group_id_idx ON skill_group_shares (group_id);
