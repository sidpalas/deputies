# Plan 003: Make stale-run recovery deterministic when no messages are recoverable (and align the two stores)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- apps/control-plane/src/store/postgres.ts apps/control-plane/src/store/memory.ts apps/control-plane/test/unit/worker.test.ts apps/control-plane/test/integration/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug (correctness hardening)
- **Planned at**: commit `42ca671`, 2026-06-12
- **Execution status**: DONE on `main` — memory and Postgres recovery now finalize zero-message stale runs, recompute session status, preserve `recovered` semantics, and keep limit parity.

## Why this matters

`recoverStaleRuns` is the worker's safety net: when a run's lease expires (worker crash, hang), it marks the run `stale`, resets its messages to `pending`, and recomputes the session status. There is an edge case — a stale run whose messages are no longer in `processing`/`cancelling` (i.e. some other path already finalized them) — where the two store implementations diverge and both do something wrong:

- **Postgres** (`store/postgres.ts:1260-1316`): marks the run `stale`, then `continue`s **before** the session-status update, so the session row's status is never recomputed by recovery.
- **Memory** (`store/memory.ts:692-742`): `continue`s **before** marking the run stale, so the run keeps its expired lease and matching status — it will be re-selected and skipped on **every subsequent poll, forever**.

Unit tests run against the memory store on the premise that it mirrors Postgres semantics; in this edge case they don't match, so a test could pass against memory and lie about production. The fix makes the path total in both stores: always finalize the run as `stale`, always recompute session status, and only skip the `recovered` entry (which drives `run_failed` event emission) when there are no messages to re-queue.

This state is believed to be rare or unreachable through current normal flows (MED confidence) — step 1 verifies reachability, but the parity divergence is worth fixing regardless.

## Current state

- `apps/control-plane/src/store/postgres.ts:1260-1316` — `recoverStaleRuns`. Structure today:
  1. `SELECT ... FROM runs WHERE status IN ('starting','running','cancelling') AND lease_expires_at <= $1 ... FOR UPDATE SKIP LOCKED LIMIT $2`
  2. per stale run: `UPDATE runs SET status='stale', lease_owner=NULL, ... error='Run lease expired' WHERE id=$1`
  3. `UPDATE messages SET status='pending' WHERE id = ANY($1::uuid[]) AND status IN ('processing','cancelling') RETURNING ...`
  4. `const messages = ...; if (!messages[0]) continue;` ← **the early-continue at line 1297 that skips step 5**
  5. `UPDATE sessions SET status = CASE WHEN status='archived' THEN 'archived' WHEN EXISTS (pending messages) THEN 'queued' ELSE 'idle' END ...`
  6. `recovered.push({ message: messages[0], messages, run: toRun(runResult.rows[0]!) })`
- `apps/control-plane/src/store/memory.ts:692-742` — same operation. Structure today: collects `pendingMessages`, then `if (!pendingMessages.length) continue;` at line 712 **before** the run is marked stale (lines 714-722) and the session updated (lines 724-736).
- `apps/control-plane/src/worker/service.ts:142-160` — the only caller. For each `RecoveredRun` it appends a `run_failed` event per message (`payload: { error: ..., recovered: true }`). `RecoveredRun` (in `store/types.ts`) has a non-optional `message: MessageRecord`, so runs with zero recoverable messages **cannot** be represented in the return value — keep them out of `recovered`; do not change the type.
- Existing tests covering this method: `apps/control-plane/test/unit/worker.test.ts` (e.g. lines 133, 160, 362 — claims a message, advances the clock past the lease, calls `store.recoverStaleRuns`, asserts messages return to `pending`). Postgres integration tests live in `apps/control-plane/test/integration/` (see `postgres-store.test.ts` for the connection/setup pattern; integration tests require `TEST_DATABASE_URL`, see below).
- Repo vocabulary (CONTEXT.md): a **Run** is "an execution attempt by the agent for one or more claimed messages in a session"; a **Session** has statuses including `queued`/`idle`/`archived`. Use these terms in test names.

## Commands you will need

| Purpose              | Command                                                                                                                      | Expected on success                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Start local Postgres | `mise run //deploy/local:infra:up`                                                                                           | Postgres up; `deputies_test` DB exists |
| Migrate              | `mise run //apps/control-plane:db:migrate`                                                                                   | exit 0                                 |
| Typecheck            | `mise run //apps/control-plane:typecheck`                                                                                    | exit 0                                 |
| Unit tests           | `mise run //apps/control-plane:test`                                                                                         | all pass                               |
| Integration tests    | `TEST_DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies_test mise run //apps/control-plane:test:integration` | all pass                               |

(In a sandbox without Docker, start Postgres with `./deploy/sandboxes/daytona/start-postgres.sh` instead — see `AGENTS.md`.)

## Scope

**In scope** (the only files you should modify):

- `apps/control-plane/src/store/postgres.ts` (only `recoverStaleRuns`)
- `apps/control-plane/src/store/memory.ts` (only `recoverStaleRuns`)
- `apps/control-plane/test/unit/worker.test.ts` (add cases)
- `apps/control-plane/test/integration/postgres-store.test.ts` (add cases)

**Out of scope** (do NOT touch, even though they look related):

