# Flue Background Agents Implementation Plan

This directory defines the implementation plan for a portable background-agent system built on top of [Flue](https://github.com/withastro/flue).

The goal is a deployable background coding-agent service that can start as a single modular Node service, then split into separate API and worker services without changing the core architecture. The design must not depend on one cloud provider's primitives. Railway, ECS Fargate + RDS, and Kubernetes should all be viable deployment targets.

## Documents

- [Architecture](./architecture.md): system shape, deployable units, module boundaries, and dependency rules.
- [Domain Design](./domain-design.md): lightweight domain-driven design boundaries, aggregates, and anti-corruption layers.
- [Data Model](./data-model.md): Postgres-backed sessions, messages, events, runs, sandboxes, integrations, and artifacts.
- [Sandbox Providers](./sandbox-providers.md): provider contract, lifecycle APIs, capabilities, and conformance expectations.
- [Flue Persistence](./flue-persistence.md): Postgres-backed Flue session store and how it relates to product session state.
- [Integrations](./integrations.md): generic webhook, GitHub, Slack, Linear, callbacks, auth, and external thread mapping.
- [Testing Strategy](./testing-strategy.md): unit, integration, e2e, UAT, adversarial, prompt/context, and emulator-backed tests.
- [Prior Art](./prior-art.md): comparison with Open-Inspect/background-agents and Open SWE, including what to adopt or avoid.
- [Roadmap](./roadmap.md): phased implementation sequence and acceptance criteria.

## Core Principles

1. Flue is the agent runtime, not the whole product.
2. The control plane uses portable primitives: Node, Postgres, HTTP, SSE/WebSockets, and S3-compatible object storage.
3. One deployable service comes first. Module boundaries must still allow later API/worker split.
4. Durable state lives in Postgres, not memory or cloud-specific actors.
5. Integrations are thin ingress/egress adapters. They never run agents directly.
6. Sandboxes are provider-backed through a stable interface.
7. Events are append-only and replayable. Streaming is delivery, not storage.
8. Tests define product behavior. Do not weaken tests to match accidental current behavior.
9. Agent context is production code. Prompt templates, skills, roles, and constraints need tests.
10. Trust is layered: permissions, conventions, lifecycle gates, tests, and review pipelines.

## Design Synthesis

The implementation should combine the strongest portable ideas from the reference systems:

```txt
Open-Inspect-style durable sessions/events/artifacts
+ Open SWE-style source normalization/follow-up/token patterns
+ Flue runner adapter
+ portable Node/Postgres deployment model
+ provider-neutral sandbox interface
```

This means product state lives in our Postgres-backed control plane, Flue is isolated behind `runner-flue`, external systems normalize into a common message envelope, and sandbox providers plug in through a conformance-tested interface. Cloud/provider-specific capabilities such as snapshots, stop/start, WebSocket bridges, or object storage are optional optimizations rather than correctness requirements.

## Flue Built-Ins We Rely On

Flue is more than a low-level model SDK. The product should use these Flue capabilities directly instead of rebuilding them:

- Agent/runtime identity through stable agent IDs.
- Flue sessions through `agent.session(id?)` and `agent.sessions`.
- Custom session persistence through `init({ persist })`.
- Built-in tools for file reads/writes/edits, search, shell, and task delegation.
- `session.task()` and the built-in `task` tool for subagents inside a run.
- Roles and skills for scoped behavior and reusable agent instructions.
- Live Flue events and SSE as the source stream for runner progress.
- Sandbox integration through Flue `SandboxFactory` / `SessionEnv` connectors.
- Commands and MCP tools for controlled external capabilities.

The product control plane still owns the things Flue does not provide on portable Node deployments: durable work queues, run leases, retry/recovery, external integrations, callback delivery, product event replay, artifacts, sandbox lifecycle records, credential policy, and UI/API state.

For Node deployments, Flue can generate a standalone server with `/agents/:name/:id`, live SSE, and custom session persistence. Our portable service should embed or delegate to those capabilities, not recreate the harness. The product endpoints still exist because they add durable background-work semantics that Flue's generated Node server does not provide by itself.

## Current Implementation Status

The current scaffold has implemented the portable control-plane foundation:

- TypeScript Node service with `RUN_MODE=all|api|worker`.
- Core session/message/event HTTP loop.
- Docker Compose Postgres for local development.
- Raw SQL migration runner.
- Postgres-backed `AppStore` for `sessions`, `messages`, `events`, `runs`, leases, webhook sources, external threads, and delivery dedupe.
- Durable worker loop with fake runner execution, run leases, heartbeat renewal, and stale lease recovery.
- Generic inbound webhook integration with DB-backed source config and prompt prefixes.
- SSE event streaming with cursor replay.
- Unit, Postgres integration, architecture fitness, and built-artifact UAT tests.
- Daytona SDK dependency, provider lifecycle adapter, and Flue `SandboxFactory` bridge.
- Real Flue agent factory wiring behind `RUNNER=flue` using provider-backed sandbox handles.
- Sandbox lifecycle persistence with reconnect/reuse semantics for follow-up messages.
- Flue live event normalization for text deltas, tools, commands, and tasks.
- Artifact persistence and generic HTTP completion callbacks.

The following MVP pieces are still planned:

- real Daytona/Flue UAT with credentials.

## MVP Target

The first complete version should support:

- Single service process with `RUN_MODE=all`.
- Postgres-backed sessions, messages, events, runs, and leases.
- Generic inbound webhook integration.
- Fake runner and fake sandbox for deterministic tests.
- Flue runner behind an adapter interface.
- One real sandbox provider.
- SSE event streaming with cursor replay.
- UAT suite against the built app artifact.

GitHub, Slack, and Linear should be added after the core session/message/worker loop is proven.
