# Secrets And Configuration Foundation

## Status

Implemented — initial foundation. The delivered scope is intentionally limited to durable deployment-wide OpenAI Codex credentials and the shared cryptographic/storage foundation. Tenant/user settings, user-linked provider accounts, dynamic Executor identities, and general credential brokering are designed here but remain follow-up work.

### Initial delivery completed

- Added the tenant-only `integration_credentials` schema, strict `pi.oauth/v1` codec, AES-256-GCM keyring, authenticated row identity, revisions, and PostgreSQL advisory-lock repository.
- Added a durable pending-operation fence so replicas fail closed instead of replaying an observed refresh token after an uncertain provider/write outcome.
- Integrated Pi 0.83 through its public `CredentialStore` and `ModelRuntime` APIs without a Pi patch, in-memory PostgreSQL snapshot, or JSON persistence bridge.
- Made environment base64 bootstrap-only in PostgreSQL mode: an existing database credential always wins, refresh replacements are persisted before use, and decryption/validation failures fail closed.
- Preserved explicit local `file` and transitional `legacy-base64` modes while making PostgreSQL mode the deployment default for Docker Compose and an invariant of the Helm chart.
- Added chart-owned and externally managed Secret paths for the integration credential keyring and optional Codex bootstrap seed; updated Railway, Compose, Helm, environment, and deployment guidance.
- Added unit and PostgreSQL integration coverage for crypto, codecs, bootstrap races, cross-replica refresh serialization, ambiguous-write recovery, restart durability, and Pi runtime wiring.
- Hardened sandbox-secret cleanup as separate lifecycle behavior without merging sandbox secrets into integration credentials.
- Validated the complete operator path with an intentionally expired access token: environment bootstrap created revision 1, OpenAI refresh persisted revision 2, and a restart succeeded after removing `OPENAI_CODEX_AUTH_BASE64`.

The future sections below remain design constraints, not claims that their deferred product surfaces have shipped.

## Context

At design time, Deputies had several unrelated configuration and secret paths:

- deployment configuration and provider credentials come from environment variables;
- OpenAI Codex auth may come from a Pi auth file or `OPENAI_CODEX_AUTH_BASE64`;
- `OPENAI_CODEX_AUTH_BASE64` was decoded into Pi's `InMemoryCredentialStore`, so a successful access/refresh-token rotation was lost when the process restarted;
- multiple replicas initialized from the same base64 refresh token could independently attempt to rotate it;
- sandbox reconnect secrets are encrypted in `sandbox_secrets` with one non-versioned deployment key;
- MCP/Executor headers are deployment-wide static configuration;
- most authenticated tools run in the trusted control-plane worker, and long-lived provider credentials do not enter the sandbox;
- persisted application settings are feature-specific, most notably the tenant agent-profile configuration; there is no general tenant/user settings service.

The immediate bug is Codex refresh durability, but solving it with another Codex-only file or table would create the wrong long-term boundary. Expected follow-up features include:

- tenant-managed settings and user preferences;
- deployment defaults overridden at tenant and user scope;
- tenant-wide and user-linked provider credentials;
- personal Codex accounts with an optional tenant credential fallback;
- a tenant Executor service identity for shared data sources;
- personal Executor identities for user-owned upstream connections;
- other OAuth credentials, API keys, webhook secrets, and integration credentials;
- rotation of Deputies encryption keys and external provider credentials;
- control-plane credential brokering without exposing long-lived credentials to sandboxes.

This spec defines a foundation that fixes the current defect without requiring those features to ship together.

## Decision Summary

1. PostgreSQL is the authoritative store for application-managed integration credentials.
2. Environment secrets may bootstrap a credential exactly once; they never overwrite an existing database credential.
3. Settings and credentials share ownership terminology and resolution context, but use separate tables and services.
4. Settings are typed, validated JSON values. Credentials are typed, versioned encrypted payloads.
5. The current product has one tenant per deployment/database. `tenant` means that existing singleton tenant; this work does not introduce partial multi-tenancy.
6. Credential encryption uses versioned direct AES-256-GCM keys in the initial implementation, explicit key IDs, canonical associated data, and dual-read/single-write rotation. Envelope encryption is deferred until there is a concrete tenant/KMS or scale requirement.
7. Credential refresh is serialized across replicas with a PostgreSQL session advisory lock held across the provider exchange and durable write, without holding a SQL transaction open during network I/O.
8. Provider refresh and database persistence cannot be made atomic. The implementation minimizes and reports the irreducible failure window rather than claiming exactly-once external rotation.
9. Long-lived integration credentials remain in the control plane. No generic secret-read tool or sandbox injection API is introduced.
10. The initial implementation supports only the tenant-wide `model-provider/openai-codex` credential. Tenant/user identity is settled at the design level, but user columns and rows are added only when authorization, linking, and deletion ship.
11. Database-backed settings are specified but are not required to fix Codex. They should ship when the first concrete tenant/user setting is migrated rather than as unused infrastructure.

## Terminology

### Deployment configuration

Operator-controlled values needed before or while the database is opened, including:

- database URL;
- encryption keyring;
- network binding and process mode;
- storage/sandbox provider credentials;
- bootstrap credential material;
- hard security ceilings and feature availability.

These remain environment/secret-manager configuration. In-app settings cannot override a deployment capability or safety ceiling.

### Setting

A non-secret, typed product value that may have a built-in/deployment default and tenant or user override. Examples include default model, default reasoning level, UI preferences, or whether tenant credential fallback is allowed.

### Integration credential

A secret used by the control plane to authenticate to an external service, such as an OAuth credential, API key, Executor personal key, webhook signing secret, or provider client secret. The encrypted payload remains provider-specific even though storage is shared.

### Sandbox runtime secret

A capability needed to create, reconnect to, or operate one sandbox, such as the current sandbox bridge token. Its owner and lifecycle are the sandbox, not a tenant/user integration. These remain separate from integration credentials.

### Principal

The identity whose setting or credential is selected:

```ts
type ConfigurationPrincipal = { scope: 'tenant' } | { scope: 'user'; userId: string };
```

This is an application identity, not raw caller input. The API/worker derives it from authenticated and durably persisted request provenance.

### Execution principal

The user or tenant/service identity selected for one run. It must be explicit for asynchronous work. It is not always the session creator:

