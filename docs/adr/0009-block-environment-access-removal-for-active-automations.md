# Block environment access removal for active automations

Deputies blocks archiving an environment or removing an environment share when doing so would make a non-archived automation lose access to its referenced environment. The API reports a conflict with the affected automations so operators must edit or archive those automations before removing the environment access, while existing sessions remain unaffected because they run from snapshotted environment config.
