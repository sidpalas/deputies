# Testing Strategy

## Philosophy

The system is designed to be built and maintained by agents. Tests must be strong enough to catch agent drift, integration seam bugs, prompt/context regressions, and user-facing behavior changes.

Rules:

1. Tests are more accurate than accidental current behavior.
2. Do not weaken tests unless intentionally changing the contract.
3. Every behavior should have the lowest useful test and at least one boundary-level test.
4. External-service behavior should be tested against stateful emulators where available.
5. Prompt templates and agent context are production code and need tests.

## Test Layers

| Layer                | Purpose                                    | Dependencies                    |
| -------------------- | ------------------------------------------ | ------------------------------- |
| Unit                 | Pure logic and domain decisions            | None                            |
| Contract             | API/event/schema stability                 | Schema validators               |
| Integration          | Module seams with real Postgres/emulators  | Postgres, emulate               |
| E2E                  | Full app behavior with fake runner/sandbox | App, Postgres                   |
| UAT                  | Built artifact behavior                    | Built server, Postgres, emulate |
| Adversarial          | Hostile inputs and edge cases              | Varies                          |
| Eval                 | Prompt/context/routing behavior            | Promptfoo or equivalent later   |
| Architecture fitness | Dependency boundaries                      | Static import checks            |

## Unit Tests

Fast tests for deterministic logic.

Targets:

- Session status transitions.
- Message queue ordering.
- Worker lease decision logic.
- Stale lease detection.
- Dedupe key handling.
- External thread ID construction.
- Webhook mapping and filters.
- Prompt template rendering.
- Event normalization.
- Secret redaction.
- Sandbox provider selection.

Examples:

```txt
generic webhook mapping extracts repo/prompt/thread id
message sequencing is monotonic per session
session cannot transition from archived to active without restore
secret redactor removes known token values from event payloads
```

## Contract Tests

Schemas should protect API and event stability.

Contract targets:

- Public API responses.
- Source-specific normalized integration inputs and shared message context shape.
- `NormalizedEvent` payloads.
- Generic webhook source config.
- Runner input/output.
- Sandbox provider input/output.

Use runtime schemas such as Zod or Valibot. JSON responses in UAT should validate against these schemas.

## Integration Tests

Use real Postgres. Use `vercel-labs/emulate` for GitHub, Slack, and AWS when testing external service behavior.

Current local policy:

- `mise run //apps/control-plane:test` runs deterministic unit tests from `apps/control-plane/test/unit` without Postgres.
- `mise run //apps/control-plane:test:integration` runs Postgres-backed integration tests and requires `TEST_DATABASE_URL`.
- `mise run //apps/control-plane:test:load` runs a configurable Postgres-backed control-plane load profile and requires `TEST_DATABASE_URL`.
- `mise run //apps/control-plane:test:uat` runs built-artifact UAT tests from `apps/control-plane/test/uat` and requires `TEST_DATABASE_URL` plus a prior `mise run //apps/control-plane:build`.
- `mise run //apps/web:test` runs the Vite/jsdom operator UI regression tests.
- `mise run //apps/web:e2e` runs Playwright browser tests such as responsive context-panel coverage.
- `mise run //deploy/docker-compose:smoke:full-stack` is an opt-in Docker smoke that builds the local Postgres, SeaweedFS, built control-plane, and built web/Caddy stack, then drives Playwright through Caddy. It verifies deployed-style API proxying for browser routes such as `/repositories` and `/models` plus basic session creation against Postgres.
- `pnpm check` and `mise run //:check` run formatting, package typechecks, and package unit tests; they do not run Playwright E2E tests.
- Real local Pi UAT is opt-in: set `RUN_REAL_LOCAL_PI_UAT=true`, `API_AUTH_MODE=none`, `RUNNER_MODEL_DEFAULT`, and the model provider credentials required by that model before running `pnpm --dir apps/control-plane exec vitest run --config vitest.uat.config.ts test/uat/real-local-pi.test.ts`.
- Real Docker sandbox UAT is opt-in: use `DOCKER_SANDBOX_IMAGE=ghcr.io/sidpalas/deputies-docker-sandbox:latest`, set `RUN_REAL_DOCKER_SANDBOX_UAT=true`, and run `pnpm --dir apps/control-plane exec vitest run --config vitest.uat.config.ts test/uat/real-docker-sandbox.test.ts` to verify create, stop/start, reconnect, bridge exec/fs, live preview proxying, and cleanup against a real Docker daemon. Build `deputies-sandbox:local` only when testing unpublished sandbox image changes.
- Real Daytona/Pi UAT is opt-in: build first and set `RUN_REAL_DAYTONA_PI_UAT=true`, `API_AUTH_MODE=none`, `TEST_DATABASE_URL`, `DAYTONA_API_KEY`, `RUNNER_MODEL_DEFAULT`, and the model provider credentials required by that model before running `mise run //apps/control-plane:test:uat`.
- `mise run //deploy/local:infra:up` starts the normal local Postgres and SeaweedFS baseline from `deploy/local/docker-compose.yml`; Postgres creates both `deputies` and `deputies_test`.
- Sandboxes without nested virtualization should not assume Docker or Docker Compose is available. Use `./deploy/sandboxes/daytona/start-postgres.sh` to start Postgres directly in sandbox images that include the helper scripts, then set `DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies` and `TEST_DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies_test`.
- For broad verification inside sandbox images that include the Daytona helper scripts, run `./deploy/sandboxes/daytona/full-check.sh`; it starts Postgres, installs dependencies, runs migrations, and exercises API and web checks including Playwright e2e.
- Integration tests apply migrations to `deputies_test` and truncate app tables between tests.
- Do not run `control-plane:test:integration` and `control-plane:test:uat` concurrently against the same `TEST_DATABASE_URL`; both suites reset shared tables.
- Do not run `control-plane:test:load` concurrently with integration or UAT tests against the same `TEST_DATABASE_URL`; it also resets shared tables.
- Load test knobs: `LOAD_SESSION_COUNT` defaults to `1000`, `LOAD_MESSAGES_PER_SESSION` defaults to `2`, `LOAD_WORKER_COUNT` defaults to `10`, and `LOAD_MAX_SECONDS` defaults to `120`. Additional load profiles cover high-contention worker claiming, read-heavy session/event histories, and concurrent generic webhook ingestion. The worker backlog profile emits per-method timing summaries for store, event, runner, sandbox-provider, and `processNext` calls so regressions can be attributed to claim, event append, sandbox persistence, runner, and finalization paths. Useful knobs include `LOAD_CONTENTION_SESSION_COUNT`, `LOAD_CONTENTION_WORKER_COUNT`, `LOAD_READ_SESSION_COUNT`, `LOAD_READ_EVENTS_PER_SESSION`, `LOAD_READ_HOT_SESSION_EVENTS`, `LOAD_WEBHOOK_DELIVERY_COUNT`, `LOAD_WEBHOOK_CONCURRENCY`, latency thresholds such as `LOAD_MAX_LIST_SESSIONS_MS`, and `LOAD_REPORT_PATH` for newline-delimited JSON benchmark summaries.
- Testcontainers is deferred until we need fully hermetic per-run databases.
- Architecture fitness tests currently run with unit tests and enforce Pi SDK isolation, integration-to-runner separation, and store-to-domain-service separation.
- API tests exercise the Hono app through the Node adapter so middleware, routing, JSON responses, and SSE behavior remain covered as transport internals change.
- Slack unit/API tests cover request signature verification, URL verification challenge handling, dedupe, bot-message ignore, app mention session creation, thread follow-up session reuse, allowlist authorization, archived-session handling, prior-thread context fetching/deduping, Slack text entity decoding, readable channel/user prompt metadata, and prompt fallback behavior when Slack scopes are missing.
- GitHub unit/API tests cover webhook signature verification, delivery dedupe, event normalization, repository/user/org allowlists, trigger-phrase gating, archived-session recovery comments, bounded context fetching, completion callback comments, runtime installation token handling, repository prepare/list/set behavior, and guarded `gh`/`git` tool behavior.
- API hardening tests cover invalid JSON and oversized request bodies.
- Lifecycle unit tests cover worker-loop stop behavior and idempotent resource shutdown.
- API tests cover auth modes, static and GitHub App session-cookie login/logout, archive/restore behavior, queued-message edit/cancel/pause/resume, active-run cancellation, callback/artifact persistence, sandbox stop/destroy cleanup, and worker batching.
- Web tests cover provider-aware session-cookie login, keyboard send behavior, mobile/sidebar reachability, active-run cancellation button, archived restore notice, and batch rendering for cancelled middle messages.
- `mise run //apps/web:build` typechecks and builds the separate Vite React operator UI.

