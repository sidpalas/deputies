# Group-owned automations

> **Status: Partially superseded.** Automations remain durable independently of their creator, but they are now tenant-wide resources managed by members and admins. Creator identity is audit-only. See [Tenant Access](../tenant-access.md).

Automations are owned by access groups, while the creating user is retained as audit metadata and creator-level management authority. This lets scheduled automations continue when their creator leaves the company, keeps generated sessions aligned with Deputies' group-owned session access model, and avoids introducing bot users with ambiguous memberships and permissions.
