# Plan 012: Repo housekeeping — fix the stale `packages/` docs claim and align vitest ranges

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- docs/README.md apps/control-plane/package.json apps/web/package.json packages/sandbox-bridge/package.json`
> Either item may have been fixed independently; skip any step whose target
> is already correct and note it.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs + dx
- **Planned at**: commit `42ca671`, 2026-06-12

Two unrelated one-line fixes share this plan because each is a single, independently verifiable edit. Commit them separately.

## Why this matters

1. `docs/README.md:32` claims `packages/` "is intentionally empty until shared code is extracted" — but `packages/sandbox-bridge` (the in-sandbox bridge server) and `packages/browser-milestones` (shared telemetry types) have existed for a while and are workspace dependencies of both apps. Actively-wrong docs are worse than missing docs for anyone (human or agent) orienting in the repo.
2. Vitest ranges drift across the workspace: `^4.0.0` in `apps/control-plane/package.json` and `packages/sandbox-bridge/package.json` vs `^4.1.5` in `apps/web/package.json`. Carets make this mostly cosmetic today, but aligned ranges keep resolution and snapshot behavior uniform.

## Current state

- `docs/README.md:32` (verbatim): `- \`packages/\`: reusable libraries shared by apps. It is intentionally empty until shared code is extracted.`
- The root `README.md` already has correct wording to borrow: "`packages/`: reusable libraries shared by apps, including the Docker sandbox bridge."
- `packages/README.md` documents the actual contents — keep the new line consistent with it.
- Manifests: `apps/control-plane/package.json` devDeps `"vitest": "^4.0.0"`; `packages/sandbox-bridge/package.json` `"vitest": "^4.0.0"`; `apps/web/package.json` `"vitest": "^4.1.5"`.
- Note `pnpm-workspace.yaml` `minimumReleaseAge: 4320` — resolution may pick a slightly older 4.x; that's fine.

## Commands you will need

| Purpose        | Command                        | Expected on success |
| -------------- | ------------------------------ | ------------------- |
| Install        | `npx pnpm@11.5.2 install`      | exit 0              |
| All unit tests | `mise run //:test`             | all pass            |
| Format         | `npx pnpm@11.5.2 format:check` | exit 0              |

## Scope

**In scope**: `docs/README.md` (line 32 only), the three package.json vitest entries, `pnpm-lock.yaml` (regenerated).

**Out of scope**: any other dependency version, any other docs wording, `packages/README.md`.

## Git workflow

- Branch: `advisor/012-repo-housekeeping`
- Two commits: `docs: correct packages/ description` and `chore: align vitest ranges across workspace`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the docs line

Replace `docs/README.md:32` with: `- \`packages/\`: reusable libraries shared by apps, including the Docker sandbox bridge and the browser-milestones telemetry package.`

**Verify**: `grep -n "intentionally empty" docs/README.md` → no matches.

### Step 2: Align vitest

Set `"vitest": "^4.1.5"` in `apps/control-plane/package.json` and `packages/sandbox-bridge/package.json`. Run `npx pnpm@11.5.2 install`.

**Verify**: `grep -rn '"vitest"' apps/*/package.json packages/sandbox-bridge/package.json` → all `^4.1.5`; install exits 0.

### Step 3: Prove the suites still run

**Verify**: `mise run //:test` → all packages pass; `npx pnpm@11.5.2 format:check` → exit 0.

## Test plan

No new tests; the full unit run in step 3 is the gate (vitest minor bumps occasionally change runner behavior — that's what we're checking).

## Done criteria

- [ ] `grep -rn "intentionally empty" docs/` → no matches
- [ ] All vitest ranges are `^4.1.5`; `mise run //:test` exits 0
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any test fails after the vitest alignment — report the failure; do not pin back down silently or modify tests.
- `docs/README.md:32` already changed (drift) — skip step 1, note it.

## Maintenance notes

- If the workspace later wants enforced version uniformity, pnpm's `catalog:` feature is the structural fix; out of scope here.
