# Plan: Session tags, stars, list filtering, and activity ordering

Status: proposed (2026-07-07, revised 2026-07-08 to include per-user stars and activity-ordering fixes)
Scope: `apps/control-plane` (migrations + store + service + API), `apps/web` (tag/star UI + sidebar filters + reorder UX)

Goal: users can attach arbitrary shared tags to sessions (e.g. `infrastructure`), star/bookmark
sessions for themselves, and filter the session list by tags, starred, and two derived
relationships: "created by me" and "I sent a message on this session". Filters combine with the
existing archived/group filters, keyset pagination, and search. Alongside this, fix two
sidebar-ordering problems: metadata edits (title/tags/access) must stop reordering everyone's
session list, and live reordering must stop shifting the list under the user's cursor.

## 1. Design decisions (read first)

1. **Tags are shared, session-level labels** — visible to everyone who can read the session,
   editable by everyone who can write it (like GitHub issue labels). They are not per-user.
   Rationale: the whole permission model is group/organization scoped (`canReadSession` /
   `canWriteSession` in `apps/control-plane/src/auth/authorization.ts:60-72`), and shared labels
   like `infrastructure` are the primary use case.

1a. **Personal bookmarks are a separate "star" feature, not a tag.** A star is private per-user
state: a `session_stars(user_id, session_id)` table, a toggle endpoint, and an `EXISTS` filter
predicate that reuses the same filter plumbing as "participated". Three reasons it cannot be a
tag: (a) tags are visible to and removable by everyone with write access; (b) tag editing
requires `canWriteSession`, but a _viewer_ must be able to star an org-visible session they can
only read; (c) tag edits ride `session_updated` events and mutate the shared session row, which
a private bookmark must not do. Starring therefore bypasses `SessionService.update` entirely —
no event, no `updatedAt` or `lastActivityAt` change; the client updates optimistically.

2. **"Created by me" and "participated" are derived filters, not tags.** The data already exists:
   `sessions.created_by_user_id` (migration `008_groups_rbac.sql:67`, set at
   `apps/control-plane/src/app/server.ts:267`) and `messages.author_user_id`
   (`002_core.sql:27`, `MessageRecord.authorUserId` in `store/types.ts:133`). No new writes needed —
   only new query predicates and one supporting index.

3. **Tags live in a `text[]` column on `sessions`, not a join table.** A `tags text[] NOT NULL
DEFAULT '{}'` column plus a GIN index gives containment filtering (`tags @> $1::text[]`),
   requires zero extra joins in the list/search/serialize paths, and keeps the memory-store parity
   implementation trivial. We give up per-tag metadata (creator, color, created-at) — acceptable;
   if that's ever needed, migrate to a `session_tags` join table then. Store tags normalized
   (see §4) and sorted, so array equality is deterministic.

4. **Tag mutations reuse the existing session update path** (`SessionService.update`,
   `sessions/service.ts:79-112`) so the change and its `session_updated` event commit atomically
   via `updateSessionWithEvent` — the comment at `service.ts:94-96` explains why that matters.
   Extend the `session_updated` payload with `tags`. `update()` keeps setting
   `updatedAt = new Date()` (record-modified semantics), but with decision 5 below that no longer
   reorders anyone's sidebar.

5. **Session ordering moves from `updated_at` to a new `last_activity_at` column.** Today
   `updated_at` conflates "row modified" with "session active": renaming a session, changing its
   access, or (without this fix) tagging it would jump it to the top of every user's
   activity-ordered sidebar. `last_activity_at` is bumped only by real activity — session
   creation, message enqueue, run/queue status transitions — never by metadata edits via
   `SessionService.update` and never by stars. List ordering, keyset cursors, and the pagination
   indexes all move to it. `updated_at` keeps its current writes and meaning.