Harness responsibilities:

```txt
test/harness/
  app.ts           # start app in-process or as child process
  postgres.ts      # create/reset test database
  emulate.ts       # start/reset/close emulators
  fixtures.ts      # seed users/repos/channels/webhook sources
  wait.ts          # polling helpers
```

Core integration tests:

- Create session writes session row and event.
- Append message writes message and `message_created` event.
- Worker claims each pending message at most once under concurrent polling.
- Worker claims a same-session pending batch in sequence order.
- Paused queues are skipped until resumed.
- Active cancellation finalizes run/messages as `cancelled` and blocks next same-session claim while `cancelling`.
- Sandbox idle cleanup stops before destroying, skips active sessions, and uses advisory-lock coordination with Postgres.
- Stale processing message is recovered.
- Event replay returns events after cursor.
- SSE stream receives appended events.
- Generic webhook creates session/message.
- Invalid webhook auth returns `401`.
- Duplicate webhook delivery is ignored.

## Emulator-Backed Tests

Use [`vercel-labs/emulate`](https://github.com/vercel-labs/emulate) for stateful local service APIs.

Use emulate programmatically from tests instead of Docker Compose. Keep Docker Compose focused on durable infrastructure such as Postgres. For manual HTTPS testing, run emulate with portless:

```sh
portless proxy start
pnpm dlx emulate start --service slack --portless
```

Programmatic setup:

```ts
import { createEmulator } from 'emulate';

const github = await createEmulator({ service: 'github', port: 4001, seed });
const slack = await createEmulator({ service: 'slack', port: 4002, seed });
const aws = await createEmulator({ service: 'aws', port: 4003, seed });

process.env.GITHUB_API_BASE_URL = github.url;
process.env.SLACK_API_BASE_URL = `${slack.url}/api`;
process.env.AWS_ENDPOINT_URL = aws.url;
```

Reset after each test:

```ts
afterEach(() => {
  github.reset();
  slack.reset();
  aws.reset();
});
```

GitHub emulator tests:

- GitHub App installation token flow after the emulator accepts valid App JWTs.
- Issue comment mention creates message.
- PR review comment includes file/line context.
- Completion callback posts issue/PR comment.
- Agent-created PR artifact is reflected in emulated GitHub after provider-owned PR helpers exist.
- Archived mapped thread posts a recovery comment and does not enqueue work.

Slack emulator tests:

- App mention creates session.
- Thread follow-up maps to existing session.
- Completion callback posts thread reply.
- Bot/self messages are ignored.

AWS emulator tests:

- Artifact upload to S3-compatible endpoint.
- Large logs are stored as objects and referenced from events.
- Object storage failures produce clear events and do not crash run finalization.

## E2E Tests

E2E tests should run the whole app with fake runner and fake sandbox first.

Scenario:

```txt
start app with RUN_MODE=combined
run migrations
POST /sessions
POST /sessions/:id/messages
wait for worker completion
GET /sessions/:id/events
assert event sequence includes run_started, agent_text_delta, run_completed
assert message status is completed
```

Use fake runner outputs to make tests deterministic:

```txt
RUNNER=fake
SANDBOX_PROVIDER=fake
FAKE_RUNNER_ARTIFACT_JSON={"type":"file","title":"Test Artifact","content":"hello","contentType":"text/plain","fileName":"artifact.txt"}
```

Add failure scenarios:

- Runner throws error.
- Sandbox create fails.
- Worker crashes after message claim.
- Callback fails but run still completes.

## UAT Tests

UAT tests exercise the built service artifact, not source modules.

Flow:

```txt
build service
start compiled server with test env
connect to test Postgres
start required emulators
run HTTP acceptance suite
stop server and emulators
```

Acceptance tests:

- Health endpoint returns ready state.
- Generic webhook returns `202` and creates session/message.
- Built fake-runner flow completes through the worker and emits sandbox lifecycle events.
- Opt-in real Daytona/Pi flow provisions a hosted sandbox, runs through `RUNNER=pi`, and completes a message.
- Product API auth rejects unauthenticated session routes while leaving health public, including bearer and session-cookie modes.
- Follow-up messages reuse the same active sandbox and expose `sandbox_ready.created=false`.
- Generic webhook auth remains independent from product API auth.
- Real Docker sandbox UAT starts a tiny server inside the sandbox and fetches it through the provider service endpoint.
- Real Daytona/Pi follow-up UAT validates persistent sandbox filesystem and Pi tool events.
- Generic webhook UAT validates HTTP completion callbacks and artifact events using a local callback server.
- Invalid auth returns stable JSON error.
- Duplicate delivery does not create duplicate messages.
- Event stream emits user-visible events.
- Generic webhook UAT validates built-server webhook ingestion and HTTP completion callbacks.
- GitHub OAuth emulate UAT validates session-cookie login through the emulated GitHub OAuth flow.
- Slack/GitHub webhook callback assertions live in gated/skipped emulator-backed integration tests until emulator reliability is sufficient for regular UAT/CI.

Current GitHub emulator caveat: published `emulate@0.5.0` rejects valid GitHub App JWTs during installation token minting. Keep tests that require installation tokens skipped until a fixed emulate release is available, and keep real GitHub App smoke tests opt-in.

UAT output contracts:

- Validate JSON with schemas.
- Validate important error messages.
- Validate status codes.
- Validate observable external side effects in emulator state.

## Adversarial Tests

Security and robustness tests should be explicit, not incidental.

Initial suite:

- Webhook replay with same dedupe key.
- Invalid HMAC/signature.
- Huge payload rejection.
- Malformed JSON body.
- Path traversal in repo names, branch names, artifact paths.
- Prompt injection in GitHub/Slack/Linear content.
- Secret leakage in logs/events/errors.
- Concurrent prompts to same session.
- Concurrent workers claiming the same message.
- Worker crash and lease recovery.
- Callback API returns 500 repeatedly.
- Sandbox provider returns unreachable handle.

Prompt injection tests should assert that prompt builders separate external content from instructions and sanitize reserved wrapper markers.

## Prompt And Context Tests

Prompt templates, Pi extensions, and skills should be treated as code.

MVP prompt tests:

- Snapshot rendered generic webhook prompt.
- Snapshot rendered GitHub issue prompt.
- Snapshot rendered GitHub PR review prompt.
- Snapshot rendered Slack thread prompt.
- Assert integration context boundaries and source labels are present.
- Assert repo, actor, source, and request are present.
- Assert secrets and raw tokens are absent.

Later evals:

- Promptfoo-style routing tests for Pi skills and instructions.
- Multi-model weekly regression for important routing behavior.
- Quality scoring for agent-facing Markdown if a tool is selected.

## Architecture Fitness Tests

Add static checks that protect module boundaries.

These checks are especially important for agentic development. If modules can only interact through small, tested contracts, an implementation agent can work with a bounded context window: the target module, its port types, and its tests. Boundary drift forces agents to read more of the repository, increases hallucination risk, and makes local changes harder to verify.

Required rules:

- `api` must not import `runner-pi`.
- `integrations` must not import `runner-pi`.
- `store` must not import domain modules.
- Pi SDK runtime imports stay in `runner-pi`; config may import Pi's model catalog and auth helpers may import Pi OAuth packages.
- Public event types must be declared in one shared module.
- Public API responses must have schemas.
- Callback core must not import concrete integrations; integrations may provide callback sender plugins.

These tests protect against agent-driven architecture drift.

## CI Shape

PR checks:

```txt
lint
typecheck
unit tests
contract tests
architecture fitness tests
integration tests with Postgres
emulator-backed integration tests for changed integrations
```

Main branch / release checks:

```txt
build artifact
UAT suite against built artifact
adversarial suite
performance smoke tests
```

Scheduled checks later:

```txt
multi-model prompt/skill evals
long-running concurrency tests
real sandbox provider smoke tests
```

## Performance Smoke Tests

Initial thresholds should be loose and user-focused.

Examples:

- Generic webhook accepted p75 under 500ms.
- Append message p75 under 250ms.
- Event replay of 1,000 events p75 under 500ms.
- Worker claim loop handles 100 pending messages without duplicate claims.

Benchmarks exist to catch regressions, not to prove the system is fast.
