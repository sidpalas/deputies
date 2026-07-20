CREATE TABLE snippets (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  body text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX snippets_active_owner_name_unique
  ON snippets (owner_user_id, name) WHERE archived_at IS NULL;
