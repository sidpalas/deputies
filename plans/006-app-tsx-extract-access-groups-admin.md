# Plan 006: Decompose app.tsx, phase 1 — extract the access-groups admin domain into a hook

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 42ca671..HEAD -- apps/web/src/app.tsx apps/web/src/app.test.tsx`
> app.tsx is the repo's highest-churn file — drift is LIKELY. If line numbers
> have shifted, re-locate the named symbols by grep before proceeding; if any
> named symbol is gone or restructured, STOP.

## Status

- **Priority**: P3
- **Effort**: M (this phase; the full decomposition is L and spans several phases)
- **Risk**: MED
- **Depends on**: none (soft: land after plan 004, which touches `apps/web/src/api.ts` and test mocks)
- **Category**: tech-debt
- **Planned at**: commit `42ca671`, 2026-06-12
- **Execution status**: BLOCKED — the planned handler seam crosses into new-thread/navigation/auth state; no refactor was landed under this plan.

## Why this matters

`apps/web/src/app.tsx` is 2,804 lines with ~59 `useState`/ref declarations and ~80 functions in a single component — and it is the #1 churn hotspot (75 changes in 3 months). Every feature touches this file; unrelated state regions interleave, so each change risks regressions in others. This plan extracts the most self-contained domain — access-groups administration (group form, member management, super-admin management) — into a custom hook, establishing the extraction pattern (and proving the test safety net) that later phases reuse for automations, the new-thread form, and session lifecycle state. The UI for this domain is _already_ extracted (`components/app-panels/access-groups-panel.tsx`); only its state and handlers still live in App.

## Current state

All line numbers as of `42ca671`; re-locate by symbol name if drifted.

- `apps/web/src/app.tsx` — the `App` component starts ~line 277. The access-groups admin domain consists of:
  - State: `accessGroupsState` / `setAccessGroupsState` (line 289, type `AccessGroupsState` and `emptyAccessGroupsState` are defined **in this same file** — they must move too). Destructured at line 348: `const { groupForm, memberSearch, superAdminSearch, roleManagementUsers } = accessGroupsState;`
  - Updater helpers (lines ~496–567): `updateGroupForm`, `updateMemberSearch`, `updateSuperAdminSearch`, `setGroupFormVisibility`, `setGroupFormWritePolicy`, `setGroupFormAutomationCreateRequiredRole`, `setMemberSearchQuery`, `setMemberUserId`, `setMemberRole`, `setSuperAdminSearchQuery`, `setSuperAdminUserId`, `setUserOptions`, `setSuperAdminUserOptions`, `setRoleManagementUsers`
  - Handlers (lines ~1821–2046): `startNewGroup`, `handleCreateGroup`, `handleGroupFormNameChange`, `handleSaveGroup`, `handleArchiveGroup`, `handleAddGroupMember`, `handleUpdateGroupMemberRole`, `handleRemoveGroupMember`, `selectMemberUser`, `handlePromoteSuperAdmin`, `selectSuperAdminUser`, `handleRemoveSuperAdmin`, `selectGroupPanel`, `selectSuperAdminsPanel`
  - Shared state that does NOT move (other domains read it): `groups`/`setGroups` (line 281), `groupMembers`/`setGroupMembers` (line 282), `refreshGroups` (line 1132), `handleApiError` (line 2266), navigation state/updaters (`updateNavigation`, `setSelectedGroupId` at ~482). The hook receives these as arguments.
- `apps/web/src/components/app-panels/access-groups-panel.tsx` — the (already-extracted) panel component consuming these values as props. Its props interface must NOT change in this plan.
- Extraction conventions already in the repo (match them):
  - Pure logic modules next to app.tsx: `apps/web/src/app-state.ts` (exports plain functions + types like `upsertEvent`, `ActiveProgress`), `app-helpers.ts`, `session-detail-loader.ts`. Imports use explicit `.js` suffixes (`from './app-state.js'`).
  - Tests: `apps/web/src/app.test.tsx` (87 `it` cases, renders `App` with a mocked API module).
- CONTEXT.md vocabulary: this domain is "Access Group" management ("A flat product access scope that owns sessions and grants users read, create, write, or management capabilities through group roles and session policies"). Name the hook and file accordingly.

## Commands you will need

| Purpose    | Command                         | Expected on success  |
| ---------- | ------------------------------- | -------------------- |
| Typecheck  | `mise run //apps/web:typecheck` | exit 0               |
| Unit tests | `mise run //apps/web:test`      | all pass (87+ cases) |
| E2E        | `mise run //apps/web:e2e`       | all pass             |
| Build      | `mise run //apps/web:build`     | exit 0               |

## Scope

**In scope** (the only files you should modify/create):

