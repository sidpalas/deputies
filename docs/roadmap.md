# Roadmap

## Current Status

Implemented so far:

- Core TypeScript service scaffold.
- Config parser, Hono transport layer, and health endpoint.
- Product API auth modes: `none`, bearer token, and AppStore-backed session cookie login for the operator UI with static and GitHub App providers.
- Stable JSON parse/body-limit errors for API routes.
- Core session/message/event modules.
- HTTP routes for creating/listing/updating/archiving/restoring sessions, enqueueing/editing/cancelling queued messages, cancelling active runs, listing/downloading/previewing artifacts, and replaying events.
- SSE event streaming with cursor replay.
- Memory-backed `AppStore` for deterministic unit tests.
- Docker Compose local Postgres.
- SQL migration runner.
- Postgres-backed `AppStore` for sessions, messages, events, runs, sandboxes, artifacts, Pi sessions, generic webhooks, callbacks, external thread mappings, and sequence counters.
- Durable worker loop with run leases, heartbeat renewal, stale lease recovery, batched same-session message claiming, queue pause/edit/cancel behavior, and active-run cancellation finalization.
- DB-backed generic webhook sources with bearer auth, prompt prefixes, thread reuse, and delivery dedupe.
- Architecture fitness tests for core import boundaries.
- Postgres-backed Pi `SessionStore` and `runner-pi` adapter seam.
- Daytona SDK dependency and sandbox provider adapter.
- Real Pi runner wiring behind `RUNNER=pi`.
- Sandbox lifecycle persistence with active sandbox reconnect/reuse.
- Opt-in real Daytona/Pi built-artifact UAT scaffold.
- Built-artifact E2E coverage for API auth, sandbox reuse, webhook auth separation, and real Daytona/Pi follow-up persistence.
- Artifact persistence, optional filesystem/S3-compatible object storage, and generic HTTP completion callbacks.
- Session artifact list/download/preview API.
- Graceful shutdown for HTTP server, worker loop, and Postgres-backed resources.
- Postgres integration test path.
- App-level Postgres worker integration test.
- Daytona sandbox idle cleanup with stop-before-destroy retention policy and advisory-lock reaper coordination.
- Vite React operator UI with provider-aware session-cookie login, session list/search, queued message editing/cancelling, active-run cancellation, archive/restore, SSE streaming, artifact panels, callback status, and per-run diagnostics derived from replayed/streamed events.
- GitHub App runtime access for allowlisted repositories, including real GitHub token minting, Pi-runner repository refresh, and opt-in real GitHub + Daytona clone UAT coverage.
- GitHub webhook ingress for issue, PR, PR review comment, and PR review events with signature verification, delivery dedupe, repository/user/repository-owner allowlists, required trigger-phrase gating when webhooks are enabled, session mapping, bounded context fetching, received reactions, and completion comments through the callback dispatcher.
- Agent runtime GitHub repository tooling for repository selection/preparation, authenticated `gh`, and authenticated guarded `git` operations inside prepared sandbox repositories.
- Agent-created stored artifacts through Pi artifact tools, with SeaweedFS-backed local Compose storage and web UI image/text previews.

Still open from the early phases:

- Public API response schemas are implemented in `src/app/response-schemas.ts`; event payload schemas remain open.

The next implementation phase should focus on operational polish and the remaining GitHub/artifact integration gaps: collaborator permission checks, label-based triggers, provider-owned branch/PR helpers, artifact retention cleanup, richer UI observability for sandbox cleanup, sandbox cancellation conformance coverage, release/migration commands, Railway/ECS/Kubernetes guidance, and event payload schemas.

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

- `RUN_MODE=combined`, `RUN_MODE=api`, and `RUN_MODE=worker` are parseable. `RUN_MODE=all` remains accepted as a compatibility alias.
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
- API response schemas and event payload schemas.

Acceptance criteria:

- Creating a session writes a `session_created` event.
- Appending a message writes a `message_created` event.
- Event replay by cursor works.
- SSE stream receives appended events.

