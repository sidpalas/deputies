# Integrations

## Principle

Integrations are thin adapters. They authenticate inbound requests, normalize external payloads, map external threads to sessions, enqueue messages, and send callbacks.

They must never run agents directly.

Allowed:

```ts
await enqueueIntegrationMessage(envelope);
```

Forbidden:

```ts
await runner.run(...);
```

## Common Envelope

Every integration should produce the same internal shape.

```ts
type IntegrationEnvelope = {
  source: 'generic-webhook' | 'github' | 'slack' | 'linear';
  externalThreadId?: string;
  dedupeKey?: string;
  actor: {
    externalId: string;
    name?: string;
    email?: string;
  };
  repo?: {
    owner: string;
    name: string;
    defaultBranch?: string;
  };
  prompt: string;
  context: Record<string, unknown>;
  callback?: {
    type: 'http' | 'github' | 'slack' | 'linear';
    target: Record<string, string>;
  };
};
```

## Shared Flow

```txt
external webhook
  -> verify signature/auth
  -> dedupe delivery
  -> normalize payload to IntegrationEnvelope
  -> resolve external thread mapping
  -> create or find session
  -> append message
  -> return 202 Accepted
  -> worker executes message later
  -> callback dispatcher posts progress/completion
```

## Generic Inbound Webhook

Generic webhook auth is independent of product API auth. Product session routes can use `API_AUTH_MODE=none|bearer|session`, but `POST /webhooks/generic/:sourceKey` always uses the bearer token configured for that webhook source in the database.

The generic webhook is the first integration to implement.

Route:

```txt
POST /webhooks/generic/:sourceKey
```

MVP capabilities:

- Bearer token auth.
- JSON body only.
- Dedupe via request-provided `dedupeKey`.
- External thread reuse via request-provided `threadId`.
- Prompt ingestion via request-provided `prompt` plus optional source prompt prefix.
- Context ingestion via request-provided `context`.
- Optional HTTP completion callback via request-provided `callbackUrl`.

Future capabilities:

- JSON-path mapping/filtering/template configuration.
- HMAC auth.
- Basic auth.
- CIDR allowlist.
- Admin API for source configuration.

Current callback support:

- Generic webhook payloads may include `callbackUrl`.
- On message completion, the worker posts a JSON payload to that URL.
- Callback attempts are persisted in `callback_deliveries`. The dispatcher claims due callbacks, delivers them through target-specific sender plugins, records `callback_sent` on success, schedules retry on transient failure, and records `callback_failed` after terminal failure.

Example config:

```json
{
  "key": "ci-failures",
  "name": "CI Failures",
  "enabled": true,
  "auth": {
    "type": "bearer",
    "tokenHash": "..."
  },
  "mapping": {
    "externalThreadIdPath": "$.workflow_run.id",
    "dedupeKeyPath": "$.delivery_id",
    "repoPath": "$.repository.full_name",
    "promptPath": "$.message",
    "titlePath": "$.workflow_run.name"
  },
  "filters": [
    { "path": "$.workflow_run.conclusion", "op": "equals", "value": "failure" }
  ],
  "defaults": {
    "promptTemplate": "Investigate this CI failure and propose or implement a fix.\n\nPayload:\n{{json payload}}"
  }
}
```

Session resolution:

```txt
if externalThreadId exists:
  sourceKey + externalThreadId -> existing session or create new
else:
  create new session per accepted delivery
```

## GitHub Integration

Supported triggers:

- Issue comments mentioning the agent.
- PR comments mentioning the agent.
- PR review comments mentioning the agent.
- Optional issue opened or label-based triggers later.

Inbound responsibilities:

- Verify `X-Hub-Signature-256`.
- Dedupe with `X-GitHub-Delivery`.
- Ignore irrelevant events and bot loops.
- Detect trigger phrases.
- Resolve repo, issue, PR, comment, actor, and installation ID.
- Fetch relevant issue/PR context when needed.
- Mark PR/comment bodies as untrusted prompt content.

External thread IDs:

```txt
github:owner/repo:issue:123
github:owner/repo:pr:456
```

Callback responsibilities:

- Post start/completion/failure comments when configured.
- Post PR URL when an artifact is created.
- Avoid noisy tool-level updates unless explicitly enabled.

Testing should use `vercel-labs/emulate` GitHub service:

- Seed users, org, repo, issue, PR, GitHub App installation.
- Send realistic webhooks to the app.
- Assert sessions/messages are created.
- Assert comments or PRs are created in the emulated GitHub API.
- Assert duplicate deliveries are ignored.

## Slack Integration

See [Slack Testing](./slack-testing.md) for real Slack, tunnel, and emulate workflows.

Supported triggers:

- App mentions.
- Thread follow-ups.
- Direct messages later.

Inbound responsibilities:

- Verify Slack signing secret.
- Enforce optional team/channel/user allowlists.
- Handle Slack URL verification challenge.
- Dedupe by Slack event ID.
- Ignore bot/self events.
- Resolve Slack thread to session.
- Strip the bot mention from app mention prompts.
- Include prior unprocessed Slack thread messages as background context when the bot is tagged later in a thread.
- Resolve readable Slack channel and user names for prompts when Slack API scopes allow it.
- Resolve repo from explicit syntax, defaults, or classifier later.

External thread ID:

```txt
slack:team_id:channel_id:thread_ts
```

