# Plan 010: Add an object-level (cross-group) authorization test matrix

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- apps/control-plane/src/auth/authorization.js apps/control-plane/src/app/server.ts apps/control-plane/test/unit/api.test.ts apps/control-plane/test/unit/authorization.test.ts`
> Drift in server.ts route wiring is fine (this plan adds tests, not code);
> drift that _removes_ a tested route is a STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (tests only — unless they catch a real bug, which is the point)
- **Depends on**: none
- **Category**: tests (security)
- **Planned at**: commit `42ca671`, 2026-06-12
- **Execution status**: DONE on `main` — cross-group API authorization matrix covers read, write, stream, callback replay, queue, message, run, workspace-tool, and group-management paths.

## Why this matters

Authorization in Deputies is enforced per-object: sessions belong to an Access Group, and `canReadSession`/`canWriteSession` combine group membership, session `visibility` (`organization` | `group`), and `writePolicy` (`group_members` | `creator_only`). The rule _functions_ have unit tests (`authorization.test.ts`, 5 cases), and `sessionAuthorizationMiddleware` (`server.ts:1263-1281`) applies them with method-aware gating (unsafe HTTP methods require write). What's missing is the systematic API-level matrix: for each session-scoped route, prove a user in group B cannot read/write group A's `group`-visibility resources. IDOR regressions are the classic refactor casualty — a new route that forgets the middleware, or a handler that fetches by ID directly. A parameterized matrix makes that class of regression fail loudly. (This audit verified the current routes use `getAuthorizedSession` correctly — the matrix locks that in.)

## Current state

- `apps/control-plane/src/auth/authorization.ts` — exports `canReadSession`, `canWriteSession`, `canCreateSessionInGroup`, `canManageGroup`, `canMoveSession`, type `RequestAuthorization { bypass, user, memberships }`.
- `apps/control-plane/src/app/server.ts:1263-1281` — `sessionAuthorizationMiddleware`: resolves the session, then `unsafeMethods.has(method) ? canWriteSession : canReadSession`, 403 on failure; stores the session in context. `getAuthorizedSession` (`server.ts:1286-1290`) deliberately has **no store fallback** — routes that skip the middleware must not see sessions (comment in code says so).
- Existing unit tests of the rules: `apps/control-plane/test/unit/authorization.test.ts` — 5 `it` cases with local helpers `authFor(user, memberships)`, `user(name)`, `member(role)`, `session({ visibility, writePolicy })`. Extend this file's helper style.
- API-level test infrastructure: `apps/control-plane/test/unit/api.test.ts` — builds the real server (`createServer`/`createServices` from `src/app/server.js`) over `MemoryStore`, with session-cookie auth created via `store.upsertAuthUserForAccount(...)` + `store.createAuthSession(...)` (see existing usage around lines 669-690 and 2046-2060). Tests fetch real HTTP against `baseUrl` with a `cookie` header. **Copy this pattern.**
- Session-scoped routes to cover (all registered behind `sessionAuthorizationMiddleware` or per-route checks in `server.ts`; enumerate live ones with `grep -n "app\.\(get\|post\|patch\|delete\)('/sessions/:sessionId" apps/control-plane/src/app/server.ts`):
  - reads: session detail, messages list, events list, artifacts list (+ download/preview), external resources, callbacks, services
  - writes: enqueue message, edit/cancel message, cancel run, archive/restore, update title/access, replay callback, extend sandbox
- Group-management routes live in `app/group-routes.ts` and have their own checks (`canManageGroup`) — in scope for a smaller matrix.
- Vocabulary (CONTEXT.md): "Access Group — a flat product access scope that owns sessions...". Name tests accordingly ("cross-group", not "cross-tenant").

## Commands you will need

| Purpose     | Command                                                                                            | Expected on success |
| ----------- | -------------------------------------------------------------------------------------------------- | ------------------- |
| Unit tests  | `mise run //apps/control-plane:test`                                                               | all pass            |
| Typecheck   | `mise run //apps/control-plane:typecheck`                                                          | exit 0              |
| Single file | `npx pnpm@11.5.2 --dir apps/control-plane exec vitest run test/unit/session-access-matrix.test.ts` | all pass            |

## Scope

**In scope** (files you should create/modify):

