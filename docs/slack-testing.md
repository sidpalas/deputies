# Slack Testing

## Auth Split

Slack webhooks do not use product API session or bearer auth.

`POST /webhooks/slack/events` is public at the HTTP routing layer and authenticates each request with Slack's `X-Slack-Signature` and `X-Slack-Request-Timestamp` headers. Product session routes remain protected by `API_AUTH_MODE`.

## Real Slack Local Test

Real Slack must call a public HTTPS URL. `portless` is useful for local emulators, but it does not expose your machine to Slack's cloud.

Use a public tunnel such as ngrok pointed at the web proxy:

```sh
ngrok http 5173
```

The Vite dev proxy allows common tunnel domains by default. If you use another tunnel host, set `VITE_DEV_ALLOWED_HOSTS=<host>` before `pnpm web:dev` so Vite does not return `403 Forbidden` before proxying Slack requests.

Run the API with Slack config and the web proxy:

```sh
cp .env.example .env.local
set -a; . ./.env.local; set +a; pnpm control-plane:dev
pnpm web:dev
```

Slack app settings:

- Events request URL: `https://<public-tunnel>/webhooks/slack/events`
- Subscribe to bot event: `app_mention`; add `message.channels` and/or `message.groups` if you want plain thread follow-up messages in already mapped channel threads
- Bot scopes: `app_mentions:read`, `reactions:write`, `chat:write` for outbound replies, `users:read` for prompt usernames, and channel history/read scopes for thread context and channel names
- Install the app to the workspace
- Invite the bot to the test channel

Required env:

```txt
SLACK_SIGNING_SECRET=<from Slack app Basic Information>
SLACK_BOT_TOKEN=xoxb-...
SLACK_API_BASE_URL=https://slack.com/api
# Slack is fail-closed when SLACK_SIGNING_SECRET is set. Configure at least one
# allowlist, or explicitly set UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS=true for local tests.
UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS=false
# Optional comma-separated allowlists. Empty means unrestricted for that dimension.
SLACK_ALLOWED_TEAM_IDS=T...
SLACK_ALLOWED_CHANNEL_IDS=C...
SLACK_ALLOWED_USER_IDS=U...
```

Authorization allowlists are evaluated after Slack signature verification. If a list is non-empty, the incoming Slack event must match one of its values. At least one allowlist is required when `SLACK_SIGNING_SECRET` is set unless `UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS=true`. Unauthorized events return `200 { "ok": true, "type": "ignored" }` so Slack does not retry, and no product session/message is created.

Manual test:

```txt
@Deputies investigate this repository setup
```

Expected result:

- Slack receives `200 { "ok": true, "type": "accepted" }`.
- A product session is created with title `Slack: ...`.
- A message is queued with source `slack`.
- When the bot is tagged with an `app_mention` in an existing thread, earlier unprocessed thread messages are fetched as prior Slack thread context for that one queued message when token scopes allow it.
- When `SLACK_BOT_TOKEN` has `users:read`, `channels:read`, or `groups:read`, prompts use readable Slack usernames and channel names instead of raw Slack IDs.
- The bot adds an `:eyes:` reaction to the received Slack message when `SLACK_BOT_TOKEN` has `reactions:write`.
- When work starts, the bot adds `:hourglass_flowing_sand:` to the same Slack message.
- When the final Slack reply is delivered, the bot adds `:white_check_mark:` to the same Slack message.
- Follow-up replies in the same Slack thread reuse the same product session.
- Follow-up replies to archived mapped sessions are acknowledged and recorded as transcript-only cancelled entries. When `SLACK_BOT_TOKEN` has `chat:write`, the bot replies in-thread explaining that the session is archived. Replying with `unarchive and proceed` restores the session and queues recovery work for archived transcript messages, or only records a recovery acknowledgement if no work is pending.
- Duplicate Slack `event_id` deliveries do not create duplicate messages.
- Events from teams, channels, or users outside configured allowlists are ignored.

## Emulate Local Test

Use `vercel-labs/emulate` for stateful local Slack Web API behavior and callback testing. This does not replace real Slack Events delivery; it is for automated or local no-network tests.

Start HTTPS emulation:

```sh
pnpm control-plane:portless:start
pnpm control-plane:emulate:slack
```

Use:

```txt
SLACK_API_BASE_URL=https://slack.emulate.localhost/api
```

Automated tests should usually start emulate programmatically with `createEmulator({ service: 'slack' })` instead of relying on a long-running process. Do not add emulate to Docker Compose by default; Docker Compose remains for durable infrastructure such as Postgres and SeaweedFS.

## Current Limits

- Inbound `app_mention` and thread follow-up `message` events are implemented.
- URL verification and signature verification are implemented.
- Optional team/channel/user allowlists are implemented.
- Bot/self-message ignore and event dedupe are implemented.
- Outbound Slack replies are delivered through the generic callback dispatcher and retried with backoff.
- Thread history fetching is implemented for `app_mention` events when `SLACK_BOT_TOKEN` has the needed history scope for the channel type. Previously processed Slack message timestamps are omitted from fetched context. Plain `message` follow-ups in already mapped threads are accepted without fetching additional prior thread context.
- Prompt channel/user name lookup is implemented when `SLACK_BOT_TOKEN` has `channels:read` or `groups:read` for the channel type and `users:read` for users. After adding Slack scopes, reinstall the app so the bot token receives them.
- Direct messages are intentionally deferred.
