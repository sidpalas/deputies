# Web UI

The operator UI is a separate Vite React app in `apps/web/`. It is intentionally independent from the Hono API process so it can be deployed later as static assets behind a CDN.

## Local Development

With the default `.env.example` settings, start Postgres, run migrations, then run the API and web app separately:

```sh
cp .env.example .env.local # if needed
pnpm db:up
set -a; . ./.env.local; set +a; pnpm control-plane:db:migrate
set -a; . ./.env.local; set +a; pnpm control-plane:dev
pnpm web:dev
```

For quick UI experiments that do not need durable state, you can instead run the API with `APP_STORE=memory`.

The web app uses same-origin API requests by default. In Vite dev mode, `apps/web/vite.config.ts` proxies `/health`, `/auth`, `/sessions`, `/events`, and `/webhooks` to the API at `VITE_API_PROXY_TARGET` or `http://localhost:3583`.

```sh
VITE_API_PROXY_TARGET=http://localhost:3583 pnpm web:dev
```

### Local Sandbox Previews

Use a host-preserving wildcard proxy when developing session-cookie auth and sandbox previews locally. `portless --no-tls` is the simplest local-only option. Published previews use one-label wildcard subdomains such as `http://p-3000-<session-id>.deputies.localhost`.

Use `--no-tls` for local previews because the default HTTPS portless proxy can strip the original wildcard host before requests reach the Docker Compose web proxy. The preview router needs that host, for example `p-3000-<session-id>.deputies.localhost`, to identify the session and sandbox port.

Start the HTTP wildcard proxy in one terminal. Portless uses port `80` for `--no-tls`, so accept the sudo prompt when it starts:

```sh
pnpm portless:start:http
# or: mise run portless-start-http
```

Register the web UI alias once, or after resetting portless aliases:

```sh
pnpm portless:alias:web
# or: mise run portless-alias-web
```

Run the API and web dev server as usual:

```sh
set -a; . ./.env.local; set +a; pnpm control-plane:dev
pnpm web:dev
```

Open the app at `http://deputies.localhost`. Published previews are listed from `GET /sessions/:sessionId/previews`; no preview is shown until the agent publishes one with the preview tool.

For portless local development, use these `.env.local` values:

```sh
VITE_API_BASE_URL=
WEB_BASE_URL=http://deputies.localhost
AUTH_SUCCESS_REDIRECT_URL=http://deputies.localhost
AUTH_COOKIE_DOMAIN=.deputies.localhost
AUTH_COOKIE_SECURE=false
PREVIEW_BASE_DOMAIN=deputies.localhost
PREVIEW_TRUST_FORWARDED_HOSTS=true
```

`portless proxy start --no-tls --wildcard` preserves wildcard preview hosts into the web proxy, including `Host` and `X-Forwarded-Host` values like `p-test.deputies.localhost`.

Preview links are browser navigations. They work with `API_AUTH_MODE=none` or session-cookie auth. They do not work with bearer-token-only auth because the browser cannot attach the UI's localStorage bearer token to a new tab.

For production-like deployments, configure real DNS records so the app hostname and wildcard preview hostname point to the deployed web/API entrypoint. Prefer a first-level wildcard such as `*.example.com`; nested wildcards like `*.app.example.com` may require provider-specific certificate upgrades such as Cloudflare Advanced Certificate Manager. For example, use `app.example.com` for the UI and `p-<session>.example.com` for previews, then set:

```sh
VITE_API_BASE_URL=
WEB_BASE_URL=https://app.example.com
AUTH_SUCCESS_REDIRECT_URL=https://app.example.com
AUTH_COOKIE_DOMAIN=.example.com
AUTH_COOKIE_SECURE=true
PREVIEW_BASE_DOMAIN=example.com
PREVIEW_TRUST_FORWARDED_HOSTS=false
```

On Railway with Cloudflare DNS, add both custom domains to the web entrypoint service: `app.example.com` and `*.example.com`. The wildcard CNAME should point directly to Railway's provided target, and Railway's `_acme-challenge` CNAME must remain DNS-only so certificate issuance and renewal can complete. If a wildcard preview host returns a TLS handshake error before any HTTP status, Railway has not finished validating or serving the wildcard certificate yet.

After changing `AUTH_COOKIE_DOMAIN`, existing browser sessions may still hold an old host-only cookie for the app domain. Log out and back in, or clear cookies for the app and preview domains. A valid production session cookie should be scoped to `.example.com` so it is sent to both `app.example.com` and `p-<session>.example.com`.

The Deputies web dev server moves its own Vite HMR socket to `/__deputies_vite_hmr` so preview app WebSocket upgrades on `/` can pass through the preview proxy. For Vite apps running inside a sandbox, avoid hard-coding `server.hmr.host`, `server.hmr.clientPort`, or `server.hmr.protocol` to `localhost`; let Vite infer the preview browser URL.

If you keep using plain Vite without a wildcard proxy, keep `AUTH_COOKIE_SECURE=false` and use an HTTP `WEB_BASE_URL`/`AUTH_SUCCESS_REDIRECT_URL` instead.

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
- List session artifacts in the context panel.
- Render run-created image and text artifacts inline with the relevant transcript group when they are safe to preview.
- Open stored image artifacts through authenticated download URLs, skip automatic loading for large images, and lazy-load text previews from the artifact preview API.
- Download stored artifacts and open external-link artifacts.
- Show HTTP, Slack, and GitHub completion callback delivery status in the context panel and manually replay failed callbacks.

## Artifacts

The UI reads artifact metadata from `GET /sessions/:sessionId/artifacts`. Stored artifacts use API URLs rather than bucket URLs:

- `GET /sessions/:sessionId/artifacts/:artifactId/download` returns the stored object with `content-type`, `content-length`, and `content-disposition` headers.
- `GET /sessions/:sessionId/artifacts/:artifactId/preview` returns capped text preview data for supported text-like artifacts.

Inline artifact rendering is intentionally conservative:

- Browser-safe image artifacts are shown inline only when `payload.sizeBytes` is present and below the current autoload threshold.
- Large or unknown-size images show an “Open image” action instead of loading automatically.
- Text-like artifacts load previews only after the user opens the preview control; truncated previews show a `Preview truncated.` note.
- External-link artifacts keep using their `url` and do not require object storage.

## Deployment

The web app builds to static assets:

```sh
pnpm web:build
```

For production-like deployments, serve `apps/web/dist` behind a reverse proxy that forwards API routes to the control-plane service. Leave `VITE_API_BASE_URL` empty for same-origin requests. If the web assets are deployed without a proxy, set `VITE_API_BASE_URL` to the public API origin at build time and set the control-plane service's `WEB_BASE_URL` to the deployed web UI URL so the API allows that origin for credentialed CORS requests and uses it for integration session links. Do not bake bearer tokens, static passwords, or session secrets into the web build.