- `apps/control-plane/test/unit/session-access-matrix.test.ts` (create — the API-level matrix)
- `apps/control-plane/test/unit/authorization.test.ts` (extend the rule-level cases)

**Out of scope** (do NOT touch):

- ALL production code. If a matrix case fails, that is a real finding: STOP, do not "fix" the route yourself.
- `api.test.ts` itself — the matrix gets its own file to stay readable; reuse its setup by copying, not by refactoring shared helpers out of it.
- Preview/service-proxy auth — covered by existing api.test.ts preview tests; different token machinery.

## Git workflow

- Branch: `advisor/010-idor-authorization-matrix`
- Commit style: `test(control-plane): add cross-group session access matrix`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Build the fixture

In the new `session-access-matrix.test.ts`, copying api.test.ts's server/store/auth setup: create two groups (A, B); users `aAdmin`, `aMember`, `aViewer` (memberships in A with roles admin/member/viewer), `bMember` (membership in B only), plus an org-wide user with no memberships. Create sessions in group A covering the policy grid: `{visibility: 'group' | 'organization'} × {writePolicy: 'group_members' | 'creator_only'}`. Each user gets a real auth session cookie via `upsertAuthUserForAccount` + `createAuthSession`.

**Verify**: the fixture test boots and a trivial assertion passes (`vitest run` on the file).

### Step 2: Read matrix

Parameterize over (user × session × read-route). Expected: `bMember` and the no-membership user get **404** for `visibility: 'group'` sessions (note: the middleware 403s, but confirm the actual status the routes return for unauthorized reads and assert that exact value — if it's 404-for-existence-hiding, assert 404; record which it is in your report) and 200 for `visibility: 'organization'`. Group-A users get 200 for everything in A. Cover at minimum: `GET /sessions/:id` (or the list-detail equivalent), `/messages`, `/events`, `/artifacts`, `/callbacks`, `/external-resources`, `/services` — use the live route list from the grep in Current state; skip routes needing live sandboxes (assert auth rejection still happens before any sandbox lookup, which it does via middleware ordering).

**Verify**: file passes; deliberately flip one expectation to confirm the matrix actually discriminates (then flip back).

### Step 3: Write matrix

Unsafe methods: enqueue message (`POST .../messages`), archive, update title. Expected: `aViewer` → 403 (read yes, write no); `bMember` → 403/404; `aMember` → 2xx where `writePolicy: 'group_members'`; for `creator_only` sessions, only the creator and group admins write (mirror the rule from `authorization.test.ts`'s "separates group viewer, member, and admin write permissions" case).

**Verify**: file passes.

### Step 4: Rule-level gaps

In `authorization.test.ts`, add missing rule cases discovered while building the matrix (e.g. `canMoveSession` cross-group, `bypass: true` behavior, super-admin role interactions if applicable). Keep the file's existing helper style.

**Verify**: `mise run //apps/control-plane:test` → entire suite passes.

## Test plan

This plan IS the test plan. Structural patterns: `api.test.ts` (HTTP-level fixtures + cookie auth) and `authorization.test.ts` (rule helpers).

## Done criteria

- [ ] `test/unit/session-access-matrix.test.ts` exists with read + write matrices over ≥ 6 routes and ≥ 4 user personas
- [ ] `mise run //apps/control-plane:test` exits 0 (or: any failure is reported as a security finding, see STOP)
- [ ] Zero production-code modifications (`git status` shows only the two test files)
- [ ] Report states the unauthorized-read status code convention found (403 vs 404)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **Any matrix case fails against current code** — that is a live IDOR/authorization bug. Report the route, persona, and expected-vs-actual; do not patch production code under a tests-only plan.
- A route from the Current state list no longer exists or moved files (drift).
- The MemoryStore fixture can't express something (e.g. creator-only needs `createdByUserId` plumbing that the public API doesn't expose) — report the gap rather than reaching into store internals beyond what api.test.ts already does.

## Maintenance notes

- New session-scoped routes should get a row in the matrix as part of their PR — cheap to add once the fixture exists; consider noting that in AGENTS.md (separate change).
- The matrix runs on MemoryStore; it validates middleware wiring and rules, not SQL. If a Postgres-specific authorization path ever appears (it shouldn't), this matrix won't see it.
