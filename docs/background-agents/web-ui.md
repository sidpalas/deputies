# Web UI

The operator UI is a separate Vite React app in `web/`. It is intentionally independent from the Hono API process so it can be deployed later as static assets behind a CDN.

## Local Development

Run the API and web app separately:

```sh
pnpm dev
pnpm web:dev
```

The web app uses `VITE_API_BASE_URL` when set and otherwise calls `http://127.0.0.1:3583`.

```sh
VITE_API_BASE_URL=http://127.0.0.1:3583 pnpm web:dev
```

## Auth

The UI uses the product API's existing bearer-token mode.

- `/health` is public and tells the UI whether `apiAuthMode` is `none` or `bearer`.
- When bearer auth is enabled, the user enters the API bearer token in the browser.
- The token is stored in `localStorage` and sent as `Authorization: Bearer <token>`.
- The UI clears the token when the API returns `401`.

The SSE client uses `fetch()` streaming instead of native `EventSource` because native `EventSource` cannot send authorization headers.

## Current Scope

- List and create sessions.
- List session messages.
- Enqueue follow-up messages.
- Replay and stream session events.
- List session artifacts.

## Deployment

The web app builds to static assets:

```sh
pnpm web:build
```

Deploy `web/dist` to a CDN/static host and set `VITE_API_BASE_URL` to the public API origin at build time. Do not bake the bearer token into the build.
