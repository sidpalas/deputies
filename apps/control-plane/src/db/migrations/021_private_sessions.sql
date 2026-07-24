ALTER TABLE sessions
  ADD COLUMN visibility text NOT NULL DEFAULT 'tenant',
  ADD COLUMN owner_user_id uuid REFERENCES auth_users(id),
  ADD CONSTRAINT sessions_visibility_check CHECK (visibility IN ('tenant', 'private')) NOT VALID,
  ADD CONSTRAINT sessions_private_owner_check CHECK (visibility <> 'private' OR owner_user_id IS NOT NULL) NOT VALID;

CREATE FUNCTION enforce_session_access_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
    RAISE EXCEPTION 'session owner is immutable';
  END IF;
  IF OLD.visibility = 'tenant' AND NEW.visibility = 'private' THEN
    RAISE EXCEPTION 'tenant sessions cannot become private';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_access_immutable
BEFORE UPDATE OF visibility, owner_user_id ON sessions
FOR EACH ROW EXECUTE FUNCTION enforce_session_access_immutability();
