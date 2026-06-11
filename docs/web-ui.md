# Web UI

The operator UI is a separate Vite React app in `apps/web/`. It is intentionally independent from the Hono API process so it can be deployed later as static assets behind a CDN.

## Local Development

With the default `.env.example` settings, start Postgres plus SeaweedFS, run migrations, then run the API and web app separately:

```sh
cp .env.example .env.local # if needed
mise run //deploy/local:infra:up
set -a; . ./.env.local; set +a; mise run //apps/control-plane:db:migrate
set -a; . ./.env.local; set +a; mise run //apps/control-plane:dev
mise run //apps/web:dev
```

For quick UI experiments that do not need durable state, you can instead run the API with `APP_DATA_STORE=memory`.

The web app uses same-origin API requests by default. In Vite dev mode, `apps/web/vite.config.ts` proxies `/health`, `/auth`, `/sessions`, `/events`, `/repositories`, `/models`, and `/webhooks` to the API at `VITE_API_PROXY_TARGET` or `http://localhost:3583`.

```sh
VITE_API_PROXY_TARGET=http://localhost:3583 mise run //apps/web:dev
```

### Local Sandbox Services

Use a host-preserving wildcard proxy when developing session-cookie auth and sandbox services locally. Published services, including app previews, use one-label wildcard subdomains such as `https://s-3000-<session-id>.deputies.localhost`.

Portless TLS terminates HTTPS locally. In Docker Compose, `apps/web/Caddyfile.local` handles the forwarded service host that Portless preserves in `X-Forwarded-Host`. In Vite dev mode, `apps/web/vite.config.ts` uses the same forwarded-host fallback.

Start the HTTPS wildcard proxy in one terminal. Portless uses port `443`, so accept the sudo prompt when it starts:

```sh
mise run //deploy/local:portless:start
# or: mise run //deploy/local:portless:start
```

Register the web UI alias once, or after resetting portless aliases:

```sh
mise run //deploy/local:portless:alias:web
# or: mise run //deploy/local:portless:alias:web
```

Run the API and web dev server as usual:

```sh
set -a; . ./.env.local; set +a; mise run //apps/control-plane:dev
mise run //apps/web:dev
```

Open the app at `https://deputies.localhost`. Published services are listed from `GET /sessions/:sessionId/services`; no service is shown until the agent publishes one with the service tool. Service previews use wildcard hosts such as `s-<port>-<session>.deputies.localhost`, not path-based proxy URLs.

For portless local development, use these `.env.local` values:

```sh
VITE_API_BASE_URL=
WEB_BASE_URL=https://deputies.localhost
AUTH_COOKIE_SECURE=true
SERVICE_BASE_DOMAIN=deputies.localhost
SERVICE_TRUST_FORWARDED_HOSTS=true
```

Service links are browser navigations to wildcard service hosts. They work with `API_AUTH_MODE=none` or session-cookie auth. They do not work with bearer-token-only auth because the browser cannot attach the UI's localStorage bearer token to a new tab.

For production-like deployments, configure real DNS records so the app hostname and wildcard service hostname point to the deployed web/API entrypoint. Prefer a first-level wildcard such as `*.example.com`; nested wildcards like `*.app.example.com` may require provider-specific certificate upgrades such as Cloudflare Advanced Certificate Manager. For example, use `app.example.com` for the UI and `s-<port>-<session>.example.com` for services, then set:

```sh
VITE_API_BASE_URL=
WEB_BASE_URL=https://app.example.com
AUTH_COOKIE_SECURE=true
SERVICE_BASE_DOMAIN=example.com
SERVICE_TRUST_FORWARDED_HOSTS=false
```

On Railway with Cloudflare DNS, add both custom domains to the web entrypoint service: `app.example.com` and `*.example.com`. The wildcard CNAME should point directly to Railway's provided target, and Railway's `_acme-challenge` CNAME must remain DNS-only so certificate issuance and renewal can complete. If a wildcard service host returns a TLS handshake error before any HTTP status, Railway has not finished validating or serving the wildcard certificate yet.

Main app session cookies are host-only. Authenticated service links include a short-lived signed preview token that sets a preview-only cookie on the service host before redirecting to the service path.

