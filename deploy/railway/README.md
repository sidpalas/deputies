# Railway Deployment

Deploy Deputies on Railway with the public template:

```txt
https://railway.com/deploy/deputies-monolith
```

The template provisions a simple production-style stack:

- A monolithic Deputies service with API and worker in one process.
- Railway Postgres for durable product and runner state.
- Railway object storage bucket for artifact blobs.
- Fake runner and fake sandbox defaults so the app can boot without model or sandbox credentials.

The default template is intended to make the UI, auth, database, setup checks, and artifact plumbing deployable immediately. It will not run real agent work until you configure a real runner, model credentials, and sandbox provider.

The template uses static session auth by default. Railway auto-generates the static password as a service variable; retrieve it from the Railway service Variables tab and use it with the configured static username to log in.

## Default Shape

The template should be treated as equivalent to:

```sh
RUN_MODE=combined
APP_DATA_STORE=postgres
RUNNER_STATE_STORE=postgres
RUNNER=fake
SANDBOX_PROVIDER=fake
ARTIFACT_STORAGE_PROVIDER=s3
```

Railway provides service variables for Postgres and object storage connection details. Keep generated secrets in Railway variables, not in source control.

## Configure Real Agent Work

To run real agent work, set:

```sh
RUNNER=pi
RUNNER_MODEL_DEFAULT=<provider/model>
```

`RUNNER=flue` is deprecated and kept only for existing legacy deployments while the Flue runner is removed.

Then configure one of the supported model auth paths:

```sh
ANTHROPIC_API_KEY=<secret>
OPENAI_API_KEY=<secret>
OPENCODE_API_KEY=<secret>
```

For OpenAI Codex subscription auth, prefer a Railway variable containing base64-encoded auth JSON:

```sh
OPENAI_CODEX_AUTH_BASE64=<base64-auth-json>
```

## Configure A Real Sandbox Provider

The template starts with fake sandboxes. For real agent work, configure a sandbox provider.

Daytona example:

```sh
SANDBOX_PROVIDER=daytona
DAYTONA_API_KEY=<secret>
DAYTONA_API_URL=<optional>
DAYTONA_TARGET=<optional>
DAYTONA_IMAGE=ghcr.io/<owner>/deputies-daytona-sandbox:<tag>
DAYTONA_SNAPSHOT=<optional>
```

Docker sandboxes are usually not appropriate inside a generic Railway service unless you have a separate Docker orchestration target. If you do use Docker sandboxes with Postgres-backed state, keep this stable:

```sh
SANDBOX_SECRET_ENCRYPTION_KEY=<stable-high-entropy-secret>
```

Generate it once with:

```sh
openssl rand -base64 32
```

## Configure Browser Auth And Domains

Browser-facing deployments use session auth:

```sh
API_AUTH_MODE=session
AUTH_PROVIDER=static # or github
AUTH_SESSION_SECRET=<high-entropy-secret>
AUTH_COOKIE_SECURE=true
WEB_BASE_URL=https://<your-app-domain>
```

Static auth:

```sh
AUTH_STATIC_USERNAME=<admin-username>
AUTH_STATIC_PASSWORD=<strong-password>
```

In the default Railway template, `AUTH_STATIC_PASSWORD` is auto-generated. Find it in the deployed service's Variables tab.

GitHub auth:

```sh
AUTH_PROVIDER=github
GITHUB_OAUTH_CLIENT_ID=<github-app-client-id>
GITHUB_OAUTH_CLIENT_SECRET=<github-app-client-secret>
GITHUB_OAUTH_CALLBACK_URL=https://<your-app-domain>/auth/oauth/github/callback
AUTH_GITHUB_ADMIN_USERS=<github-login>
AUTH_GITHUB_ALLOWED_ORGANIZATIONS=<github-org>
AUTH_GITHUB_DEFAULT_GROUP_ROLE=member
```

For sandbox service previews, configure an app domain and wildcard service domain that both point to the Railway web entrypoint:

```sh
WEB_BASE_URL=https://app.example.com
SERVICE_BASE_DOMAIN=example.com
AUTH_COOKIE_SECURE=true
SERVICE_TRUST_FORWARDED_HOSTS=false
```

Add both `app.example.com` and `*.example.com` as Railway custom domains. If using Cloudflare DNS, keep Railway `_acme-challenge` records DNS-only so certificate issuance can complete.

## Configure Integrations

Remote MCP / Executor:

```sh
MCP_SERVERS='[{"name":"executor","url":"https://<executor-host>/mcp","headers":{"Authorization":"Bearer <executor-api-key>"},"transport":"streamable-http","allowedTools":["execute","skills","resume"]}]'
MCP_CONNECT_TIMEOUT_MS=10000
MCP_TOOL_TIMEOUT_MS=60000
MCP_TOOL_RESULT_MAX_CHARS=100000
MCP_RESPONSE_MAX_BYTES=5242880
```

Keep the Executor API key in Railway service variables. Deputies attaches the header from the control-plane worker process; it is not copied into sandbox environment variables.
`MCP_TOOL_TIMEOUT_MS` and `MCP_TOOL_RESULT_MAX_CHARS` are enforced by the Pi/shared MCP client; the deprecated Flue native MCP adapter ignores those two knobs.

GitHub runtime repository access:

```sh
GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY=<private-key>
GITHUB_ALLOWED_REPOSITORIES=owner/repo,owner/*
```

GitHub webhooks:

```sh
GITHUB_WEBHOOK_SECRET=<shared-secret>
GITHUB_WEBHOOK_TRIGGER_PHRASES=/deputies,deputies:
GITHUB_WEBHOOK_ALLOWED_USERS=<github-login>
# or
GITHUB_WEBHOOK_ALLOWED_ORGANIZATIONS=<github-org>
```

Webhook URL:

```txt
https://<your-app-domain>/webhooks/github/events
```

Slack:

```sh
SLACK_API_BASE_URL=https://slack.com/api
SLACK_SIGNING_SECRET=<from Slack app>
SLACK_BOT_TOKEN=xoxb-...
SLACK_ALLOWED_TEAM_IDS=T...
SLACK_ALLOWED_CHANNEL_IDS=C...
SLACK_ALLOWED_USER_IDS=U...
```

Slack Events request URL:

```txt
https://<your-app-domain>/webhooks/slack/events
```

## Verify The Deployment

After deploying and setting variables:

1. Open the web UI at `WEB_BASE_URL`.
2. Check `GET /health`.
3. Open the setup checklist or call `GET /setup/status`.
4. Confirm Postgres migrations are applied.
5. Confirm model provider credentials are detected when `RUNNER=pi`.
6. Create a test session and run one fake or real task.
7. If enabled, verify artifact download/preview, service preview links, GitHub webhook delivery, and Slack URL verification.

For the full provider-agnostic deployment reference, see `../../docs/deployment.md`.