- an interactive run normally uses the triggering message author;
- a title uses the first message author;
- subagents inherit the parent run's execution principal;
- an automation persists its selected principal at creation;
- work with no user may use an explicitly configured tenant service identity.

## Goals

- Make refreshed OpenAI Codex credentials survive worker/container restarts.
- Serialize one refresh-token chain across multiple control-plane replicas.
- Establish one reusable encrypted integration-credential storage mechanism.
- Support dual-read/single-write Deputies key transitions without duplicate credential payloads, while deferring old-key retirement tooling.
- Preserve provider-specific payload validation and refresh semantics.
- Establish a typed tenant/user settings model and precedence rules for follow-up work.
- Ensure future personal credentials and tenant fallback fit the same ownership model.
- Ensure future Executor personal and shared connections fit without exposing upstream credentials to Deputies sandboxes.
- Preserve the existing control-plane credential boundary.
- Provide explicit migration, rollback, observability, and failure semantics.

## Non-Goals

The initial delivery does not:

- add a user-facing settings page;
- migrate existing feature configuration into generic settings;
- add per-user Codex linking;
- add provider OAuth callback APIs;
- add tenant or user Executor connection UI;
- move static `MCP_SERVERS` configuration into PostgreSQL;
- implement a general control-plane egress proxy;
- expose credentials to sandbox commands;
- redesign the sandbox bridge token;
- merge `sandbox_secrets` into the integration credential table;
- introduce a `tenants` table or multi-tenant authorization;
- build arbitrary user-defined secret storage;
- automatically create/revoke arbitrary provider API keys;
- implement envelope encryption or an external KMS/HSM integration;
- promise recovery from provider-side revocation or every crash point in rotating OAuth protocols.

## Security And Product Invariants

### Settings and secrets are not interchangeable

- A setting value can be returned by a settings API to an authorized caller.
- A credential value cannot be returned through a generic product API or agent tool.
- Credential status may expose safe metadata such as configured/missing, source scope, provider account label, expiry category, and reauthorization state.
- Raw ciphertext, nonces, tags, access tokens, refresh tokens, and API keys never enter product events, prompts, artifacts, tool arguments/results, traces, or normal logs. Non-secret key IDs may appear only in operator-facing rotation diagnostics.

### Credential management source is explicit

Each integration deployment chooses one management mode rather than inferring precedence from whether a database row happens to exist:

- `deployment`: deployment configuration or an external secret store is authoritative. Deputies does not create a credential row, and UI/API mutation is disabled for that integration.
- `managed`: PostgreSQL is authoritative. UI/API connection may be supported, and deployment material may seed an absent row once.

An environment variable is a suitable authoritative source for an immutable or operator-rotated API key. It cannot by itself be authoritative for rotating OAuth while also preserving refreshed state across process or container restarts. A deployment-managed OAuth credential therefore requires either an external secret-store adapter with atomic read/write support or acceptance that refreshed state is nondurable. Environment variables containing pointers, secret names, or mount locations may configure such an adapter; they should not contain a rotating credential that Deputies is expected to write back into the process environment.

Credential status should report management (`deployment`, `managed`, or a future named external store) separately from ownership scope (`tenant` or `user`). Connect, replace, disconnect, and rotate operations must reject attempts to mutate deployment-managed credentials rather than creating a shadow database value.

This is a settled design constraint, not a request for a generic credential-source framework in the initial delivery. Initially:

- the explicit Codex storage mode is the only source-selection mechanism;
- `integration_credentials` contains only application-managed PostgreSQL credentials;
- deployment-managed credentials remain outside that table;
- no generic management-mode column, source registry, external secret-store adapter, deployment-credential status API, or UI mutation policy is implemented.

Add those product/API concepts when the first credential-linking UI or second managed provider makes them concrete. Until then, provider-specific configuration must select the source explicitly; absence of a database row is not itself a source-selection rule.

### Database state is authoritative in managed mode

- Bootstrap material is used only when the target credential does not exist.
- An existing row wins even if an environment seed differs.
- Decryption or validation failure fails closed; it must not cause silent reseeding from a stale environment value.
- Operators should remove bootstrap material after successful cutover.

### A broken personal credential is not equivalent to an absent credential

Future fallback behavior must distinguish:

```text
personal credential absent
    -> tenant fallback may be allowed by policy

personal credential present but expired/revoked/invalid
    -> fail and request reconnection; do not silently consume tenant credentials
```

### No long-lived credentials in sandboxes

The preferred order is:

1. a control-plane authenticated tool call;
2. an auth-injecting, operation-scoped control-plane proxy;
3. a short-lived, resource-scoped derived credential for one command;
4. raw long-lived sandbox injection only as a separately designed explicit escape hatch.

Model credentials, OAuth refresh tokens, personal Executor credentials, and provider API keys remain outside the sandbox.

### Configuration cannot expand deployment capability

Deployment configuration defines available providers, hard maximums, and security constraints. Tenant/user/request values may choose or narrow behavior but cannot enable unavailable providers or exceed hard deployment limits.

## Future Configuration Model

This section settles direction and compatibility constraints; it is a non-normative future sketch rather than initial-delivery acceptance criteria. Exact interfaces and SQL should be reviewed with the first concrete generic setting.

### UI-first onboarding direction

The expected common deployment starts with only enough operator configuration to boot and secure Deputies, then lets an authenticated tenant admin complete product setup in the existing Setup page. The initial Codex durability change does not turn that currently read-only page into a mutation surface, but new product-facing configuration should generally be designed for UI/API management rather than requiring another environment variable.

Classify values before migrating them:

| Class                          | Examples                                                                                                               | Authority and UI behavior                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| bootstrap/infrastructure       | database URL, encryption keyring, network/public URL, session-auth bootstrap, storage and sandbox backend availability | deployment-only; UI reports status but cannot override                                   |
| tenant settings                | default model/reasoning, fallback policy, enabled product behavior                                                     | typed PostgreSQL setting; deployment value is a default or hard ceiling                  |
| tenant integration credentials | Codex, Slack, GitHub installation, shared Executor identity                                                            | encrypted PostgreSQL credential by default; deployment-managed mode remains possible     |
| user settings and credentials  | preferences, personal Codex/Executor connections                                                                       | PostgreSQL under the authenticated user; never sourced from a shared process environment |

The target onboarding flow is:

1. Deputies starts with deployment bootstrap configuration.
2. An authenticated admin opens Setup and sees each capability as unavailable, deployment-managed, or application-managed.
3. For application-managed integrations, the admin connects or imports a credential and Deputies validates it before committing encrypted state.
4. The admin sets product defaults through typed forms backed by the settings service.
5. Setup performs connectivity checks without returning secret values and identifies remaining deployment-only work.

Do not copy every environment variable into generic settings at startup. Migrate one concrete setting or integration at a time, preserve its existing environment value as a deployment default or explicit deployment-managed source, and add a deliberate import/adopt action only where ownership transfer to Deputies is useful. Once application-managed state exists, removing or changing an environment default must not erase it.

### Resolution layers

The general precedence is:

```text
request override
    > user setting
    > tenant setting
    > deployment/built-in default
```

Session/run snapshots are persisted resolved results, not another override scope. Resolution is not a universal blind merge: each setting definition declares its allowed layers and combines them with deployment capabilities through setting-specific logic.

Examples:

| Setting                    | Deployment                      | Tenant           | User    | Request   |
| -------------------------- | ------------------------------- | ---------------- | ------- | --------- |
| runner default model       | available-model ceiling/default | allowed          | allowed | allowed   |
| reasoning level            | hard allowed set/default        | allowed          | allowed | allowed   |
| tenant credential fallback | default                         | allowed          | no      | no        |
| maximum run duration       | hard maximum                    | may lower        | no      | may lower |
| theme                      | default                         | optional default | allowed | no        |
| provider availability      | hard capability                 | may disable      | no      | no        |

### Definition registry

Setting keys and behavior are declared in code. The database does not create new settings merely because it can store arbitrary JSON.

```ts
type SettingDefinition<T> = {
  key: string;
  schemaVersion: number;
  parseStored(value: unknown, storedSchemaVersion: number): T;
  allowedScopes: readonly ('tenant' | 'user' | 'request')[];
  deploymentDefault(config: AppConfig): T;
  resolve(input: { deployment: T; tenant?: T; user?: T; request?: T; capabilities: DeploymentCapabilities }): T;
  snapshot: 'live' | 'session' | 'run';
  authorizeWrite(input: SettingWriteAuthorization): boolean;
};
```

Unknown keys and unsupported scopes are rejected at the service boundary. Stored values are revalidated on read. A stored version newer than the running definition fails clearly; an older version requires an explicit parser/migration path.

### Provenance

Resolution returns provenance with the effective value:

```ts
type ResolvedSetting<T> = {
  value: T;
  contributors: readonly ('request' | 'user' | 'tenant' | 'deployment')[];
  definitionVersion: number;
  storedRevisions: Partial<Record<'user' | 'tenant', number>>;
};
```

Provenance lists every contributing layer because merge/minimum/intersection resolution can combine values. It supports diagnostics, UI explanation, and correct snapshots. It must not reveal secret values; credentials use a separate status contract.

### Snapshot policy

- Reproducibility-affecting choices such as model, reasoning level, profile, tool policy, and execution limits may be snapshotted on a session or run according to their definition.
- UI preferences and tenant kill switches resolve live.
- A credential principal may be snapshotted; credential material never is.
- Existing agent-profile snapshot behavior remains authoritative until intentionally migrated.

### Future settings schema

Create these tables when the first generic tenant/user setting ships, not solely for the Codex fix:

```sql
CREATE TABLE tenant_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_settings (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
```

Separate tables preserve concrete foreign keys and simple authorization. A polymorphic `scope_type/scope_id` settings table is not justified while the product has exactly one tenant and concrete users.

Writes use optimistic concurrency: callers provide `expectedRevision`, and one conditional update increments `revision` and `updated_at`. Missing/mismatched revisions conflict rather than silently overwriting another settings edit.

Existing domain-specific configuration tables may remain domain-specific where they encode stronger relational invariants, revisions, or lifecycle. The generic settings store is for small typed overrides, not a replacement for agent profiles, environments, automations, or other domain models.

## Integration Credential Model

### Why one shared table

OAuth credentials, API keys, Executor bearer credentials, and webhook secrets can share:

- ownership keys;
- encryption and key rotation;
- typed payload envelopes;
- cross-replica locking;
- encrypted CRUD;
- revisioning and audit timestamps;
- redaction rules.

They must not share provider-specific refresh, validation, revocation, fallback, or status logic.

### Schema

Add `apps/control-plane/src/db/migrations/026_integration_credentials.sql`:

```sql
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
```

The fence is not credential metadata and does not change the encrypted payload or AAD. It records that a provider callback may have consumed the currently stored refresh token. Reads and competing modifications fail closed while it remains set.

The initial row is:

```text
scope           = tenant
namespace       = model-provider
name            = openai-codex
payload_schema  = pi.oauth
payload_version = 1
```

V1 enforces tenant-only rows. When user linking ships, an additive migration widens the scope check, adds `owner_user_id REFERENCES auth_users(id)`, replaces tenant uniqueness with partial tenant/user indexes, and adds application-level revocation-before-delete behavior. Existing credential IDs and tenant semantic keys do not change.

### Payload envelope

The decrypted JSON is typed and versioned:

```ts
type PiOAuthCredentialV1 = {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};
```

The codec enforces:

- non-empty access and refresh tokens;
- finite expiration timestamp;
- non-empty `accountId` required by Pi 0.83's Codex login/refresh shape;
- exactly the fields required by Pi 0.83's OpenAI Codex OAuth contract;
- no unknown fields, prototypes, or class instances;
- a conservative maximum decrypted payload size;
- sanitized errors that identify schema/version but never values.

A legacy seed without `accountId` fails with a fresh-login instruction rather than guessing or accepting a shape the pinned refresh path will not reproduce.

Future examples fit the same key model:

```text
tenant / integration-gateway / executor
user:A / integration-gateway / executor
user:A / model-provider / openai-codex
tenant / webhook-provider / example
```

### Metadata and account linkage

Do not put queryable expiry/status/account metadata into the initial credential row merely for speculation. When user linking ships, add a domain record for provider connection state if needed, containing only non-secret fields such as:

- external provider subject;
- display label;
- granted scopes;
- status (`active`, `reauthorization_required`, `revoked`);
- access/refresh expiry metadata;
- last validation/refresh timestamps.

The encrypted credential remains in `integration_credentials`. A richer external-principal model should be introduced only when multiple provider identities per user or organization membership makes it concrete.

## Encryption Design

