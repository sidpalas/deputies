# Flue Upgrade Notes

Deputies is currently pinned to `@flue/sdk@0.5.1`; latest upstream Flue in `../flue-upstream` is `0.8.0`.

## Upgrade Plan

1. Phase 1: upgrade Flue and handle breaking changes.
2. Phase 2: adopt new Flue features where they fit Deputies.

## Phase 1: Breaking Changes

- Runtime APIs moved from `@flue/sdk` to `@flue/runtime`. The latest `@flue/sdk` is now the deployed-app client package, and legacy subpaths like `@flue/sdk/app`, `@flue/sdk/internal`, and `@flue/sdk/sandbox` throw migration errors.
- `ctx.init({ ... })` was replaced by `ctx.init(createAgent(...), options)`. Deputies must move model, sandbox, cwd, persistence, tools, and instructions into a created agent profile/runtime config.
- `ToolDef` was renamed to `ToolDefinition`. Existing custom tools should import from `@flue/runtime`, and can later be wrapped with `defineTool(...)`.
- Roles were replaced by named agent profiles/subagents. Current `roles: {}` config and `event.role` handling need to become `subagents: {}` and `event.agent`.
- Flue event types expanded for agent lifecycle, model turns, message events, and tool execution telemetry. Deputies should explicitly ignore or normalize new events in `runner-flue/runner.ts`.
- Sandbox helper imports should come from root `@flue/runtime`, not `@flue/runtime/sandbox`.
- Flue sandbox timeout units are seconds, while Deputies adapter options use milliseconds. The migration must preserve Deputies' millisecond semantics at the adapter boundary.

## Persistence Assessment

- `SessionData` is still version `3` in Flue `0.8.0`.
- `SessionStore` is still `save/load/delete`.
- Deputies' current key format, `agent-session:["deputies","runner","<sessionId>"]`, still matches upstream harness storage keys.
- Existing legacy key fallback logic in `RealFlueAgentFactory` should be preserved.
- Deputies keeps clear Flue storage identities (`deputies`/`runner`) and carries a small `@flue/runtime` package patch that hashes only provider-facing affinity keys longer than 64 characters. This avoids a storage migration and covers nested child tasks until upstream handles cache-key length limits.
- No Postgres schema migration appears required for `flue_sessions`.

## Phase 2: Feature Opportunities

- Implemented in the initial upgrade: capture Flue prompt response `model` and aggregate `usage` on run completion and final response events, and show model/token/cost metadata in diagnostics when available.

Remaining opportunities:

- Use model-aware compaction defaults and consider exposing compaction config.
- Add an explicit compact-session operation only if the UI/API can guard against active runs.
- Add named subagents for specialized work such as repository research, test running, PR authoring, preview publishing, and artifact curation.
- Move stable Deputies tool guidance into packaged Markdown skills.
- Consider model-turn observability, but persist only allowlisted metadata. Raw prompt, message, and tool telemetry can contain secrets or repository contents.
- Image input support is a future product opportunity for vision-capable models.

## Low-Priority Or Not Applicable

- Flue public `/agents`, `/workflows`, `/runs`, WebSocket, OpenAPI, and admin app surfaces do not replace Deputies' product sessions, durable queue, callbacks, artifacts, cancellation, and UI events.
- Cloudflare Shell, Wrangler/Durable Object migrations, and Cloudflare AI Gateway are not directly relevant to the current control-plane runner architecture.
