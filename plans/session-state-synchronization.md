# Plan: Unify web session state synchronization and eliminate broad refresh fanout

Status: in progress (2026-07-20)
Scope: `apps/web` (session state ownership, realtime reconciliation, mutation handling, recovery, and request instrumentation); targeted `apps/control-plane` contract tests only if existing event guarantees are not already covered

## 1. Problem and current state

A network recording of one follow-up message exposed roughly 30 follow-up requests across the
message lifecycle. The initial `POST /sessions/:id/messages` completed quickly and returned the
new pending message, but the client then combined several independent refresh mechanisms:

- `handleSendMessage` optimistically inserted the returned message, refreshed the first session
  page, and ran a complete selected-session detail refresh.
- `loadSessionDetailPhases` fetched messages, up to 1,000 historical events, artifacts, external
  resources, callbacks, and services.
- realtime lifecycle events called `refreshSessionOutputs`, which fetched messages, artifacts,
  services, external resources, and callbacks for every qualifying event type.
- the same events independently called both `refreshLoadedSessionSummary` and
  `scheduleSessionsRefresh`, producing `GET /sessions/:id` and `GET /sessions?limit=50` for the
  same event burst.
- the current in-flight output-refresh guard serializes broad refreshes but deliberately runs a
  second complete five-request batch if any invalidation arrives while the first is in flight.

The recording is a symptom, not an isolated message-submission defect. Equivalent broad refresh
patterns exist across the application:

- retrying failed messages patches returned messages and then reloads all six detail resources;
- callback replay patches the callback and then reloads all six detail resources;
- sandbox keepalive extension reloads five output resources;
- created-session backfill repeatedly reloads all six detail resources until the first message
  settles;
- wake recovery and hidden-to-visible recovery can independently refresh both the session list
  and all selected-session detail resources;
- realtime session/message/sandbox events overlap summary and first-page list reconciliation;
- initial REST detail phases can replace state that changed through realtime events after the
  request began.

Most of this behavior is owned ad hoc by `apps/web/src/app.tsx`. It contains the global stream,
session list and selected-summary requests, detail replacement, mutation generations, authority
epochs, optimistic rollback, created-session backfill, reconnect handling, and visibility
recovery. Existing reusable pieces are limited to:

- pure event/progress reducers in `apps/web/src/app-state.ts`;
- phased bootstrap loading in `apps/web/src/session-detail-loader.ts`;
- a single-resource invalidation/debounce precedent in
  `apps/web/src/session-skill-catalog.ts`.

The underlying problem is therefore **call-site-owned synchronization**: each event or mutation
decides which broad loader to invoke. The target is **resource-owned synchronization**: all
sources of change flow through one event/effect policy and two bounded reconcilers.

## 2. Goals and non-goals

### Goals

1. Preserve immediate optimistic display of mutation responses, especially a submitted message.
2. Reduce a normal complete follow-up lifecycle from roughly 30 follow-up data requests to a
   target of 5–8.
3. Prevent normal live operation from fetching full event history.
4. Fetch only resources affected by an event or mutation.
5. Ensure one event burst chooses either a loaded-session summary refresh or a first-page list
   refresh, never both for the same generation.
6. Preserve correctness when realtime delivery is delayed, reconnects, replays events, misses
   events, or the page resumes after sleep.
7. Prevent stale REST snapshots from overwriting newer mutation or realtime state.
8. Preserve active filters, pagination, archived sessions, child sessions, search hydration,
   optimistic rollback, session selection, and browser milestone meaning.
9. Make request amplification measurable by interaction and difficult to reintroduce.

### Non-goals

- Do not replace the application state model with Redux, React Query, or another general cache
  library. Realtime ordering, per-session cursors, filtered list membership, optimistic mutation
  responses, and recovery still require domain-specific coordination.
- Do not add an aggregated detail API solely to reduce live-mode fanout. Aggregation may later
  improve initial-selection latency, but it does not solve broad invalidation.
- Do not rewrite the session UI or split `app.tsx` for cosmetic reasons. Extract only coherent,
  testable synchronization responsibilities.
- Do not require contiguous event sequences. Event compaction can produce valid gaps.
- Do not add unbounded automatic retries. Recovery must be bounded and driven by a newer
  invalidation, explicit recovery, or user action.

## 3. Design decisions

### 3.1 Distinguish bootstrap, live, and recovery modes

The current implementation uses full detail loading in all three situations. The new design gives
each mode an explicit contract.

