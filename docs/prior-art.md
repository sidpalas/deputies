# Prior Art: Open-Inspect, Open SWE, Junior, And Mistle

This document compares the portable Flue background-agent design with four reference systems:

- `background-agents`, also referred to as Open-Inspect in its docs.
- `open-swe-`, the LangGraph/Deep Agents implementation.
- `junior`, an open source Slack bot agent project with plugin, skill, sandbox, eval, and telemetry patterns.
- `mistle`, an open source background-agent platform with sandbox profiles, runtime plans, control/data-plane services, credential brokering, tunnels, and triggers.

The goal is not to copy any system directly. The goal is to identify durable patterns that fit a portable, provider-neutral Flue implementation.

See [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) before copying implementation code, schemas, tests, fixtures, config, prompts, or substantial documentation from any referenced project.

## Summary Comparison

| Area                | This Design                                          | Open-Inspect / background-agents                    | Open SWE                                          | Junior                                           | Mistle                                                      |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| Harness             | Flue behind runner adapter                           | OpenCode in sandbox runtime                         | Deep Agents / LangGraph                           | Pi agent core behind Slack runtime               | Codex/OpenCode/Pi behind `sandboxd` runtime adapters        |
| Control plane       | Portable Node service + Postgres                     | Cloudflare Workers + Durable Objects + D1/KV        | LangGraph server/webapp + thread metadata/store   | Hono/Nitro request runtime + Redis/memory state  | Dashboard + control-plane and data-plane services           |
| Deployment target   | Railway, ECS, Kubernetes, local                      | Cloudflare + Modal/Daytona                          | LangSmith/LangGraph oriented, pluggable sandboxes | Vercel/serverless-oriented app shell             | Local Docker Compose, Docker/E2B, self-hosting roadmap      |
| Session state       | Postgres tables                                      | Durable Object SQLite per session + D1 shared state | LangGraph thread state and metadata               | Conversation state adapter + turn checkpoints    | Control/data-plane DB records + active runtime plan         |
| Queueing            | Postgres messages + leases                           | DO-local message queue                              | LangGraph store queue for busy threads            | Thread locks, timeout resume, pending auth state | OpenWorkflow durable workflows + idempotency keys           |
| Events              | Append-only Postgres event log + SSE                 | DO event table + WebSocket fanout                   | Agent/tool stream plus source replies             | Slack-visible replies/status + structured evals  | Lifecycle telemetry + tunnel/runtime stream routing         |
| Sandbox abstraction | Provider interface + capabilities                    | Provider lifecycle manager for Modal/Daytona        | Sandbox backend protocol selected by env          | Sandbox executor + dependency snapshot profiles  | Sandbox profile + compiled runtime plan + provider adapters |
| Runtime bridge      | Optional, provider-dependent                         | Required sandbox bridge/supervisor                  | Provider-specific backend wrappers                | Tool wrapper + sandbox executor facade           | `sandboxd`, gateway tunnel, and runtime-specific proxies    |
| Integrations        | Thin adapters with source-specific normalized inputs | Slack/GitHub/Linear bots call control plane         | Webhooks normalize into LangGraph thread IDs      | Rich Slack routing, outbound, OAuth contracts    | Definition registry, bindings, managed egress, triggers     |
| Testing             | Agent-first layered tests + emulate                  | Strong production code, infra-specific tests/docs   | Python tests around utility/webhook behavior      | MSW Slack tests + rubric evals                   | Strict schema validation, CI, system/test harness packages  |

## Non-Open-Source References

Several hosted background-agent products are relevant for product comparison, but are not used as open source prior art in this document.

- OpenHands Cloud / OpenHands Enterprise: OpenHands has MIT-licensed non-`enterprise/` code, but the pieces that make it more similar to a hosted agent are described as cloud/enterprise features, including SaaS or self-hosting in your VPC and Enterprise SAML/SSO. The `enterprise/LICENSE` is PolyForm Free Trial, not MIT or Apache-2.0.
- Ona: relevant as a hosted background-agent product reference, but not available as MIT or Apache-2.0 open source prior art.
- Devin: relevant as a hosted background-agent product reference, but not available as MIT or Apache-2.0 open source prior art.

These systems can inform product expectations at a high level, but Deputies should not use their non-open-source or source-available implementation details as prior art for code, schemas, prompts, tests, or architecture.

## What We Should Adopt From Open-Inspect

Deputies has implemented patterns similar to several Open-Inspect control-plane ideas. Keep these as architectural guardrails, not as a request to recreate Cloudflare Durable Objects or OpenCode-specific runtime pieces.

### 1. Session As The Core Actor

Open-Inspect is built around a durable session object. A session owns messages, events, artifacts, sandbox state, participants, and WebSocket subscribers.