6. **The client updates rows in place but defers re-sorting while the pointer is over the
   session list** ("hover-freeze"). Live reordering stays — an activity-sorted list that is
   secretly stale is worse than one that moves — but the list must not shift under a cursor that
   is about to click. Sorting is already client-side in one place (`sortSessionsByLastActivity`,
   `apps/web/src/app-state.ts:251`), so this is a small, purely-web change. Explicitly rejected
   alternative: only reordering on full page reload — it makes "ordered by activity" misleading
   and hides exactly the fresh work the ordering exists to surface.

## 2. Current state (verified against code)

- **Schema**: `sessions` in `002_core.sql`; group/creator columns added in `008_groups_rbac.sql:60-67`;
  keyset-pagination partial indexes in `012_sessions_pagination.sql`. Migrations are lexicographically
  sorted files run by `apps/control-plane/src/db/migrate.ts`; latest is `013_session_search_docs.sql`,
  so the new files are `014_session_tags.sql` and `015_session_activity_ordering.sql`.
- **Store contract**: `SessionRecord` (`store/types.ts:110-124`), `SessionListOptions`
  (`types.ts:532-538`), `SessionSearchOptions` (`types.ts:547-553`). Two implementations that must
  stay in parity: `store/postgres.ts` (`listSessionsWithLatestSandbox` at 712, `searchSessions` at
  768, shared visibility predicate builder `sessionVisibilityWhereClauses` at 2649) and
  `store/memory.ts` (`listSessionsWithLatestSandbox` at 307, `searchSessions` at 330). Shared
  contract tests: `test/support/contracts.ts` and `test/support/postgres-store-suite.ts`.
- **API**: `GET /sessions` (`app/server.ts:272-307`) parses `limit`, `cursor`, `archived`, `groupId`
  and builds a `visibleTo` group filter from memberships; `GET /sessions/search` (309-346) does the
  same. `PATCH /sessions/:sessionId` (372-387) updates the title. Route authorization:
  `sessionAuthorizationMiddleware` (964-987) resolves the session, requires `canWriteSession` for
  unsafe methods, and **special-cases the literal path segment `search`** (line 973) so
  `GET /sessions/search` isn't treated as a session id — any new non-id path under `/sessions/`
  needs the same treatment.
- **Serialization**: `serializeSessionView` (`server.ts:1152-1167`) spreads the whole
  `SessionRecord`, so a `tags` field on the record flows to clients automatically.
- **Update quirk to preserve**: `SessionService.update` deletes `title` when the input omits it
  (`service.ts:88-89`), so callers like `PATCH /sessions/:sessionId/access` explicitly pass the
  existing title through (`server.ts:415`). Do **not** copy that pattern for tags — use
  `if (input.tags !== undefined)` so omitting `tags` leaves them unchanged, and existing callers
  (title rename, access change, automations in `automations/`) need no changes.
- **Events**: `session_updated` payload schema at `events/types.ts:35-41`. The web sidebar refreshes
  its first page on `session_created`/`session_updated` (`app/event-routes.ts:19`), and the search
  indexer also consumes those events (`search/indexer.ts:60`) — it only reads `title`, so adding
  `tags` to the payload is backward compatible.
- **Web**: `listSessions`/`searchSessions` clients in `apps/web/src/api.ts:346-370`; session list
  state, `refreshSessions` (page-1 refresh with merge), and load-more live in `apps/web/src/app.tsx`
  (~261, 1045, 1133); sidebar with search box + collapsible archived section in
  `components/app-panels/session-sidebar.tsx`; session header with inline title editing and archive
  actions in `components/app-panels/thread-header.tsx`. `mergeSessionsById` merges new pages into
  existing state — see §7 for why filters need replace semantics instead.
- **Ordering today**: the client sorts purely by `updatedAt`
  (`sortSessionsByLastActivity`, `app-state.ts:251-253`, re-sorted via `useMemo` at
  `app.tsx:488` on every state change) and refetches page 1 on every
  `session_created`/`session_updated` event (`event-routes.ts:19` → `refreshSessions`). The
  server bumps `sessions.updated_at` from many scattered raw-SQL sites in `store/postgres.ts` —
  message insert (`createMessage`, ~1445-1477), run claim (~1677), run cancel (~1851), queue
  pause/resume (~1088/1099), archive — plus the generic record writers used by
  `SessionService.update` and the worker's mid-run context merges
  (`worker/service.ts:290,372`). Net effect: any activity or edit by anyone reorders every
  user's sidebar live. Session timestamps are always written from JS `Date` values, never DB
  `now()` — cursor round-trips depend on that (`sessions/service.ts:39-40`); `last_activity_at`
  writes must follow the same rule.

