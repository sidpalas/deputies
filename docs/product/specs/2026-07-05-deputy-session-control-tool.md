# Deputy Session Control Tool

## Status

Superseded

The durable session-control implementation remains, but this specification's group ownership and session-policy authorization model was replaced by tenant-wide roles. See [Tenant Access](../../tenant-access.md), [Architecture](../../architecture.md), and [Deployment](../../deployment.md).

## Context

Deputies has runner-native subagent mechanisms for quick intra-run delegation, but durable work that should be visible, auditable, resumable, and independently owned needs to be represented as ordinary product sessions. The `deputies` tool gives an agent a scoped product-session control surface without exposing raw credentials or broad API access inside the sandbox.

## Goals

- Expose an opt-in `deputies` tool for the Pi runner.
- Keep implementation runner-agnostic in `sessions/deputy-tool.ts`, with thin runner adapters.
- Enforce scoped agent authorization for read, spawn, follow-up, and cancel actions.
- Persist parent/child lineage for UI visibility and auditability.
- Make spawn transactional and retry-safe.
- Bound fanout and depth.
- Keep `get_session` cheap enough for polling.

## Non-Goals

- Replacing the Pi `subagent` tool for work that should die with the current run.
- Cascading parent cancellation or archival to spawned children.
- Shipping a public MCP server in the first implementation.

## Proposed Design

- `sessions/deputy-tool.ts` owns schema validation, policy checks, durable session operations, and result serialization.
- `auth/agent-authorization.ts` defines the session-agent policy: read and manage any tenant session plus private sessions owned by the acting private session's owner. Spawned children inherit access initially, but lineage does not constrain later access or promotion.
- The Pi adapter exposes the `deputies` action surface when `DEPUTY_TOOL_ENABLED=true`.
- `spawn` creates a child session with status `queued`, parent lineage, inherited access fields, and an initial pending message.
- `idempotencyKey` deterministically derives child session/message IDs so retrying returns the same child without consuming more quota.
- `notifyOnComplete=true` stores child context that is consumed once when the child reaches a terminal outcome. Successful parent notifications are informational and output-free; failure notifications include bounded diagnostic error text.
- Parent cancellation and archival never cascade. Agents and humans must explicitly cancel children they no longer need.

## Data Model / Schema Changes

- Add `sessions.parent_session_id uuid references sessions(id) on delete set null`.
- Add `sessions.spawn_depth integer not null default 0`.
- Add `sessions_parent_session_id_idx`.
- Add `session_spawned` event type.
- Allow `context.deputy.notifyParentOnComplete` and `context.deputy.parentNotificationSentAt` as explicit control metadata.

## API / Contract Changes

- Agent tool actions: `spawn`, `list_sessions`, `get_session`, `send_message`, `cancel`.
- `list_sessions` defaults to the full readable set for the acting session agent; explicit `scope=children` narrows to direct children.
- `get_session` defaults to a cheap summary. `includeTranscript=true` or transcript pagination params return bounded newest-first transcript pages; agents should use runner-native subagents when a large transcript needs summarization.
- Spawned children copy `createdByUserId` from the triggering parent message when present for human write-policy attribution; session-agent authorization ignores `createdByUserId`.
- New config: `DEPUTY_TOOL_ENABLED`, `DEPUTY_MAX_SPAWN_DEPTH`, `DEPUTY_MAX_CHILDREN_PER_SESSION`, `DEPUTY_MAX_SPAWNS_PER_RUN`.
- Web session DTOs include `parentSessionId` and `spawnDepth`.
- Web UI displays session lineage and labels deputy-authored messages.

## Testing Plan

- Unit-test agent policy, `deputies` action behavior, list scoping, direct-child follow-up/cancel, quotas, and worker notifications.
- Integration-test Postgres atomic child session and first-message creation.
- Run control-plane typecheck, lint, unit, and integration suites.
- Run web typecheck, unit, build, and e2e checks for lineage rendering.

## Rollout / Migration Plan

- Ship migration first; existing sessions backfill to `spawn_depth=0` and no parent.
- Keep `DEPUTY_TOOL_ENABLED=true` by default, with `DEPUTY_TOOL_ENABLED=false` available for conservative deployments.
- Enable per deployment after reviewing worker capacity and spawn caps.

## Risks And Tradeoffs

- Spawned children can outlive a bad parent turn. This is intentional and bounded by spawn caps plus human visibility.
- Parent notifications can be orphaned if the parent is archived. This is expected and warn-only.
- Polling child state must use bounded store accessors rather than full event replay.

## Open Questions

- Whether to expose the same scoped surface through MCP for external agent runtimes.
- Whether the parent UI should add a human-triggered "cancel active children" action.

## Links

- Related PRD: `docs/product/prds/2026-07-05-deputy-session-control-tool.md`
- Related decisions: `docs/product/decisions/2026-07-06-no-lifecycle-cascade-from-parent-sessions-to-spawned-children.md`
- Related pull requests: pending, `feature/deputy-session-control-tool`
