# Snapshot environment config for agent work

Sessions and automation invocations keep a reference to the environment used for traceability, but they run from a snapshot of the environment's resolved codebase and runtime profile. Existing sessions do not change when an environment is edited or unshared, while each automation invocation resolves the current environment only if the automation's group still has use access at invocation time.
