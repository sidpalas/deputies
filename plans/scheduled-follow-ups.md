# Plan: Add session-bound scheduled follow-ups

Status: implemented, updated for private Sessions (2026-07-24)
Scope: `apps/control-plane` and `apps/web`; additive database migration; dedicated Pi agent tool; Slack and GitHub delivery for externally bound sessions

Access-model baseline: `370c6af` (`feat: add private sessions`).

## 1. Outcome and current state

Deputies should let a human or agent arrange for a prompt to be appended to an existing session at one or more future times. This is a **Scheduled Follow-up**, not an Automation:

- a Scheduled Follow-up is bound to its target session and continues that session;
- a Scheduled Automation is a tenant-wide resource that creates a new session for each invocation;
- both ultimately produce normal messages processed by the existing worker;
- both need durable due-time claiming, lease recovery, and idempotency, but they do not share ownership, authorization, schedule-expression, or invocation semantics.

The repository already has most execution primitives:

- `AutomationService.processNextScheduled` and the Postgres automation claim methods provide the lease-and-recovery pattern;
- `MessageService.enqueue` and the worker pipeline process follow-up messages in existing sessions;
- session authorization already separates human read/write access;
- the deputy tool supplies a session-agent principal and active-run persistence gate;
- External Thread records durably map Slack/GitHub work to sessions;
- callback delivery already retries provider responses durably.

The missing pieces are a session-bound schedule definition, immutable due-occurrence history, atomic activation into an existing session, reverse External Thread resolution, a dedicated agent tool, and session-level web UI.

## 2. Goals and non-goals

### Goals

1. Schedule a one-off prompt for an exact future instant.
2. Schedule bounded recurrence using a constrained RFC 5545 RRULE and IANA time zone.
3. Continue the existing session and preserve its ordered message/run history.
4. Prevent duplicate messages after worker crashes, concurrent scheduler claims, edits, cancellation, archival, or retries.
5. Prevent recurring backlog while retaining an auditable occurrence history.
6. Deliver results and actionable pre-message failures back to a bound Slack or GitHub External Thread.
7. Support humans through the session composer and agents through a dedicated tool.
8. Follow the tenant-wide Viewer/Member/Admin access model and existing session-agent control scope.
9. Leave existing Scheduled Automation behavior and UTC cron data unchanged.

### Non-goals

- Do not convert Scheduled Follow-ups into an Automation kind.
- Do not migrate Automations from UTC cron to RRULE.
- Do not introduce human reminders that notify without creating agent work.
- Do not allow unbounded recurrence.
- Do not expose arbitrary raw RRULE authoring in the initial web UI.
- Do not add a separate Scheduled Follow-up access policy or reintroduce access groups; access follows the target Session, including its private owner boundary.
- Do not build a generic scheduling framework before the two concrete schedulers demonstrate a stable shared abstraction.

## 3. Settled domain behavior

### 3.1 Ownership and authority

- The Scheduled Follow-up is bound to its target Session and inherits that Session's access boundary. Tenant Session definitions/history are tenant-readable; private Session definitions/history are owner-only and undiscoverable to other users, including Admins and bypass identities.
- Members and Admins may create, edit, and cancel Scheduled Follow-ups on writable tenant Sessions or private Sessions they own. Viewer owners retain read-only access to definitions/history. Trusted `none`/`bearer` modes retain bypass behavior only for tenant Sessions.
- The dedicated agent tool follows the current agent Session authority: a tenant acting Session may target non-archived tenant Sessions, while a private acting Session may additionally target same-owner private Sessions. Lineage remains audit/UI metadata, not authority.
- Human authorization is checked for CRUD operations and agent authority is checked while the acting Run still owns its lease. Due activation does not reauthorize the creator.
- Creator identity is audit-only. User removal or role changes do not stop an already-created schedule.
- Archiving a Session permanently cancels all remaining Scheduled Follow-ups. Unarchiving does not resurrect them.

### 3.2 Schedule kinds and bounds

