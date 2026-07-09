# Prepare multi-repository codebases all-or-nothing

When a session or automation invocation resolves an environment with a multi-repository codebase, Deputies prepares every repository before the agent prompt and fails the run if any repository cannot be cloned or checked out. This avoids agents working from partial codebase context when the selected environment promised a complete set of repositories.
