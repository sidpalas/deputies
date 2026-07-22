# Feature Backlog

This is a living backlog for product, integration, runtime, and operations work. It is not a release commitment.

## Integrations

- GitHub collaborator permission gating in addition to the current repository, user, org, and trigger-phrase gates.
- GitHub label-based triggers for teams that want non-mention workflows.
- Expand the existing `gh pr create` external-resource recording to existing or updated GitHub PRs, including `gh pr edit`, `gh pr view/checkout`, and branch pushes that resolve to an open PR.
- Continue consolidating shared integration utilities, especially allowlist helpers, prompt section rendering, and callback target parsing before adding the next major integration.
- Source-agnostic start/queued/final-response lifecycle so integrations add lightweight start signals while callback senders own exactly one final external reply.
- Global runner/agent instruction injection for integration behavior that should not appear in chat-visible source prompts.
- Linear integration for issue mentions, assignments, and comment follow-ups.
- Generic webhook mapping/filter/template configuration beyond the current simple payload shape.

## Web UI

- Saved session views/grouping for common filters, sources, repositories, and teams.
- Saved codebase, branch, model, and reasoning defaults per user/group/integration source, building on the existing environment/repository picker and per-session controls.
- Audit and document preview-origin isolation after signed preview auth, including whether separate eTLD+1 deployment remains required for defense-in-depth against untrusted preview content.
- Surface sandbox cleanup events and failures more clearly.
- Expand callback delivery UI with filtering and clearer retry/failure history.
- Bulk cleanup and retention workflows for archived sessions.
- Broader Playwright smoke tests for desktop/mobile flows beyond the existing responsive context-panel coverage.

## Agent Runtime

- Harden the opt-in `deputies` control tool with richer audit views, policy diagnostics, and eventual MCP exposure if external agent runtimes need the same scoped session-control surface.
- Agent authentication to external services: instance-level remote MCP/Executor support is implemented through `MCP_SERVERS`; remaining work is per-user/per-access-group MCP configuration, CLI credential policy, API-token lifecycle, and short-lived provider tokens.
- Credential scoping and injection policy for tools, commands, per-user MCP servers, and sandbox environments.
- Sandbox credential broker for GitHub repository operations: keep GitHub App installation tokens outside the sandbox trust domain, route `git` smart-HTTP and `gh` operations through a control-plane or sandbox-bridge proxy, and enforce push/PR policy server-side with opaque per-session sandbox credentials. Treat this as the gate for safely preparing untrusted PR branches or forks; until then repository setup assumes trusted, allowlisted repositories.
- Named agent presets that bundle versioned agent instructions with model/reasoning defaults, managed skills, environment/runtime defaults, and scoped tool or MCP policy. Keep the preset separate from stored prompt templates: a preset defines how the agent works and may reference a default prompt, while the rendered prompt remains user-visible session input.
- Prompt templates and snapshot tests for Slack/GitHub/Linear inputs.
- Better repo resolution from Slack/GitHub/Linear context.
- Setup/install hook observability beyond `repository_ready`.
- OpenAI Codex OAuth refresh hardening for deployed workers: static base64 auth variables can become stale when refresh tokens rotate; durable refresh state likely needs a writable auth file/volume or refresh-token-specific secret flow; avoid naive whole-run retry on 401 because agent/tool side effects may duplicate.

## Meta Agents

- Human-facing controls to grant and revoke the existing Broad Notepad Discovery and Session Notepad Coordination capabilities for a Session, with clear descriptions of the grantor, access-group boundary, live authority checks, and read-versus-write effects.
- A meta-agent overview showing capability-enabled Sessions, their associated Explicit Notepads, recent coordination activity, and the human authority each capability currently exercises.
- An explicit workflow for a meta-agent to request or establish an association after discovering an Explicit Notepad, without turning broad read discovery into implicit write access.
- Access-group policy controls for who may create meta-agent grants, which capabilities may be granted, and whether grants require an administrator, while preserving the current human-granted and revocable trust model.
- System-administrator diagnostics for tracing effective Notepad access across meta-agent capabilities, Session policies, Explicit Notepad associations, and revoked or stale grants.

## Automations