Use a discriminated schedule contract:

```ts
type ScheduledFollowUpSchedule =
  | {
      kind: 'once';
      runAt: string; // absolute RFC 3339 instant
      displayTimezone?: string;
    }
  | {
      kind: 'recurring';
      dtstartLocal: string; // civil local date-time, no offset
      timezone: string; // canonical IANA TZID
      rrule: string; // normalized body; excludes DTSTART, COUNT, UNTIL
      endsAt?: string; // inclusive absolute instant
      maxOccurrences?: number;
    };
```

Rules:

- Recurrence must include `endsAt`, `maxOccurrences`, or both.
- If neither is supplied by the authoring surface, persist `maxOccurrences = 10`.
- Explicit `maxOccurrences` must be between 1 and 100.
- Even an end-time-only schedule stops after the platform hard cap of 100 occurrences.
- A one-off has one occurrence.
- Every due activation consumes an occurrence number whether it creates, skips, or fails to create a Message.
- `COUNT`, `UNTIL`, and `DTSTART` are rejected inside RRULE so product bounds have one source of truth.
- The server validates and normalizes RRULE and timezone input and is authoritative for occurrence preview.

### 3.3 Time-zone and DST policy

- Persist civil `dtstartLocal` separately from the IANA timezone and materialized UTC instants.
- Recurrence preserves local wall-clock time through daylight-saving changes.
- A nonexistent local time in a spring-forward gap produces no due instant and does not consume an occurrence.
- An ambiguous local time in a fall-back overlap resolves once using the earlier offset.
- `endsAt` is inclusive.
- Persisted occurrence instants never change after timezone database or recurrence-library upgrades.
- Pin the recurrence/timezone library and add fixtures proving behavior independently of the process `TZ` setting.

### 3.4 Occurrence, overlap, downtime, and failure

- A Scheduled Follow-up Occurrence is immutable activation history, not a Run.
- At most one Message from a given Scheduled Follow-up may be unfinished (`pending`, `processing`, or `cancelling`).
- Unrelated Session work does not suppress an occurrence; its generated Message waits in Session order.
- If the prior Message from the same schedule is unfinished, the new occurrence is `skipped` with reason `previous_message_unfinished`.
- After scheduler downtime, enumerate all due scheduled instants:
  - record all but the latest as `skipped: missed_during_downtime`;
  - let only the latest attempt to create a Message;
  - consume every enumerated occurrence number.
- A one-off that was validly created before its due time executes late after downtime.
- Reject newly created one-off times materially in the past rather than treating them as scheduler catch-up.
- A classified pre-message domain failure records `pre_message_failed` and recurrence continues.
- Infrastructure failures—database outage, lease loss, process crash, transient resolver failure—do not consume an occurrence; the same due activation is retried.
- Later Message completion, failure, retry, or cancellation is derived through its Message/Run linkage and does not mutate immutable occurrence activation history.

### 3.5 Context

Define a narrow `ScheduledFollowUpContextOverrides` contract for supported fields such as Environment/revision selection, repository/branch selection, model, reasoning level, and invoked skills where authorization can be preserved safely.

- Reject caller-supplied callback, integration, deputy, title-generation, and arbitrary capability-bearing context.
- Preserve field presence so an explicit override/clear is distinguishable from omission.
- Explicit overrides are validated and fixed when the Scheduled Follow-up is created or edited.
- Unspecified values resolve from the Session's active context when each Occurrence becomes due.
- Persist the immutable effective context on each Occurrence for audit and retry.
- Revalidate live Environment/resource availability at activation; loss of availability is a counted pre-message domain failure.
- Apply repository/environment mutual-exclusion rules from normal follow-up messages.
- When the due Message is inserted, apply its effective codebase/model context consistently with an immediate follow-up. Do not mutate Session context at schedule creation.

### 3.6 Editing and cancellation