- `worker/service.ts` and `store/types.ts` — the caller contract and `RecoveredRun` shape stay as-is.
- The question of whether `cancelling` messages _should_ be reset to `pending` by recovery (they are today; that is existing, tested behavior — leave it).
- Lease claiming, heartbeat renewal, `failRunBatch` — adjacent but separate machinery.

## Git workflow

- Branch: `advisor/003-stale-run-recovery-edge-case`
- Commit style: Conventional Commits, e.g. `fix(control-plane): finalize stale runs with no recoverable messages`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the divergence with failing tests first

Write the tests from the Test plan section below **before** changing store code, and confirm they fail in the expected ways:

- Memory store: after constructing the edge state and calling `recoverStaleRuns` twice, the run is still not `stale` after the first call (current bug), so the assertion `run.status === 'stale'` fails.
- Postgres: after the edge state, the session status remains its pre-recovery value instead of being recomputed (current bug).

**Verify**: the new tests fail with assertions matching the two described behaviors (not with setup errors).

### Step 2: Fix the Postgres store

In `postgres.ts` `recoverStaleRuns`, move the session-status `UPDATE` (current lines 1299-1309) **above** the `if (!messages[0]) continue;` check so it always runs for every selected stale run. Then keep the guard so `recovered.push(...)` still only happens when `messages[0]` exists. Resulting order per stale run: mark run stale → reset messages → recompute session status → push to `recovered` only if messages were reset.

**Verify**: `TEST_DATABASE_URL=... mise run //apps/control-plane:test:integration` → the new Postgres case passes; all existing cases still pass.

### Step 3: Fix the memory store

In `memory.ts` `recoverStaleRuns`, restructure so that marking the run `stale` (lines 714-722) and the session-status update (lines 724-736) happen **before** / regardless of the `pendingMessages.length` check, and only `recovered.push(...)` (line 738) is guarded by `if (!pendingMessages.length) continue;`. The resulting per-run order must match Step 2's Postgres order exactly.

**Verify**: `mise run //apps/control-plane:test` → the new memory-store cases pass; all existing pass.

### Step 4: Full gates

**Verify**: `mise run //apps/control-plane:typecheck` → exit 0; unit + integration suites green.

## Test plan

New cases, named using repo vocabulary (e.g. "finalizes a stale run whose messages were already finalized"):

1. **Postgres integration** (`test/integration/postgres-store.test.ts`, follow the file's existing setup pattern): create a session + message, claim it (run becomes `running`, message `processing`), then put the message into a terminal state the recovery query won't match by issuing direct SQL through the test's pg client (`UPDATE messages SET status='cancelled' WHERE id=$1`) — direct SQL is acceptable here because no public store flow constructs this state; that's the point of the hardening. Expire the lease (recover with `now` past `leaseExpiresAt`). Assert: returned array is empty; the run row has `status='stale'`, `lease_owner IS NULL`, `error='Run lease expired'`; the session row status is recomputed (`'idle'` when no pending messages remain, `'queued'` if you add a second pending message; assert both variants or pick `idle`). Assert a second `recoverStaleRuns` call returns empty and changes nothing.
2. **Memory unit** (`test/unit/worker.test.ts`, follow the existing recoverStaleRuns tests at lines ~133-170): construct the same state. The memory store's maps are private; mutate the claimed message's status via a narrow cast in the test (`(store as unknown as { messages: Map<string, MessageRecord[]> })`) with a one-line comment explaining no public flow reaches this state. Same assertions as case 1, including the second-call-is-empty assertion (this is the regression test for the infinite re-selection bug).
3. **Parity guard**: assert in both cases that `recovered` is empty (the worker must not emit `run_failed` events for messages it didn't re-queue).

Existing tests at `worker.test.ts:133/160/362` are the structural pattern and must remain green unmodified.

## Done criteria

- [ ] `mise run //apps/control-plane:typecheck` exits 0
- [ ] `mise run //apps/control-plane:test` exits 0, including new memory-store cases
- [ ] `TEST_DATABASE_URL=... mise run //apps/control-plane:test:integration` exits 0, including the new Postgres case
- [ ] In both stores, a stale run with zero recoverable messages ends `status='stale'` with its session status recomputed, and repeated recovery calls are no-ops (asserted by tests)
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `recoverStaleRuns` bodies don't match the excerpts above (drift).
- Fixing the order in Postgres requires touching the SQL of steps 1–3 themselves (the fix should be a reordering plus guard move, not a query rewrite). If you find yourself rewriting the CTEs/queries, stop.
- Any _existing_ worker or integration test fails after your change — recovery ordering is load-bearing for queue semantics; do not adjust existing assertions to make them pass (repo principle: "Do not weaken tests to match accidental current behavior").
- The memory-store cast in the test is rejected by repo owners' conventions you discover (e.g. a lint rule); report rather than inventing a new public store API.

## Maintenance notes

- If a future flow legitimately finalizes messages independently of their run (e.g. the backlog's "scheduler loop that enqueues normal messages"), this edge state becomes reachable in production and these tests become the contract for it.
- Reviewer should scrutinize: the per-run operation order is now identical in `postgres.ts` and `memory.ts`; and `recovered` still never contains zero-message entries (the `RecoveredRun.message` field is non-optional).
- Deferred (deliberately): whether recovery should reset `cancelling` messages to `pending` — behavioral question for the maintainer, existing behavior preserved.