#### Bootstrap/selection mode

Purpose: establish a complete selected-session snapshot when there is no usable local authority.

Allowed requests:

- messages;
- retained event history;
- artifacts;
- external resources;
- callbacks;
- services;
- session list or selected-session summary as required by selection.

`loadSessionDetailPhases` remains the bootstrap loader. This is the only routine mode in which a
non-incremental event-history request is expected.

#### Live mode

Purpose: apply mutation responses and realtime events with minimal authoritative reconciliation.

Rules:

- complete mutation responses update their returned entities directly;
- complete event payloads are validated and applied directly;
- partial event payloads invalidate only affected resources;
- no full detail reload;
- no full event-history reload;
- session presentation chooses summary, list, or neither;
- repeated invalidations coalesce by resource.

Normal message submission, retry, cancellation, callback replay, sandbox controls, and realtime
lifecycle events operate in live mode.

#### Recovery mode

Purpose: converge after reconnect, sleep, a stream delivery gap, or uncertain state.

Default flow:

1. reconnect or confirm the global event stream;
2. reconcile the first session page once;
3. request selected-session events after the current session sequence;
4. feed recovered events through the same event planner used by live SSE;
5. reconcile only resources dirtied by those events;
6. fetch `GET /sessions/:id` only if the selected session is not represented by the list result;
7. use a full bootstrap snapshot only when there is no usable selected-session cursor or snapshot.

### 3.2 Introduce a pure session event planner

Replace the broad `shouldRefreshSessionDetail(eventType)` and overlapping
`shouldRefreshSessions(eventType)` decisions with a pure planner that accepts the complete event:

```ts
type DetailResource = 'messages' | 'artifacts' | 'services' | 'externalResources' | 'callbacks';

type SessionPresentationEffect = 'none' | 'summary' | 'list';

type SessionEventPlan = {
  detailResources: ReadonlySet<DetailResource>;
  sessionEffect: SessionPresentationEffect;
  directActions: readonly DirectSessionAction[];
};
```

Every event source uses this planner:

- live global SSE;
- incremental reconnect/resume recovery;
- submission fallback recovery;
- tests and simulated events.

The planner must remain pure. Executing requests, checking selection, and applying state belong to
the coordinators and reducers.

### 3.3 Add a selected-session resource coordinator

The selected-detail coordinator owns independent synchronization for:

- messages;
- artifacts;
- services;
- external resources;
- callbacks.

Recommended state:

```ts
type ResourceRefreshState = {
  sessionId: string;
  selectionVersion: number;
  pending: Set<DetailResource>;
  versions: Map<DetailResource, number>;
  inFlight: Set<DetailResource>;
  timer: number | null;
};
```

Invalidation semantics:

1. Ignore an empty or non-selected session ID.
2. Increment each resource generation.
3. Add each resource to `pending`.
4. If no affected resource is in flight, start or reset a 100–150 ms trailing timer.
5. If an affected resource is in flight, leave the resource pending; do not start a parallel
   request.

Flush semantics:

1. Snapshot and clear pending resources.
2. Capture authority epoch, selected session ID, selection version, and each resource generation.
3. Start only the endpoints in the snapshot.
4. Apply successful responses independently, equivalent to `Promise.allSettled` semantics.
5. Apply a resource only if authority, selection, session ID, and its generation still match.
6. If a generation advanced during the request, discard the stale response and let the pending
   generation own final state.
7. After requests settle, immediately schedule one final flush if pending resources remain.
8. Do not automatically retry a failed endpoint without a newer invalidation or explicit recovery.

This replaces `refreshSessionOutputs`. It must not wrap the old five-request batch.

### 3.4 Add a session-index coordinator

The session-index coordinator owns the relationship among:

- first-page active session list;
- loaded individual session summaries;
- selected session outside the current first page;
- active filters;
- archived, child, and search-derived rows;
- existing pagination and mutation generations.

Routing policy:

1. **Summary reconciliation** when the session is already loaded, no active filters can change
   membership, and only status/title/context/sandbox/activity data changed.
2. **First-page list reconciliation** for structural membership changes, active filters, an
   unloaded session that could enter the first page, reconnect/resume recovery, and explicit list
   refresh.
3. **No session request** for resource-only and progress-only events.

Add a 100–200 ms per-session trailing debounce for summary reconciliation. Preserve existing
mutation-version and authority-epoch protections.

