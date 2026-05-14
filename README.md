# Deputies

Deputies is a control plane for delegating engineering work to [background agents](https://background-agents.com/). It includes a fully featured web UI where each task gets a persistent session for queueing prompts, following live progress, reviewing diagnostics, inspecting artifacts, and managing callbacks from integrations like Slack, GitHub, or webhooks.

![Deputies primary view](docs/images/deputies-primary-view.png)

## What It Does

- Runs agent work in background sessions with a searchable activity history.
- Streams progress, tool diagnostics, and final responses into the web UI.
- Uses [Flue](https://github.com/withastro/flue) under the hood to run and resume agent work.
- Supports Slack and GitHub integrations for issue, thread, and callback-driven workflows.
- Supports GitHub OAuth login for browser access control.
- Works with [Daytona](https://www.daytona.io/) as a remote sandbox provider, with unsafe local sandbox support for trusted development (more sandbox providers coming soon!)
- Supports standard LLM API-key configuration and OpenAI Codex/ChatGPT subscriptions.
- Tracks artifacts, callback deliveries, repositories, sandbox status, and queued messages.
- Easy to deploy anywhere: a React client, Node control plane, and Postgres-backed persistence.

## Project Layout

- `apps/`: independently runnable and deployable applications/services.
- `apps/control-plane/`: backend control-plane API, event stream, stores, integrations, workers, and sandbox providers.
- `apps/web/`: React frontend for session management and agent progress review.
- `packages/`: reusable libraries shared by apps. Empty for now; see `packages/README.md`.
- `deploy/`: deployment and local runtime configuration.
- `docs/`: architecture, domain notes, testing strategy, and feature backlog.

## More Docs

Start with `docs/README.md` for deeper project documentation.