- Edits affect future Occurrences only.
- Occurrence rows and consumed occurrence numbers remain unchanged.
- Prompt, schedule, timezone, bounds, or explicit-context edits increment a definition revision.
- A recurrence edit calculates the first eligible instant strictly after the edit time and last consumed scheduled instant; it never replays newly introduced past times.
- Cancelling a Scheduled Follow-up stops future Occurrences and cancels its generated Message if that Message remains pending.
- Cancelling does not cancel a processing/cancelling Message or active Run; that remains a separate explicit action.
- Cancelling only a generated pending Message cancels that Message while recurrence continues.
- A failed generated Message retry remains linked to the same Occurrence and does not consume another occurrence. It conflicts if a newer unfinished Message from the same schedule exists.
- Pending generated Messages cannot be edited through the generic Message PATCH route. Edit the schedule for future work, or cancel the current pending Message.

### 3.7 Paused and archived Sessions

- A due Occurrence in a queue-paused Session creates one pending Message that waits for resume.
- Later due times skip and count while that Message remains unfinished.
- Session archive atomically cancels active schedule definitions and their pending generated Messages.
- An active Run may finish after archive under the existing Session archive contract.

## 4. Persistence model

Add `apps/control-plane/src/db/migrations/023_scheduled_follow_ups.sql` after private-Session migrations 021 and 022.

### 4.1 `scheduled_follow_ups`

Suggested columns:

```text
id uuid primary key
session_id uuid not null references sessions(id)
status text not null               -- active | completed | cancelled
schedule_kind text not null        -- once | recurring
prompt text not null
context_overrides jsonb

run_at timestamptz                 -- one-off
dtstart_local timestamp            -- recurring civil time
timezone text                      -- recurring canonical IANA TZID
rrule text                         -- normalized recurrence body
ends_at timestamptz
max_occurrences integer

next_due_at timestamptz
definition_revision integer not null default 1
scheduler_lock_owner text
scheduler_locked_until timestamptz

created_by_user_id uuid
created_by_session_id uuid
created_by_run_id uuid
created_by_message_id uuid
idempotency_key text

created_at timestamptz not null
updated_at timestamptz not null
completed_at timestamptz
cancelled_at timestamptz
```

Constraints and indexes:

- schedule-kind checks require exactly the applicable one-off or recurring fields;
- recurring effective bounds and 1–100 explicit max checks;
- due partial index on `(next_due_at, created_at)` for active unlocked/expired definitions;
- session/status index for Session management UI and the 25-active limit;
- optional unique `(created_by_run_id, idempotency_key)` for agent idempotency;
- no destructive cascade that silently discards occurrence audit history without an explicit Session-retention decision.

Define “active” for the 25-per-Session limit as a definition eligible to create a future Occurrence. A definition stops occupying a slot as soon as its final due activation is consumed, even if that final Message is still unfinished.

### 4.2 `scheduled_follow_up_occurrences`

Suggested columns:

```text
id uuid primary key
scheduled_follow_up_id uuid not null
occurrence_number integer not null
definition_revision integer not null
scheduled_at timestamptz not null
activated_at timestamptz not null
outcome text not null              -- message_created | skipped | pre_message_failed
reason text
error text
message_id uuid
effective_context jsonb
delivery_metadata jsonb
```

Constraints:

- unique `(scheduled_follow_up_id, occurrence_number)`;
- unique `(scheduled_follow_up_id, scheduled_at)`;
- outcome-specific checks for Message, reason, and error fields;
- occurrence number is the authoritative consumed count; do not maintain an independent mutable counter.

Typed skip/failure reasons should include at least `missed_during_downtime`, `previous_message_unfinished`, `invalid_context`, `resource_unavailable`, and `external_binding_invalid`.

Do not create fictional future Occurrences merely because the Session or schedule is cancelled. Cancellation is definition lifecycle, not a due activation.

### 4.3 Message provenance and Run boundaries

Add nullable typed provenance to `messages`:

```text
scheduled_follow_up_id uuid
scheduled_follow_up_occurrence_id uuid
```

