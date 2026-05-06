# Web UI

The operator UI is a separate Vite React app in `web/`. It is intentionally independent from the Hono API process so it can be deployed later as static assets behind a CDN.

## Local Development

Run the API and web app separately:

```sh
pnpm api:dev
pnpm web:dev
```

The web app uses `VITE_API_BASE_URL` when set and otherwise calls `http://localhost:3583`. For session-cookie auth, the browser UI host and API host should use the same hostname family. For example, use `localhost` for both the Vite app and API instead of mixing `localhost` and `127.0.0.1`.

```sh
VITE_API_BASE_URL=http://localhost:3583 pnpm web:dev
```

## Auth

The UI supports all product API auth modes exposed by `/health`:

- `none`: the UI calls the API without credentials.
- `bearer`: the user enters the API bearer token in the browser. The token is stored in `localStorage` and sent as `Authorization: Bearer <token>`.
- `session`: the user signs in with static operator credentials. The API sets a signed `dev_deputies_session` HTTP-only cookie, and the UI sends requests with `credentials: include`.

Local session-auth example:

```sh
API_AUTH_MODE=session
AUTH_STATIC_USERNAME=dev
AUTH_STATIC_PASSWORD=dev-secret
AUTH_SESSION_SECRET=replace-with-random-local-secret
AUTH_COOKIE_SECURE=false
VITE_API_BASE_URL=http://localhost:3583
```

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
- Replay and stream session events.
- List session artifacts.

## Deployment

The web app builds to static assets:

```sh
pnpm web:build
```

Deploy `web/dist` to a CDN/static host and set `VITE_API_BASE_URL` to the public API origin at build time. Do not bake bearer tokens, static passwords, or session secrets into the web build.
