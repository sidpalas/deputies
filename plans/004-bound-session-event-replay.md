# Plan 004: Bound the session event list endpoint and page through it in the web client

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- apps/control-plane/src/app/server.ts apps/control-plane/src/events/service.ts apps/web/src/api.ts apps/web/src/session-detail-loader.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `42ca671`, 2026-06-12
- **Execution status**: DONE on `main` — session event listing is paged with `limit`/`cursor`/`hasMore`, and the web client follows pages defensively.

## Why this matters

`GET /sessions/:sessionId/events` returns the session's **entire** remaining event history in one unbounded query and one JSON body. The product's own definitions (CONTEXT.md) set "Normal Session History" at up to 2,000 replayable events with a Session Detail Ready target of p95 < 250 ms, and say "Larger histories may require incremental loading." Sessions that exceed the bound (long agent runs accumulate deltas faster than compaction trims them) produce multi-MB responses that blow the latency budget and browser memory. The SSE stream already replays in bounded batches (`events/service.ts` `listBatch`, used by `app/event-stream.ts`); the REST list endpoint is the remaining unbounded path, and it's the one the web client uses for initial session load. The fix: server-side cap with an additive paging contract, and a client that pages until done.

## Current state

- `apps/control-plane/src/app/server.ts:870-878` — the unbounded route:

  ```ts
  app.get('/sessions/:sessionId/events', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = getAuthorizedSession(c, sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const after = parseCursor(c.req.query('after') ?? null);
    const events = await services.events.list(sessionId, after);
    return c.json({ events });
  });
  ```

- `apps/control-plane/src/events/service.ts:82-93` — `list` is unbounded; `listBatch` already exists with exactly the needed shape:

  ```ts
  async list(sessionId: string, afterSequence?: number) {
    return this.store.getEvents(sessionId, afterSequence);
  }

  async listBatch(sessionId: string, afterSequence: number, limit: number): Promise<EventBatch> {
    const events = await this.store.getEvents(sessionId, afterSequence, limit);
    return {
      events,
      cursor: events[events.length - 1]?.sequence ?? afterSequence,
      hasMore: events.length === limit,
    };
  }
  ```

  Both stores already accept a limit: `getEvents(sessionId, afterSequence = 0, limit?)` (`store/postgres.ts:1865`, `store/memory.ts:1039`, interface at `store/types.ts:646`).

- `apps/web/src/api.ts:719-731` — the client wrapper:

  ```ts
  export async function listEvents(sessionId, token, after?, options = {}): Promise<AgentEvent[]> {
    const body = await request<{ events: AgentEvent[] }>(
      `/sessions/${sessionId}/events${after ? `?after=${after}` : ''}`,
      { token, ...options },
    );
    return body.events;
  }
  ```

- `apps/web/src/session-detail-loader.ts:67-69` — the only initial-load call site: `listEvents(input.sessionId, input.token, undefined, requestOptions(...))`, awaited in parallel with messages for Session Detail Ready (line 88).
- There is also an unbounded **global** route `GET /events` at `server.ts:524-535` (`services.events.listAll` / `listAllEvents`; bounded sibling `listAllBatch` exists at `events/service.ts:103-111`). It is operator/debug-facing — see Out of scope.
- Conventions: route handlers return `writeError(c, 400, 'invalid_request', ...)` for bad query params (see `parseCursor` usage patterns in `server.ts`); API tests live in `apps/control-plane/test/unit/api.test.ts`; web unit tests in `apps/web/src/app.test.tsx` mock the API module.
- CONTEXT.md vocabulary to use in code/comments/tests: "Session Detail Ready", "Normal Session History" (≤ 100 messages, ≤ 2,000 replayable events).

## Commands you will need

| Purpose              | Command                                   | Expected on success |
| -------------------- | ----------------------------------------- | ------------------- |
| CP typecheck         | `mise run //apps/control-plane:typecheck` | exit 0              |
| CP unit tests        | `mise run //apps/control-plane:test`      | all pass            |
| Web typecheck        | `mise run //apps/web:typecheck`           | exit 0              |
| Web unit tests       | `mise run //apps/web:test`                | all pass            |
| Web e2e (full check) | `mise run //apps/web:e2e`                 | all pass            |

## Scope

**In scope** (the only files you should modify):

- `apps/control-plane/src/app/server.ts` (only the `/sessions/:sessionId/events` handler)
- `apps/control-plane/test/unit/api.test.ts` (add cases)
- `apps/web/src/api.ts` (`listEvents`)
- `apps/web/src/session-detail-loader.ts` (page until `hasMore` is false)
- `apps/web/src/app.test.tsx` / `apps/web/src/test/` only if existing mocks of `listEvents` need their return shape updated

**Out of scope** (do NOT touch, even though they look related):

- `GET /events` (global, `server.ts:524-535`) — operator/debug surface with different auth filtering (`readableEvents`); bounding it is a follow-up, noted in Maintenance.
- `app/event-stream.ts` and both `/events/stream` routes — SSE replay is already batched.
- `events/service.ts` — `listBatch` already does what's needed; reuse it, don't modify it.
- Event compaction, retention, windowed/virtualized session rendering — known product decisions explicitly deferred by the maintainers.
- `apps/web/vite.config.ts`, `apps/web/Caddyfile*` — no new route is added, only query params; proxies match by path and need no change.

