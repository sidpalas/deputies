# Deputies

Deputies is a background coding-agent service that creates and runs agent sessions on behalf of users and integrations.

## Language

**Session**:
The user-visible unit of agent work. A session contains ordered messages, replayable events, artifacts, and the current work state.
_Avoid_: Conversation, chat, task

**Message**:
A user, integration, or automation prompt inside a session. Messages are ordered within their session and represent work to be processed.
_Avoid_: Turn, request, job

**Run**:
An execution attempt by the agent for one or more claimed messages in a session. A run is not the same thing as a scheduled occurrence or a user request.
_Avoid_: Job, task, scheduled run

**Sandbox**:
An isolated execution environment associated with a session where agent work can read files, run commands, and produce artifacts.
_Avoid_: Container, workspace, runner

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