Add a partial unique index allowing only one unfinished Message per Scheduled Follow-up. Preserve this provenance when retrying a failed Message.

Generated follow-up Messages form an isolated Run boundary:

- if the oldest pending Message is generated by a Scheduled Follow-up, claim only that Message;
- a normal batch claims only contiguous normal Messages before the next generated follow-up Message;
- never combine a generated follow-up Message with unrelated pending Messages.

This preserves occurrence-level context, result attribution, and External Thread callback delivery while retaining Session queue order. Use the provenance columns as the boundary marker rather than introducing a generic batching abstraction solely for this feature.

## 5. Atomic store operations and scheduler algorithm

Implement a dedicated `ScheduledFollowUpStore` in `store/types.ts`, with Memory and Postgres parity, row mappings, and telemetry registration.

### 5.1 Create transaction

`createScheduledFollowUp` must atomically:

1. lock and reload the target Session;
2. reject archived Sessions;
3. enforce at most 25 active definitions for the Session;
4. enforce the 10-active-per-agent-Run limit for agent principals;
5. return an existing definition for an idempotent agent replay without consuming quota;
6. insert the definition and Session event;
7. return events for publication only after commit.

The agent's `shouldPersist` callback remains an entry gate. If strict active-lease ownership is available, pass its predicate into the transaction; otherwise document parity with the existing deputy mutation guarantee.

### 5.2 Claim and activation transaction

Claim due definitions with the existing `FOR UPDATE SKIP LOCKED` lease pattern. Every definition edit increments `definition_revision` and clears its lease.

Use one lock order everywhere: **Session, then Scheduled Follow-up**.

`activateDueScheduledFollowUp` must atomically:

1. lock/reload Session and definition;
2. verify `status = active`, lease owner, lock expiry, and claimed definition revision;
3. stop with no writes if edit, cancellation, or archival won the race;
4. enumerate due instants from persisted `next_due_at` through scheduler `now`, bounded by remaining occurrence numbers and inclusive `ends_at`;
5. insert immutable skipped rows for all but the latest due instant;
6. for the latest instant, check relationally whether the schedule has an unfinished Message;
7. resolve and validate effective context and trusted External Thread delivery;
8. insert either a skipped/failed Occurrence or an Occurrence plus Message, message sequence, and events;
9. advance from the last enumerated scheduled instant, not from wall-clock `now`;
10. set `next_due_at = NULL`, `status = completed`, and `completed_at` when no eligible Occurrence remains;
11. clear the lease and commit;
12. publish returned events and wake ordinary workers after commit.

Reserve deterministic occurrence and Message IDs before insertion so a crash/retry converges. Infrastructure failure rolls back the transaction and leaves the due activation retryable.

### 5.3 Edit, cancel, and archive transactions

- Edit locks Session then definition, validates current tenant authorization at the service boundary, increments revision, clears lease, and calculates the next future instant.
- Cancel locks Session then definition, marks it cancelled, clears due/lease fields, and cancels its one pending generated Message with a `message_cancelled` event.
- Extend the existing Session archive transaction to cancel all active Scheduled Follow-ups and their pending generated Messages before commit.
- All three fence stale scheduler work through status, lease owner, and definition revision.

## 6. Service, API, events, and authorization

### 6.1 Service

Add `apps/control-plane/src/scheduled-follow-ups/service.ts` to own:

- schedule validation and normalization;
- authoritative preview;
- context-override validation;
- create/get/list/update/cancel/history operations;
- due activation classification;
- provider-neutral external-target resolution;
- conversion of store conflicts to stable domain errors.

Do not put session creation or Automation Invocation behavior into this service.

### 6.2 Session authorization

