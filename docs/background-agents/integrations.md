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

## Cross-Integration Learnings

Slack, GitHub, and the web UI now exercise the same product loop from different entry points. New integrations should follow these constraints instead of creating source-specific side channels:

- Integration prompts should contain source/thread context only. Behavior rules belong in runner/agent instructions, tool descriptions, and callback senders, not in chat-visible message text.
- Every public webhook should authenticate origin, dedupe deliveries, authorize actor/resource, map an external thread to a Deputies session, fetch unseen prior context, enqueue the current request, add a lightweight received signal, and post exactly one final response through callbacks.
- Received/progress signals and final replies are separate. Slack/GitHub use reactions for received state; callback senders own final replies. Agent tools should not post final Slack/GitHub replies directly.
- Follow-up prompts should be compact. The first message can include full channel/issue/PR metadata; later messages should include only a compact event/thread identity, unseen prior context, and the current tagged request.
- Prompt text from integrations should be Markdown-safe in the web UI. Source prompts are rendered as plain text; assistant responses remain Markdown.
- Public integrations should fail closed: webhook secret/signature checks, source-specific allowlists, and explicit trigger-phrase gating where applicable.
- Context de-duplication is a platform concern. Slack tracks timestamps; GitHub tracks comment IDs. Future integrations should record source item IDs in message context so prior context is not repeated.

Shared utilities worth extracting before the next major integration:

- `getOrCreateIntegrationSession(source, externalId, title, metadata)` for external-thread/session mapping.
- Delivery dedupe helpers around `integration_deliveries` for claim/processed/failed paths.
- Allowlist helpers with consistent case-sensitive/case-insensitive matching and skip reasons.
- Processed-item helpers for reading item IDs from prior message context and recording newly included IDs.
- Prompt section rendering helpers using the Slack-style `Label:` / `---` convention.
- Callback target parsing and received/final response interfaces so each source can share the same lifecycle while keeping source-specific clients isolated.

Avoid a large abstract integration framework for now. Prefer small shared utilities extracted from repeated Slack/GitHub patterns.

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

GitHub App runtime access exists for webhook-created and manually selected repository work. The service mints short-lived installation credentials for clone/fetch and guarded runtime GitHub operations. Provider-owned branch push and PR helper operations remain future work.

Current runtime access support includes GitHub App JWT signing, repository installation lookup, installation token minting, token caching, repository allowlist checks, configurable clone URL generation through `GITHUB_CLONE_BASE_URL`, signed inbound GitHub webhooks, webhook sender/repo-owner allowlists, trigger-phrase gating, GitHub completion comments, Flue-runner repository refresh from message repository context, a dynamic `repository` tool for status/list/set/prepare actions, a dynamic `gh` tool for authenticated GitHub CLI/API operations against the active repository, and a dynamic `git` tool for authenticated git network operations inside the prepared sandbox repository. The worker only ensures a sandbox exists. When a run starts with repository context, Flue performs pre-prompt clone/fetch and starts in the repository `cwd`. When no repository context exists, agents can choose an allowlisted repo with `repository set`, prepare it with `repository prepare`, and then use absolute paths in the returned workspace. PR helper operations are still future work.

`GITHUB_API_BASE_URL` and `GITHUB_CLONE_BASE_URL` are intentionally separate. The API base points at GitHub's REST API or an emulator; the clone base points at the git remote host used for clone/fetch/push. Defaults are `https://api.github.com` and `https://github.com`.

Credential handling:

- `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_ID` stay in service environment/secrets and are used only server-side to sign GitHub App JWTs.
- Installation tokens are minted in memory, cached per installation until near expiry, and are not persisted in messages, events, artifacts, callbacks, or prompts.
- Git clone/fetch auth is passed to Flue `session.shell` as command-scoped env: `GITHUB_AUTH_HEADER=Authorization: Basic base64(x-access-token:<installation-token>)`.
- Shell commands reference only `$GITHUB_AUTH_HEADER`; token values are not embedded in command strings. Flue shell history records env variable names, not values.
- The agent `repository` tool is always available when GitHub access is configured. `status` reports active/prepared repo state, `list` reports configured allowlist entries, `set` validates and persists session repo context, and `prepare` clones/fetches inside the sandbox.
- Repository setup configures repo-local git identity as `Deputies <deputies@users.noreply.github.com>` so agents do not need to mutate global sandbox git config.
- The agent `gh` tool runs in trusted worker code with command-scoped `GH_TOKEN`, `GH_REPO`, a temporary `GH_CONFIG_DIR`, disabled prompts, token redaction, and blocked auth/config/extension/clone escape hatches. It resolves the active repo at call time and blocks GitHub Git Database API routes so sandbox-local commits are published through git, not remote object surgery.
- The agent `git` tool runs the git process inside the prepared remote sandbox repository through Flue agent-level `shell` with command-scoped `GITHUB_AUTH_HEADER`. Agents should use it for authenticated push/fetch/pull operations, not for GitHub issue/comment/PR API work. Risky push forms such as force, mirror, delete, and force refspecs are blocked.
- `repository_ready` events contain repository identity, workspace path, and expiry metadata only.
- GitHub webhook allowlists fail closed when `GITHUB_WEBHOOK_SECRET` is set. Configure `GITHUB_ALLOWED_USERS` or `GITHUB_ALLOWED_ORGANIZATIONS`, or explicitly set `UNSAFE_ALLOW_ALL_GITHUB_USERS_AND_ORGS=true` for unrestricted GitHub webhook access.
- `GITHUB_ALLOWED_USERS` and `GITHUB_ALLOWED_ORGANIZATIONS` gate inbound webhooks. Empty means unrestricted for that dimension only after at least one webhook allowlist exists, or after unsafe allow-all is enabled. Configured lists are matched case-insensitively. Non-matching deliveries are recorded as failed integration deliveries and no session/message is created.
- `GITHUB_TRIGGER_PHRASES` replaces trigger handles. Issue/PR/comment/review text must include one configured activation phrase, such as `/deputies`, `deputies:`, `@deputies`, or an org team mention like `@acme/deputies`. Bare values like `deputies` match `@deputies`, `/deputies`, and `deputies:`.

The intended runtime model is snapshot-friendly: Daytona images/snapshots may pre-bake common repos and build artifacts, but every Flue run still refreshes or repairs the requested repository as its first sandbox shell step so reused/stale sandboxes get current code and fresh credentials.

Repository-scoped messages can carry context in either shape:

```json
{ "repository": { "provider": "github", "owner": "owner", "repo": "repo" } }
```

```json
{ "github": { "repository": { "owner": "owner", "repo": "repo" } } }
```

When a message provides repository context through the product API, the repository is also persisted as durable session context. Later messages inherit that repository automatically. Supplying a different repository on a later message updates the session default and overrides the effective context for that message and future follow-ups. Only durable repository context should be promoted to the session; transient integration metadata, callbacks, delivery IDs, and webhook payloads remain message-scoped.

Future multi-repository context should distinguish repository roles instead of treating every cloned repo as equally writable:

```json
{
  "repositories": [
    { "provider": "github", "owner": "org", "repo": "app", "role": "primary", "writable": true },
    { "provider": "github", "owner": "org", "repo": "shared-lib", "role": "auxiliary", "writable": false }
  ]
}
```

Planned semantics:

- Exactly one `primary` repository is the default `cwd`, branch target, and expected edit location for normal tasks.
- `auxiliary` repositories are cloned as sibling worktrees for context/reference and are read-only by default.
- A task that intentionally spans multiple repositories should mark each modified repo as `writable: true`; each writable repo should get its own branch/PR artifact plus a summary artifact linking the PR set.
- Snapshot/image baking can pre-populate common primary and auxiliary repositories, but startup refresh still verifies each requested worktree exists and is current enough for the run.
- Prompt context should list each repository role and sandbox path so the agent knows which repo is safe to modify.

