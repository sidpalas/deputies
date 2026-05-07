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

| Layer | Purpose | Dependencies |
|---|---|---|
| Unit | Pure logic and domain decisions | None |
| Contract | API/event/schema stability | Schema validators |
| Integration | Module seams with real Postgres/emulators | Postgres, emulate |
| E2E | Full app behavior with fake runner/sandbox | App, Postgres |
| UAT | Built artifact behavior | Built server, Postgres, emulate |
| Adversarial | Hostile inputs and edge cases | Varies |
| Eval | Prompt/context/routing behavior | Promptfoo or equivalent later |
| Architecture fitness | Dependency boundaries | Static import checks |

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
- `IntegrationEnvelope`.
- `NormalizedEvent` payloads.
- Generic webhook source config.
- Runner input/output.
- Sandbox provider input/output.

Use runtime schemas such as Zod or Valibot. JSON responses in UAT should validate against these schemas.

## Integration Tests

Use real Postgres. Use `vercel-labs/emulate` for GitHub, Slack, and AWS when testing external service behavior.

Current local policy:

- `pnpm api:test` runs deterministic unit tests from `api/test/unit` without Postgres.
- `pnpm api:test:integration` runs Postgres-backed integration tests and requires `TEST_DATABASE_URL`.
- `pnpm api:test:load` runs a configurable Postgres-backed control-plane load profile and requires `TEST_DATABASE_URL`.
- `pnpm api:test:uat` runs built-artifact UAT tests from `api/test/uat` and requires `TEST_DATABASE_URL` plus a prior `pnpm api:build`.
- `pnpm web:test -- --run` runs the Vite/jsdom operator UI regression tests.
- `pnpm check` runs API typecheck/tests and web typecheck/tests.
- Real local Flue UAT is opt-in: set `RUN_REAL_LOCAL_FLUE_UAT=true`, `FLUE_MODEL`, and the model provider credentials required by that model before running `pnpm --dir api exec vitest run --config vitest.uat.config.ts test/uat/real-local-flue.test.ts`.
- Real Daytona/Flue UAT is opt-in: set `RUN_REAL_DAYTONA_FLUE_UAT=true`, `DAYTONA_API_KEY`, `FLUE_MODEL`, and the model provider credentials required by that model before running `pnpm api:test:uat`.
- `docker compose up -d postgres` starts local Postgres and creates both `flue` and `flue_test`.
- Integration tests apply migrations to `flue_test` and truncate app tables between tests.
- Do not run `api:test:integration` and `api:test:uat` concurrently against the same `TEST_DATABASE_URL`; both suites reset shared tables.
- Do not run `api:test:load` concurrently with integration or UAT tests against the same `TEST_DATABASE_URL`; it also resets shared tables.
- Load test knobs: `LOAD_SESSION_COUNT` defaults to `1000`, `LOAD_MESSAGES_PER_SESSION` defaults to `2`, `LOAD_WORKER_COUNT` defaults to `10`, and `LOAD_MAX_SECONDS` defaults to `120`.
- Testcontainers is deferred until we need fully hermetic per-run databases.
- Architecture fitness tests currently run with unit tests and enforce Flue SDK isolation, integration-to-runner separation, and store-to-domain-service separation.
- API tests exercise the Hono app through the Node adapter so middleware, routing, JSON responses, and SSE behavior remain covered as transport internals change.
- Slack unit/API tests cover request signature verification, URL verification challenge handling, dedupe, bot-message ignore, app mention session creation, thread follow-up session reuse, allowlist authorization, archived-session handling, prior-thread context fetching/deduping, Slack text entity decoding, readable channel/user prompt metadata, and prompt fallback behavior when Slack scopes are missing.
- API hardening tests cover invalid JSON and oversized request bodies.
- Lifecycle unit tests cover worker-loop stop behavior and idempotent resource shutdown.
- API tests cover auth modes, session-cookie login/logout, archive/restore behavior, queued-message edit/cancel/pause/resume, active-run cancellation, callback/artifact persistence, sandbox stop/destroy cleanup, and worker batching.
- Web tests cover session-cookie login, keyboard send behavior, mobile/sidebar reachability, active-run cancellation button, archived restore notice, and batch rendering for cancelled middle messages.
- `pnpm web:build` typechecks and builds the separate Vite React operator UI.

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

- GitHub App installation token flow.
- Issue comment mention creates message.
- PR review comment includes file/line context.
- Completion callback posts issue/PR comment.
- Agent-created PR artifact is reflected in emulated GitHub.

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
start app with RUN_MODE=all
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
FAKE_RUNNER_SCRIPT=basic-success
FAKE_SANDBOX_PROVIDER=ready
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
- Opt-in real Daytona/Flue flow provisions a hosted sandbox, runs through `RUNNER=flue`, and completes a message.
- Product API auth rejects unauthenticated session routes while leaving health public, including bearer and session-cookie modes.
- Follow-up messages reuse the same active sandbox and expose `sandbox_ready.created=false`.
- Generic webhook auth remains independent from product API auth.
- Real Daytona/Flue follow-up UAT validates persistent sandbox filesystem and Flue tool events.
- Generic webhook UAT validates HTTP completion callbacks and artifact events using a local callback server.
- Invalid auth returns stable JSON error.
- Duplicate delivery does not create duplicate messages.
- Event stream emits user-visible events.
- GitHub webhook creates session and callback comment in emulator.
- Slack webhook creates session and callback reply in emulator.

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

Prompt injection tests should assert that prompt builders wrap external content as untrusted data.

## Prompt And Context Tests

Prompt templates, Flue roles, and skills should be treated as code.

MVP prompt tests:

- Snapshot rendered generic webhook prompt.
- Snapshot rendered GitHub issue prompt.
- Snapshot rendered GitHub PR review prompt.
- Snapshot rendered Slack thread prompt.
- Assert untrusted content boundaries are present.
- Assert repo, actor, source, and request are present.
- Assert secrets and raw tokens are absent.

Later evals:

- Promptfoo-style routing tests for Flue skills/roles.
- Multi-model weekly regression for important routing behavior.
- Quality scoring for agent-facing Markdown if a tool is selected.

## Architecture Fitness Tests

Add static checks that protect module boundaries.

These checks are especially important for agentic development. If modules can only interact through small, tested contracts, an implementation agent can work with a bounded context window: the target module, its port types, and its tests. Boundary drift forces agents to read more of the repository, increases hallucination risk, and makes local changes harder to verify.

Required rules:

- `api` must not import `runner-flue`.
- `integrations` must not import `runner-flue`.
- `store` must not import domain modules.
- Only `runner-flue` imports `@flue/sdk`.
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