## Git workflow

- Branch: `advisor/004-bound-session-event-replay`
- Commit style: Conventional Commits, e.g. `perf(control-plane): page session event replay` (commit server and web changes separately if convenient)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Cap the route, additively

Rewrite the `/sessions/:sessionId/events` handler to:

1. Parse optional `limit` query param: positive integer, default **1000**, max **2000** (values above max are clamped; non-numeric/zero/negative → `writeError(c, 400, 'invalid_request', 'Expected a positive integer limit')`).
2. Call `services.events.listBatch(sessionId, after ?? 0, limit)`.
3. Return `c.json({ events: batch.events, cursor: batch.cursor, hasMore: batch.hasMore })`.

The response keeps the `events` field (existing consumers keep working) and adds `cursor`/`hasMore` additively. A session whose remaining history is under the limit gets one response with `hasMore: false` — behaviorally identical to today for Normal Session History.

**Verify**: `mise run //apps/control-plane:typecheck` → exit 0.

### Step 2: API tests for the new contract

In `apps/control-plane/test/unit/api.test.ts` (follow the file's existing route-test pattern — it builds the app and fetches against it), add:

- session with N events, no `limit` → all events, `hasMore: false`, `cursor` equals last event's sequence
- `limit` smaller than the event count → exactly `limit` events, `hasMore: true`; following `cursor` with `after` returns the rest and `hasMore: false`
- `limit=0` and `limit=abc` → 400 `invalid_request`
- `after` combined with `limit` still respects authorization (route already sits behind `sessionAuthorizationMiddleware` via `getAuthorizedSession` — just confirm an unauthorized request still 401/403s in the existing pattern)

**Verify**: `mise run //apps/control-plane:test` → all pass including new cases.

### Step 3: Page in the web client

In `apps/web/src/api.ts`, change `listEvents` to request with an explicit `limit` (use 1000) and loop: request, append `body.events`, and while `body.hasMore`, request again with `after=body.cursor`. Return the concatenated array — the function signature and return type (`Promise<AgentEvent[]>`) stay the same, so `session-detail-loader.ts:69` and milestone timing code need no structural change. Guard the loop: stop and return what you have if a page returns 0 events while claiming `hasMore` (defensive; prevents an infinite loop against a misbehaving server). Treat a response without `hasMore`/`cursor` fields (older server) as `hasMore: false`.

**Verify**: `mise run //apps/web:typecheck` → exit 0; `mise run //apps/web:test` → all pass (update `listEvents` mocks' return shape only where the test fakes the raw HTTP response rather than the function).

### Step 4: Full gates

**Verify**: all five commands in the table above pass, including `mise run //apps/web:e2e` (the e2e suite includes a heavy-session-load spec that exercises session detail loading end to end).

## Test plan

- Server cases: listed in Step 2, in `apps/control-plane/test/unit/api.test.ts`, modeled on that file's existing `/sessions/:id/events`-adjacent tests.
- Client cases: in the web unit suite, add a test that `listEvents` follows `hasMore`/`cursor` across two pages and concatenates in order, and one for the zero-events-with-hasMore guard. Follow the existing API-mocking pattern used by `app.test.tsx` / `apps/web/src/test/`.
- Regression: existing api.test.ts event-listing tests must pass with at most additive assertion changes (the response gained two fields).

## Done criteria

- [ ] `grep -n "services.events.list(" apps/control-plane/src/app/server.ts` returns no match for the session events route (it now uses `listBatch`)
- [ ] All five verification commands exit 0
- [ ] New server tests cover: default limit, paging via cursor, invalid limit → 400
- [ ] New client test covers multi-page concatenation
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The route or `listEvents` excerpts don't match the live code (drift).
- You find another consumer of `GET /sessions/:sessionId/events` besides `apps/web/src/api.ts` (search: `grep -rn "sessions/.*events" apps packages --include='*.ts' --include='*.tsx' | grep -v stream | grep -v test | grep -v node_modules`) — e.g. the static demo exporter (`apps/control-plane/src/scripts/export-static-demo.ts`) or `packages/sandbox-bridge`. If such a consumer exists and would be truncated by the default limit, stop and report it.
- e2e fails on the heavy-session-load spec after your change — the paging changed Session Detail Ready timing in a way the milestones tests notice; report numbers, don't tune thresholds.

## Maintenance notes

- The global `GET /events` route (`server.ts:524-535`) remains unbounded; `listAllBatch` already exists for it. Natural follow-up with the same contract.
- If session-list virtualization / windowed detail loading lands later (a known deferred product decision), the client-side "fetch all pages" loop should become "fetch most recent window first" — the server contract built here already supports that.
- Reviewer: check the clamp values (1000 default / 2000 max — chosen to match the "Normal Session History" ≤ 2,000 events definition in CONTEXT.md) and that the response stayed backward compatible.
