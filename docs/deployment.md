# Deployment Guide

This guide describes how to deploy Deputies without assuming a specific hosting provider. Use it with platform-specific docs, templates, or infrastructure code.

## Deployment Shape

A production-like deployment usually includes:

- A web static entrypoint and reverse proxy that serves `apps/web/dist`, proxies API routes, and forwards sandbox service preview hosts.
- One or more control-plane API processes.
- One or more worker processes, either combined with the API or split out.
- Postgres for durable product state and runner state.
- Optional S3-compatible object storage for artifact blobs.
- A sandbox provider for real agent work: Daytona, Docker, Tensorlake, Kubernetes Agent Sandbox, or AWS Lambda MicroVM.

The diagrams below show the three intended deployment modes, from the smallest useful setup to a horizontally scalable split topology.

### Simple Mode

Use simple mode for small deployments: one combined API/worker process, web/proxy entrypoint, Postgres, optional S3-compatible artifact storage, and a sandbox provider.

![Simple deployment mode](images/simple-mode.svg)

### Integrated Mode

Use integrated mode when you want separate API and worker processes, but still keep the core services in one application deployment boundary.

![Integrated deployment mode](images/integrated-mode.svg)

### Scale Mode

Use scale mode when API, worker, web/proxy, storage, and sandbox orchestration need independent scaling or stronger isolation.

![Scale deployment mode](images/scale-mode.svg)

## Images And Dockerfiles

Use the published GHCR images for standard deployments, or use the in-repo Dockerfiles as starting points for provider-specific builds:

| Component       | Published image                                             | Dockerfile                            |
| --------------- | ----------------------------------------------------------- | ------------------------------------- |
| Control plane   | `ghcr.io/sidpalas/deputies-control-plane:<tag-or-digest>`   | `apps/control-plane/Dockerfile`       |
| Web             | `ghcr.io/sidpalas/deputies-web:<tag-or-digest>`             | `apps/web/Dockerfile`                 |
| Sandbox base    | `ghcr.io/sidpalas/deputies-sandbox-base:<tag-or-digest>`    | `deploy/sandboxes/base/Dockerfile`    |
| Docker sandbox  | `ghcr.io/sidpalas/deputies-docker-sandbox:<tag-or-digest>`  | `deploy/sandboxes/docker/Dockerfile`  |
| Daytona sandbox | `ghcr.io/sidpalas/deputies-daytona-sandbox:<tag-or-digest>` | `deploy/sandboxes/daytona/Dockerfile` |

The web image serves the built `apps/web/dist` assets behind Caddy and proxies browser-facing API routes. The control-plane image runs `apps/control-plane/dist/index.js` and uses `RUN_MODE` to choose API, worker, or combined process responsibilities.

The published web and control-plane images are multi-arch manifests for `linux/amd64` and `linux/arm64`. AWS Fargate deployments should prefer `ARM64`/Graviton unless a dependency forces x86. The sandbox provider images are currently published as `linux/amd64`; Lambda MicroVM images are built by AWS from the dedicated `deploy/sandboxes/lambda-microvm` package instead of GHCR OCI images.

Local app image helpers:

```sh
mise run images:app:build:local

CONTROL_PLANE_IMAGE=ghcr.io/<owner>/deputies-control-plane:<tag> \
WEB_IMAGE=ghcr.io/<owner>/deputies-web:<tag> \
mise run images:app:push:multiarch
```

`images:app:push:multiarch` uses the active Docker Buildx builder and defaults to `DEPUTIES_APP_IMAGE_PLATFORMS=linux/amd64,linux/arm64`. Use QEMU/binfmt for local emulation, or select a remote Buildx builder such as Namespace, Depot, or another Docker Build Cloud/remote builder before running the task.

Use the published sandbox images as the base/reference images for deployments:

```sh
DOCKER_SANDBOX_IMAGE=ghcr.io/sidpalas/deputies-docker-sandbox:<tag-or-digest>
DAYTONA_IMAGE=ghcr.io/sidpalas/deputies-daytona-sandbox:<tag-or-digest>
```