Adopt the concept, not the Cloudflare implementation.

In this design:

- Durable Object has become Postgres-backed product state.
- DO-local SQLite has become regular Postgres tables for sessions, messages, runs, events, sandboxes, artifacts, external threads, integration deliveries, callbacks, and Flue session blobs.
- WebSocket hibernation has become replayable event cursors over SSE.
- Per-session actor exclusivity has become Postgres run leases and worker claim rules.

Keep the distinction between product state and Flue runtime state. Product sessions own user-visible state and work orchestration. Flue session persistence is stored opaquely in `flue_sessions` and should not become the product database.

### 2. Append-Only Events With Replay

Open-Inspect treats events as durable state and broadcasts them to connected clients.

Adopt:

- Store events before broadcasting.
- Give every session event a cursor/sequence.
- Allow clients to reconnect and replay.
- Treat SSE/WebSocket as delivery only.

This is implemented through the `events` table, per-session event sequences, event replay, and `GET /sessions/:id/events/stream`.

### 3. Message Queue Decoupled From Active Connections

Open-Inspect can keep running after the user disconnects. Client presence is not required for progress.

Adopt:

- API requests append durable messages.
- Workers process messages asynchronously through run leases.
- Follow-ups queue while a session is busy and are claimed as an ordered same-session batch when the session becomes runnable.
- Clients can close and later inspect events/artifacts.

### 4. Sandbox Supervisor + Bridge Split

Open-Inspect separates sandbox supervision from protocol bridging:

- Supervisor owns repo setup, processes, dev server, and runtime lifecycle.
- Bridge owns control-plane connection, commands, event translation, buffering, and ACKs.

Adopt selectively, not as a universal runtime requirement:

- For providers with poor native exec/filesystem APIs, use a bridge.
- Keep provider lifecycle and runner protocol separate.
- Do not require the bridge for every provider.

This is most relevant for Docker, ECS, and Kubernetes. Daytona and other third-party providers can keep using direct provider APIs where those APIs are sufficient.

### 5. Provider Lifecycle Manager

Open-Inspect has a lifecycle layer that decides when to create, restore, stop, snapshot, or mark sandboxes stale.

Adopt:

- Provider interface.
- Provider capability flags.
- Separate lifecycle policy from provider API calls.
- Health checks, reconnect/reuse, start/stop, idle cleanup, and stale sandbox recovery.
- Snapshots as optimization, not core correctness.

### 6. Thin Integrations

Open-Inspect's Slack/GitHub/Linear integrations are mostly webhook-to-session translators. Deputies uses a similar shape for generic webhooks, Slack, and GitHub.

Adopt:

- Verify signatures.
- Dedupe deliveries.
- Normalize source context.
- Map external thread to session.
- Enqueue message.
- Send lightweight received/progress signals where useful.
- Let the worker/runner do the actual agent work.
- Keep final external replies in callback senders, not in agent tools.

### 7. Shared Protocol Types

Open-Inspect has shared session and event contracts used by clients, control plane, and sandbox runtime.

Adopt:

- One canonical event schema. This exists in code, but public event schemas still need contract-test coverage.
- One canonical sandbox provider contract.
- Public API response schemas and UAT validation.
- Source-specific integration envelopes until repetition justifies a shared `IntegrationEnvelope` type.
- Contract tests for these schemas and boundaries.

### 8. Callback Contexts

Open-Inspect keeps enough source context to notify Slack/Linear/GitHub when work progresses or completes.

Adopt:

- Store message callback targets.
- Drive outbound callbacks from message/run completion and normalized internal state.
- Retry callback delivery independently from run completion.
- Keep callbacks sparse by default.
- Block agent tools from posting duplicate final Slack/GitHub replies when callback senders own that surface.

## What We Should Avoid From Open-Inspect

### 1. Cloudflare-Specific Control Plane As A Requirement

Open-Inspect's core design is tightly aligned with Cloudflare Durable Objects, D1, and KV.

Avoid as mandatory infrastructure.

Use:

- Postgres for state.
- Postgres leases for actor-like exclusivity.
- SSE/WebSocket replay from the event log.

### 2. Modal-First Assumptions

Open-Inspect gets a lot from Modal snapshots and fast starts.

Avoid making snapshots or Modal semantics required.

Use provider capabilities instead.

### 3. WebSocket As The Primary Persistence Boundary

Open-Inspect has a sophisticated sandbox WebSocket protocol.

Avoid requiring long-lived bidirectional sockets for every provider.

Use bridges where helpful, but let providers implement direct APIs when simpler.

## What We Should Adopt From Open SWE