- Session-scoped GET routes reuse `canReadSession`, including non-disclosing owner-only access for private Sessions.
- Create, update, and cancel routes reuse `canWriteSession`; private mutations run under the shared private-Session write lease supplied by Session middleware.
- Agent actions use `AgentPrincipal` and `agentCanManageSession`: tenant targets are available regardless of lineage, while private targets require a currently private, same-owner acting Session. All targets must be non-archived.
- Every agent action is serialized with promotion through the acting Session lease. Mutations also retain the `shouldPersist` active-Run lease gate and record acting Session, Run, and Message provenance.
- Scheduler activation does not reauthorize a human or agent creator. It checks current Session/archive state and live Environment/resource validity only.

Keep these checks in authorization helpers and service entry points rather than duplicating role or lineage comparisons in routes, the Pi wrapper, or scheduler code.

### 6.3 Session-scoped HTTP API

Add `apps/control-plane/src/app/scheduled-follow-up-routes.ts` and register routes beneath existing Session authorization middleware:

```text
POST   /sessions/:sessionId/scheduled-follow-ups
POST   /sessions/:sessionId/scheduled-follow-ups/preview
GET    /sessions/:sessionId/scheduled-follow-ups
GET    /sessions/:sessionId/scheduled-follow-ups/:followUpId
PATCH  /sessions/:sessionId/scheduled-follow-ups/:followUpId
DELETE /sessions/:sessionId/scheduled-follow-ups/:followUpId
GET    /sessions/:sessionId/scheduled-follow-ups/:followUpId/occurrences
```

Requirements:

- list/history pagination is bounded and cursor-based;
- serialized records expose `canManage` from the current principal;
- server preview returns normalized schedule plus the next several absolute/display times;
- external callers cannot supply occurrence outcome, next due time, callback target, consumed count, creator provenance, or scheduler fields;
- add response schemas and stable validation/conflict errors.

### 6.4 Events

Add typed Session events for definition creation/update/cancellation/completion and occurrence creation/skipping/failure. Event payloads include safe identifiers, scheduled instant, occurrence number, outcome/reason, and Message ID where present.

Pre-message failures must be visible without fabricating a Message or Run. Add a `followUps` detail-resource invalidation in the web event planner; Session archive invalidates both Session lifecycle and Scheduled Follow-ups.

## 7. Trusted External Thread delivery

Current callback data is Message-scoped, and External Thread lookup is only by provider/external ID. Add a reverse binding contract such as `getExternalThreadsForSession(sessionId)` and audit current data before deciding whether to enforce unique `external_threads(session_id)`.

The intended domain invariant is one originating External Thread per integration-created Session. If existing data confirms it, add the unique index; otherwise retain list semantics and fail closed rather than silently fan out until cardinality is explicitly resolved.

Add a provider registry:

```ts
resolveExternalThreadTarget(thread): SlackTarget | GitHubTarget | null
```

It must:

- parse and validate persisted provider metadata with typed Slack/GitHub target helpers;
- enforce current GitHub installation/allowlist and Slack workspace configuration;
- never pass arbitrary metadata or old Message callback JSON through as a trusted target.

At occurrence activation, resolve a fresh trusted target and attach only the server-generated callback target to the isolated generated Message. Callback retries may retain that immutable trusted target.

Generalize callback payloads into a discriminated union so a pre-message occurrence failure can enqueue an idempotent delivery without a Message or Run. Derive its delivery ID from Occurrence ID and event type. Successful Run results continue through ordinary completion callbacks; terminal Run failures should use existing provider failure-notification behavior where available and gain equivalent provider coverage as part of this slice.

Do not enable Scheduled Follow-ups for externally bound Sessions until trusted reverse delivery is complete.

## 8. Dedicated agent tool

Add a dedicated Pi tool named `scheduled_follow_ups`, rather than expanding the `deputies` action schema.

Actions:

```text
create
preview
list
get
update
cancel
list_occurrences
```

The tool accepts a target `sessionId`, prompt, discriminated schedule, supported context overrides, and an idempotency key for creation. It derives acting Session, Run, and Message provenance internally and cannot spoof user identity or callback targets.

Integration points:

- a provider-neutral core executor next to the session/deputy tooling;
- a Pi definition wrapper next to `runner-pi/deputy-tool.ts`;
- runner option/service injection and per-Run creation state;
- forwarding of the existing `shouldPersist` gate;
- always-on registration for Pi runs.

