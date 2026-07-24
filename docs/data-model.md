# Data Model

## Goals

Postgres is the durable source of truth. The schema keeps product sessions separate from runner state, supports replayable events and idempotent integration delivery, and models one tenant-wide resource namespace. Raw SQL migrations live under `apps/control-plane/src/db/migrations`.

## Tenant Users And Authentication

`auth_users` stores an identity and one tenant-wide `role`: `viewer`, `member`, or `admin`. OAuth identities are linked through `auth_accounts`; opaque browser sessions live in `auth_sessions`. Roles are not recomputed on login. A database trigger serializes role/removal operations and rejects demoting or deleting the final admin.

Viewers can read active and archived tenant resources. Members and admins can manage ordinary tenant resources. Every authenticated user can manage only their own personal skills and snippets. Only admins manage users, roles, and instance setup/configuration. Creator columns are nullable audit attribution only and never establish ownership or authorization.

## Tenant Resources

Sessions, automations, environments, tenant-scoped skills, and explicit notepads are tenant-wide. They have no access-group owner or per-resource sharing policy. Members and admins manage them; viewers read them. Ordinary resources are archived/restored rather than hard-deleted, and archived rows remain readable.

Environment and tenant-skill names are trimmed and case-insensitively unique tenant-wide, including archived rows. Personal skill and snippet names are scoped to their owner.

### Skills And Revisions

`skills` is the stable identity and lifecycle/current-revision pointer. A skill's `scope` is either `tenant` or `personal`; personal skills retain an `owner_user_id` authorization boundary and are visible only to that user, including against admins and system bypass. `skill_revisions` stores immutable name, description, and body definitions. Creation publishes revision 1; a changed definition publishes another revision. Enabled, auto-load, and archive state remain live policy. Personal skills cannot auto-load and are available only for explicit manual invocation by their owner. New manual invocations are pinned to current by the API; historical pins remain usable only while the skill is enabled and non-archived.

### Environments And Revisions

`environments` is the stable tenant identity and lifecycle/current-revision pointer. `environment_revisions` and their repository rows are append-only executable configuration. Each codebase contains one to ten repositories with exactly one primary repository. Activity rows record actors and configuration changes.

### Prompt Snippets

`snippets` stores private, user-owned web-composer text and archive state. Every operation is restricted to `owner_user_id`; tenant admins do not bypass snippet ownership. The browser expands a selected snippet into message text; submitted messages do not retain a snippet reference.

### Explicit Notepads

`explicit_notepads` are tenant-wide durable coordination resources. `notepad_associations` links them to sessions without creating an ownership or authorization boundary. Archived notepads remain readable and cannot be ordinarily mutated until restored.

## Sessions, Messages, And Runs

`sessions` is the durable unit of work. It stores lifecycle/status, title and execution defaults, optional repository/environment context, parent lineage, spawn depth, timestamps, and nullable `created_by_user_id` audit attribution. It has no owner, visibility, or write-policy columns.

`messages` stores ordered user/deputy content, processing status, source context, and author attribution. Message author IDs support audit and managed request provenance, not private access. Agent-created child sessions are ordinary tenant resources; `parent_session_id` and `spawn_depth` represent coordination lineage only.

`runs` records each execution attempt, lease ownership, runner/model information, terminal state, and usage. Product session IDs and Pi runtime session IDs remain separate.

## Automations And Invocations

`automations` stores tenant-wide scheduled rules, cron/timezone configuration, prompt/execution defaults, enabled state, archive state, and audit creator. `automation_invocations` records due/manual/skipped/failed/completed attempts separately from agent runs. Archived automations cannot be enabled or invoked until restored; restoring leaves them disabled until explicitly enabled.

## Events

`events` is the append-only product event stream keyed by session and sequence. It drives replay, SSE, diagnostics, and audit views. Compact streaming deltas are storage optimizations rather than a substitute for terminal/audit events.

Each run emits `skills_loaded` before its first prompt, recording managed skill/revision identity, repository provenance, shadowing, invocation flags, and bounded diagnostics. `skill_invoked` records actual explicit or model-read use. Group ownership fields are not part of new event payloads.

## Sandboxes And Artifacts

`sandboxes` persists provider identity, lifecycle, reconnect metadata, encrypted provider state where required, and timestamps. Provider handles do not define product authorization.

`artifacts` belongs to a session/run and stores metadata plus either an external URL or blob-storage key. Stored bytes live behind the artifact storage abstraction; product routes authorize metadata, preview, and download.

## Integrations And Delivery

`external_threads` deterministically maps a source/external thread to one product session. `integration_deliveries` provides ingress dedupe and processing state. `callback_deliveries` provides durable outbound retry, terminal failure, and replay state. Tokens and raw credentials are not stored in messages, events, or delivery payloads.

`webhook_sources` stores generic webhook configuration. GitHub and Slack use source-specific configuration and normalized message context but converge on the same tenant session/message workflow.

## Transaction Patterns

Use transactions for state transitions that must be observed atomically: claiming messages/runs, appending ordered events, publishing immutable revisions and advancing current pointers, deduplicating ingress, and scheduling callback delivery. Lease fencing prevents stale workers from finalizing adopted work. Unique indexes enforce tenant-wide names and external-delivery identity.

## Migration Policy

Migrations are ordered, immutable SQL files and run transactionally before new application processes serve traffic. Backward-compatible rollout is preferred when API and workers can overlap; explicitly coordinated migrations may remove obsolete columns and tables.

Migration `020_single_tenant_access.sql` is the coordinated access-group upgrade. It maps existing super admins/group admins to admin, active group members to member, and others to viewer, refusing migration without an admin. It converts resources from archived groups to archived tenant resources while preserving personal skill and snippet ownership. For environment and tenant-skill name collisions, the oldest keeps its name; later rows gain the former group name, with a stable UUID suffix for further collisions. It then removes groups, memberships, shares, tenant-resource ownership, visibility, and write-policy schema.
