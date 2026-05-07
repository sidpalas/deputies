# Feature Backlog

This is a living backlog for product, integration, runtime, and operations work. It is not a release commitment.

## Integrations

- Slack start/queued status acknowledgement beyond reaction-only progress.
- Slack direct-message support.
- GitHub provider-owned push, branch, and PR helper operations using fresh installation access, sanitized branch names, and verified PR artifacts.
- Preview URL detection and surfacing from sandbox/deployment output, including final callback links for Slack/GitHub and context-panel artifacts in the web UI.
- GitHub collaborator permission gating in addition to the current repository, user, org, and trigger-phrase gates.
- GitHub label-based triggers for teams that want non-mention workflows.
- GitHub final callback links for PR/artifact URLs after provider-owned PR helpers exist.
- Shared integration utilities for delivery dedupe, allowlists, external-thread session mapping, processed-item filtering, prompt section rendering, and callback target parsing before adding the next major integration.
- Source-agnostic received/final-response lifecycle so integrations add lightweight received signals while callback senders own exactly one final external reply.
- Global runner/agent instruction injection for integration behavior that should not appear in chat-visible source prompts.
- Linear integration for issue mentions, assignments, and comment follow-ups.
- Generic webhook mapping/filter/template configuration beyond the current simple payload shape.

## Web UI

- Session tagging, filtering, and grouping.
- User-selectable model, repository, branch, and execution settings.
- Repository picker with saved defaults per user/team/source.
- Session list pagination and server-side search.
- Pin/favorite sessions.
- Better run and sandbox status in the context panel.
- Preview URL cards in the context panel, with source, expiry/status, and quick-open/copy actions.
- Surface sandbox cleanup events and failures more clearly.
- Show callback delivery status per session/message.
- Improve archived-session browsing and bulk cleanup.
- Playwright smoke tests for desktop/mobile flows.

## Agent Runtime

- Agent authentication to external services through MCP, CLI credentials, API tokens, and short-lived provider tokens.
- Codex Pro subscription authentication for OpenAI Codex provider support, likely via Pi's OAuth-backed subscription auth (`~/.pi/agent/auth.json`).
- Credential scoping and injection policy for tools, commands, MCP servers, and sandbox environments.
- Multi-repository task support with one primary writable repo, auxiliary read-only context repos by default, and explicit multi-writable change sets when a task spans repos.
- Prompt templates and snapshot tests for Slack/GitHub/Linear inputs.
- Better repo resolution from Slack/GitHub/Linear context.
- Populate `repository list` from GitHub App installation repositories instead of only `GITHUB_ALLOWED_REPOSITORIES`, while keeping the allowlist as an optional safety filter.
- Setup/install hook observability beyond `repository_ready`.
- Preview URL artifact emission from agent tools and sandbox processes, with normalization for common local/dev-server/deployment URL patterns.
- Snapshot/image baking for common repos and build artifacts, with Flue startup refresh for stale or missing worktrees.
- Upstream Flue cancellation improvement for built-in bash/tool execution.

## Sandboxes

- Local Docker provider.
- Kubernetes provider.
- ECS/Fargate provider with bridge sidecar.
- Provider conformance test suite.
- Sandbox metrics for create/connect/start/stop/destroy latency.
- Object storage integration for large logs/artifacts.

## Scale And Operations

- Multiple product users and organizations with separate auth, session ownership, quotas, and audit trails.
- Per-user/per-team integration authorization policies for Slack, GitHub, Linear, and web UI entry points.
- Metrics endpoint or structured timing logs.
- Pending-message, active-run, and worker-throughput dashboards.
- Session/event table pagination and retention policies.
- Deployment guides for Railway, ECS Fargate + RDS, and Kubernetes.
- Migration/release runbooks.
- Production readiness checklist.

## Testing

- Emulate-backed Slack callback tests in regular CI if reliable.
- Emulate-backed GitHub integration tests once the GitHub App JWT emulator caveat is resolved upstream.
- Real-provider smoke tests for Daytona on a schedule.
- Load profiles for session listing, event replay, SSE fanout, and worker throughput.
- Contract schemas for public API responses and normalized events.
