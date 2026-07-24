# Block environment access removal for active automations

> **Status: Partially superseded.** Environment lifecycle dependency checks remain relevant, but environment shares and group access removal no longer exist. See [Tenant Access](../tenant-access.md).

Deputies blocks archiving an environment or removing an environment share when doing so would make a non-archived automation lose access to its referenced environment. The API reports a conflict with the affected automations so operators must edit or archive those automations before removing the environment access, while existing sessions remain unaffected because they run from snapshotted environment config.
