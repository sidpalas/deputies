# Data Model

## Goals

The database model should make the service resumable, observable, and safe under concurrency. Conversation memory is not enough. The database must answer:

- What session is this?
- What work is pending?
- Is a run active?
- Which sandbox belongs to this session?
- What events happened?
- Which external thread maps to this session?
- What artifacts were produced?

Postgres is the required durable store for the MVP.

## Entity Overview

```txt
sessions
auth_users
auth_accounts
auth_sessions
messages
runs
events
sandboxes
artifacts
flue_sessions
pi_sessions
external_threads
integration_deliveries
callback_deliveries
webhook_sources
session_sequence_counters
app_migrations

Planned:
repo_credentials
```

## Implementation Stages

The data model below is both the product target and the current implementation reference. Some columns are still narrower than the long-term target, but the core durable API/worker model is implemented.

Current implemented tables:

- `sessions`
- `auth_users`
- `auth_accounts`
- `auth_sessions`
- `messages`
- `runs`
- `events`
- `sandboxes`
- `artifacts`
- `flue_sessions`
- `pi_sessions`
- `external_threads`
- `integration_deliveries`
- `callback_deliveries`
- `webhook_sources`
- `session_sequence_counters`
- `app_migrations`

Planned tables:

- `repo_credentials`

Identifier policy:

- Product entity IDs are application-generated UUID strings. SQL tables should use `uuid` columns once the table participates in production behavior.
- Flue-owned IDs are `text` because their format is owned by Flue.
- Provider/external IDs are `text` because their format is owned by the provider.
- Per-session cursor sequences should be allocated by database-backed counters or equivalent transactional logic, not by counting rows in application memory.

## Auth Users, Accounts, And Sessions

Product session authentication is durable and provider-backed. The browser receives only an opaque session ID in the `dev_deputies_session` cookie.

```txt
auth_users
  id uuid primary key
  username text not null
  display_name text
  avatar_url text
  created_at timestamptz not null
  updated_at timestamptz not null

auth_accounts
  id uuid primary key
  user_id uuid not null references auth_users(id) on delete cascade
  provider text not null
  provider_account_id text not null
  username text not null
  profile jsonb not null
  created_at timestamptz not null
  updated_at timestamptz not null
  unique(provider, provider_account_id)

auth_sessions
  id text primary key
  user_id uuid not null references auth_users(id) on delete cascade
  created_at timestamptz not null
  expires_at timestamptz not null
```

Provider accounts let `AUTH_PROVIDER=static` and `AUTH_PROVIDER=github` share the same session machinery. GitHub login uses the GitHub App user-authorization client ID and client secret; repository runtime access still mints separate short-lived installation tokens and does not persist those tokens in auth tables.

## Sessions

Represents a durable background task workspace.

Suggested columns:

```txt
id uuid primary key
title text
status text not null
queue_paused_at timestamptz
context jsonb
source text
created_by jsonb
metadata jsonb not null default '{}'
created_at timestamptz not null
updated_at timestamptz not null
archived_at timestamptz
```

Statuses:

```txt
created
active
idle
completed
failed
cancelled
archived
```

Rules:

- A session may have many messages.
- A session may have at most one active run.
- A session may have one current sandbox, but historical sandbox rows should be preserved.
- Source-specific identifiers belong in `external_threads`, not the session row.
- Archived sessions are read-only until restored.
- `queue_paused_at` is used while editing pending messages so the worker does not claim a message mid-edit.
- `context` stores durable session-level defaults such as the current repository. It must not store transient delivery data, callbacks, provider tokens, or raw webhook payloads.

## Messages

Represents user prompts and follow-ups.

Suggested columns:

```txt
id uuid primary key
session_id uuid not null references sessions(id)
sequence bigint not null
kind text not null
status text not null
actor jsonb
prompt text not null
context jsonb not null default '{}'
source text
source_metadata jsonb not null default '{}'
dedupe_key text
created_at timestamptz not null
started_at timestamptz
completed_at timestamptz
failed_at timestamptz
error text
```

Kinds:

```txt
initial_prompt
follow_up
system
integration_event
```

Statuses:

```txt
pending
processing
cancelling
completed
failed
cancelled
```

Rules:

- `sequence` is monotonically increasing per session.
- Pending messages are processed in sequence order. The worker claims all currently pending messages for one session as an ordered batch.
- Message context is the effective run context. It inherits durable session context and can override it with message-specific values such as a new repository.
- Duplicate external deliveries must not create duplicate messages.
- Follow-ups sent during an active run remain pending and are handled by the next batch.
- Pending messages can be edited or cancelled before the worker claims them.
- Active run cancellation marks claimed messages `cancelling` first, then the worker finalizes them as `cancelled`.

Indexes:

```txt
(session_id, sequence)
(status, created_at)
unique(source, dedupe_key) where dedupe_key is not null
```

## Runs

Represents an active or historical execution attempt.

Suggested columns:

```txt
id uuid primary key
session_id uuid not null references sessions(id)
message_id uuid references messages(id)
status text not null
runner_type text not null
sandbox_id uuid references sandboxes(id)
lease_owner text
lease_expires_at timestamptz
heartbeat_at timestamptz
attempt int not null default 1
started_at timestamptz not null
completed_at timestamptz
failed_at timestamptz
error text
metadata jsonb not null default '{}'
```

Statuses:

```txt
starting
running
cancelling
completed
failed
cancelled
timed_out
stale
```

Rules:

- Only one `starting`, `running`, or `cancelling` run is allowed per session.
- Leases must expire if a process crashes.
- A retry should create a new run row, not overwrite historical run data.
- A batch run stores the first claimed message in `message_id`; all claimed message IDs are retained in run metadata and completed/cancelled together.

## Events

Append-only event log.

Suggested columns:

```txt
id uuid primary key
session_id uuid not null references sessions(id)
run_id uuid references runs(id)
message_id uuid references messages(id)
sequence bigint not null
type text not null
severity text
payload jsonb not null default '{}'
created_at timestamptz not null
```

Important current event types:

```txt
session_created
session_archived
session_unarchived
session_updated
session_queue_paused
session_queue_resumed
message_created
message_updated
message_cancelled
message_started
run_started
sandbox_starting
sandbox_ready
sandbox_stopped
sandbox_stop_failed
sandbox_destroyed
sandbox_destroy_failed
repository_ready
agent_text_delta
agent_response_final
tool_started
tool_finished
artifact_created
run_completed
run_failed
run_cancel_requested
run_cancelled
message_completed
message_failed
callback_sent
callback_retry_scheduled
callback_failed
callback_replay_requested
```

Rules:

- Events are never updated for normal behavior.
- Consumers replay from `(session_id, sequence)`.
- Large payloads should be moved to object storage and referenced by URL/key.
- Sensitive values must be redacted before event write.

Indexes:

```txt
unique(session_id, sequence)
(session_id, created_at)
(run_id, sequence)
```

## Sandboxes

Represents provider-backed execution environments.

Suggested columns:

```txt
id uuid primary key
session_id uuid references sessions(id)
provider text not null
provider_sandbox_id text not null
status text not null
workspace_path text
snapshot_id text
metadata jsonb not null default '{}'
created_at timestamptz not null
updated_at timestamptz not null
last_health_check_at timestamptz
destroyed_at timestamptz
```

Current implemented statuses:

```txt
ready
stopped
unhealthy
destroyed
failed
```

Longer-term provider lifecycle states such as `pending`, `creating`, `running`, and `snapshotting` may be introduced later if needed.

Rules:

- Provider-specific fields belong in `metadata` unless frequently queried.
- A session can have multiple historical sandboxes.
- The active sandbox should be derivable by latest non-destroyed row or a session metadata pointer.

Current implementation:

- `007_sandboxes.sql` creates the product sandbox lifecycle table.
- Active sandbox lookup uses the latest non-destroyed `ready`, `stopped`, or `unhealthy` row for a `(session_id, provider)` pair.
- The worker health-checks and reconnects a ready active sandbox before running a follow-up message.
- Stopped sandboxes remain active candidates and are restarted before reconnect when the provider supports start/stop.
- If health or reconnect fails, the row is marked `unhealthy` and a replacement sandbox is created.
- The reaper first stops idle ready sandboxes after `SANDBOX_STOP_DELAY_SECONDS`, then destroys ready/stopped/unhealthy sandboxes after `SANDBOX_RETENTION_SECONDS`.
- Archive destroys active session sandboxes immediately.
- Reaper coordination uses a Postgres advisory lock when the Postgres store is active.