Most production deployments should build and publish a derivative sandbox image for each repository or organization because agent tasks usually need project-specific toolchains, CLIs, package managers, browser dependencies, database clients, or language runtimes. Start from the published provider image so the provider runtime contract stays intact.

The repo-owned provider Dockerfiles are useful starting points when designing your own images: `deploy/sandboxes/docker/Dockerfile` for the Docker provider and `deploy/sandboxes/daytona/Dockerfile` for Daytona.

Docker provider derivative example:

```Dockerfile
FROM ghcr.io/sidpalas/deputies-docker-sandbox:<tag-or-digest>

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
USER sandbox
```

Daytona provider derivative example:

```Dockerfile
FROM ghcr.io/sidpalas/deputies-daytona-sandbox:<tag-or-digest>

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
USER daytona
```

## Run Modes

`RUN_MODE` controls process responsibilities:

| Mode       | Behavior                                                                                |
| ---------- | --------------------------------------------------------------------------------------- |
| `combined` | API, worker, and automation scheduler loops in one process. Good for small deployments. |
| `api`      | API only. Use with separate worker replicas.                                            |
| `worker`   | Worker and automation scheduler only. Also exposes `/health` on `PORT`.                 |

Recommended topologies:

- Simple mode: one or more `RUN_MODE=combined` instances with Postgres.
- Integrated mode: one or more `RUN_MODE=api` instances plus one or more `RUN_MODE=worker` instances.
- Scale mode: API/worker processes call separate infrastructure such as a Docker orchestrator over HTTP.

Scheduled automations are claimed by worker-capable processes. API-only deployments can create and edit automations, but automatic scheduled invocation requires at least one `combined` or `worker` process.

The AWS reference Terraform supports this with `topology_mode=combined` or `topology_mode=split`. Combined mode creates one ECS service that runs web, API, worker, and migrations in one task. Split mode creates an API ECS service that runs web, API, and migrations plus a separate worker ECS service that runs worker and migrations. Each service gates its main container on the migration container completing successfully.

## Base Environment

Every control-plane process needs:

```sh
PORT=3583
RUN_MODE=combined
API_AUTH_MODE=session
APP_DATA_STORE=postgres
DATABASE_URL=postgres://user:password@host:5432/db
RUNNER_STATE_STORE=postgres
```

`API_AUTH_MODE` is required and must be one of:

```txt
none
bearer
session
```

Use `session` in almost all deployments, especially any browser-facing product deployment. Reserve `none` for local/test environments and `bearer` for narrow machine-to-machine or internal API access.

## Observability

