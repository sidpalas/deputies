# Tenant Access

Deputies uses a single-tenant access model for browser-facing product authentication. Every signed-in user belongs to the deployment's one tenant and has one tenant-wide role. Sessions, automations, environments, tenant skills, and notepads are tenant resources; they are not owned by users or access groups. Personal skills and snippets are explicit owner-only exceptions.

In `API_AUTH_MODE=session`, the API enforces these rules server-side for product routes, event streams, service previews, and browser-facing proxies. `none` and `bearer` intentionally bypass tenant-role checks and are appropriate only for trusted local, test, or machine access; because they have no user identity, they cannot access personal skills or snippets.

## Roles

| Role     | Read                                                                          | Tenant-resource management                                                                               | Personal resources                                | Users and setup configuration                           |
| -------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| `viewer` | All tenant resources, including archived resources and revision/audit history | No                                                                                                       | Manage and use only their own skills and snippets | No                                                      |
| `member` | Same as viewer                                                                | Create, edit, run, archive, and restore sessions, automations, environments, tenant skills, and notepads | Manage and use only their own skills and snippets | No                                                      |
| `admin`  | Same as member                                                                | Same as member                                                                                           | Manage and use only their own skills and snippets | Manage users and roles and instance setup/configuration |

`created_by_user_id` and similar creator fields are audit attribution only. They do not grant private ownership, special write access, or deletion rights. Explicit `owner_user_id` fields on personal skills and snippets are authorization boundaries: even admins cannot access another user's personal resources. Personal skills never auto-load and can be invoked only manually by their owner. Agents operate on tenant resources under the same ordinary-resource boundary; child sessions are tenant-wide resources and lineage is audit/coordination metadata, not an ownership boundary.

Admins cannot demote or remove the final admin. Role changes and removal are serialized in Postgres so concurrent requests cannot bypass this protection.

Ordinary product resources use archive and restore rather than hard delete. Archived tenant resources remain readable tenant-wide but cannot be mutated, run, or invoked until restored. Archived personal resources remain readable only to their owner. User removal is an administrative operation and preserves nullable creator attribution where applicable.

## GitHub Authentication

```sh
API_AUTH_MODE=session
AUTH_PROVIDER=github
AUTH_GITHUB_ADMIN_USERS=octocat
AUTH_GITHUB_ALLOWED_USERS=
AUTH_GITHUB_ALLOWED_ORGANIZATIONS=
AUTH_GITHUB_DEFAULT_ROLE=member
UNSAFE_AUTH_GITHUB_ALLOW_ALL=false
```

`AUTH_GITHUB_ADMIN_USERS` gives listed users the `admin` role when their account is first created. It is not a recurring role-restoration mechanism; subsequent role changes made by an admin are retained. Allowed users and organization members receive `AUTH_GITHUB_DEFAULT_ROLE`, which accepts `viewer`, `member`, or `admin` and defaults to `member`. Unsafe allow-all is intended only for public trial-style deployments.

Static session auth creates the configured static account as an admin. Keep at least one admin account: the application and database reject removal or demotion of the final admin.

## Upgrade From Access Groups

Migration `020_single_tenant_access.sql` converts existing installations. Existing super admins become tenant admins; users with an active member or admin group membership become tenant members; all others become viewers. Former group admins are not promoted to tenant admin because that would grant new instance-wide user and configuration authority. The migration refuses to proceed if it cannot retain an admin.

Group-owned resources become tenant-wide. Resources belonging to archived groups are converted to archived resources so their history remains readable. Existing personal skills and snippets remain owned by their users. Because environment and tenant-skill names become tenant-wide and case-insensitively unique, collisions keep the oldest resource's name and rename later resources with their former group name; a stable UUID suffix resolves any further collision. Groups, memberships, group shares, and session visibility/write-policy columns are then removed.
