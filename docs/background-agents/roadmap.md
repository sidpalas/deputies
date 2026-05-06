# Roadmap

## Current Status

Implemented so far:

- Core TypeScript service scaffold.
- Config parser, Hono transport layer, and health endpoint.
- Product API auth modes: `none`, bearer token, and static-credential session cookie login for the operator UI.
- Stable JSON parse/body-limit errors for API routes.
- Core session/message/event modules.
- HTTP routes for creating/listing/updating/archiving/restoring sessions, enqueueing/editing/cancelling queued messages, cancelling active runs, listing artifacts, and replaying events.
- SSE event streaming with cursor replay.
- Memory-backed `AppStore` for deterministic unit tests.
- Docker Compose local Postgres.
- SQL migration runner.
- Postgres-backed `AppStore` for sessions, messages, events, runs, sandboxes, artifacts, Flue sessions, generic webhooks, callbacks, external thread mappings, and sequence counters.
- Durable worker loop with run leases, heartbeat renewal, stale lease recovery, batched same-session message claiming, queue pause/edit/cancel behavior, and active-run cancellation finalization.
- DB-backed generic webhook sources with bearer auth, prompt prefixes, thread reuse, and delivery dedupe.
- Architecture fitness tests for core import boundaries.
- Postgres-backed Flue `SessionStore` and `runner-flue` adapter seam.
- Daytona SDK dependency, sandbox provider adapter, and Flue `SandboxFactory` bridge.
- Real Flue agent factory wiring behind `RUNNER=flue`.
- Sandbox lifecycle persistence with active sandbox reconnect/reuse.
- Opt-in real Daytona/Flue built-artifact UAT scaffold.
- Flue live event normalization for text deltas, tools, commands, and tasks.
- Built-artifact E2E coverage for API auth, sandbox reuse, webhook auth separation, and real Daytona/Flue follow-up persistence.
- Artifact persistence and generic HTTP completion callbacks.
- Session artifact read API.
- Graceful shutdown for HTTP server, worker loop, and Postgres-backed resources.
- Postgres integration test path.
- App-level Postgres worker integration test.
- Daytona sandbox idle cleanup with stop-before-destroy retention policy and advisory-lock reaper coordination.
- Vite React operator UI with session-cookie login, session list/search, queued message editing/cancelling, active-run cancellation, archive/restore, SSE streaming, and artifact/event views.

Still open from the early phases:

- Contract schemas for public API responses and events.

The next implementation phase should focus on deployability and operational polish: release/migration commands, Railway/ECS/Kubernetes guidance, callback retry dispatch, richer UI observability for sandbox cleanup, and contract schemas for public API/events.

## Phase 0: Repository And Agent Context

Goal: make the codebase agent-ready before implementation accelerates.

Deliverables:

- `AGENTS.md` with project-wide conventions.
- `agent-constraints/planning.md`.
- `agent-constraints/adversarial-review.md`.
- `agent-constraints/implementation.md`.
- `agent-constraints/testing.md`.
- Architecture docs for module boundaries.
- Initial package/project scaffold.

Acceptance criteria:

- An agent can read one entry point and understand the intended module boundaries.
- The testing rules are explicit before production code exists.

## Phase 1: Core Service Scaffold

Goal: create the modular monolith skeleton.

Deliverables:

- Node service bootstrap.
- Config parser with `RUN_MODE`.
- Health endpoint.
- Store module with Postgres connection.
- Migration runner.
- Test harness for app + Postgres.
- Architecture fitness tests.

Acceptance criteria:

- `RUN_MODE=all`, `RUN_MODE=api`, and `RUN_MODE=worker` are parseable.
- Health endpoint works.
- Integration test can start app with test Postgres.
- Architecture tests prevent forbidden imports.

Status: implemented for the current module set. Architecture fitness tests now protect key import boundaries. The current Postgres integration suite starts the app in-process with Postgres and processes an HTTP-created message through the worker.

## Phase 2: Sessions, Messages, Events