Current webhook triggers:

- `issues.opened`, `issues.reopened`, and title/body `issues.edited`.
- `issue_comment.created` on issues or PRs.
- `pull_request.opened`, `pull_request.reopened`, `pull_request.synchronize`, and title/body/base `pull_request.edited`.
- `pull_request_review_comment.created` for inline PR review comments.
- `pull_request_review.submitted` for submitted PR reviews.

Planned webhook gating refinements:

- Add label-based triggers for teams that want non-mention workflows.
- Add collaborator permission checks requiring `write`, `maintain`, or `admin` when explicit user/org allowlists are not sufficient.
- Fetch richer issue/PR context when needed.

Inbound responsibilities:

- Verify `X-Hub-Signature-256`.
- Dedupe with `X-GitHub-Delivery`.
- Ignore irrelevant events, bot loops, and non-allowlisted actors/repo owners.
- Resolve repo, issue, PR, comment, and actor.
- Fetch issue/PR comments and include only comments not already represented in prior Deputies messages for that GitHub thread. The current triggering comment is excluded because it is rendered separately.
- Render GitHub context with Slack-style section labels and separators; rely on webhook auth, repo/user/org allowlists, and trigger-phrase gating for authorization.
- If a webhook maps to an archived session, acknowledge it without creating a message and, when GitHub comments are configured, post a recovery comment telling the user to restore the session or start a new thread.

External thread IDs:

```txt
github:owner/repo:issue:123
github:owner/repo:pr:456
```

Reaction/callback responsibilities:

- Add an `eyes` reaction to accepted webhook subjects when GitHub App credentials allow it.
- Post completion comments when configured.
- Skip GitHub completion comments that are only webhook acknowledgement text; the received `eyes` reaction is the acknowledgement.
- Post start/failure comments when configured later.
- Post PR URL when an artifact is created.
- Avoid noisy tool-level updates unless explicitly enabled.

Archived-session behavior:

- Slack and GitHub mapped follow-ups do not reactivate archived sessions.
- The inbound webhook is acknowledged and ignored for queueing.
- If the source callback client is configured, the integration posts a short recovery notice in the external thread.
- Restoring the product session allows later mapped follow-ups to enqueue normally.

Testing should use `vercel-labs/emulate` GitHub service where possible:

- Seed users, org, repo, issue, PR, GitHub App installation.
- Send realistic webhooks to the app.
- Assert sessions/messages are created.
- Assert comments are created in the emulated GitHub API. Assert PRs after provider-owned PR helpers exist.
- Assert duplicate deliveries are ignored.