When a list request starts, capture summary generations for sessions represented by that page. A
successful list response may satisfy generations that have not advanced. A newer event arriving
during the list request must remain pending and run afterward. This prevents both duplicate reads
and stale list responses.

### 3.5 Apply complete mutation responses directly

Every mutation must be classified into one of three policies.

#### Complete entity response

Apply by ID immediately and do not refetch that entity solely to confirm the mutation. Candidate
paths include:

- enqueue message;
- edit or cancel a queued message;
- retry messages when complete messages are returned;
- pause/resume queue when a complete session is returned;
- title, tags, star, archive, and unarchive mutations;
- callback replay when a complete callback is returned;
- opening a workspace tool when complete session/service records are returned.

#### Partial response

Invalidate only affected authoritative resources. Candidate paths include:

- cancelling an active run: messages and summary;
- sandbox keepalive extension: services and summary;
- mutations whose response acknowledges the operation but omits resulting state.

#### Structural change

Reconcile the first-page list only when membership, ordering, pagination, or filters may change.

Existing optimistic rollback and mutation versions remain authoritative. The coordinators consume
those versions rather than introducing a parallel mutation model.

### 3.6 Keep full detail loading bootstrap-only

`refreshSessionDetail` currently serves selection, live mutation, manual refresh, and recovery
roles. Split those semantics explicitly:

- `loadSelectedSessionSnapshot` (or equivalent existing function) for bootstrap/selection;
- keyed invalidation for live reconciliation;
- incremental event recovery for reconnect/resume;
- an explicit user full-refresh action may invoke bootstrap behavior when that is the intended UX.

After migration, add a test that fails if live-mode interactions call events without `after`.

### 3.7 Make state application generation-safe

Every asynchronous read captures:

- authorization/authority epoch;
- selected session ID;
- selection version;
- relevant resource or summary generation.

All must still match before applying the response.

Additional invariants:

- `eventCursor` advances with `Math.max` and never decreases;
- global event IDs and per-session event sequences are never interchanged;
- initial REST events merge with live events by sequence instead of replacing them;
- mutation and event upserts dedupe by stable entity ID;
- event replay is idempotent;
- selection and auth changes clear timers and make old responses ineligible;
- refs used by event-time decisions update in the same state transition as React state, avoiding a
  one-render stale-ref window.

### 3.8 Treat created-session backfill as a separate migration

Created-session startup has a wider race surface because the selected session, first message,
detail snapshot, and stream can all become authoritative in different orders.

Migration order:

1. Keep bounded existing backfill initially.
2. Route backfill results through generation-safe application.
3. After live and recovery coordination is stable, replace repeated full snapshots with
   incremental events plus messages.
4. Retain one bounded full-snapshot fallback if the stream never establishes or no usable cursor
   exists.

Do not make created-session backfill a blocker for eliminating broad follow-up-message and event
fanout.

## 4. Event-to-action matrix

| Event                                                      | Selected-session action                                                                                     | Session-index action                               | Notes                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `session_created`                                          | None unless selected through creation flow                                                                  | List                                               | Discovers a structurally new row.                                          |
| `session_spawned`                                          | None                                                                                                        | Summary for loaded parent when child count changes | Child discovery remains driven by creation/list behavior.                  |
| `session_updated`                                          | Patch complete safe fields; reconcile services only when service descriptors changed                        | Summary                                            | Do not fetch services for unrelated context/title changes.                 |
| `session_archived`, `session_unarchived`                   | Clear/update selection when necessary                                                                       | List                                               | Changes active/archived membership and filters.                            |
| `session_queue_paused`, `session_queue_resumed`            | None                                                                                                        | Summary                                            | Returned mutation sessions should be applied immediately locally.          |
| `message_created`                                          | Messages unless the same ID was already applied from a local mutation                                       | Summary                                            | Event payload is partial.                                                  |
| `message_updated`                                          | Messages                                                                                                    | Usually none                                       | Ensure this currently underrepresented event is handled.                   |
| `message_started`                                          | Messages                                                                                                    | Summary                                            | Reconciles processing state.                                               |
| `message_completed`, `message_failed`, `message_cancelled` | Messages                                                                                                    | Summary                                            | Reconciles terminal state and possible queued siblings.                    |
| `run_cancel_requested`, `run_cancelled`, `run_failed`      | Messages                                                                                                    | Summary                                            | Handles active-run and stale-run recovery paths.                           |
| `run_started`, `run_completed`                             | Event insertion only                                                                                        | None                                               | Message lifecycle events drive authoritative message reconciliation.       |
| `sandbox_starting`                                         | Event insertion only                                                                                        | Summary only if serialized display state changes   | Avoid redundant reads when `message_started` already establishes activity. |
| `sandbox_ready`                                            | Clear stale services after create/restart; fetch services only when descriptors indicate published services | Summary                                            | Do not confirm known-empty services immediately.                           |
| `sandbox_stopped`, `sandbox_destroyed`                     | Clear services directly                                                                                     | Summary                                            | No services GET is needed to confirm terminal emptiness.                   |
| `sandbox_keepalive_extended`                               | Services                                                                                                    | Summary                                            | Reconciles availability/timing.                                            |
| `artifact_created`                                         | Validate and upsert complete artifact payload                                                               | None                                               | Dedupe by artifact ID.                                                     |
| `external_resource_created`                                | Validate and upsert complete resource payload                                                               | None                                               | Dedupe by resource ID.                                                     |
| callback lifecycle events                                  | Callbacks                                                                                                   | None                                               | Payloads are partial; retry bursts debounce to one read.                   |
| `skills_loaded`                                            | Existing skill-catalog invalidation                                                                         | None                                               | Preserve current behavior.                                                 |
| text/tool/progress/setup events                            | Existing event/progress reducers                                                                            | None                                               | No normalized-resource read.                                               |

