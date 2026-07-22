# Deputies

Deputies is a background coding-agent service that creates and runs agent sessions on behalf of users and integrations.

## Language

**Session**:
The user-visible unit of agent work, permanently owned by the access group selected at creation. A session contains ordered messages, replayable events, artifacts, and the current work state.
_Avoid_: Conversation, chat, task

**Notepad**:
A durable, mutable document for human and agent working notes. A notepad is either a session-local Session Notepad or an independently durable Explicit Notepad.
_Avoid_: Scratchpad, notebook, session note

**Session Notepad**:
A session-local notepad used by exactly one session as its default working document. It follows that session's access and lifecycle, cannot be associated with another session, and may be edited externally only through human session-write authority or explicitly delegated meta-agent authority.
_Avoid_: Primary notepad, default notepad, shared notepad

**Explicit Notepad**:
An access-group-owned notepad created for independent or cross-session work. It has an independent lifecycle and may be associated with multiple sessions owned by the same access group. Through an association it inherits that session's read and write access; standalone access uses its own policy.
_Avoid_: Primary notepad, global notepad

**Notepad Association**:
The relationship that makes an Explicit Notepad available through a session. Readers and writers inherit the associated session's respective access, and a participating agent may associate it with another session in the same access group.
_Avoid_: Notepad ownership, child-session share

**Broad Notepad Discovery**:
An explicitly delegated session capability that lets a meta-agent find and read visible Explicit Notepads beyond those associated with its session. Ordinary session agents discover only associated notepads.
_Avoid_: Global notepad access, automatic notepad search

**Session Notepad Coordination**:
An explicitly delegated meta-agent capability to read and write other sessions' Session Notepads under the live session-write authority of the human who granted it.
_Avoid_: Global session-notepad access, agent admin

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
An execution attempt by the agent for one or more claimed messages in a session. A run is not the same thing as a scheduled occurrence or a user request.
_Avoid_: Job, task, scheduled run

**Sandbox**:
An isolated execution environment associated with a session where agent work can read files, run commands, and produce artifacts.
_Avoid_: Container, workspace, runner

**Environment**:
A reusable work context selected for a session or automation. An environment can contain sub-configurations for the code the agent should work with and the runtime assumptions it should run under.
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

**Environment Revision**:
An immutable version of an environment's supported executable configuration. Revisions currently contain the codebase and can include the runtime profile when runtime profiles are implemented. An environment points to one current revision while historical revisions remain available for traceability and pinned automation work.
_Avoid_: Environment version, configuration copy

**Follow-Latest Automation**:
An automation that resolves the environment's current revision when each invocation is recorded. The invocation retains the selected revision even if the environment later changes.
_Avoid_: Unpinned automation, dynamic environment

**Pinned Automation**:
An automation that always resolves one specified environment revision. Pinning executable configuration does not preserve environment access when live sharing policy changes.
_Avoid_: Frozen automation, copied environment

**Environment Activity**:
An append-only audit record of an environment revision, sharing, ownership, name, or lifecycle change, including the actor and time of the change.
_Avoid_: Environment event, telemetry

**Runtime Profile**:
The runtime sub-configuration of an environment. A runtime profile describes sandbox, tooling, and execution assumptions separately from the codebase.
_Avoid_: Runtime environment

**Shared Environment**:
An environment that a non-owner access group can view and use for sessions or automations without receiving management authority over the environment.
_Avoid_: Shared project, copied environment

**All-Groups Environment Share**:
A non-default sharing mode that lets every current and future non-archived access group view and use an environment without receiving management authority over it.
_Avoid_: Public environment, global environment

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
A persisted attempt to send a completion response or status update back to an external target.
_Avoid_: Notification, reply job

**Access Group**:
A flat product access scope that owns sessions and grants users read, create, write, or management capabilities through group roles and session policies.
_Avoid_: Tenant, organization, team

**Automation**:
A group-owned rule that creates agent work without a user manually starting a session at that moment. Automations can be based on time or external events, carry the access policy for sessions they create, and may include durable prompt context such as repository, model, or branch.
_Avoid_: Trigger, job, workflow

**Automation Creator**:
The user who originally created an automation. The creator can manage their automation while group admins retain management authority for continuity.
_Avoid_: Automation owner, bot user

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