OpenTelemetry export is disabled by default. Enable it on API and worker processes with the standard OTel environment variables:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com
OTEL_SERVICE_NAME=deputies-control-plane
```

Set `OTEL_SDK_DISABLED=true` to force-disable export. Other standard OTLP variables such as `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` are passed through to the OpenTelemetry SDK/exporters.

The browser does not export directly to OpenTelemetry. It posts authenticated milestone payloads to `/telemetry/browser-milestones`; keep that route proxied with the rest of the browser-facing API routes.

## Remote MCP Servers

Workers can expose tools from remote MCP servers to the agent with `MCP_SERVERS`. This is primarily intended for Executor, where Executor stores upstream integration credentials and Deputies only receives a streamable-HTTP MCP endpoint. See [Executor Data Tools](./executor-data-tools.md) for the end-to-end setup flow.

Executor example:

```sh
MCP_SERVERS='[
  {
    "name": "executor",
    "url": "https://<executor-host>/mcp",
    "headers": { "Authorization": "Bearer <executor-api-key>" },
    "transport": "streamable-http",
    "allowedTools": ["execute", "skills", "resume"]
  }
]'
```

Related knobs:

```sh
MCP_CONNECT_TIMEOUT_MS=10000
MCP_TOOL_TIMEOUT_MS=60000
MCP_TOOL_RESULT_MAX_CHARS=100000
MCP_RESPONSE_MAX_BYTES=5242880
```

Notes:

- `MCP_SERVERS` defaults to an empty array when unset, so remote MCP tools are opt-in.
- `name` is sanitized into the tool prefix. A server named `executor` exposes tools such as `mcp__executor__execute`.
- `headers` are attached by the control-plane worker's MCP transport and are not forwarded to the sandbox.
- `allowedTools` is optional and filters original, unprefixed MCP tool names.
- `MCP_RESPONSE_MAX_BYTES` is a transport-level cap enforced while receiving MCP responses for both streamable HTTP and SSE.
- `MCP_TOOL_TIMEOUT_MS` and `MCP_TOOL_RESULT_MAX_CHARS` are enforced by the Pi/shared MCP client. The deprecated Flue native MCP adapter ignores those two per-call/text-result knobs, but still uses the connect timeout and response byte cap.
- A server that cannot connect for a run is skipped non-fatally; the agent receives a prompt note that the tools are unavailable.

## Postgres And Migrations

Recommended durable configuration:

```sh
APP_DATA_STORE=postgres
DATABASE_URL=postgres://user:password@host:5432/db
RUNNER_STATE_STORE=postgres
```

Run migrations before starting Postgres-backed API, worker, or scheduler processes. The migration runner uses a Postgres advisory lock, so a dedicated migration job is safe even if retried, but application processes do not run migrations at startup:

```sh
DATABASE_URL=postgres://... mise run //apps/control-plane:db:migrate
```

Memory mode is only for demos/tests:

```sh
APP_DATA_STORE=memory
RUNNER_STATE_STORE=memory
```

Do not use memory mode for multi-replica deployments.

## Product Authentication

### Bearer Auth

```sh
API_AUTH_MODE=bearer
API_BEARER_TOKEN=<high-entropy-token>
```

Bearer auth is useful for machine/internal API access. It is not ideal for browser deployments with service preview links because new tabs cannot automatically attach bearer tokens to wildcard service hosts.

### Static Session Auth

```sh
API_AUTH_MODE=session
AUTH_PROVIDER=static
AUTH_STATIC_USERNAME=<admin-username>
AUTH_STATIC_PASSWORD=<strong-password>
AUTH_SESSION_SECRET=<high-entropy-secret>
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAME_SITE=lax
```

Static auth grants admin access to the configured user.

### GitHub Session Auth

```sh
API_AUTH_MODE=session
AUTH_PROVIDER=github
AUTH_SESSION_SECRET=<high-entropy-secret>
GITHUB_OAUTH_CLIENT_ID=<github-app-client-id>
GITHUB_OAUTH_CLIENT_SECRET=<github-app-client-secret>
GITHUB_OAUTH_CALLBACK_URL=https://app.example.com/auth/oauth/github/callback
AUTH_GITHUB_ADMIN_USERS=octocat
AUTH_GITHUB_ALLOWED_USERS=
AUTH_GITHUB_ALLOWED_ORGANIZATIONS=
AUTH_GITHUB_DEFAULT_GROUP_ROLE=member
```

`AUTH_GITHUB_ADMIN_USERS` grants super-admin access and is restored on login. `AUTH_GITHUB_ALLOWED_*` controls which non-admin GitHub users can sign in, and `AUTH_GITHUB_DEFAULT_GROUP_ROLE` sets their default access group role. See [Access Groups](./access-groups.md) for RBAC behavior and role semantics.

## Web Entrypoint, Proxying, And Cookies

The web entrypoint should proxy these paths to the control-plane API:

```txt
/health
/auth*
/automations*
/sessions*
/events*
/groups*
/repositories*
/models*
/setup*
/telemetry*
/users*
/webhooks*
```

It should also proxy sandbox service preview hosts whose hostname starts with `s-` to the control-plane service proxy. See `apps/web/Caddyfile` and `apps/web/Caddyfile.local` for reference Caddy configs. The matcher defaults to the `^s-` host prefix and can be overridden with `SERVICE_HOST_REGEX` (`web.serviceHostRegex` in the Helm chart); set `SERVICE_HOST_REGEX=^$` for an instance running only as an app preview behind another Deputies service host.

Recommended same-origin production shape:

```sh
WEB_BASE_URL=https://app.example.com
SERVICE_BASE_DOMAIN=example.com
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAME_SITE=lax
SERVICE_TRUST_FORWARDED_HOSTS=false
VITE_API_BASE_URL=
```

DNS/TLS requirements:

- `app.example.com` points to the web/proxy entrypoint.
- `*.example.com` points to the same web/proxy entrypoint.
- Sandbox service previews use hosts like `https://s-3000-<session-id>.example.com`.

