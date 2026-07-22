# Plan: Replace lateral sharing with organization governance and strict group boundaries

Status: design accepted (2026-07-22)
Scope: control-plane schema and authorization, session/agent authority, skills, environments, repositories and external capabilities, integrations/service principals, revocation workflows, and corresponding web management surfaces

## 1. Outcome

Deputies will treat one deployment as one organization. The organization governs access groups,
organization resources, repository/capability grants, and break-glass operations. Access groups
are the ordinary boundary for sessions, automations, reusable group resources, users, and agents.

The redesign deliberately removes three overlapping mechanisms:

- peer-group resource sharing;
- per-session visibility and write policies;
- creator- and group-admin-specific authority over group work.

The replacement model has two group roles:

| Principal          | Group work                                               | Group boundary                          | Organization resources                               |
| ------------------ | -------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| Viewer             | Complete read-only access, including revisions and audit | None                                    | Read granted resources                               |
| Member             | Full session and group-resource authority                | None                                    | Read/use granted resources; manage group suppression |
| Group-scoped agent | Member authority during an active leased run             | None                                    | Read/use granted resources; manage group suppression |
| Super admin        | Audited break-glass access to all group work             | Create/archive groups and assign access | Full management and grants                           |

`CONTEXT.md` and ADRs 0013–0015 are the authoritative domain and architectural decisions for this
plan. Existing implementation documentation continues to describe current behavior until the
authorization cutover ships, at which point it must be updated in the same change.

## 2. Non-negotiable invariants

1. A session and automation belong permanently to exactly one group.
2. A group-scoped human or agent cannot discover or act in another group.
3. Group-owned resources cannot be shared or transferred to another group.
4. Identity-preserving ownership moves are one-way: user → group → organization.
5. Organization grants can target selected groups or every current and future active group.
6. Group suppression can narrow organization availability but never broaden it.
7. Repository and credential-backed capability access is independent from environment access.
8. Deployment/provider credentials do not imply product authorization.
9. Every mutation has a first-class actor and every run has one causal origin.
10. Agent authority requires an active validly leased run; a session ID is never an agent credential.
11. Revocation denies new authority synchronously and reports containment complete only after
    durable cleanup succeeds.
12. Persisted history cannot be made unknown; revocation prevents future execution and external
    side effects.

## 3. Target domain model

### 3.1 Organization and groups

Do not add an `organizations` table for the first version. The deployment is the organization,
but use explicit `organization` owner/principal discriminants rather than encoding organization
ownership as an unexplained null. This leaves a clean migration path if multi-organization hosting
is ever introduced.

Replace `viewer | member | admin` group membership with `viewer | member`:

- viewers read all group sessions, artifacts, resource definitions, immutable revisions, activity,
  automation invocations, and audit history;
- members can create, modify, archive, restore, invoke, and control all group work;
- only super admins create/archive groups and assign viewer/member access;
- archiving a group immediately enters revocation, freezes mutation and execution, and preserves
  read-only history.

Remove group defaults and policies that no longer have meaning:

- `default_visibility`;
- `default_write_policy`;
- `automation_create_required_role`.

### 3.2 Sessions, runs, and principals

Remove session `visibility` and `write_policy`. Keep `created_by_user_id` only as historical
attribution while introducing explicit actor/origin records.

Represent request and execution principals as discriminated identities rather than bypass flags:

- user;
- super admin;
- group-scoped agent;
- service principal;
- system;
- future organization orchestrator.

Every message, automation invocation, and run receives an immutable causal origin. Scheduled work
has automation origin even when a former user created the automation. Agent descendants inherit
the spawning run's causal chain. A run may claim only messages with the same causal origin.

Agent authorization must require all of:

- active run and valid lease;
- active owning session;
- active owning group;
- matching policy epoch;
- target resource/session in the same group;
- target capability available to the group.

Members and active agents may control every session in the group. Preserve parent/child lineage for
navigation, causal provenance, cancellation trees, and meta-agent coordination, not authorization.

### 3.3 Resource ownership, grants, and suppression

Extend skill ownership to `user | group | organization` and environment ownership to
`group | organization`. Keep owner-specific foreign keys constrained by owner kind.

Prefer typed grant and setting tables over a polymorphic ACL table so Postgres retains foreign-key
integrity:

- organization skill grants and per-group disabled/auto-load-suppressed settings;
- organization environment grants and per-group disabled settings;
- repository grants;
- later, typed external capability/integration grants.

Organization-wide availability is a policy applying to current and future groups, not materialized
rows for today's groups. Per-group suppressions persist across organization default changes,
grant removal/re-addition, and group archive/restore.

Effective skill state is:

```text
enabled = organization_enabled AND NOT group_disabled
auto_load = enabled AND organization_auto_load AND NOT group_auto_load_suppressed
```

Group skills shadow same-name organization skills for auto-load and name fallback. Explicit
invocations remain ID-based. Active organization names must be unique per resource type; promotion
accepts an explicit destination name and fails atomically on collision.

