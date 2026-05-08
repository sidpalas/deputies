# Domain Design

## Position

Use lightweight domain-driven design. Do not use heavy DDD ceremony.

The system has real domain concepts that need protection from infrastructure details:

- sessions
- messages
- runs
- events
- sandboxes
- artifacts
- integrations
- callbacks
- credentials

These should be modeled explicitly in code. They should not be reduced to route handlers that directly mutate tables.

## Why DDD Fits

Background-agent systems fail at boundaries:

- A Slack thread accidentally starts a second session.
- A worker processes the same message twice.
- A sandbox reconnect creates a new workspace instead of resuming.
- A callback announces success before a PR exists.
- A provider-specific assumption leaks into the core workflow.
- Flue session state is confused with product session state.

DDD helps because it names these concepts and keeps the invariants close to the code that owns them.

## What We Mean By Lightweight DDD

Use:

- clear bounded contexts;
- services for workflows that span entities;
- explicit state transitions;
- repository/store interfaces;
- anti-corruption layers for external systems;
- domain vocabulary in code and tests.

Avoid:

- abstract factories everywhere;
- excessive entity/value-object hierarchies;
- generic repository patterns without purpose;
- splitting every small operation into many classes;
- hiding simple data behind needless ceremony.

## Bounded Contexts

### Session Context

Owns the user-visible unit of work.

Concepts:

- `Session`
- `Message`
- `Run`
- `Event`
- `Artifact`

Invariants:

- A session has ordered messages.
- A session has replayable events.
- A session can have at most one active run.
- Message processing status must be durable.
- Completion must produce terminal events.

Modules:

```txt
apps/api/src/sessions
apps/api/src/messages
apps/api/src/runs
apps/api/src/events
apps/api/src/artifacts
```

### Sandbox Context

Owns isolated execution environments.

Concepts:

- `SandboxProvider`
- `SandboxHandle`
- `SandboxHealth`
- `SandboxCapabilities`

Invariants:

- Provider-specific behavior stays behind the provider interface.
- A sandbox must be healthy before a run starts.
- Destroy is idempotent.
- Snapshots are optional optimizations, not correctness requirements.

Modules:

```txt
apps/api/src/sandbox
```

### Runner Context

Owns agent harness execution.

Concepts:

- `Runner`
- `RunnerInput`
- `RunnerResult`
- `FlueRunner`
- `FakeRunner`

Invariants:

- Only `runner-flue` imports `@flue/sdk`.
- Runner emits normalized events.
- Runner does not own product session state.
- Flue runtime state is persisted separately through the Flue session store.

Modules:

```txt
apps/api/src/runner
apps/api/src/runner-flue
```

### Integration Context

Owns external source normalization and callbacks.

Concepts:

- `ExternalThread`
- `IntegrationDelivery`
- source-specific normalized webhook inputs
- message `context.callback` targets
- `CallbackDelivery`

Invariants:

- Integrations never run agents directly.
- Inbound deliveries are authenticated and deduped.
- External content is rendered as clearly labelled source-specific prompt context.
- External thread IDs deterministically map to sessions.

Modules:

```txt
apps/api/src/integrations
apps/api/src/integrations/prompt-bounds.ts
apps/api/src/integrations/slack/prompts.ts
```

### Persistence Context

Owns durable storage implementations.

Concepts:

- `AppStore`
- Postgres implementation
- in-memory implementation for tests/dev
- migrations

Invariants:

- Domain modules depend on store interfaces, not SQL details.
- Store code does not import domain services.
- Product state and Flue runtime state are stored separately.
- Memory storage is for deterministic tests and local experiments; durable product behavior uses Postgres.

Modules:

```txt
apps/api/src/store
```

## Aggregate Boundaries

### Session Aggregate

The main aggregate is the session.

It owns:

- session status;
- message ordering;
- run exclusivity;
- event sequence;
- artifacts produced for the session.

Rules:

- Commands that affect message ordering or run state should go through session/message/run services.
- Route handlers should not hand-edit session state.
- Workers should acquire a session run lease before processing messages.

### External Thread Mapping

External thread mapping is separate from the session aggregate but points to it.

Rules:

- Slack/GitHub/Linear IDs do not belong as first-class columns on `sessions`.
- `external_threads` maps source-specific IDs to sessions.
- This keeps the session model source-neutral.

### Sandbox Record

Sandbox records are associated with sessions but not owned by the session aggregate in memory.

Rules:

- The sandbox lifecycle manager owns create/connect/health/destroy decisions.
- The session only references sandbox status through durable records and events.

## Anti-Corruption Layers

External systems must be translated at the boundary.

| External System | Internal Translation |
|---|---|
| Slack events | source-specific normalized event + external thread mapping + callback target |
| GitHub webhooks | source-specific normalized event + prompt context + callback target |
| Linear webhooks | planned normalized event + repo resolution + callback target |
| Generic webhooks | required simple payload shape -> session/message/context/callback target |
| Flue | `Runner` interface + Flue session store |
| Sandbox providers | `SandboxProvider` interface + capabilities |

Do not let external payload shapes leak into core session/message/run services.

## Current Scaffold Alignment

The current code already follows this direction:

```txt
apps/api/src/sessions/service.ts     # session domain operations
apps/api/src/messages/service.ts     # message queue operations
apps/api/src/events/service.ts       # append/replay events
apps/api/src/store/types.ts          # persistence port
apps/api/src/store/memory.ts         # deterministic test/local adapter
apps/api/src/store/postgres.ts       # durable product state adapter
apps/api/src/db/migrations           # SQL migrations
apps/api/src/runner/types.ts         # runner port
apps/api/src/worker/service.ts       # durable work coordinator
apps/api/src/runner-flue             # Flue runner adapter
apps/api/src/sandbox/types.ts        # sandbox provider port
```

This is intentionally not full DDD ceremony. It is enough structure to keep agents from collapsing the design into route handlers plus SQL.

## Testing Implications

DDD boundaries should be enforced by tests:

- Unit test domain services without HTTP.
- Integration test API behavior through HTTP.
- Architecture fitness tests should prevent forbidden imports.
- Provider conformance tests should validate every sandbox implementation.
- Integration tests should prove external payloads normalize into internal envelopes.

## Guidance For Agents

When adding a feature:

1. Identify the bounded context first.
2. Add or update domain services before route glue.
3. Keep external payloads out of core domain modules.
4. Put provider-specific logic behind interfaces.
5. Add tests at the domain boundary and at one user-visible boundary.

If a change requires importing `@flue/sdk` outside `runner-flue`, importing provider SDKs outside `sandbox`, or importing Slack/GitHub/Linear types into `sessions`, the boundary is probably wrong.
