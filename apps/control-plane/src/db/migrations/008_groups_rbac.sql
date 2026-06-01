CREATE TABLE IF NOT EXISTS groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  default_visibility text NOT NULL DEFAULT 'organization' CHECK (default_visibility IN ('group', 'organization')),
  default_write_policy text NOT NULL DEFAULT 'group_members' CHECK (default_write_policy IN ('group_members', 'creator_only')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE groups ADD COLUMN IF NOT EXISTS archived_at timestamptz;

UPDATE groups
SET name = btrim(name)
WHERE name <> btrim(name);

CREATE UNIQUE INDEX IF NOT EXISTS groups_name_unique_idx ON groups (lower(btrim(name)));

INSERT INTO groups (id, name, default_visibility, default_write_policy, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Default',
  'organization',
  'group_members',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer', 'member', 'admin')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS group_members_user_id_idx ON group_members(user_id);

INSERT INTO group_members (group_id, user_id, role, created_at, updated_at)
SELECT
  '00000000-0000-4000-8000-000000000001',
  id,
  CASE WHEN role = 'admin' THEN 'admin' ELSE 'viewer' END,
  now(),
  now()
FROM auth_users
ON CONFLICT (group_id, user_id) DO NOTHING;

ALTER TABLE auth_users DROP CONSTRAINT IF EXISTS auth_users_role_check;

UPDATE auth_users
SET role = CASE WHEN role = 'admin' THEN 'super_admin' ELSE 'user' END
WHERE role IN ('admin', 'viewer');

ALTER TABLE auth_users ALTER COLUMN role SET DEFAULT 'user';
ALTER TABLE auth_users ADD CONSTRAINT auth_users_role_check CHECK (role IN ('user', 'super_admin'));

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS owner_group_id uuid REFERENCES groups(id) ON DELETE RESTRICT;
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'organization' CHECK (visibility IN ('group', 'organization'));
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS write_policy text NOT NULL DEFAULT 'group_members' CHECK (write_policy IN ('group_members', 'creator_only'));
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL;

UPDATE sessions
SET owner_group_id = '00000000-0000-4000-8000-000000000001'
WHERE owner_group_id IS NULL;

ALTER TABLE sessions ALTER COLUMN owner_group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_owner_group_updated_idx
  ON sessions(owner_group_id, updated_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_created_by_user_id_idx ON sessions(created_by_user_id);
