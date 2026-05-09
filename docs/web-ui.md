# Web UI

The operator UI is a separate Vite React app in `apps/web/`. It is intentionally independent from the Hono API process so it can be deployed later as static assets behind a CDN.

## Local Development

With the default `.env.example` settings, start Postgres, run migrations, then run the API and web app separately:

```sh
cp .env.example .env.local # if needed
pnpm db:up
set -a; . ./.env.local; set +a; pnpm api:db:migrate
set -a; . ./.env.local; set +a; pnpm api:dev
pnpm web:dev
```

For quick UI experiments that do not need durable state, you can instead run the API with `APP_STORE=memory`.

The web app uses same-origin API requests by default. In Vite dev mode, `apps/web/vite.config.ts` proxies `/health`, `/auth`, `/sessions`, `/events`, and `/webhooks` to the API at `VITE_API_PROXY_TARGET` or `http://localhost:3583`.

```sh
VITE_API_PROXY_TARGET=http://localhost:3583 pnpm web:dev
```

## Auth

The UI supports all product API auth modes exposed by `/health`:

- `none`: the UI calls the API without credentials.
- `bearer`: the user enters the API bearer token in the browser. The token is stored in `localStorage` and sent as `Authorization: Bearer <token>`.
- `session`: the user signs in through the configured provider. The API sets an opaque `dev_deputies_session` HTTP-only cookie backed by the configured `AppStore` (`auth_sessions` in Postgres for durable deployments), and the UI sends requests with `credentials: include`.

`API_AUTH_MODE` is required. Use `API_AUTH_MODE=none` only for intentional local or test no-auth runs; production-like deployments should use `bearer` or `session`.

Session-cookie auth is an API access gate only. Product sessions remain multiplayer/shared by default: authenticated users can list and open the same global session set, and sessions are not currently owned by or filtered to the authenticated user.

Local static session-auth example:

```sh
API_AUTH_MODE=session
AUTH_PROVIDER=static
AUTH_STATIC_USERNAME=dev
AUTH_STATIC_PASSWORD=dev-secret
AUTH_SESSION_SECRET=replace-with-random-local-secret
AUTH_COOKIE_SECURE=false
AUTH_COOKIE_SAME_SITE=lax
```

Local GitHub App session-auth example:

```sh
API_AUTH_MODE=session
AUTH_PROVIDER=github
AUTH_SESSION_SECRET=replace-with-random-local-secret
AUTH_COOKIE_SECURE=false
AUTH_SUCCESS_REDIRECT_URL=http://localhost:5173
WEB_BASE_URL=http://localhost:5173
GITHUB_APP_CLIENT_ID=Iv1.example
GITHUB_APP_CLIENT_SECRET=github-app-client-secret
GITHUB_APP_CALLBACK_URL=http://localhost:5173/auth/oauth/github/callback
AUTH_GITHUB_ALLOWED_USERS=your-github-login
```

For GitHub App login, configure the GitHub App's callback URL to exactly match `GITHUB_APP_CALLBACK_URL`. The same GitHub App can also provide runtime repository access through `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; those are separate values from the app's user-authorization client ID and client secret.

Set `WEB_BASE_URL` to the externally reachable web UI origin when Slack/GitHub callbacks should include an “open session” link. The API appends `?session=<id>` to that URL, and the web UI opens the matching session when present.

Set `AUTH_COOKIE_SECURE=true` only when the API is served over HTTPS. If it is enabled on plain `http://localhost`, the browser will not send the session cookie back.

The UI clears local auth state when the API returns `401`.

The SSE client uses `fetch()` streaming instead of native `EventSource` because native `EventSource` cannot send authorization headers. This also allows session-cookie mode to use `credentials: include`.

## Current Scope

- List and create sessions.
- List session messages.
- Enqueue follow-up messages.
- Batch queued follow-up messages visually with one deputy response.
- Edit or cancel pending queued messages.
- Request cancellation of an active run.
- Archive and restore sessions. Archived sessions are read-only until restored.
- Replay and stream session events internally, rendering assistant text in the transcript and non-text run/message events as collapsible diagnostics.
- List session artifacts.
- Show HTTP, Slack, and GitHub completion callback delivery status in the context panel and manually replay failed callbacks.

## Deployment

The web app builds to static assets:

```sh
pnpm web:build
```

For production-like deployments, serve `apps/web/dist` behind a reverse proxy that forwards API routes to the API service. Leave `VITE_API_BASE_URL` empty for same-origin requests. If the web assets are deployed without a proxy, set `VITE_API_BASE_URL` to the public API origin at build time and set the API service's `WEB_BASE_URL` to the deployed web UI URL so the API allows that origin for credentialed CORS requests and uses it for integration session links. Do not bake bearer tokens, static passwords, or session secrets into the web build.