Goal: implement durable intent and replayable observability.

Deliverables:

- `sessions` module.
- `messages` module.
- `events` module.
- Postgres schema and migrations.
- API routes:
  - `POST /sessions`
  - `GET /sessions/:id`
  - `POST /sessions/:id/messages`
  - `GET /sessions/:id/events`
  - `GET /sessions/:id/events/stream`
- Contract schemas for API responses and events.

Acceptance criteria:

- Creating a session writes a `session_created` event.
- Appending a message writes a `message_created` event.
- Event replay by cursor works.
- SSE stream receives appended events.

Status: implemented beyond the original scope. Session/message/event routes, cursor replay, SSE streaming, title updates, archive/restore, queued follow-up edit/cancel, and active-run cancellation routes exist. Contract schemas remain open.

## Phase 3: Worker, Runs, Leases

Goal: execute pending messages safely and portably.

Deliverables:

- `runs` module.
- Worker loop.
- Message claiming with `FOR UPDATE SKIP LOCKED`.
- Session run lease.
- Lease heartbeat and stale lease recovery.
- Fake runner.
- Fake sandbox provider.

Acceptance criteria:

- Worker processes pending messages using fake runner.
- Concurrent workers do not process the same message twice.
- Stale processing messages recover.
- Failed runner marks message/run failed and emits failure event.

Status: implemented for fake and Flue runner paths. The worker claims pending messages transactionally, batches all queued messages for one session, enforces one active/cancelling run per session, executes the configured runner, renews heartbeats, recovers stale leases, supports active-run cancellation, and marks success/failure/cancel terminal states. More recovery policy can be added later when retry limits are introduced.

## Phase 4: Generic Webhook Integration

Goal: support arbitrary external systems before specialized integrations.

Deliverables:

- Generic webhook source config.
- Bearer auth.
- Mapping config.
- Filter config.
- Prompt template rendering.
- Dedupe handling.
- Route: `POST /webhooks/generic/:sourceKey`.

Acceptance criteria:

- Valid webhook creates or reuses session and appends message.
- Invalid auth returns `401`.
- Duplicate delivery is ignored.
- Filtered-out payload does not create a message.
- Rendered prompt includes source, repo, request, and payload context.

Status: implemented for the first DB-backed shape. Webhook sources are stored in Postgres with bearer tokens and prompt prefixes. The route accepts `threadId`, `dedupeKey`, `title`, `prompt`, and `context`; reuses sessions by external thread; dedupes deliveries; and enqueues prefixed prompts. Configurable JSON-path mapping/filtering/templates remain future enhancements.

## Phase 5: Flue Runner Adapter

Goal: connect real Flue execution behind the runner interface.

Deliverables:

- `runner-flue` module.
- Postgres-backed Flue session store.
- Flue initialization from session/message context.
- Remote coding-agent setup flow based on Flue's documented Daytona pattern.
- Event normalization from Flue events to internal events.
- Prompt builder integration.
- Fake and real runner selectable by config.

Acceptance criteria:

- Only `runner-flue` imports `@flue/sdk`.
- Flue session history survives process restart.
- Fake runner remains default in deterministic tests.
- Real Flue runner can execute a minimal prompt in a controlled sandbox.
- Real Flue runner can initialize a project-scoped agent with a sandbox `cwd`.
- Real Flue runner uses Flue commands/tools/session APIs rather than a parallel harness.
- Flue text/tool/task events are persisted as normalized events.

Status: mostly implemented. The Postgres-backed Flue `SessionStore` exists and is integration-tested. A `FlueRunner` adapter seam exists and is unit-tested with a fake Flue agent factory. A real Flue agent factory now creates in-process Flue contexts, passes provider-backed `SandboxFactory` instances, and uses durable Flue session persistence when configured. Flue text/tool/command/task events are normalized into product events. Credential-backed controlled sandbox execution exists as opt-in UAT and should be run/hardened with real credentials.

## Phase 6: Sandbox Provider

Goal: execute coding tasks in an isolated environment through a provider abstraction.