### Preview Auth

In `API_AUTH_MODE=session`, service previews do not use the main `dev_deputies_session` cookie. When the UI lists or opens a service for an admin, the API returns a service URL on the preview host that first visits the preview auth trampoline:

```txt
https://s-3000-<session-id>.example.com/__preview_auth?token=<signed-bootstrap-token>&redirect=/
```

The service-host middleware handles `/__preview_auth`, validates the signed bootstrap token, sets a host-only `deputies_preview` HTTP-only cookie, and redirects to `redirect`. The bootstrap token is valid for 2 minutes and is scoped to the authenticated app session, user, product session, and service port.

The preview cookie is signed and scoped to the specific preview host. It has a 30-minute sliding idle expiry and a 2-hour absolute grant cap. Authorized HTTP preview requests renew the cookie after half of the idle window has elapsed, but WebSocket upgrades only validate the cookie at handshake time and do not renew mid-connection.

Preview auth responses include `Referrer-Policy: no-referrer`, and the service proxy strips `Referer`, `Cookie`, and `Authorization` before forwarding requests to the sandbox service. Unsafe HTTP methods and WebSocket upgrades are rejected when browser `Sec-Fetch-Site` or `Origin` headers indicate a cross-site request.

The Deputies web dev server moves its own Vite HMR socket to `/__deputies_vite_hmr` so sandbox service WebSocket upgrades on `/` can pass through the service proxy. For Vite apps running inside a sandbox, avoid hard-coding `server.hmr.host`, `server.hmr.clientPort`, or `server.hmr.protocol` to `localhost`; let Vite infer the browser URL.

If you keep using plain Vite without a wildcard proxy, keep `AUTH_COOKIE_SECURE=false` and use an HTTP `WEB_BASE_URL` instead.

### Deputies App Preview Inside A Sandbox

For dogfooding UX changes, you can run a full inner Deputies app inside an outer Deputies sandbox and expose only the inner web app through the outer service preview. This workflow validates login, sessions, and the normal web/API path. It intentionally does not support the inner instance's own service previews.

The outer instance must keep service-host routing enabled, usually with the default `SERVICE_HOST_REGEX=^s-`. The inner web process must disable its own service-host routing:

```sh
SERVICE_HOST_REGEX=^$
```

Use distinct inner cookie names so the outer service proxy and sandbox bridge do not strip the inner app's auth cookies:

```sh
SESSION_COOKIE_NAME=inner_deputies_session
PREVIEW_COOKIE_NAME=inner_deputies_preview
```

Start the inner control-plane on port `3583`. Use memory stores for temporary validation unless you specifically need Postgres-backed state:

```sh
AUTH_SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

WEB_BASE_URL=<EXPOSED_SERVICE_ORIGIN> \
API_AUTH_MODE=session \
AUTH_PROVIDER=static \
AUTH_STATIC_USERNAME=dev \
AUTH_STATIC_PASSWORD=dev-secret \
AUTH_SESSION_SECRET="$AUTH_SESSION_SECRET" \
AUTH_COOKIE_SECURE=true \
AUTH_COOKIE_SAME_SITE=lax \
SESSION_COOKIE_NAME=inner_deputies_session \
PREVIEW_COOKIE_NAME=inner_deputies_preview \
PORT=3583 \
RUNNER_STATE_STORE=memory \
APP_DATA_STORE=memory \
pnpm --dir apps/control-plane exec tsx src/index.ts
```

Start the inner Vite web server on a private port and point it at the inner API:

```sh
SERVICE_HOST_REGEX='^$' \
VITE_API_PROXY_TARGET='http://127.0.0.1:3583' \
pnpm --dir apps/web exec vite --host 0.0.0.0 --port 5174
```

If Vite rejects the browser's outer service host, place a host-rewrite proxy in front of Vite and publish the proxy port instead:

```sh
PROXY_PORT=5173 TARGET_PORT=5174 node /tmp/inner-web-proxy.mjs
```