If `session_updated.payload.context` is contractually a complete context snapshot, compare normalized
service descriptors and dirty services only when they changed. If that contract cannot be verified,
initially use the conservative rule “context present means services dirty,” then tighten after adding
the server contract test. Even that conservative rule is narrower than refreshing five resources.

## 5. Mutation-specific behavior

### 5.1 Follow-up message submission

1. Record selected session ID, selection version, and current per-session event sequence.
2. Call `enqueueMessage`.
3. Upsert the returned message by ID; never blindly append.
4. Preserve the existing optimistic session context/status/timestamp update and auto-follow.
5. Return success without awaiting a list or detail refresh.
6. Expect the corresponding `message_created` event.
7. If it is not observed within approximately 750–1,000 ms, request events after the recorded
   sequence and process them through the event planner.
8. If the expected event is still absent, invalidate messages and selected-session summary once.
9. Cancel fallback work on selection change, auth change, unmount, or matching event receipt.

Remove both current broad calls from `handleSendMessage`:

- `refreshSessions()`;
- `refreshSessionDetail(selectedSessionId, 'refresh')`.

Submission should no longer emit the three detail/output/services `'refresh'` browser milestones,
because those phases no longer run. Do not preserve misleading telemetry by retaining the requests.
If submit latency needs measurement, introduce a separately named submit-to-optimistic-display or
submit-to-first-lifecycle-event metric later.

### 5.2 Retry and cancellation

- Upsert messages returned by retry.
- Let subsequent lifecycle events dirty messages and summary.
- Apply complete queued-message cancellation/edit responses directly.
- Active-run cancellation may dirty messages and summary because the acknowledgement can precede
  final resulting states.
- Do not invoke the full selected-session loader.

### 5.3 Callback replay

- Apply a complete returned callback immediately.
- Later callback events dirty only callbacks.
- Remove the full detail refresh.

### 5.4 Sandbox controls

- Keepalive extension dirties services and summary only when the mutation response does not contain
  complete resulting state.
- Workspace-tool responses continue to apply returned session/service records directly.
- Stopped/destroyed events clear services locally and dirty summary; they do not fetch all outputs.

### 5.5 Archive, restore, metadata, star, and queue controls

- Preserve existing optimistic updates, mutation versions, and rollback behavior.
- Reconcile the list only when active filters or structural membership require it.
- Complete returned sessions satisfy summary state directly.
- Do not let general event handling issue both summary and list reads after the mutation.

## 6. Recovery and cursor behavior

### 6.1 Normal stream operation

- Upsert events by per-session sequence.
- Batch active text deltas using existing behavior.
- Advance the session event cursor monotonically.
- Do not read event history in response to ordinary lifecycle events.

### 6.2 Stream reconnect

The global server stream already supports cursor replay. On failure:

1. mark recovery pending;
2. do not refresh the list on every reconnect attempt;
3. once the stream successfully reopens, run one recovery flow;
4. refresh the first-page list once;
5. request selected events after `eventCursor` once;
6. process events through the common planner;
7. flush resulting detail-resource invalidations.

