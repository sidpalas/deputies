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
environments
environment_revisions
environment_revision_repositories
environment_group_shares
environment_activity
automations
automation_invocations
auth_users
auth_accounts
auth_sessions
messages
runs
events
sandboxes
artifacts
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
- `environments`
- `environment_revisions`
- `environment_revision_repositories`
- `environment_group_shares`
- `environment_activity`
- `automations`
- `automation_invocations`
- `auth_users`
- `auth_accounts`
- `auth_sessions`
- `messages`
- `runs`
- `events`
- `sandboxes`
- `artifacts`
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

## Access Groups

Access groups own sessions and automations.

Current relevant columns:

```txt
groups
  id uuid primary key
  name text not null
  default_visibility text not null
  default_write_policy text not null
  automation_create_required_role text not null
  archived_at timestamptz
  created_at timestamptz not null
  updated_at timestamptz not null
```

Rules:

- `automation_create_required_role` is `member` by default.
- `member` lets group members and admins create new scheduled automations in the group.
- `admin` limits new scheduled automation creation to group admins and super admins.
- The setting controls creation only; existing automation management still follows automation ownership and creator-management rules.

## Environments And Revisions

Environments are stable, group-owned identities with live sharing and lifecycle policy. Executable configuration is append-only: publishing creates an immutable revision and atomically advances `current_revision_id`. Repository rows belong to revisions rather than directly to the mutable environment; each codebase supports from one to 10 repositories. Activity rows durably record actors and access/configuration changes; they are not session events or telemetry.

```txt
environments
  id uuid primary key
  name text not null
  owner_group_id uuid not null references groups(id) on delete restrict
  share_mode text not null
  current_revision_id uuid not null references environment_revisions(id) on delete restrict
  current_revision_number integer not null
  archived_at timestamptz
  created_at timestamptz not null
  updated_at timestamptz not null

environment_revisions
  id uuid primary key
  environment_id uuid not null references environments(id) on delete restrict
  revision_number integer not null
  actor_type text not null
  actor_user_id uuid references auth_users(id) on delete set null
  created_at timestamptz not null
  unique(environment_id, revision_number)

environment_revision_repositories
  id uuid primary key
  revision_id uuid not null references environment_revisions(id) on delete restrict
  provider text not null
  owner text not null
  repo text not null
  branch text
  is_primary boolean not null
  position integer not null
  created_at timestamptz not null
  updated_at timestamptz not null

environment_group_shares
  environment_id uuid not null references environments(id) on delete cascade
  group_id uuid not null references groups(id) on delete cascade
  created_at timestamptz not null
  primary key(environment_id, group_id)

environment_activity
  id uuid primary key
  environment_id uuid not null references environments(id) on delete restrict
  type text not null
  actor_type text not null
  actor_user_id uuid references auth_users(id) on delete set null
  revision_id uuid references environment_revisions(id) on delete restrict
  payload jsonb not null
  created_at timestamptz not null
```

Automations referencing environments store either `follow_latest` with no pinned revision or `pinned` with an `environment_revision_id`. Every automation invocation stores the environment and selected revision before work begins, including skipped and failed invocations. Sharing remains live for both policies.

## Sessions

Represents a durable background task workspace. Sessions may also form a shallow lineage when an agent uses the opt-in `deputies` tool to spawn durable child sessions.

Current relevant columns:

```txt
id uuid primary key
status text not null
title text
context jsonb
parent_session_id uuid references sessions(id) on delete set null
spawn_depth integer not null default 0
owner_group_id uuid not null references groups(id)
visibility text not null
write_policy text not null
created_by_user_id uuid references auth_users(id)
queue_paused_at timestamptz
created_at timestamptz not null
updated_at timestamptz not null
```

Statuses:

```txt
created
queued
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
- `parent_session_id` records the durable parent-child relationship for agent-spawned child sessions. It is nullable and uses `on delete set null` so deleting or pruning a parent cannot cascade-delete work history.
- `spawn_depth` starts at `0` for root sessions and increments by one for each `deputies`-spawned child. Tool policy enforces the configured max depth before insertion.
- Child sessions inherit the parent's `owner_group_id`, `visibility`, and `write_policy`; lineage is for coordination and audit, not a separate RBAC boundary.
- Child sessions copy `created_by_user_id` from the triggering parent message when present. This is human attribution for `creator_only` write-policy checks, not an input to agent authorization.
- `queue_paused_at` is used while editing pending messages so the worker does not claim a message mid-edit.
- `context` stores durable session-level defaults such as the current repository. It must not store transient delivery data, callbacks, provider tokens, or raw webhook payloads.
- `context.deputy.notifyParentOnComplete` is allowed only as explicit control metadata for a child session to request one parent follow-up after terminal completion, failure, or cancellation. Workers clear it after consumption and may record `parentNotificationSentAt`.

Indexes:

```txt
(parent_session_id)
```

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
- Agent-authored coordination messages use `source='deputy'` so API clients and the web UI can distinguish them from human-authored follow-ups.

Indexes:

```txt
(session_id, sequence)
(status, created_at)
unique(source, dedupe_key) where dedupe_key is not null
```

## Automations

Represents group-owned rules that create agent work without a user manually starting a session at that moment.

Current columns:

```txt
id uuid primary key
kind text not null
name text not null
prompt text not null
schedule_cron text not null
enabled boolean not null
owner_group_id uuid not null references groups(id)
visibility text not null
write_policy text not null
context jsonb
created_by_user_id uuid references auth_users(id)
archived_at timestamptz
environment_id uuid references environments(id)
environment_revision_policy text
environment_revision_id uuid references environment_revisions(id)
next_invocation_at timestamptz
scheduler_lock_owner text
scheduler_locked_until timestamptz
created_at timestamptz not null
updated_at timestamptz not null
```

Rules:

- Automations are owned by access groups, not by bot users.
- `created_by_user_id` is audit and creator-management metadata; group ownership is the durable authority.
- Scheduled automations use 5-field UTC cron expressions and store the next absolute invocation timestamp.
- Disabled automations are not invoked automatically.
- Archived automations are disabled, are not invoked automatically or manually, and cannot be enabled until restored.
- Restored automations remain disabled until explicitly enabled.
- Archiving an automation's owner access group suspends automatic and manual invocations without mutating the automation's `enabled` state.
- A scheduled fire while the owner group is archived records a skipped invocation with reason `owner_group_archived`.
- Environment-backed automations explicitly use `follow_latest` or `pinned` revision policy.
- Follow-latest automations leave `environment_revision_id` null and resolve the environment's current revision when each invocation is recorded.
- Pinned automations require an `environment_revision_id` belonging to their environment.
- Automation context may contain durable prompt context such as repository, model, or branch.

## Automation Invocations

Represents one durable activation of an automation that creates or attempts to create a session.

Current columns:

```txt
id uuid primary key
automation_id uuid not null references automations(id)
trigger text not null
status text not null
scheduled_at timestamptz
session_id uuid references sessions(id)
message_id uuid references messages(id)
reserved_session_id uuid
reserved_message_id uuid
requested_by_user_id uuid references auth_users(id)
environment_id uuid references environments(id)
environment_revision_id uuid references environment_revisions(id)
reason text
error text
metadata jsonb not null default '{}'
created_at timestamptz not null
completed_at timestamptz
```

Rules:

- Invocations are separate from agent runs.
- Scheduled invocations are unique per automation and scheduled timestamp.
- Skipped invocations are recorded when domain rules prevent session creation, such as missed schedule time or an active previous automation session.
- Failed invocations are terminal records; the next scheduled time or a manual invocation creates a separate invocation.
- Every environment-backed invocation records both its environment identity and resolved immutable revision, including skipped and failed invocations.
- Reserved session/message ids are private idempotency fields and are not exposed as public invocation metadata.

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

Replayable event log. Semantic events are append-only; finalized streaming text deltas may be compacted once a later valid final response preserves the rendered text.

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
session_spawned
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
- `agent_text_delta` rows are compactable only when they are older than the compaction retention window, precede a valid `agent_response_final` for the same message, and are not needed to preserve failed/cancelled partial output.
- Consumers replay from `(session_id, sequence)`; sequences are monotonic but may have gaps after compactable deltas are removed.
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
- Stored artifact content can be created by runner-returned artifact bytes or by the Pi artifact tool, which copies a sandbox file into configured object storage.
- Object storage is optional and selected with `ARTIFACT_STORAGE_PROVIDER=disabled|filesystem|s3`; stored blob artifacts fail clearly when storage is disabled.
- Session artifacts are readable through `GET /sessions/:sessionId/artifacts`.
- Stored artifacts are downloadable through `GET /sessions/:sessionId/artifacts/:artifactId/download`.
- Text-like stored artifacts are previewable through `GET /sessions/:sessionId/artifacts/:artifactId/preview`; unsupported previews return `415 unsupported_preview`.
- Generic webhook HTTP callbacks, Slack completion replies, and GitHub completion comments are recorded in `callback_deliveries` with `pending`, `sending`, `sent`, or `failed` status.

## Runner Runtime Sessions

Stores runner-owned internal session history for durable runner continuation. This is separate from product session state.

Product state remains in `sessions`, `messages`, `runs`, `events`, `artifacts`, and `sandboxes`. Runner runtime tables are opaque SDK state used only by the runner adapter that wrote them.

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
