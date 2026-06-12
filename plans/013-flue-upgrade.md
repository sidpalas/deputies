# Plan 013: Upgrade @flue/runtime past 0.10.0 and remove the affinity-key patch

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. This plan contains investigation steps whose findings feed the
> later steps — record what you find as you go; your final report must
> include them. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When done, update the status row for this
> plan in `plans/README.md` — unless a reviewer dispatched you and told you
> they maintain the index.
>
> **Drift check (run first)**: confirm `apps/control-plane/package.json` still has
> `"@flue/runtime": "0.8.0"` and `pnpm-workspace.yaml` still has the
> `patchedDependencies` entry for it. If either is gone, the upgrade already
> happened — STOP and report.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH (core runtime dependency; multiple breaking changes)
- **Depends on**: none. Supersedes plan 011 (the patch is removed here instead of documented).
- **Category**: migration
- **Planned at**: commit `42ca671`, 2026-06-12

## Decisions already made (do not re-litigate)

Recorded with the maintainer on 2026-06-12:

1. **Pre-upgrade Flue sessions need not be resumable.** If Flue rejects persisted pre-upgrade session state, Deputies starts a fresh Flue session for follow-up messages. Deputies' own session history (messages, events, artifacts in its own Postgres tables) is unaffected and must remain intact.
2. **Single combined task**: investigation and execution in this one plan, with STOP conditions guarding the genuinely unresolvable cases.
3. Advisor defaults accepted: **target version** = newest `@flue/runtime` installable under the workspace's `minimumReleaseAge: 4320` (3 days) at execution time, minimum acceptable **0.10.1**; **store scope** = minimal port of the existing custom session store to the new contracts — evaluating the official `@flue/postgres` package is explicitly deferred (note it in your report, don't do it).

## Why this matters