Status: implemented beyond the original scope. Session/message/event routes, cursor replay, SSE streaming, title updates, archive/restore, queued follow-up edit/cancel, active-run cancellation routes, and API response schemas exist. Event payload schemas remain open.

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

Status: implemented for fake and Pi runner paths. The worker claims pending messages transactionally, batches all queued messages for one session, enforces one active/cancelling run per session, executes the configured runner, renews heartbeats, recovers stale leases, supports active-run cancellation, and marks success/failure/cancel terminal states. More recovery policy can be added later when retry limits are introduced.

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

Status: implemented for the first DB-backed shape. Webhook sources are stored in Postgres with bearer tokens and prompt prefixes. The route accepts the shared integration ingress-style fields `thread.externalId`, `dedupeKey`, `title`, `prompt`, `actor`, `repository`, `callback`, and `context`; reuses sessions by external thread; dedupes deliveries; and enqueues prefixed prompts. Configurable JSON-path mapping/filtering/templates remain future enhancements.

## Phase 5: Runner Adapter

Goal: connect real Pi agent execution behind the runner interface.

Deliverables:

- `runner-pi` module.
- Postgres-backed Pi session store.
- Pi initialization from session/message context.
- Remote coding-agent setup flow based on the product sandbox abstraction.
- Event normalization from Pi events to internal events.
- Prompt builder integration.
- Fake and real runner selectable by config.

Acceptance criteria:

- Only `runner-pi` imports Pi SDK packages.
- Pi session history survives process restart.
- Fake runner remains default in deterministic tests.
- Real Pi runner can execute a minimal prompt in a controlled sandbox.
- Real Pi runner can initialize a project-scoped agent with a sandbox `cwd`.
- Real Pi runner uses Pi tools/session APIs rather than a parallel harness.
- Pi text/tool/task events are persisted as normalized events.

Status: implemented for Pi. The Postgres-backed Pi session store exists, `PiRunner` is wired behind `RUNNER=pi`, Pi uses sandbox-backed tools, and Pi events are normalized into product events.

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

Status: implemented for the current provider set. The fake provider and Daytona provider adapter exist. Daytona creation, connection, start, stop, health, destroy, exec, and filesystem operations are unit-tested with an SDK-shaped fake client. The `sandboxes` table persists provider sandbox IDs, workspace paths, status, metadata, and health timestamps. The worker reuses ready/stopped active sandboxes for follow-up messages, restarts stopped Daytona sandboxes before reconnect, and creates a replacement if health/connect fails. Idle cleanup stops sandboxes before retention destroy, and archive destroys active sandboxes immediately. Real Daytona UAT is opt-in. Active-run cancellation propagates through repository setup shell calls, Pi prompt handling, local sandbox child processes, Docker/Kubernetes bridge fetches, and bridge-side command termination. Daytona observes cancellation before and during SDK `executeCommand` calls so Deputies stops waiting, but remains a provider-specific interruption gap because the current SDK path exposes timeouts but no explicit remote command cancel; future hardening should add provider conformance coverage and account for SDK backends that cannot interrupt running commands.

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

## Phase 8: Slack Integration

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

Status: mostly implemented. Inbound app mentions and mapped thread follow-ups create/reuse sessions, Slack signatures and URL verification are supported, duplicate events are ignored, bot messages are ignored, and allowlists enforce team/channel/user authorization; when `SLACK_SIGNING_SECRET` is set, startup requires at least one allowlist unless `UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS=true`. Received/running/completed reactions are posted best-effort, and final deputy responses are delivered through the callback dispatcher. App mentions can fetch prior unprocessed thread replies as prompt context, omit already processed Slack timestamps, decode Slack text entities, and use readable channel/user names when Slack scopes allow it. Remaining work is optional status messages beyond reactions and direct-message support later.

## Phase 8.5: Callback Observability

Goal: make asynchronous completion delivery debuggable and recoverable before adding more integrations.

Deliverables:

- API route to list callback deliveries for a session or message.
- API route to manually replay failed callback deliveries.
- Operator UI context-panel section for callback status, attempts, last error, and next retry time.
- Tests for callback visibility, retry state, and manual replay behavior.