Do not advance `globalEventCursor` using per-session REST events. Their global IDs can skip unread
events for other sessions.

### 6.3 Page resume

Consolidate wake-recovery and hidden-to-visible effects into one idempotent operation:

1. recover/reconnect stream;
2. refresh first-page list once;
3. read selected events after cursor;
4. reconcile affected resources;
5. use one selected-summary fallback only when the selected row is absent from the first page.

Multiple online, visibility, and long-tick signals must coalesce into one recovery generation.

### 6.4 Auth changes

Reset and clear:

- global event cursor;
- selected-session event cursor;
- authority epoch;
- selection generation as appropriate;
- pending resource and summary invalidations;
- debounce timers;
- submission fallback timers;
- queued recovery work.

An event cursor must not survive a change to the authorization identity whose visibility filtering
produced it.

## 7. Implementation phases

### Phase 1: Instrument request amplification

Files:

- `apps/web/src/app.test.tsx`;
- existing API test/mocking helpers;
- minimal production telemetry only if endpoint-level metrics are currently unavailable.

Tasks:

1. Count requests by normalized endpoint class.
2. Associate requests with interaction type and synchronization mode where practical.
3. Add baseline scenarios for initial selection, follow-up submission, retry, cancel, callback
   replay, sandbox extension, archive/restore, reconnect, resume, and creation backfill.
4. Assert current behavior only where needed to demonstrate the problem; target tests should be
   introduced with each migration to avoid locking broad behavior in permanently.

### Phase 2: Define event synchronization plans

Files:

- `apps/web/src/app-state.ts` or a focused new synchronization module;
- pure unit tests.

Tasks:

1. Define `DetailResource`, direct actions, and session presentation effects.
2. Implement the event-to-action matrix.
3. Add runtime validation for complete artifact/external-resource payloads.
4. Test every normalized event type.

### Phase 3: Harden stale-response handling

Files:

- `apps/web/src/app.tsx`;
- `apps/web/src/session-detail-loader.ts` only if phase metadata is required;
- tests.

Tasks:

1. Add/standardize selection generations.
2. Make event cursor monotonic.
3. Merge initial REST events with newer live events.
4. Prevent older messages/resources/summaries from overwriting newer generations.
5. Reset auth-scoped cursors and work queues.
6. Keep refs used by stream decisions synchronized with state updates.

### Phase 4: Add selected-resource and session-index coordinators

Files:

- preferably focused modules under `apps/web/src/`;
- `apps/web/src/app.tsx` integration;
- deterministic coordinator tests with fake timers.

Tasks:

1. Implement keyed dirty resources and per-key generations.
2. Implement summary-versus-list routing and summary debounce.
3. Integrate existing mutation versions, list request IDs, and authority epoch.
4. Apply independent resource responses independently.

### Phase 5: Route realtime events through the planner

Files:

- `apps/web/src/app.tsx` global stream handler;
- `apps/web/src/app-state.ts` broad predicates removed/replaced;
- app integration tests.

Tasks:

1. Replace `shouldRefreshSessionDetail` broad output refreshes.
2. Replace unconditional summary plus scheduled-list refreshes.
3. Apply direct artifact/resource/service-clearing actions.
4. Preserve existing event and active-progress reducers.

This phase should remove most recorded event-driven fanout before mutation handlers migrate.

### Phase 6: Migrate all live mutations

Order:

1. follow-up message submission;
2. retry, edit, queued cancellation, and active-run cancellation;
3. callback replay;
4. sandbox controls;
5. archive/restore and metadata mutations;
6. queue controls.

Each conversion must include an interaction-specific request-budget test.

### Phase 7: Consolidate reconnect and resume recovery

Files:

- `apps/web/src/app.tsx` visibility/wake/stream effects;
- `apps/web/src/api-request.ts` or `apps/web/src/api.ts` if a stream-open callback is required;
- recovery tests.

Tasks:

1. Introduce one recovery generation.
2. Trigger recovery once after successful stream reopening.
3. Use incremental selected events.
4. Reuse the event planner and coordinators.
5. Remove duplicate full-detail recovery calls.

### Phase 8: Make created-session backfill incremental

Tasks:

1. Replace repeated full snapshots with incremental events plus messages.
2. Preserve bounded fallback and sign-out/selection abort behavior.
3. Retain one full snapshot only when no usable local authority exists.

