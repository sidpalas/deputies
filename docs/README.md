# Deputies Documentation

This directory defines the implementation plan for a portable background-agent system built on Pi for real agent work. The Flue runner remains documented as a deprecated legacy path while it is being removed.

The goal is a deployable background coding-agent service that can start as a single modular Node service, then split into separate API and worker services without changing the core architecture. The design must not depend on one cloud provider's primitives. Railway, ECS Fargate + RDS, and Kubernetes should all be viable deployment targets.

## Documents

- [Architecture](./architecture.md): system shape, deployable units, module boundaries, and dependency rules.
- [Domain Design](./domain-design.md): lightweight domain-driven design boundaries, aggregates, and anti-corruption layers.
- [Data Model](./data-model.md): Postgres-backed sessions, messages, automations, events, runs, sandboxes, integrations, and artifacts.
- [Sandbox Providers](./sandbox-providers.md): provider contract, lifecycle APIs, capabilities, and conformance expectations.
- [Flue Persistence](./flue-persistence.md): deprecated Flue runner session store notes kept for legacy deployments and removal work.
- [Integrations](./integrations.md): generic webhook, GitHub, Slack, Linear, callbacks, auth, and external thread mapping.
- [Web UI](./web-ui.md): separate Vite React operator UI, browser auth, and static deployment notes.
- [Deputies App Preview](./deputies-app-preview.md): agent runbook for running the Deputies app from a branch inside a sandbox behind the outer service preview.
- [Repository Setup Scripts](./repository-setup-scripts.md): `.agents/setup` convention for repo-owned sandbox preparation before agent work begins.
- [Access Groups](./access-groups.md): RBAC roles, session access policies, group management, and GitHub auth allowlists.
- [Local Development](./contributing-local-development.md): contributor setup, Postgres, Portless, Docker Compose, Pi runner setup, and local integrations.
- [Development Tasks](./development-tasks.md): where to put `package.json` scripts versus `mise` tasks in this monorepo.
- [Deployment](./deployment.md): provider-agnostic deployment topology, env vars, integrations, sandbox providers, and operations checklist.
- [Testing Strategy](./testing-strategy.md): unit, integration, e2e, UAT, adversarial, prompt/context, and emulator-backed tests.
- [Prior Art](./prior-art.md): comparison with Open-Inspect/background-agents, Open SWE, Junior, and Mistle, plus non-open-source hosted-agent references.
- [Roadmap](./roadmap.md): phased implementation sequence and acceptance criteria.
- [Product Documentation](./product/): PRDs, technical specs, research notes, and durable product decisions.
- [Third Party Notices](../THIRD_PARTY_NOTICES.md): license and attribution checkpoint for referenced prior-art projects.

## Repository Layout

- `apps/`: independently runnable and deployable applications/services.
- `apps/control-plane/`: Node/Hono control-plane API, worker runtime, integrations, stores, and sandbox providers.
- `apps/web/`: Vite React operator UI.
- `packages/`: reusable libraries shared by apps, including the Docker sandbox bridge and the browser-milestones telemetry package.
- `deploy/`: deployment and local runtime configuration.
- `docs/`: architecture and product documentation.

## Core Principles

1. Pi is the preferred real agent runner; Flue is deprecated and isolated for removal.
2. The control plane uses portable primitives: Node, Postgres, HTTP, SSE/WebSockets, and S3-compatible object storage.
3. One deployable service comes first. Module boundaries must still allow later API/worker split.
4. Durable state lives in Postgres, not memory or cloud-specific actors.
5. Integrations are thin ingress/egress adapters. They never run agents directly.
6. Sandboxes are provider-backed through a stable interface.
7. Events are replayable, with compactable streaming deltas treated as storage optimization rather than durable audit history.
8. Tests define product behavior. Do not weaken tests to match accidental current behavior.
9. Agent context is production code. Prompt templates, skills, subagents, and constraints need tests.
10. Trust is layered: permissions, conventions, lifecycle gates, tests, and review pipelines.

## Design Synthesis

The implementation should combine the strongest portable ideas from the reference systems:

```txt
Open-Inspect-style durable sessions/events/artifacts
+ Open SWE-style source normalization/follow-up/token patterns
+ Mistle-style runtime plans/credential brokering/lifecycle workflows
+ Pi runner adapter
+ portable Node/Postgres deployment model
+ provider-neutral sandbox interface
```

