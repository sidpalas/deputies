# Review fixes: session tags, stars, filtering, and activity ordering

Status: addressed (2026-07-08)
Applies to: the uncommitted implementation of `plans/session-tags-and-filters.md` in this worktree
Source: conventional review pass (complete, findings below). The actionable fixes have been
applied in this worktree.

Verification state at review time: `apps/control-plane` typecheck + unit tests pass (541 tests),
`apps/web` typecheck + tests pass (106 tests). **Postgres integration tests have never been run**
— see finding 2.

## 1. Should-fix findings (ordered)

### 1.1 Hover-freeze breaks the archived section

Where: `apps/web/src/app.tsx:551` (`applyFrozenSessionOrder`), `app.tsx:1281-1305`
(`loadArchivedSessions`), `apps/web/src/components/app-panels/session-sidebar.tsx:163-166`.

The freeze carve-out for load-more was applied to `loadMoreSessions` (app.tsx:1270-1272 appends
new ids to the frozen order) but not to `loadArchivedSessions` or the archived load-more. The
archived toggle lives inside the hover container, so the pointer is always over the list when it
is clicked: the fetch merges archived sessions into state, `applyFrozenSessionOrder` drops ids not
in `sessionOrderIds`, and the section renders "No archived sessions" until the pointer leaves.

Fix: treat archived load / archived load-more exactly like active load-more — append their ids to
the frozen order immediately. Add a web unit test for the frozen-order helper covering "archived
page arrives while frozen" (note: jsdom clicks don't fire `pointerenter`, which is why the
existing tests missed this — drive the freeze state directly in the test).

### 1.2 Plan-mandated Postgres contract/parity tests are missing (the plan's "critical gate")

Where: `apps/control-plane/test/support/contracts.ts` + `test/support/postgres-store-suite.ts`
(not extended); only a memory-store-only unit test shipped
(`test/unit/session-tags.test.ts`).

None of the new SQL has ever executed against real Postgres: the GIN `tags @>` filter, the
participant and starred `EXISTS` predicates, `session_stars` insert/conflict handling,
`listSessionTags`'s `CROSS JOIN LATERAL unnest` (postgres.ts:872-888), the tags-preserve
`CASE WHEN $15 THEN tags ELSE $14 END` clause (postgres.ts:1013), the new 14-column session
insert, and migrations 014/015.

Fix: add the contract cases plan §5 lists to the shared suites so they run against BOTH stores:
tags round-trip on create/update; single-tag, multi-tag (AND), and tag + group + archived
filtering; `createdByUserId`; `participantUserId` (author on one of several messages; user with
no messages); `starredByUserId` (per-user isolation; unstar removes from filter); star/unstar
idempotency; pagination cursors stable under filters; `listSessionTags` visibility + counts; the
activity-bump matrix (message insert / run claim / queue pause bump `lastActivityAt`;
`updateSessionWithEvent` does not). Then run:
`mise run //deploy/local:infra:up` and
`TEST_DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies_test npx pnpm@11.5.2 --dir apps/control-plane test:integration`
(plain `pnpm` is broken in this environment; always use `npx pnpm@11.5.2`). Report the results.

### 1.3 Unplanned blanket "archived sessions are read-only" middleware guard — decision required

Where: `apps/control-plane/src/app/server.ts:1080-1082`, tests updated at
`test/unit/api.test.ts:1373` and added at 1378-1397.

Plan §7 said archive read-only enforcement stays in existing write-path checks and asked only for
client-side disabling of tag editing on archived sessions. The implementation instead added a
global 409 for every unsafe method on archived sessions (except star/unarchive). This changes
pre-existing API behavior beyond tags:

- Re-archiving an archived session now 409s (previously idempotent 200).
- `PATCH /sessions/:id/access` on an archived session now 409s — archived sessions can no longer
  be moved between groups without unarchiving first.
- `POST /sessions/:id/runs/current/cancel` on a session archived mid-run now 409s.
- The enqueue error message changed ("Cannot enqueue messages to an archived session" →
  "Archived sessions are read-only"), which external consumers may match on.

Fix: default to reverting to plan scope — guard only the tags/title PATCH path (or check archived
inside the PATCH route) and restore the previous archive-idempotency and access-move behavior.
If the blanket guard is intentionally kept, get explicit sign-off from Sid and document the
behavior change in the PR description; do not leave it implicit.

### 1.4 Plan-required route/web tests missing

Present already: PATCH tags happy path + validation 400; tags filter on list/search; bypass-token
`createdBy=me` → 400; viewer star 200 / viewer PATCH 403 / non-reader star 403
(`test/unit/session-access-matrix.test.ts:352-373`); `/sessions/tags` happy path.

