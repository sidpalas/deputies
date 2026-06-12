# Deputies App Preview Inside A Sandbox

This runbook explains how to run a full inner Deputies app from this checkout inside an outer Deputies sandbox and expose only the inner web app through the outer service preview. It is written for the agent performing the setup inside the sandbox; the operator usually just asks for "a preview of this branch" and opens the resulting service link.

The workflow validates login, sessions, and the normal web/API path for UX changes. It intentionally does not support the inner instance's own service previews.

## Inner Web Routing

The outer instance must keep service-host routing enabled, usually with the default `SERVICE_HOST_REGEX=^s-`. The inner web process must disable its own service-host routing:

```sh
SERVICE_HOST_REGEX=^$
```

Disable with `^$`, never an empty string: an empty regex matches every host, which routes the entire app to the service proxy.

## Inner Cookie Names

Use distinct inner cookie names so the outer service proxy and sandbox bridge do not strip the inner app's auth cookies:

```sh
SESSION_COOKIE_NAME=inner_deputies_session
PREVIEW_COOKIE_NAME=inner_deputies_preview
```

## Start The Inner Control-Plane

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

## Start The Inner Web Server

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

## Publish The Service

Publish port `5173` as the browser-facing inner web service, for example `Inner Deputies Web`.

The final `WEB_BASE_URL` must exactly match the published browser origin, for example:

```sh
WEB_BASE_URL=https://s-5173-<outer-session-id>.deputies.localhost
```

Update and restart the inner control-plane whenever the published service host changes. Unsafe cookie-auth requests such as `POST /sessions` compare the browser `Origin` against `WEB_BASE_URL`; a stale or guessed value produces `403 Untrusted browser request`.

The agent running inside the sandbox may not automatically know the final preview URL. If the service tool returns a URL, use that origin. If it does not, get the exact service link from the outer UI or from the outer API's `GET /sessions/:sessionId/services?port=5173` response, then provide it back to the inner agent before the final control-plane restart.

## Validate

Validate the setup with a fresh browser profile or after clearing cookies for the service host:

- Opening the service URL shows the inner login page when no inner cookie exists.
- `dev` / `dev-secret` logs in and `/auth/me` returns the inner `dev` user.
- Refresh preserves the inner session through `inner_deputies_session`.
- Creating an inner session succeeds without read-only or CSRF errors.
- Inner service preview links are not expected to work in this setup.

See [Web UI](./web-ui.md) for how service previews and preview auth work in general.
