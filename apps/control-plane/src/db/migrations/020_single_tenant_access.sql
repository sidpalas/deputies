-- Collapse group RBAC into one tenant-wide role and resource namespace.
-- The migration runner executes each migration in a transaction.

-- Acquire the locks up front. Otherwise a pre-migration process could insert
-- group-scoped rows after the snapshots below but before the ownership columns
-- and group tables are removed.
LOCK TABLE auth_users, groups, group_members, sessions, messages, automations,
  environments, environment_group_shares, skills, skill_revisions,
  skill_group_shares, explicit_notepads, notepad_associations
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE auth_users DROP CONSTRAINT IF EXISTS auth_users_role_check;
ALTER TABLE auth_users ALTER COLUMN role DROP DEFAULT;

UPDATE auth_users u
SET role = CASE
  -- Existing installations still use the pre-single-tenant role name.  Accept
  -- `admin` as well so development databases which tested an earlier version
  -- of this migration can be rebuilt deterministically.
  WHEN u.role IN ('super_admin', 'admin') THEN 'admin'
  WHEN EXISTS (
    SELECT 1
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.user_id = u.id
      AND g.archived_at IS NULL
      AND gm.role IN ('member', 'admin')
  ) THEN 'member'
  ELSE 'viewer'
END;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth_users)
     AND NOT EXISTS (SELECT 1 FROM auth_users WHERE role = 'admin') THEN
    RAISE EXCEPTION 'single-tenant migration requires an administrator: configure/promote at least one super_admin before migrating';
  END IF;
END $$;

ALTER TABLE auth_users ALTER COLUMN role SET DEFAULT 'member';
ALTER TABLE auth_users ADD CONSTRAINT auth_users_role_check CHECK (role IN ('viewer', 'member', 'admin'));

-- Materialize the effective archive state before removing group ownership.
UPDATE sessions s
SET status = 'archived', updated_at = GREATEST(s.updated_at, g.archived_at)
FROM groups g
WHERE s.owner_group_id = g.id AND g.archived_at IS NOT NULL AND s.status <> 'archived';

UPDATE messages m
SET status = 'cancelled'
FROM sessions s
WHERE m.session_id = s.id AND s.status = 'archived' AND m.status = 'pending';

UPDATE automations a
SET archived_at = COALESCE(a.archived_at, g.archived_at),
    updated_at = GREATEST(a.updated_at, g.archived_at),
    enabled = false,
    next_invocation_at = NULL,
    scheduler_lock_owner = NULL,
    scheduler_locked_until = NULL
FROM groups g
WHERE a.owner_group_id = g.id AND g.archived_at IS NOT NULL;

UPDATE environments e
SET archived_at = COALESCE(e.archived_at, g.archived_at),
    updated_at = GREATEST(e.updated_at, g.archived_at)
FROM groups g
WHERE e.owner_group_id = g.id AND g.archived_at IS NOT NULL;

UPDATE skills s
SET archived_at = COALESCE(s.archived_at, g.archived_at),
    updated_at = GREATEST(s.updated_at, g.archived_at)
FROM groups g
WHERE s.owner_group_id = g.id AND g.archived_at IS NOT NULL;

ALTER TABLE explicit_notepads ADD COLUMN archived_at timestamptz;
UPDATE explicit_notepads n
SET archived_at = g.archived_at, updated_at = GREATEST(n.updated_at, g.archived_at)
FROM groups g
WHERE n.owner_group_id = g.id AND g.archived_at IS NOT NULL;

-- Names used to be unique only within an owner.  Build all proposed tenant
-- names before changing any rows, and include archived rows so restoring one
-- can never violate the tenant-wide indexes below.  The oldest row (UUID as a
-- stable tie-breaker) keeps the unsuffixed name.  A proposed suffix which is
-- already present, or is proposed by more than one row, gets the resource's
-- stable UUID suffix.
CREATE TEMP TABLE single_tenant_renames (
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  old_name text NOT NULL,
  proposed_name text NOT NULL,
  created_at timestamptz NOT NULL,
  final_name text,
  PRIMARY KEY (resource_type, resource_id)
) ON COMMIT DROP;

CREATE TEMP TABLE single_tenant_used_names (
  resource_type text NOT NULL,
  normalized_name text NOT NULL
) ON COMMIT DROP;

