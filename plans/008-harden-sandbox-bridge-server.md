# Plan 008: Harden the sandbox-bridge server (headers-sent guard + timing-safe bearer compare)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- packages/sandbox-bridge/src/server.ts packages/sandbox-bridge/test/server.test.ts`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (sibling of plan 002 — same comparison pattern, different package)
- **Category**: bug + security hardening
- **Planned at**: commit `42ca671`, 2026-06-12

## Why this matters

The sandbox bridge is the Node HTTP server that runs _inside_ every sandbox and proxies preview traffic to services the agent starts. Two small robustness gaps:

1. **Double-write on mid-stream upstream errors.** `proxyPreviewHttpRequest` calls `response.writeHead(...)` as soon as the upstream responds, then pipes the body. If the upstream errors _after_ headers are sent, the rejection bubbles to the top-level catch, which unconditionally calls `writeJson(response, ...)` → `response.writeHead(...)` a second time → Node throws `ERR_HTTP_HEADERS_SENT` inside the catch handler, producing an unhandled rejection and a hung client connection instead of a clean close.
2. **Non-timing-safe bearer comparison.** `isAuthorized` compares the bridge token with `===`. Plan 002 fixes the same pattern in the control plane's generic webhook; this is the only other `===` credential compare in the repo. The token is high-entropy so practical risk is low — this restores the repo-wide invariant.

## Current state

- `packages/sandbox-bridge/src/server.ts:338-374` — `proxyPreviewHttpRequest`. The risky sequence:

  ```ts
  (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      previewResponseHeadersFromNodeHeaders(upstreamResponse.headers),
    );
    upstreamResponse.pipe(response);
    upstreamResponse.once('end', resolve);
    upstreamResponse.once('error', reject);   // ← rejection after writeHead
  },
  ```

- `packages/sandbox-bridge/src/server.ts:~166-176` — the top-level request handler's catch:

  ```ts
  } catch (error) {
    writeJson(response, statusCodeForError(error), {
      error: error instanceof Error ? error.message : 'Unknown bridge error',
    });
  }
  ```

- `packages/sandbox-bridge/src/server.ts:634-637` — `writeJson`:

  ```ts
  function writeJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }
  ```

- `packages/sandbox-bridge/src/server.ts:639-641` — the weak compare:

  ```ts
  function isAuthorized(request: IncomingMessage, token: string): boolean {
    return request.headers.authorization === `Bearer ${token}`;
  }
  ```

- The timing-safe pattern to copy (from the control plane, `apps/control-plane/src/auth/session.ts:133-138`): `Buffer.from` both sides, length check, `timingSafeEqual` from `node:crypto`. This package currently imports nothing from `node:crypto`.
- Tests: `packages/sandbox-bridge/test/server.test.ts` — starts a real bridge server and makes real HTTP requests (see `it('requires bearer auth', ...)` at line 35 and the preview proxy tests further down). Model new cases on these.

## Commands you will need

| Purpose   | Command                                                                                                       | Expected on success |
| --------- | ------------------------------------------------------------------------------------------------------------- | ------------------- |
| Typecheck | `mise run //packages/sandbox-bridge:typecheck` (or `npx pnpm@11.5.2 --dir packages/sandbox-bridge typecheck`) | exit 0              |
| Tests     | `mise run //packages/sandbox-bridge:test` (or `... --dir packages/sandbox-bridge test`)                       | all pass            |
| Build     | `npx pnpm@11.5.2 --dir packages/sandbox-bridge build`                                                         | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/sandbox-bridge/src/server.ts`
- `packages/sandbox-bridge/test/server.test.ts`

**Out of scope** (do NOT touch):

- The WebSocket upgrade path (`proxyPreviewUpgrade`) — raw-socket, no ServerResponse; its destroy-both-on-error handling is fine.
- The control plane's `service-proxy.ts` — different layer, already has its own handling.
- Header filtering, cookie skipping, body-limit logic — adjacent code in the same file, not this plan.

## Git workflow

- Branch: `advisor/008-harden-sandbox-bridge`
- Commits: `fix(sandbox-bridge): guard error responses after headers are sent` and `fix(sandbox-bridge): timing-safe bridge token comparison`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Headers-sent guard

In the top-level catch (server.ts ~166-176), branch on `response.headersSent`: if headers were already sent, call `response.destroy()` (terminates the connection so the client sees a truncated response rather than a hang) instead of `writeJson`. Keep the existing `writeJson` path for the normal pre-headers case. Do the same guard anywhere else `writeJson` can run after a proxy attempt if you find one (`grep -n "writeJson" packages/sandbox-bridge/src/server.ts` and check each call site's reachability after `proxyPreviewRequest`).

**Verify**: typecheck → exit 0.

### Step 2: Test the mid-stream failure

In `server.test.ts`, add a test: start a stub upstream HTTP server that sends headers + a partial body, then destroys the socket mid-response; proxy a request to it through the bridge's `/preview/{port}/...` path; assert the bridge connection ends (request promise rejects or response truncates) **without** the bridge process emitting an unhandled rejection. Pattern: attach a `process.on('unhandledRejection')` spy for the test's duration and assert it wasn't called (restore it in `finally`). Model server/request setup on the existing preview proxy tests in the same file.

**Verify**: `mise run //packages/sandbox-bridge:test` → all pass; the new test fails if you temporarily revert step 1 (spot-check this, then re-apply).

### Step 3: Timing-safe compare

Rewrite `isAuthorized` (server.ts:639-641) using the `safeEqual` pattern from `apps/control-plane/src/auth/session.ts:133-138` (copy the helper into this file — the packages are independently deployable, no cross-package import): handle `undefined` authorization header with an early `false`, then length-check + `timingSafeEqual` against `` `Bearer ${token}` ``. Add `import { timingSafeEqual } from 'node:crypto';`.

Add test cases beside `it('requires bearer auth', ...)` (line 35): wrong token of equal length → 401/403 (match the existing test's expected status); missing header → same; correct token still works (existing tests cover this).

**Verify**: `mise run //packages/sandbox-bridge:test` → all pass; `mise run //packages/sandbox-bridge:typecheck` → exit 0; build → exit 0.

## Test plan

Covered in steps 2–3. Structural pattern: the existing real-server tests in `packages/sandbox-bridge/test/server.test.ts`.

## Done criteria

- [ ] `grep -n "=== \`Bearer" packages/sandbox-bridge/src/server.ts` → no matches
- [ ] `grep -n "headersSent" packages/sandbox-bridge/src/server.ts` → at least one guard in the catch path
- [ ] Typecheck, tests, and build all exit 0; new tests present for both fixes
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- The mid-stream test can't deterministically reproduce the truncation (raw-socket stub timing); after two attempts at a deterministic setup, report the flake rather than shipping a timing-dependent test.
- Fixing the catch path appears to require restructuring `proxyPreviewRequest`'s promise flow — the guard should be additive; restructuring is out of scope.

## Maintenance notes

- After this and plan 002 land, the repo invariant is "every credential comparison is timing-safe" — `grep -rn '=== \`Bearer' apps packages --include='\*.ts'` should stay empty; consider it a review checklist item.
- The `response.destroy()` choice means clients see connection-reset on mid-stream upstream failure; if a future bridge version wants graceful trailers/error frames, that's a protocol change, not a bug.