Deputies has implemented patterns similar to Open SWE's source-normalization and GitHub workflows. The remaining work is hardening, richer PR workflows, and permission refinements rather than using the base model wholesale.

### 1. Deterministic External Thread IDs

Open SWE maps Slack, Linear, and GitHub source objects to deterministic thread IDs.

Current storage keeps `source` separate from `external_id`, for example:

```txt
source=slack, external_id=team:channel:thread_ts
source=github, external_id=owner/repo#number
source=<generic webhook source key>, external_id=<threadId>
source=linear, external_id=issue_id  # planned
```

The older `github:owner/repo:issue:123` and `github:owner/repo:pr:456` shapes remain useful design references, not current persisted values.

This pattern is implemented for generic webhooks, Slack, and GitHub. It makes follow-ups route predictably to the same product session while keeping source-specific metadata on messages and external-thread records.

### 2. Busy Thread Follow-Up Queue

Open SWE does not start duplicate agents when a thread is already busy. Deputies uses a similar one-active-run-per-session invariant, but processes follow-ups as an ordered same-session batch when the session is next claimed rather than requiring mid-turn injection before the next model call.

Adopt:

- Same-session follow-ups queue in `messages`.
- Worker enforces one active or cancelling run per session.
- Worker claims pending same-session messages transactionally and preserves sequence order.
- Mid-turn injection can remain a future optimization only if Flue exposes a clean, tested hook.

### 3. Pluggable Sandbox Backend

Open SWE selects sandbox providers through a common backend protocol.

Adopt:

- Provider abstraction.
- Reconnect by persisted sandbox ID.
- Health check before reuse.
- Recreate when unreachable according to policy.

Flue's documented Daytona coding-agent example remains relevant. Deputies uses a durable wrapper around that idea: persisted sandbox records, reconnect/reuse policy, pre-prompt repository setup through sandbox shell operations, and project-scoped Flue execution with `cwd` set to the prepared repository. A separate long-lived setup agent is not required for the current implementation.

### 4. GitHub App Token Handling

Open SWE mints GitHub App installation tokens and avoids blindly storing real tokens in the sandbox when possible. Deputies now has a similar credential boundary.

Preserve:

- Runtime GitHub App installation token minting.
- Store credential references or encrypted payloads, not raw tokens in events/messages/artifacts/callbacks/prompts.
- Prefer short-lived tokens.
- Redact all token material from logs and events.
- Pass git credentials as command-scoped environment where possible, not as persisted command text.
- Keep guarded `gh` and authenticated `git` tools in trusted worker policy code.

### 5. Source-Specific Prompt Builders

Open SWE builds rich prompts for Slack, Linear, GitHub issues, and GitHub PRs. Deputies now has source-specific Slack and GitHub prompt builders.

Adopt:

- Common prompt safety wrapper.
- Source-specific context sections.
- Compact labeled sections and separators that are safe in the web UI.
- Sanitization of reserved wrapper markers and bounded prior context.
- PR review context including file, line, and diff hunk.

### 6. Prompt-Driven PR Completion With Verification

Open SWE instructs the agent to create/update PRs with `gh` and to report only after success. Deputies now supports guarded `gh pr create` / `gh pr edit` paths and records verified PR URLs as external resources.

Preserve the verification rule:

- Do not claim PR success without a verified PR URL.
- Record PR URLs as product external resources/artifacts, not only as assistant text.
- Keep final GitHub issue/PR comments in callback senders.
- Continue improving provider-owned branch/push/update helpers and duplicate/update policy.

## What We Should Avoid From Open SWE

### 1. Thread Metadata As The Only Durable Product State

Open SWE can lean on LangGraph thread metadata and state.

Avoid making Flue session history our only system of record.

Use Postgres for product state:

- sessions
- messages
- runs
- events
- artifacts
- sandboxes
- external thread mappings

Flue history is runner state, not the whole product database.

### 2. Prompt-Only Enforcement For Critical Workflow Gates

Open SWE relies heavily on system prompts for validation, PR creation, and notification behavior.

Adopt prompts for agent guidance, but enforce critical rules in code where possible:

- one active run per session
- webhook dedupe
- token redaction
- event persistence
- verified artifact creation
- callback retry/failure handling

### 3. Provider-Specific Token Proxy As A Requirement

Open SWE's LangSmith proxy pattern is useful, but should not be required.

Adopt the goal:

- avoid leaking long-lived credentials into sandboxes.

Allow multiple implementations:

- runtime-minted env vars
- provider secret injection
- outbound proxy
- host-side controlled commands/tools

## What We Should Adopt From Junior

Junior is most useful as Slack-specific prior art. Deputies should adopt its product-contract clarity selectively while preserving Deputies' durable worker, callback-dispatcher, and emulator-backed testing choices.

