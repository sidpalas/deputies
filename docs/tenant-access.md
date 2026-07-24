# Tenant Access

Deputies uses a single-tenant access model for browser-facing product authentication. Every signed-in user belongs to the deployment's one tenant and has one tenant-wide role. Sessions are tenant-wide by default, while a member or admin may create an owner-only private session and later promote it to tenant-wide. Automations, environments, tenant skills, and notepads are tenant resources; they are not owned by users or access groups. Private sessions, personal skills, and snippets are explicit owner-only exceptions.

In `API_AUTH_MODE=session`, the API enforces these rules server-side for product routes, event streams, service previews, and browser-facing proxies. `none` and `bearer` intentionally bypass tenant-role checks and are appropriate only for trusted local, test, or machine access; because they have no user identity, they cannot access personal skills or snippets.

## Roles

| Role     | Read                                                                          | Tenant-resource management                                                                               | Personal resources                                              | Users and setup configuration                           |
| -------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| `viewer` | All tenant resources, including archived resources and revision/audit history | No                                                                                                       | Manage and use only their own skills and snippets               | No                                                      |
| `member` | Same as viewer                                                                | Create, edit, run, archive, and restore sessions, automations, environments, tenant skills, and notepads | Manage their private sessions and their own skills and snippets | No                                                      |
| `admin`  | Same as member                                                                | Same as member                                                                                           | Manage their own private sessions, skills, and snippets         | Manage users and roles and instance setup/configuration |

`created_by_user_id` and similar creator fields are audit attribution only. They do not grant private ownership, special write access, or deletion rights. A private session's immutable `owner_user_id` is an authorization boundary: no other user can list, search, open, mutate, preview, or receive events for it, including admins. Trusted bearer/unauthenticated bypass modes have no user identity and therefore cannot access private sessions. Promotion changes `visibility` from `private` to `tenant`, retains the owner for audit history, emits an access-change event, and cannot be reversed. Spawned children initially inherit the parent's visibility and owner, but visibility is not a lineage boundary: each private session can be promoted independently. Session-bound agents can read and manage any tenant session plus private sessions belonging to their acting private session's owner, but cannot discover another user's private sessions. Parent IDs remain audit metadata and never grant access to an inaccessible related session.

Explicit `owner_user_id` fields on personal skills and snippets are also authorization boundaries: even admins cannot access another user's personal resources. Personal skills never auto-load and can be invoked only manually by their owner.

Admins cannot demote or remove the final admin. Role changes and removal are serialized in Postgres so concurrent requests cannot bypass this protection.

Ordinary product resources use archive and restore rather than hard delete. Archived tenant resources remain readable tenant-wide but cannot be mutated, run, or invoked until restored. Archived private and personal resources remain readable only to their owner. User removal is an administrative operation and preserves nullable creator attribution where applicable; a private-session owner remains referenced so its authorization and audit boundary cannot be orphaned.

## Session API

`POST /sessions` accepts `visibility: "tenant" | "private"` and defaults to `tenant`, preserving existing behavior. The server derives private ownership from the authenticated user and does not accept an owner ID from clients. `PATCH /sessions/:sessionId` with `{ "visibility": "tenant" }` promotes exactly that owner-visible private session, including a child, without changing its parent or descendants. Promotion must be sent separately from title or tag changes. Attempts to set `private` on an existing session, promote an already tenant-wide session, or access another user's private session are rejected; unauthorized direct access uses `404` to avoid confirming that the session exists.

Private creation is protected by `PRIVATE_SESSIONS_ENABLED`, which defaults to `false`. The disabled API rejects private creation, private agents cannot spawn new private children, and the UI hides private-creation controls; tenant-wide behavior is unchanged. Existing private sessions remain readable to their owners and can still be promoted while creation is disabled. Enable creation only after every API, worker, and combined control-plane instance has been upgraded through migrations `021_private_sessions.sql` and `022_validate_private_sessions.sql`. This two-phase rollout is required: first deploy the new version with the flag disabled, wait until no older control-plane instance remains, and then enable the flag in a second deployment. Enabling during the first rolling deployment could let older API or worker code expose a private session created by a newer process. The Helm chart therefore defaults `config.privateSessionsEnabled` to `false`.

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
