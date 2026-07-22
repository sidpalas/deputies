# Agent Skills

## Status

Building

## Problem

Before this work, Deputies sessions ran with Pi's skill loading disabled (`noSkills: true`). Users had no way to package reusable instructions - "how we write release notes", "how to triage a flaky test", "our PR checklist" - and have agents discover and apply them. Every session either re-explained the procedure in the prompt or relied on repo docs the agent might not find. Teams also could not share proven procedures with each other, and repos that already shipped Agent Skills (`.agents/skills/`) got no benefit when run through Deputies.

## Goals

- Users can create, edit, and archive skills through the web UI and product API. A skill is a single `SKILL.md`-style document: a slug name, a one-line description, and a markdown body, per the Agent Skills standard Pi already implements.
- Managed skill definitions are immutable revisions. Creation publishes revision 1; a real change to name, description, or body publishes the next revision, while unchanged saves and changes to live settings do not create revisions.
- Skills can be personal (visible only to their creator) or group-owned (usable by sessions owned by that group), so teams can share procedures while individuals keep private ones.
- Group skills can additionally be shared beyond their owner group — with specific other groups or with all groups — following the environment-sharing pattern (ADR 0008), so organization-wide procedures don't need to be duplicated per group.
- Each skill has an auto-load setting. Auto-load skills are advertised to the agent (name + description) on every eligible run; the agent reads the full body only when relevant. Non-auto-load skills are hidden from the model until explicitly invoked.
- Users can manually invoke any available skill from the message composer, regardless of its auto-load setting.
- Repos checked out into a session are scanned for skills at the popular well-known locations — `.agents/skills/`, `.claude/skills/`, and `.pi/skills/` — and those skills are made available to the agent automatically, so repos authored for the Agent Skills standard, Claude Code, or Pi all work without Deputies-specific changes.
- Runs record which skills were loaded so behavior is observable and debuggable.
- Manual managed-skill invocations are pinned by the server to the current revision when the message is enqueued. The persisted pin makes queued work reproducible even after a later edit, while authorization, ownership, sharing, enabled state, and archive state remain live.

## Non-Goals

- Multi-file skill bundles (supporting scripts, references, templates). V1 stores a single markdown document per managed skill. Repo-sourced skills may reference sibling files in their repo since those already exist in the sandbox, but Deputies does not manage those files.
- Saved prompts / prompt templates. A saved prompt is inserted as the user's message text rather than loaded as agent instructions. It is a related feature that should reuse the same ownership and sharing model, but it is out of scope for v1. The `auto_load=false` + manual invocation path covers the nearest use cases in the meantime.
- Ownerless organization-level skills (skills owned by no group, super-admin managed). All-groups sharing of a group-owned skill covers the "global skill" need while keeping every skill's management anchored to one group.
- Demoting a group skill to personal, and moving skills between groups. Archiving covers retirement; immutable session ownership provides no group-to-group move precedent, so any future skill move requires its own explicit ownership model.
- Selecting arbitrary historical revisions for new messages or pinning skills in automation configuration. Clients can invoke only the current managed revision; the server persists that revision on the message.
- Skill marketplaces, importing skills from external registries, or skill evals.

## Users / Use Cases

- A team member writes a "backport a fix" skill once, marks it group-owned and auto-load, and every session in the group can follow it when a backport request arrives.
- An engineer keeps a personal "my debugging workflow" skill that loads only in sessions they create.
- A user manually invokes a rarely needed "prepare quarterly dependency report" skill (auto-load off) from the composer for one specific session.
- A repo ships `.agents/skills/deploy-preview/SKILL.md`; any Deputies session that checks out the repo can discover and use it with no Deputies configuration.
- An automation-created session in a group picks up the group's auto-load skills with no per-invocation setup.
- A platform team maintains an "incident writeup" skill in its own group and shares it with all groups, so every team's sessions can use the same procedure without each group maintaining a copy.

## Requirements

Ownership and access:

- A skill is owned either by one user (personal) or by one access group (group skill).
- Personal skills are visible and manageable only by their owner (and super admins). They load only into sessions created by the owner.
- Group skills follow existing RBAC: group members and admins can create skills in the group; a skill's creator and group admins can edit/archive it; viewers can read but not manage; super admins can do all of this in any group.
- A personal skill can be promoted to a group: the same skill (same id) becomes group-owned, so there is one live version rather than a forked copy. Promotion requires owning the skill and being allowed to create skills in the target group; the promoter remains the skill's creator and keeps creator-management rights. Promotion is one-way in v1 — retiring a group skill means archiving it, not demoting it back to personal.
- A group skill has a share mode: owner group only (default), specific groups, or all groups. Sharing is managed by the skill's creator and owner-group admins; it grants use (loading and invocation) and read access to other groups' members, never edit rights. Sharing is live — changing it affects the next run, and archiving the skill or its owner group stops it loading everywhere. Personal skills cannot be shared; promote first.
- Skills are archived, never hard-deleted, consistent with sessions, groups, and automations. Archived skills never load and cannot be invoked until restored.
- Skill names are slugs (lowercase letters, digits, hyphens), unique case-insensitively within their owner scope (per user, per group).
- Name, description, and body are immutable revision content. Ownership, sharing, enabled/auto-load flags, and archive state remain live properties of the skill identity and are not revisioned.
- Full revision history and historical bodies are visible only to users who can manage the skill. Users with read access can inspect the current body.

Loading and invocation:

- Each skill has `enabled` and `auto_load` flags. At run start the worker resolves: enabled, non-archived auto-load skills of the session's owner group; plus skills shared into that group (specific-group or all-groups share mode); plus enabled, non-archived auto-load personal skills of the session creator; plus repo skills discovered under the well-known roots (`.agents/skills/`, `.claude/skills/`, `.pi/skills/`) in each prepared repository.
- Auto-load always resolves the current managed revision at run start.
- Within one repo, a skill name found in multiple well-known roots is treated as the same skill mirrored across conventions: the first root in the order above wins and the duplicate is collapsed quietly in diagnostics, not reported as a conflict. Discovery caps apply across all roots of a repo combined.
- Manually invoked skills load for that request even when `auto_load` is off. At enqueue, the server authorizes a managed skill against live policy, resolves its current revision, and persists `{ id, name, revisionId }`. A previously persisted historical pin still runs if the skill remains enabled, non-archived, and authorized; a client cannot submit an old revision as a new invocation.
- Auto-load name collisions resolve by precedence: personal > owner-group skills > skills shared in from other groups > repo, with a diagnostic recorded when a skill is shadowed. Collisions among multiple shared-in skills use a deterministic tiebreak and record the shadowed ones. Request-local invocations do not reorder the advertised catalog.
- The composer is slash-only: typing `/` at the beginning of an empty draft opens autocomplete. There is no persistent Skills button. An invoked skill is attached as structured data rendered as a chip, not as text the server must parse, and the agent is instructed to apply that skill to the message's request.
- Repository skill references use repository identity plus skill name and never managed revision IDs. Repository skills marked non-advertised are still recorded during discovery and can be invoked manually after discovery.
- Integration-sourced messages (Slack mentions, GitHub comments, generic webhooks) can invoke skills with a leading `/skill-name` token. Matching uses currently discoverable owner-group, shared-in, and previously discovered repository skills; personal skills are excluded. Managed matches are pinned to current at enqueue. A non-matching token is left in the text as an ordinary prompt rather than failing the message.

Observability and safety:

- Each run emits `skills_loaded` as the canonical audit record for the resolved skill set, including managed revision IDs/numbers, repository identity, shadowing, invocation/advertisement state, and diagnostics. `skill_invoked` records explicit invocation and successful model reads. Resolved skills are not duplicated into run metadata.
- Skills are user/repo-authored instructions and are treated like repo content, not like secrets or system policy. Names and descriptions enter the system prompt; bodies are read from the sandbox on demand. Repo skill discovery is bounded (file count/size caps) so a hostile repo cannot bloat prompts.
- Skill loading failures are non-fatal. The run continues without affected skills and records redacted diagnostics in the loaded-skills event.

## Acceptance Criteria

- A user can create a personal skill and a group skill in the web UI, see them listed, edit them, toggle enabled/auto-load, archive and restore them; the same operations work through the API with RBAC enforced in `API_AUTH_MODE=session`.
- Creating a managed skill publishes revision 1. Changing name, description, or body publishes exactly one new immutable revision only when content actually changes; toggling enabled/auto-load, sharing, ownership, archive state, or submitting an unchanged edit does not publish a revision.
- A session in a group with an enabled auto-load group skill advertises that skill to the agent, and the agent can read its full body from inside the sandbox.
- A personal skill loads in sessions created by its owner and does not load in other users' sessions.
- A skill with auto-load off is not advertised to the agent, but manual invocation from the composer makes the agent apply it for that message.
- A managed invocation is pinned to current at enqueue. If the definition changes before execution, the queued message still uses its persisted revision subject to live authorization; attempts to newly submit an older revision fail as `unknown_skill`.
- Mentioning `@deputies /skill-name ...` in Slack (or a GitHub comment) invokes a matching group or shared skill for that message; a token matching no skill leaves the message unchanged.
- Promoting a personal skill to a group keeps its id and settings, makes it load for the group's sessions on subsequent runs, stops it loading as a personal skill, and leaves the promoter able to edit and archive it as its creator. Promotion into a group with a same-named skill is rejected.
- A group skill shared with all groups loads for sessions in every group; one shared with specific groups loads only there; unsharing or archiving stops it loading outside (or everywhere) on the next run. Members of a shared-into group can read and invoke the skill but cannot edit it.
- A repo containing `<root>/<name>/SKILL.md` under any well-known root (`.agents/skills/`, `.claude/skills/`, `.pi/skills/`) produces a usable skill in sessions that prepare that repo; a skill mirrored across roots loads once; removing the repo association removes the skill on subsequent runs.
- Runs record the loaded skill set and managed revision identity in `skills_loaded`; explicit/model use records revision identity in `skill_invoked`. Archived/disabled skills never resolve, including for persisted pins.
- Managers can inspect complete revision history and historical bodies; sent historical chips link to the exact revision only when the current user can inspect it.
- Deployments apply `017_skills.sql`, which creates the final immutable-revision schema with current revision pointers.

## Open Questions

- Should repo skill loading be configurable per environment (e.g. an environment revision flag) rather than a deployment-wide env var? V1 proposes a deployment env var default-on.
- Do automation-created sessions need per-automation skill selection, or is group auto-load sufficient? V1 assumes group auto-load is sufficient.
- Saved prompts: same table with a `kind` column later, or a separate entity? Deferred; the spec keeps the schema compatible with either.

## Links

- Related issues:
- Related specs: [2026-07-15-agent-skills-technical-spec.md](../specs/2026-07-15-agent-skills-technical-spec.md)
- Related decisions: [ADR 0002 group-owned automations](../../adr/0002-group-owned-automations.md)
