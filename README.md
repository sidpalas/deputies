# Deputies

Deputies is a control plane for delegating engineering work to [background agents](https://background-agents.com/). It includes a fully featured web UI where each task gets a persistent session for queueing prompts, following live progress, reviewing diagnostics, inspecting artifacts, and managing callbacks from integrations like Slack, GitHub, or webhooks.

> [!NOTE]
> Deputies is still early-stage. Expect the system to evolve quickly as real usage exposes needed changes, including occasional breaking changes.

![Deputies primary view](docs/images/deputies-primary-view.png)

## What It Does

- Runs agent work in background sessions with a searchable activity history.
- Streams progress, tool diagnostics, and final responses into the web UI.
- Built on [Pi](https://pi.dev/) for real agent work; the legacy Flue runner is deprecated and remains temporarily available during removal.
- Supports Slack and GitHub integrations for issue, thread, and callback-driven workflows.
- Supports GitHub OAuth login for browser access control.
- Works with [Daytona](https://www.daytona.io/) and Docker as sandbox providers, plus fake and unsafe local providers for tests and trusted development.
- Runs repo-owned `.agents/setup` scripts to prepare sandbox workspaces before agents start.
- Supports standard LLM API-key configuration and OpenAI Codex/ChatGPT subscriptions.
- Tracks artifacts, callback deliveries, repositories, sandbox status, and queued messages.
- Deploys as portable Node, Caddy, Postgres, and optional S3-compatible object storage services.

## Deployment

Start with the provider-agnostic deployment guide:

- `docs/deployment.md`: required services, env vars, integrations, sandbox providers, and operations checklists.

Specific deployment targets:

- Railway: the public template at `https://railway.com/deploy/deputies-monolith` provisions the app services and supporting infrastructure.
- Docker Compose: `deploy/docker-compose/` contains local production-style Compose stacks for combined and split API/worker/orchestrator deployments.

More deployment targets are expected over time. See `deploy/README.md`, `docs/deployment.md`, and target-specific docs for details.

## Local Development

For contributor setup, see `docs/contributing-local-development.md`. It covers the local Postgres and SeaweedFS baseline, Portless, Docker Compose, Pi runner setup, and local integration testing.

## Project Layout

- `apps/`: independently runnable and deployable applications/services.
- `apps/control-plane/`: backend control-plane API, event stream, stores, integrations, workers, and sandbox providers.
- `apps/web/`: React frontend for session management and agent progress review.
- `apps/www/`: static root-domain website with an embedded public demo build.
- `packages/`: reusable libraries shared by apps, including the Docker sandbox bridge.
- `deploy/`: deployment and local runtime configuration.
- `docs/`: architecture, domain notes, testing strategy, and feature backlog.

## More Docs

Start with `docs/README.md` for deeper project documentation.
