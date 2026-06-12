# Plan 007: Finish segregating the AppStore interface (type-only)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- apps/control-plane/src/store/types.ts apps/control-plane/src/automations/service.ts`
> If `store/types.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (type-only; zero runtime change)
- **Depends on**: none (soft: coordinate with plan 003, which edits store implementations — types-only here, so conflicts are unlikely)
- **Category**: tech-debt
- **Planned at**: commit `42ca671`, 2026-06-12
- **Execution status**: DONE on `main` — remaining `AppStore` methods were split into domain interfaces and clean consumers were narrowed type-only.

## Why this matters

`store/types.ts` already segregates seven domain store interfaces — `SessionStore` (line 471), `MessageStore` (500), `RunStore` (519), `SandboxStore` (568), `CallbackStore` (581), `AutomationStore` (600), `EventStore` (638) — and domain services correctly depend on the narrow ones (`SessionService` takes `SessionStore`, `MessageService` takes `MessageStore`, `CallbackService` takes `CallbackStore`). But the composition at line 654 (`interface AppStore extends ...`) then declares **~25 more methods flat on AppStore itself** (lines 656–708): auth users/sessions, groups/members, artifacts, external resources, webhook sources, external threads, integration deliveries. Anything needing one of those methods must depend on all ~70. Finishing the segregation makes each consumer's true store surface visible, lets tests fake only what a unit uses, and keeps the established pattern consistent for the next contributor.

## Current state

- `apps/control-plane/src/store/types.ts:654-708` — `AppStore` extends the seven interfaces and then declares the flat methods. The flat groups (verbatim method names from the file):
  - Auth: `upsertAuthUserForAccount`, `createAuthSession`, `getAuthUserBySession`, `deleteAuthSession`, `listAuthUsers`, `updateAuthUserRole`
  - Groups: `createGroup`, `getGroup`, `listGroups`, `updateGroup`, `upsertGroupMember`, `deleteGroupMember`, `getGroupMember`, `listGroupMembers`, `listUserGroupMemberships`
  - Artifacts: `createArtifact`, `getArtifacts`
  - External resources: `createExternalResource`, `getExternalResources`
  - Integration plumbing: `createWebhookSource`, `getWebhookSource`, `withExternalThreadLock?`, `getExternalThread`, `createExternalThread`, `createIntegrationDelivery`, `markIntegrationDeliveryProcessed`, `markIntegrationDeliveryFailed`
- Existing segregation pattern to copy — `store/types.ts:471`: `export interface SessionStore { ... }`, then `AppStore extends SessionStore, ...`.
- Implementations that must keep satisfying `AppStore` unchanged: `store/postgres.ts` (class `PostgresStore`), `store/memory.ts` (class `MemoryStore`). They need **no edits** — structural typing means they already implement the new sub-interfaces.
- One service that takes the full store but may not need it: `automations/service.ts:82-86` — `constructor(private readonly store: AppStore, ...)`. Whether it can narrow to `AutomationStore` depends on which methods it calls (step 3 determines this empirically).
- HTTP-layer consumers (`app/server.ts`, `app/group-routes.ts`, `app/service-proxy.ts`, `app/access-policy.ts`, `auth/middleware.ts`) legitimately take `AppStore` — they are composition roots. Leave them.

## Commands you will need

| Purpose     | Command                                                                                                                      | Expected on success |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Typecheck   | `mise run //apps/control-plane:typecheck`                                                                                    | exit 0              |
| Unit tests  | `mise run //apps/control-plane:test`                                                                                         | all pass            |
| Integration | `TEST_DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies_test mise run //apps/control-plane:test:integration` | all pass            |

## Scope

**In scope** (the only files you should modify):

- `apps/control-plane/src/store/types.ts`
- `apps/control-plane/src/automations/service.ts` (constructor type only, and only if step 3 says it narrows cleanly)
- Service files where step 3 finds a clean narrowing (constructor parameter type only)

**Out of scope** (do NOT touch):

- `store/postgres.ts`, `store/memory.ts` — implementations are structurally compatible; no edits.
- All `app/*` HTTP-layer files and `auth/middleware.ts` — composition roots keep `AppStore`.
- Test files — the point is that they _don't_ need changes; if one breaks, see STOP conditions.
- Any method signature. This plan moves declarations between interfaces; it changes zero signatures.

## Git workflow

- Branch: `advisor/007-appstore-interface-segregation`
- Commit style: `refactor(control-plane): segregate remaining AppStore methods into domain interfaces`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the flat methods into named interfaces

In `store/types.ts`, following the exact style of `SessionStore` at line 471, create:

- `AuthStore` (the 6 auth methods)
- `GroupStore` (the 9 group/member methods)
- `ArtifactStore` (2)
- `ExternalResourceStore` (2)
- `IntegrationStore` (the 8 webhook/external-thread/delivery methods, keeping `withExternalThreadLock?` optional as today)

Change `AppStore` to `extends SessionStore, MessageStore, RunStore, SandboxStore, CallbackStore, AutomationStore, EventStore, AuthStore, GroupStore, ArtifactStore, ExternalResourceStore, IntegrationStore` with an **empty body**. Keep every method name, signature, doc comment, and the `/** Returns null when... */` comment on `createIntegrationDelivery` byte-identical — cut/paste, don't retype.

**Verify**: `mise run //apps/control-plane:typecheck` → exit 0 (this alone proves both store implementations still satisfy everything).

### Step 2: Run the full suites untouched

**Verify**: `mise run //apps/control-plane:test` → all pass with zero test-file edits; integration suite likewise.

### Step 3: Narrow service constructors where it's free

For each domain service whose constructor takes `AppStore` (find them: `grep -rn "store: AppStore" apps/control-plane/src --include='*.ts' | grep -v "app/" | grep -v "auth/middleware"`), list its actual store calls (`grep -n "this.store\." <file>`). If every call belongs to one or two of the named interfaces, change the constructor parameter to that interface (or an inline intersection like `AutomationStore & GroupStore`). If the calls span 3+ interfaces, leave it as `AppStore` and note it in your report. Expected candidate: `automations/service.ts:82`.

**Verify**: typecheck + unit tests again → exit 0 / all pass.

## Test plan

No new tests — the deliverable is that the type refactor is invisible to every existing test. The typecheck is the primary gate; the suites prove no runtime drift.

## Done criteria

- [ ] `AppStore` in `store/types.ts` has an empty interface body (pure composition): `grep -A2 "export interface AppStore" apps/control-plane/src/store/types.ts` shows only `extends ... {}`
- [ ] All three verification commands exit 0
- [ ] Zero edits in `store/postgres.ts`, `store/memory.ts`, `app/*`, or any test file (`git status`)
- [ ] Report lists which services were narrowed and which stayed on `AppStore` (with the interface-span reason)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Typecheck fails after step 1 in `store/postgres.ts` or `store/memory.ts` — a signature was retyped inexactly; fix by re-copying, and if it still fails, the stores had a pre-existing structural gap worth reporting.
- Any test fails — type-only changes cannot break tests; a failure means something other than types changed.
- Narrowing a constructor in step 3 requires changing a _call site's_ type (e.g. a factory passes a narrower store than the service now wants) — leave that service on `AppStore` and note it.

## Maintenance notes

- New store methods should land in the matching domain interface, never flat on `AppStore` — the empty body makes violations visible in review.
- Follow-up (not this plan): focused mock factories per interface for unit tests, which this segregation enables.
- Reviewer: confirm the diff in `types.ts` is pure cut/paste (move detection) and constructor changes are type-position-only.