### 3.4 Promotion and personal skills

Promotion preserves resource ID, immutable history, references, and creator attribution:

- a personal skill owner who is a target-group member may promote user → group;
- only a super admin may promote group → organization;
- group → organization promotion initially grants the source group;
- no demotion, peer-group transfer, or identity-preserving copy exists.

Personal skills never auto-load. Explicit invocation materializes an immutable faithful snapshot of
the invoked revision into the group message/run history. Other personal resources remain private
and undiscoverable. Super-admin inspection of uninvoked personal content requires a dedicated,
reason-bearing audit event rather than ordinary list/read access.

### 3.5 Repositories and capability dependencies

Model repositories as organization-controlled capabilities with selected-group or organization-wide
grants. An environment grant does not grant its repositories:

- group environments may include only repositories available to their group;
- organization environments may be granted only to groups with every required repository;
- organization-wide environments may contain only organization-wide repositories;
- publishing an organization environment revision is blocked if any consuming group would lack a
  repository in the new codebase;
- repository grant removal is blocked while a non-archived, non-suppressed effective environment or
  runnable automation depends on it.

Track a session's required capability set as the monotonic union of repositories and credential-backed
capabilities materialized into its sandbox or model context. Direct repository context, environment
revisions, integrations, agent-spawned work, and future runtime profiles must all contribute to the
same set.

Pinned automations depend on their pinned revision. Follow-latest automations depend on the revision
being published/current. Unreferenced historical revisions do not block access changes.

## 4. Persistence and migration

### Phase 1: Additive schema

Add the new columns/tables without changing effective authorization:

- organization owner kinds and owner constraints;
- typed organization grant and group suppression tables;
- repository identities and grants;
- actor and causal-origin discriminants/IDs;
- run lease-bound principal metadata;
- session required-capability records;
- service principals, credentials/references, target groups, and capability grants;
- policy epoch and durable revocation/containment state;
- generalized user/agent/service/system actor support in resource activity and revisions.

Do not overload nullable user IDs to represent agents or service principals. Raw bearer or provider
credentials must not be persisted in audit data.

### Phase 2: Deterministic preflight and backfill

Before behavior cutover, report blockers without mutating production data:

- organization skill/environment name collisions caused by promotion;
- existing shared environments whose repository sets do not match consumer-group repository grants;
- automations whose direct repository/environment dependencies cannot be represented;
- deployments without a recoverable super admin;
- bearer/integration callers lacking a target-group mapping.

Require reviewed names for organization collisions. Do not invent organization-vs-organization
precedence.

Backfill in one idempotent migration workflow:

1. Convert group `admin` memberships to `member`; preserve `viewer` and `member`.
2. Promote every laterally shared skill/environment in place to organization ownership.
3. Convert selected shares to selected grants and `all_groups` to organization-wide availability.
4. Add an initial source-group grant for each promoted resource.
5. Preserve resource IDs, revisions, automation references, and activity history.
6. Record system-attributed promotion/migration activity.
7. Disable ambient personal-skill auto-load without deleting personal definitions.
8. Backfill causal origins conservatively; mark genuinely unknowable historical origins as legacy
   system provenance rather than guessing a user.
9. Derive initial required-capability sets from persisted environment/repository snapshots.

### Phase 3: Atomic authorization cutover

Do not run old and new permission semantics per request. Deploy additive readers/writers first, run
preflight/backfill, then switch the deployment to one authorization-model version atomically.

At cutover:

- stop honoring session visibility/write policy and group admin authority;
- stop lateral shares;
- enforce viewer/member semantics;
- enforce group-wide member and run-bound agent authority;
- enforce grants, suppression, repository dependencies, and hidden ungranted resources;
- reject unscoped bearer/integration access in secured deployments;
- stop issuing fresh credentials through old policy epochs.

Retain old columns/share tables for one release as read-only migration evidence if operationally
useful, then remove them after rollback is no longer required. Never preserve them as a hidden
authorization fallback.

## 5. Authorization and service changes

### Human authorization

Replace role ranking and creator exceptions with direct predicates:

- viewer or member may read group work;
- member may mutate all active group work;
- super admin may govern organization/group boundaries and use audited break-glass access;
- personal resources remain owner-only except invoked snapshots and explicit break-glass inspection.

### Agent tools

Replace owner-group-plus-lineage mutation checks with active-run group authority. Extend the product
tool surface so agents can perform member operations for sessions, skills, environments, automations,
suppression, and other group resources. Every tool operation must recheck active lease, group state,
policy epoch, and target group at commit time.

Do not expose product API credentials to sandboxes. Trusted worker-side tools continue to mediate
product operations and external credentials.

### Service principals and integrations

Replace anonymous `bypass` authorization with scoped service principals:

- each bearer credential/integration has an audit identity;
- each has explicit target groups and capabilities;
- external-thread routing resolves exactly one owning group;
- external usernames are provenance, not authorization;
- `API_AUTH_MODE=none` is development/test-only and outside the secured model.

