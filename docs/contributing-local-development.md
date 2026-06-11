# Local Development

This is the fastest path to a solid local Deputies setup. It uses Postgres and SeaweedFS via Docker Compose, Portless HTTPS, static session auth, `RUN_MODE=combined`, the Docker sandbox provider, and an Anthropic or OpenAI API key.

## Prerequisites

- `mise` for the pinned toolchain.
- Docker Desktop or another Docker Engine for Postgres, SeaweedFS, and Docker sandboxes.
- An Anthropic or OpenAI API key.
- Optional: `ngrok` or another public HTTPS tunnel for external webhook delivery, such as Slack and GitHub events.

Install tools and dependencies:

```sh
mise install
pnpm install
```

The Portless commands used below run through mise tasks with `pnpm dlx`, so there is no separate Portless install step.

Install ngrok separately only if you need external webhook delivery into your local machine, such as Slack or GitHub events; it is not needed for the default local UI, API, or sandbox flow.

## Setup

Create a local env file:

```sh
cp .env.example .env.local
```

Generate two local secrets:

```sh
openssl rand -base64 32
openssl rand -base64 32
```

Edit `.env.local` with this baseline. Use one generated value for `AUTH_SESSION_SECRET` and the other for `SANDBOX_SECRET_ENCRYPTION_KEY`.

```sh
RUN_MODE=combined

APP_DATA_STORE=postgres
DATABASE_URL=postgres://deputies:deputies@localhost:5432/deputies
TEST_DATABASE_URL=postgres://deputies:deputies@localhost:5432/deputies_test
RUNNER_STATE_STORE=postgres

ARTIFACT_STORAGE_PROVIDER=s3
ARTIFACT_STORAGE_S3_ENDPOINT=http://localhost:8333
ARTIFACT_STORAGE_S3_REGION=us-east-1
ARTIFACT_STORAGE_S3_BUCKET=deputies-artifacts
ARTIFACT_STORAGE_S3_ACCESS_KEY_ID=seaweed
ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY=seaweed
ARTIFACT_STORAGE_S3_FORCE_PATH_STYLE=true
ARTIFACT_STORAGE_S3_CREATE_BUCKET=true

API_AUTH_MODE=session
AUTH_PROVIDER=static
AUTH_STATIC_USERNAME=dev
AUTH_STATIC_PASSWORD=dev-secret
AUTH_SESSION_SECRET=<generated-secret>
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAME_SITE=lax
WEB_BASE_URL=https://deputies.localhost
SERVICE_BASE_DOMAIN=deputies.localhost
SERVICE_TRUST_FORWARDED_HOSTS=true
VITE_API_BASE_URL=
VITE_PORTLESS_URL=https://deputies.localhost

RUNNER=flue
RUNNER_MODEL_DEFAULT=anthropic/claude-haiku-4-5
ANTHROPIC_API_KEY=<secret>

# Optional: use Brave for the agent web_search tool. Without this, web_search uses no-key DuckDuckGo HTML search.
WEB_SEARCH_BRAVE_API_KEY=

SANDBOX_PROVIDER=docker
DOCKER_SANDBOX_IMAGE=ghcr.io/sidpalas/deputies-docker-sandbox:latest
DOCKER_SANDBOX_BRIDGE_HOST=127.0.0.1
DOCKER_ORCHESTRATOR_MODE=in-process
SANDBOX_SECRET_ENCRYPTION_KEY=<generated-secret>
```

For OpenAI instead of Anthropic:

```sh
RUNNER_MODEL_DEFAULT=openai/gpt-5.5
OPENAI_API_KEY=<secret>
ANTHROPIC_API_KEY=
```

## GitHub App Runtime Access

Real repository work requires a GitHub App so agent sandboxes can clone repositories and create branches, commits, and pull requests.

Create a GitHub App under your user or organization, install it on the repositories Deputies should access, generate a private key, then add:

```sh
GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY=<private-key>
GITHUB_ALLOWED_REPOSITORIES=owner/repo,owner/*
```

Use the narrowest `GITHUB_ALLOWED_REPOSITORIES` patterns you can. For local env files, store private keys as a single line with `\n` escapes.

## Run Locally

Start Postgres and SeaweedFS:

```sh
mise run //deploy/local:infra:up
```

Pull the Docker sandbox image once, or let Docker pull it on the first run:

```sh
docker pull ghcr.io/sidpalas/deputies-docker-sandbox:latest
```

Load env vars in any terminal that runs control-plane commands:

```sh
set -a; . ./.env.local; set +a
```

Run migrations:

```sh
mise run //apps/control-plane:db:migrate
```

Start the local HTTPS wildcard proxy and register the web alias:

```sh
mise run //deploy/local:portless:start
mise run //deploy/local:portless:alias:web
```

Portless binds port `443`, so approve the sudo prompt.

Terminal 1, start the control plane API and worker in `RUN_MODE=combined`:

```sh
set -a; . ./.env.local; set +a
mise run //apps/control-plane:dev
```

Terminal 2, start the web UI:

```sh
set -a; . ./.env.local; set +a
mise run //apps/web:dev
```

Open `https://deputies.localhost` and sign in with `dev` / `dev-secret`.

## Health Checks

```sh
curl http://localhost:3583/health
curl http://localhost:5173/health
curl https://deputies.localhost/health
```

Vite proxies browser-facing API routes to `VITE_API_PROXY_TARGET`, defaulting to `http://localhost:3583`.

When adding browser-facing API routes, keep these in sync:

- `apps/web/vite.config.ts`
- `apps/web/Caddyfile`
- `apps/web/Caddyfile.local`

## Optional Slack Integration

Use this only when testing Slack event delivery locally. Start a public HTTPS tunnel such as ngrok to your local web/proxy entrypoint, then set the Slack Events request URL to `https://<public-tunnel>/webhooks/slack/events`.

```sh
SLACK_API_BASE_URL=https://slack.com/api
SLACK_SIGNING_SECRET=<from-slack-app>
SLACK_BOT_TOKEN=xoxb-...
SLACK_ALLOWED_TEAM_IDS=T...
SLACK_ALLOWED_CHANNEL_IDS=C...
SLACK_ALLOWED_USER_IDS=U...
```

Slack fails closed when `SLACK_SIGNING_SECRET` is set. Configure at least one allowlist for local testing.

## Optional GitHub Webhooks

Use this only when testing GitHub issue, pull request, comment, or review triggers locally. Point the GitHub App webhook URL at `https://<public-tunnel>/webhooks/github/events`.

```sh
GITHUB_WEBHOOK_SECRET=<shared-secret>
GITHUB_WEBHOOK_ALLOWED_USERS=octocat
GITHUB_WEBHOOK_ALLOWED_ORGANIZATIONS=acme
GITHUB_WEBHOOK_TRIGGER_PHRASES=/deputies,deputies:
```

GitHub webhooks fail closed when `GITHUB_WEBHOOK_SECRET` is set. Configure at least one user/org allowlist and at least one trigger phrase.

## Common Commands

```sh
mise run //deploy/local:infra:up
mise run //deploy/local:infra:down
mise run //apps/control-plane:db:migrate
mise run //deploy/local:portless:start
mise run //deploy/local:portless:alias:web
mise run //apps/control-plane:dev
mise run //apps/web:dev
mise run //apps/control-plane:typecheck
mise run //apps/control-plane:test
mise run //apps/control-plane:test:integration
mise run //apps/web:typecheck
mise run //apps/web:test
mise run //deploy/docker-compose:smoke:full-stack
```

## Troubleshooting

### Docker Sandbox Fails With Missing Encryption Key

Set a stable key in `.env.local`:

```sh
SANDBOX_SECRET_ENCRYPTION_KEY=<generated-secret>
```

Do not rotate it casually; changing it prevents decrypting existing Docker sandbox secrets stored in Postgres.

### Session Cookies Do Not Stick

For the default Portless HTTPS setup, use:

```sh
AUTH_COOKIE_SECURE=true
WEB_BASE_URL=https://deputies.localhost
```

Clear browser cookies after changing cookie settings.

For a plain HTTP fallback, use:

```sh
AUTH_COOKIE_SECURE=false
WEB_BASE_URL=http://localhost:5173
```

### Integration Tests Collide

Do not run integration, UAT, and load tests against the same `TEST_DATABASE_URL` concurrently. They reset shared test tables.

## More Local Topics

- Deployment-style Docker Compose stacks: `deploy/docker-compose/README.md`.
- Sandbox image details: `deploy/sandboxes/README.md`.
- Slack and GitHub integration testing: `docs/integrations.md`.
- Testing strategy: `docs/testing-strategy.md`.