Deliverables:

- Sandbox provider interface.
- Sandbox lifecycle manager.
- Fake provider for tests.
- One real provider, selected from Daytona, local Docker, Kubernetes, or ECS.
- Health checks.
- Provider metadata persistence.

Acceptance criteria:

- Worker ensures sandbox exists before running.
- Existing sandbox can be reconnected by provider ID.
- Unhealthy sandbox fails clearly or is recreated according to policy.
- Tests use fake provider without real infrastructure.

Status: implemented for the current provider set. The fake provider and Daytona provider adapter exist. Daytona creation, connection, start, stop, health, destroy, exec, and filesystem operations are unit-tested with an SDK-shaped fake client. The `sandboxes` table persists provider sandbox IDs, workspace paths, status, metadata, and health timestamps. The worker reuses ready/stopped active sandboxes for follow-up messages, restarts stopped Daytona sandboxes before reconnect, and creates a replacement if health/connect fails. Idle cleanup stops sandboxes before retention destroy, and archive destroys active sandboxes immediately. Real Daytona UAT is opt-in.

## Phase 7: UAT Suite

Goal: test the built artifact as users and deploy platforms will run it.

Deliverables:

- Build command.
- UAT harness that starts compiled server.
- UAT Postgres setup.
- HTTP acceptance tests.
- Emulator-backed GitHub/Slack/AWS setup if relevant tests exist.

Acceptance criteria:

- Built artifact passes health/session/message/event/generic webhook UAT.
- JSON response schemas are validated.
- User-facing errors are stable and useful.

## Phase 8: GitHub Integration

Goal: support issue/PR mention workflows with emulator-backed confidence.

Deliverables:

- GitHub webhook route.
- Signature verification.
- Delivery dedupe.
- Mention detection.
- Issue/PR context fetching.
- GitHub callback posting.
- GitHub App token support.
- Emulate-backed integration tests.

Acceptance criteria:

- Issue comment mention creates message.
- PR comment mention creates or reuses session.
- Duplicate delivery is ignored.
- Completion posts comment to emulated GitHub.
- Prompt wraps GitHub content as untrusted.

## Phase 9: Slack Integration

Goal: support Slack app mention and thread follow-up workflows.

Deliverables:

- Slack event route.
- Signature verification.
- URL verification challenge.
- Event dedupe.
- Thread-to-session mapping.
- Slack callback posting.
- Emulate-backed integration tests.

Acceptance criteria:

- App mention creates message.
- Thread follow-up maps to existing session.
- Bot messages are ignored.
- Completion posts thread reply in emulated Slack.

## Phase 10: Linear Integration

Goal: support Linear issue workflows.

Deliverables:

- Linear webhook route.
- Signature verification.
- Delivery dedupe.
- Issue-to-session mapping.
- Repo resolution rules.
- Linear callback/activity posting.
- Local fake Linear integration tests.

Acceptance criteria:

- Mention or assignment creates message.
- Follow-up comments map to existing session.
- Completion links session and PR artifact.
- Signature failure returns `401`.

## Phase 11: Deployment Targets

Goal: prove portability.

Deliverables:

- Railway deployment guide.
- ECS Fargate + RDS deployment guide.
- Kubernetes deployment guide.
- Dockerfile.
- Runtime env var reference.
- Migration/runbook docs.

Acceptance criteria:

- Same artifact runs on all targets.
- Only environment/config differs.
- No core code path depends on one platform-specific primitive.

## Phase 12: Agent Workflow Hardening

Goal: make agent-driven development compound.

Deliverables:

- Prompt/context snapshot tests.
- Promptfoo-style evals for skills/roles if used.
- Adversarial review prompt and checklist.
- CI change detection for docs/prompts/integrations.
- Optional AI review pipeline later.

Acceptance criteria:

- Changes to prompt templates require tests.
- Changes to module boundaries fail architecture tests if they drift.
- New integrations include emulator/fake-backed tests.
- New sandbox providers include conformance tests.
