# Feature Backlog

This is a living backlog for product, integration, runtime, and operations work. It is not a release commitment.

## Integrations

- GitHub collaborator permission gating in addition to the current repository, user, org, and trigger-phrase gates.
- GitHub label-based triggers for teams that want non-mention workflows.
- Record existing or updated GitHub PRs as external resources, not only PRs created through `gh pr create`; include cases like `gh pr edit`, `gh pr view/checkout`, and branch pushes that resolve to an open PR.
- Continue consolidating shared integration utilities, especially allowlist helpers, prompt section rendering, and callback target parsing before adding the next major integration.
- Source-agnostic start/queued/final-response lifecycle so integrations add lightweight start signals while callback senders own exactly one final external reply.
- Global runner/agent instruction injection for integration behavior that should not appear in chat-visible source prompts.
- Linear integration for issue mentions, assignments, and comment follow-ups.
- Generic webhook mapping/filter/template configuration beyond the current simple payload shape.

## Web UI

- Session tagging, filtering, and grouping.
- Session filters for all sessions, started by me, participated in, and tag-based views.
- User-selectable model, repository, branch, and execution settings.
- Repository picker with saved defaults per user/team/source.
- Session list pagination and server-side search.
- Pin/favorite sessions.
- Audit and document preview-origin isolation after signed preview auth, including whether separate eTLD+1 deployment remains required for defense-in-depth against untrusted preview content.
- Surface sandbox cleanup events and failures more clearly.
- Expand callback delivery UI with filtering and clearer retry/failure history.
- Improve archived-session browsing and bulk cleanup.
- Broader Playwright smoke tests for desktop/mobile flows beyond the existing responsive context-panel coverage.

## Agent Runtime

- Agent-facing Deputies control/API surface, likely exposed through an MCP server, so agents can inspect available deputies, view sessions and session state, spawn new sessions, send follow-up messages, and coordinate handoffs or sub-agent work safely with scoped permissions and auditability.
- Agent authentication to external services through MCP, CLI credentials, API tokens, and short-lived provider tokens.
- Credential scoping and injection policy for tools, commands, MCP servers, and sandbox environments.
- First-class multi-repository task support, including environments made of one or more repositories, one primary writable repo by default, auxiliary read-only context repos, and explicit multi-writable change sets when a task spans repos.
- Prompt templates and snapshot tests for Slack/GitHub/Linear inputs.
- Better repo resolution from Slack/GitHub/Linear context.
- Setup/install hook observability beyond `repository_ready`.
- User-controlled startup scripts for repository/environment setup before agent work begins.
- Upstream Flue cancellation improvement for built-in bash/tool execution.
- OpenAI Codex OAuth refresh hardening for deployed workers: current loading can refresh expired access tokens at startup, but Flue then uses a static provider API key; static base64 auth variables can become stale when refresh tokens rotate; durable refresh state likely needs a writable auth file/volume or refresh-token-specific secret flow; avoid naive whole-run retry on 401 because agent/tool side effects may duplicate.

## Automations

- Automatic stale session archival when associated GitHub PRs are closed, plus an agent-accessible archive-thread tool for direct-to-main workflows after successful commit/push completion.
- Scheduled prompts for a session, repository, or integration source.
- Recurring tasks with cron-like schedules, timezone support, pause/resume, and failure backoff.
- One-off delayed tasks and reminders.
- Automation ownership, audit trail, run history, and last/next-run visibility in the web UI.
- Integration-triggered automations such as daily Slack summaries, weekly repository health checks, and scheduled GitHub issue/PR sweeps.
- Guardrails for max frequency, concurrency, allowed repositories/sources, and external callback behavior.
- Scheduler loop that enqueues normal messages into sessions instead of bypassing session/message/run invariants.

## Sandboxes

- Provider conformance test suite.
- Sandbox metrics for create/connect/start/stop/destroy latency.
- Repository-aware, auto-refreshing sandbox images/snapshots for common repos that keep up with main, preinstall dependencies, precompile the app, and still use Flue startup refresh for stale or missing worktrees.
- Automate building and publishing the Tensorlake sandbox image, including refreshing the registered Tensorlake image after base image changes.
- Remote Docker host bridge reachability: the current Docker provider publishes each sandbox bridge on the Docker host loopback (`127.0.0.1::3584`). In in-process mode with a remote Docker daemon, the control plane needs bridge reachability for exec, filesystem, and previews. In split mode, exec/filesystem can flow through the orchestrator, but previews still require direct bridge reachability today. Add orchestrator-side preview proxying, or make bridge bind/private-network configuration explicit and safe.

## Scale And Operations

- Generate `docs/configuration.md` from `apps/control-plane/src/config/index.ts` as the env source of truth, with `Name`, `Required When`, `Default`, `Values`, and `Description` columns, including conditional requirements such as `SANDBOX_SECRET_ENCRYPTION_KEY` for Postgres-backed Docker sandboxes, `GITHUB_WEBHOOK_TRIGGER_PHRASES` when GitHub webhooks are enabled, and Slack allowlists when `SLACK_SIGNING_SECRET` is set.
- Multiple product users and organizations with separate auth, session ownership, quotas, and audit trails.
- Session participants, including `createdByUserId` and users who send messages or otherwise participate.
- Session tags as a general metadata layer, starting with API/manual tags and later integration-derived tags such as `github:owner/repo`, `slack:channel`, and `repo:owner/name`.
- `GET /sessions` filters for `createdBy=me`, `participation=mine`, `tag=...`, and eventually source/repository filters.
- Preserve the shared workspace model: session filtering is for discovery and noise reduction, not an RBAC or visibility boundary.
- Per-user/per-team integration authorization policies for Slack, GitHub, Linear, and web UI entry points, beyond the current global allowlists.
- Metrics endpoint or structured timing logs.
- Observability pass across control-plane, workers, sandbox orchestrators, and sandbox bridge: structured request/lifecycle logs with session/run/sandbox correlation IDs, sandbox create/connect/exec/preview/destroy audit events, useful latency/error metrics, and optional trace propagation for HTTP orchestrator and provider calls.
- Pending-message, active-run, and worker-throughput dashboards.
- Session/event table pagination and retention policies.
- Deployment guides for Railway, Docker-Compose, and Kubernetes.
- Migration/release runbooks.
- Production readiness checklist.

## Testing

- Emulate-backed Slack callback tests in regular CI if reliable.
- Emulate-backed GitHub integration tests once the GitHub App JWT emulator caveat is resolved upstream.
- Expand deployment smoke coverage beyond the deterministic fake-runner path: Kubernetes split API/worker topology, Docker Compose split topology, static-session auth, migration idempotency on repeated install/upgrade, and a `cloud-provider-kind` LoadBalancer/Ingress access-mode check.
- Add a positive sandbox preview smoke once there is a deterministic fake or ephemeral preview provider; the current deployment smoke only verifies service-host proxy requests do not fall through to the web SPA.
- Opt-in credentialed UAT for real Flue runner, sandbox provider, model credentials, and artifact-tool creation/download, separate from the deterministic fake-runner full-stack smoke.
- Real-provider smoke tests for Daytona on a schedule.
- Load profiles for session listing, event replay, SSE fanout, and worker throughput.
- Contract schemas for public API responses and normalized events.
