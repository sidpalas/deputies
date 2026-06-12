# Plan 005: Add an ESLint baseline (flat config) wired into scripts, mise, and CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- package.json mise.toml .github/workflows/run-tests.yml`
> Also run `ls eslint.config.* 2>/dev/null` — if a config already exists,
> this plan is superseded; STOP and report.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (initial triage churn, no runtime risk)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `42ca671`, 2026-06-12
- **Execution status**: DONE on `main` — ESLint flat config, scripts, mise task, CI job, and mechanical baseline fixes are landed.

## Why this matters

The repo has Prettier, TypeScript strict typechecks, and strong test suites — but **no linter at all** (no `eslint.config.*`, no eslint dependency in any manifest). Whole bug classes that typecheck cleanly go uncaught until review or runtime: unawaited floating promises (this codebase is heavily async — worker loops, SSE, stores), unused variables/imports, accidental `==`, switch fallthrough. This repo is explicitly built for agent-driven development (AGENTS.md, agent runbooks); a linter is the cheapest reviewer-multiplier for both humans and agents. The single highest-value rule here is `@typescript-eslint/no-floating-promises`, which requires type-aware linting.

## Current state

- No linter: `ls eslint.config.* .eslintrc*` → nothing; `grep -l eslint apps/*/package.json packages/*/package.json` → nothing.
- Root `package.json` scripts: `format`, `format:check`, `test`, `typecheck`, `check` (`pnpm format:check && pnpm typecheck && pnpm test`). Workspace: pnpm 11.5.2, Node >= 24, workspaces `apps/*`, `packages/*`.
- Root `mise.toml` defines tasks `format:check`, `typecheck`, `test`, and `check` (`depends = ["format:check", "typecheck", "test"]`). CI calls `mise run //:<task>`.
- CI: `.github/workflows/run-tests.yml` has jobs `format`, `typecheck`, `unit` (matrix), `control-plane-integration`, `web-e2e`. Each job: checkout → `uses: ./.github/actions/setup-ci` → `mise run <task>`. The `format` job is the simplest template to copy (runs `mise run //:format:check`).
- TS projects: `apps/control-plane` (Node, tsconfig.json + tsconfig.build.json), `apps/web` (React 19, tsconfig.json + tsconfig.e2e.json), `apps/www` (static site — check for TS before including), `packages/sandbox-bridge`, `packages/browser-milestones` (plain `.js` + `.d.ts` — exclude or lint as JS).
- Prettier owns formatting (`prettier-plugin-astro` is present — `apps/www` contains Astro files; ESLint should **not** lint `.astro` files in this plan).
- `pnpm-workspace.yaml` has `minimumReleaseAge: 4320` (3 days) — pnpm may resolve slightly older package versions; that's fine.
- Generated/vendored dirs to ignore: `**/dist/`, `**/node_modules/`, `apps/web/src/static-demo/` (exported demo data), `apps/www/public/`, `apps/web/test-results/`, `coverage`.

## Commands you will need

| Purpose       | Command                               | Expected on success |
| ------------- | ------------------------------------- | ------------------- |
| Install       | `npx pnpm@11.5.2 install` (repo root) | exit 0              |
| Lint          | `npx pnpm@11.5.2 lint` (after step 2) | exit 0              |
| Typecheck all | `mise run //:typecheck`               | exit 0              |
| Tests all     | `mise run //:test`                    | all pass            |
| Format        | `npx pnpm@11.5.2 format`              | exit 0              |

## Scope

**In scope** (the only files you should modify/create):

- `eslint.config.js` (create, repo root)
- `package.json` (root: devDependencies + `lint` script; add `lint` to the `check` script)
- `mise.toml` (root: `lint` task; add to `check` depends)
- `.github/workflows/run-tests.yml` (new `lint` job)
- Source files across `apps/*/src`, `apps/control-plane/test`, `apps/web/e2e`, `packages/sandbox-bridge/src|test` — **only** mechanical fixes required to get the chosen rule set green (see Step 3 constraints)

**Out of scope** (do NOT touch):

- `.husky/pre-commit` — keeping the hook Prettier-only is a deliberate speed choice; CI is the lint gate. (Noted in Maintenance.)
- Prettier config, any formatting concerns — ESLint stylistic rules must be off (no `eslint-config-prettier` needed if no stylistic rules are enabled).
- `.astro` files, `apps/web/src/static-demo/`, generated `dist/` output.
- Any behavioral refactor "while you're in there." Lint fixes must be semantics-preserving.

## Git workflow

- Branch: `advisor/005-eslint-baseline`
- Commits: separate `chore: add eslint flat config and wiring` from `chore: fix lint violations` (mechanical fixes reviewed apart from config).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Install and configure

At repo root: `npx pnpm@11.5.2 add -D -w eslint typescript-eslint @eslint/js globals`.

Create `eslint.config.js` (ESM — root package.json has `"type": "module"`):