### 1. Slack Routing Contracts

Junior has a detailed Slack routing model in `packages/junior/src/chat/runtime/slack-runtime.ts`, `packages/junior/src/chat/app/production.ts`, and `.agents/skills/slack-development/references/slack-thread-routing.md`.

Current Deputies support covers `app_mention` and mapped thread `message` follow-ups. Direct messages, passive classification, edited-message mention handling, and richer Slack Assistant App behavior remain future expansion.

Adopt these rules as Slack support expands:

- Route DMs and explicit mentions through always-reply handling when DMs are implemented.
- Use structured mention metadata before passive classification.
- Persist skipped passive replies with concrete no-reply reasons.
- Treat `message_changed` events that introduce a bot mention as authenticated follow-ups when the Slack adapter would otherwise ignore them.

Avoid:

- Display-name parsing for mentions when Slack provides structured metadata.
- Letting passive reply policy suppress DMs or explicit mentions.

### 2. Single Slack Outbound Boundary

Junior centralizes Slack writes in `packages/junior/src/chat/slack/outbound.ts`, formats/chunks replies in `packages/junior/src/chat/slack/output.ts`, and plans final delivery in `packages/junior/src/chat/slack/reply.ts`. The behavior is captured in `specs/slack-outbound-contract-spec.md`.

Deputies already routes final Slack replies through callback deliveries and `SlackCompletionCallbackSender`. Session-link, archive, and recovery notices still use Slack service helpers. The next refinement is to consolidate Slack Web API writes behind a single outbound module without weakening callback ownership.

Adopt:

- One module for Slack Web API writes.
- One formatter for Slack markdown, chunking, code fences, and continuation markers. Current chunking is character-based and should be hardened before long code-heavy replies are common.
- Top-level `text` fallbacks for block messages.
- Idempotent handling for already-done operations such as `already_reacted` and `no_reaction`.

Avoid:

- Scattered direct `chat.postMessage` calls.
- Model-authored continuation markers.
- Treating run completion as proof of external Slack delivery. In Deputies, callback delivery success/failure/retry is tracked separately from run status.

### 3. Assistant Thread Status As Best-Effort Progress

Junior's assistant thread lifecycle and status handling live in `packages/junior/src/chat/slack/assistant-thread/lifecycle.ts` and `packages/junior/src/chat/slack/assistant-thread/status.ts`, with a contract in `specs/slack-agent-delivery-spec.md`.

Deputies currently uses reactions as the primary lightweight Slack progress signal, with optional Assistant thread status. Preserve Junior's best-effort status semantics:

- Status updates are in-flight progress, not the durable result.
- Status writes are best effort, debounced, and non-blocking.
- Final replies remain the primary visible output.
- Status updates use the live event `channel_id` and `thread_ts`, with adapter-scoped IDs normalized before Slack API calls.

Avoid:

- Blocking model/tool execution on status writes.
- Passing adapter IDs such as `slack:C123` into raw Slack assistant APIs.

### 4. OAuth Pause And Resume Semantics

Junior's OAuth flow specs and resume runtime are in `specs/oauth-flows-spec.md`, `packages/junior/src/handlers/oauth-callback.ts`, and `packages/junior/src/chat/runtime/slack-resume.ts`.

Deputies has product auth sessions and GitHub App login/runtime credentials, but not a Junior-style pending OAuth turn checkpoint/resume model. Use this only when user-granted provider credentials can interrupt an agent turn:

- Store pending OAuth state with requester, provider, channel/thread, pending message, config, and resume IDs.
- Deliver authorization links privately.
- Keep tokens and authorization URLs out of model-visible context.
- Resume only the latest still-relevant pending request for a thread.
- Use thread locks around resume to avoid duplicate work.

Avoid:

- Public authorization URLs in shared Slack threads.
- Auto-resuming stale OAuth completions after newer thread activity.
- Treating token exchange success as turn success before the resumed Slack reply is delivered.

### 5. Tool Wrapping And Checkpointed Turns

Junior separates tool definitions from execution wrapping in `packages/junior/src/chat/tools/index.ts` and `packages/junior/src/chat/tools/agent-tools.ts`, routes sandbox operations through `packages/junior/src/chat/sandbox/sandbox.ts`, and persists resumable turn checkpoints in `packages/junior/src/chat/services/turn-checkpoint.ts`.

Adopt:

- A central tool execution wrapper for tracing, validation, result normalization, error handling, and auth-pause behavior.
- A sandbox executor facade between agent tools and provider-specific APIs.
- Persistable turn checkpoints or resume slices for long-running work.

Avoid:

- Letting one orchestration file own runner, sandbox, persistence, callbacks, integrations, and delivery.

### 6. Declarative Plugin And Capability Manifests

Junior describes plugins with `plugin.yaml` manifests in `PLUGIN.md`, validates them in `packages/junior/src/chat/plugins/manifest.ts`, registers them in `packages/junior/src/chat/plugins/registry.ts`, and separates capability catalogs from credential brokers.

Deputies has code-level callback sender plugins, but no manifest loader or runtime plugin registry. Use these patterns only if integration packages become separately installable or operator-configurable:

- Declarative manifests for integrations, runtime dependencies, MCP config, credential domains, OAuth scopes, and command environment placeholders.
- Uniqueness checks for plugin names, capability names, config keys, and credential domains.
- Explicit allowlists for loadable plugin packages.
- Persist enabled integrations in Postgres while using manifests as definitions.

Avoid:

- Auto-loading arbitrary installed packages in production.
- Making markdown skill prose responsible for installing packages, configuring credentials, or bootstrapping MCP servers.

### 7. Skill Specs And Prompt Modules

Junior uses markdown skill files with frontmatter in `packages/junior/src/chat/skills.ts` and prompt composition in `packages/junior/src/chat/prompt.ts`. Example package skills include `packages/junior-sentry/skills/sentry/SPEC.md` and `packages/junior-sentry/skills/sentry/SKILL.md`.

Flue owns the skill/runtime capability surface. Deputies should adopt Junior's skill documentation pattern only for serious Flue skills or roles that become product-supported:

- `SPEC.md` for skill intent, scope, runtime contract, evaluation, and maintenance.
- `SKILL.md` for activation, workflow, guardrails, and reference links.
- Explicit available-vs-loaded capability distinction to reduce prompt bloat.
- Strict validation for user-visible prompt modules.

Avoid:

- Broad activation triggers that fire for adjacent but wrong work.
- Markdown skills as the only extension mechanism where typed APIs, permissions, migrations, or UI are required.

### 8. Slack HTTP Contract Tests

Junior's Slack testing model is described in `specs/testing/slack-mocking-spec.md`, implemented with MSW handlers in `packages/junior/tests/msw/handlers/slack-api.ts`, and supported by shared harnesses such as `packages/junior/tests/fixtures/slack-harness.ts`.

Deputies has chosen an emulator-first path for external service behavior: use `vercel-labs/emulate` for stateful Slack/GitHub API behavior where possible, plus deterministic unit/API tests for signature, routing, callback, and prompt behavior. Use Junior's MSW approach as a reference for strict request-shape assertions, not as the default harness.

Adopt:

- Emulator-backed Slack integration tests with strict external request handling where the emulator supports the behavior.
- Shared Slack inbound/outbound fixture factories.
- Fake only the agent boundary in Slack integration tests.
- Capture Slack API calls for request-shape assertions.

Avoid:

- Broad SDK mocks in integration tests.
- Per-test ad hoc Slack HTTP stubs.

### 9. Rubric-Based Evals

Junior separates deterministic tests from model-dependent evals in `specs/testing/index.md` and `specs/testing/evals-spec.md`. Its eval package uses helpers in `packages/junior-evals/evals/helpers.ts` and scenario files such as `packages/junior-evals/evals/core/routing-and-continuity.eval.ts`.

Deputies' current test strategy prioritizes deterministic unit/API/integration/UAT/emulator coverage. Use Junior's eval shape later for model-dependent behavior:

- Evals for agent/model behavior, integration tests for product wiring, and unit tests for local deterministic invariants.
- Structured rubrics with contract, pass, allow, and fail criteria.
- Eval outputs that include visible assistant posts, files, channel posts, reactions, and selected tool observations.
- CI gates that run evals only when relevant files changed, a label requests them, and required secrets are present.

Avoid:

- Unit tests that assert prompt substrings, logger calls, or multi-module runtime behavior.
- Evals that prescribe exact internal commands unless that command surface is what is being evaluated.

### 10. Agent-Readable Telemetry Docs

Junior's `TELEMETRY.md`, `TELEMETRY.spec.md`, and `specs/logging/tracing-spec.md` provide a useful symptom-first production triage map.

This remains a real documentation gap. Adopt:

- A root `TELEMETRY.md` for Deputies with copyable queries and stable pivots.
- Correlation IDs for trace/span, session, run, external thread, tool, sandbox, and provider.
- Incident-surface groupings instead of exhaustive event inventories.

Avoid:

- Telemetry docs that become migration backlogs or full schema dumps.

## What We Should Avoid From Junior

### 1. Serverless Request Runtime As The Product Architecture

Junior's Hono/Nitro/Vercel-oriented shape is useful for Slack bots, but Deputies needs durable background-work semantics across API and worker processes.

Avoid making request lifetime the primary unit of work.