### Credential keyring

The current single-key `SecretCipher` is not extended implicitly. Add a credential-specific, versioned keyring with one active write key and zero or more historical read keys.

Conceptual configuration:

```text
INTEGRATION_CREDENTIAL_ACTIVE_KEY_ID=2026-07
INTEGRATION_CREDENTIAL_ENCRYPTION_KEYS=<secret JSON map of key ID to base64 32-byte key>
```

Requirements:

- key IDs are stable non-secret identifiers;
- each value is the actual AES key and decodes to exactly 32 random bytes;
- the active ID exists in the map;
- encryption always uses the active key;
- decryption selects the exact row `encryption_key_id`;
- no fallback loop tries every key;
- keys are generated for and used only by integration credentials;
- missing historical keys fail with an actionable, value-free error.

The environment representation may be revised during implementation to fit deployment secret managers, but it must retain explicit IDs and one active key.

### Direct authenticated encryption

Initial credentials use direct AES-256-GCM:

- 12-byte random nonce per encryption;
- 16-byte authentication tag;
- the selected 32-byte keyring value directly, with no HMAC/HKDF derivation;
- `encryption_version = 1`; unknown versions are rejected;
- canonical associated authenticated data (AAD).

Canonical AAD:

```ts
JSON.stringify([
  'deputies.integration-credential',
  encryptionVersion,
  encryptionKeyId,
  id,
  scope,
  namespace,
  name,
  payloadSchema,
  payloadVersion,
]);
```

The AAD is the UTF-8 bytes of that JSON array, using canonical lowercase UUID text and exact stored text values. The cipher calls `setAAD` before encryption/decryption and uses the stored 16-byte tag. AAD binds ciphertext to its row, owner scope, and semantic interpretation. Copying ciphertext to another provider row or mutating identity columns causes decryption to fail. The future user-scope migration adds `ownerUserId ?? null` to a new encryption/AAD version rather than changing v1 interpretation.

### Why envelope encryption is deferred

Envelope encryption is valuable when Deputies has one or more of:

- a real multi-tenant model requiring tenant cryptographic isolation or crypto-erasure;
- an external KMS/HSM that wraps data-encryption keys;
- enough credential ciphertext that full-row re-encryption is operationally expensive;
- a requirement to rotate master wrapping keys without decrypting credential payloads.

The current system has one tenant and initially one database credential. Versioned direct encryption already supports safe rotation and is materially simpler. A later migration can add wrapped DEKs while preserving credential IDs and semantic keys.

### Deputies key rotation

Use dual-read/single-write phases:

1. Deploy every replica with old and new keys; old remains active.
2. Switch the active write key to new after all replicas understand the keyring.
3. New/updated credentials use new; historical rows remain readable with old.
4. Retain every historical key referenced by a live row or supported backup.

V1 supports old-key reads and new-key writes but does not retire old keys. A follow-up bounded re-encryption operation will migrate old-key rows, verify no live references remain, observe the backup retention window, and then permit retirement.

The rotation operation uses the credential advisory lock or revision compare-and-swap so it cannot overwrite a concurrent provider refresh:

```sql
UPDATE integration_credentials
SET encryption_key_id = $new_key_id,
    nonce = $nonce,
    ciphertext = $ciphertext,
    auth_tag = $auth_tag,
    revision = revision + 1,
    updated_at = now()
WHERE id = $id
  AND revision = $observed_revision
  AND encryption_key_id = $old_key_id;
```

Each row contains one encrypted credential, not old/new duplicate payloads. Runtime configuration contains every encryption key still referenced by live data or supported backups. The shown conditional update is the deferred retirement mechanism, not a v1 deliverable.

## Credential Repository And Service Boundaries

### Credential codec

```ts
interface CredentialCodec<T> {
  readonly schema: string;
  readonly version: number;
  encode(value: T): Uint8Array;
  decode(value: Uint8Array): T;
}
```

Codecs are registered explicitly. No arbitrary caller-provided schema name can cause untyped deserialization.

### Credential cipher

```ts
interface CredentialCipher {
  encrypt(identity: CredentialIdentity, plaintext: Uint8Array): EncryptedCredentialPayload;
  decrypt(identity: CredentialIdentity, encrypted: EncryptedCredentialPayload): Uint8Array;
}
```

This layer knows crypto and keyrings, not PostgreSQL, OAuth, fallback, or users.

### PostgreSQL repository

```ts
interface IntegrationCredentialRepository {
  read<T>(key: CredentialKey, codec: CredentialCodec<T>): Promise<T | undefined>;

  modify<T>(
    key: CredentialKey,
    codec: CredentialCodec<T>,
    operation: (current: T | undefined) => Promise<T | undefined>,
  ): Promise<T | undefined>;

  delete(key: CredentialKey): Promise<void>;
}
```

`modify` owns the full serialized read/modify/write path. Returning `undefined` leaves the row unchanged and returns
the current durable value; returning a credential persists it before returning the resulting durable value. Deletion
uses the same lock.

Use a dedicated small PostgreSQL pool because refresh intentionally pins one connection during provider network I/O; refresh waits must not starve ordinary application queries.

### Advisory lock

The canonical lock key includes the complete owner and semantic key:

```ts
JSON.stringify(['deputies.integration-credential-lock', scope, namespace, name]);
```

V1 passes that exact UTF-8 JSON text to `hashtextextended($1, 0)` everywhere. The future user-scope lock version adds `ownerUserId ?? null`. Hash collisions cause only harmless extra serialization.

The repository polls `pg_try_advisory_lock` with a bounded deadline on a dedicated connection, reads after acquiring the lock, performs the provider callback, writes on the same connection, verifies the update, unlocks, and releases the connection.

Do not keep a SQL transaction open across the provider request. The session lock provides cross-replica exclusion without retaining a long-running MVCC snapshot.

Verify `pg_advisory_unlock` returns `true`. Destroy rather than pool a connection after lock, unlock, or connection failure because its server session may still own the lock. Register the dedicated pool with process shutdown resources.

The installed Pi Codex refresh request is not abortable. Do not implement timeout by racing and abandoning that promise: the provider could rotate the token after the lock was released. Until an abortable upstream boundary exists, retain the lock until refresh settles. Once a provider replacement is received, request cancellation no longer cancels bounded persistence recovery; graceful shutdown waits for that recovery deadline.

### Capability-shaped provider services

