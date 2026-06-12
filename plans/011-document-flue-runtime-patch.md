# Plan 011: ~~Document the @flue/runtime patch~~ — SUPERSEDED by plan 013

> **Status: SUPERSEDED (2026-06-12).** The maintainer chose to fold the patch
> removal into a single execution task: plan 013 upgrades `@flue/runtime`
> past 0.10.0 and deletes the patch outright, making interim documentation
> moot. Do not execute this plan. It is retained for the upstream-resolution
> facts gathered during planning (issue withastro/flue#183, fix commit
> `a783a7c`, first fixed release 0.10.0), which plan 013 incorporates.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- pnpm-workspace.yaml docs/flue-upgrade.md patches/`
> If the `patchedDependencies` entry is gone (Flue upgraded past 0.8.0 —
> see plan 013), this plan is obsolete — mark it REJECTED in the index with
> that reason.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (docs/comments only)
- **Depends on**: none (related: plan 013 performs the upgrade that retires the patch)
- **Category**: docs / deps
- **Planned at**: commit `42ca671`, 2026-06-12 (revised same day with upstream resolution facts)
- **Execution status**: REJECTED — superseded by plan 013, which upgraded Flue and removed the patch instead of documenting it in place.

## Why this matters

`pnpm-workspace.yaml` patches `@flue/runtime@0.8.0` via `patches/@flue__runtime@0.8.0.patch`, with the rationale buried in one sentence of `docs/flue-upgrade.md:26`. Since the audit first flagged this, the situation improved and sharpened: **upstream has fixed the underlying issue** ([withastro/flue#183](https://github.com/withastro/flue/issues/183), closed 2026-06-02), so the patch now has a concrete, dated removal trigger instead of a vague "until upstream handles it." But the fix first ships in `@flue/runtime` **0.10.0**, and upgrading from 0.8.0 is a breaking migration (see plan 013) — so the patch will be carried for a while yet, and whoever bumps Flue needs the full story at the patch site.

## Current state

- `pnpm-workspace.yaml` (bottom of file), no comment:

  ```yaml
  patchedDependencies:
    '@flue/runtime@0.8.0': patches/@flue__runtime@0.8.0.patch
  ```

- `docs/flue-upgrade.md:26` — the only written rationale (verbatim):

  > Deputies keeps clear Flue storage identities (`deputies`/`runner`) and carries a small `@flue/runtime` package patch that hashes only provider-facing affinity keys longer than 64 characters. This avoids a storage migration and covers nested child tasks until upstream handles cache-key length limits.

- Upstream resolution facts (verified 2026-06-12 via the GitHub API — re-verify only if something looks off):
  - Issue: `withastro/flue#183` "Session affinity keys can exceed Codex prompt_cache_key length limit", closed 2026-06-02.
  - Fix commit: `a783a7c` — "fix(runtime): persist bounded session affinity keys". Flue now persists one bounded opaque `aff_<ULID>` affinity key per session (including delegated task sessions) and reuses it across saves and reopens; lossless session storage keys are unchanged.
  - First release containing the fix: `@flue/runtime` **0.10.0** (2026-06-08). It is NOT in 0.9.x (`a783a7c` diverges from the v0.9.2 tag).
  - The fix ships alongside breaking changes (0.10.0 rejects version-4 session state precisely _because_ of the new affinity model, removes the `@flue/runtime/app` subpath Deputies imports, and changes persistence adapter contracts) — which is why removal is coupled to the plan-013 migration, not a quick bump.
- `patches/@flue__runtime@0.8.0.patch` — read it to confirm it modifies affinity-key handling; quote the touched function name in your additions.

## Commands you will need

| Purpose             | Command                        | Expected on success       |
| ------------------- | ------------------------------ | ------------------------- |
| Patch still applies | `npx pnpm@11.5.2 install`      | exit 0, no patch warnings |
| Format              | `npx pnpm@11.5.2 format:check` | exit 0                    |

## Scope

**In scope**:

- `pnpm-workspace.yaml` (comment only)
- `docs/flue-upgrade.md` (new subsection)

**Out of scope**:

- The patch file content, the `@flue/runtime` version, or any dependency change — the upgrade itself is plan 013.

## Git workflow

- Branch: `advisor/011-document-flue-patch`
- Commit style: `docs: document the @flue/runtime affinity-key patch and its removal trigger`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Annotate the patch entry

Above `patchedDependencies:` in `pnpm-workspace.yaml`:

```yaml
# @flue/runtime@0.8.0 patch: hashes provider-facing affinity keys >64 chars
# (OpenAI Codex prompt_cache_key length limit) without a storage migration.
# Fixed upstream in @flue/runtime 0.10.0 (withastro/flue#183, commit a783a7c)
# via persisted opaque aff_<ULID> keys — drop this patch when upgrading to
# >=0.10.0 (breaking migration; see docs/flue-upgrade.md "Patch maintenance").
```

**Verify**: `npx pnpm@11.5.2 install` → exit 0 (YAML parses, patch applies).

### Step 2: Add a "Patch maintenance" subsection to docs/flue-upgrade.md

Append a short section covering: what the patch does (cite the actual function modified, from reading the patch file); why (Codex cache-key length limit, no storage migration, nested child tasks); the resolution (issue #183 facts from Current state, verbatim); and the removal procedure — the patch is dropped as part of the ≥0.10.0 upgrade, noting that upstream's `aff_<ULID>` model **replaces** the patch's hashing (existing sessions get fresh affinity keys → one-time provider cache miss per session; lossless storage keys unchanged, per the upstream resolution).

**Verify**: `npx pnpm@11.5.2 format:check` → exit 0.

## Test plan

None — documentation only. `pnpm install` is the executable check.

## Done criteria

- [ ] `grep -B5 "patchedDependencies" pnpm-workspace.yaml` shows the comment incl. "0.10.0" and "#183"
- [ ] `grep -n "Patch maintenance" docs/flue-upgrade.md` → match
- [ ] `npx pnpm@11.5.2 install` and `format:check` exit 0
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The patch file's content does not match the documented rationale (it patches something other than affinity-key handling) — report the discrepancy instead of writing it down.
- `@flue/runtime` in `apps/control-plane/package.json` is no longer `0.8.0` — plan 013 (or someone) already moved; reassess whether the patch still exists before documenting it.

## Maintenance notes

- Plan 013 (Flue upgrade assessment) owns the actual removal. If 013 is executed soon, this plan's value shrinks to the interim — it's still worth the 15 minutes, since 013's outcome may be "defer the upgrade."
