# Deputies

Deputies is a control plane for delegating engineering work to [background agents](https://background-agents.com/). It includes a fully featured web UI where each task gets a persistent session for queueing prompts, following live progress, reviewing diagnostics, inspecting artifacts, and managing callbacks from integrations like Slack, GitHub, or webhooks.

> [!NOTE]
> Deputies is still early-stage. Expect the system to evolve quickly as real usage exposes needed changes, including occasional breaking changes.

![Deputies primary view](docs/images/deputies-primary-view.png)

## What It Does

- Runs agent work in durable background sessions with searchable, paginated activity history.
- Streams progress, tool diagnostics, artifacts, and final responses into the web UI.
- Lets users star, tag, filter, search, archive, and resume sessions.
- Built on [Pi](https://pi.dev/) for real agent work, with a fake runner for deterministic smoke tests.
- Supports Slack, GitHub, generic webhook, and scheduled automation workflows with callback delivery tracking.
- Supports GitHub OAuth login, static login, access groups, and session ownership controls for browser access.
- Works with [Daytona](https://www.daytona.io/), Docker, Tensorlake, Kubernetes Agent Sandbox, and AWS Lambda MicroVM sandbox providers, plus fake and unsafe local providers for tests and trusted development.
- Runs repo-owned `.agents/setup` scripts to prepare sandbox workspaces before agents start.
- Supports standard LLM API-key configuration and OpenAI Codex/ChatGPT subscriptions.
- Tracks artifacts, callback deliveries, repositories, sandbox status, automations, and queued messages.
- Deploys as portable Node, Caddy, Postgres, and optional S3-compatible object storage services.

## Deployment

Start with the provider-agnostic deployment guide:

- `docs/deployment.md`: required services, env vars, integrations, sandbox providers, and operations checklists.

Specific deployment targets:

- Railway: the public template at `https://railway.com/deploy/deputies-monolith` provisions the app services and supporting infrastructure.
- Docker Compose: `deploy/docker-compose/` contains local production-style Compose stacks for combined and split API/worker/orchestrator deployments.
- Kubernetes: `deploy/kubernetes/` contains Helm charts for Kubernetes deployments.
- AWS: `deploy/aws/` contains a Terraform reference deployment for ECS Fargate, RDS, S3, and Lambda MicroVM sandboxes.

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
