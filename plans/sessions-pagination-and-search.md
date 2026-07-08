# Plan: Paginate the sessions list and add cross-session search

Status: implemented (2026-07-07)
Scope: `apps/control-plane` (API + store + migrations + worker), `apps/web` (session list UI)

Implementation notes:

- Added paginated active/archived session listing, lazy archived loading, and load-more controls.
- Added server-backed cross-session search over titles, prompts, and final agent responses.
- Added Postgres search-doc migrations, async indexer, and idempotent backfill script.
- Validated with control-plane/web typecheck, unit tests, Postgres integration tests, web build, and web e2e.

## 1. Problem and current state

`GET /sessions` returns every session in the database on every call, and the web app calls it
on startup, after most mutations, and on event-stream reconnects. This breaks down at scale in
three ways: query cost (full table scan + a lateral sandbox join per row), payload size, and
client render cost. There is also no way to search sessions — not even by title — and no index
of session content that could support search.

Key facts about the current implementation (verified against the code):

- Endpoint: `apps/control-plane/src/app/server.ts:263` (`app.get('/sessions', ...)`). It calls
  `store.listSessionsWithLatestSandbox(provider, visibleTo)` plus `store.listGroups()`, then
  filters rows in-app with `canReadSession` and serializes via `serializeSessionView`
  (`server.ts:984`).
- Store interface: `SessionStore.listSessions()` / `listSessionsWithLatestSandbox()` in
  `apps/control-plane/src/store/types.ts:471-478`. Two implementations that must stay in
  parity: `apps/control-plane/src/store/postgres.ts:464-505` and
  `apps/control-plane/src/store/memory.ts:227-245`. Shared contract tests live in
  `apps/control-plane/test/support/postgres-store-suite.ts` and `test/support/contracts.ts`.
- The Postgres query orders by `(updated_at DESC, created_at DESC)` with no LIMIT, and runs a
  `LEFT JOIN LATERAL` against `sandboxes` for **every** session row before any truncation.
- Authorization: the SQL visibility filter (`visibility = 'organization' OR owner_group_id =
ANY(groupIds)`) is **exactly equivalent** to `canReadSession`
  (`apps/control-plane/src/auth/authorization.ts:60-64`: bypass/super-admin see all, otherwise
  organization-visible OR member of owner group). This matters: because the SQL predicate is
  exact, pagination can be pushed fully into SQL without pages "shrinking" after app-side
  filtering. Keep the app-side `canReadSession` filter as a defensive check, but it should
  never remove rows.
- Schema: `sessions` table in `apps/control-plane/src/db/migrations/002_core.sql` (id, status,
  title, context jsonb, timestamps; later migrations add owner_group_id, visibility,
  write_policy, created_by_user_id, archived-related status). Existing indexes:
  `sessions_updated_created_idx (updated_at DESC, created_at DESC)` and
  `sessions_owner_group_updated_idx` (008). Session status enum includes `'archived'`
  (`store/types.ts:3-11`).
- Session content lives in two places:
  - `messages.prompt` (text) — user prompts.
  - `events.payload` (jsonb) — agent output. Crucially, the event delta compactor
    (`apps/control-plane/src/events/compaction.ts`, migration 011) deletes
    `agent_text_delta` events once a final `agent_response_final` event exists with the full
    text at `payload->'text'`. So the durable assistant text per run is the
    `agent_response_final` event; per-delta indexing would index rows that later disappear.
- Web client: `listSessions` in `apps/web/src/api.ts:327-329`; `refreshSessions` in
  `apps/web/src/app.tsx:951` replaces the whole `sessions` state array; the sidebar renders
  active sessions plus a collapsible archived section
  (`archivedSessionsOpenStorageKey` in `apps/web/src/app-helpers.ts`). The web app is the only
  consumer of `GET /sessions` (verified: no other callers in `packages/` or the control plane).
- Existing infra worth reusing: `startPeriodicTask` + advisory-lock helper in
  `apps/control-plane/src/app/periodic-task.ts` (used by the event compactor — the search
  indexer should follow the same pattern), and `events.listAllBatch(afterId, limit, ...)`
  (`apps/control-plane/src/events/service.ts:103`) which already implements cursor-batched
  reads over the global event log.

## 2. Goals and non-goals

Goals:

1. `GET /sessions` cost becomes O(page), not O(total sessions), at the SQL and payload level.
2. Archived sessions are no longer fetched by default (they are the unbounded-growth set).
3. Users can search sessions by title and by content (their prompts + agent responses),
   scoped by the same visibility rules as the list.
