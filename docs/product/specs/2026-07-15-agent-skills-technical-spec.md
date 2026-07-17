# Agent Skills Technical Spec

## Status

Building

## Context

Pi implements the Agent Skills standard (agentskills.io): a skill is a directory with `SKILL.md` whose frontmatter carries `name`, `description`, and optionally `disable-model-invocation`. Pi's `DefaultResourceLoader` discovers skills, and `formatSkillsForPrompt` injects name + description + file path into the system prompt; the model reads the full body on demand with its read tool. Deputies keeps Pi filesystem scanning disabled with `noSkills: true` and supplies the reviewed catalog through `skillsOverride`.

Two runtime facts shape the design:

- The Pi resource loader runs in the trusted worker process, but the agent's read tool operates on the remote sandbox filesystem. A skill's `filePath` must therefore point at a file that exists inside the sandbox, and the worker cannot rely on Pi's local-filesystem discovery (`loadSkillsFromDir`). `DefaultResourceLoader` exposes a `skillsOverride` hook that lets us supply the resolved `Skill[]` directly.
- Repositories are prepared inside the sandbox by the repository setup phase, so repo skill discovery must go through `SandboxHandle.fs` / `exec`, not worker-local fs.

Ownership follows the PRD: skills are personal (user-owned) or group-owned, single-markdown-document only, with immutable managed definition revisions, live `enabled` and `auto_load` flags, and manual invocation from the composer. Repo skills come from the popular well-known roots in prepared repositories: `.agents/skills/` (Agent Skills standard), `.claude/skills/` (Claude Code, where most existing public skills live), and `.pi/skills/` (Pi's own `CONFIG_DIR_NAME` project convention). Deputies fetches these roots from the sandbox and runs Pi's own `loadSkillsFromDir` over a local mirror (see Proposed Design), so it reuses Pi's discovery behavior without being bound to Pi's single-directory default.

## Goals

- Durable `skills` storage with RBAC-enforced CRUD API and web UI.
- Immutable `skill_revisions` for managed name, description, and body, with a current pointer on each skill identity.
- Run-time skill resolution (group + personal + repo + manually invoked), materialization into the sandbox, and injection through `skillsOverride`.
- Server-pinned manual invocation attached to messages, with slash-triggered composer autocomplete.
- `skills_loaded` observability event per run.

## Non-Goals

- Multi-file managed skill bundles, arbitrary historical revision selection for new invocations, automation-level skill pinning, saved prompts, and skill import/export.

## Reviewed Design

### Modules

Following the existing responsibility split:

- `store`: `skills` table, migration, `SkillStore` methods (SQL hidden behind narrow methods).
- `skills` (new service module, sibling of `sessions`/`messages`): validation, RBAC checks delegated to `auth` helpers, archive/restore semantics, and the run-time resolution query (`listSkillsForRun`). Depends only on `store`, per dependency rules.
- `api`/`app`: `/skills` routes calling the service; composer support endpoint.
- `worker` → `runner-pi`: worker passes a skill resolution function into runner options (same pattern as `repositoryAccess` and `setupScript`); `runner-pi` owns materialization, repo scanning, prompt wiring, and the `skills_loaded` event.
- `apps/web`: skills admin surface (modeled on `automations-admin.ts`) and a composer skill picker.

### Run-time flow

```txt
worker claims batch
  -> repository setup prepares repos in sandbox (existing)
  -> resolve managed skills via store:
       group skills: owner_group_id = session.owner_group_id, enabled, not archived, auto_load
       shared skills: share_mode = 'all_groups', or 'specific' with a share row for
         session.owner_group_id; enabled, not archived, auto_load, owner group not archived
       personal skills: owner_user_id = session.created_by_user_id, enabled, not archived, auto_load
       invoked skills: persisted managed revision pins (or legacy names) referenced by each
         claimed message, resolved against that message's author and live authorization;
         enabled, not archived (auto_load ignored)
  -> for each prepared repository, mirror the well-known roots out of the sandbox
     into a worker temp dir (bounded), roots in order:
       .agents/skills/ > .claude/skills/ > .pi/skills/
  -> run Pi's loadSkillsFromDir over each mirrored root in the worker,
     then rewrite filePath/baseDir from mirror paths to sandbox repo paths
     (within a repo, a name in multiple roots is a mirrored skill: first root wins,
      collapsed quietly in diagnostics, not reported as shadowing)
  -> build the advertised auto-load catalog, deduped by name with precedence:
       personal > owner-group > shared-in > repo; record shadowed names
       (ties among shared-in skills break deterministically: oldest created_at wins)
  -> materialize managed skills to /workspace/.deputies-skills/<scope>/<id>/<revision-id>/<name>/SKILL.md
  -> build Skill[] from advertised auto-load candidates; pass via DefaultResourceLoader skillsOverride
  -> emit skills_loaded event (names, sources, shadowed)
  -> prompt; for invoked skills, prepend Pi's native expanded skill block
```

Details:

- Materialization uses `sandbox.fs.writeFile` when the handle provides `fs`, otherwise a base64 heredoc through `exec`. Files are rewritten every run so edits take effect on the next message; the directory lives outside repo worktrees so it never dirties a checkout.
- Auto-loaded managed skills resolve the current revision at run start. Manual managed invocations use the revision already persisted on the message; historical pins remain executable only while the live skill identity is enabled, non-archived, and authorized for that message author/session group.
- Managed skill bodies are serialized as standard `SKILL.md` frontmatter + body so the same file works if the user later copies it into a repo.
- Repo discovery reuses Pi's `loadSkillsFromDir` rather than reimplementing its rules. Pi's discovery is synchronous worker-local `node:fs` (`readdirSync`/`readFileSync`), so it cannot run against repos that exist only inside the sandbox. Instead, the runner mirrors each existing well-known root out of the sandbox into a `mkdtemp` worker directory (the same pattern the runner already uses for Pi session files), runs `loadSkillsFromDir` over the mirror, and rewrites each resulting skill's `filePath`/`baseDir` from the mirror path to the corresponding sandbox repo path before injection. This preserves exact behavioral parity with local `pi` — the SKILL.md-stops-recursion rule, direct `.md` children, `.gitignore`/`.ignore`/`.fdignore` handling, name fallback to the parent directory, and validation diagnostics — and tracks Pi's rules automatically on version bumps.
- Mirroring transfers only what discovery needs: `SKILL.md` files, direct `.md` children of the root, and ignore files, preserving relative layout. To avoid per-file round trips on remote providers (Daytona fs calls are HTTP), the mirror is fetched in a single `exec` (`tar -cz` of the roots, streamed back base64-encoded and extracted locally), falling back to `SandboxHandle.fs` walks when `exec` output limits are hit. Sandbox symlinks are not followed during mirroring; a symlinked skill is skipped with a diagnostic. Caps: at most 50 skills per repo across all roots combined, 256 KB per mirrored file, and 2 MB total mirror per repo; anything over caps is skipped with a diagnostic in `skills_loaded`. The temp mirror is removed in a `finally` block.
- Mirrored files are untrusted repo content parsed in the trusted worker (frontmatter YAML); caps bound that exposure, and parsing failures degrade to per-file diagnostics exactly as Pi does. Only `SKILL.md` bodies are needed for discovery — a skill's supporting files stay in the repo checkout, and the agent reads them in the sandbox via the rewritten `baseDir`.
- A Deputies-specific root (e.g. `.deputies/skills/`) is intentionally omitted: repos targeting Deputies should use `.agents/skills/`.
- Skills authored for other tools may carry tool-specific frontmatter (e.g. Claude Code's `allowed-tools`); Pi's `SkillFrontmatter` allows unknown keys, so these load fine and unknown keys are ignored. This is a content-quality tradeoff, not a loader concern.
- `noSkills: true` remains, so Pi never scans the worker's own filesystem; `skillsOverride` returns the advertised auto-load set. Frontmatter `disable-model-invocation` in repo skills maps to exclusion from that catalog, mirroring `auto_load=false` for managed skills.
- Manual invocation: enqueue canonicalization authorizes the selected managed skill, replaces client hints with its current `{ id, name, revisionId }`, and persists that pin. A supplied non-current revision is rejected as `unknown_skill`, so clients cannot newly replay historical definitions. The runner rechecks live authorization and materializes the persisted revision, strips frontmatter with Pi's exported helper, and prepends Pi's native `<skill name="…" location="…">` expansion to the affected message. Legacy name-only messages resolve current using normal precedence. Request-local invocations do not enter or reorder `skillsOverride`, which keeps author-specific changes out of the cacheable system-prompt prefix while guaranteeing that explicit skill instructions reach the model.
- Skill resolution failures (store error, sandbox write failure) degrade like MCP unavailability: log a redacted warning, drop the affected skills for the run, and include a note in `skills_loaded` rather than failing the run.

### Managed revisions

- `name`, `description`, and `body` are authoritative immutable content in `skill_revisions`. `skills.current_revision_id` and `skills.current_revision_number` select the live definition. The retained `skills.name` column is only a denormalized owner-scope uniqueness key maintained transactionally with the pointer.
- Creation inserts revision 1 and the skill identity in one transaction. Content PATCHes use `expectedCurrentRevisionId` for optimistic concurrency and insert the next revision only when normalized name, description, or body differs. No-op saves and updates limited to `enabled`/`auto_load` do not create a revision.
- Ownership, promotion, sharing, enabled/auto-load settings, and archive state remain live on `skills`; revisions never snapshot or bypass these authorization inputs.
- `GET /skills/:skillId/revisions` returns newest-first complete revisions, including bodies, and requires management permission. `GET /skills/:skillId` continues to expose the current definition to readers.

### Web UI

- New `Skills` navigation entry. Three lists: `My skills` (personal), per-group skills for groups where the user has access, and `Shared with my groups` (read-only, showing the owning group). Editor: name (slug-validated inline), description, markdown body, auto-load toggle, enabled toggle, archive/restore, and a `Move to access group` action on personal skills (group picker limited to groups where the user can create skills, with a confirmation noting the ownership move is one-way and the skill will stop loading as personal). Group skills add a sharing control (owner group only / specific groups / all groups) visible to users who can edit the skill, mirroring the environment sharing UI. Managers also get read-only revision history/body inspection. Group skill creation respects group role rules; non-managing readers see only the current definition.

### Integration invocation

Slack mentions, GitHub comments, and generic webhook prompts can invoke skills with a leading `/skill-name` token in the message text (e.g. `@deputies /incident-writeup INC-123`). This is parsed in the integration normalization layer (`integrations/shared-utils.ts`), not by each provider module, and never uses platform-native slash commands (Slack `/commands` are statically registered per app; skills are dynamic).

Rules:

- Only the leading token is parsed. On an exact, case-sensitive match against enabled, non-archived group-owned/shared-in skills or repository skills from the session's latest discovery event, the token is stripped and canonical `context.skills`/`context.skillRefs` are attached; otherwise the text passes through untouched - no hard failure on typos in free text, unlike the structured API field's `400 unknown_skill`.
- Personal skills are not invokable from integrations in v1: external actors do not reliably map to an `auth_users` row, and guessing would bypass personal-skill privacy. Revisit if/when integration actor-to-user mapping lands.
- Repo skills are invokable by name after discovery, including skills with `disable-model-invocation` that were discovered but not advertised. The latest `skills_loaded` event is the discovery index used by session pickers and integrations. Unmatched names pass through, so a not-yet-discovered repo skill degrades to plain prompt text.
- Composer: typing `/` at the start of an empty composer opens filter-as-you-type autocomplete listing skills available to the session and current message author. There is no persistent Skills button. The first match is active by default; Arrow Up/Down and Home/End navigate, and Enter attaches the active skill without submitting slash text. Same-name candidates remain distinct and show source plus owner/repository provenance. Selecting a skill attaches a removable chip to the draft rather than inserting text; the remaining composer text is optional, multiple same-name chips may be attached, and skill-only messages are valid. Chips send canonical display names in `context.skills` and aligned identity hints in `context.skillRefs`. The server pins managed refs to current at enqueue; repository refs remain `repo:<owner>/<repo>:<name>` identities without revision IDs. Existing persisted name-only arrays retain precedence-based fallback. As a fast-typing fallback, an exact leading `/name` match selects the existing precedence winner. Repo skills appear in the picker only after a run has discovered them; personal, group, and shared skills are always listable.

## Data Model / Schema Changes

Migration `017_skills.sql` creates the final immutable-revision schema:

```txt
skills
  id uuid primary key
  owner_kind text not null check (owner_kind in ('user','group'))
  owner_group_id uuid references groups(id) on delete restrict
  owner_user_id uuid references auth_users(id) on delete restrict
  name text not null
  current_revision_id uuid not null
  current_revision_number integer not null check (current_revision_number > 0)
  auto_load boolean not null default true
  enabled boolean not null default true
  share_mode text not null default 'none' check (share_mode in ('none','specific','all_groups'))
  check (owner_kind = 'group' or share_mode = 'none')
  created_by_user_id uuid references auth_users(id) on delete set null
  archived_at timestamptz
  created_at timestamptz not null
  updated_at timestamptz not null
  check ((owner_kind = 'group') = (owner_group_id is not null))
  check ((owner_kind = 'user') = (owner_user_id is not null))
  foreign key (id, current_revision_id)
    references skill_revisions(skill_id, id) on delete restrict
    deferrable initially deferred

skill_revisions
  id uuid primary key
  skill_id uuid not null references skills(id) on delete restrict
  revision_number integer not null check (revision_number > 0)
  name text not null
  description text not null
  body text not null
  actor_type text not null check (actor_type in ('user', 'system'))
  actor_user_id uuid references auth_users(id) on delete set null
  created_at timestamptz not null
  unique(skill_id, revision_number)
  unique(skill_id, id)

skill_group_shares
  skill_id uuid not null references skills(id) on delete cascade
  group_id uuid not null references groups(id) on delete cascade
  created_at timestamptz not null
  primary key(skill_id, group_id)

unique index on (owner_group_id, lower(name)) where owner_group_id is not null
unique index on (owner_user_id, lower(name)) where owner_user_id is not null
partial index on share_mode where share_mode <> 'none'
index on skill_revisions(skill_id, revision_number desc)
index on skill_group_shares(group_id)
```

`skills.name` is a transactionally maintained projection used by the owner-scope unique indexes; `skill_revisions.name` is authoritative for reads and execution. The deferred composite foreign key lets creation insert the skill identity and immutable revision 1 atomically despite their circular references.

Sharing mirrors `environment_group_shares` (ADR 0008): `share_mode='specific'` uses the share rows; `all_groups` ignores them; `none` is owner-group-only. Share rows are meaningful only while `share_mode='specific'` but are kept when the mode changes so toggling back restores the previous set. Only group-owned skills can share (enforced by the check constraint); promotion starts a skill at `share_mode='none'`.

- `name` is a slug: `^[a-z0-9]+(-[a-z0-9]+)*$`, max 64 chars; `description` non-empty, max 1024; `body` max 64 KB.
- Message `context` gains an optional `skills: string[]` array naming manually invoked skills and an aligned `skillRefs: Array<{ id, name, revisionId? }>` identity list. At enqueue, managed entries are canonicalized to the currently authorized revision and persisted with `revisionId`; a client-supplied historical revision is rejected. Repository entries use stable `repo:<owner>/<repo>:<name>` identities and never carry `revisionId`. Existing persisted name-only arrays retain precedence-based current-resolution fallback. Validation and run resolution use the individual message author, not the session creator.
- `skills_loaded` has payload `{ skills: [{ name, source, repo?, ownerGroupId?, ownerGroupName?, skillId?, revisionId?, revisionNumber?, ref?, invoked?, advertised? }], shadowed: [...], diagnostics: [...] }`. Managed entries in both loaded and shadowed sets carry revision identity/number; repository entries carry repository identity instead. Group provenance is snapshotted for auditability. Manual invocation remains request-local and does not alter catalog precedence; manual-only entries are recorded as `invoked: true, advertised: false`.
- `skill_invoked` has payload `{ name, source, trigger: 'user'|'model', ref, filePath, repo?, ownerGroupId?, ownerGroupName?, skillId?, revisionId?, revisionNumber? }`. Explicit selections emit `user`; the first successful read-tool completion for each advertised auto-loaded `SKILL.md` path per run emits `model`. Manual-only skills are expanded directly and do not emit `model`.
- `skills_loaded` is the canonical resolved-skill audit source. Resolved skills are deliberately not duplicated into run metadata; `skill_invoked` is the canonical use record.

## API / Contract Changes

All under existing product session auth; RBAC enforced in `API_AUTH_MODE=session`:

```txt
GET    /skills?scope=personal|group|shared&groupId=... list visible skills
POST   /skills                                     create (personal or group)
GET    /skills/:id                                 read
GET    /skills/:id/revisions                       complete history, managers only
PATCH  /skills/:id                                 update fields, enabled, auto_load
POST   /skills/:id/archive
POST   /skills/:id/restore
POST   /skills/:id/promote                         { groupId } — personal -> group, one-way
PUT    /skills/:id/shares                          { shareMode, groupIds? } — group skills only
GET    /sessions/:sessionId/skills                 skills available to this session (composer picker)
GET    /skills/invocation-candidates?ownerGroupId=... managed candidates before session creation
```

- Create with `ownerGroupId` requires `member`+ in that group (v1 keeps member-creation fixed; a `skill_create_required_role` group knob can follow the automations pattern later). Personal creation requires only an authenticated user.
- Update/archive of a group skill requires group admin, the skill's creator, or super admin — the automations creator-management rule. Personal skills: owner or super admin.
- Duplicate names return `409 skill_name_exists`.
- Shares: managed by the skill's creator, owner-group admins, or super admins — the same rule as edit. `shareMode='specific'` requires `groupIds` naming active groups; `all_groups` and `none` reject `groupIds`. Sharing grants read + invoke + auto-load to the target groups' sessions, never edit. `GET /skills` includes skills shared into the caller's groups (`scope=shared`), and reads of a shared skill are permitted for members of shared-into groups.
- Promote: caller must be the personal skill's owner (or super admin) and allowed to create skills in the target group (`member`+, group active, not archived). The row mutates in place — `owner_kind` flips to `group`, `owner_group_id` set, `owner_user_id` cleared — so the skill id is stable and `created_by_user_id` keeps creator-management rights working. Archived skills cannot be promoted (`409 skill_archived`); a name collision in the target group returns `409 skill_name_exists`. No demotion or group-to-group move endpoint in v1. Because resolution is live, promotion takes effect on the next run: the skill stops loading as personal and starts loading for the target group's sessions.
- Message append and pending-message edit accept `context.skills` with optional aligned `context.skillRefs`. The API resolves managed entries to current and persists the canonical revision pin; a non-current requested pin, stale/inaccessible candidate, or repository ref carrying a revision fails with `400 unknown_skill`, and malformed alignment fails with `400 invalid_request`.
- `GET /skills/:id/revisions` requires `canManageSkill` and returns newest-first complete definitions. This is also the authorization gate used by the web UI before linking a sent historical chip.
- `GET /skills/invocation-candidates` requires permission to create a session in the active `ownerGroupId` and returns managed personal, owner-group, and shared candidates only. `GET /sessions/:sessionId/skills` additionally discovers repository candidates from the latest `skills_loaded` event, including non-advertised and shadowed repository skills.
- Config: `SKILLS_ENABLED=true` (master switch hiding routes/UI and skipping resolution) and `REPO_SKILLS_ENABLED=true` (repo scanning only), both default on.

## Testing Plan

- Store integration tests: fresh migration, revision-1 creation, immutable revision ordering, no-op/live-only update behavior, optimistic content conflicts, historical pinned resolution under live authorization, CRUD, per-scope case-insensitive uniqueness, archive semantics, and `listSkillsForRun` filtering against `TEST_DATABASE_URL`.
- Route tests: RBAC matrix (viewer/member/admin/creator/super admin, personal vs group), manager-only revision history, validation errors, 409s, server pinning at message append/edit, rejection of newly submitted historical pins, invocation-candidates behavior, promotion, and sharing.
- Runner unit tests: current auto-load resolution, persisted historical manual pins, revision IDs/numbers in both skill events, resolution precedence and shadowing, materialization writes (fake sandbox fs), mirror fetch + path rewrite, non-advertised repository discovery/manual invocation, caps and symlink skipping, `skillsOverride` wiring, invoked-skill prompt prefix, and degraded behavior. Discovery-rule behavior itself remains Pi's contract beyond representative fixtures.
- E2E with `FakeRunner`/fake sandbox: session run emits `skills_loaded`; repo fixtures covering each well-known root and a mirrored-skill fixture (same name in `.agents/skills/` and `.claude/skills/`) that must load once from `.agents/skills/`.
- Integration tests: leading-token parse in shared normalization, current managed revision pinning, discovered advertised/non-advertised repository matches, non-match passthrough, and personal-skill exclusion across Slack, GitHub, and generic webhook ingress.
- Web tests: skills admin CRUD/revision history flows, manager-only history, slash-only picker attach/chip rendering, leading `/name` fallback conversion, historical-chip inspectability, invocation-candidates for new threads, chip removal, and read-only states.

## Rollout / Migration Plan

- Apply `017_skills.sql` before serving revision-aware requests.
- Ship behind `SKILLS_ENABLED` default-on; deployments see no behavior change until a managed skill exists or a prepared repo contains a skill root. Roll API and worker processes with the migration applied before serving revision-aware requests.
- Update `docs/data-model.md` (skills table, event type), `docs/architecture.md` (skill loading in the runner section), `docs/web-ui.md`, and `docs/access-groups.md` (role capabilities for skills).

## Risks And Tradeoffs

- Prompt-injection surface: repo skills put repo-authored text into the system prompt. This is comparable to the agent reading repo files today, but earlier in the trust chain. Mitigations: name+description only in the prompt (bodies read on demand), caps on count/size, `skills_loaded` visibility, and `REPO_SKILLS_ENABLED` off-switch. Accepted for v1 since sessions already execute repo code in the sandbox.
- Auto-loaded personal skills key off session `created_by_user_id`, so automation- and integration-created sessions get no auto-loaded personal skills. Manual personal invocations instead key off each message's `author_user_id`; integration messages without a mapped user cannot invoke personal skills.
- In a collaborative session, later contributors do not replace the creator's auto-loaded personal catalog with their own. They may explicitly invoke their own personal skills for messages they author; other contributors cannot invoke those personal skills, even though the resulting agent response and skill-loading metadata are visible to session readers.
- Auto-load follows current at each run start, so edits intentionally affect the next run. Manual invocations differ: enqueue persists current and queued historical pins remain reproducible. This split must remain visible in tests and events.
- Live lifecycle and authorization can prevent a persisted pin from running after disable/archive/unshare/ownership changes. This is intentional fail-closed behavior, not a snapshot of access.
- Immutable bodies increase database growth and expose sensitive historical instructions to managers for the life of the skill. Body limits, manager-only history, and no hard-delete semantics are accepted tradeoffs; retention/export policy remains future work.
- Precedence-based name shadowing still determines auto-load and legacy `/name` fallback. Explicit picker choices carry identities, so users can invoke multiple same-name candidates despite owner/source collisions. Cross-group sharing widens the collision surface; uniqueness stays per owner scope, and ties among legacy shared-in candidates remain oldest-first.
- All-groups sharing lets one group grow every session's prompt in the organization. Name + description injection keeps the per-skill cost small, and shared skills are managed content from authenticated teammates (unlike repo skills), so no extra cap is added in v1; revisit if prompt budgets become a problem.

## Open Questions

- Per-environment repo-skill opt-out vs deployment-wide `REPO_SKILLS_ENABLED` only (v1: deployment-wide).
- Whether the composer picker should also let users browse repo skills before the first run (requires an on-demand sandbox scan or repo-content fetch; deferred).
- Saved prompts: extend this table with `kind = 'skill' | 'prompt'` or separate entity when that feature is picked up.

## Links

- Related PRD: [2026-07-15-agent-skills.md](../prds/2026-07-15-agent-skills.md)
- Related decisions: [ADR 0002 group-owned automations](../../adr/0002-group-owned-automations.md)
- Related pull requests:
