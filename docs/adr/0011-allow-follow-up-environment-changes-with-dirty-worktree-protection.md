# Allow follow-up environment changes with dirty worktree protection

A writable session may choose a different environment for a follow-up message, and that follow-up snapshots the newly resolved environment for its run without rewriting prior run context. During setup Deputies may clone missing repositories and fetch existing repositories, but it must not discard uncommitted changes; if applying the requested environment would require switching or resetting a dirty repository, the follow-up is blocked before the agent prompt with a clear conflict.