Still missing (plan §6/§7):

- Route-level `participant=me` and `starred=me` filter tests with real users.
- Per-user `starred` decoration: user A stars, user B's list/search/get must not show it.
- Star/unstar idempotency via the API (double PUT, double DELETE).
- `GET /sessions/tags`: non-member must not see group-only sessions' tags (currently covered only
  at the memory-store level).
- Web test for tag editing in the thread header (plan §7 names it explicitly).

## 2. Nits (fix if cheap, otherwise note in PR)

- **2.1** `apps/control-plane/src/db/migrations/015_session_activity_ordering.sql:2` adds
  `DEFAULT now()`, absent from the plan's SQL. Session timestamps must come from JS `Date`
  (ms precision) for cursor round-trip stability; a DB-default µs value written by old code
  during a rolling deploy can destabilize keyset boundaries. Either remove the default or add a
  comment that it is a rolling-deploy safety net to be dropped after deploy.
- **2.2** `apps/control-plane/src/sessions/tags.ts:10-11` rejects control characters before
  trimming, so `"infra\n"` or `"a\tb"` → 400 instead of normalizing to `"infra"` / `"a b"` as
  plan §4 specifies (trim/collapse first, then validate).
- **2.3** Parity drift: `store/memory.ts:1003-1010` preserves archived status in
  `requestRunCancellation`; `store/postgres.ts:1924-1928` sets `'active'` unconditionally.
  Currently unreachable via the API, but align them (and let the 1.2 contract suite lock it in).
- **2.4** `apps/web/src/app-state.ts:256` breaks id ties with `localeCompare`; the server compares
  uuid bytes. Use plain `<`/`>` string comparison to match exactly.
- **2.5** `apps/web/src/app.tsx:369`: `sessionListHovered` is never reset if the sidebar unmounts
  while hovered; reset on unmount.
- **2.6** `apps/web/src/components/app-panels/thread-header.tsx:215`: the raw session id line was
  removed to make room for the tag row — it was the only place the session id was visible.
  Restore it somewhere (e.g. tooltip or details row) or confirm the removal is intended.
- **2.7** `apps/control-plane/src/store/postgres.ts:1116`: `updateSessionForRun` writes `tags`
  unconditionally; the `preserveTags` mechanism only protects the `SessionService.update` path.
  The worker re-reads the session just before each merge so the clobber window is tiny, but
  consider excluding tags from that UPDATE entirely.

## 3. Adversarial review findings

Adversarial pass complete against the post-fix tree. No critical/high findings. It ran the
Postgres integration suite for the first time (**49 passed, 2 skipped** — skips are unrelated
env-gated emulate tests), including the four new shared contract tests against real Postgres, and
separately probed `PostgresStore.searchSessions` with the new filters against a fresh DB (all
correct; the `@> '{}'` match-all hazard confirmed unreachable — both stores guard `tags?.length`
and the route drops empty/whitespace `tags=` before the store). Six findings, all concurrency or
cosmetic:

### 3.1 MEDIUM — metadata edits can regress `last_activity_at` (and status) under concurrency

Where: `apps/control-plane/src/sessions/service.ts:82-118` → `store/postgres.ts:1013`
(`updateSessionWithEvent` writes the read snapshot's `lastActivityAt`, `status`, `context`
unconditionally). CONFIRMED by code path (interleaving not executed).

`SessionService.update` reads `existing`, then writes it back wholesale. If a message enqueue or
run claim commits between B's `getSession` and B's UPDATE, a title/tag edit overwrites the fresh
`last_activity_at` and `status` with stale values — the session sinks in every sidebar despite
real activity. The status/context read-modify-write is pre-existing, but this feature newly routes
**sidebar ordering** through it, raising the stakes. Same exposure in `messages/service.ts:37` and
`app/workspace-tools.ts:108`. The fix pass only closed the worker path (`updateSessionForRun` no
longer writes tags — verified).

Recommended fix: make the activity-bumping status transitions authoritative for
`last_activity_at` — e.g. have `updateSessionWithEvent` (the metadata path) not lower
`last_activity_at`/`status`, or do the metadata update as a targeted column write (title/tags/
access/visibility only) rather than a whole-record overwrite. Worth Sid's judgment on scope since
it touches a pre-existing pattern; at minimum document it.

### 3.2 LOW — tags-only PATCH can clobber a concurrent rename

Where: `apps/control-plane/src/app/server.ts:444`. CONFIRMED.
A tags-only PATCH passes `title: session.title` from the middleware-resolved snapshot into
`update()`. A rename committed between middleware resolution and the update is silently reverted.
Fix: pass the service-refetched title (or split tags into their own targeted update) instead of
the stale snapshot title. (The title is only threaded through at all because of `update()`'s
delete-title-when-omitted quirk.)