4. Memory-store and Postgres-store behavior stays in parity, covered by the shared contract
   suites.

Non-goals (explicitly rejected — do not implement):

- External search engine (Elasticsearch/Meilisearch/Typesense). This is a self-hosted app
  whose only stateful dependency is Postgres; adding a second stateful service for search is
  operationally unjustified at the target scale (tens of thousands of sessions). Postgres FTS
  - pg_trgm is sufficient and transactional.
- Offset (`?page=N`) pagination. Degrades linearly with depth and produces duplicate/skipped
  rows under the activity-ordered (`updated_at DESC`) sort.
- Semantic/embedding search (pgvector). Out of scope; the search-doc table designed below is a
  natural place to hang embeddings later if wanted.
- Indexing `agent_text_delta` events. They are deleted by compaction; index only durable text.

## 3. Design

### 3.1 API: paginated `GET /sessions`

Add query parameters (all optional, backward-compatible response shape):

- `limit` — default **50**, max **200**. The endpoint always caps; there is no "give me
  everything" escape hatch. The web app ships in the same repo, so it is updated in lockstep;
  flag the behavior change as `feat!:` in the commit for release-please/CHANGELOG.
- `cursor` — opaque keyset cursor. Encode `(updatedAt ISO, createdAt ISO, id)` as
  base64url JSON. The server decodes and applies
  `WHERE (updated_at, created_at, id) < ($cUpdated, $cCreated, $cId)` (row-value comparison,
  matching the `ORDER BY updated_at DESC, created_at DESC, id DESC` sort). Reject malformed
  cursors with 400 `invalid_request`.
- `archived` — `false` (default) excludes `status = 'archived'`; `true` returns only archived
  sessions. The sidebar's archived section becomes a lazily-loaded second list.
- `groupId` — optional filter to one owner group (validate the caller can see that group).

Response becomes `{ sessions: [...], nextCursor: string | null }`. `sessions` keeps its
existing element shape (`serializeSessionView` output) so `apps/web/src/static-demo/types.ts`
and tests need only additive changes. `nextCursor: null` means no more pages. Compute it by
fetching `limit + 1` rows and trimming.

Ordering note (accepted trade-off): because the sort key is `updated_at`, a session that
receives activity moves to the top; a client paging deep can miss it until refresh. That is
acceptable for an activity feed because the web app also receives per-session updates over the
global event stream (`/events/stream`) and can upsert rows it already knows about. Document
this in the endpoint's comment.

Also add a lightweight `GET /sessions/:sessionId` fallback usage on the client (already
exists, `server.ts:300`) for deep-linked/selected sessions not present in loaded pages.

### 3.2 Store layer

Replace `listSessionsWithLatestSandbox(provider, visibleTo?)` with a parameterized version
(same name is fine):

```
listSessionsWithLatestSandbox(provider, {
  visibleTo?: { groupIds: string[] },
  archived: boolean,
  groupId?: string,
  limit: number,
  cursor?: { updatedAt: Date; createdAt: Date; id: string },
}): Promise<{ items: SessionWithSandboxRecord[]; nextCursor: ... | null }>
```

Postgres implementation requirements:

- **Apply WHERE/ORDER/LIMIT to `sessions` in a subquery first, then lateral-join sandboxes.**
  Today the lateral join runs per session row before any limit; the fix is the main perf win:

  ```sql
  SELECT ... FROM (
    SELECT * FROM sessions
    WHERE <visibility> AND <archived filter> AND <cursor predicate>
    ORDER BY updated_at DESC, created_at DESC, id DESC
    LIMIT $n
  ) sessions
  LEFT JOIN LATERAL (SELECT ... FROM sandboxes ...) latest_sandbox ON TRUE
  ORDER BY sessions.updated_at DESC, sessions.created_at DESC, sessions.id DESC
  ```

- Keep `listSessions()` (unpaginated) only if other internal callers need it; audit callers
  and delete it from the interface if the endpoint was its only user (check worker/automation
  code before removing).

Memory implementation: same filtering/sorting/slicing over the in-memory map — trivial, but it
must match Postgres exactly; extend the shared contract suite with pagination cases (cursor
stability, tie-breaking on identical timestamps, archived filter, visibility filter).

Migration `012_sessions_pagination.sql`:

- `CREATE INDEX sessions_active_updated_idx ON sessions (updated_at DESC, created_at DESC, id DESC) WHERE status <> 'archived';`
- `CREATE INDEX sessions_archived_updated_idx ON sessions (updated_at DESC, created_at DESC, id DESC) WHERE status = 'archived';`
- Optionally drop `sessions_updated_created_idx` if nothing else uses it (verify with the
  other query sites first; `updateSessionForRun` etc. use PK lookups, so it is likely safe,
  but leave it if in doubt — it's small).

The group-name map currently built from `listGroups()` can stay (group count is small), or be
folded into the SQL as a join; not a scale concern either way.

### 3.3 Web app changes (`apps/web`)

- `api.ts` `listSessions(token)` → `listSessions(token, { cursor?, limit?, archived? })`
  returning `{ sessions, nextCursor }`.
- `app.tsx` state: keep an ordered list of loaded active sessions + `nextCursor`; a separate
  lazily-loaded archived list keyed off the existing collapsible section (fetch first archived
  page when the user expands it; "Load more" within it).
- Sidebar gets infinite scroll or a "Load more" button (button is simpler and fine for v1).
- `refreshSessions()` semantics change: re-fetch the **first page** and merge by id into the
  loaded set (replace matching rows, prepend unknown rows, drop nothing the user has scrolled
  to). Event-stream session events should upsert the affected row: if the session is unknown
  and the event implies it should be visible, fetch it via `GET /sessions/:id` and insert in
  sort order.
- Selected-session handling in `refreshSessions` (`app.tsx:963-976`) must tolerate the
  selected id not being in the first page: fetch it individually instead of deselecting.
- Update `apps/web/e2e/heavy-session-load.spec.ts` — it exists precisely to cover large
  session counts and should now assert paged behavior (first page renders fast, load-more
  fetches the next page, archived section loads on expand).

### 3.4 Search

#### Index storage: a dedicated search-doc table

Do **not** index `events.payload` or `messages.prompt` in place — payload extraction per event
type is fragile, compaction rewrites the event set, and both tables are hot write paths. Add a
derived table:

```sql
CREATE TABLE session_search_docs (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,              -- 'title' | 'prompt' | 'response'
  source_id text NOT NULL,         -- session id / message id / event id (dedup key)
  content text NOT NULL,           -- capped, e.g. first 16 KiB of source text
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(content, 16384))) STORED,
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, kind, source_id)
);
CREATE INDEX session_search_docs_tsv_idx ON session_search_docs USING GIN (tsv);
CREATE INDEX session_search_docs_session_idx ON session_search_docs (session_id);
```

Use the `'simple'` config (not `'english'`): session content is code-heavy and possibly
multilingual; stemming hurts more than it helps. Also add pg_trgm for title matching:
`CREATE EXTENSION IF NOT EXISTS pg_trgm;` + a GIN trgm index on `sessions.title` (substring
matches on titles are the most common quick-find gesture and FTS tokenization misses partial
identifiers). Note: verify the managed-Postgres targets in `deploy/` allow `pg_trgm` (it is
available on RDS/Cloud SQL/Neon); if extension creation must be optional, gate the trigram
index behind a try/catch in the migration runner and fall back to ILIKE without the index.

#### Index population: async worker, not synchronous writes

Reuse the event-compactor pattern (`periodic-task.ts` + advisory lock + cursor):

- A `search-indexer` periodic task tails the global event log via the same mechanism as
  `events.listAllBatch` (`events/service.ts:103`), persisting its position in a one-row
  cursor table (`search_index_cursor(last_event_id bigint)`).
- For each batch it upserts docs (`ON CONFLICT (session_id, kind, source_id) DO NOTHING`):
  - session created/title-updated events → upsert the `'title'` doc (kind `'title'`,
    source_id = session id, replace content on conflict).
  - message-created events → `'prompt'` doc from `messages.prompt` (source_id = message id).
    If message creation does not emit an event carrying the prompt, index prompts by tailing
    the `messages` table by `created_at`/id instead — implementer should check
    `apps/control-plane/src/messages/` and `events/types.ts` for what the event payloads
    actually carry and pick the cheaper source.
  - `agent_response_final` events → `'response'` doc from `payload->>'text'`
    (source_id = event id). These are durable post-compaction.
- Why async instead of indexing in the write path: keeps message/event insert latency
  unchanged, tolerates indexer bugs without breaking core flows, and gives a natural backfill
  path (below). Eventual consistency of a few seconds is fine for search.

Backfill: a one-shot script in `apps/control-plane/src/scripts/` (follow existing script
conventions there) that walks existing sessions/messages/final events in batches and upserts
docs, then seeds the cursor to the current max event id. Idempotent via the unique constraint.

#### Search API

New endpoint `GET /sessions/search?q=...&limit=...&cursor=...` (separate from the list
endpoint because the ordering semantics differ — relevance-ranked, not recency-ordered):

- Auth: same middleware chain as `/sessions`; the SQL must embed the same visibility predicate
  (`visibility = 'organization' OR owner_group_id = ANY($groups)`) joined from
  `session_search_docs` → `sessions`, plus the defensive app-side `canReadSession` filter.
- Query parsing: `websearch_to_tsquery('simple', q)` (handles quoted phrases, `-`negation,
  bare words; never throws on user input, unlike `to_tsquery`).
- Matching: `(docs.tsv @@ query)` UNION-style with a title trigram/ILIKE branch so partial
  title matches surface even when FTS tokens don't align.
- Aggregation: group by session — return one row per session with the best-ranked doc:
  `max(ts_rank(tsv, query))` as score, order by `score DESC, session.updated_at DESC`, and a
  snippet via `ts_headline('simple', content, query, 'MaxFragments=1, MaxWords=18')` from the
  top doc plus its `kind` (so the UI can label "matched in prompt/response/title").
- Pagination: keyset on `(score, updated_at, session_id)` is fiddly; offset pagination capped
  at e.g. 10 pages is acceptable **here** (result sets are small and relevance-ordered; users
  don't page deep into search results). Cap `limit` at 50.
- Response: `{ results: [{ session: <serializeSessionView shape>, snippet, matchKind, score }], nextCursor }`.
- Store interface: add `searchSessions(...)` to `SessionStore` with a naive substring-scan
  implementation in `memory.ts` (score = crude term-frequency; parity requirement is
  "returns the right sessions", not identical ranking — write the contract test accordingly).

#### Search UI

- Search input above the session sidebar; debounced (~250 ms) calls to the search endpoint;
  results replace the sidebar list while active, with snippet + match-kind badge; Escape/clear
  returns to the paged list. Archived sessions appear in results with their archived styling.

## 4. Implementation phases (each independently shippable)

1. **Pagination backend** — store interface change + Postgres/memory implementations +
   migration 012 + endpoint params + `nextCursor` + contract/API tests
   (`test/unit/api.test.ts`, `test/support/postgres-store-suite.ts`, `contracts.ts`,
   `test/integration/postgres-api-worker.test.ts` likely touches the listing).
2. **Web app pagination** — api.ts, app.tsx list state/merge logic, archived lazy load, load
   more, selected-session fallback; update `heavy-session-load.spec.ts` and app tests
   (`app.test.tsx` mocks `/sessions` responses — add `nextCursor`).
3. **Search backend** — migration 013 (docs table + indexes + pg_trgm), indexer periodic task
   wired where the event compactor is started (find its call site in server/worker startup),
   backfill script, `/sessions/search` endpoint, store method + contract tests, unit tests for
   query building and visibility filtering (there is precedent in
   `test/unit/session-access-matrix.test.ts` for access-matrix style tests — mirror it).
4. **Search UI** — sidebar search box + results rendering + e2e coverage.

Phases 1–2 land together in one release (the endpoint's default-limit change requires the
client update); 3–4 can follow independently.

## 5. Risks and edge cases for the implementer

- **Row-value comparison with mixed sort directions**: all three sort keys are DESC, so a
  single row-value `<` works. If anyone changes sort directions, the cursor predicate must be
  expanded into the explicit OR-chain form.
- **Timestamp precision**: `updated_at`/`created_at` are timestamptz (µs precision); cursor
  serialization must round-trip full precision (ISO with µs, or epoch micros) or pages can
  skip/duplicate rows with close timestamps. Cover with a contract test using equal
  timestamps.
- **Sessions bumped past the cursor**: acknowledged trade-off (§3.1); the event stream covers
  live updates. Do not try to fix with snapshot cursors.
- **Auth parity drift**: if `canReadSession` ever gains a condition not expressible in the SQL
  filter, pages will shrink. Add a code comment on both sides pointing at each other (there is
  already a comment convention for this in `store/types.ts:465`).
- **Indexer vs compaction ordering**: the indexer reads `agent_response_final` events, which
  are exactly what compaction preserves — but confirm the indexer cursor advances only after a
  successful upsert batch (crash-safe resume), and that `listAllBatch`-style reads see events
  in id order.
- **Doc size**: cap indexed content (16 KiB above) — `tsvector` has a hard 1 MiB limit and
  giant agent responses exist (OOM history on the deployed instance; keep memory bounded in
  the backfill batches too).
- **`context` jsonb payload weight**: `serializeSessionView` spreads the whole session record
  including `context`; while touching the endpoint, check whether the list view needs
  `context` at all — dropping it from list serialization is a cheap payload win (verify the
  web sidebar doesn't read it first).
