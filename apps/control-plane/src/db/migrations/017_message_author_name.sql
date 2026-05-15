ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_name text;