Current emulator caveat: published `emulate@0.5.0` rejects valid GitHub App JWTs during installation token minting because of upstream issue [vercel-labs/emulate#96](https://github.com/vercel-labs/emulate/issues/96). GitHub emulator tests that require App installation tokens are hard-skipped until a fixed emulate release is available. Real-provider smoke coverage is opt-in:

```sh
RUN_REAL_GITHUB_APP_UAT=true pnpm --dir api exec vitest run --config vitest.uat.config.ts test/uat/real-github-app.test.ts
RUN_REAL_GITHUB_DAYTONA_UAT=true pnpm --dir api exec vitest run --config vitest.uat.config.ts test/uat/real-github-app.test.ts
```

The first UAT mints a real installation token and performs a non-mutating local `git ls-remote`. The second creates a real Daytona sandbox and verifies the Flue-runner startup path clones/fetches the repository inside the sandbox.

### GitHub Implementation Plan

This plan combines the strongest patterns from Background Agents/Open Inspect and Open SWE while preserving this service's boundaries: integrations normalize external events, workers own sandbox lifecycle, Flue owns runner startup shell setup, and GitHub-specific API/push/PR details stay in GitHub adapters.

#### 1. Webhook ingress and dedupe

Implement public `POST /webhooks/github/events` before adding any GitHub-created work to production.

- Read the raw request body and verify `X-Hub-Signature-256` with HMAC SHA-256 against `GITHUB_WEBHOOK_SECRET`.
- Fail closed when the webhook secret is missing or the signature is invalid.
- Require and persist `X-GitHub-Delivery` in `integration_deliveries` with source `github`.
- Use a two-phase delivery state inspired by Background Agents: mark as received/processing before async work, mark processed after successful enqueue, and mark failed with a retryable error when enqueue fails.
- Ignore duplicate deliveries without creating new sessions/messages.
- Record structured delivery metadata only: event name, action, repository, sender, issue/PR/comment IDs, and skip reason. Do not persist payload bodies unless explicitly needed and sanitized.

Acceptance criteria:

- Invalid signatures return `401`.
- Missing secrets reject webhooks instead of silently accepting them.
- Duplicate delivery IDs are idempotent.
- Failed processing leaves enough metadata for operator diagnosis without storing GitHub tokens or large raw payloads.

#### 2. GitHub event normalization and gating

Normalize raw GitHub payloads into a small internal event shape before session/message creation.

- Support `issue_comment.created`, `pull_request_review_comment.created`, and selected `pull_request` actions first.
- Add stable `triggerKey` and `concurrencyKey` fields, e.g. `issue_comment:<commentId>`, `pr:<number>`, and `issue:<number>`.
- Resolve repository as `{ provider: 'github', owner, repo }` and attach it to message context so the Flue runner startup step can clone/fetch it inside the sandbox before the agent prompt.
- Ignore bot/self comments to avoid loops.
- Enforce `GITHUB_ALLOWED_REPOSITORIES` before any API fetch or session creation.
- Add caller gating after repo allowlist: explicit allowed GitHub users/orgs exist; collaborator permission checks requiring `write`, `maintain`, or `admin` remain open.
- Add best-effort `eyes` reaction for accepted comments/review comments after gating succeeds.

Acceptance criteria:

- Unsupported actions are acknowledged and skipped with a reason.
- Unauthorized repositories/users do not create sessions/messages.
- Accepted events include normalized context and repository setup context.

#### 3. Repository extraction utilities

Add a reusable repo parser for non-GitHub-webhook sources and manual prompts, based on Open SWE's pragmatic extraction rules.

- Support `repo:owner/name` and `repo owner/name`.
- Support GitHub URLs such as `https://github.com/owner/repo`.
- Prefer explicit `repo:` or `repo ` syntax over URLs when both are present.
- Do not add a default owner unless there is an explicit product setting; absent defaults should return no repository.
- Normalize trailing slashes and reject ambiguous or invalid values.

Acceptance criteria:

- Slack/Linear/manual sources can opt into the same parser later without importing GitHub webhook handlers.
- Unit tests cover explicit repo syntax, URLs, precedence, trailing slashes, and invalid inputs.

#### 4. Thread mapping and follow-up context

Use deterministic external thread IDs so GitHub follow-ups reuse the correct session.

- Map issues to `github:<owner>/<repo>:issue:<issueNumber>`.
- Map PRs to `github:<owner>/<repo>:pr:<prNumber>`.
- For PR review comments, use the PR external thread and include review-comment metadata in the message context.
- Fetch enough context for the first accepted event: issue/PR title, body, author, relevant comments, review comments, and diff hunk when available.
- For later mentions, include only unprocessed comments since the last accepted GitHub mention when feasible.
- Bound context sizes: cap issue/PR body previews, diff hunks, and comment counts.

Acceptance criteria:

- Repeated comments on the same issue/PR enqueue follow-up messages on the existing session.
- Concurrent messages for the same session are handled by the existing queue/batch behavior.
- Large PR/issue payloads do not produce unbounded prompts.

#### 5. GitHub prompt context

Keep GitHub webhook prompts compact and similar to Slack prompts.

- Do not inject bulky untrusted-content warnings into every webhook prompt; they can cause the model to reject legitimate tagged requests.
- Use structured labels and `---` separators for webhook context.
- Sanitize legacy reserved wrapper tags if they appear inside user-controlled GitHub content.
- Preserve readable author/source labels for comments, review comments, PR titles, bodies, branch names, and diff hunks.
- Add tests for prompt construction and tag sanitization.

Acceptance criteria:

- Prompt tests prove external content cannot spoof legacy reserved boundaries.
- GitHub prompts remain compact while clearly separating event metadata, prior comments, and the current tagged request.

#### 6. Callback comments and completion behavior

Implement GitHub callback delivery through the generic callback core instead of relying only on prompt instructions.

- Add a GitHub callback sender for final completion, failure, and PR/artifact links.
- Post sparse comments by default: accepted/start reaction, final summary, failure requiring human attention, and PR URL when created.
- Store callback target metadata, not tokens.
- Use fresh GitHub App access when dispatching callback comments.
- Add manual replay support automatically through the existing callback replay route.

Acceptance criteria:

- Completion comments are visible through emulator-backed tests.
- Failed callback deliveries show in existing callback observability UI and can be replayed.
- GitHub tokens never appear in callback payloads, events, artifacts, or logs.

#### 7. Provider-owned push and PR helpers

Build branch push and PR creation as GitHub/source-control adapter operations, not as worker or runner internals.

- Add branch-name sanitization before any push or PR creation.
- Generate fresh app auth for each push/PR operation.
- Build redacted and real push specs in the GitHub adapter; only redacted specs may be logged or persisted.
- Push branch first, verify it succeeded, then create PR.
- Prevent duplicate PR artifacts for the same session unless an explicit update flow is requested.
- Record verified PR URLs as artifacts.
- Allow a later user-OAuth path to override app-token PR creation when product auth exists; keep GitHub App fallback as the first implementation.

Acceptance criteria:

- PR creation cannot claim success without a verified PR URL.
- Invalid branch names are rejected before git commands run.
- Provider-specific URL/token logic stays inside GitHub/source-control adapter modules.

#### 8. Auth refresh for reused sandboxes

Keep runtime GitHub auth fresh whenever a reused sandbox performs repository operations.

- Continue minting/accessing short-lived tokens during Flue runner startup setup for clone/fetch.
- Re-mint or refresh auth before push/PR operations, not only at sandbox creation time.
- If a future sandbox provider supports outbound proxy or secret injection, implement it behind the sandbox provider boundary; do not require it for all providers.
- Prefer Flue `session.shell(..., { env })` command-scoped auth for Daytona until a stronger provider-native mechanism exists.

Acceptance criteria:

- Stopped/restarted sandboxes can fetch/push with fresh credentials.
- Token refresh is tested independently from sandbox creation.
- No provider-specific proxy requirement leaks into the core sandbox interface.

#### 9. Tests and emulator coverage

Add focused unit tests first, then emulator-backed integration tests.

- Unit-test webhook signature verification, delivery dedupe, normalization, repo extraction, trigger-phrase gating, permission gating decisions, prompt wrappers, and branch sanitization.
- Use fake GitHub clients for token, permission, comment, branch, push, and PR flows.
- Add opt-in emulator tests that seed GitHub users/repos/issues/PRs/installations, send webhooks, process worker runs, and assert comments in the emulator once `emulate` has a fixed GitHub App JWT verification release. Add PR assertions after provider-owned PR helpers exist.
- Keep real GitHub App and real GitHub + Daytona smoke tests opt-in and skipped by default.
- Add regression tests proving token strings are absent from events, messages, artifacts, callback payloads, and logs under controlled fakes.

Acceptance criteria:

- Phase 9 can be verified without real GitHub credentials in CI-like local runs.
- Real-provider smoke testing remains opt-in and never runs by default.

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
- Session-scoped API/UI controls show callback delivery status and can requeue failed deliveries for manual replay without re-running the agent task.

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
