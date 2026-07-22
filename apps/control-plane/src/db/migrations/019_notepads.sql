CREATE TABLE session_notepads (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 0), content text NOT NULL, size_bytes integer NOT NULL CHECK (size_bytes = octet_length(content) AND size_bytes <= 262144),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE explicit_notepads (
  id uuid PRIMARY KEY, title text NOT NULL CHECK (length(btrim(title)) > 0),
  owner_group_id uuid NOT NULL REFERENCES groups(id), visibility text NOT NULL CHECK (visibility IN ('group','organization')),
  write_policy text NOT NULL CHECK (write_policy IN ('group_members','creator_only')), revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0), content text NOT NULL DEFAULT '',
  size_bytes integer NOT NULL DEFAULT 0 CHECK (size_bytes = octet_length(content) AND size_bytes <= 262144), created_by_user_id uuid REFERENCES auth_users(id),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX explicit_notepads_group_idx ON explicit_notepads(owner_group_id, updated_at DESC);
CREATE TABLE notepad_revisions (
  notepad_kind text NOT NULL CHECK (notepad_kind IN ('session','explicit')), notepad_id uuid NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  content text NOT NULL, size_bytes integer NOT NULL CHECK (size_bytes = octet_length(content) AND size_bytes <= 262144), actor jsonb NOT NULL CHECK (jsonb_typeof(actor)='object' AND actor->>'kind' IN ('human','agent','system') AND (actor->>'kind'<>'human' OR actor ? 'userId') AND (actor->>'kind'<>'agent' OR (actor ? 'sessionId' AND actor ? 'runId'))),
  mutation_kind text NOT NULL CHECK (mutation_kind IN ('replace','patch','append','restore')), created_at timestamptz NOT NULL,
  PRIMARY KEY(notepad_kind, notepad_id, revision)
);
CREATE FUNCTION retain_latest_notepad_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM notepad_revisions
  WHERE notepad_kind=NEW.notepad_kind AND notepad_id=NEW.notepad_id AND revision <= NEW.revision - 50;
  RETURN NEW;
END $$;
CREATE TRIGGER notepad_revisions_retain_latest AFTER INSERT ON notepad_revisions FOR EACH ROW EXECUTE FUNCTION retain_latest_notepad_revisions();
CREATE TABLE notepad_associations (
  notepad_id uuid NOT NULL REFERENCES explicit_notepads(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES auth_users(id), created_at timestamptz NOT NULL,
  PRIMARY KEY(notepad_id, session_id)
);
CREATE INDEX notepad_associations_session_idx ON notepad_associations(session_id);
CREATE TABLE session_notepad_capabilities (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind text NOT NULL CHECK (kind IN ('explicit_search','session_notepad_coordination')),
  granted_by_user_id uuid NOT NULL REFERENCES auth_users(id), created_at timestamptz NOT NULL,
  PRIMARY KEY(session_id, kind)
);
CREATE TABLE notepad_activity (
  id uuid PRIMARY KEY, notepad_id uuid NOT NULL REFERENCES explicit_notepads(id) ON DELETE CASCADE,
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor)='object' AND actor->>'kind' IN ('human','agent','system') AND (actor->>'kind'<>'human' OR actor ? 'userId') AND (actor->>'kind'<>'agent' OR (actor ? 'sessionId' AND actor ? 'runId'))), kind text NOT NULL CHECK (kind IN ('created','metadata_changed','revision_restored','association_granted','association_changed','association_revoked')), metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata)='object'), created_at timestamptz NOT NULL
);
CREATE INDEX notepad_activity_notepad_idx ON notepad_activity(notepad_id, created_at DESC, id DESC);

CREATE FUNCTION reject_notepad_owner_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_group_id IS DISTINCT FROM OLD.owner_group_id THEN RAISE EXCEPTION 'notepad owner is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_owner_immutable BEFORE UPDATE OF owner_group_id ON sessions FOR EACH ROW EXECUTE FUNCTION reject_notepad_owner_change();
CREATE TRIGGER explicit_notepads_owner_immutable BEFORE UPDATE OF owner_group_id ON explicit_notepads FOR EACH ROW EXECUTE FUNCTION reject_notepad_owner_change();

CREATE FUNCTION enforce_notepad_association_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM explicit_notepads n JOIN sessions s ON s.id=NEW.session_id WHERE n.id=NEW.notepad_id AND n.owner_group_id=s.owner_group_id) THEN
    RAISE EXCEPTION 'notepad and session must belong to the same group';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notepad_association_same_group BEFORE INSERT OR UPDATE ON notepad_associations FOR EACH ROW EXECUTE FUNCTION enforce_notepad_association_group();

CREATE FUNCTION delete_session_notepad_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN DELETE FROM notepad_revisions WHERE notepad_kind='session' AND notepad_id=OLD.id; RETURN OLD; END $$;
CREATE TRIGGER sessions_delete_notepad_revisions BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION delete_session_notepad_revisions();
CREATE FUNCTION delete_explicit_notepad_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN DELETE FROM notepad_revisions WHERE notepad_kind='explicit' AND notepad_id=OLD.id; RETURN OLD; END $$;
CREATE TRIGGER explicit_notepads_delete_revisions BEFORE DELETE ON explicit_notepads FOR EACH ROW EXECUTE FUNCTION delete_explicit_notepad_revisions();
