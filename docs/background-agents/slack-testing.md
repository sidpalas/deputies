# Slack Testing

## Auth Split

Slack webhooks do not use product API session or bearer auth.

`POST /webhooks/slack/events` is public at the HTTP routing layer and authenticates each request with Slack's `X-Slack-Signature` and `X-Slack-Request-Timestamp` headers. Product session routes remain protected by `API_AUTH_MODE`.

## Real Slack Local Test

Real Slack must call a public HTTPS URL. `portless` is useful for local emulators, but it does not expose your machine to Slack's cloud.

Use a tunnel such as ngrok or cloudflared:

```sh
ngrok http 3583
```

Run the API with Slack config:

```sh
set -a; source .env.local; set +a; pnpm api:dev
```

Slack app settings:

- Events request URL: `https://<public-tunnel>/webhooks/slack/events`
- Subscribe to bot event: `app_mention`
- Bot scopes: `app_mentions:read`, `reactions:write`, `chat:write` for outbound replies
- Install the app to the workspace
- Invite the bot to the test channel

Required env:

```txt
SLACK_SIGNING_SECRET=<from Slack app Basic Information>
SLACK_BOT_TOKEN=xoxb-...
SLACK_API_BASE_URL=https://slack.com/api
```

Manual test:

```txt
@Dev Deputies investigate this repository setup
```

Expected result:

- Slack receives `200 { "ok": true, "type": "accepted" }`.
- A product session is created with title `Slack: ...`.
- A message is queued with source `slack`.
- The bot adds an `:eyes:` reaction to the received Slack message when `SLACK_BOT_TOKEN` has `reactions:write`.
- Follow-up replies in the same Slack thread reuse the same product session.
- Duplicate Slack `event_id` deliveries do not create duplicate messages.

## Emulate Local Test

Use `vercel-labs/emulate` for stateful local Slack Web API behavior and callback testing. This does not replace real Slack Events delivery; it is for automated or local no-network tests.

Start HTTPS emulation:

```sh
pnpm api:portless:start
pnpm api:emulate:slack
```

Use:

```txt
SLACK_API_BASE_URL=https://slack.emulate.localhost/api
```

Automated tests should usually start emulate programmatically with `createEmulator({ service: 'slack' })` instead of relying on a long-running process. Do not add emulate to Docker Compose by default; Docker Compose remains for durable infrastructure such as Postgres.

## Current Limits

- Inbound `app_mention` and thread follow-up `message` events are implemented.
- URL verification and signature verification are implemented.
- Bot/self-message ignore and event dedupe are implemented.
- Outbound Slack replies are not wired to completion callbacks yet.
- Thread history fetching is not implemented yet.
- Direct messages are intentionally deferred.