INSERT INTO single_tenant_used_names
SELECT 'environment', lower(btrim(name)) FROM environments
UNION ALL SELECT 'skill', lower(btrim(name)) FROM skills WHERE owner_kind = 'group';

INSERT INTO single_tenant_renames(resource_type, resource_id, old_name, proposed_name, created_at)
SELECT 'environment', e.id, e.name,
       e.name || ' (' || COALESCE(g.name, u.username, 'unknown') || ')', e.created_at
FROM (
  SELECT e.*, row_number() OVER (PARTITION BY lower(btrim(e.name)) ORDER BY e.created_at, e.id) AS duplicate_rank
  FROM environments e
) e
LEFT JOIN groups g ON g.id = e.owner_group_id
LEFT JOIN auth_users u ON false
WHERE e.duplicate_rank > 1;

INSERT INTO single_tenant_renames(resource_type, resource_id, old_name, proposed_name, created_at)
SELECT 'skill', s.id, s.name,
       regexp_replace(left(s.name, 39), '-+$', '') || '-' ||
         COALESCE(NULLIF(left(btrim(lower(regexp_replace(g.name, '[^a-zA-Z0-9]+', '-', 'g')), '-'), 24), ''),
                  left(replace(s.id::text, '-', ''), 12)),
       s.created_at
FROM (
  SELECT s.*, row_number() OVER (PARTITION BY lower(btrim(s.name)) ORDER BY s.created_at, s.id) AS duplicate_rank
  FROM skills s WHERE s.owner_kind = 'group'
) s
LEFT JOIN groups g ON g.id = s.owner_group_id
LEFT JOIN auth_users u ON u.id = s.owner_user_id
WHERE s.duplicate_rank > 1;

-- Allocate in stable row order. All original active and archived names remain
-- reserved while allocating, then each allocation is reserved immediately.
-- This also handles names which already look like migration-generated names.
DO $$
DECLARE
  r record;
  candidate text;
  fallback text;
  counter integer;
BEGIN
  FOR r IN
    SELECT * FROM single_tenant_renames
    ORDER BY resource_type, created_at, resource_id
  LOOP
    candidate := r.proposed_name;
    IF EXISTS (
      SELECT 1 FROM single_tenant_used_names u
      WHERE u.resource_type = r.resource_type
        AND u.normalized_name = lower(btrim(candidate))
    ) THEN
      counter := 1;
      IF r.resource_type = 'skill' THEN
        candidate := regexp_replace(left(r.old_name, 30), '-+$', '') || '-' || md5(r.resource_id::text || ':' || counter);
      ELSE
        fallback := regexp_replace(r.proposed_name, '\)$', ', ' || r.resource_id::text || ')');
        candidate := fallback;
      END IF;
      WHILE EXISTS (
        SELECT 1 FROM single_tenant_used_names u
        WHERE u.resource_type = r.resource_type
          AND u.normalized_name = lower(btrim(candidate))
      ) LOOP
        counter := counter + 1;
        IF r.resource_type = 'skill' THEN
          candidate := regexp_replace(left(r.old_name, 30), '-+$', '') || '-' || md5(r.resource_id::text || ':' || counter);
        ELSE
          candidate := fallback || ' (' || counter || ')';
        END IF;
      END LOOP;
    END IF;

    UPDATE single_tenant_renames SET final_name = candidate
    WHERE resource_type = r.resource_type AND resource_id = r.resource_id;
    INSERT INTO single_tenant_used_names VALUES (r.resource_type, lower(btrim(candidate)));
  END LOOP;
END $$;

UPDATE environments e SET name = r.final_name
FROM single_tenant_renames r WHERE r.resource_type = 'environment' AND r.resource_id = e.id;
UPDATE skills s SET name = r.final_name
FROM single_tenant_renames r WHERE r.resource_type = 'skill' AND r.resource_id = s.id;
-- Revision names are display metadata. Preserve intentionally different
-- historical names, while keeping revisions which mirrored the resource name
-- coherent with the deterministic rename.
UPDATE skill_revisions sr SET name = r.final_name
FROM single_tenant_renames r
JOIN skills s ON s.id = r.resource_id
WHERE r.resource_type = 'skill'
  AND sr.id = s.current_revision_id
  AND sr.name = r.old_name;