## 3. Migration — `apps/control-plane/src/db/migrations/014_session_tags.sql`

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS sessions_tags_gin_idx ON sessions USING gin (tags);

-- Supports the "sessions I have sent a message on" EXISTS predicate.
CREATE INDEX IF NOT EXISTS messages_author_session_idx
  ON messages (author_user_id, session_id)
  WHERE author_user_id IS NOT NULL;

-- Per-user bookmarks. PK order (user_id, session_id) serves both the starred
-- filter EXISTS and per-user page lookups; the session_id index keeps the
-- ON DELETE CASCADE from sessions cheap.
CREATE TABLE IF NOT EXISTS session_stars (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS session_stars_session_idx ON session_stars (session_id);
```

Optional (skip unless load tests show need): a composite
`sessions (created_by_user_id, last_activity_at DESC, created_at DESC, id DESC)` index for
paginated created-by-me listing; the existing `sessions_created_by_user_id_idx` (008) plus the
pagination indexes should be fine at current scale.

## 3a. Migration — `apps/control-plane/src/db/migrations/015_session_activity_ordering.sql`

Separate file so the ordering change reviews and reverts independently of tags/stars:

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
UPDATE sessions SET last_activity_at = updated_at WHERE last_activity_at IS NULL;
ALTER TABLE sessions ALTER COLUMN last_activity_at SET NOT NULL;

-- Mirror the four keyset-pagination indexes from 012_sessions_pagination.sql on the
-- new ordering key, then drop the updated_at variants they replace.
CREATE INDEX IF NOT EXISTS sessions_active_activity_idx
  ON sessions (last_activity_at DESC, created_at DESC, id DESC)
  WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS sessions_archived_activity_idx
  ON sessions (last_activity_at DESC, created_at DESC, id DESC)
  WHERE status = 'archived';
CREATE INDEX IF NOT EXISTS sessions_active_owner_group_activity_idx
  ON sessions (owner_group_id, last_activity_at DESC, created_at DESC, id DESC)
  WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS sessions_archived_owner_group_activity_idx
  ON sessions (owner_group_id, last_activity_at DESC, created_at DESC, id DESC)
  WHERE status = 'archived';

DROP INDEX IF EXISTS sessions_active_updated_idx;
DROP INDEX IF EXISTS sessions_archived_updated_idx;
DROP INDEX IF EXISTS sessions_active_owner_group_updated_idx;
DROP INDEX IF EXISTS sessions_archived_owner_group_updated_idx;
```

**What bumps `last_activity_at`** — the crisp rule: everything that bumps `updated_at` today
_except_ metadata edits keeps counting as activity. Concretely:

- Session creation sets `last_activity_at = created_at` (`SessionService.create`).
- Every raw `UPDATE sessions SET status/queue_paused_at ..., updated_at = ...` site in
  `store/postgres.ts` (message insert, run claim, run completion/failure, cancel, queue
  pause/resume, archive — audit by grepping `updated_at` writes in postgres.ts and mirror each in
  memory.ts) also sets `last_activity_at` to the same JS-Date value.
- The generic record writers (`updateSession`, `updateSessionWithEvent`) persist whatever
  `record.lastActivityAt` says — they do not bump it. `SessionService.update` (title/tags/access)
  carries the existing value through unchanged; that is the whole point. The worker's mid-run
  context merges and `MessageService.enqueue`'s context merge also leave it unchanged (the
  surrounding message/run status transitions already bump it).
- Stars never touch the sessions row at all (§1a).

## 4. Tag normalization and limits (shared service-level helper)

Add a `normalizeSessionTags(input: unknown): string[] | null` helper (suggested location:
`apps/control-plane/src/sessions/tags.ts`) used by the API route; return `null` for invalid input
so the route can 400. Rules:

- Must be an array of strings; each tag: trim, collapse internal whitespace runs to one space,
  lowercase. Drop empties, dedupe, sort.
- Reject tags longer than 64 chars, tags containing commas (commas are the list separator in the
  filter query param) or control characters, and arrays with more than 20 tags after dedupe.

Unit-test this helper directly (`apps/control-plane/test/unit/`).

## 5. Control plane — store layer

`store/types.ts`:

- `SessionRecord` gains `tags: string[]` (non-optional; default `[]`) and
  `lastActivityAt: Date`. Update `CreateSessionRecord` (`types.ts:323`) accordingly.
- `SessionListCursor` (`types.ts:526-530`) changes `updatedAt` → `lastActivityAt`; the keyset
  comparison in both stores and the `ORDER BY` move to
  `(last_activity_at, created_at, id) DESC` (postgres.ts:749/761, the search tiebreak at
  postgres.ts:813, `compareSessionsNewestFirst` and cursor construction in memory.ts).
- `SessionListOptions` and `SessionSearchOptions` gain:
  ```ts
  tags?: string[];              // AND semantics: session must have every tag
  createdByUserId?: string;
  participantUserId?: string;   // has at least one message authored by this user
  starredByUserId?: string;     // has a session_stars row for this user
  ```
- New store method for the filter UI's tag picker:
  ```ts
  listSessionTags(options: { visibleTo?: SessionVisibilityFilter; limit: number }):
    Promise<{ tag: string; sessionCount: number }[]>;
  ```
- New star methods (idempotent — starring twice or unstarring a non-star is a no-op):
  ```ts
  starSession(input: { sessionId: string; userId: string; now: Date }): Promise<void>;
  unstarSession(input: { sessionId: string; userId: string }): Promise<void>;
  listStarredSessionIds(input: { userId: string; sessionIds: string[] }): Promise<Set<string>>;
  ```
  `listStarredSessionIds` exists so routes can decorate a fetched page with a per-user `starred`
  boolean without threading the requesting user into the list/search SQL (see §6).

`store/postgres.ts`:

- Add `tags` and `last_activity_at` to `sessionSelectColumns` / row mapper / insert / update
  statements (find every site that reads or writes session rows — `createSession`,
  `updateSession`, `updateSessionWithEvent`, `archiveSession`; the flue/pi runner tables in
  migrations 004/007 are unrelated and untouched). Apply the §3a activity-bump rule at each raw
  status-transition UPDATE.
- In `listSessionsWithLatestSandbox` and `searchSessions` (the `matched_sessions` CTE WHERE at
  postgres.ts:812), append predicates next to the existing `groupId` handling:
  - `sessions.tags @> $n::text[]`
  - `sessions.created_by_user_id = $n::uuid`
  - `EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id AND messages.author_user_id = $n::uuid)`
  - `EXISTS (SELECT 1 FROM session_stars WHERE session_stars.session_id = sessions.id AND session_stars.user_id = $n::uuid)`
- `listSessionTags`: reuse `sessionVisibilityWhereClauses`, then
  `SELECT tag, count(*) FROM sessions, unnest(sessions.tags) AS tag WHERE ... GROUP BY tag
ORDER BY count(*) DESC, tag ASC LIMIT $n`. Include archived sessions (a tag on an archived
  session is still filterable).

`store/memory.ts`: mirror all of the above with array filters; participant check scans
`this.messages` for `authorUserId`; stars in a `Map<userId, Set<sessionId>>`. Keep exact parity —
the contract suites will enforce it.

