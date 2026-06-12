# Plan 002: Use a timing-safe comparison for generic-webhook bearer authorization

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- apps/control-plane/src/integrations/generic-webhook/service.ts apps/control-plane/test/unit/generic-webhook.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `42ca671`, 2026-06-12

## Why this matters

Every other credential comparison in this codebase is timing-safe — bearer tokens in `app/server.ts:1605`, session cookies in `auth/session.ts:136`, GitHub webhook HMACs in `integrations/github/webhook-auth.ts:19`, Slack signatures in `integrations/slack/auth.ts:35` all use `crypto.timingSafeEqual` behind a length check. The one exception is the generic inbound webhook's bearer check, which uses plain `===`. The practical timing-leak risk is low, but the inconsistency is exactly the kind of thing that survives copy-paste into the next integration; fixing it restores the invariant "all secret comparisons in this repo are timing-safe."

## Current state

- `apps/control-plane/src/integrations/generic-webhook/service.ts:101-103` — the weak comparison:

  ```ts
  function isAuthorized(authorization: string | undefined, source: WebhookSourceRecord): boolean {
    return authorization === `Bearer ${source.bearerToken}`;
  }
  ```

  Called from `handle()` at `service.ts:42-44`, which throws `GenericWebhookError('unauthorized', ...)` on failure.

- The repo's convention for this, to copy exactly — `apps/control-plane/src/auth/session.ts:133-138`:

  ```ts
  function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  ```

  with `import { ... timingSafeEqual } from 'node:crypto';` at the top of the file.

- Existing tests: `apps/control-plane/test/unit/generic-webhook.test.ts` creates sources with `bearerToken: 'secret'` and calls `services.genericWebhooks.handle({ ..., authorization: 'Bearer secret', ... })` (e.g. lines 15–35). Model new test cases on those.

## Commands you will need

| Purpose    | Command                                   | Expected on success |
| ---------- | ----------------------------------------- | ------------------- |
| Typecheck  | `mise run //apps/control-plane:typecheck` | exit 0              |
| Unit tests | `mise run //apps/control-plane:test`      | all pass            |
| Format     | `npx pnpm@11.5.2 format` (repo root)      | exit 0              |

(If `mise` is unavailable, the equivalents are `npx pnpm@11.5.2 --dir apps/control-plane typecheck` / `... test`.)

## Scope

**In scope** (the only files you should modify):

- `apps/control-plane/src/integrations/generic-webhook/service.ts`
- `apps/control-plane/test/unit/generic-webhook.test.ts`

**Out of scope** (do NOT touch, even though they look related):

- `auth/session.ts`, `app/server.ts`, `integrations/github/webhook-auth.ts`, `integrations/slack/auth.ts` — already correct; do not "consolidate" the helpers into a shared module in this plan (helper consolidation across integrations is a separately tracked backlog item).

## Git workflow

- Branch: `advisor/002-timing-safe-webhook-bearer`
- Commit style: Conventional Commits, e.g. `fix(control-plane): timing-safe generic webhook auth comparison`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the comparison

In `apps/control-plane/src/integrations/generic-webhook/service.ts`:

1. Add `import { timingSafeEqual } from 'node:crypto';` at the top (this file currently has no `node:crypto` import).
2. Rewrite `isAuthorized` to compare the presented value against `` `Bearer ${source.bearerToken}` `` using the exact `safeEqual` pattern from `auth/session.ts:133-138` (length check, then `timingSafeEqual` over `Buffer.from`). Keep `isAuthorized`'s signature unchanged; `authorization` may be `undefined` — return `false` in that case before constructing buffers.

**Verify**: `mise run //apps/control-plane:typecheck` → exit 0.

### Step 2: Add regression tests

In `apps/control-plane/test/unit/generic-webhook.test.ts`, add cases (modeled on the existing `bearerToken: 'secret'` setup):

- wrong token of the same length (`'Bearer secreX'`) → `handle` rejects with `GenericWebhookError` code `unauthorized`
- wrong token of different length → rejects `unauthorized`
- missing `authorization` (undefined) → rejects `unauthorized`
- correct token still accepted (existing happy-path tests must keep passing unchanged)

**Verify**: `mise run //apps/control-plane:test` → all pass, including the new cases.

## Test plan

Covered by Step 2. Pattern source: the existing tests in `generic-webhook.test.ts` (same file).

## Done criteria

- [ ] `grep -n '=== \`Bearer' apps/control-plane/src/integrations/generic-webhook/service.ts` returns no matches
- [ ] `mise run //apps/control-plane:typecheck` exits 0
- [ ] `mise run //apps/control-plane:test` exits 0 with the new test cases present
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `isAuthorized` in the live code no longer matches the excerpt (someone fixed or moved it already).
- Existing generic-webhook tests fail for reasons unrelated to your change.

## Maintenance notes

- When the backlog item "consolidate shared integration utilities" lands, this `safeEqual` copy should move into the shared helper along with the four existing copies — five call sites is the trigger.
- Reviewer: confirm the `undefined` early-return, and that no behavior other than comparison strategy changed.