Consumers do not receive a generic `getSecret()` API. Provider-facing services expose actions or resolved auth:

```ts
interface ModelCredentialResolver {
  resolveForRequest(provider: string, principal: ConfigurationPrincipal): Promise<ModelAuth>;
}

interface ExecutorConnectionProvider {
  connectForRun(input: ExecutorRunPrincipal): Promise<McpConnection | undefined>;
}
```

The repository is private to trusted services. Pi tools and sandbox tools never receive it.

## OpenAI Codex Initial Implementation

### Root cause fixed

Previous base64 auth created an `InMemoryCredentialStore`. Pi refreshed the credential in memory, including a potentially rotated refresh token, but process restart reloaded the original environment value. Multiple replicas had independent stale copies.

### Explicit storage mode

Avoid ambiguous precedence during migration:

```text
OPENAI_CODEX_AUTH_STORAGE=file | postgres | legacy-base64
```

- `file`: use Pi's writable file-backed store; operator owns durable shared filesystem semantics.
- `postgres`: require PostgreSQL and the integration credential keyring; base64 is seed-only.
- `legacy-base64`: preserve current behavior temporarily and emit a clear nondurability warning.

One transitional release permits an unset mode and preserves today's precedence—explicit file, then base64, then Pi's default file—while warning when base64 selects nondurable storage. New deployments should set a mode explicitly. Combinations are exact:

- `file`: reject base64; use the configured file or Pi's default file;
- `legacy-base64`: require base64 and reject an auth file;
- `postgres`: require PostgreSQL/keyring, reject an auth file, and accept base64 only as an absent-row seed.

### Bootstrap

In `postgres` mode:

1. Read the tenant `model-provider/openai-codex` row.
2. If present, decrypt and validate it; ignore `OPENAI_CODEX_AUTH_BASE64`.
3. If absent and no seed is configured, leave the store empty so non-Codex providers can operate normally.
4. If absent and a seed is configured, strictly decode it and extract only the `openai-codex` OAuth entry.
5. Validate it with the v1 codec.
6. Insert it with conflict-safe create-if-absent semantics.
7. Read/decrypt/validate the winner.

Concurrent worker startup converges on one row. Invalid base64 fails before writing. Invalid existing ciphertext fails closed and never falls back to the seed.

### Refresh

For an expired credential:

1. Acquire the credential advisory lock.
2. Read/decrypt the latest row.
3. Recheck expiry after locking.
4. If another replica already refreshed it, return current auth.
5. Persist a unique pending-operation fence while retaining the lock.
6. Call OpenAI with the current refresh token while retaining the lock.
7. Validate the complete returned access/refresh credential.
8. Encrypt with the active Deputies key.
9. Persist the replacement, increment revision, and clear the fence atomically.
10. Confirm durability.
11. Unlock.
12. Only then return auth to the model request.

### Provider-success/database-failure window

OpenAI and PostgreSQL cannot participate in one transaction. A crash after OpenAI rotates the token but before PostgreSQL stores it can lose the refresh-token chain.

Mitigation around the provider operation and after receiving a replacement:

1. Before calling OpenAI, retain the observed row ID, revision, decrypted credential, and semantic identity and durably set a unique operation fence.
2. After success, retain the replacement in memory and persist with `UPDATE ... WHERE id = $id AND revision = $revision RETURNING revision`.
3. The replacement update clears the matching fence atomically. A returned row confirms acceptance under PostgreSQL's configured durability guarantees; do not claim stronger durability.
4. Any unconfirmed write, including a deterministic zero-row update, enters recovery. On an ambiguous connection/write result, destroy that connection, reconnect, reacquire the semantic lock, and reread/decrypt. A waiting replica that acquires the lock first sees the fence and must fail without invoking its callback.
5. If current plaintext equals the replacement, succeed.
6. If the same row still contains the observed plaintext—even if key re-encryption changed its revision—write the retained replacement against the current revision.
7. If a different usable credential is authoritative, reload the Pi adapter snapshot and return auth resolved from that credential rather than the callback result derived from the unpersisted replacement.
8. If the row is absent, has a new ID, changed schema/identity, or represents reconnect/deletion, fail without recreating it.
9. Never compare ciphertext and never call OpenAI again during recovery.
10. If persistence cannot be confirmed within a bounded recovery period, leave the fence set, fail the request, and emit a sanitized critical signal.

If confirmation of the initial fence write is lost, the provider callback has not started. Deputies reacquires the semantic lock and clears only its exact operation ID if it committed; absence is already safe, while another operation's fence or a changed/deleted row fails recovery without mutation. The original request fails retryably after recovery and never invokes the provider callback.

If a callback throws, Deputies cannot know whether the provider consumed the refresh token before the response was lost. The fence therefore remains set and requires deliberate provider reconnection; another replica never retries the observed token. PostgreSQL-mode credential deletion is rejected until a reconnect workflow can preserve the distinction between never bootstrapped and deliberately disconnected. This favors availability loss over silently forking or resurrecting a rotating token chain.

### Pi credential store

The installed Pi 0.83 packages expose the asynchronous `CredentialStore` contract and `ModelRuntime`. OAuth refresh runs inside `CredentialStore.modify`, which serializes read-modify-write and resolves only after persistence.

V1 uses a narrowly bounded direct store:

1. atomically bootstrap/read PostgreSQL under the repository's semantic lock;
2. inject the PostgreSQL `CredentialStore` into each `ModelRuntime`;
3. run refresh callbacks under the cross-process lock and validate every candidate with the strict codec;
4. persist replacements before `modify` resolves, without an independent cache, snapshot, or JSON bridge;
5. pin title, main-turn, compaction/internal-call, subagent, and cross-replica behavior with tests.

The store only exposes the fixed `openai-codex` provider entry and rejects unrelated mutation. Main sessions, title generation, compaction/internal calls, and subagents share a runtime within each operation and reuse the injected store across runtimes.

## Future Personal Credentials And Fallback

When user linking ships:

- the API derives `owner_user_id` from the authenticated user and never accepts an arbitrary owner for personal writes;
- user rows are private even from other users; admin access to raw credentials remains prohibited;
- linking validates provider identity and stores only sanitized metadata outside ciphertext;
- disconnect serializes with refresh, attempts provider revocation when supported, and deletes locally even if best-effort remote revocation fails;
- user deletion uses application-level revocation plus `ON DELETE CASCADE` as the final safety net;
- runs persist an execution principal instead of inferring session creator;
- title generation receives the first message author identity;
- subagents inherit the run principal;
- absent personal credentials may resolve to tenant only when a typed tenant setting permits it;
- invalid personal credentials produce `reauthorization_required` and do not silently fall back.