Contract tests (`test/support/contracts.ts` + `postgres-store-suite.ts`): tags round-trip on
create/update; list filtering by single tag, multiple tags (AND), tag + group + archived combined;
createdByUserId; participantUserId (author on one of several messages; user with no messages);
starredByUserId (one user's stars invisible to another; unstar removes from filter); star/unstar
idempotency; pagination cursors still stable under filters; `listSessionTags` respects `visibleTo`
and counts. For activity ordering: creating a message / claiming a run / pausing the queue bumps
`lastActivityAt` and changes list position; `updateSessionWithEvent` (title/tags/access edit) does
not; keyset pagination pages correctly by `lastActivityAt` with `createdAt`/`id` tiebreaks —
adapt the existing pagination contract cases rather than duplicating them.

## 6. Control plane — service + API

`sessions/service.ts`:

- `UpdateSessionInput` gains `tags?: string[]`. In `update()`, apply with
  `if (input.tags !== undefined) next.tags = input.tags;` (see §2 title quirk — omitting tags must
  not clear them). Include `tags: next.tags` in the `session_updated` payload.
- `create()` initializes `tags: []` (accepting initial tags on create is unnecessary for v1) and
  `lastActivityAt: now` (same JS `Date` as `createdAt` — see the precision comment at
  `service.ts:39-40`).
- `update()` carries `lastActivityAt` through from the existing record untouched.

`events/types.ts`: add `tags?: string[]` to the `session_updated` payload type (line 35).

Cursor encoding (`app/server.ts:1032-1049`): `encodeSessionListCursor`/`decodeSessionListCursor`
switch the payload field from `updatedAt` to `lastActivityAt`. During decode, accept a legacy
cursor's `updatedAt` key as an alias for `lastActivityAt` (values are compatible because the
migration backfills `last_activity_at = updated_at`) so a tab that was mid-pagination across the
deploy doesn't get a 400; keep the existing 400 for genuinely malformed cursors.

`app/server.ts`:

- `PATCH /sessions/:sessionId` (372): accept optional `tags`; validate via `normalizeSessionTags`
  (400 `invalid_request` with a message naming the constraint on failure); pass through to
  `services.sessions.update`. Write access is already enforced by the middleware (PATCH is an
  unsafe method). This one endpoint covers add/remove/replace — the client always sends the full
  normalized set.
- `GET /sessions` and `GET /sessions/search`: parse new query params next to `groupId`:
  - `tags` — comma-separated; run through the same normalizer; 400 on invalid.
  - `createdBy` — only the literal `me` accepted; 400 otherwise.
  - `participant` — only the literal `me`; 400 otherwise.
  - `starred` — only the literal `me`; 400 otherwise.
    Resolve `me` to `auth.user.id`; if `auth.bypass` (no user), 400 with a clear message. Pass down
    as `createdByUserId` / `participantUserId` / `starredByUserId` store options.
- Star toggle endpoints: `PUT /sessions/:sessionId/star` and `DELETE /sessions/:sessionId/star`
  (idempotent; return `{ starred: boolean }`). They call the star store methods directly — not
  `SessionService.update` — so no `session_updated` event is emitted and `updatedAt` is untouched
  (§1a). Skip them for bypass tokens (no user → 400). **Authorization gotcha**: these are unsafe
  methods, so `sessionAuthorizationMiddleware` (server.ts:980) would demand `canWriteSession`, but
  starring must only require _read_ access. Extend the middleware with an explicit exception —
  e.g. a check that the resolved route path is `/sessions/:sessionId/star`, which downgrades the
  requirement to `canReadSession` — with a unit test proving a group `viewer` can star an
  org-visible session but still gets 403 on `PATCH .../:sessionId` (tags/title).
- Per-user `starred` decoration: in `GET /sessions`, `GET /sessions/search`, and
  `GET /sessions/:sessionId`, after fetching the page, call
  `listStarredSessionIds({ userId, sessionIds })` (skip for bypass tokens) and pass
  `starred: boolean` into `serializeSessionView` as a new explicit argument (it is per-requester
  state, so it must not be added to `SessionRecord`).
- New `GET /sessions/tags` returning `{ tags: [{ tag, sessionCount }] }` scoped by the same
  `visibleTo` construction as `GET /sessions`. **Gotcha**: `sessionAuthorizationMiddleware`
  (server.ts:973) must special-case the `tags` path segment exactly as it does `search`, and the
  route must be registered before the `/sessions/:sessionId` GET. Add a unit test that
  `GET /sessions/tags` does not 404/403 spuriously and that a non-member cannot see group-only
  sessions' tags.