Preserve a future principal kind for an organization orchestrator, but do not add organization-owned
sessions. A future orchestrator owns a coordination record and creates explicitly authorized
group-owned target sessions.

## 6. Revocation and containment

Implement revocation as a durable state machine:

1. Atomically advance policy epoch and enter `revoking`.
2. Deny new run claims, agent mutations, callback sends, and credential issuance under the old epoch.
3. Identify affected active runs and sessions from causal origin and required-capability records.
4. Cancel runs and suspend queued/retrying external deliveries.
5. Destroy or durably quarantine affected sandboxes.
6. Retry failed cleanup durably with visible error state.
7. Mark `containment_complete` only after terminal run and sandbox invariants hold.

Apply this workflow to:

- group archive;
- repository or credential-backed capability revocation;
- user member → viewer demotion or removal for active work with that user causal origin.

Repository/capability revocation freezes affected sessions and rejects future runs until access is
restored. Existing messages, artifacts, and audit records remain readable. Restored access prepares a
new sandbox; it never revives an old credential or quarantined sandbox.

Skill suppression rejects new and queued invocation at execution authorization but cannot remove
instructions already materialized into an active model context.

Every callback/external delivery reauthorizes its target capability when sending. Group archive or
target-capability revocation suspends pending retries; already-sent deliveries remain history.

## 7. Web product changes

Replace ownership/sharing UI with explicit scope and availability:

- `Group` and `Organization` provenance on skills/environments;
- organization grant editor for selected groups or organization-wide availability;
- group suppression controls for resource enabled state and skill auto-load;
- no owner-group picker for organization resources and no peer-group sharing picker;
- repository grant management and missing-repository dependency diagnostics;
- promotion confirmation explaining irreversible governance transfer;
- read-only viewer experience for all histories and resources;
- super-admin-only group membership/lifecycle controls;
- revoking versus containment-complete status and cleanup failures;
- explicit audit actor, causal origin, and break-glass reason display.

Update the static demo independently of product authorization. It remains hard-coded read-only and
does not require a viewer role to enforce its non-interactive behavior, though its role/share fixtures
must reflect the new model.

## 8. Verification

### Authorization matrices

Add table-driven tests for every resource and operation across:

- viewer, member, super admin, active agent, inactive/stale agent, service principal, and system;
- same group, other group, selected grant, organization-wide grant, suppressed grant, archived group;
- group-, organization-, and user-owned resources;
- valid, stale, cancelled, and lease-lost runs.

Explicitly prove that no group principal can discover another group's sessions, resources, repository
names, capability metadata, or organization resources not granted to it.

### Migration tests

Cover:

- admin → member conversion;
- selected/all-group share promotion and reference preservation;
- organization namespace collision preflight;
- source-group initial grants;
- incompatible environment/repository grants;
- personal skill auto-load removal and invoked snapshot retention;
- rollback before cutover and absence of legacy fallback after cutover.

### Dependency and revocation tests

Cover:

- environment publication blocked by missing repository access;
- organization-wide environment/repository consistency;
- pinned versus follow-latest automation dependencies;
- direct-repository and multi-repository required-capability accumulation;
- policy-epoch race between authorization and mutation/credential issuance;
- cancellation, sandbox quarantine/destruction, durable retry, and containment completion;
- restored access using fresh authority and sandbox state;
- callback send-time reauthorization;
- mixed-origin messages executing in separate runs;
- member removal cancelling only user-originated active work, not group-owned scheduled automation.

### End-to-end checks

Exercise at least:

1. Super admin creates a group and assigns viewer/member access.
2. Member and agent collaboratively manage all group work while viewer remains read-only.
3. No principal crosses into another group.
4. Group skill shadows an organization skill and suppression restores organization behavior.
5. Organization environment use succeeds only with independent repository grants.
6. Repository revocation enters revoking, blocks new authority, freezes affected sessions, and reaches
   containment complete only after sandbox cleanup.
7. Scoped integration creates an attributable session in exactly one allowed group.
8. Explicit personal skill invocation preserves the invoked body in group history without exposing
   the rest of the personal library.

## 9. Delivery sequence

Use reviewable changes in this order:

1. Domain types, additive schema, actor/origin model, and preflight reporting.
2. Organization ownership, grants, suppression, repository access, and deterministic migration.
3. Viewer/member human authorization and removal of session policy/group-admin semantics.
4. Run-bound group-scoped agent authority and expanded trusted product tools.
5. Service principals and deterministic integration routing.
6. Required-capability tracking and dependency validation.
7. Durable revocation/containment state machine and callback reauthorization.
8. Web management/read-only/audit surfaces and static-demo fixture updates.
9. Atomic cutover, broad verification, documentation replacement, then later legacy-column cleanup.

Do not ship a state where new group-wide agent authority is active while bearer bypass, unscoped
repository access, or stale session-lifetime credentials remain available. Those combinations would
expand authority before the new perimeter exists.