### 3.3 LOW — filters active: refresh/load-more race can permanently drop loaded rows

Where: `apps/web/src/app.tsx:1190-1200`, `app.tsx:1237`. SUSPECTED (race not executed).
With filters active, refresh replaces non-archived rows with page 1 but only resets the cursor
when it didn't change mid-refresh. If a load-more completes while an event-driven refresh is in
flight, rows 51..N are discarded while the deep cursor is kept, so that range never reappears
without a filter reset. Also `refreshLoadedSessionSummary` is a no-op while any filter is active,
so single-row updates depend entirely on full refreshes.

### 3.4 LOW — invisible/format Unicode accepted in tags

Where: `apps/control-plane/src/sessions/tags.ts:12`. CONFIRMED.
Only C0+DEL are rejected. Zero-width space, soft hyphen, bidi overrides pass, so `"infra"` and
`"infra​"` are distinct tags rendering identically (spoofing/duplication nuisance, not a
filter bypass — write and filter share the normalizer). Consider stripping/rejecting
default-ignorable and bidi-control code points.

### 3.5 LOW — `localeCompare` ordering nondeterminism / parity drift

Where: `sessions/tags.ts:17` (stored tag sort), `store/memory.ts:369` and `memory.ts:1637`
(tiebreaks) vs Postgres DB collation / uuid byte order. CONFIRMED.
Host-locale/ICU-dependent sorting breaks the plan's "deterministic array equality" for non-ASCII
tags and can drift between memory and Postgres; coincidentally equal for canonical lowercase-hex
UUIDs and ASCII tags, so not currently observable. Use code-unit (`<`/`>`) comparison to match the
server and be locale-independent. (Overlaps nit 2.4.)

### 3.6 LOW — star/tag mutations share one per-session version counter

Where: `apps/web/src/app.tsx:604-615`, used at 1729/1748. SUSPECTED.
A tag edit bumps the same counter a pending star PUT/DELETE checks, so a _failed_ star request
whose failure lands after an interleaved tag edit skips its rollback, leaving a phantom star until
the next refresh repaints `starred`. Self-healing; needs rapid interleaving. Consider separate
version counters (or a per-mutation token) for star vs tag.

Non-issue noted for the record (fail-closed, not a vuln): the star-route exception compares the
percent-encoded pathname against the decoded `:sessionId` (`server.ts:1076-1077`), so any
percent-encoding in a legitimate star URL makes a read-only viewer's star 403 instead of 200 —
safe direction, but tighten if star URLs might ever be encoded.

### Attack surfaces probed clean

Star-route authorization exception (encoding/trailing-slash/case/method tricks all fail closed;
non-readers 403; `GET /sessions/tags` visibility exactly matches `canReadSession` in both stores);
filter semantics (empty/whitespace/comma `tags=` drop the filter, executed against real Postgres;
no write-only-unfilterable tag; appended-parameter SQL indexing correct); ordering/pagination
(strict keyset, no dup/skip on ties; legacy cursor alias correct; all activity sites bump
`last_activity_at` from JS `Date`, memory mirrors each); validation/limits (count/length/type/
comma/control-char all 400 both paths; bypass tokens 400; star insert idempotent); web (rapid star
toggling resolves under the version guard; frozen-order handles removed/duplicate ids; archived
loads now append to the frozen order); migrations (014/015 idempotent on re-run, executed twice;
NULL backfill before `SET NOT NULL`; indexes agree with ORDER BY).

## 4. Resolution

- Added shared MemoryStore/PostgresStore contract coverage for tags, stars, filters, pagination,
  tag visibility, and activity-ordering behavior.
- Reverted the broad archived unsafe-write guard and kept archived metadata protection scoped to
  `PATCH /sessions/:sessionId`.
- Added missing route-level and web tests for real-user filters, per-user star decoration,
  idempotent star/unstar, group-only tag visibility, and header tag editing.
- Addressed nits for tag whitespace normalization, Postgres cancellation status parity,
  `updateSessionForRun` tag preservation, cursor tie-breaking, hover cleanup, and archived loads
  while frozen.
- Addressed adversarial findings by adding targeted session metadata/context store writes that do
  not regress `last_activity_at`, status, or context; removing stale route title threading;
  rejecting invisible/format tag characters; using locale-independent tag/tiebreak sorting;
  preserving filtered load-more rows across refresh races; and separating star/tag optimistic
  mutation versions and rollbacks.
- Verified with control-plane/web typechecks, unit tests, and Docker-backed Postgres integration
  tests.
