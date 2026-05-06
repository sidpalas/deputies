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
- Callback attempts are persisted in `callback_deliveries` and reflected as `callback_sent` or `callback_failed` events.

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

Supported triggers:

- App mentions.
- Direct messages.
- Thread follow-ups.

Inbound responsibilities:

- Verify Slack signing secret.
- Handle Slack URL verification challenge.
- Dedupe by Slack event ID.
- Ignore bot/self events.
- Resolve Slack thread to session.
- Resolve repo from explicit syntax, defaults, or classifier later.
- Fetch thread history when useful.

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
  -> records callback_sent or callback_failed
```

Default callback policy:

- `run_started`: optional, source-specific.
- `artifact_created` with PR: notify.
- `run_completed`: notify.
- `run_failed`: notify.
- Tool events and text deltas: do not notify externally by default.

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