### Phase 9: Remove obsolete broad live paths

Tasks:

1. Remove `refreshSessionOutputs`.
2. Restrict the full detail loader to bootstrap/selection/manual-full-refresh call sites.
3. Remove stale broad predicates.
4. Add an architectural test prohibiting non-incremental event reads in live mode.

## 8. Verification plan

### Pure planner tests

- Every event type maps to an explicit action.
- Message events never dirty artifacts/services/external resources/callbacks.
- Callback events dirty only callbacks.
- Sandbox stopped/destroyed clears services without reading services.
- Artifact and external-resource payloads validate, upsert, and dedupe by ID.
- `session_updated` dirties services only according to the verified context contract.

### Coordinator tests

1. Ten same-resource invalidations before debounce produce one request.
2. Invalidation during an in-flight request causes the stale response to be discarded and exactly
   one final request to run.
3. Different resources in one burst each issue one request.
4. Failure of one resource does not block successful sibling resources.
5. Selection change makes all old responses ineligible and clears queued work.
6. Auth change resets cursors, timers, and pending work.
7. Duplicate event replay creates no duplicate entity and no unnecessary settled refresh.
8. A list response satisfies only summary generations captured before that request.
9. A newer summary invalidation survives an in-flight list request.

### Application integration tests

- Successful submit shows the pending message before reconciliation.
- Normal submit makes no session-list, full-events, artifacts, services, external-resources, or
  callbacks request.
- Realtime `message_created` arriving before the POST response does not duplicate the message.
- Missing matching realtime delivery invokes `/events?after=<sequence>` once.
- `message_created` plus `message_started` yields at most one debounced messages request before an
  in-flight final rerun is justified.
- One event never triggers both session list and selected summary reads.
- Active filters route membership-sensitive events to the list.
- Unloaded-session activity refreshes the first page.
- Callback retry bursts issue one callbacks request.
- Sandbox stop clears services without a services request.
- A stale REST response cannot change a completed message back to processing.
- A phased bootstrap response cannot remove a newer realtime event or regress the cursor.
- Reconnect replay plus incremental recovery is idempotent.
- Simultaneous wake and visibility signals start one recovery flow.
- Initial selection events request omits `after`; all post-selection recovery requests include it.
- Existing optimistic rollback still preserves interleaved newer mutations.
- Existing pagination, search, archived, child-session, hover-order, and filtered-selection tests
  remain green.

### End-to-end request budgets

Add a Playwright request recorder or equivalent integration harness that groups requests by route
class. Use upper bounds rather than exact counts because lifecycle event timing varies. On threshold
failure, preserve request details as a CI artifact when practical.

Initial whole-lifecycle threshold: no more than 10 follow-up data requests. Tighten to 8 after the
coordinator and recovery work stabilizes.

## 9. Target request budgets

| Interaction                               |                                                       Target data requests |
| ----------------------------------------- | -------------------------------------------------------------------------: |
| Initial app load with selected session    |                                                     1 list + 6 detail GETs |
| Select another session                    |                                                              6 detail GETs |
| Follow-up submit/start                    |                                     1 POST + 1 messages + 1–2 summary GETs |
| Submit with delayed/missed matching event |                                           Above + 1 incremental events GET |
| Message completion                        |                                                 1 messages + 1 summary GET |
| Retry                                     | Mutation request + returned messages; narrow lifecycle reconciliation only |
| Cancel queued message                     |                                 Mutation request; usually no immediate GET |
| Cancel active run                         |                         Mutation request + messages/summary reconciliation |
| Callback replay                           |                                 Mutation request + at most 1 callbacks GET |
| Sandbox keepalive                         |                         Mutation request + services/summary only as needed |
| Sandbox stop/destroy                      |                                      1 summary GET; services clear locally |
| Archive/unarchive                         |         Mutation request + list only when membership/filtering requires it |
| Clean reconnect                           |                       Stream reconnect + 1 list + 1 incremental events GET |
| Resume with missed changes                |         List + incremental events + affected resources, typically 2–5 GETs |
| Explicit full refresh                     |                                     Bootstrap-style behavior is acceptable |

The normal complete message lifecycle target is approximately 5–8 follow-up data GETs, excluding
the long-lived stream and deliberately separate telemetry.

## 10. Rollout and observability

Land the work in independently reviewable stages; a feature flag is unnecessary unless production
lacks enough endpoint-level observability to detect regressions.

