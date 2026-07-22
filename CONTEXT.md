# Deputies

Deputies is a background coding-agent service that creates and runs agent sessions on behalf of users and integrations.

## Language

**Session**:
A group-owned unit of agent work that remains within its creation group for its lifetime. Group viewers can read it, while group members and agents can control its ordered messages, replayable events, artifacts, and current work state.
_Avoid_: Conversation, chat, task

**Session Detail Ready**:
The operator-visible state where a selected session has rendered its ordered messages, replayable events, and metadata for artifacts displayed inline with those messages or runs. It should feel instant to an operator: p95 under 250 ms and p50 under 100 ms for normal session history, while artifact content, external resources, callback deliveries, and sandbox service discovery may still be loading.
_Avoid_: Thread-ready, fully loaded

**Normal Session History**:
A selected session with up to 100 messages and 2,000 replayable events. Larger histories may require incremental loading, event compaction, or virtualization.
_Avoid_: Typical history, small session

**Session Outputs Ready**:
The operator-visible state where the selected session's persisted secondary outputs have loaded, including the full artifact list, external resources, and callback deliveries. It should complete at p95 under 500 ms for normal output history, may happen after Session Detail Ready, and does not include live sandbox service discovery.
_Avoid_: Fully loaded, hydrated

**Normal Output History**:
A selected session with up to 50 artifacts, 50 external resources, and 100 callback deliveries. Larger output histories may require incremental loading.
_Avoid_: Typical outputs, small outputs

**Sandbox Services Ready**:
The operator-visible state where the selected session's live sandbox services have been discovered and rendered. It may happen after Session Detail Ready and Session Outputs Ready, and it can fail independently when live sandbox state is unavailable.
_Avoid_: Services loaded, live previews ready

**Message**:
A user, integration, or automation prompt inside a session. Messages are ordered within their session and represent work to be processed.
_Avoid_: Turn, request, job

**Run**:
An execution attempt by the agent for one or more claimed messages with one causal origin in a session. A run is not the same thing as a scheduled occurrence or a user request.
_Avoid_: Job, task, scheduled run

**Sandbox**:
An isolated execution environment associated with a session where agent work can read files, run commands, and produce artifacts.
_Avoid_: Container, workspace, runner

**Environment**:
A reusable work context owned by an access group or the organization and selected for a session or automation. An environment can contain sub-configurations for the code the agent should work with and the runtime assumptions it should run under.
_Avoid_: Project, workspace

**Codebase**:
The code sub-configuration of an environment. A codebase identifies one to 10 repositories that belong together for agent work.
_Avoid_: Repository set, code environment

**Primary Repository**:
The repository in an environment's codebase that acts as the default entry point for agent work. A session starts in the primary repository's working directory when its environment has a multi-repository codebase. Primary status does not make other repositories read-only.
_Avoid_: Main repo, selected repo

**Active Repository**:
The repository that repository-aware tools currently target during a session or run. It starts as the primary repository, may change among the environment's repositories as work moves across a codebase, and does not change the environment's primary repository or revision. Any repository in the codebase may be writable.
_Avoid_: Primary repository, current project

**Repository Access**:
The organization-controlled availability of a repository to an access group for agent work. It is granted independently from environments; deployment-level provider access and environment availability do not confer it.
_Avoid_: GitHub App access, environment grant, deployment allowlist

**Environment Revision**:
An immutable version of an environment's supported executable configuration. Revisions currently contain the codebase and can include the runtime profile when runtime profiles are implemented. An environment points to one current revision while historical revisions remain available for traceability and pinned automation work.
_Avoid_: Environment version, configuration copy

**Follow-Latest Automation**:
An automation that resolves the environment's current revision when each invocation is recorded. The invocation retains the selected revision even if the environment later changes.
_Avoid_: Unpinned automation, dynamic environment

**Pinned Automation**:
An automation that always resolves one specified environment revision. Pinning executable configuration does not preserve environment access when live availability or repository policy changes.
_Avoid_: Frozen automation, copied environment

**Environment Activity**:
An append-only audit record of an environment revision, grant, suppression, ownership, name, or lifecycle change, including the actor and time of the change.
_Avoid_: Environment event, telemetry