Use:

- Postgres messages, runs, leases, and events.
- Worker-owned execution.
- Signed internal callbacks only as optional resume signals, not as the source of durable truth.

### 2. Redis Or Memory As Primary Product State

Junior's adapter model supports memory and Redis state. Deputies should not move durable session/run state out of Postgres.

Use Redis only if it becomes useful for ephemeral locks, rate limits, or caches.

### 3. Runtime Package Discovery As Production Truth

Junior's package discovery and allowlist are strong safeguards for a package-based bot framework. Deputies should use manifests for definitions but persist installed/enabled integration state in Postgres.

### 4. A Large Monolithic Turn Orchestrator

Junior's `respond.ts` style is practical for a compact Slack bot. Deputies should preserve separate boundaries for integrations, queueing, runner adapters, sandbox lifecycle, callback delivery, artifacts, and event persistence.

## What We Should Adopt From Mistle

Mistle is the closest open source system-level reference for a hosted background coding-agent platform. Its `docs/architecture.md` splits the product into dashboard/control-plane API/control-plane worker services, data-plane API/data-plane worker/data-plane gateway services, and sandbox runtimes. Use it as implementation inspiration for sandbox profiles, runtime plans, credential brokering, and lifecycle workflows, not as a reason to replace Deputies' Flue runner boundary.

The repository appears early but substantial. Its `README.md` describes Mistle as an open source platform for background coding agents in sandboxes with brokered credentials, reusable snapshots, sessions, and triggers, while also warning that the project and CLI are early. `VERSION` currently reports `0.31.0`, and `docs/roadmap.md` lists self-hosted deployment, triggers, CLI, and sandbox provider expansion as ongoing work.

### 1. Runtime Plan As The Cross-Boundary Contract

Mistle compiles sandbox profile versions into a strict runtime plan before starting a sandbox. The control-plane start path in `apps/control-plane-api/src/sandbox-profiles/services/start-profile-instance.ts` resolves the launch image, compiles the profile version, resolves repository/git identity context, and passes the effective `runtimePlan` to the data plane. The core compiler and schema live in `packages/integrations-core/src/compiler/index.ts`, `packages/integrations-core/src/runtime-plan/schema.ts`, and `packages/integrations-core/src/validation/index.ts`.

Adopt:

- Treat Deputies' sandbox/run launch plan as the immutable contract between API, worker, provider adapter, runner adapter, and optional bridge.
- Validate conflicts before sandbox start for workspace paths, setup files, artifacts, runtime clients, egress routes, and credentials.
- Persist a plan id, hash, or compact summary on sandbox/run records so lifecycle events and diagnostics can be correlated back to the launch input.
- Put setup artifacts, workspace sources, skills, runtime files, and egress policy into typed plan fields rather than prompt prose.

### 2. Credentialless Sandbox And Managed Egress Policy

Mistle's `docs/architecture.md` says sandboxes are credentialless by default. Managed HTTP requests go through the data-plane gateway, which loads the active runtime plan, matches egress routes, resolves credentials through control-plane internal APIs, and injects auth at request time. The concrete gateway implementation uses `/_mistle/egress/http`, `/_mistle/egress/ws`, and `x-mistle-egress-token` in `apps/data-plane-gateway/src/egress/direct-egress-proxy-service.ts`, short-lived five-minute egress tokens in `apps/data-plane-gateway/src/egress/sandbox-egress-token-service.ts`, and route-specific auth injection in `apps/data-plane-gateway/src/egress/managed-egress-request.ts`.

Adopt selectively:

- Keep raw long-lived credentials out of prompts, events, artifacts, command text, and sandbox environment by default.
- Prefer route-scoped credential resolvers or host-side controlled tools when agents need broad external API access.
- Use short-lived scoped tokens for any sandbox-to-control-plane or sandbox-to-gateway authority.
- Log route ids, resolver kinds, and failure codes, but never log resolved credential values.

### 3. Durable Sandbox Startup Workflow

Mistle's data-plane API creates an idempotent workflow run and pending `sbi` sandbox instance record in `apps/data-plane-api/src/internal/sandbox-instances/services/start-sandbox-instance.ts`. The data-plane worker then resolves provider runtime credentials, prepares the image, marks status transitions, starts the provider sandbox, persists provisioning metadata, activates the runtime, waits for tunnel/bootstrap readiness, and records failures/cleanup in `apps/data-plane-worker/openworkflow/start-sandbox-instance/workflow.ts`.

Adopt:

- Use idempotency keys for sandbox start requests and trigger-driven starts.
- Persist sandbox records before provider creation and keep explicit status transitions for pending, starting, initializing, running, failed, and stopped states.
- Emit user-visible lifecycle events for image preparation, provider start, runtime activation, tunnel attachment, readiness, and failure cleanup.
- Treat startup diagnostics as product behavior, not only logs.

