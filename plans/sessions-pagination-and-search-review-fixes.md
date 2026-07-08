# Review feedback: sessions pagination + search — required fixes

Audience: the agent that implemented `plans/sessions-pagination-and-search.md` (uncommitted
work on branch `claude/cool-moser-6f67e5`). Two independent code reviews (one standard, one
adversarial) were run against the working tree. Overall assessment: the implementation is
faithful to the plan and the security-critical surfaces are correct — visibility predicates
match `canReadSession` and are enforced at query time, SQL is parameterized, cursor input is
validated to 400, the lateral sandbox join runs after the limited subquery, the indexer
cursor advances only after a successful upsert, and the backfill is idempotent. Do not
rework any of that.

However, the change is **not mergeable yet**. Fix the items below in order. Items 1–5 are
required before merge; section B is follow-up material (fix now if cheap, otherwise note as
TODOs). Line numbers refer to the current working tree.

---

## A. Required before merge

### A1. Search indexer crash-loops on duplicate doc keys within one batch (CRITICAL)

- **Where:** `apps/control-plane/src/search/indexer.ts:47-88` (`searchDocsForEvents`) and
  `upsertSessionSearchDocs` in `apps/control-plane/src/store/postgres.ts` (single
  `INSERT ... SELECT FROM unnest(...) ON CONFLICT (session_id, kind, source_id) DO UPDATE`).
- **Defect:** `searchDocsForEvents` does not dedupe docs by conflict key. If one event batch
  (default 1,000 events) contains two events mapping to the same `(session_id, kind,
source_id)`, Postgres aborts the whole INSERT with error 21000 — _"ON CONFLICT DO UPDATE
  command cannot affect row a second time."_
- **Why it fires immediately in production:** two `session_updated` events for the same
  session both produce a `'title'` doc with `source_id = session id`. `session_updated` is
  emitted on every session-context merge (`apps/control-plane/src/messages/service.ts:44`)
  and multiple times per run by the worker (`apps/control-plane/src/worker/service.ts:271`
  and `:352`), so any active session yields duplicates well inside one batch. Same hazard for
  `session_created` + `session_updated`, and `message_created` + `message_updated`.
- **Blast radius:** `runSessionSearchIndexerOnce` throws before `setSearchIndexCursor`
  (`indexer.ts:31-32`), so the cursor never advances; every tick re-reads the same batch and
  fails again. Search indexing halts permanently, logging an error each interval.
- **Why tests missed it:** `MemoryStore.upsertSessionSearchDocs` is a `Map.set` loop that
  tolerates duplicate keys.
- **Fix:** in `searchDocsForEvents`, dedupe by `(sessionId, kind, sourceId)` keeping the
  **last** occurrence (events are in id order, so last = newest). As belt-and-braces, apply
  the same last-wins dedupe inside the Postgres `upsertSessionSearchDocs` before building the
  unnest arrays.
- **Test to add:** a unit test where one batch contains two `session_updated` events for the
  same session, run against the **Postgres** store (extend
  `test/integration/postgres-store.test.ts` or the shared suite) — must upsert cleanly and
  leave the newest title.

### A2. Ungated `CREATE EXTENSION pg_trgm` can permanently block migrations (MAJOR)

- **Where:** `apps/control-plane/src/db/migrations/013_session_search_docs.sql:1`.
- **Defect:** this is the repo's first `CREATE EXTENSION`, and `src/db/migrate.ts` runs each
  migration in a transaction and rethrows on failure. On a deployment where the app's DB role
  lacks extension-creation privilege (common on locked-down/minimal Postgres), migration 013
  fails on every boot and blocks **all** future migrations — the app cannot start.
- **Fix (per plan §3.4):** make the extension + trigram index best-effort. Options, pick one:
  1. Wrap the `CREATE EXTENSION` + trgm index in a `DO $$ ... EXCEPTION WHEN
insufficient_privilege / undefined_file THEN RAISE NOTICE ... $$` block so 013 always
     succeeds; title search falls back to the existing parameterized ILIKE (which works
     without the index — the index is purely an optimization).
  2. Split the extension/index into a separate migration executed non-fatally by the runner.
     Option 1 is less invasive. Verify the search code path does not _require_ the extension at
     query time (it must not reference trgm operators directly; plain ILIKE is index-optional).