Route unit tests (`test/unit/`, alongside existing server tests): PATCH tags happy path +
validation failures + write-policy 403 (viewer role); GET /sessions with each filter and
combinations; filters honored in /sessions/search; bypass-token `createdBy=me` / `starred=me` →
400; star/unstar as viewer (200) and as non-reader of a group-only session (403); `starred`
decoration correct per requesting user.
Integration tests (`test/integration/`, needs `TEST_DATABASE_URL`) if the existing suites cover
list/search endpoints there — follow the pattern from the pagination/search work.

## 7. Web app

`api.ts`:

- `Session` type gains `tags: string[]`, `starred?: boolean`, and `lastActivityAt: string`
  (flows automatically from the `SessionRecord` spread in `serializeSessionView`).
- `listSessions` / `searchSessions` options gain `tags?: string[]`, `createdBy?: 'me'`,
  `participant?: 'me'`, `starred?: 'me'`; serialize into query params (tags joined with commas).
- New `updateSessionTags(token, sessionId, tags)` → `PATCH /sessions/:sessionId` with `{ tags }`,
  `listSessionTags(token)` → `GET /sessions/tags`, and
  `setSessionStarred(token, sessionId, starred)` → `PUT`/`DELETE /sessions/:sessionId/star`.

Filter state (`app.tsx`):

- Add `sessionFilters` state:
  `{ tags: string[]; createdByMe: boolean; participatedByMe: boolean; starredByMe: boolean }`,
  persisted to `sessionStorage` following the `archivedSessionsOpenStorageKey` pattern in
  `app-helpers.ts`. Thread it through `refreshSessions`, the archived lazy-load, and both load-more
  paths so every page request carries the active filters; also pass tags/filters into the search
  call so sidebar search respects active filters.
- **Merge pitfall**: `refreshSessions` merges page 1 into existing state via `mergeSessionsById`,
  so sessions loaded before a filter was applied would linger. When filters change: clear the
  session list state and cursors, then fetch fresh. While filters are active, have the event-driven
  first-page refresh _replace_ the filtered list (retaining the selected session even if it doesn't
  match, as the existing selected-session fetch already does) instead of merging. `tags`,
  `createdByUserId`, and `starred` are client-visible so upserts could be predicate-filtered
  client-side, but `participatedByMe` is not client-derivable — replace semantics keeps all the
  filters correct with one code path.
- Star toggling is optimistic: flip `starred` on the session in state, call `setSessionStarred`,
  revert on failure. No event arrives from the server for stars (§1a), so local state is the source
  of truth for the current tab.

Activity ordering + hover-freeze (`app.tsx` / `app-state.ts`):

- `sortSessionsByLastActivity` (`app-state.ts:251-253`) switches from `updatedAt` to
  `lastActivityAt`, with `createdAt`/`id` tiebreaks matching the server's keyset order.
- Hover-freeze (§1 decision 6): rows always update in place (status, title, tags, star), but the
  _order_ is only recomputed while the pointer is not over the session list. Suggested mechanics:
  track hover state on the sidebar list container; keep the last applied order (array of session
  ids); while hovered, render existing sessions in that frozen order with fresh data, and hold
  session ids not yet in the order; on mouse-leave (or when the list wasn't hovered to begin
  with), recompute from `lastActivityAt`. Implement the "apply frozen order + hold newcomers"
  logic as a pure helper in `app-state.ts` with unit tests.
- Two carve-outs from the freeze: load-more results append immediately (the pointer is
  necessarily over the sidebar when clicking load-more, and older pages sort below existing rows
  anyway), and filter/search changes always recompute (the list is being replaced, not
  reshuffled).
- With `last_activity_at` on the server, tag/title/access edits no longer reorder anything —
  their `session_updated` events still refresh row data in place. Verify there is no remaining
  client path that reorders on `updatedAt`.

Sidebar (`components/app-panels/session-sidebar.tsx`):