**Runtime Profile**:
The runtime sub-configuration of an environment. A runtime profile describes sandbox, tooling, and execution assumptions separately from the codebase.
_Avoid_: Runtime environment

**Granted Environment**:
An organization-owned environment made available to an access group through an organization resource grant. The group can use it for sessions or automations only when it has independent access to every repository in the environment's codebase.
_Avoid_: Shared environment, shared project, copied environment

**Organization-Wide Resource Availability**:
An organization resource policy that makes the resource available to every current and future active access group without transferring management authority.
_Avoid_: Public resource, global resource, copied group grants

**Skill**:
A reusable agent instruction owned by a user, an access group, or the organization.
_Avoid_: Prompt, command, plugin

**Personal Skill**:
A user-owned skill available only through explicit invocation by its owner for an individual message. The invoked content becomes immutable group history, but the skill does not become an ambient capability of the session or access group.
_Avoid_: Auto-loaded personal skill, private group skill

**Skill Shadowing**:
The resolution rule where a group skill takes precedence over an available organization skill with the same name for automatic loading and name-based invocation. Both skills retain distinct identities and remain explicitly invocable.
_Avoid_: Skill replacement, skill promotion, name conflict

**Artifact**:
A durable output produced for a session, such as a file, link, preview, or result bundle.
_Avoid_: Attachment, asset

**Integration**:
An adapter that connects an external system to Deputies by normalizing external input into sessions and messages, then delivering source-specific responses.
_Avoid_: Plugin, connector, automation

**External Thread**:
The source-specific conversation or work item that maps an external system back to a Deputies session.
_Avoid_: Channel, issue, conversation

**Callback Delivery**:
A persisted, reauthorized-at-send attempt to deliver a completion response or status update from group-owned work to an external target. Pending and retrying deliveries remain active group work.
_Avoid_: Notification, reply job

**Organization**:
The single company-wide governance scope represented by a Deputies deployment. An organization contains all users and access groups in that deployment and is not a multi-tenant boundary within it.
_Avoid_: Tenant, access group

**Access Group**:
An organization-owned work boundary with viewer and member access. Members have equal authority over work and resources inside the boundary, while the organization governs group membership and lifecycle.
_Avoid_: Tenant, organization, team

**Archived Access Group**:
An access group frozen by the organization so its history remains readable while active work, automations, agents, and resource mutations are stopped until restoration.
_Avoid_: Deleted group, hidden group, inactive team

**Group Viewer**:
A user with complete read-only access to an access group's sessions, resources, revision history, and audit history.
_Avoid_: Guest, member, auditor

**Group Member**:
A user with full authority over an access group's sessions and group resources but no authority over group membership, group lifecycle, or organization resources.
_Avoid_: Group admin, resource owner

**Super Admin**:
A break-glass organization-level user who governs access groups and organization resources and can inspect or control work in every access group.
_Avoid_: Group admin, group owner

**Break-Glass Inspection**:
An explicit, reason-bearing, audited super-admin action that reveals otherwise private user-owned content for an operational need.
_Avoid_: Admin browsing, ambient access, routine inspection

**Service Principal**:
An organization-managed non-human identity with explicit target-group and capability grants used by integrations or API clients. It creates group-owned work under its own audit identity and never receives anonymous organization-wide bypass authority.
_Avoid_: Bearer bypass, bot user, external user

**Group Resource**:
A resource governed by one access group and available only within that group. It cannot be shared directly with another access group.
_Avoid_: Shared group resource, cross-group resource

**Organization Resource**:
A resource governed at the organization level that can be made available to access groups without granting those groups management authority over it.
_Avoid_: Global resource, public resource, shared group resource

**Organization Resource Grant**:
An organization-controlled assignment that makes an organization resource available for use within an access group without transferring management authority.
_Avoid_: Share, invitation, group ownership

**Resource Availability**:
The right of an access group to inspect a resource and use it in that group's sessions or automations. Group ownership and organization resource grants establish availability without creating per-resource permissions inside the group.
_Avoid_: Resource membership, user grant, resource ACL

**Capability Availability**:
The organization-controlled assignment of an external tool, integration, repository, or credential-backed capability to an access group. Group-scoped agents receive only capabilities available to their group and never receive the underlying raw credentials.
_Avoid_: Deployment-wide tool access, ambient credentials, agent credential