No personal credential values are copied into sessions, messages, runs, or events.

## Future Executor Model

### Shared and personal identities

Future records:

```text
tenant / integration-gateway / executor
  -> dedicated Executor service-user credential

user:A / integration-gateway / executor
  -> user A's Executor personal API key or OAuth credential
```

Executor requires an acting user for MCP sessions; an organization API key cannot open one. The tenant credential therefore represents a dedicated, least-privilege Executor service identity with no personal upstream connections.

Resolution per run:

```text
usable personal Executor credential
  -> connect as user; visible catalog is personal + organization connections

no personal credential and tenant fallback enabled
  -> connect as tenant service identity; visible catalog is approved organization connections

personal credential exists but is broken
  -> request reconnection; no silent tenant fallback
```

Deputies stores only its Executor-facing credential. Executor continues storing GitHub/Slack/Google/database upstream credentials and injecting them host-side. Executor MCP clients remain in the control-plane worker.

Dynamic MCP configuration should become run-scoped rather than static `MCP_SERVERS` headers. Connections must never be pooled across user identities unless the cache key includes endpoint, organization, user, and credential revision.

### Authorization and audit

An Executor call requires the intersection of:

- Deputies user/session/tool authorization;
- the selected execution principal;
- Executor connection visibility;
- Executor tool policy;
- upstream provider permissions.

Audit records may contain Deputies user, session/run, Executor subject/organization, connection address, tool, status, and timestamps. They never contain bearer or upstream credentials.

## Sandbox Boundary

### Existing behavior to preserve

- Model and control-plane provider credentials remain in workers.
- Authenticated GitHub API/CLI, web search, MCP, and external-resource operations run in workers.
- Sandbox shell commands do not inherit worker environment.
- Repository checkout may receive a short-lived repository-scoped installation token for that command only; setup code runs after it is removed.
- Every sandbox necessarily has a bridge capability, but it is not an external integration credential.

### Storage separation

`integration_credentials` and `sandbox_secrets` remain separate:

| Store                   | Owner              | Consumer                       | Lifetime               |
| ----------------------- | ------------------ | ------------------------------ | ---------------------- |
| integration credentials | tenant/user        | control-plane provider service | long-lived/refreshable |
| sandbox runtime secrets | sandbox            | provider/bridge path           | sandbox lifetime       |
| deployment secrets      | operator           | process startup/control plane  | deployment lifetime    |
| derived credentials     | operation/resource | one command/request            | short-lived            |

Future sandbox-secret hardening—keyring migration, bridge-token delivery via file/FD, log redaction, cleanup, and snapshot behavior—should reuse cryptographic conventions where appropriate but is not part of the Codex delivery.

### Bounded sandbox-secret hardening

The Codex credential migration does not need to redesign sandbox secrets, but the following existing gaps should be handled as a small independent hardening change:

1. Require `SANDBOX_SECRET_ENCRYPTION_KEY` at startup for every PostgreSQL-backed provider that returns reconnect secrets. The current validation covers Docker, Kubernetes agent sandbox, and Lambda MicroVM, but Daytona, Tensorlake, and Superserve also persist bridge tokens and otherwise fail only when the first sandbox is created.
2. When the existing store update marks a sandbox destroyed, delete its `sandbox_secrets` in the same PostgreSQL transaction and mirror the invariant in the memory store. The foreign-key cascade only runs when the sandbox row is deleted, while destroyed sandbox rows are retained.
3. Test that bridge tokens are redacted from provider errors, logs, events, and tool output.
4. Verify each snapshot-capable provider does not include the bridge token in a reusable filesystem or image snapshot. Treat a provider that cannot make this guarantee as requiring token regeneration after restore.

Use a distinct deployment key for sandbox runtime secrets and integration credentials. A compromise or rotation in one domain must not automatically expose or invalidate the other. These checks may ship before, with, or after the Codex change, but they remain separate reviewable changes and are not prerequisites for making PostgreSQL authoritative for Codex refresh.

The current bridge token is sandbox-scoped and replaceable. If sandbox-secret key rotation becomes operationally necessary, first determine whether Deputies can invalidate and regenerate bridge tokens while reconnecting active sandboxes. Regeneration may be safer and simpler than preserving old ciphertext indefinitely.

### Deferred sandbox redesign

Do not put sandbox bridge tokens in `integration_credentials` or add a general user-secret injection API. Defer the following until required by a concrete threat model or provider:

- add `encryption_version`, `encryption_key_id`, and sandbox-bound AAD to `sandbox_secrets` using the same format conventions, but a separate keyring, as integration credentials;
- replace process-environment delivery of `DEPUTIES_SANDBOX_TOKEN` with a protected mounted file, inherited file descriptor, or provider-native secret mechanism;
- rotate the bridge token on reconnect or resume;
- add generalized sandbox secret brokering or egress proxying.

## External Credential Rotation

### OAuth refresh rotation

OAuth refresh replaces the complete logical credential under one repository lock. After successful refresh, Deputies treats the previous refresh token as unusable and never retries it, regardless of undocumented provider grace or reuse behavior. One authoritative payload is retained.

### Manual reconnect

Complete and validate the new grant first, then atomically replace the local credential under the same lock. Provider-side revocation of the displaced grant is best-effort and provider-specific.

### API-key rotation

Providers that allow overlapping keys may use an explicit pending/active/retired workflow in a provider connection domain model. Do not add universal `current` and `previous` fields to every encrypted payload.

### Webhook signing rotation

Inbound signature verification may legitimately accept current and previous secrets for a bounded overlap. That is a secret-kind-specific policy, not the generic repository default.

## Multi-Tenancy

Deputies currently has one tenant per deployment/database. This design uses explicit `tenant` scope without a `tenant_id`.

Do not add a nullable or synthetic tenant ID only to settings/credentials. If real multi-tenancy is implemented, introduce tenants and memberships coherently across auth, sessions, resources, workers, settings, credentials, and authorization. Then:

- add `tenant_id` to tenant and user credentials/settings;
- migrate the existing singleton rows to the default tenant;
- scope uniqueness and advisory lock keys by tenant;
- validate user membership for every personal operation;
- consider per-tenant envelope keys if isolation/crypto-erasure is a requirement.

