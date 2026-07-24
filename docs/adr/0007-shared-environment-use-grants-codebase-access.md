# Shared environment use grants codebase access

> **Status: Superseded.** Environments are now tenant-wide and have no group-sharing policy. See [Tenant Access](../tenant-access.md).

Sharing an environment with another access group grants that group permission to run agents against every repository in the environment's codebase, assuming the Deputies GitHub App has installation access to those repositories. Deputies does not require each launching user or group to separately hold GitHub repository permission, because environment sharing is the product-level access grant for reusable agent work contexts.
