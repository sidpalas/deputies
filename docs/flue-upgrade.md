# Flue Upgrade Notes

Deputies is currently pinned to `@flue/runtime@0.11.1`.

## Operator Impact

Deploying the `0.11.1` upgrade intentionally does **not** migrate existing `@flue/runtime@0.8.0` session blobs. Follow-up messages on product sessions that have old Flue runtime state will start a fresh Flue session the first time they run after the deploy.

This does not delete Deputies history: product sessions, messages, events, artifacts, runs, sandboxes, callbacks, and integration records remain in Deputies-owned tables. The only lost continuity is Flue's opaque internal conversation/tool/task state for that runner. Operators should schedule the deploy with the expectation that in-flight or long-running Flue conversations may need the next prompt to restate any context that was only present inside Flue runtime memory.

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

## Previous 0.8.0 Persistence Assessment

This section records the pre-Plan-013 `@flue/runtime@0.8.0` state.

- `SessionData` is still version `3` in Flue `0.8.0`.
- `SessionStore` is still `save/load/delete`.
- Deputies' current key format, `agent-session:["deputies","runner","<sessionId>"]`, still matches upstream harness storage keys.
- Existing legacy key fallback logic in `RealFlueAgentFactory` should be preserved.
- Deputies keeps clear Flue storage identities (`deputies`/`runner`) and carries a small `@flue/runtime` package patch that hashes only provider-facing affinity keys longer than 64 characters. This avoids a storage migration and covers nested child tasks until upstream handles cache-key length limits.
- No Postgres schema migration appears required for `flue_sessions`.

## Phase 1: `@flue/runtime@0.11.1` Migration

Plan 013 upgraded Deputies from `@flue/runtime@0.8.0` to exactly `0.11.1`. The workspace keeps `minimumReleaseAge: 4320` and exempts this direct pin with:

```yaml
minimumReleaseAgeExclude:
  - '@flue/runtime'
```

### API Mapping

| Old surface                                                                               | `0.11.1` surface                                               | Deputies decision                                                                               |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `configureProvider` from `@flue/runtime/app`                                              | `configureProvider` from root `@flue/runtime`                  | Updated `RealFlueAgentFactory` imports.                                                         |
| `createFlueContext`, `InMemorySessionStore`, `resolveModel` from `@flue/runtime/internal` | Still exported from `@flue/runtime/internal`                   | Kept the existing internal import.                                                              |
| `createAgent(() => ({ persist }))`                                                        | No `persist` runtime-config field                              | Use `createFlueContext({ defaultStore })`; the embedded harness reads that store.               |
| `SandboxFactory.createSessionEnv({ id, cwd })`                                            | `SandboxFactory.createSessionEnv({ id })`                      | The sandbox factory creates an env at the sandbox root; Flue applies agent `cwd` itself.        |
| `SessionData.version: 3` without affinity                                                 | `SessionData.version: 5` plus opaque `aff_<ULID>` affinity key | Updated tests and Postgres fixture data to the new shape.                                       |
| `tool_execution_start/update/end` events                                                  | Removed                                                        | Deleted the dead ignore cases.                                                                  |
| No `run_resume` event case                                                                | `run_resume` event exists                                      | Explicitly ignored with other runtime lifecycle events.                                         |
| Runtime faux-provider helpers from `@flue/runtime`                                        | Not exported                                                   | Unit tests register a local fake API through root `registerApiProvider` and `registerProvider`. |

### Persistence Surface

- Deputies still embeds Flue in-process through `runner-flue/agent-factory.ts`, so the required durable HTTP/runtime adapter surfaces (`connectRunStore()`, `connectRunRegistry()`, submission claiming, lease renewal, expired submission listing, `deleteSession()`, and `connectEventStreamStore()`) are not exercised by this usage.
- The custom `PostgresFlueSessionStore` remains a minimal `SessionStore` over the existing `flue_sessions` table. No schema migration was required.
- The `SessionStore` contract remains `save`, `load`, and `delete`; persisted blobs are opaque except for the boundary check that detects 0.11.1-incompatible Flue state before handing it back to the runtime.
- No in-memory substitute was added for a durable persistence surface; the only in-memory store remains Flue's default `InMemorySessionStore` when a caller does not provide persistence.

### Pre-Upgrade State

Maintainer decision: **pre-upgrade Flue sessions start fresh; Deputies history unaffected**.

`@flue/runtime@0.11.1` rejects persisted session data whose version is not `5` or whose affinity key is missing/malformed. `RealFlueAgentFactory` wraps the configured Flue `SessionStore`, logs a warning naming the Deputies session id, returns `null` for rejected pre-upgrade Flue blobs, and lets Flue create a fresh session. This only affects Flue's own conversation state. Deputies' product session history, messages, events, and artifacts stay in Deputies tables.

The legacy storage-key fallback is retained only for valid current-version Flue data and cleanup. Real pre-upgrade `0.8.0` blobs are version `3`, so they intentionally take the fresh-start path instead of being migrated.

### Patch Removal

The local `patches/@flue__runtime@0.8.0.patch` affinity-key patch was removed. Upstream fixed the provider-facing key-length issue in withastro/flue#183, commit `a783a7c`, by storing opaque `aff_<ULID>` keys per session while preserving lossless storage keys.

### Deferred Items

- Evaluate `@flue/postgres` as a replacement for the custom `PostgresFlueSessionStore`.
- Align the direct `@earendil-works/pi-*` pins with Flue's internal `0.79.x` line in a separate runner-pi decision.
- Revisit deleting the legacy storage-key fallback once no valid current-version data can exist under legacy keys.
- Revisit durable event streams and submission stores if Deputies consumes Flue over HTTP or durable dispatch instead of the current embedded in-process harness.

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