This is an additive migration of the stable credential ID and semantic key, not a reason to build partial tenancy now.

## API And Contract Changes

### Initial delivery

- Add explicit Codex auth storage mode.
- Add integration credential keyring configuration.
- Add the additive credential migration.
- Add no browser-facing raw credential API.
- Validate configuration without echoing secret values.
- Require operators to retain every referenced historical key. Operator key-ID reporting, setup-status integration, key retirement, and bulk re-encryption are deferred.

### Future settings API

Typed endpoints should expose registered settings and provenance, not arbitrary JSON keys. Tenant writes require admin authorization. User writes derive the authenticated user. Secrets use separate connect/disconnect/status routes.

### Future credential status API

Example safe response:

```json
{
  "provider": "openai-codex",
  "configured": true,
  "scope": "user",
  "management": "managed",
  "status": "active",
  "accountLabel": "optional non-secret label"
}
```

Never return encrypted columns or token fields.

## Observability And Audit

Allowed operational signals:

- credential semantic key without user email/name;
- scope and opaque owner ID where access-controlled;
- payload schema/version;
- encryption key ID;
- row revision;
- bootstrap created/already-present;
- refresh attempted/succeeded/failed;
- lock wait duration and timeout;
- reauthorization-required classification;
- counts grouped by encryption key ID.

Forbidden:

- serialized credential payloads;
- token fragments, hashes, prefixes, or suffixes;
- base64 seed values;
- request/response bodies from OAuth token endpoints;
- raw encryption keys;
- generic error objects that may include request headers.

Provider errors are classified and sanitized before logging or product events. Traces contain status/category, not provider response bodies.

## Testing Plan

### Crypto unit tests

- AES-GCM round trip for every configured key ID.
- Nonce uniqueness across writes.
- Unknown/missing key ID fails clearly.
- Wrong key, modified ciphertext/tag, and modified AAD fail authentication.
- Swapping ciphertext between provider rows fails.
- Invalid keyring configuration fails startup without values.
- Old-key read/new-key write behavior.

### Codec unit tests

- Valid Pi OAuth credential round trip.
- Missing/empty access or refresh rejected.
- Non-finite expiry rejected.
- Payload size cap enforced.
- Unknown fields rejected for the pinned v1 schema.
- Unknown payload schema/version rejected safely.

### PostgreSQL integration tests

- Seed races converge on one complete row.
- Existing row always wins over differing seed.
- Read/modify/delete serialize across independent pools.
- Two workers racing an expired credential call the mocked provider once.
- A second worker rereads the winning rotated credential.
- Restart/new repository instance reads the rotated value.
- A callback with an uncertain provider outcome leaves the prior ciphertext fenced and prevents a second callback.
- Provider success followed by injected write failure follows bounded recovery without a second provider call.
- A waiting second replica cannot replay the observed refresh token during ambiguous-write recovery.
- Before/after-commit fence establishment failures recover without invoking the provider callback.
- Before/after-commit fence clearing failures recover without changing the credential revision.
- Connection failure while a lock may be held destroys rather than reuses the client.

### Runner tests

- Title, main session, compaction/internal model requests, and subagents all use the durable resolver.
- No path constructs a Codex `InMemoryCredentialStore` in postgres mode.
- File and explicit legacy modes retain documented behavior.
- Credential failure produces a sanitized provider-unavailable/reauthorization result.

### Boundary tests

Canary token values must not appear in:

- logs and thrown error messages;
- normalized events;
- session context/history;
- MCP tool arguments/results;
- sandbox command environments;
- artifacts;
- traces/metrics attributes.

### Settings tests when implemented

- unknown keys rejected;
- stored values revalidated;
- unsupported scope rejected;
- precedence and provenance correct;
- minimum/intersection settings cannot expand deployment ceilings;
- user settings inaccessible to other users;
- snapshot/live behavior matches definitions.

## Expected Initial Code Ownership

Keep the credential foundation out of the already large generic `PostgresStore` except for shared lifecycle wiring:

- `apps/control-plane/src/integration-credentials/types.ts` — semantic keys, encrypted row types, codecs, and repository contracts;
- `apps/control-plane/src/integration-credentials/cipher.ts` — keyring validation and AES-GCM/AAD implementation;
- `apps/control-plane/src/integration-credentials/postgres.ts` — dedicated pool, SQL, advisory locks, revisions, and recovery;
- `apps/control-plane/src/runner/openai-codex-credentials.ts` — pinned Codex codec and seed parsing;
- `apps/control-plane/src/runner-pi/postgres-credential-store.ts` — direct Pi `CredentialStore` adapter;
- `apps/control-plane/src/config/index.ts` — explicit storage mode and keyring configuration validation;
- `apps/control-plane/src/index.ts` — repository lifecycle, asynchronous bootstrap, and runner injection;
- `apps/control-plane/src/db/migrations/026_integration_credentials.sql` — additive tenant-only schema and uncertain-operation fence;
- `apps/control-plane/test/unit/` and `apps/control-plane/test/integration/` — crypto, codec, adapter, and cross-pool behavior.

The exact filenames may follow nearby conventions during implementation. The important boundary is that provider logic does not leak into crypto/SQL and raw repository access does not leak into runner tools.

## Initial Implementation Phases (Complete)

### Phase 0: Pi integration spike

- Prove direct `CredentialStore` persistence ordering and strict candidate validation.
- Trace all model-auth paths: title, main session, internal/compaction calls, and subagents.
- Prove a credential rotated during process lifetime is visible to subsequent calls.
- Prove the advisory lock remains held until the installed unabortable refresh settles.
- Stop and pursue an upstream async store boundary if these assumptions fail.

### Phase 1: credential schema and crypto

- Add migration `026_integration_credentials.sql`.
- Add keyring parsing/validation.
- Add credential cipher with AAD.
- Add Pi OAuth codec.
- Add repository read/modify/delete with dedicated pool and advisory locks.
- Add crypto/unit/Postgres integration tests.

### Phase 2: Codex bootstrap and runtime

- Add explicit storage mode.
- Implement seed-if-absent bootstrap.
- Wire the durable provider store into every Pi model path.
- Add refresh failure recovery and sanitized diagnostics.
- Remove base64 in-memory behavior from postgres mode.