Acceptance criteria:

- Operators can see whether a Slack or generic-webhook callback is pending, sent, retrying, or terminally failed.
- Operators can replay a failed callback without re-running the agent task.
- Callback observability works for all callback target types through the generic callback core.

Status: implemented for the current callback core. Session-scoped API routes list callback deliveries and requeue failed deliveries for replay. Manual replay preserves delivery history while extending the attempt budget for one more dispatch. The operator UI context panel shows callback status, attempts, retry timing, last error, and a replay action for failed deliveries.

## Phase 8.6: GitHub App Runtime Access

Goal: give agent runs short-lived GitHub App credentials for repository operations before GitHub webhooks start creating repo-scoped work.

Deliverables:

- GitHub App config for app ID, private key, API base URL, and webhook secret later.
- GitHub App JWT creation and installation access token minting.
- Installation resolution for a repository owner/name.
- Short-lived token caching until expiry.
- A runner/sandbox-safe way to clone and push private repositories without writing tokens to messages/events.
- Tests using a fake or emulator-backed GitHub API for JWT/token flow and installation lookup.

Acceptance criteria:

- The service can mint an installation token for an allowed GitHub repository.
- A runner can receive repo access instructions without integrations importing runner code.
- Tokens are not persisted in events, messages, artifacts, or logs.
- GitHub API base URLs remain configurable for emulator-backed tests.

Status: implemented for current runtime needs. Config parsing, GitHub App JWT signing, repository installation lookup, repository-scoped installation token minting, per-repository token caching, repository allowlist checks, and runner-safe repository access instructions exist with focused unit coverage. Messages can carry repository context, and the runner clones or fetches the repo inside the sandbox with command-scoped env auth. The agent can list/set/prepare repositories and use guarded authenticated `gh` and `git` tools for the active prepared repo. Token values are not written to events/messages/artifacts or prompt text. Opt-in real GitHub App and real GitHub + Daytona UATs verify token minting and sandbox clone/fetch. Provider-owned push/branch/PR helper operations remain next.

## Phase 9: GitHub Integration

Goal: support issue/PR mention workflows with emulator-backed confidence.

Deliverables:

- GitHub webhook route with fail-closed `X-Hub-Signature-256` verification.
- Delivery dedupe keyed by `X-GitHub-Delivery`.
- Normalized GitHub event shape with trigger/concurrency keys.
- Repository/user gating using repository allowlists, trigger phrases, and explicit allowed users/orgs; collaborator permission checks remain open.
- Mention detection for issue comments, PR comments, and PR review comments.
- Issue/PR context fetching with bounded prompt context and reserved-marker sanitization.
- GitHub callback posting through the generic callback core.
- Provider-owned branch push and PR creation helpers with branch sanitization and redacted push specs.
- Emulate-backed integration tests.

Acceptance criteria:

- Issue comment mention creates message.
- PR comment mention creates or reuses session.
- Duplicate delivery is ignored.
- Completion posts comment to emulated GitHub.
- Prompt wraps GitHub content as untrusted.
- Push/PR creation records verified PR artifacts and never persists token material.

Dependency: Phase 8.6 should exist first so GitHub-created work can clone private repositories, push branches, and create PRs through GitHub App credentials.

Status: implemented for webhook-created work and completion comments. `POST /webhooks/github/events` verifies signatures, dedupes deliveries, supports issue/PR/comment/review events, gates by repository/user/repository-owner allowlists and `GITHUB_WEBHOOK_TRIGGER_PHRASES`, maps issue/PR threads to sessions, fetches bounded prior context, records transcript-only cancelled entries for archived mapped sessions, supports `unarchive and proceed` recovery, posts best-effort received reactions, and sends completion comments through the callback dispatcher. Remaining work: collaborator permission gating, label-based triggers, provider-owned branch/PR helpers, and fuller emulator-backed coverage once GitHub App JWT handling is fixed upstream.

Detailed implementation plan: see [GitHub Implementation Plan](./integrations.md#github-implementation-plan).

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
