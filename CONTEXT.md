# Deputies Domain Vocabulary

Use these terms in current product documentation and implementation.

**Tenant**: The single company-wide scope represented by one Deputies deployment. Deputies does not partition product resources into access groups.

**Viewer**: A tenant user with read-only access to active and archived tenant resources, revisions, and audit history. Like every authenticated user, a viewer may manage only their own personal skills and snippets.

**Member**: A tenant user who can read and ordinarily manage sessions, automations, environments, tenant skills, notepads, and related work. A member cannot manage users or instance setup configuration.

**Admin**: A tenant user with member capabilities plus user/role and instance setup/configuration management. The final admin cannot be removed or demoted.

**Session**: A durable tenant-wide unit of agent work with ordered messages, replayable events, artifacts, callbacks, sandbox state, and current work state.

**Message**: An ordered prompt, follow-up, integration request, system entry, or deputy-authored coordination entry in a session.

**Run**: One execution attempt for claimed session messages. Runs are historical records and are distinct from product sessions and Pi runtime sessions.

**Child Session**: A tenant session created by another session's deputy tool. Parent/child lineage supports coordination and audit; it does not create ownership or an authorization boundary.

**Explicit Notepad**: A tenant-wide durable coordination document that can be associated with sessions. Associations do not alter tenant access.

**Scheduled Follow-up**: A session-bound durable instruction to append and process a message in that session at one or more future times. It inherits the target session's tenant or private access boundary rather than defining separate ownership. Recurring scheduled follow-ups are always bounded by an end time, a maximum number of occurrences, or both.

**Scheduled Follow-up Occurrence**: A durable record of one due activation of a scheduled follow-up that appends or attempts to append a message and counts toward the schedule's occurrence bound regardless of outcome. Recurrence neither accumulates unfinished messages nor replays every missed time; after an interruption, only the latest missed time may produce a catch-up message.

**Scheduled Follow-up Context**: The context used by a scheduled follow-up occurrence. Explicitly selected values remain fixed from schedule creation, while unspecified values resolve from the session's active context when the occurrence becomes due.

**Environment**: A tenant-wide reusable, revisioned multi-repository work context selected for sessions or automations.

**Skill**: A reusable agent instruction with immutable definition revisions and live enabled and archive state. Tenant skills are available tenant-wide and may auto-load. Personal skills are owner-only and manually invokable. Repository skills remain repository-authored instructions discovered during runs.

**Prompt Snippet**: A private, user-owned web-composer shortcut expanded into editable message text. The submitted message does not retain snippet identity.

**Automation**: A tenant-wide rule that creates agent work on a schedule or external event without a user manually starting it at that moment.

**Automation Creator**: Audit attribution for who created an automation. Creation confers no ownership or special authority.

**Creator Attribution**: A nullable `created_by`/`created_by_user_id` reference used for audit only. It never grants private reads, special writes, or ownership. Explicit `owner_user_id` fields on personal skills and snippets are authorization boundaries, not creator attribution.

**Archive**: The ordinary-resource removal lifecycle. Archived tenant resources remain tenant-readable, while archived personal resources remain owner-readable; neither can be mutated or invoked until restored. Ordinary resources are not hard-deleted.

**External Thread**: A deterministic mapping from an external Slack, GitHub, or generic webhook thread to a tenant session.

**Integration Delivery**: A durable inbound dedupe/processing record for an external event.

**Callback Delivery**: A durable, retryable attempt to deliver a completion response or status update to an external target.

**Artifact**: A durable output produced by a run, with tenant-readable metadata and either stored bytes or a verified external URL.

**Sandbox**: A provider-backed isolated execution environment associated with a session. Provider lifecycle and credentials do not define product access.