### Phase 3: deployment cutover and verification

- Update Railway, Kubernetes, Compose, `.env.example`, and deployment docs.
- Run targeted unit and Postgres integration tests.
- Run canonical repository checks.
- Perform a two-worker refresh race and restart UAT with a test credential where feasible.

### Deferred phases

- Ship settings tables/service with the first concrete tenant/user setting.
- Add personal Codex linking and fallback policy.
- Add tenant/user Executor credential selection and dynamic MCP connections.
- Add provider connection metadata/status and revoke workflows.
- Add bounded key re-encryption, verification, backup retention, and key retirement operations.
- Migrate sandbox secret encryption to the keyring as a separate change.
- Add a credential-injecting egress broker only for concrete integrations that cannot use control-plane tools.

## Rollout And Migration Plan

### Additive deployment

1. Apply the additive database migration.
2. Deploy code that understands postgres credential mode but leave it inactive.
3. Verify every API/worker replica is compatible.
4. Drain and stop all old worker-capable replicas that use the same Codex grant.
5. While no grant consumer is running, configure postgres mode and the keyring.
6. Bootstrap with a one-shot command or exactly one compatible worker.
7. Verify the row can be decrypted, then scale compatible workers.
8. Exercise auth and verify the encrypted row revision changes after refresh.
9. Remove `OPENAI_CODEX_AUTH_BASE64` after verification.

A normal mixed-version rolling cutover is unsafe: an old in-memory worker can rotate the same refresh token independently of the database-backed chain.

### Migration from independent deployments

Do not seed multiple independent databases/deployments from the same rotating refresh token. Either:

- perform a separate provider login for each independent deployment; or
- centralize every consumer on one authoritative credential store and lock.

Multiple distinct grants for one OpenAI account may coexist, but Deputies must not rely on undocumented provider behavior for correctness.

### Rollback

- The database migration is additive and need not be reversed.
- Before the first DB-backed provider rotation, application rollback can restore the previous mode.
- After rotation, the original environment seed may be stale; v1 rollback is fresh provider login or roll-forward.
- Encrypted database backups and the keyring versions needed to restore them are retained together.

## Risks And Tradeoffs

### Generic storage can become an untyped dumping ground

Mitigation: private repository, explicit codecs, registered semantic namespaces, capability-shaped provider services, and no generic external API.

### Direct encryption requires rewriting rows during key rotation

Acceptable at expected credential counts. Envelope encryption remains an additive future optimization when justified.

### Advisory lock holds a database connection during provider I/O

Intentional to protect rotating refresh tokens. Use a dedicated bounded pool and timeouts so application queries are unaffected.

### External rotation is not atomic with PostgreSQL

The crash window is irreducible. Persist before returning, retry ambiguous writes without re-refreshing, alert clearly, and support reconnection.

### Deferring user scope until user linking

V1 stores only the tenant credential. A later additive migration introduces the concrete `auth_users.id` boundary together with linking, revocation, status, and deletion semantics; existing tenant rows and IDs remain stable.

### Settings can conflict with existing domain configuration

The registry must define ownership. Do not silently duplicate agent-profile or environment state in generic settings. Migrations need one source of truth and explicit compatibility behavior.

### Personal Executor and tenant fallback can blur attribution

Future runs must record the selected execution principal. Tenant fallback uses a dedicated service identity, never another human's key, and Deputies retains its own per-call audit.

### Sandbox prompt injection remains relevant

Keeping credentials out of the sandbox prevents direct token theft but does not make authenticated tools harmless. Tool authorization, Executor policy, upstream scopes, approvals, and audit remain necessary.

## Settled Future Compatibility

The following decisions are intentionally stable even though features are deferred:

- one singleton tenant today, no fake tenant row;
- tenant and user are the supported configuration/credential scopes;
- execution principal is explicit and based on triggering work, not session creator;
- personal-invalid does not fall back as personal-absent;
- settings and credentials use separate persistence;
- credentials use semantic namespace/name plus typed encrypted payload;
- raw credential access stays private to control-plane services;
- Executor upstream credentials stay in Executor;
- tenant Executor fallback uses a dedicated service identity;
- long-lived provider credentials do not enter sandboxes;
- real multi-tenancy is a coherent product-wide migration, not a credential-only column.

## Resolved During Initial Implementation

1. Pi 0.83's direct `CredentialStore` integration passed phase-zero acceptance. Deputies injects one PostgreSQL-backed store into each `ModelRuntime`, and integration tests cover cross-pool serialization and restart visibility.
2. The deployment representation is one active key ID plus a JSON map of stable key IDs to base64-encoded 32-byte keys. Compose and Railway receive it through environment/secret injection; Helm supports chart-owned values or an existing Kubernetes Secret. The Codex base64 value is an optional absent-row seed in PostgreSQL mode.
3. Lock acquisition and post-provider persistence recovery use fixed bounded deadlines in v1. Provider refresh remains under the semantic lock until it settles; Deputies does not race and abandon an unabortable refresh.
4. Pi should be upgraded to the first official release containing the later upstream file-store fixes when available, but those changes do not alter the PostgreSQL schema, encryption format, or direct credential-store contract and are not required for PostgreSQL-mode correctness.

## Open Questions

1. Which first concrete setting should introduce `tenant_settings` and `user_settings` rather than shipping empty tables?
2. Should future provider connection metadata be one generic domain model or provider-specific until at least two linked providers exist?
3. Should credential operations receive dedicated audit rows, or are sanitized operational logs sufficient for the initial global Codex credential?

## Links

- Current Codex runner auth: `apps/control-plane/src/runner-pi/runner.ts`
- Existing Codex auth helper: `apps/control-plane/src/runner/openai-codex-auth.ts`
- Existing sandbox cipher: `apps/control-plane/src/store/encrypted-secrets.ts`
- Existing sandbox secret schema: `apps/control-plane/src/db/migrations/003_sandboxes.sql`
- Current single-tenant model: `docs/tenant-access.md`
- Current data model: `docs/data-model.md`
- Executor integration: `docs/executor-data-tools.md`
- Remote MCP technical spec: `docs/product/specs/2026-07-06-mcp-server-tools.md`
- Executor MCP proxy: https://executor.sh/docs/mcp-proxy
- Mistle reference implementation: https://github.com/mistlehq/mistle
- Open-Inspect reference implementation: https://github.com/ColeMurray/background-agents
