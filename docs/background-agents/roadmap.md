# Roadmap

## Current Status

Implemented so far:

- Core TypeScript service scaffold.
- Config parser and health endpoint.
- Core session/message/event modules.
- HTTP routes for creating sessions, enqueueing messages, and replaying events.
- SSE event streaming with cursor replay.
- Memory-backed `AppStore` for deterministic unit tests.
- Docker Compose local Postgres.
- SQL migration runner.
- Postgres-backed `AppStore` for `sessions`, `messages`, `events`, and sequence counters.
- Durable worker loop with `runs`, message claiming, fake-runner execution, run leases, heartbeat renewal, and stale lease recovery.
- DB-backed generic webhook sources with bearer auth, prompt prefixes, thread reuse, and delivery dedupe.
- Architecture fitness tests for core import boundaries.
- Postgres-backed Flue `SessionStore` and `runner-flue` adapter seam.
- Postgres integration test path.
- App-level Postgres worker integration test.

Still open from the early phases:

- Contract schemas for public API responses and events.

The next implementation phase should wire real Flue context/agent construction behind `runner-flue`, then add the first real sandbox provider.

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

Status: mostly implemented. Session/message/event routes, cursor replay, and SSE streaming exist. Contract schemas remain open.

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

Status: implemented for the fake-runner path. The worker can claim pending messages transactionally, enforce one active run per session, execute the fake runner, renew heartbeats, recover stale leases, and mark success/failure terminal states. More recovery policy can be added later when retry limits are introduced.

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

Status: partially implemented. The Postgres-backed Flue `SessionStore` exists and is integration-tested. A `FlueRunner` adapter seam exists and is unit-tested with a fake Flue agent factory. Real Flue context/agent factory wiring, event normalization from actual Flue events, and controlled sandbox execution remain open.

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