- **Test to add:** integration test asserting migrations apply on a database where the role
  cannot create extensions is likely impractical; at minimum add a unit test or comment-level
  guarantee plus manual verification that 013 applies when `CREATE EXTENSION` is a no-op
  failure.

### A3. Missing pagination edge-case tests the plan explicitly required (MAJOR)

- **Where:** `test/support/postgres-store-suite.ts` (untouched by the change),
  `test/integration/postgres-store.test.ts:279`, `test/unit/api.test.ts:1040`.
- **Gaps** (plan §5 called these out as must-cover):
  1. **Identical timestamps + id tie-breaking:** create ≥3 sessions with exactly equal
     `updatedAt` AND `createdAt`; page through with limit 1–2; assert no duplicates, no
     skips, deterministic order. This would catch a `<=` vs `<` cursor bug — current tests
     use distinct timestamps and `arrayContaining`, so they cannot.
  2. **Cursor round-trip precision:** page boundary falls between rows whose timestamps
     differ by <1 ms is unreachable today (all session timestamps are JS-Date ms writes; no
     `now()` writes exist — verified), but add a contract test with equal-ms timestamps and a
     code comment on the session write path stating the invariant: _session timestamps must
     be written from JS Dates (ms precision); a `now()` write would silently break keyset
     cursors and the backfill keyset loops (`backfill-session-search.ts:72,101`)._
  3. **Malformed cursor → 400:** garbage base64, valid base64 of non-JSON, JSON with wrong
     types, non-UUID id — endpoint test in `api.test.ts` asserting 400 `invalid_request`,
     never 500.
  4. **Paginated listing under a visibility filter:** visibility is currently only tested
     unpaginated; add a paged case (member of one group + org-visible sessions, limit smaller
     than the visible set, walk all pages).
- Also fix while here: `compareSessionsNewestFirst` in
  `apps/control-plane/src/store/memory.ts:1354` tie-breaks with `localeCompare` (ICU
  collation-dependent) while Postgres compares uuid bytes. Replace with ordinal comparison
  (`a.id < b.id ? 1 : a.id > b.id ? -1 : 0`) so memory and Postgres can never diverge.

### A4. `refreshSessions` aborts entirely when the selected session returns 403 (MEDIUM)

- **Where:** `apps/web/src/app.tsx` `refreshSessions`, selected-session fallback
  (~lines 1030-1044).