Enforce atomically:

- current agent Session authority under a valid Run lease: any tenant target, plus same-owner private targets only while the acting Session remains private;
- 10 active definitions per agent Run; completed and cancelled definitions no longer consume this quota;
- 25 active definitions per target Session;
- idempotent replay does not consume quota;
- archived target rejection;
- 100-occurrence hard cap.

## 9. Human web experience

### 9.1 Composer

Extend `MessageComposer` with a Send-now/Schedule-send choice. Schedule send opens structured controls for:

- once: local date, time, and timezone;
- recurring: common hourly/daily/weekly/weekday patterns;
- optional end date and/or maximum occurrences;
- explicit supported context overrides already available to the composer.

The client requests authoritative server preview and shows the next several occurrences before saving. It never constructs or trusts arbitrary advanced RRULE text as final authority.

On successful scheduling, clear the composer just as successful immediate send does. On failure, restore prompt and selected context.

### 9.2 Session management and timeline

Add a Session-level Scheduled Follow-ups section to inspect active/completed/cancelled definitions and paginated occurrence history. Support edit, cancel, and clone/renew. Keep it out of global Automation management.

Scheduling creates a compact Session timeline event/card immediately, not a Message. Due activation creates the ordinary Message card. Display:

- next due time and timezone;
- remaining bounds;
- active/completed/cancelled state;
- paused-queue waiting state;
- skipped and pre-message-failed reasons;
- creator provenance where appropriate.

Add client API types/functions and realtime invalidation through `session-event-plan.ts` and the selected-session resource coordinator. Do not trigger broad Session-detail reloads.

## 10. Safe implementation slices

### Slice 0 — Recurrence and contract spike

- Select and pin RRULE/timezone libraries.
- Implement pure schedule validation, normalization, preview, and next/due expansion.
- Prove DST gaps/overlaps, `Australia/Lord_Howe`, leap/month-end behavior, bounds, edit cutovers, and process-timezone independence.
- Finalize typed context overrides, tenant-role checks, and the scheduled-follow-up agent authorization helper.

Exit: deterministic fixtures define every supported recurrence behavior before persistence depends on it.

### Slice 1 — Additive persistence and atomic invariants

- Add migration 023, records, store interfaces, row mappings, Memory/Postgres parity, and telemetry registration.
- Add Message provenance and modify claim batching to isolate generated follow-up Messages.
- Implement create/edit/cancel/activate/archive transactions with revision fencing.

Exit: concurrent Postgres tests prove create-limit, archive-versus-due, cancel-versus-due, retry-versus-next-occurrence, lease-expiry, and stale-revision behavior.

### Slice 2 — One-off service and internal API

- Implement one-off validation/preview and one-off scheduler activation.
- Add session-scoped CRUD/history routes and events.
- Process isolated generated Messages through the existing worker.

Exit: transactionally at most one Message across scheduler crash/retry; provider callback delivery is at-least-once. Late execution, paused queue, cancellation, and archive semantics match the contract.

### Slice 3 — Bounded recurrence

- Enable constrained RRULE persistence and preview.
- Implement due-batch materialization, occurrence counting, latest-only catch-up, overlap skipping, bounds, and edit cutovers.

Exit: each due instant has one occurrence number, no recurring backlog forms, and no definition exceeds 100 occurrences.

### Slice 4 — Trusted Slack/GitHub delivery

- Add reverse External Thread lookup and trusted provider resolvers.
- Attach fresh trusted completion targets to isolated Messages.
- Add idempotent pre-message failure deliveries.
- Cover successful and terminal-failure provider behavior.

Exit: integration-bound Sessions always receive results/failures in their External Thread or retain a visible durable delivery failure; no callback target comes from caller input.

### Slice 5 — Human web UI

- Add schedule-send controls, preview, Session management/history, timeline cards, and focused realtime invalidation.