### 4. Optional Sandbox Daemon For Providers That Need It

Mistle's in-sandbox `sandboxd` accepts strict activation input in `packages/sandboxd/src/protocol/activation.rs`: operation kind, bootstrap token, tunnel-exchange token, gateway WebSocket URL, runtime plan, acting user, git identity, and transparent proxy configuration. It applies runtime-plan artifacts, workspace sources, skills, and runtime files in `packages/sandboxd/src/runtime/mod.rs`, then coordinates tunnel connectivity, egress proxying, runtime adapters, readiness projection, and cleanup through its lifecycle modules.

Adopt only where provider APIs are insufficient:

- Use a daemon or bridge for Docker, ECS, Kubernetes, and other providers with weak native exec/filesystem/stream APIs.
- Keep the daemon activation protocol strict, versioned, and limited to bootstrap authority plus the launch plan.
- Let providers with strong native APIs remain direct-provider implementations.
- Do not make a bridge mandatory for every sandbox provider.

### 5. Runtime-Specific Adapter And Proxy Layer

Mistle registers Codex, OpenCode, and Pi as first-class agent runtimes in `packages/integrations-definitions/src/registry/agent-runtimes.ts` and `packages/integrations-definitions/src/registry/agent-runtimes.server.ts`. `packages/sandboxd/src/runtime/adapters.rs` maps compiled runtime entries to concrete Codex/OpenCode/Pi proxy adapters because each runtime exposes different readiness, stream, and keepalive behavior.

Adopt:

- Keep Flue behind `runner-flue` as the primary runtime boundary, but preserve a clean adapter seam for any future direct CLI/runtime support.
- Normalize runtime readiness, stream URLs, terminal access, and lifecycle signals at the product boundary instead of assuming every agent runtime behaves the same.
- Put runtime-specific quirks in adapters, not in session orchestration, integration callbacks, or UI components.

### 6. Trigger Delivery As Durable Conversation Routing

Mistle handles trigger runs through durable control-plane workflows. `apps/control-plane-worker/openworkflow/handle-trigger-run/workflow.ts` transitions trigger runs to running, prepares the trigger, queues a delivery task, and schedules conversation delivery idempotently. `apps/control-plane-worker/openworkflow/handle-trigger-conversation-delivery/workflow.ts` ensures or recovers a sandbox-backed delivery route, creates or resumes provider conversations, submits payloads, and persists provider delivery results. `apps/control-plane-worker/openworkflow/handle-trigger-conversation-delivery/execute-conversation-provider-delivery.ts` sends `mistle/setDeliveryContext` with active W3C trace context before provider delivery.

Adopt:

- Model external triggers as durable delivery tasks that can recover, resume, and dedupe independently from inbound webhook receipt.
- Keep route creation/recovery separate from provider conversation creation and payload submission.
- Carry correlation and trace context into runtime-facing delivery context when practical.
- Persist provider conversation/execution ids as product state, not only as agent-visible text.

### 7. Reconnectable Runtime Surfaces

Mistle's dashboard terminal code in `apps/dashboard/src/features/pages/session-terminal-workspace.tsx` treats PTY panels as reconnectable runtime surfaces with stable panel/session ids, reset observation, auto-reopen, and lifecycle-derived recovery state.

Adopt:

- Make terminal and dev-server UI panes recover from transport resets through stable pane/session identifiers.
- Drive recovery from sandbox lifecycle and stream state, not from a single WebSocket's current status.
- Keep UI transport recovery separate from durable run/session state.

## What We Should Avoid From Mistle

### 1. Full Service Split As The Starting Architecture

Mistle's dashboard, control-plane API, control-plane worker, data-plane API, data-plane worker, and gateway split is a strong reference for boundaries, but Deputies should not require that deployment shape on day one.

Avoid:

- Splitting services before the single modular Node service and Postgres model are operationally insufficient.
- Creating a separate gateway just to mirror Mistle if host-side tools or provider APIs solve the immediate credential/runtime problem.
- Letting data-plane abstractions obscure the simpler provider interface Deputies already uses.

Preserve the boundary names in code and docs so API/worker/data-plane extraction remains possible later.

### 2. Treating Credentialless Sandboxes As Absolute Security

Mistle's architecture doc explicitly notes that operators can still put secrets directly into sandbox environments. Deputies should treat credential brokering as one layer, not a complete guarantee.

Avoid:

- Claiming sandboxes are credentialless unless tests and runtime policy prevent secret env vars, dotenv files, prompts, logs, and artifacts from carrying credentials.
- Moving all credential safety into an egress proxy without redaction, audit, replay, cache-expiry, and route-matching tests.
- Letting an agent bypass managed egress with unreviewed injected credentials.

