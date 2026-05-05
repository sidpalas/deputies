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
messages
runs
events
sandboxes
artifacts
flue_sessions
external_threads
integration_deliveries
message_callbacks
repo_credentials
webhook_sources
```

## Implementation Stages

The data model below is the target product model. It is intentionally broader than the current scaffold.

Current implemented tables:

- `sessions`
- `messages`
- `events`
- `session_sequence_counters`
- `app_migrations`

Planned tables:

- `runs`
- `sandboxes`
- `artifacts`
- `flue_sessions`
- `external_threads`
- `integration_deliveries`
- `message_callbacks`
- `repo_credentials`
- `webhook_sources`

Identifier policy:

- Product entity IDs are application-generated UUID strings. SQL tables should use `uuid` columns once the table participates in production behavior.
- Flue-owned IDs are `text` because their format is owned by Flue.
- Provider/external IDs are `text` because their format is owned by the provider.
- Per-session cursor sequences should be allocated by database-backed counters or equivalent transactional logic, not by counting rows in application memory.

## Sessions

Represents a durable background task workspace.

Suggested columns:

```txt
id uuid primary key
title text
status text not null
repo_owner text
repo_name text
repo_url text
base_branch text
working_branch text
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
completed
failed
cancelled
```

Rules:

- `sequence` is monotonically increasing per session.
- Pending messages are processed in sequence order.
- Duplicate external deliveries must not create duplicate messages.
- Follow-ups sent during an active run remain pending unless the runner supports safe injection.

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
completed
failed
cancelled
timed_out
stale
```

Rules:

- Only one `starting` or `running` run is allowed per session.
- Leases must expire if a process crashes.
- A retry should create a new run row, not overwrite historical run data.

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

Important event types:

```txt
session_created
message_created
message_started
run_started
sandbox_starting
sandbox_ready
agent_text_delta
tool_started
tool_finished
artifact_created
run_completed
run_failed
message_completed
message_failed
callback_sent
callback_failed
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

Statuses:

```txt
pending
creating
ready
running
unhealthy
snapshotting
stopped
destroyed
failed
```

Rules:

- Provider-specific fields belong in `metadata` unless frequently queried.
- A session can have multiple historical sandboxes.
- The active sandbox should be derivable by latest non-destroyed row or a session metadata pointer.

Current implementation:

- `007_sandboxes.sql` creates the product sandbox lifecycle table.
- Active sandbox lookup uses the latest non-destroyed `ready` or `unhealthy` row for a `(session_id, provider)` pair.
- The worker health-checks and reconnects a ready active sandbox before running a follow-up message.
- If health or reconnect fails, the row is marked `unhealthy` and a replacement sandbox is created.

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
screenshot
log
report
file
external_link
```

Rules:

- PR artifacts should include repo, PR number, branch, title, and URL.
- Artifacts should be referenced from events with `artifact_created`.

Current implementation:

- `008_artifacts_callbacks.sql` creates `artifacts` and `callback_deliveries`.
- Runner-returned artifacts are persisted after successful runs and emitted as `artifact_created` events.
- Generic webhook HTTP callbacks are recorded in `callback_deliveries` with `pending`, `sent`, or `failed` status.

## Flue Sessions

Stores Flue's internal session history for Node deployments. This is separate from product session state.

Suggested columns:

```txt
id text primary key
agent_id text not null
session_id text not null
app_session_id uuid references sessions(id)
data jsonb not null
version int not null default 1
created_at timestamptz not null
updated_at timestamptz not null
```

Rules:

- Treat `data` as opaque Flue-owned serialized state.
- Use a custom Postgres-backed Flue session store in production and CI.
- Do not rely on Flue's Node in-memory default outside local experiments.
- Product state remains in `sessions`, `messages`, `runs`, `events`, `artifacts`, and `sandboxes`.
- Do not create this table until `runner-flue` is implemented; the current Postgres `AppStore` is product-state persistence only.

See [Flue Persistence](./flue-persistence.md) for details.

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

Examples:

```txt
slack:T123:C456:thread_ts
github:owner/repo:issue:123
github:owner/repo:pr:456
linear:issue-id
webhook:source-key:external-thread-id
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
error text
metadata jsonb not null default '{}'
```

Index:

```txt
unique(source, dedupe_key)
```

## Message Callbacks

Tracks outbound notifications.

Suggested columns:

```txt
id uuid primary key
message_id uuid references messages(id)
session_id uuid not null references sessions(id)
source text not null
target jsonb not null
status text not null
attempts int not null default 0
last_attempt_at timestamptz
created_at timestamptz not null
completed_at timestamptz
error text
```

Statuses:

```txt
pending
sent
failed
disabled
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

For MVP this can be loaded from static config first, then moved to DB-backed admin APIs later.

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

The current scaffold has separate `AppStore` calls for sequence allocation and insert. The Postgres implementation keeps sequence allocation safe through `session_sequence_counters`; the worker phase should move multi-step message/run transitions into explicit transactions where atomic state transitions matter.

Claim message:

```txt
begin
  select pending message for update skip locked
  acquire session lease or create run row
  mark message processing
  insert message_started/run_started events
commit
```

Complete message:

```txt
begin
  insert terminal events
  update run completed/failed
  update message completed/failed
  update session status
  release lease
commit
```

## Migration Policy

- Use explicit SQL migrations.
- Migrations must be deterministic and idempotent when possible.
- Schema changes require integration tests.
- Public event payload changes require contract tests.