## Artifacts

Durable outputs generated by a run.

Suggested columns:

```txt
id uuid primary key
session_id uuid not null references sessions(id)
run_id uuid references runs(id)
message_id uuid references messages(id)
type text not null
title text
url text
storage_key text
payload jsonb not null default '{}'
created_at timestamptz not null
```

Types:

```txt
pull_request
branch
commit
image
screenshot
log
report
file
external_link
```

Rules:

- PR artifacts should include repo, PR number, branch, title, and URL.
- Artifacts should be referenced from events with `artifact_created`.
- Postgres remains the source of truth for artifact metadata; large/binary content is stored outside Postgres when `storage_key` is set.
- Stored artifacts should include retrieval/display metadata in `payload`: `storage`, `sizeBytes`, `checksumSha256`, `contentType`, and `fileName` when known.
- External-link artifacts use `url` without `storage_key`; internally stored artifacts use `storage_key` and are read through authenticated API routes.

Current implementation:

- `008_artifacts_callbacks.sql` creates `artifacts` and `callback_deliveries`.
- Runner-returned artifacts are persisted after successful runs and emitted as `artifact_created` events.
- Stored artifact content can be created by runner-returned artifact bytes or by the Flue `artifact({ action: "create" })` tool, which copies a sandbox file into configured object storage.
- Object storage is optional and selected with `ARTIFACT_STORAGE_PROVIDER=disabled|filesystem|s3`; stored blob artifacts fail clearly when storage is disabled.
- Session artifacts are readable through `GET /sessions/:sessionId/artifacts`.
- Stored artifacts are downloadable through `GET /sessions/:sessionId/artifacts/:artifactId/download`.
- Text-like stored artifacts are previewable through `GET /sessions/:sessionId/artifacts/:artifactId/preview`; unsupported previews return `415 unsupported_preview`.
- Generic webhook HTTP callbacks, Slack completion replies, and GitHub completion comments are recorded in `callback_deliveries` with `pending`, `sending`, `sent`, or `failed` status.

## Runner Runtime Sessions

Stores runner-owned internal session history for durable runner continuation. This is separate from product session state.

Product state remains in `sessions`, `messages`, `runs`, `events`, `artifacts`, and `sandboxes`. Runner runtime tables are opaque SDK state used only by the runner adapter that wrote them.

Changing a product session from one runner to another does not continue the previous runner's internal history. For example, a session that starts on `RUNNER=flue` can later receive work with `RUNNER=pi`, but Pi starts a new Pi runtime history for that product session. The product UI still shows the prior messages/events, but the Pi agent does not read or convert `flue_sessions`. Cross-runner continuation requires an explicit transcript conversion layer or a future runner-agnostic transcript store.

The runner tables are intentionally separate for now. A future shared `agent_sessions` table is viable, but it should include an explicit `runner` discriminator, runner-owned key, product `session_id`, schema/data version fields, and tests that prevent one runner from loading another runner's state. Without those guardrails, a shared table makes divergent SDK shapes easier to mix accidentally, weakens table-level constraints such as Pi's `sessions(id)` foreign key, and couples Flue and Pi storage migrations even though each runtime owns a different opaque format.

### Flue Sessions

Stores Flue's internal session history for Node deployments.

Suggested columns:

```txt
id text primary key
data jsonb not null
version int not null default 1
created_at timestamptz not null
updated_at timestamptz not null
```

Rules:

- Treat `data` as opaque Flue-owned serialized state.
- Use a custom Postgres-backed Flue session store in production and CI.
- Do not rely on Flue's Node in-memory default outside local experiments.
- The current `flue_sessions` table is implemented by `004_flue_sessions.sql` and stores only Flue's opaque session store key as `id`; it does not persist separate `agent_id`, `session_id`, or `app_session_id` metadata columns.

See [Flue Persistence](./flue-persistence.md) for details.

### Pi Sessions

Stores Pi's internal JSONL-equivalent session history.

Current columns:

```txt
id uuid primary key references sessions(id) on delete cascade
data jsonb not null
created_at timestamptz not null
updated_at timestamptz not null
```

Rules:

- Treat `data` as opaque Pi-owned serialized state.
- The stored JSON shape is `{ version, header, entries }`, where `header` and `entries` are Pi SDK session records.
- `id` is the product `sessions.id`; deleting the product session cascades Pi runtime state.
- Pi does not read `flue_sessions`, and Flue does not read `pi_sessions`.

## External Threads

Maps external systems to sessions.

Suggested columns:

```txt
id uuid primary key
source text not null
external_id text not null
session_id uuid not null references sessions(id)
metadata jsonb not null default '{}'
created_at timestamptz not null
updated_at timestamptz not null
```

Examples of `(source, external_id)` pairs:

```txt
source=slack, external_id=T123:C456:1710000000.000100
source=github, external_id=owner/repo#123
source=<generic webhook source key>, external_id=<threadId>
source=linear, external_id=<issue-id>  # planned
```

Index:

```txt
unique(source, external_id)
```

## Integration Deliveries

Tracks webhook dedupe and processing status.

Suggested columns:

```txt
id uuid primary key
source text not null
dedupe_key text not null
status text not null
received_at timestamptz not null
processed_at timestamptz
failed_at timestamptz
error text
metadata jsonb not null default '{}'
```

Index:

```txt
unique(source, dedupe_key)
```

## Callback Deliveries

Tracks outbound notifications.

Implemented columns:

```txt
id uuid primary key
session_id uuid not null references sessions(id)
run_id uuid references runs(id)
message_id uuid references messages(id)
target_type text not null
target jsonb not null
status text not null
event_type text not null
payload jsonb not null default '{}'
attempts int not null default 0
max_attempts int not null default 5
last_error text
created_at timestamptz not null
updated_at timestamptz not null
next_attempt_at timestamptz
last_attempt_at timestamptz
delivered_at timestamptz
```

Statuses:

```txt
pending
sending
sent
failed
```

## Repo Credentials

Stores credential references or encrypted material for repo access.

Suggested columns:

```txt
id uuid primary key
repo_owner text
repo_name text
provider text not null
kind text not null
encrypted_payload bytea
metadata jsonb not null default '{}'
created_at timestamptz not null
updated_at timestamptz not null
expires_at timestamptz
```

Kinds:

```txt
github_app_installation
github_user_oauth
static_token
```

Rules:

- Prefer short-lived GitHub App installation tokens minted at runtime.
- Do not write raw tokens into messages, events, or sandbox disk unless explicitly required.
- Token references are safer than token values.

## Webhook Sources

Stores generic inbound webhook configuration.

Suggested columns:

```txt
id uuid primary key
key text not null unique
name text not null
enabled boolean not null default true
auth_config jsonb not null
mapping_config jsonb not null
filter_config jsonb not null default '[]'
defaults jsonb not null default '{}'
created_at timestamptz not null
updated_at timestamptz not null
```

Current implementation stores generic webhook sources in Postgres with `key`, `name`, `enabled`, `bearer_token`, and `prompt_prefix`. Rich mapping/filter/default configuration remains a future extension.

## Transaction Patterns

Append message:

```txt
begin
  find/create session
  allocate next message sequence from durable per-session counter
  insert message
  allocate next event sequence from durable per-session counter
  insert message_created event
commit
```

The Postgres implementation keeps sequence allocation safe through `session_sequence_counters` and implements worker claim/finalize/cancellation transitions with transactional store methods where atomic state changes matter.

Claim message:

```txt
begin
  select one pending session for update skip locked, excluding paused queues
  claim every pending message in that session in sequence order
  create run row and acquire active-run lease
  mark messages processing
  insert message_started/message_batch_started/run_started events
commit
```

Complete message:

```txt
begin
  insert terminal events
  update run completed/failed
  update all claimed messages completed/failed/cancelled
  update session status
  release lease
commit
```

Cancel active run:

```txt
begin
  find active starting/running/cancelling run for session
  mark run and processing messages cancelling
  insert run_cancel_requested event
commit

worker observes cancellation
  abort runner signal

begin
  mark run and claimed messages cancelled
  insert run_cancelled/message_cancelled events
  release lease
commit
```

## Migration Policy

- Use explicit SQL migrations.
- Migrations must be deterministic and idempotent when possible.
- Schema changes require integration tests.
- Public event payload changes require contract tests.
