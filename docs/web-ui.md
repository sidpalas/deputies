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

The web app uses same-origin API requests by default. In Vite dev mode, `apps/web/vite.config.ts` proxies `/health`, `/auth`, `/sessions`, `/skills`, `/events`, `/repositories`, `/models`, and `/webhooks` to the API at `VITE_API_PROXY_TARGET` or `http://localhost:3583`.

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

You can run a full inner Deputies app inside an outer Deputies sandbox and expose the inner web app through the outer service preview, e.g. for dogfooding UX changes from a branch. The setup runbook is written for the agent performing the setup inside the sandbox; see [Deputies App Preview](./deputies-app-preview.md).

## Auth

The UI supports all product API auth modes exposed by `/health`:

- `none`: the UI calls the API without credentials.
- `bearer`: the user enters the API bearer token in the browser. The token is stored in `localStorage` and sent as `Authorization: Bearer <token>`.
- `session`: the user signs in through the configured provider. The API sets an opaque `dev_deputies_session` HTTP-only cookie backed by the configured app data store (`auth_sessions` in Postgres for durable deployments), and the UI sends requests with `credentials: include`.

`API_AUTH_MODE` is required. Browser-facing deployments use `session`. Reserve `bearer` for development tooling or programmatic/internal API access, and use `none` only for intentional local or test no-auth runs.

Session-cookie auth enables tenant-wide role checks for browser-facing product routes. Viewers can read all resources, members manage ordinary resources, and admins additionally manage users and setup configuration. See [Tenant Access](./tenant-access.md).

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
# AUTH_GITHUB_DEFAULT_ROLE=member
```

For GitHub App login, configure the GitHub App's callback URL to exactly match `GITHUB_OAUTH_CALLBACK_URL`. The same GitHub App can also provide runtime repository access through `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; those are separate values from the app's user-authorization client ID and client secret.

New GitHub users in `AUTH_GITHUB_ADMIN_USERS` start as admins. Users or organizations in `AUTH_GITHUB_ALLOWED_*` can sign in with `AUTH_GITHUB_DEFAULT_ROLE`; later admin-managed role changes are retained.

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
- Manage tenant users and roles as an admin; the final admin cannot be demoted or removed.
- Manage environments and inspect immutable repository-configuration revisions.
- Manage tenant-wide skills as a member or admin, or private personal skills as their owner, including immutable definition revisions and archive/restore actions.
- Attach available skills to a message as structured invocation chips and inspect the skills loaded for each run.
- Replay and stream session events internally, rendering assistant text in the transcript and non-text run/message events as collapsible diagnostics.
- List session artifacts in the context panel.
- Render run-created image and text artifacts inline with the relevant transcript group when they are safe to preview.
- Open stored image artifacts through authenticated download URLs, skip automatic loading for large images, and lazy-load text previews from the artifact preview API.
- Download stored artifacts and open external-link artifacts.
- Show HTTP, Slack, and GitHub completion callback delivery status in the context panel and manually replay failed callbacks.

## Environments

Open `Environments` to manage reusable multi-repository codebases. Existing environments show a compact revision selector at the top of the editor. The selector is newest-first, marks the current and historical entries, and uses the bounded searchable picker for long histories. Selecting a historical revision changes only the displayed repository configuration: name, owner, sharing, and lifecycle remain visibly current. The whole editor becomes read-only and a warning describes that boundary until the current revision is selected again.

Environment deep links use `?environment=<environment-id>&revision=<revision-id>`. The revision is part of application navigation state, so initial loads and browser Back/Forward restore it. Changing revisions or environments uses the same unsaved-change guard as other editor navigation, and selecting another environment clears the prior revision selection. An unavailable revision falls back visibly to the current repository configuration.

## Skills

Open `Skills` from the main navigation to manage tenant-wide or private personal reusable agent instructions.

The editor supports tenant and personal scope, a slug name, one-line description, markdown body, enabled and auto-load toggles, and archive/restore actions. Personal skills are visible only to their owner, cannot auto-load, and are only manually invokable. Creation publishes revision 1. Saving a real name/description/body change publishes the next immutable revision; unchanged saves and live setting/lifecycle changes do not. Users can inspect and manage their own personal skills; all roles can inspect tenant-skill revision history, while members and admins can edit tenant skills.

## Prompt snippets

Use `/` in a composer to search available tenant, personal, and repository skills and `//` to search your active personal prompt snippets. Selecting a snippet replaces only that token with editable body text; only expanded text is submitted, with no snippet identity or back-reference. Snippet expansion is web-only. Every user can create, edit, archive, and restore only their own snippets; archived snippets remain readable to their owner but are excluded from composers.

The message composer loads tenant skills, the current user's personal skills, and discovered repository skills available to the session. Skill invocation is slash-only: type a standalone `/query` at the start of the prompt or after whitespace to filter by name and attach up to eight skills. Each selection becomes a removable chip; sending stores readable names in `context.skills` and aligned identity hints in `context.skillRefs`. The server authorizes and pins a managed selection to current at enqueue; a stale/historical client pin is rejected. Repository selections remain revisionless.

A message may contain text plus skills or skills alone. Skill-only messages render their chips with “No additional instructions”; the runner expands each request-local skill body into Pi's native skill representation before the model call. Multiple skills apply to the same request in chip order.

Before a new thread has a session, the UI calls `GET /skills/invocation-candidates` to list managed tenant skills and the current user's personal skills without a sandbox. For an existing session it calls `GET /sessions/:sessionId/skills`; repository skills become browseable after a run records them in `skills_loaded`. Skill loading metadata, revisions, shadowing, diagnostics, explicit selections, and successful model reads appear in the run's collapsed Activity section.

When `SKILLS_ENABLED=false`, the skills routes return `404` and the UI hides the skills administration and composer surfaces. `REPO_SKILLS_ENABLED=false` leaves managed skills and their UI available but removes repository-discovered skills.

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