Track:

- requests by normalized endpoint and interaction;
- synchronization mode (`bootstrap`, `live`, `recovery`);
- full versus incremental event requests;
- list and summary reads for the same session within 500 ms;
- per-resource invalidation and queued-rerun counts;
- stale-response discard counts;
- submission fallback activation rate;
- reconnect/recovery duration and failure rate;
- event payload validation failures;
- resource reconciliation failures.

Success criteria:

1. Pending mutation responses display immediately.
2. Normal submit/start has no full event-history, list, artifact, external-resource, callback, or
   unrelated service request.
3. No loaded-session lifecycle event triggers both list and summary reads.
4. Empty output endpoints are not repeatedly polled.
5. A contiguous event burst makes at most one request per affected resource, plus one final rerun
   only when invalidated during flight.
6. Resume executes one recovery generation.
7. No increase in stale-message, stale-sandbox, filtered-list, or reconnect-related UI failures.

Annotate telemetry dashboards when normal submission stops emitting detail/output/services
`'refresh'` milestones. Do not silently reinterpret those existing metrics.

## 11. Risks and open questions

### High: stale REST snapshots versus realtime state

Broad refresh removal can expose races currently masked by later reloads. Generation guards and
monotonic event merging must land before or with mutation changes.

### High: `session_updated` context completeness

Verify whether every relevant emission contains a complete context/services descriptor snapshot.
If uncertain, initially invalidate services whenever context is present and tighten later.

### High: auth-scoped global cursor

Ensure global cursor state is reset when authority changes before relying more heavily on stream
replay.

### Medium: filtered and paginated list membership

An individual summary cannot determine every active-filter or first-page membership change.
Preserve list reconciliation for active filters, structural changes, and unloaded-session activity.

### Medium: event-before-mutation-response races

`message_created` may arrive before the POST response. Entity-ID upserts, synchronized refs, and
generation-aware invalidation must prevent duplicate messages and unnecessary reads.

### Medium: browser milestone discontinuity

Removing submission full-detail phases correctly removes their milestone samples. Communicate the
dashboard change and add a separately named submit metric only if needed.

### Medium: created-session bootstrap

Creation has more authority transitions than follow-up mutation. Migrate it after the common live
and recovery paths stabilize.

### Low: direct event payload trust

Artifact and external-resource events appear to carry complete records, but web event payloads are
untyped records. Validate shape and session ownership before direct upsert.

### Deferred: aggregated bootstrap snapshot

Consider only if initial selection remains a measured bottleneck after live fanout is fixed. This
is a consistency feature as well as a request-count optimization: merely bundling six unrelated
reads does not create a snapshot and must not be treated as newer authority.

#### Problem the extension solves

Independent bootstrap requests can observe different committed server states. For example, the
active list may be read before an archive mutation while the selected summary and groups are read
after it. Without server-provided revision metadata, the client can reject responses invalidated by
newer local work, but it cannot determine which committed server state each response represents or
identify an exact snapshot-to-stream handoff.

The extension should provide two related values:

- a **snapshot revision**, identifying the committed state represented by every included resource;
- an **event high-water cursor**, meaning all applicable events through that cursor are reflected
  in the snapshot and changes after it are available through replay.

The resulting bootstrap and replay boundary is:

1. atomically read bootstrap state and its event high-water cursor;
2. apply the snapshot as one client authority transition;
3. open or resume the global event stream strictly after that cursor;
4. route replayed events through the existing planner and coordinators.

Every committed mutation must therefore be either represented by the snapshot or replayable after
its cursor, never neither. Event records and the state changes they describe must commit in the
same transaction, or an equivalent ordering guarantee must exist.

#### Recommended first contract

Start with a focused aggregate for the session-index/selection bootstrap rather than every detail
resource:

```ts
type SessionBootstrapSnapshot = {
  snapshot: {
    revision: number;
    globalEventCursor: number;
  };
  sessions: {
    items: Session[];
    nextCursor: string | null;
  };
  selectedSession?: Session;
};
```

The server should construct this response in one consistent read transaction, preferably
`REPEATABLE READ`, and capture `revision` and `globalEventCursor` inside that transaction. The
response contract must state that every returned entity incorporates all authorized changes
through the advertised revision/cursor. The snapshot is scoped to the requesting authorization
identity; an auth transition invalidates it and requires a new bootstrap.

