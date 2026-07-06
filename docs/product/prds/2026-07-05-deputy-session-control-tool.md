# Deputy Session Control Tool

## Status

Building

## Problem

Agents can delegate short in-run subtasks through runner-native task tools, but they do not have a safe way to create separately visible, durable Deputies sessions for work that should be audited, resumed, monitored, or handed back to a parent session.

## Goals

- Expose an opt-in `deputies` agent tool for durable session coordination.
- Keep the core implementation runner-agnostic, with thin Flue and Pi adapters.
- Enforce scoped agent authorization for reading, spawning, messaging, and cancelling sessions.
- Persist parent/child lineage so users and agents can inspect durable delegated work.
- Make spawning retry-safe with idempotency keys and transactional first-message creation.
- Bound runaway fanout with depth, child-count, and per-run spawn limits.
- Allow one-shot parent notification when a child reaches a terminal outcome.

## Non-Goals

- Replacing runner-native task/subagent tools for quick in-run delegation.
- Exposing raw product credentials or unrestricted product API access to sandbox code.
- Adding a public MCP server in the first implementation.

## Requirements

- `DEPUTY_TOOL_ENABLED` defaults to `true`.
- Supported actions are `spawn`, `list_sessions`, `get_session`, `send_message`, and `cancel`.
- `list_sessions` defaults to all sessions the acting session may read; agents can pass `scope=children` to list only direct children.
- Child sessions inherit the parent session's owner group, visibility, and write policy.
- Child sessions copy creator attribution from the triggering parent message when present; agent policy must not use `createdByUserId` for authority.
- Agents may read organization-visible sessions or sessions in their own group.
- Agents may send messages to and cancel only non-archived direct children.
- `notifyOnComplete=true` is consumed once and sends a deputy-authored parent follow-up for completed, failed, or cancelled child runs.
- Successful parent notifications must be informational and not embed child output. Agents can inspect the child with `get_session` when useful.
- `get_session` must be summary-only by default and must return bounded newest-first transcript pages only when explicitly requested.

## Acceptance Criteria

- Flue and Pi runners expose the tool only when enabled.
- Postgres creates the child session, first message, child events, and parent `session_spawned` event atomically.
- Idempotent spawn replay returns the existing child without consuming additional spawn quota.
- Web UI shows parent/child lineage and labels deputy-authored messages.
- Unit, integration, typecheck, build, and e2e validation pass for the touched surfaces.

## Open Questions

- Whether the same scoped surface should be exposed through MCP for external agent runtimes.
- Whether parent notification prompts should later include structured links or summarized artifacts.

## Links

- Related docs: `docs/architecture.md`, `docs/data-model.md`, `docs/deployment.md`
- Related specs: `docs/product/specs/2026-07-05-deputy-session-control-tool.md`
- Related decisions: `docs/product/decisions/2026-07-06-no-lifecycle-cascade-from-parent-sessions-to-spawned-children.md`