- `apps/web/src/use-access-groups-admin.ts` (create — the hook + moved types)
- `apps/web/src/app.tsx` (delete moved code, call the hook)
- `apps/web/src/app.test.tsx` (characterization additions only; existing assertions unchanged)

**Out of scope** (do NOT touch):

- `components/app-panels/access-groups-panel.tsx` and every other component — props interfaces are frozen for this phase.
- The automations, new-thread, session-detail, archive/optimistic-update, theme, or connection-status state regions — later phases.
- `api.ts`, `app-state.ts`, `app-helpers.ts` — no API or shared-helper changes.
- Any behavior change whatsoever. This is a pure move-and-rewire.

## Git workflow

- Branch: `advisor/006-extract-access-groups-admin`
- Commits: `test(web): characterize access group admin flows` then `refactor(web): extract access groups admin hook`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm or add characterization coverage

Grep `app.test.tsx` for group-admin coverage: `grep -n "group" apps/web/src/app.test.tsx | head -40`. The flows that must be covered before moving code: create a group (form open → name → submit), add a member with a role, change a member's role, remove a member, promote/remove a super admin, archive a group. For any flow with no test, add one now, following the file's existing mock-API render pattern. These tests assert today's behavior and must pass before AND after the extraction, unmodified.

**Verify**: `mise run //apps/web:test` → all pass, including any new cases.

### Step 2: Create the hook

Create `apps/web/src/use-access-groups-admin.ts`:

- Move the `AccessGroupsState` type, its sub-types (`AccessGroupFormState`, member/super-admin search state types — whatever app.tsx defines for this domain), and `emptyAccessGroupsState` here. Export them.
- Export `useAccessGroupsAdmin(deps)` where `deps` carries exactly what the moved code references from App scope: `token`, `groups`, `setGroups`, `groupMembers`, `setGroupMembers`, `refreshGroups`, `handleApiError`, and the navigation callbacks (`updateNavigation`/`setSelectedGroupId` or the narrower functions actually used — determine by compiling). Move the state (`useState<AccessGroupsState>`), all 14 updater helpers, and all 14 handlers into the hook. Return everything the JSX consumes.
- Mechanical rule: the moved function bodies must be byte-identical except for `deps.` prefixes where they referenced App-scope values. No logic edits, no renames.

**Verify**: `mise run //apps/web:typecheck` → exit 0.

### Step 3: Rewire App

In `app.tsx`: delete the moved code, call `const accessGroupsAdmin = useAccessGroupsAdmin({...})`, and update the JSX/prop sites to read from the hook's return (`accessGroupsAdmin.groupForm`, `accessGroupsAdmin.handleCreateGroup`, ...). The values passed to `<AccessGroupsPanel ...>` must be the same shapes as before.

**Verify**: `mise run //apps/web:typecheck` → exit 0; `mise run //apps/web:test` → all 87+ pass with zero assertion changes to pre-existing tests.

### Step 4: Full gates and size check

**Verify**: `mise run //apps/web:e2e` → pass; `mise run //apps/web:build` → exit 0; `wc -l apps/web/src/app.tsx` → meaningfully smaller (expect roughly 300–400 lines removed).

## Test plan

- Step 1's characterization tests (in `app.test.tsx`, existing mock pattern) are the contract; list in your report which flows already had coverage vs. which you added.
- No hook-level unit tests required this phase — the component tests exercise the hook through the real wiring, which is the point of characterization.

## Done criteria

- [ ] `apps/web/src/use-access-groups-admin.ts` exists; `grep -c "AccessGroupsState" apps/web/src/app.tsx` → only import references remain
- [ ] All four verification commands exit 0
- [ ] Zero modifications to pre-existing test assertions (`git diff apps/web/src/app.test.tsx` shows only additions)
- [ ] `components/app-panels/` untouched (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any named symbol from "Current state" no longer exists in app.tsx (drift — this file changes weekly).
- A moved handler turns out to depend on state from another domain that isn't in the deps list (e.g. session-detail state) — that coupling is a finding in itself; report it rather than widening the hook.
- Any pre-existing test fails after step 3 and the fix isn't an obvious wiring slip — behavior changed; revert and report.
- The hook's deps object exceeds ~10 entries — the seam is wrong; report instead of forcing it.

## Maintenance notes

- This is **phase 1**. The follow-up phases, in suggested order (each gets its own plan when promoted): automations admin state (`automations`, handlers at app.tsx ~1721–1797), new-thread form state (~304–308 + `handleCreateThread`), optimistic archive/unarchive (~2112–2207), session-detail refresh machinery (largest and riskiest, do last).
- Reviewer: diff the moved bodies against the originals (should be mechanical); scrutinize the deps list — anything beyond the documented shared state suggests hidden coupling.
- If plan 004 landed first, re-run its `listEvents` paging tests after this merge (both touch `app.test.tsx`).