Deputies pins `@flue/runtime@0.8.0` plus a local patch that hashes over-long provider affinity keys. Upstream fixed the underlying issue in **0.10.0** (withastro/flue#183, commit `a783a7c`: persisted opaque `aff_<ULID>` keys per session; lossless storage keys unchanged), so the patch is now pure carrying cost — and 0.8.0 falls further behind a fast-moving pre-1.0 line (0.11.1 as of 2026-06-11) with each release. This plan lands the upgrade, deletes the patch, and records the migration in the repo's existing upgrade runbook.

## Current state — known breaking surface (verified 2026-06-12)

- `apps/control-plane/package.json`: `"@flue/runtime": "0.8.0"`, plus direct pins `@earendil-works/pi-coding-agent@0.78.0`, `@earendil-works/pi-ai@0.74.0` (used by `runner-pi/`, separate from Flue). Flue 0.10.1+ internally uses pi-ai 0.79.x — mixed pi versions across the tree are expected and acceptable unless install/peer resolution fails.
- `pnpm-workspace.yaml`: `patchedDependencies: '@flue/runtime@0.8.0': patches/@flue__runtime@0.8.0.patch`.
- **Known compile breaks** (from the upstream CHANGELOG, 0.10.0 "Runtime surface cleanup" and later):
  - `runner-flue/agent-factory.ts:12` — `import { configureProvider } from '@flue/runtime/app';` → the `/app` subpath is **removed** in 0.10.0. Find `configureProvider`'s new home in the target version's exports (check the package's `exports` map and `.d.ts`); if it no longer exists, find the replacement provider-configuration API in the docs/changelog.
  - `runner-flue/agent-factory.ts:13` — `import { createFlueContext, InMemorySessionStore, resolveModel } from '@flue/runtime/internal';` → `/internal` survived 0.10.0 but had removals in later releases; verify each of the three symbols in the target version.
  - `runner-flue/session-store.ts` — implements Flue's `SessionStore` (type imported from `@flue/runtime`) backed by Deputies Postgres (design doc: `docs/flue-persistence.md`). 0.10.x changed persistence contracts: custom adapters implement `connectRunStore()`, `connectRunRegistry()`, `SubmissionClaimRef` claiming, `renewLeases()`, `listExpiredSubmissions()`, `deleteSession()`, and `connectEventStreamStore()` is required on `PersistenceAdapter`. **Investigate which of these the embedded (in-process) usage actually exercises** — Deputies embeds the runtime via `agent-factory.ts`, it does not run Flue's generated HTTP server, so parts of the adapter surface may be optional in practice. Use the compiler plus the existing unit tests to find the true minimal surface.
  - `runner-flue/runner.ts:415-417` — handles `tool_execution_start/update/end` events, **removed** in 0.10.0. These cases sit in the passthrough/ignore region (lines ~406-420); they become dead and should be deleted. Re-verify the rest of the consumed event vocabulary (cases at lines 315-420: `text_delta`, `tool_start`, `tool_call`, `task_start`, `task`, `operation_start`, `operation`, `run_end`, `log`, ...) against the target version's event union — if the union type is exported, the TypeScript `switch` exhaustiveness will surface drift.
- **Session-state versioning**: 0.10.0 rejects pre-existing version-4 session state (the affinity model changed). Per Decision 1, handle rejection gracefully: when loading persisted Flue state fails validation for a pre-upgrade session, treat it as absent (log a warning naming the session id, start fresh). Find where `session-store.ts` / `agent-factory.ts` loads state and what the rejection looks like (error vs. null) by reading the new runtime's session-load path.
- **Legacy key fallback**: `docs/flue-upgrade.md:25` says "Existing legacy key fallback logic in `RealFlueAgentFactory` should be preserved" — that referred to the 0.7→0.8 transition. Given Decision 1, this fallback MAY now be removable; flag it in your report but only remove it if the fresh-start path makes it provably dead.
- **The patch**: `patches/@flue__runtime@0.8.0.patch` hashes provider-facing affinity keys >64 chars. The upstream `aff_<ULID>` model replaces it entirely. Delete the patch file and the `patchedDependencies` entry.
- **Existing regression net**: `apps/control-plane/test/unit/flue-runner.test.ts`, `flue-agent-factory.test.ts`, `flue-sandbox-factory.test.ts` exercise the adapter against the real library in-process. These are your primary gate. Opt-in real-Flue UAT (`test:uat`, requires credentials) exists; run it only if credentials are configured in your environment, and say in the report whether it ran.
- Repo principle (docs/README.md): "Tests define product behavior. Do not weaken tests to match accidental current behavior." If a Flue test asserts behavior the new version changed, the assertion change must be justified by a changelog entry, cited in the commit message.

## Commands you will need

| Purpose                     | Command                                                                                                                      | Expected on success                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Pick target version         | `npm view @flue/runtime time --json`                                                                                         | choose newest ≥3 days old, ≥0.10.1 |
| Install                     | `npx pnpm@11.5.2 install`                                                                                                    | exit 0, no patch warnings          |
| Typecheck                   | `mise run //apps/control-plane:typecheck`                                                                                    | exit 0                             |
| Unit tests                  | `mise run //apps/control-plane:test`                                                                                         | all pass                           |
| Integration                 | `TEST_DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies_test mise run //apps/control-plane:test:integration` | all pass                           |
| Build                       | `npx pnpm@11.5.2 --dir apps/control-plane build`                                                                             | exit 0                             |
| UAT (only if creds present) | `npx pnpm@11.5.2 --dir apps/control-plane test:uat`                                                                          | pass / skipped-with-reason         |

## Scope

**In scope** (files you may modify):

- `apps/control-plane/package.json` (the `@flue/runtime` version), `pnpm-workspace.yaml` (remove patch entry), `pnpm-lock.yaml`, delete `patches/@flue__runtime@0.8.0.patch`
- `apps/control-plane/src/runner-flue/**` (the adapter seam — this is where the migration lives)
- `apps/control-plane/src/db/migrations/` (a new additive migration ONLY if the persistence port requires a new table; follow the existing numbered-file pattern)
- `apps/control-plane/test/unit/flue-*.test.ts` (assertion changes only with changelog citation; new tests for the fresh-start path)
- `docs/flue-upgrade.md` (the migration record)

**Out of scope** (do NOT touch):

- `runner-pi/**` and the `@earendil-works/pi-*` version pins — separate runner, separate decision.
- Adopting `@flue/postgres` (Decision 3 — deferred; report only).
- Everything outside the runner-flue seam: `worker/`, `store/` (except a new migration file), `app/`, integrations. The architecture isolates Flue behind `runner-flue` — if the fix wants to leak past it, that's a STOP.
- The www/web apps.

## Git workflow

- Branch: `advisor/013-flue-upgrade`
- Commits per logical unit: `chore(control-plane): bump @flue/runtime to <version>`, `fix(control-plane): migrate runner-flue to <version> APIs`, `feat(control-plane): start fresh flue sessions on pre-upgrade state`, `chore: drop @flue/runtime affinity patch`, `docs: record flue <version> upgrade`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pick the target and bump

Compute the newest installable version (≥3 days old per `minimumReleaseAge`, minimum 0.10.1). Set it in `apps/control-plane/package.json`. Remove the `patchedDependencies` entry from `pnpm-workspace.yaml` and delete `patches/@flue__runtime@0.8.0.patch`. Run install.

**Verify**: `npx pnpm@11.5.2 install` → exit 0; `git status` shows the patch file deleted; record the chosen version.

### Step 2: Capture the error inventory, then burn it down

Run typecheck and save the full error list to your notes (count + per-file). Fix errors **only** by mapping each broken symbol to its target-version equivalent (package `exports`/`.d.ts` first, changelog second, upstream docs third — `flue docs` exists in `@flue/cli` if installed). Known anchors: `configureProvider` (`/app` removed), the three `/internal` imports, the `SessionStore`/adapter contract, removed `tool_execution_*` event cases in `runner.ts:415-417`.

**Verify**: `mise run //apps/control-plane:typecheck` → exit 0.

### Step 3: Port the persistence seam minimally

Make `session-store.ts` (and its wiring in `agent-factory.ts`) satisfy the target contract with the **smallest** surface the embedded usage exercises. Prefer: implement required methods backed by the existing `flue_sessions` table where semantics match; if a required method needs durable storage that has no home (e.g. event streams), add ONE additive migration following the `db/migrations` numbered pattern. In-memory implementations are acceptable only for surfaces the embedded runtime provably never calls in Deputies' usage (document each such choice in code with a one-line comment and in your report).

**Verify**: typecheck → exit 0; `mise run //apps/control-plane:test` → `flue-agent-factory.test.ts`, `flue-runner.test.ts`, `flue-sandbox-factory.test.ts` pass.

### Step 4: Implement the fresh-start path for pre-upgrade state (Decision 1)

Where persisted session state is loaded, catch/detect the new version's rejection of pre-upgrade state and fall back to starting a fresh Flue session: log a warning with the Deputies session id, do not fail the run, and never touch Deputies' own session/message/event rows. Add a unit test: seed the store with a state blob shaped like pre-upgrade (version-4) data, run a follow-up message through the fake-sandbox path, assert the run succeeds with a fresh Flue session and the warning is emitted. Model the test setup on `flue-agent-factory.test.ts`.

**Verify**: the new test passes; it fails if you disable the fallback (spot-check, then restore).

### Step 5: Full gates

**Verify**: typecheck, unit, integration (Postgres up + migrated first), and build all green. Run `test:uat` if credentials are configured; otherwise record "UAT skipped: no credentials" in the report.

### Step 6: Record the migration

Add a section to `docs/flue-upgrade.md` (matching its existing phase structure): chosen version, the import/API mapping table from step 2, the persistence-surface decisions from step 3, the Decision-1 record verbatim ("pre-upgrade Flue sessions start fresh; Deputies history unaffected"), patch removal (issue #183 / commit `a783a7c` reference), and deferred items (`@flue/postgres` evaluation, pi-\* alignment, legacy-key-fallback removal if you kept it).

**Verify**: `npx pnpm@11.5.2 format:check` → exit 0.

## Test plan

- Existing `flue-*.test.ts` suites are the primary regression net (assertion edits only with changelog citations in the commit message).
- New: the pre-upgrade-state fresh-start test (step 4).
- If step 3 added a migration: integration suite runs it automatically; assert the new table exists via the test that uses it.

## Done criteria

- [ ] `@flue/runtime` ≥0.10.1 in package.json; `grep -rn "flue" pnpm-workspace.yaml` → no patch entry; `ls patches/` → no flue patch
- [ ] `grep -n "@flue/runtime/app" apps/control-plane/src -r` → no matches
- [ ] `grep -n "tool_execution" apps/control-plane/src/runner-flue/runner.ts` → no matches
- [ ] All gates in step 5 green; UAT ran or skip reason recorded
- [ ] Fresh-start test exists and passes
- [ ] `docs/flue-upgrade.md` updated; report includes error-inventory count, API mapping, persistence-surface decisions, deferred items
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status rows updated (this plan, and 011 if not already marked superseded)

## STOP conditions

Stop and report back (do not improvise) if:

- A removed symbol (`configureProvider`, `createFlueContext`, `resolveModel`, or any other) has **no discoverable replacement** in the target version's exports, changelog, or docs — report the symbol and the three places you looked.
- The persistence port cannot be satisfied with the existing schema plus ONE additive migration — e.g. it demands restructuring `flue_sessions` or destructive changes. Schema redesign is a maintainer decision.
- The fix wants to escape `runner-flue/**` (changes in `worker/`, `store/types.ts`, or runner-agnostic code) — the architecture isolates Flue behind this seam; a leak means the seam itself needs rethinking.
- The step-2 error inventory exceeds ~80 errors after the known anchors are fixed — the surface moved more than assessed; report the inventory instead of grinding.
- Any non-flue test fails — the upgrade must be invisible outside the seam.
- `flue-*.test.ts` failures that reflect genuine behavior changes you cannot map to a changelog entry.

## Maintenance notes

- Deferred follow-ups for the maintainer: evaluate `@flue/postgres` replacing the custom store; align `@earendil-works/pi-*` pins (Flue uses 0.79.x internally); remove the legacy-key fallback in `RealFlueAgentFactory` if step 4 made it dead; revisit Durable Streams adoption if Deputies ever consumes Flue over HTTP instead of in-process.
- Reviewer: scrutinize step 3's "provably never called" in-memory choices (each needs the code comment), and every test-assertion edit (must cite a changelog entry).
- Operationally: deploys after this upgrade will start fresh Flue sessions for all in-flight work — schedule accordingly; the one-time provider cache miss per session is expected.