The main app session cookie is host-only. Service previews use a short-lived signed preview token to set a preview-only cookie on the service host.

Prefer first-level wildcards such as `*.example.com`. Nested wildcards such as `*.app.example.com` may require provider-specific certificate support.

Future deployment variants may split this further by serving static web assets from a CDN or static host and moving API/service-preview routing into an existing reverse proxy or Kubernetes ingress controller. That path should keep the same route and wildcard-host behavior as the reference Caddy configs, but it is not the primary tested deployment shape yet.

If hosting static web assets separately from the API/proxy, build the web UI with:

```sh
VITE_API_BASE_URL=https://api.example.com
```

and set the API-side browser origin:

```sh
WEB_BASE_URL=https://app.example.com
```

## Runner And Model Providers

Fake runner:

```sh
RUNNER=fake
SANDBOX_PROVIDER=fake
```

Default real runner:

```sh
RUNNER=pi
RUNNER_MODEL_DEFAULT=anthropic/claude-haiku-4-5
```

`RUNNER=flue` is deprecated and kept only for legacy deployments while the Flue runner is removed. Do not use it for new deployments.

Provider credentials:

```sh
ANTHROPIC_API_KEY=<secret>
OPENAI_API_KEY=<secret>
OPENCODE_API_KEY=<secret>
```

Amazon Bedrock through Pi:

```sh
RUNNER=pi
RUNNER_MODEL_DEFAULT=amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0
BEDROCK_REGION=us-east-2
```