Callback responsibilities:

- Reply in thread with session start.
- Reply with final result or PR URL.
- Reply with failures that require human attention.
- Keep progress messages sparse by default.

Testing should use `vercel-labs/emulate` Slack service:

- Seed team, bot, users, channels.
- Post messages and thread replies through emulated Slack APIs.
- Send app mention payloads to the app.
- Assert callback messages are visible in the emulated thread.

Current implementation:

- `POST /webhooks/slack/events` handles Slack Events API payloads.
- `url_verification` returns the Slack challenge after signature verification.
- Optional `SLACK_ALLOWED_TEAM_IDS`, `SLACK_ALLOWED_CHANNEL_IDS`, and `SLACK_ALLOWED_USER_IDS` comma-separated allowlists reject unauthorized events before session/message creation. Slack is fail-closed when `SLACK_SIGNING_SECRET` is set: at least one allowlist is required unless `UNSAFE_ALLOW_ALL_SLACK_IDS=true` is explicitly configured.
- `app_mention` creates or reuses a session keyed by `team_id:channel:thread_ts`.
- `message` events are accepted only as thread follow-ups, not as new top-level sessions.
- Thread follow-ups mapped to archived sessions are acknowledged and ignored so archived sessions remain read-only. When Slack replies are configured, the bot posts an in-thread notice explaining that the session must be restored first.
- Duplicate `event_id` values are ignored through `integration_deliveries`.
- Bot messages are ignored to prevent loops.
- Accepted Slack messages get a best-effort `:eyes:` reaction when `SLACK_BOT_TOKEN` has `reactions:write`.
- Tagged Slack thread messages can include fetched prior thread replies as prior-message context. Context messages whose Slack `ts` already exists on prior product messages are omitted to avoid replaying already processed requests.
- Prompts use Slack channel/user names when `SLACK_BOT_TOKEN` has `channels:read` or `groups:read` for channel lookup and `users:read` for user lookup; raw Slack IDs remain in message context only.
- Running Slack-originated work gets a best-effort `:hourglass_flowing_sand:` reaction through the Slack progress notifier plugin.
- Completed Slack replies get a best-effort `:white_check_mark:` reaction through the Slack callback sender.
- `api/src/integrations/slack` owns Slack auth, types, prompts, client helpers, and service orchestration. It must not import runners, sandboxes, or Flue.

Local HTTPS emulation:

```sh
portless proxy start
pnpm dlx emulate start --service slack --portless
```

Then point Slack client config at:

```txt
SLACK_API_BASE_URL=https://slack.emulate.localhost/api
```

Automated tests should prefer the programmatic `createEmulator({ service: 'slack' })` API. Do not add emulate to Docker Compose by default; Compose remains for infrastructure dependencies such as Postgres.

## Linear Integration

Linear does not currently have an obvious emulator in `vercel-labs/emulate`. Use a local fake HTTP server or integration test fixtures first.

Supported triggers:

- Issue assigned to agent.
- Comment mentioning the agent.
- Follow-up comments on mapped issues.
- Stop/cancel action later.

Inbound responsibilities:

- Verify Linear signature.
- Dedupe deliveries.
- Resolve issue and actor.
- Resolve repo from explicit text, project mapping, team mapping, previous session, or classifier.
- Fetch issue title, description, comments, and attachments.

External thread ID:

```txt
linear:issue_id
```

Callback responsibilities:

- Post agent activity updates.
- Link session and PR artifacts.
- Report failure with useful next step.

## Callback Dispatcher

Callbacks should consume normalized internal events, not runner internals.

Input:

```txt
event appended
  -> callback dispatcher evaluates subscriptions/callback targets
  -> formats source-specific update
  -> posts to external service
  -> records callback_sent, callback_retry_scheduled, or callback_failed
```

Default callback policy:

- `run_started`: optional, source-specific.
- `artifact_created` with PR: notify.
- `run_completed`: notify.
- `run_failed`: notify.
- Tool events and text deltas: do not notify externally by default.

Current implementation:

- Completion callbacks are enqueued during worker finalization instead of requiring immediate delivery to complete the run.
- The worker dispatches due callbacks when no session message is available to claim.
- Callback sender plugins keep concrete integration clients out of callback core. Slack provides `SlackCompletionCallbackSender` from `api/src/integrations/slack`.
- Retry uses exponential backoff with jitter and terminal failure after `max_attempts`.

## Auth Model

Separate inbound verification from outbound API credentials.

| Integration | Inbound | Outbound |
|---|---|---|
| Generic webhook | Bearer/HMAC/basic | Optional HTTP callback auth |
| GitHub | Webhook secret | GitHub App token, optional user OAuth |
| Slack | Signing secret | Slack bot token |
| Linear | Webhook secret | Linear API token |

Credential handling rules:

- Store references or encrypted payloads, not raw tokens in messages/events.
- Mint short-lived GitHub App installation tokens at runtime.
- Redact tokens from logs and events.
- Keep outbound client base URLs configurable for emulator-backed tests.

## Prompt Construction

Integration prompt builders should produce structured, source-specific context while sharing common safety language.

Required sections:

- Source and actor.
- Repository, if known.
- External object metadata.
- User request.
- Relevant context.
- Explicit untrusted-content boundary for external comments/bodies.

Prompt templates live in `api/src/prompts`, not inside route handlers.