**Required Capability Set**:
The cumulative set of repositories and credential-backed capabilities ever materialized into a session's sandbox or model context. The set only grows and determines which capability revocations freeze future work in that session.
_Avoid_: Current environment, active repository, sandbox contents

**Resource Suppression**:
A group-controlled restriction that disables an available organization resource or disables automatic loading of an available organization skill within that group. Suppression can only narrow organization policy and may be managed by group members and group-scoped agents.
_Avoid_: Grant revocation, group override, resource deletion

**Resource Promotion**:
The irreversible transfer of a resource from user ownership to access-group ownership or from access-group ownership to organization ownership. The resource retains its identity and history, while management authority moves to the broader scope.
_Avoid_: Resource copy, resource share, ownership move

**Group-Scoped Agent**:
An agent with the same authority over work and resources as a member of one access group, independent of the memberships and roles of the user who initiated it. It cannot govern the group boundary or organization resources, and its descendants remain in the same access group.
_Avoid_: User-delegated agent, organization agent, cross-group agent

**Organization Orchestrator**:
A future organization-owned coordination principal that creates explicitly authorized group-owned work without granting ordinary group-scoped agents cross-group authority. It is not represented as a session owned by a home group.
_Avoid_: Cross-group agent, Group-Scoped Agent

**Agent-Created Group Resource**:
A durable group resource created by a group-scoped agent on behalf of its access group. The access group owns the resource while the creating agent remains attributable in its history.
_Avoid_: Agent-owned resource, user-owned resource

**Agent Audit Actor**:
A group-scoped agent recorded as the direct actor for its mutations, independently from users who prompted or interacted with its session.
_Avoid_: Impersonated user, initiating user, system actor

**Causal Origin**:
The user, automation, agent, service principal, or organization orchestrator whose action directly initiated a message, invocation, or run. Causal origin is distinct from resource ownership, creator attribution, and the actor executing subsequent mutations.
_Avoid_: Creator, owner, audit actor

**Run-Bound Agent Authority**:
The temporary authority held by a group-scoped agent only while its run is active and validly leased. A session establishes the group and audit identity but is not itself a reusable agent credential.
_Avoid_: Session-lifetime authority, agent bearer token

**Revoking**:
The security state where a policy change already denies new authority and capability use while affected active work and sandboxes are still being durably contained.
_Avoid_: Revoked, cleanup complete, best-effort cancellation

**Containment Complete**:
The security state reached when affected runs are terminal and their executable sandbox state has been destroyed or durably quarantined after revocation.
_Avoid_: Policy updated, cancellation requested

**Automation**:
A group-owned rule that creates agent work without a user manually starting a session at that moment. Automations can be based on time or external events and may include durable prompt context such as repository, model, or branch.
_Avoid_: Trigger, job, workflow

**Automation Creator**:
The user or agent that originally created an automation. The creator is retained for attribution and receives no special authority over the group-owned automation.
_Avoid_: Automation owner, resource owner

**Automation Invocation**:
One durable activation of an automation that creates or attempts to create a session. An invocation can be caused by a schedule, an external event, or a manual operator action, and may be recorded as skipped when domain rules prevent session creation.
_Avoid_: Run, execution, occurrence

**Failed Automation Invocation**:
An automation invocation that could not create its session. Failed invocations are terminal records; the next scheduled time or a manual invocation creates a separate invocation.
_Avoid_: Retried run, failed job

**Disabled Automation**:
An automation that will not be invoked automatically. It can still be manually invoked when an operator explicitly confirms that disabled-state override.
_Avoid_: Paused job, inactive trigger

**Scheduled Automation**:
An automation that creates a new session for each time-based invocation. Its schedule is expressed as a UTC cron expression.
_Avoid_: Scheduled run, cron job

**Automation Management**:
The operator-facing experience for creating, editing, enabling, disabling, manually invoking, and inspecting automation invocations.
_Avoid_: Trigger admin, jobs page

**Automation-Created Session**:
A session created by an automation invocation. Its title should identify the automation and invocation time.
_Avoid_: Generated conversation, bot session

**Overlapping Automation Invocation**:
An automation invocation that would create a new session while a previous session from the same automation is still queued or active. Scheduled automations do not overlap by default.
_Avoid_: Concurrent scheduled run