-- Flush the deferred current-revision foreign-key checks before replacing
-- indexes on their resource tables. PostgreSQL rejects CREATE INDEX while an
-- updated table still has pending deferred constraint-trigger events.
SET CONSTRAINTS ALL IMMEDIATE;

DROP TRIGGER IF EXISTS sessions_owner_immutable ON sessions;
DROP TRIGGER IF EXISTS explicit_notepads_owner_immutable ON explicit_notepads;
DROP FUNCTION IF EXISTS reject_notepad_owner_change();
DROP TRIGGER IF EXISTS notepad_association_same_group ON notepad_associations;
DROP FUNCTION IF EXISTS enforce_notepad_association_group();

DROP TABLE environment_group_shares;
DROP TABLE skill_group_shares;

DROP INDEX IF EXISTS sessions_owner_group_updated_idx;
DROP INDEX IF EXISTS sessions_owner_activity_idx;
DROP INDEX IF EXISTS sessions_owner_status_activity_idx;
ALTER TABLE sessions DROP COLUMN owner_group_id, DROP COLUMN visibility, DROP COLUMN write_policy;

DROP INDEX IF EXISTS automations_owner_group_active_idx;
DROP INDEX IF EXISTS automations_owner_group_updated_idx;
ALTER TABLE automations DROP COLUMN owner_group_id, DROP COLUMN visibility, DROP COLUMN write_policy;

DROP INDEX IF EXISTS environments_owner_group_name_active_unique_idx;
DROP INDEX IF EXISTS environments_owner_group_updated_idx;
CREATE UNIQUE INDEX environments_name_unique_idx ON environments(lower(btrim(name)));
ALTER TABLE environments DROP COLUMN owner_group_id, DROP COLUMN share_mode;

DROP INDEX IF EXISTS skills_group_name_idx;
DROP INDEX IF EXISTS skills_user_name_idx;
DROP INDEX IF EXISTS skills_share_mode_idx;
UPDATE skills SET created_by_user_id = COALESCE(created_by_user_id, owner_user_id), auto_load = false
WHERE owner_kind = 'user';
ALTER TABLE skills
  DROP CONSTRAINT IF EXISTS skills_owner_kind_check,
  DROP CONSTRAINT IF EXISTS skills_owner_group_check,
  DROP CONSTRAINT IF EXISTS skills_owner_user_check,
  DROP CONSTRAINT IF EXISTS skills_share_mode_check,
  DROP CONSTRAINT IF EXISTS skills_check,
  DROP CONSTRAINT IF EXISTS skills_check1,
  DROP CONSTRAINT IF EXISTS skills_check2;
ALTER TABLE skills RENAME COLUMN owner_kind TO scope;
UPDATE skills SET scope = CASE scope WHEN 'group' THEN 'tenant' ELSE 'personal' END;
ALTER TABLE skills DROP COLUMN owner_group_id, DROP COLUMN share_mode;
ALTER TABLE skills ADD CONSTRAINT skills_scope_check CHECK (
  (scope = 'tenant' AND owner_user_id IS NULL) OR
  (scope = 'personal' AND owner_user_id IS NOT NULL AND auto_load = false)
);
CREATE UNIQUE INDEX skills_tenant_name_unique_idx ON skills(lower(btrim(name))) WHERE scope = 'tenant';
CREATE UNIQUE INDEX skills_personal_active_owner_name_unique_idx
  ON skills(owner_user_id, lower(btrim(name))) WHERE scope = 'personal' AND archived_at IS NULL;

DROP INDEX IF EXISTS explicit_notepads_group_idx;
ALTER TABLE explicit_notepads DROP COLUMN owner_group_id, DROP COLUMN visibility, DROP COLUMN write_policy;

DROP TABLE group_members;
DROP TABLE groups;

-- Serialize role/removal operations and reject removing the final tenant admin.
CREATE FUNCTION protect_final_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(2147483647, 2020);
  IF OLD.role = 'admin' AND (TG_OP = 'DELETE' OR NEW.role <> 'admin')
     AND NOT EXISTS (SELECT 1 FROM auth_users WHERE role = 'admin' AND id <> OLD.id) THEN
    RAISE EXCEPTION 'cannot demote or remove the final administrator';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER auth_users_protect_final_admin
  BEFORE UPDATE OF role OR DELETE ON auth_users
  FOR EACH ROW EXECUTE FUNCTION protect_final_admin();
