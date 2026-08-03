CREATE TABLE integration_credentials (
  id uuid PRIMARY KEY,

  scope text NOT NULL CHECK (scope = 'tenant'),

  namespace text NOT NULL CHECK (length(btrim(namespace)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),

  payload_schema text NOT NULL CHECK (length(btrim(payload_schema)) > 0),
  payload_version integer NOT NULL CHECK (payload_version > 0),

  encryption_version integer NOT NULL CHECK (encryption_version = 1),
  encryption_key_id text NOT NULL CHECK (length(btrim(encryption_key_id)) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 65536),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),

  pending_operation_id uuid,
  pending_operation_started_at timestamptz,

  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT integration_credentials_pending_operation_shape
    CHECK ((pending_operation_id IS NULL) = (pending_operation_started_at IS NULL)),
  UNIQUE (scope, namespace, name)
);