Bedrock uses the default AWS SDK credential chain, such as an ECS task role in the AWS reference deployment. If `BEDROCK_REGION` is unset, Deputies falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1`. Claude models commonly require inference-profile IDs with the regional prefix, for example `us.anthropic.claude-haiku-4-5-20251001-v1:0`; direct base model IDs can fail when on-demand throughput is unsupported. If Bedrock ships a useful inference-profile ID before the Pi catalog includes it, add a temporary entry to `AMAZON_BEDROCK_INFERENCE_PROFILE_MODELS` in `apps/control-plane/src/runner/bedrock.ts`.

Optional model picker choices override:

```sh
RUNNER_MODEL_CHOICES=anthropic/claude-haiku-4-5,openai/gpt-5.5
```

If unset, model choices are derived from Pi's catalog for providers with configured credentials.

## Repository Setup Scripts

Deputies runs a repository-committed `.agents/setup` script after clone/checkout and before the agent prompt when the script is present. See [Repository Setup Scripts](./repository-setup-scripts.md) for the user-facing convention.

```sh
REPOSITORY_SETUP_SCRIPT_ENABLED=true
REPOSITORY_SETUP_SCRIPT_TIMEOUT_SECONDS=600
```

Set `REPOSITORY_SETUP_SCRIPT_ENABLED=false` to disable repo-owned setup execution globally. This can be useful for restricted providers or operators that do not want repository code running before the agent starts. The clone/fetch `GITHUB_AUTH_HEADER` is never passed to the setup script.

OpenAI Codex subscription auth:

```sh
mise run //apps/control-plane:auth:login:openai-codex
```

The login task writes OAuth credentials to `~/.pi/agent/auth.json` by default. Use `OPENAI_CODEX_AUTH_FILE` when the runtime should read a mounted copy from another path.

```sh
RUNNER_MODEL_DEFAULT=openai-codex/gpt-5.5
OPENAI_CODEX_AUTH_FILE=/run/secrets/openai-codex-auth.json
OPENAI_CODEX_AUTH_BASE64=<base64-auth-json>
```

Prefer a mounted secret file or `OPENAI_CODEX_AUTH_BASE64` for hosted deployments.

## Web Search Tool

The `web_search` agent tool runs in the control-plane worker, not in the sandbox. This keeps search credentials off sandbox filesystems and lets Deputies enforce URL safety checks centrally.

Default provider selection:

```sh
WEB_SEARCH_PROVIDER=auto
WEB_SEARCH_BRAVE_API_KEY=<optional>
WEB_SEARCH_MAX_RESULTS=10
WEB_SEARCH_CONTENT_MAX_CHARS=5000
WEB_SEARCH_TIMEOUT_MS=10000
```

`WEB_SEARCH_PROVIDER=auto` uses Brave Search when `WEB_SEARCH_BRAVE_API_KEY` or `BRAVE_API_KEY` is set. Without a Brave key, it falls back to DuckDuckGo HTML search, which does not require an API key. Set `WEB_SEARCH_PROVIDER=disabled` to remove the tool, or `WEB_SEARCH_PROVIDER=brave` to fail closed unless a Brave key is configured.

## Deputy Control Tool

The `deputies` agent tool is enabled by default so agents can coordinate separate, durable Deputies sessions from inside a run:

```sh
DEPUTY_TOOL_ENABLED=true
DEPUTY_MAX_SPAWN_DEPTH=2
DEPUTY_MAX_CHILDREN_PER_SESSION=5
DEPUTY_MAX_SPAWNS_PER_RUN=3
```

Set `DEPUTY_TOOL_ENABLED=false` to hide the tool for a conservative deployment.

When enabled for `RUNNER=pi` or deprecated `RUNNER=flue`, the tool runs in the trusted worker process and writes product sessions/messages through the control-plane store. It does not grant sandbox credentials to the model. Spawned child sessions inherit the parent's owner group, visibility, and write policy, and copy the triggering message's author user as creator attribution when present. They can optionally enqueue one deputy-authored parent follow-up on terminal completion, failure, or cancellation with `notifyOnComplete=true`. Successful completion follow-ups are informational and output-free; agents can explicitly request bounded newest-first transcript pages with `get_session` when the child result matters.

Before relying on the default in production, review the organization-level coordination policy, worker capacity, and session-spawn limits. Use `DEPUTY_TOOL_ENABLED=false` if the deployment needs a conservative rollout.

## Sandbox Providers

### Fake

```sh
SANDBOX_PROVIDER=fake
```

For demos/tests only.

### Unsafe Local

```sh
SANDBOX_PROVIDER=unsafe-local
LOCAL_SANDBOX_ALLOWED_COMMANDS=
```

Not a security boundary. Use only for trusted local development.

### Docker

```sh
SANDBOX_PROVIDER=docker
DOCKER_SANDBOX_IMAGE=ghcr.io/sidpalas/deputies-docker-sandbox:<tag-or-digest>
DOCKER_SANDBOX_BRIDGE_HOST=127.0.0.1
DOCKER_CLI_TIMEOUT_MS=30000
SANDBOX_WORKSPACE_PATH=/workspace
```

Optional resource controls:

```sh
DOCKER_SANDBOX_NETWORK=
DOCKER_SANDBOX_MEMORY=
DOCKER_SANDBOX_CPUS=
```

Required for Postgres-backed Docker, Kubernetes Agent Sandbox, and Lambda MicroVM sandboxes:

```sh
SANDBOX_SECRET_ENCRYPTION_KEY=<stable-high-entropy-secret>
```

Generate it once:

```sh
openssl rand -base64 32
```

Changing this key prevents decrypting existing encrypted sandbox provider secrets.

In-process Docker orchestration:

```sh
DOCKER_ORCHESTRATOR_MODE=in-process
```

HTTP Docker orchestration:

```sh
DOCKER_ORCHESTRATOR_MODE=http
DOCKER_ORCHESTRATOR_URL=http://docker-orchestrator:3585
DOCKER_ORCHESTRATOR_TOKEN=<shared-secret>
DOCKER_ORCHESTRATOR_HOST=0.0.0.0
DOCKER_ORCHESTRATOR_PORT=3585
```

Only the Docker orchestrator service should need Docker daemon access in this topology.

### Daytona

```sh
SANDBOX_PROVIDER=daytona
DAYTONA_API_KEY=<secret>
DAYTONA_API_URL=<optional>
DAYTONA_TARGET=<optional>
DAYTONA_IMAGE=ghcr.io/sidpalas/deputies-daytona-sandbox:<tag-or-digest>
DAYTONA_SNAPSHOT=<optional>
SANDBOX_WORKSPACE_PATH=/workspace
```

Optional Daytona resource request:

```sh
DAYTONA_SANDBOX_CPU=2
DAYTONA_SANDBOX_GPU=
DAYTONA_SANDBOX_MEMORY_GIB=4
DAYTONA_SANDBOX_DISK_GIB=10
```

Leave these empty to use Daytona defaults. These are deployment-level controls because resource sizing affects cost and capacity. If per-session sizing is needed later, expose an allowlisted resource profile in the session API rather than accepting raw CPU, memory, or disk values from clients.

`DAYTONA_API_KEY` is required when `SANDBOX_PROVIDER=daytona`.

Use pinned image tags or digests instead of `latest`. For private registries, configure registry credentials in Daytona.

### AWS Lambda MicroVM

```sh
SANDBOX_PROVIDER=lambda-microvm
LAMBDA_MICROVM_IMAGE_IDENTIFIER=<image-name-or-arn>
LAMBDA_MICROVM_IMAGE_VERSION=<optional-version>
LAMBDA_MICROVM_EXECUTION_ROLE_ARN=<optional-runtime-role-arn>
LAMBDA_MICROVM_INGRESS_NETWORK_CONNECTORS=arn:aws:lambda:us-east-2:aws:network-connector:aws-network-connector:ALL_INGRESS
LAMBDA_MICROVM_EGRESS_NETWORK_CONNECTORS=arn:aws:lambda:us-east-2:aws:network-connector:aws-network-connector:INTERNET_EGRESS
LAMBDA_MICROVM_MAXIMUM_DURATION_SECONDS=28800
LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES=30
LAMBDA_MICROVM_BRIDGE_PORT=3584
```

Lambda MicroVM images are built/updated outside the app process with `deploy/sandboxes/lambda-microvm` tasks. The AWS reference Terraform in `deploy/aws` creates the supporting artifact bucket, build role, runtime role, log group, and ECS task-role permissions, then passes the selected image identifier into the app.

MicroVM inbound traffic uses the AWS-managed MicroVM HTTPS endpoint with `X-aws-proxy-auth` and `X-aws-proxy-port` headers. VPC network connectors configure MicroVM egress, such as public internet or private VPC access; they do not replace the inbound endpoint.

The repo-owned Lambda MicroVM image runs the hook server, bridge, and agent commands as `root`. That is intentional for this sandbox boundary: Lambda MicroVM may set `no_new_privs`, which prevents `sudo` from elevating a non-root command user. The default image includes Docker packages but does not include media tooling such as `ffmpeg`; add extra packages in a derived image if your workload needs them. For nested Docker, build/update the MicroVM image with `MICROVM_ADDITIONAL_OS_CAPABILITIES=ALL`; this maps to AWS `additionalOsCapabilities: ["ALL"]` and enables the cgroup/mount capabilities required by `dockerd`. The image lazily starts `dockerd` on the first `docker` command rather than during sandbox startup. Verify `docker info` and `docker run --rm hello-world` against a rebuilt image before relying on Docker-in-sandbox workflows.

`SANDBOX_SECRET_ENCRYPTION_KEY` must be stable across restarts so encrypted Lambda MicroVM bridge credentials can be decrypted for resume, preview, and cleanup flows.

## Sandbox Lifecycle Tuning

```sh
SANDBOX_IDLE_TIMEOUT_SECONDS=900
SANDBOX_STOP_DELAY_SECONDS=60
SANDBOX_RETENTION_SECONDS=3600
SANDBOX_KEEPALIVE_MAX_EXTENSION_SECONDS=7200
WORKER_CONCURRENCY=4
WORKER_POLL_INTERVAL_MS=1000
RUN_CANCELLATION_POLL_INTERVAL_MS=1000
```

Higher `WORKER_CONCURRENCY` increases simultaneous sandbox, model, and integration load.

## Artifact Storage

Disabled:

```sh
ARTIFACT_STORAGE_PROVIDER=disabled
```

Filesystem, best for local/single-process use:

```sh
ARTIFACT_STORAGE_PROVIDER=filesystem
ARTIFACT_STORAGE_FILESYSTEM_PATH=/var/lib/deputies/artifacts
```

S3-compatible storage, recommended for production-like deployments:

```sh
ARTIFACT_STORAGE_PROVIDER=s3
ARTIFACT_STORAGE_S3_BUCKET=deputies-artifacts
ARTIFACT_STORAGE_S3_ACCESS_KEY_ID=<secret>
ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY=<secret>
ARTIFACT_STORAGE_S3_REGION=us-east-1
ARTIFACT_STORAGE_S3_ENDPOINT=https://s3.example.com
ARTIFACT_STORAGE_S3_FORCE_PATH_STYLE=false
ARTIFACT_STORAGE_S3_CREATE_BUCKET=false
ARTIFACT_CREATE_MAX_BYTES=26214400
```

Native AWS deployments can omit `ARTIFACT_STORAGE_S3_ACCESS_KEY_ID` and `ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY` to use the default AWS SDK credential chain, such as an ECS task role. Custom S3-compatible endpoints still require explicit access keys.

Keep downloads going through the API so product auth is enforced. Do not expose object storage credentials to browsers.

## GitHub App Setup

Deputies uses GitHub App credentials for runtime repository access and can also use GitHub OAuth credentials for product login. The same GitHub App can provide both sets of credentials if it is created/configured as a GitHub App with OAuth callback support. A GitHub OAuth App can only be used for OAuth login; it cannot provide runtime repository access because it has no App ID, installation access tokens, or private key.

Runtime repository access:

```sh
GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY=<private-key>
GITHUB_ALLOWED_REPOSITORIES=owner/repo,owner/*
GITHUB_API_BASE_URL=https://api.github.com
GITHUB_CLONE_BASE_URL=https://github.com
```

Product login OAuth:

```sh
GITHUB_OAUTH_CLIENT_ID=<client-id>
GITHUB_OAUTH_CLIENT_SECRET=<client-secret>
GITHUB_OAUTH_BASE_URL=https://github.com
GITHUB_OAUTH_CALLBACK_URL=https://app.example.com/auth/oauth/github/callback
```

Setup steps:

1. Create a GitHub App under the user or organization account.
2. Set the callback URL exactly to `https://app.example.com/auth/oauth/github/callback`.
3. Generate and download a private key.
4. Copy App ID to `GITHUB_APP_ID`.
5. Store the private key in `GITHUB_APP_PRIVATE_KEY`. Env files can use `\n` escapes; secrets managers can usually store real newlines.
6. Copy Client ID and Client secret to `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`.
7. Install the app on repositories Deputies should access.
8. Set `GITHUB_ALLOWED_REPOSITORIES` to the narrowest owner/repo or owner/\* patterns you need.

GitHub webhooks:

```sh
GITHUB_WEBHOOK_SECRET=<shared-secret>
GITHUB_WEBHOOK_ALLOWED_USERS=octocat,hubot
GITHUB_WEBHOOK_ALLOWED_ORGANIZATIONS=acme
GITHUB_WEBHOOK_TRIGGER_PHRASES=/deputies,deputies:,@acme/deputies
UNSAFE_GITHUB_WEBHOOK_ALLOW_ALL_USERS_AND_ORGS=false
```

Webhook URL:

```txt
https://app.example.com/webhooks/github/events
```

GitHub webhooks fail closed when `GITHUB_WEBHOOK_SECRET` is set. Configure at least one user/org allowlist unless `UNSAFE_GITHUB_WEBHOOK_ALLOW_ALL_USERS_AND_ORGS=true`, and configure at least one trigger phrase.

## Slack App Setup

Slack webhook URL:

```txt
https://app.example.com/webhooks/slack/events
```

Required env:

```sh
SLACK_API_BASE_URL=https://slack.com/api
SLACK_SIGNING_SECRET=<from Slack Basic Information>
SLACK_BOT_TOKEN=xoxb-...
UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS=false
SLACK_ALLOWED_TEAM_IDS=T...
SLACK_ALLOWED_CHANNEL_IDS=C...
SLACK_ALLOWED_USER_IDS=U...
```

Slack fails closed when `SLACK_SIGNING_SECRET` is set. Configure at least one allowlist or explicitly set `UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS=true`.

Slack app setup:

1. Enable Event Subscriptions.
2. Set Request URL to `https://app.example.com/webhooks/slack/events`.
3. Subscribe to `app_mention`.
4. Optionally subscribe to `message.channels` and `message.groups` for follow-ups in mapped threads.
5. Add bot scopes such as `app_mentions:read`, `chat:write`, `reactions:write`, `users:read`, `channels:read`, and `groups:read` as needed.
6. Install or reinstall the app.
7. Invite the bot to relevant channels.

## Generic Webhooks And Callbacks

Generic webhook route:

```txt
POST /webhooks/generic/:sourceKey
```

Generic webhook sources are stored in the database and use their own bearer tokens independent of product API auth.

HTTP callbacks to local/private networks are blocked unless explicitly enabled:

```sh
UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS=true
```

Use that only for trusted local testing.

## Health And Setup Checks

Health:

```txt
GET /health
```

Setup status:

```txt
GET /setup/status
```

Setup status checks auth, Slack, GitHub webhooks, runner, sandbox provider, GitHub App runtime access, model providers, artifact storage, Postgres, and migrations. Use it after deployment and after secret changes.

Set this only if you intentionally want to hide the setup checklist UI:

```sh
HIDE_SETUP_PAGE=true
```

## Secrets

Treat these as secrets:

```txt
DATABASE_URL
API_BEARER_TOKEN
AUTH_STATIC_PASSWORD
AUTH_SESSION_SECRET
GITHUB_APP_PRIVATE_KEY
GITHUB_OAUTH_CLIENT_SECRET
GITHUB_WEBHOOK_SECRET
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
ANTHROPIC_API_KEY
OPENAI_API_KEY
OPENCODE_API_KEY
OPENAI_CODEX_AUTH_FILE contents
OPENAI_CODEX_AUTH_BASE64
DAYTONA_API_KEY
DOCKER_ORCHESTRATOR_TOKEN
SANDBOX_SECRET_ENCRYPTION_KEY
ARTIFACT_STORAGE_S3_ACCESS_KEY_ID
ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY
```

Use a secrets manager where possible. Avoid `UNSAFE_*` flags in production.

## Scaling Notes

- API instances can scale horizontally with Postgres.
- Worker replicas can scale horizontally with Postgres-backed run leases.
- Tune `WORKER_CONCURRENCY` based on sandbox, model, and provider capacity.
- Prefer S3-compatible artifact storage for multi-replica deployments.
- Prefer a separate Docker orchestrator if API/worker containers should not have Docker socket access.
- Keep `SANDBOX_SECRET_ENCRYPTION_KEY` stable once Docker sandbox secrets exist.

## Deployment Checklist

- Choose topology: `all` or split `api`/`worker`.
- Use `API_AUTH_MODE=session` for browser deployments. Reserve `bearer` or `none` for development tooling, tests, or programmatic/internal API access.
- Provision Postgres and run migrations before starting API or worker processes.
- Provision object storage if artifacts are needed.
- Configure DNS/TLS for app host and wildcard service preview hosts.
- Prepare model credentials.
- Prepare sandbox provider credentials and images.
- Prepare GitHub App and Slack App if integrations are needed.
- Build control plane and web UI.
- Start Postgres, object storage, Docker orchestrator if needed, API processes, worker processes, and web/proxy entrypoint.
- Verify `/health` and `/setup/status`.
- Verify login, session creation, a test run, artifacts if enabled, service preview links if needed, and webhook delivery if integrations are enabled.
