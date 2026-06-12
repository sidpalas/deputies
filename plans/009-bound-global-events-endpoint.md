# Plan 009: Bound the global `GET /events` endpoint

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- apps/control-plane/src/app/server.ts apps/control-plane/src/events/service.ts`
> Also read plan 004's status in `plans/README.md` first — this plan
> intentionally mirrors 004's response contract and is much easier after it.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 004 (contract precedent; execute 004 first)
- **Category**: perf
- **Planned at**: commit `42ca671`, 2026-06-12
- **Execution status**: DONE on `main` — global event listing is paged with pre-filter cursor semantics and a separate response contract from unpaged session events.

## Why this matters

`GET /events` returns every product event after a cursor, across **all sessions**, in one response. It is the last unbounded event query after plan 004 bounds the per-session route. Today its only consumers are operators/scripts (the web UI uses only the `/events/stream` SSE route — verified by grep at planning time), but an instance that has run for months can hold hundreds of thousands of events, making this route a self-inflicted memory/latency spike. The bounded sibling (`listAllBatch`) already exists and is used by the global SSE stream.

## Current state

- `apps/control-plane/src/app/server.ts:524-535` — the route:

  ```ts
  app.get('/events', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const after = parseCursor(c.req.query('after') ?? null);
    const includeAll = c.req.query('include') === 'all';
    const events = await readableEvents(
      services.store,
      auth,
      includeAll ? await services.events.listAllEvents(after) : await services.events.listAll(after),
    );
    return c.json({ events });
  });
  ```

  Note the route is also behind `apiAuthMiddleware` (registered at `server.ts:370`).

- `apps/control-plane/src/events/service.ts:95-111` — `listAll` / `listAllEvents` are unbounded; `listAllBatch(afterId, limit, includeAllEvents)` already returns `{ events, cursor, hasMore }`, where `cursor` tracks **fetched (pre-filter)** ids so paging advances past filtered-out events (same convention as the SSE replay; see the comment in `app/event-stream.ts:156-157`).
- `readableEvents(...)` (in `server.ts`, helper around line 1531's `createEventReadFilter`) applies per-event authorization filtering **after** the fetch — so a page may legitimately return fewer (even zero) events while `hasMore` is true. The response contract must expose `cursor`/`hasMore` so callers page by cursor, never by counting events.
- Plan 004 (per-session route) established the contract: optional `limit` query param (default 1000, max 2000, invalid → 400 `invalid_request`), response `{ events, cursor, hasMore }`. Match it exactly.
- Consumers verified at planning time: none in `apps/web/src`, `packages/`, or scripts — only the route itself. Re-verify in step 1.

## Commands you will need

| Purpose    | Command                                   | Expected on success |
| ---------- | ----------------------------------------- | ------------------- |
| Typecheck  | `mise run //apps/control-plane:typecheck` | exit 0              |
| Unit tests | `mise run //apps/control-plane:test`      | all pass            |

## Scope

**In scope** (the only files you should modify):

- `apps/control-plane/src/app/server.ts` (only the `GET /events` handler)
- `apps/control-plane/test/unit/api.test.ts` (add cases)

**Out of scope** (do NOT touch):

- `/events/stream` and `/sessions/:id/events*` routes.
- `events/service.ts` — `listAllBatch` is used as-is. (If plan 004 added shared limit-parsing helpers in `server.ts`, reuse them.)
- `readableEvents` / `createEventReadFilter` — authorization filtering is unchanged.

## Git workflow

- Branch: `advisor/009-bound-global-events`
- Commit style: `perf(control-plane): page the global events listing`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Re-verify there are no external consumers

`grep -rn "'/events'" apps packages --include='*.ts' --include='*.tsx' | grep -v stream | grep -v node_modules | grep -v test` → only the server route definition. If anything else appears, STOP and report it.

### Step 2: Convert the route to `listAllBatch`

Parse `limit` exactly as plan 004 does (default 1000, max 2000, invalid → `writeError(c, 400, 'invalid_request', ...)`; reuse 004's helper if it exists). Call `services.events.listAllBatch(after ?? 0, limit, includeAll)`, apply `readableEvents` to `batch.events`, and return `c.json({ events: filtered, cursor: batch.cursor, hasMore: batch.hasMore })`.

**Verify**: `mise run //apps/control-plane:typecheck` → exit 0.

### Step 3: Tests

In `api.test.ts` (existing route-test pattern), add:

- fewer events than `limit` → all returned, `hasMore: false`
- more events than `limit` → page 1 has `limit` events and `hasMore: true`; following `cursor` returns the rest
- authorization filtering: a user who can read only some sessions gets a page where `events.length < limit` but `cursor` still advanced past the filtered events (this is the contract subtlety — assert paging by cursor reaches the end)
- `limit=abc` → 400

**Verify**: `mise run //apps/control-plane:test` → all pass.

## Test plan

Covered in step 3; model on the api.test.ts cases plan 004 added (or the file's existing `/events`-adjacent tests if 004's aren't merged yet).

## Done criteria

- [ ] `grep -n "listAllEvents(after)\|listAll(after)" apps/control-plane/src/app/server.ts` → no matches in the `GET /events` handler
- [ ] Typecheck and unit tests exit 0; the four new cases exist
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 finds a consumer of the unpaged response.
- The route excerpt doesn't match the live code (drift, or plan 004 already restructured this area differently than assumed).
- `listAllEvents`/`listAll` turn out to have other callers that would become dead code — leave them and note it; deleting service methods is not in scope.

## Maintenance notes

- After this lands, every event read path is bounded (SSE replay batches, per-session pages, global pages). New event-listing endpoints should start from `listBatch`/`listAllBatch`, never the unbounded methods — consider deprecating `list`/`listAll`/`listAllEvents` in a follow-up once callers are confirmed gone.
- Reviewer: the post-filter `cursor` semantics (advance past filtered events) is the one thing to get right; the test in step 3 bullet 3 is the proof.