- Automatic stale session archival when associated GitHub PRs are closed; direct-to-main workflows can already archive their current or child sessions through the `deputies` control tool.
- Scheduled follow-up prompts for an existing session and integration-source-aware scheduled callbacks, beyond the current automation-per-invocation session creation.
- Timezone-aware schedules and failure backoff for the existing UTC cron automations.
- One-off delayed tasks and reminders.
- Automation definition and invocation changes in the product-wide audit trail; ownership, invocation history, and next-run visibility already exist.
- Integration-triggered automations such as daily Slack summaries, weekly repository health checks, and scheduled GitHub issue/PR sweeps.
- Guardrails beyond the existing no-overlap default: max frequency, configurable concurrency, allowed repositories/sources, and external callback behavior.

## Sandboxes

- Provider conformance test suite.
- Sandbox metrics for create/connect/start/stop/destroy latency.
- Repository-aware, auto-refreshing sandbox images/snapshots for common repos that keep up with main, preinstall dependencies, precompile the app, and still use runner startup refresh for stale or missing worktrees.
- Automate building and publishing the Tensorlake sandbox image, including refreshing the registered Tensorlake image after base image changes.
- Remote Docker host bridge reachability: the current Docker provider publishes each sandbox bridge on the Docker host loopback (`127.0.0.1::3584`). In in-process mode with a remote Docker daemon, the control plane needs bridge reachability for exec, filesystem, and previews. In split mode, exec/filesystem can flow through the orchestrator, but previews still require direct bridge reachability today. Add orchestrator-side preview proxying, or make bridge bind/private-network configuration explicit and safe.

## Scale And Operations

- Generate `docs/configuration.md` from `apps/control-plane/src/config/index.ts` as the env source of truth, with `Name`, `Required When`, `Default`, `Values`, and `Description` columns, including conditional requirements such as `SANDBOX_SECRET_ENCRYPTION_KEY` for Postgres-backed Docker sandboxes, `GITHUB_WEBHOOK_TRIGGER_PHRASES` when GitHub webhooks are enabled, and Slack allowlists when `SLACK_SIGNING_SECRET` is set.
- User/org quotas and audit trails beyond the current auth, access-group, and session ownership model.
- Generalize append-only environment activity into a product-wide audit framework with typed actor/resource/action records, transactional capture, authorization-aware queries, retention policy, filtering, and export. Preserve environment activity as the first resource-specific producer rather than delaying durable capture for the generalized UI.
- Richer participant metadata beyond creator/message-author participation, such as tool-run actors and external integration actors.
- Source/repository-derived session tag dimensions such as `github:owner/repo`, `slack:channel`, and `repo:owner/name`.
- Additional `GET /sessions` filters for source/repository dimensions once those tags or fields exist.
- Per-user/per-team integration authorization policies for Slack, GitHub, Linear, and web UI entry points, beyond the current global allowlists.
- Metrics endpoint or structured timing logs.
- Observability pass across control-plane, workers, sandbox orchestrators, and sandbox bridge: structured request/lifecycle logs with session/run/sandbox correlation IDs, sandbox create/connect/exec/preview/destroy audit events, useful latency/error metrics, and optional trace propagation for HTTP orchestrator and provider calls.
- Pending-message, active-run, and worker-throughput dashboards.
- Event table pagination and session/event retention policies.
- Migration/release runbooks.
- Production readiness checklist.

## Testing

- Emulate-backed Slack callback tests in regular CI if reliable.
- Emulate-backed GitHub integration tests once the GitHub App JWT emulator caveat is resolved upstream.
- Expand deployment smoke coverage beyond the deterministic fake-runner path: Kubernetes split API/worker topology, Docker Compose split topology, static-session auth, migration idempotency on repeated install/upgrade, and a `cloud-provider-kind` LoadBalancer/Ingress access-mode check.
- Add a positive sandbox preview smoke once there is a deterministic fake or ephemeral preview provider; the current deployment smoke only verifies service-host proxy requests do not fall through to the web SPA.
- Opt-in credentialed UAT for the real Pi runner, sandbox provider, model credentials, and artifact-tool creation/download, separate from the deterministic fake-runner full-stack smoke.
- Real-provider smoke tests for Daytona on a schedule.
- Load profiles for session listing, event replay, SSE fanout, and worker throughput.
- Contract schemas for normalized event payloads.
