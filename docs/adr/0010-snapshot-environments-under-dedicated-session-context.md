# Snapshot environments under dedicated session context

Environment-backed sessions and automation invocations store the resolved environment snapshot under `context.environment`, including environment identity and the resolved codebase repositories. Deputies keeps the existing top-level `context.repository` and `context.branch` shape for direct single-repository work, so environment-backed work and legacy direct-repository work remain unambiguous.