- Filter row under the search input: a tag multi-select (populated from `listSessionTags`, showing
  counts; refresh when the panel opens) plus "Starred", "Created by me", and "I participated"
  toggle chips. Show an active-filter count with a clear-all affordance. Reuse
  `components/ui/badge.tsx` / `button.tsx`.
- Render up to ~3 tag badges per session row (overflow as `+n`), for both list and search results.
- Star affordance on each session row: filled star when `starred`, outline on hover otherwise
  (lucide icons are already in use in this file); click toggles without selecting the session
  (stopPropagation).
- Empty state copy when filters match nothing ("No sessions match the current filters").

Session header (`components/app-panels/thread-header.tsx`):

- Star toggle button next to the archive action, same optimistic behavior as the sidebar row.
- Tag editor next to the title: existing tags as badges with remove (×), an input to add a tag with
  `datalist` autocomplete from `listSessionTags`, submitting the full set via `updateSessionTags`.
  Follow the title-edit interaction pattern already in this file (optimistic local draft, server
  errors surfaced the same way; server 403 covers write-policy — no client-side permission gating,
  same as title editing today). Disable tag editing for archived sessions (they're read-only);
  starring an archived session stays allowed (it's per-user state, not a session mutation — but
  note the middleware/archive guard interplay: archive read-only enforcement lives in write-path
  checks, which the star route bypasses by design).

Web tests: extend `app.test.tsx` for filter state → query param wiring and tag editing; unit-test
the frozen-order helper (existing rows keep order while frozen, newcomers held then inserted on
unfreeze, load-more appends immediately); check whether `src/static-demo` fixtures /
`demo:export` need the new `tags`/`lastActivityAt` fields to compile.

## 8. Out of scope / follow-ups (note in PR, do not build)

- Per-user private _tags_ (stars ship in this plan; arbitrary private labels do not).
- Syncing star state live across a user's own tabs/devices (no event is emitted for stars; a
  page refresh reconciles).
- Reorder batching beyond hover-freeze (e.g. debouncing others' activity, "N sessions moved"
  affordances). Ship hover-freeze first; it likely removes most of the pain.
- Tag content in full-text search (indexing tags into `session_search_docs`).
- Tag rename/merge admin tooling and per-tag colors (would motivate the join-table model).
- Filtering by _other_ users (`createdBy=<userId>`); only `me` ships.
- Agent-facing session list tools (`sessions/deputy-tool.ts`, `listSessionsForAgent`) stay
  tag-unaware.

## 9. Validation

Local toolchain notes: plain `pnpm` may be broken in this environment — use `npx pnpm@11.5.2 ...`
or the `mise run` tasks (`mise task ls --all`). Postgres for integration tests:
`mise run //deploy/local:infra:up`, then `TEST_DATABASE_URL=postgres://...deputies_test`.

1. `npx pnpm@11.5.2 --dir apps/control-plane typecheck && npx pnpm@11.5.2 --dir apps/control-plane test`
2. `TEST_DATABASE_URL=... npx pnpm@11.5.2 --dir apps/control-plane test:integration` (runs the
   Postgres store suite — the parity/contract tests are the critical gate here)
3. `npx pnpm@11.5.2 --dir apps/web typecheck && npx pnpm@11.5.2 --dir apps/web test && npx pnpm@11.5.2 --dir apps/web build`
4. Manual smoke: create two sessions as different users in different groups; tag one; verify tag
   filter, created-by-me, participated (send a message on someone else's session), filter + search
   combined, filter + archived section, viewer role gets 403 on tag edit, and the sidebar updates
   live when a second browser tags a session. For stars: star a session as user A, confirm user B
   sees no star and the "Starred" filter is per-user; star as a viewer-role user on an org-visible
   session (must succeed); confirm starring does not reorder the sidebar for anyone. For ordering:
   rename/tag a session in browser B and confirm browser A's row updates in place _without_
   moving; send a message in B and confirm A reorders; hold the pointer over A's session list
   while B sends messages and confirm the order stays frozen until the pointer leaves, while
   status badges keep updating.
