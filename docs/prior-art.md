# Prior Art: Open-Inspect, Open SWE, And Junior

This document compares the portable Flue background-agent design with three reference systems:

- `background-agents-upstream`, also referred to as Open-Inspect in its docs.
- `open-swe-upstream`, the LangGraph/Deep Agents implementation.
- `junior-upstream`, an open source Slack bot agent project with plugin, skill, sandbox, eval, and telemetry patterns.

The goal is not to copy any system directly. The goal is to identify durable patterns that fit a portable, provider-neutral Flue implementation.

See [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) before copying implementation code, schemas, tests, fixtures, config, prompts, or substantial documentation from any referenced project.

## Summary Comparison

| Area                | This Design                                          | Open-Inspect / background-agents                    | Open SWE                                          | Junior                                           |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Harness             | Flue behind runner adapter                           | OpenCode in sandbox runtime                         | Deep Agents / LangGraph                           | Pi agent core behind Slack runtime               |
| Control plane       | Portable Node service + Postgres                     | Cloudflare Workers + Durable Objects + D1/KV        | LangGraph server/webapp + thread metadata/store   | Hono/Nitro request runtime + Redis/memory state  |
| Deployment target   | Railway, ECS, Kubernetes, local                      | Cloudflare + Modal/Daytona                          | LangSmith/LangGraph oriented, pluggable sandboxes | Vercel/serverless-oriented app shell             |
| Session state       | Postgres tables                                      | Durable Object SQLite per session + D1 shared state | LangGraph thread state and metadata               | Conversation state adapter + turn checkpoints    |
| Queueing            | Postgres messages + leases                           | DO-local message queue                              | LangGraph store queue for busy threads            | Thread locks, timeout resume, pending auth state |
| Events              | Append-only Postgres event log + SSE                 | DO event table + WebSocket fanout                   | Agent/tool stream plus source replies             | Slack-visible replies/status + structured evals  |
| Sandbox abstraction | Provider interface + capabilities                    | Provider lifecycle manager for Modal/Daytona        | Sandbox backend protocol selected by env          | Sandbox executor + dependency snapshot profiles  |
| Runtime bridge      | Optional, provider-dependent                         | Required sandbox bridge/supervisor                  | Provider-specific backend wrappers                | Tool wrapper + sandbox executor facade           |
| Integrations        | Thin adapters with source-specific normalized inputs | Slack/GitHub/Linear bots call control plane         | Webhooks normalize into LangGraph thread IDs      | Rich Slack routing, outbound, OAuth contracts    |
| Testing             | Agent-first layered tests + emulate                  | Strong production code, infra-specific tests/docs   | Python tests around utility/webhook behavior      | MSW Slack tests + rubric evals                   |

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

## Additional Pattern To Adopt From All Three

### Normalize Early, Specialize Late

All three systems work best where external inputs are normalized before hitting the agent.

Adopt:

```txt
raw webhook -> verified source event -> source-specific normalized input -> message -> prompt context -> runner
```

This keeps integrations simple and makes tests easier.

### Design For Resumption

All three systems assume agent work may outlive the request that started it.

Adopt:

- every state transition is persisted.
- every run has a lease.
- every sandbox has a persisted provider ID.
- every event is replayable.
- every external thread maps to a session.
- every external callback delivery is tracked independently from run completion.

### Make Sandbox State Observable

All three systems benefit from visible sandbox lifecycle state, even when the exact delivery mechanism differs.

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

Use Flue as the agent runtime boundary, not as the entire product state model. Flue should own conversation mechanics, tools, skills, roles, tasks/subagents, live runtime events, and sandbox connector shape. The product should own durable background-work semantics, integrations, replayable product events, artifacts, queueing, leases, and operational state.

The resulting design is:

```txt
Open-Inspect-style durable sessions/events/artifacts
+ Open SWE-style source normalization/follow-up/token handling
+ Junior-style Slack contracts/plugin manifest/eval/telemetry ideas
+ Flue runner adapter
+ portable Postgres/Node deployment model
+ provider-neutral sandbox interface
```

That combination preserves the best ideas from the reference systems while avoiding their deployment-specific constraints.