- **Defect:** the fallback `getSession` catch handles only `err.status === 404`. A **403**
  (session moved to a group the user isn't in, or visibility flipped organization→group)
  rethrows to the outer catch: error banner shown, `setSessions` never runs. The user who
  lost access typically does not receive the corresponding `session_updated` event (the
  stream filters by access), so the sidebar stays permanently stale while that session is
  selected.
- **Fix:** treat 403 exactly like 404 — drop the row from local state and deselect.
- **Test:** extend the `app.test.tsx` refresh tests with a 403 response for the selected
  session; assert the list still updates and the session is deselected.

### A5. `refreshSessions` races load-more and can drop loaded pages (MEDIUM)

- **Where:** `apps/web/src/app.tsx` `refreshSessions` — it computes `nextSessions` from a
  `sessionsRef.current` snapshot taken **before** its awaits, then commits with a
  non-functional `setSessions(nextSessions)`. `loadMoreSessions` uses a functional merge.
- **Trigger:** user clicks "Load more" (state grows to 100 rows) while an event-driven
  `scheduleSessionsRefresh` is in flight; the refresh then commits a merge based on its stale
  50-row snapshot, clobbering page 2. Plan §3.3 requires "drop nothing the user has scrolled
  to."
- **Fix:** commit via a functional update — `setSessions(current =>
mergeFirstPageInto(current, fetchedFirstPage, ...))` — so the merge always runs against the
  latest state. Apply the same pattern to any sibling state committed from pre-await
  snapshots in that function.
- **Related (fix together):** on every refresh, `setSessionsNextCursor` resets the cursor to
  the **first page's** `nextCursor` even when deeper pages are loaded
  (`app.tsx:~1047`), forcing the user to re-click through already-loaded pages. Preserve the
  deepest loaded cursor unless the refresh indicates the list shrank (e.g. only rewind when
  the loaded set is a single page).
- **Test:** app test interleaving a load-more resolution inside an in-flight refresh; assert
  page-2 rows survive and the cursor still points past the deepest loaded page.

---

## B. Follow-ups (non-blocking; do now if cheap, else leave TODO comments)

- **B1. `sessionId === 'search'` middleware carve-out** —
  `apps/control-plane/src/app/server.ts:973-976`. Write verbs to literal paths (e.g.
  authenticated `POST /sessions/search/archive`, `PATCH /sessions/search`) bypass the session
  lookup and reach real handlers with `sessionId='search'`; on Postgres, `getSession('search')`
  fails the uuid cast → 500 `internal_error` leaking the raw PG message, instead of 404.
  Not a security hole (auth runs first; no session can have that id), but fragile. Preferred
  fix: register `GET /sessions/search` **before** `sessionAuthorizationMiddleware` is
  attached and delete the carve-out.
- **B2. Negation-only search queries** — `searchSessions` in
  `apps/control-plane/src/store/postgres.ts`: `q=-zzz` compiles via `websearch_to_tsquery`
  to `!'zzz'`, which matches nearly every doc and cannot use the GIN index → per-request seq
  scan + rank of the whole docs table; a cheap authenticated DoS lever. Reject (or return
  empty for) queries whose tsquery is empty or negation-only, e.g. check
  `numnode(websearch_to_tsquery('simple', $q)) = 0` or strip leading `-` terms app-side.
- **B3. Dead `<mark>` snippet markup** — the server generates `StartSel=<mark>` headline
  markup that the only client immediately strips (`cleanSnippet` in
  `apps/web/src/components/app-panels/session-sidebar.tsx:439`, whose regex also mangles
  content containing a literal `</mark>`). Either use the marks for real highlighting in the
  UI or set `StartSel=''`/`StopSel=''` server-side and delete `cleanSnippet`.
- **B4. Memory-store search parity is behavioral, not structural** —
  `memorySearchDocuments` (`apps/control-plane/src/store/memory.ts:1314`) scans live
  messages/events, so the unit content-search test passes without the indexer running; the
  production async docs-table path has only one integration test. Add at least one more
  Postgres integration test that exercises endpoint → indexer → docs → search end-to-end.
  Also delete the dead code in `bestMemorySearchMatch` (`memory.ts:1373-1379`): the phrase
  fallback title branch is unreachable and the `kind === 'title'` tie-break never fires.
- **B5. e2e gaps** — `apps/web/e2e/heavy-session-load.spec.ts` covers first-page render and
  load-more but not archived-section lazy load on expand; there is no e2e for the search UI.
- **B6. Empty-content title docs** — both indexer and backfill write `'title'` docs with
  empty content for untitled sessions; skip them.
- **B7. Store-level content cap** — `upsertSessionSearchDocs` relies on callers for the
  16 KiB cap; enforce `left(content, 16384)`-equivalent truncation inside the store method
  too so a future caller can't persist unbounded content that `ts_headline` then processes
  per search row.
- **B8. `groupId` filter semantics** — `canFilterToGroup` (`server.ts:997`) requires
  membership, stricter than the plan's "caller can see that group" (a user can read another
  group's organization-visible sessions but gets 403 filtering to it). Unused by the web UI;
  either relax to match the plan or update the plan doc to match the code.
- **B9. Commit message** — the default limit of 50 is a breaking change for any out-of-repo
  caller of `GET /sessions`; the eventual commit must use a `feat!:` prefix so
  release-please flags it in the CHANGELOG (plan §3.1).
- **B10. Optional payload win not taken** — `serializeSessionView` still spreads the full
  session record including `context` jsonb into list responses; plan §5 suggested checking
  whether the sidebar needs it and dropping it from list serialization if not.

---

## C. Verification checklist after fixes

1. `apps/control-plane`: typecheck, unit tests, and Postgres integration tests (needs
   `TEST_DATABASE_URL`; see repo dev docs — `mise infra:up`, and use `npx pnpm@11.5.2` if
   plain `pnpm` is broken locally).
2. `apps/web`: typecheck, unit tests, build, and the heavy-session-load e2e.
3. New tests from A1, A3, A4, A5 all present and failing-before/passing-after.
4. Migration check: fresh DB applies 001→013 cleanly; simulate 013 with extension creation
   failing (e.g. revoke privilege or run against a role without it) and confirm the app still
   boots and title search still works via ILIKE.
5. Manual/integration sanity: run the indexer against a session with several
   `session_updated` events in one batch (pre-A1 this crash-loops; post-A1 it must advance
   the cursor and index the newest title).