For a built web app served by Caddy instead of Vite, use the same inner control-plane settings, set `SERVICE_HOST_REGEX=^$`, and point Caddy at the inner API with `API_UPSTREAM=http://127.0.0.1:3583`. Caddy does not normally need the Vite host-rewrite proxy; publish the Caddy port directly unless another proxy in front of it enforces host allowlists.

Publish port `5173` as the browser-facing inner web service, for example `Inner Deputies Web`.

The final `WEB_BASE_URL` must exactly match the published browser origin, for example:

```sh
WEB_BASE_URL=https://s-5173-<outer-session-id>.deputies.localhost
```

Update and restart the inner control-plane whenever the published service host changes. Unsafe cookie-auth requests such as `POST /sessions` compare the browser `Origin` against `WEB_BASE_URL`; a stale or guessed value produces `403 Untrusted browser request`.

The agent running inside the sandbox may not automatically know the final preview URL. If the service tool returns a URL, use that origin. If it does not, get the exact service link from the outer UI or from the outer API's `GET /sessions/:sessionId/services?port=5173` response, then provide it back to the inner agent before the final control-plane restart.

Validate the setup with a fresh browser profile or after clearing cookies for the service host:

- Opening the service URL shows the inner login page when no inner cookie exists.
- `dev` / `dev-secret` logs in and `/auth/me` returns the inner `dev` user.
- Refresh preserves the inner session through `inner_deputies_session`.
- Creating an inner session succeeds without read-only or CSRF errors.
- Inner service preview links are not expected to work in this setup.

## Auth

The UI supports all product API auth modes exposed by `/health`:

- `none`: the UI calls the API without credentials.
- `bearer`: the user enters the API bearer token in the browser. The token is stored in `localStorage` and sent as `Authorization: Bearer <token>`.
- `session`: the user signs in through the configured provider. The API sets an opaque `dev_deputies_session` HTTP-only cookie backed by the configured app data store (`auth_sessions` in Postgres for durable deployments), and the UI sends requests with `credentials: include`.

`API_AUTH_MODE` is required. Browser-facing deployments use `session`. Reserve `bearer` for development tooling or programmatic/internal API access, and use `none` only for intentional local or test no-auth runs.

Session-cookie auth enables access-group RBAC for browser-facing product routes. Sessions belong to one access group and use group/organization visibility plus group-members/creator-only write policies. See [Access Groups](./access-groups.md) for roles, defaults, archived-group behavior, and GitHub auth allowlists.

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
WEB_BASE_URL=http://localhost:5173
GITHUB_OAUTH_CLIENT_ID=Iv1.example
GITHUB_OAUTH_CLIENT_SECRET=github-app-client-secret
GITHUB_OAUTH_CALLBACK_URL=http://localhost:5173/auth/oauth/github/callback
AUTH_GITHUB_ADMIN_USERS=your-github-login
# Optional non-admin sign-in allowlist:
# AUTH_GITHUB_ALLOWED_USERS=teammate-login
# AUTH_GITHUB_ALLOWED_ORGANIZATIONS=your-org
# AUTH_GITHUB_DEFAULT_GROUP_ROLE=member
```

For GitHub App login, configure the GitHub App's callback URL to exactly match `GITHUB_OAUTH_CALLBACK_URL`. The same GitHub App can also provide runtime repository access through `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; those are separate values from the app's user-authorization client ID and client secret.

GitHub users in `AUTH_GITHUB_ADMIN_USERS` are super admins and are restored to that role on login. Users or organizations in `AUTH_GITHUB_ALLOWED_*` can sign in as regular users and receive default-group access from `AUTH_GITHUB_DEFAULT_GROUP_ROLE`.

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
- Manage access groups, group members, group defaults, archived groups, and super admins when the signed-in user has sufficient access.
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
mise run //apps/web:build
```

For production-like deployments, serve `apps/web/dist` behind a reverse proxy that forwards API routes to the control-plane service. Leave `VITE_API_BASE_URL` empty for same-origin requests. If the web assets are deployed without a proxy, set `VITE_API_BASE_URL` to the public API origin at build time and set the control-plane service's `WEB_BASE_URL` to the deployed web UI URL so the API allows that origin for credentialed CORS requests and uses it for integration session links. Do not bake bearer tokens, static passwords, or session secrets into the web build.
