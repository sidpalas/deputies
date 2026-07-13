# No Lifecycle Cascade From Parent Sessions To Spawned Children

## Status

Approved

## Date

2026-07-06

## Decision

Cancelling a parent session's run, or archiving a parent session, never cancels or archives sessions that the parent spawned through the `deputies` tool. Children are fully independent durable sessions from the moment they are created. Human cleanup of unwanted children happens through UI visibility, such as the lineage panel on the parent, never through automatic cascade.

## Context

The deputy session control surface lets an agent in a running session spawn new durable Deputies sessions. That raised the question: when a user cancels or archives the parent, should its children be cancelled or archived too?

The deciding principle is that the system already has two delegation mechanisms with intentionally different lifecycles, and the choice between them is the lifecycle decision:

- Intra-run subagents created with the Pi `subagent` tool live inside the parent's run and abort with it. Work that should die with its initiator belongs there.
- `deputies.spawn` creates an independent product session: a separate feature, a bug discovered along the way, or a handoff. Choosing `spawn` asserts that the work is an independent durable record that may outlive the parent.

Cascading cancellation would turn spawned children back into subagents with extra steps and erase the distinction the tool guidance teaches the model. It also fights the architecture: children are ordinary sessions claimed by other workers under their own run leases, and a spawned child is user-visible and multiplayer. A human may already have sent it follow-up messages that cascade would destroy.

## Options Considered

- No cascade, chosen. Children always survive parent cancellation and archival.
- Cascade on archive only, rejected. Archival means this parent's work is done or abandoned, which says nothing about children explicitly created to live independently, and it would destroy sessions humans may be actively using.
- Cascade on run cancellation, rejected. Cancelling a run often means stop this turn, then re-prompt; the parent session keeps living, so killing children is wrong.
- Configurable cascade, rejected for now. It adds a policy knob before any real usage shows it is needed.

Runaway spawn is handled by making human cleanup easy and by bounding blast radius with `DEPUTY_MAX_SPAWN_DEPTH`, `DEPUTY_MAX_CHILDREN_PER_SESSION`, and `DEPUTY_MAX_SPAWNS_PER_RUN`. A future parent UI can add a human-triggered "cancel active children" affordance, but the decision stays with a human and is never automatic.

## Consequences

- No cascade code should be written for parent cancellation or archival.
- Tool guidance must tell agents that parent run cancellation and parent archival do not affect children, and that direct children must be cancelled explicitly with `deputies({ action: "cancel", sessionId })` when no longer needed.
- Orphaned completion notifications are expected. A `notifyOnComplete` child that finishes after its parent was archived fails to enqueue the parent notification because archived sessions reject messages. The worker catches this, logs a warning with child and parent session IDs, and continues finalizing the child without retrying or surfacing a run failure.
- `get_session` remains the parent's cheap view of child state by default. Transcript retrieval is explicit, bounded, and paginated newest-first.

## Revisit When

- Real usage shows orphaned children regularly burning meaningful sandbox or model budget despite caps and UI visibility.
- Multi-tenant or budget-enforcement work introduces hard per-tree resource limits that need lifecycle coupling.
- A human-triggered "cancel active children" UI affordance proves insufficient and users ask for cancel-by-default semantics.

## Links

- Related specs: `docs/product/specs/2026-07-05-deputy-session-control-tool.md`
- Related docs: `docs/architecture.md`
- Related pull requests: pending, `feature/deputy-session-control-tool`