This first contract intentionally leaves messages, retained event history, artifacts, external
resources, callbacks, and services on the existing phased bootstrap loader. Add them only when
measurement shows that an aggregate materially improves initial-selection latency and they can be
read under the same consistency guarantee.

#### Stable pagination and searches

The first aggregate does not by itself make later pages stable. If page drift is observed, extend
the API with a short-lived, authorization-bound snapshot token:

```ts
type SnapshotHandle = {
  token: string;
  revision: number;
  globalEventCursor: number;
  expiresAt: string;
};
```

First-page, archived, child, and search responses would return or accept that token, and every
cursor derived from the response would remain bound to the same snapshot. This prevents inserts,
removals, or ordering changes between page one and page two from causing duplicate or omitted
rows. Cursors must encode or validate the snapshot identity and filter/search context.

Do not hold an open PostgreSQL transaction across arbitrary client requests. Implement snapshot
tokens only if the persistence model supports bounded historical/as-of reads or another durable
snapshot representation. Otherwise retain the current coordinator ownership model and treat page
drift as requiring a fresh first-page generation.

#### Lighter high-water-only alternative

Adding `{ revision, globalEventCursor }` to independent responses is useful but weaker than a
shared snapshot. It allows the client to compare authority, reject older responses, select an exact
replay boundary, and retry incompatible bootstrap reads. It does **not** prove that separate
responses are mutually consistent unless the server also supports reads as of the same revision.
The API and client must not label independently read resources an aggregate snapshot solely because
their responses contain nearby high-water values.

#### Required guarantees

1. **Consistent inclusion:** all aggregate resources reflect one committed snapshot.
2. **Atomic event boundary:** every mutation is in the snapshot or in replay after its cursor.
3. **Comparable authority:** revision ordering is documented, monotonic, and scoped consistently.
4. **Stable pagination when promised:** all pages and searches using a snapshot token read the same
   data and ordering basis.
5. **Replay retention:** events after the advertised cursor remain available long enough to finish
   bootstrap and reconnect; an expired cursor produces an explicit full-bootstrap requirement.
6. **Authorization consistency:** revisions, cursors, and snapshot tokens cannot expose rows outside
   the caller's current visibility and cannot survive an identity change.

#### Client integration

- Add one atomic reducer/application path for the aggregate rather than invoking existing resource
  setters independently.
- Advance local global-event authority to the advertised cursor only after the whole snapshot is
  accepted.
- Reject the aggregate if auth authority, selection intent, or bootstrap generation changed while
  it was in flight.
- Continue using session-index and selected-resource generations for responses arriving after
  bootstrap. Server revisions complement request leases; they do not replace client coordination.
- If replay reports that the high-water cursor expired, discard the incomplete recovery generation
  and perform one bounded full bootstrap.

#### Extension verification

- A mutation committed before snapshot capture appears in the snapshot and is not required from
  replay.
- A mutation committed after snapshot capture is absent from the snapshot and appears after
  `globalEventCursor`.
- No transaction-boundary race can make a mutation absent from both sources.
- Bootstrap resources all report the same revision.
- An older aggregate cannot overwrite a newer mutation, summary, list, or auth authority.
- Replaying from the advertised cursor is idempotent with entities already in the snapshot.
- Auth changes and unmount abort snapshot application and stream handoff.
- Snapshot-token pagination does not duplicate or omit rows while concurrent sessions are created,
  archived, restored, retitled, or reordered.
- Expired snapshot/replay cursors cause one explicit bounded bootstrap, not an automatic retry loop.

Implement this extension only after measuring the current completed synchronization architecture.
The initial decision gate is either material bootstrap latency/request pressure or a demonstrated
snapshot-to-replay consistency defect; it is not needed to complete live session synchronization.

## 12. Suggested commit sequence

1. `test(web): measure request amplification by session interaction`
2. `refactor(web): define session event synchronization plans`
3. `fix(web): guard session state against stale snapshot responses`
4. `refactor(web): coordinate selected-session resource invalidation`
5. `refactor(web): coordinate session summary and list reconciliation`
6. `refactor(web): route realtime events through session sync planning`
7. `perf(web): use mutation responses without broad reconciliation`
8. `perf(web): remove full refreshes from message lifecycle actions`
9. `fix(web): unify session reconnect and resume recovery`
10. `perf(web): make created-session backfill incremental`

Each commit should preserve existing behavior outside its stated synchronization boundary and add
the narrow request-budget or race test that proves the change.