This means product state lives in our Postgres-backed control plane, Pi runner behavior is isolated behind `runner-pi`, deprecated Flue behavior is isolated behind `runner-flue` until removal, external systems normalize into source-specific message context, sandbox/run launch plans stay explicit, and sandbox providers plug in through a stable interface; a shared provider conformance test suite is planned. Cloud/provider-specific capabilities such as snapshots, stop/start, WebSocket bridges, gateway-mediated egress, or object storage are optional optimizations rather than correctness requirements.

## Runner Direction

New real-agent work and deployments should use Pi. `RUNNER=fake` remains the safe boot/smoke-test default where model credentials are intentionally absent. `RUNNER=flue` is deprecated, should not be used for new deployments, and remains only to support existing legacy sessions during the removal window.

## Legacy Flue Built-Ins

This section is retained for the deprecated Flue runner. New runner work should target Pi unless it is explicitly part of Flue removal or legacy support.

- Agent/runtime identity through stable agent IDs.
- Flue sessions through `agent.session(id?)` and `agent.sessions`.
- Custom session persistence through `createFlueContext({ defaultStore })`.
- Built-in tools for file reads/writes/edits, search, shell, and task delegation.
- `session.task()` and the built-in `task` tool for subagents inside a run.
- Subagents and skills for scoped behavior and reusable agent instructions.
- Live Flue events and SSE as the source stream for runner progress.
- Sandbox integration through Flue `SandboxFactory` / `SessionEnv` connectors.
- Commands and MCP tools for controlled external capabilities.

The product control plane still owns the things Flue does not provide on portable Node deployments: durable work queues, run leases, retry/recovery, external integrations, callback delivery, product event replay, artifacts, sandbox lifecycle records, credential policy, and UI/API state.

For Node deployments, Flue can generate a standalone server with `/agents/:name/:id`, live SSE, and custom session persistence. Our portable service should embed or delegate to those capabilities, not recreate the harness. The product endpoints still exist because they add durable background-work semantics that Flue's generated Node server does not provide by itself.

## Current Implementation Status

The current scaffold has implemented the portable control-plane foundation:

- TypeScript Node service with `RUN_MODE=combined|api|worker`.
- Core session/message/event HTTP loop.
- Docker Compose Postgres and SeaweedFS object storage for local development.
- Raw SQL migration runner.
- Postgres-backed `AppStore` for `sessions`, `messages`, `events`, `runs`, leases, webhook sources, external threads, and delivery dedupe.
- Durable worker loop with fake runner execution, run leases, heartbeat renewal, and stale lease recovery.
- Generic inbound webhook integration with DB-backed source config and prompt prefixes.
- SSE event streaming with cursor replay.
- Unit, Postgres integration, architecture fitness, and built-artifact UAT tests.
- Daytona SDK dependency, provider lifecycle adapter, and Flue `SandboxFactory` bridge.
- Pi runner wiring behind `RUNNER=pi` using provider-backed sandbox handles.
- Deprecated Flue agent factory wiring remains behind `RUNNER=flue` for legacy support only.
- Sandbox lifecycle persistence with reconnect/reuse semantics for follow-up messages.
- Daytona sandbox auto-stop configuration and stopped-sandbox restart/reuse.
- Flue live event normalization for text deltas, tools, commands, and tasks.
- Artifact persistence, optional filesystem/S3-compatible blob storage, session artifact list/download/preview APIs, and generic HTTP completion callbacks.
- Separate Vite React operator UI scaffold.
- Scheduled automations with UTC cron schedules, durable invocation records, manual invocation, and minimal operator UI.
- Opt-in legacy real local Flue and real Daytona/Flue UAT paths with credentials.
- Slack and GitHub webhook integrations with external thread reuse, callback delivery, and archived-session recovery.
- GitHub App repository access with guarded `repository`, `gh`, and authenticated `git` tools.
- Repo-owned `.agents/setup` scripts for preparing sandbox workspaces before agent prompts.
- Pi and legacy Flue artifact tools for publishing sandbox files as downloadable/previewable product artifacts.

The following MVP pieces are still planned:

- contract schemas for public API responses and normalized events.
- release/migration runbooks.

## MVP Target

The first complete version should support:

- Single service process with `RUN_MODE=combined`.
- Postgres-backed sessions, messages, events, runs, and leases.
- Generic inbound webhook integration.
- Fake runner and fake sandbox for deterministic tests.
- Pi runner behind an adapter interface.
- One real sandbox provider.
- SSE event streaming with cursor replay.
- UAT suite against the built app artifact.

Slack and GitHub are implemented for the current MVP path. Linear remains a future integration after the core product loop and operational hardening are production-ready.