- `@eslint/js` `recommended` + `typescript-eslint` `recommendedTypeChecked` for `**/*.ts`/`**/*.tsx`, with `languageOptions.parserOptions.projectService: true` and `tsconfigRootDir: import.meta.dirname`.
- Global ignores: the generated/vendored dirs listed in Current state, plus `eslint.config.js` itself and `**/*.d.ts`.
- Turn OFF rules that fight this codebase's idioms rather than mass-suppressing inline: set `@typescript-eslint/no-unused-vars` to error with `{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }` (the repo already uses `_leaseExpiresAt`-style discards — see `store/memory.ts:714`).
- Keep ON (these are the payload): `no-floating-promises`, `no-misused-promises`, `await-thenable`, `require-await` off (too noisy, leave off), `no-unnecessary-type-assertion`.
- For `apps/web`: add `globals.browser`; for Node packages: `globals.node`.
- No stylistic rules anywhere.

**Verify**: `npx pnpm@11.5.2 exec eslint --version` → v9+; `npx pnpm@11.5.2 exec eslint . 2>&1 | tail -5` runs to completion (violations expected at this point).

### Step 2: Wire scripts, mise, CI

1. Root `package.json`: add `"lint": "eslint ."` and change `check` to `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.
2. Root `mise.toml`: add a `lint` task (`description = "Lint the workspace"`, `run = "pnpm lint"`) and add `"lint"` to `[tasks.check]` depends.
3. `.github/workflows/run-tests.yml`: add a `lint` job cloned from the `format` job (same `if:` release-skip condition, same checkout + `./.github/actions/setup-ci` steps), running `mise run //:lint`, `timeout-minutes: 10`.

**Verify**: `mise run //:lint` invokes eslint (exit code may still be 1 until step 3).

### Step 3: Triage to green

Run `npx pnpm@11.5.2 lint` and drive to exit 0 under these constraints:

- Mechanical, semantics-preserving fixes only: remove unused imports, prefix intentionally unused vars with `_`, add `void` to genuinely fire-and-forget promises **only where the surrounding code already shows that intent** (e.g. existing `.catch(() => undefined)` or `void` patterns nearby).
- For true-positive floating promises where the right handling isn't obvious from local context: do NOT guess — add `// eslint-disable-next-line @typescript-eslint/no-floating-promises -- TODO(lint-baseline): triage` and count them.
- If a single rule produces an overwhelming, low-value violation count (> ~100 across the repo), turn that rule off in the config with a one-line comment naming the count and date, rather than scattering hundreds of disables. Record each such decision for your report.

**Verify**: `npx pnpm@11.5.2 lint` → exit 0.

### Step 4: Prove nothing broke

**Verify**: `mise run //:typecheck` → exit 0; `mise run //:test` → all pass; `npx pnpm@11.5.2 format:check` → exit 0 (run `npx pnpm@11.5.2 format` first if your edits moved code).

## Test plan

No new tests — the lint config is itself the gate. The existing unit suites (`mise run //:test`) are the regression net for the mechanical fixes; any test failure after a lint fix means the fix changed semantics (see STOP conditions).

## Done criteria

- [ ] `eslint.config.js` exists; `npx pnpm@11.5.2 lint` exits 0
- [ ] `no-floating-promises` is active (verify: `grep -n "no-floating-promises" eslint.config.js` shows it is not disabled globally)
- [ ] `mise run //:check` includes lint and passes end-to-end
- [ ] `.github/workflows/run-tests.yml` contains a `lint` job using `mise run //:lint`
- [ ] `mise run //:typecheck` and `mise run //:test` exit 0
- [ ] `plans/README.md` status row updated; report lists every rule turned off in triage and the inline-disable count

## STOP conditions

Stop and report back (do not improvise) if:

- An `eslint.config.*` file already exists (work superseded).
- After step 3's permitted triage, more than ~200 violations remain — the rule selection needs maintainer input; report the per-rule histogram (`npx pnpm@11.5.2 exec eslint . -f json | ...` or just the summary) instead of mass-disabling.
- Any unit test fails after a lint fix and the cause isn't an obviously bad fix you can revert — semantics changed somewhere; revert the file and flag it.
- Type-aware linting is impractically slow (> ~5 minutes cold) — fall back to non-type-checked `recommended` (losing `no-floating-promises`), note the downgrade prominently in your report, and continue.

## Maintenance notes

- Deliberately deferred: extending `.husky/pre-commit` beyond Prettier (speed tradeoff — maintainer call), per-package lint scripts (root-level `eslint .` covers the workspace), and lint-staged.
- Every `TODO(lint-baseline)` inline disable is a real floating-promise candidate bug — worth a follow-up sweep.
- When `apps/www` gains real TS/JS logic, revisit the `.astro` exclusion (eslint-plugin-astro exists).
- Reviewer: scrutinize each `void`-prefix added in step 3 — that's the only fix class with semantic teeth.