Exit: create/edit/cancel/history survive refresh and reconnect; failed submission restores composer state; archive cancellation is visible.

### Slice 6 — Dedicated agent tool

- Add the `scheduled_follow_ups` tool, idempotency, quotas, Session-scoped agent authorization, and provenance.

Exit: concurrent calls cannot exceed quotas, stale runs cannot persist beyond the chosen deputy-equivalent guarantee, and idempotent replay returns the same definition.

### Slice 7 — Deployment

Scheduled Follow-ups are always on with no controlled rollout flags. **Hard requirement:** first complete the private-Session rollout through migrations 021 and 022, then stop and drain all old API and worker processes, apply migration 023, and deploy new API/workers with a blue-green or stop-the-world cutover. A mixed old worker and new scheduler/API deployment is unsupported. Configure provider access before using externally bound Sessions.

## 11. Verification

### Control-plane unit tests

- schedule validation, canonicalization, preview, bounds, and DST fixtures;
- Viewer read-only and Member/Admin create/update/cancel behavior;
- creator removal or role change does not affect activation;
- active Session, paused Session, archived Session, and archive/unarchive behavior;
- same-schedule unfinished-message skip;
- unrelated pending work preserves ordering and isolated Run boundaries;
- downtime enumeration and latest-only catch-up;
- domain failure consumes one occurrence and recurrence continues;
- infrastructure failure consumes none;
- context override/inheritance and live resource revalidation;
- immutable history and future-only edits;
- cancellation of pending but not active generated work;
- failed Message retry provenance and conflicts;
- human and agent quota/idempotency behavior;
- trusted Slack/GitHub target reconstruction and pre-message failure delivery.

### Postgres integration tests

- migration constraints and indexes;
- concurrent active-limit creation;
- concurrent agent quota creation and idempotent replay;
- two scheduler workers claiming due definitions;
- crash after claim and retry after lease expiry;
- edit/cancel/archive racing activation;
- sequence allocation and Message/Occurrence atomicity;
- partial unique unfinished-Message enforcement;
- retry racing a later occurrence;
- Session archive atomically cancels definitions and pending generated Messages;
- reverse External Thread lookup/cardinality.

### Web tests

- schedule-send form and structured recurrence generation;
- server preview rendering across timezone changes;
- composer reset/restore behavior;
- Session-scoped list/history loading and pagination;
- edit/cancel/clone actions;
- timeline cards and occurrence statuses;
- realtime follow-up-resource invalidation without broad detail refresh;
- read-only/archived/paused access states.

### Targeted repository checks

```sh
mise run //apps/control-plane:typecheck
mise run //apps/control-plane:test
mise run //apps/control-plane:test:integration
mise run //apps/web:typecheck
mise run //apps/web:test
mise run //apps/web:build
```

Run Postgres migration/integration checks with the repository's direct Postgres helper when nested Docker is unavailable.

## 12. Observability and deployment guards

Add metrics/log fields for:

- due lag (`activated_at - scheduled_at`);
- claim count and stale-lease recovery;
- occurrence outcomes and typed reasons;
- schedules completed by count, end time, cancellation, or archive;
- uniqueness/revision-fence conflicts;
- active definitions per Session;
- generated Message queue wait and Run outcome;
- trusted-target resolution and callback delivery failures;
- agent quota rejection and idempotent replay.

Alert on sustained due lag, duplicate/uniqueness conflicts, repeated pre-message failures, or provider delivery failures. Do not log prompt text, arbitrary context, credentials, or callback secrets.

## 13. Dependencies and deferred decisions

- Audit existing External Thread cardinality before adding a unique reverse-binding constraint.
- Confirm the chosen RRULE/timezone library with the Slice 0 spike before migration fields or API normalization are frozen.
- Retention/deletion of immutable Occurrence history should follow the Session retention policy; do not invent an independent retention system in this feature.
- Any future Automation RRULE support must preserve existing UTC cron schedules and is explicitly outside this plan.
