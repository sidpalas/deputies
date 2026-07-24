# Launching group owns sessions from shared environments

> **Status: Superseded.** Sessions and environments are now tenant-wide resources with no owning or sharing group. See [Tenant Access](../tenant-access.md).

When an access group uses a shared environment to start a session or automation, the resulting sessions are owned by the launching group rather than the environment owner group. This keeps the reusable environment definition under its owner group's control while keeping session history, artifacts, access policy, and operational responsibility with the group that initiated the work.
