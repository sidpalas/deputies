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

## Start The Inner Web Server

Prefer serving the built web app. The Vite dev server keeps a long-running esbuild transform service that is often OOM-killed under sandbox memory pressure, after which every page load fails with `The service is no longer running`. `vite preview` serves the built assets with the same API proxy and allowed-host config and has no such service:

```sh
pnpm --dir apps/web exec vite build

SERVICE_HOST_REGEX='^$' \
VITE_API_PROXY_TARGET='http://127.0.0.1:3583' \
VITE_DEV_ALLOWED_HOSTS='.<outer-service-domain>' \
pnpm --dir apps/web exec vite preview --host 0.0.0.0 --port 5173
```

Set `VITE_DEV_ALLOWED_HOSTS` to the outer instance's service domain suffix (for example `.example.com`) or the exact published service host so Vite accepts the browser's host directly; the default already covers `.localhost`. If you do not know the domain before publishing, publish the port first, read the service host from the link, then start or restart the web server with it. The web server can start before the inner control-plane is running; API requests fail until the control-plane is up.

For HMR while iterating on UI code, run the dev server instead with the same environment:

```sh
SERVICE_HOST_REGEX='^$' \
VITE_API_PROXY_TARGET='http://127.0.0.1:3583' \
VITE_DEV_ALLOWED_HOSTS='.<outer-service-domain>' \
pnpm --dir apps/web exec vite --host 0.0.0.0 --port 5173
```

If you cannot configure allowed hosts, run the web server on a private port (for example `5174`) and place a host-rewrite proxy in front of it on the published port. The proxy must rewrite only the request `Host` header sent to Vite. Do not rewrite browser `Origin` or `Referer` headers; the inner control-plane compares unsafe request origins to the public `WEB_BASE_URL`. This minimal proxy does not forward WebSocket upgrades, so dev-server HMR will not connect through it.

```js
// /tmp/inner-web-proxy.mjs
import http from 'node:http';

const proxyPort = Number(process.env.PROXY_PORT ?? 5173);
const targetPort = Number(process.env.TARGET_PORT ?? 5174);
const targetHost = '127.0.0.1';

http
  .createServer((req, res) => {
    const headers = { ...req.headers, host: `${targetHost}:${targetPort}` };
    const upstream = http.request(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Proxy error: ${error.message}`);
    });
    req.pipe(upstream);
  })
  .listen(proxyPort, '0.0.0.0');
```

```sh
PROXY_PORT=5173 TARGET_PORT=5174 node /tmp/inner-web-proxy.mjs
```

For a built web app served by Caddy instead of Vite, use the same inner control-plane settings, set `SERVICE_HOST_REGEX=^$`, and point Caddy at the inner API with `API_UPSTREAM=http://127.0.0.1:3583`. Caddy does not normally need the Vite host-rewrite proxy; publish the Caddy port directly unless another proxy in front of it enforces host allowlists.

## Publish The Service

Publish the port serving the browser-facing inner web app, for example as `Inner Deputies Web`. That is `5173` in the commands above, or the host-rewrite proxy's port when you use one.

The final `WEB_BASE_URL` must exactly match the published browser origin, for example:

```sh
WEB_BASE_URL=https://s-5173-<outer-session-id>.deputies.localhost
```

Update and restart the inner control-plane whenever the published service host changes. Unsafe cookie-auth requests such as `POST /sessions` compare the browser `Origin` against `WEB_BASE_URL`; a stale or guessed value produces `403 Untrusted browser request`.

The agent running inside the sandbox may not automatically know the final preview URL. If the service tool returns a URL, use that origin. If it does not, get the exact service link from the outer UI or from the outer API's `GET /sessions/:sessionId/services?port=<published-port>` response, then provide it back to the inner agent before the final control-plane restart.

## Start The Inner Control-Plane

Start the inner control-plane on port `3583` after you know the exact service origin. Use memory stores for temporary validation unless you specifically need Postgres-backed state:

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

Do not use `WEB_BASE_URL=http://localhost:5173` for a browser-facing service preview. If you started the control-plane before publishing, restart it with the final `https://s-5173-...` origin before validating login or session creation.

Startup under `tsx` in a sandbox can take more than a minute. Poll for readiness instead of assuming failure after a short sleep:

```sh
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:3583/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:3583/health
```

## Validate

Do not report the preview as ready until these checks pass from inside the sandbox:

- `curl -fsS http://127.0.0.1:3583/health` succeeds.
- `curl -fsS http://127.0.0.1:5173/auth/config` succeeds through the web server (adjust the port if you published a different one).
- The running control-plane was started with `WEB_BASE_URL` equal to the published service origin, not a localhost URL.

Then validate in a browser with a fresh profile or after clearing cookies for the service host:

- Opening the service URL shows the inner login page when no inner cookie exists.
- `dev` / `dev-secret` logs in and `/auth/me` returns the inner `dev` user.
- Refresh preserves the inner session through `inner_deputies_session`.
- Creating an inner session succeeds without read-only or CSRF errors.
- Inner service preview links are not expected to work in this setup.

## Troubleshooting

Browser symptoms map to specific dead or misconfigured inner processes:

- `Request failed with 500` instead of the login page: the inner app's assets loaded but its first API call failed. The Vite server returns a bare 500 when the inner control-plane is unreachable (`connect ECONNREFUSED 127.0.0.1:3583` in the Vite log) and when the dev server's esbuild service has died (`The service is no longer running`). Restart the dead process, re-run the readiness checks, and prefer the built app if the dev server keeps dying.
- `Proxy error: connect ECONNREFUSED 127.0.0.1:5174` (502): the web server behind the host-rewrite proxy is down.
- A blocked-host error page from Vite: the published service host is not covered by `VITE_DEV_ALLOWED_HOSTS`.
- `403 Untrusted browser request` on logout or session creation: the control-plane's `WEB_BASE_URL` does not match the browser origin. Restart it with the published service origin.
- The outer login page instead of the inner app: the inner web proxy is routing service hosts itself; confirm the inner web server runs with `SERVICE_HOST_REGEX=^$`.

See [Web UI](./web-ui.md) for how service previews and preview auth work in general.