### 3. Gateway And Tunnel Complexity Without Matching Tests

Mistle's gateway handles tunnel admission, bootstrap ownership, stream routing, managed egress, direct egress, WebSocket health, token exchange, and runtime state. This is powerful but security-sensitive.

Avoid until needed:

- A large custom gateway/tunnel subsystem without dedicated tests for token replay, route ambiguity, route authorization, credential cache expiry, WebSocket lifecycle, and failure cleanup.
- Making long-lived bidirectional tunnels the only way a sandbox can run when provider APIs are enough.

### 4. Provider And Runtime Breadth Before Depth

Mistle's sandbox package has adapter factories for Docker, E2B, Freestyle, and Tensorlake in `packages/sandbox/src/factory.ts` and provider enum values in `packages/sandbox/src/types.ts`. Provider breadth is useful, but Deputies should not present providers as equal until conformance and lifecycle behavior are tested.

Avoid:

- Adding provider names without capability flags, health checks, startup/reuse policy, and conformance coverage.
- Pinning direct upstream CLI/runtime versions as operationally critical dependencies without upgrade and protocol regression tests.
- Treating snapshots as correctness requirements rather than startup optimizations.

### 5. Replacing Flue With A Bespoke Runtime Platform

Mistle's runtime plan, sandbox daemon, and runtime proxies are instructive, but Deputies' core design is Flue behind a runner adapter.

Avoid:

- Reimplementing Flue conversation mechanics, tools, skills, task delegation, live events, and sandbox connector shape in product code.
- Building runtime-client and agent-runtime registries unless multiple non-Flue runtimes become a real product requirement.
- Making Mistle's runtime architecture the product state model.

## Additional Pattern To Adopt From All Four

### Normalize Early, Specialize Late

All four systems work best where external inputs are normalized before hitting the agent.

Adopt:

```txt
raw webhook -> verified source event -> source-specific normalized input -> message -> prompt context -> runner
```

This keeps integrations simple and makes tests easier.

### Design For Resumption

All four systems assume agent work may outlive the request that started it.

Adopt:

- every state transition is persisted.
- every run has a lease.
- every sandbox has a persisted provider ID.
- every event is replayable.
- every external thread maps to a session.
- every external callback delivery is tracked independently from run completion.

### Make Sandbox State Observable

All four systems benefit from visible sandbox lifecycle state, even when the exact delivery mechanism differs.

Adopt event types for:

- sandbox create/connect/health.
- repo sync.
- setup/start hook.
- runner start.
- snapshot/restore if supported.
- sandbox failure.

## Net Recommendation

Open-Inspect remains a useful reference model for product/control-plane architecture. Deputies has implemented patterns similar to its durable session, event, artifact, callback-context, and lifecycle ideas through Postgres-backed sessions, leases, replayable events, artifacts, callbacks, and sandbox records.

Open SWE remains a useful reference model for invocation normalization, deterministic thread IDs, follow-up queue behavior, GitHub App token handling, and source-specific prompt construction. Deputies has implemented similar core patterns; remaining work is permission refinement, label triggers, richer PR/update helpers, and token/redaction regression coverage.

Junior remains a useful reference model for Slack-specific product contracts: explicit routing policy, one outbound boundary, assistant-thread status semantics, OAuth pause/resume, strict Slack HTTP tests, rubric evals, plugin manifests, and agent-readable telemetry docs. Deputies should adopt these selectively around its durable callback dispatcher and emulator-backed test strategy.

Mistle is the strongest open source reference for a full hosted-agent platform: compiled runtime plans, credential brokering through managed egress, optional sandbox daemons, provider adapters, durable data-plane startup workflows, trigger delivery routes, and reconnectable runtime surfaces. Deputies should adopt these as boundary and lifecycle patterns while staying smaller, portable, and Flue-centered.

Use Flue as the agent runtime boundary, not as the entire product state model. Flue should own conversation mechanics, tools, skills, roles, tasks/subagents, live runtime events, and sandbox connector shape. The product should own durable background-work semantics, integrations, replayable product events, artifacts, queueing, leases, and operational state.

The resulting design is:

```txt
Open-Inspect-style durable sessions/events/artifacts
+ Open SWE-style source normalization/follow-up/token handling
+ Junior-style Slack contracts/plugin manifest/eval/telemetry ideas
+ Mistle-style runtime plans/credential brokering/lifecycle workflows
+ Flue runner adapter
+ portable Postgres/Node deployment model
+ provider-neutral sandbox interface
```

That combination preserves the best ideas from the reference systems while avoiding their deployment-specific constraints.
