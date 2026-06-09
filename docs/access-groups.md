# Access Groups

Access groups are Deputies' v1 RBAC model for browser-facing product auth. They control who can see sessions, create new work, send follow-ups, manage membership, and open session services/previews.

Access groups are flat company/org access scopes. They are not tenant boundaries, billing units, nested groups, or directory-sync groups.

## Core Model

- Users sign in through the configured product auth mode.
- Groups contain users with a group role: `viewer`, `member`, or `admin`.
- Each session has one owning access group.
- Each session has a read visibility policy and a write policy.
- `super_admin` is a global user role outside group membership.

In `API_AUTH_MODE=session`, the API enforces these rules server-side for sessions, follow-up messages, event streams, service previews, and browser-facing proxy routes.

`API_AUTH_MODE=none` and `API_AUTH_MODE=bearer` bypass session RBAC by design. Use those modes only for local/test/internal deployments where shared API access is intended.

## Roles

| Role          | Scope  | Can read                                                            | Can create sessions      | Can send follow-ups                                    | Can manage group    | Can manage all groups |
| ------------- | ------ | ------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ | ------------------- | --------------------- |
| `viewer`      | Group  | Group-only sessions in that group and organization-visible sessions | No                       | No                                                     | No                  | No                    |
| `member`      | Group  | Group-only sessions in that group and organization-visible sessions | Yes, in that group       | Yes when the session write policy allows group members | No                  | No                    |
| `admin`       | Group  | Group-only sessions in that group and organization-visible sessions | Yes, in that group       | Yes, for sessions owned by that group                  | Yes, for that group | No                    |
| `super_admin` | Global | All sessions                                                        | Yes, in any active group | Yes, for all sessions                                  | Yes                 | Yes                   |

Group admins can add, remove, and change members in groups they administer. Super admins can manage all access groups, all group memberships, and other super admins.

## Session Access Policies

Every session has these access fields:

| Field                | Values                          | Behavior                                                                                                                                                         |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner_group_id`     | Access group ID                 | The group that owns the session. Write and group-only read checks use this group.                                                                                |
| `visibility`         | `group`, `organization`         | `group` restricts read access to members of the owning group. `organization` lets any signed-in user read the session.                                           |
| `write_policy`       | `group_members`, `creator_only` | `group_members` lets members and admins of the owning group write. `creator_only` lets the session creator write; group admins and super admins can still write. |
| `created_by_user_id` | User ID                         | Used for `creator_only` write access.                                                                                                                            |

Admins can edit a session's access settings. Moving a session to another group requires admin access in both the current group and target group, unless the user is a super admin.

When a session is moved to a different group, it inherits the target group's default visibility and write policy unless the request explicitly sets different values.

## Group Defaults

Each group has default session access settings:

- Default visibility: `Organization` or `Group only`.
- Default write policy: `Group members` or `Creator only`.

New sessions created in a group inherit those defaults. Group admins can override access defaults when creating sessions in their group. Members can create sessions but cannot override the group defaults.

For public-trial GitHub auth with `UNSAFE_AUTH_GITHUB_ALLOW_ALL=true`, default-group member sessions use `creator_only` writes so trial users do not get broad write access to each other's sessions.

## UI Workflows

Open `Groups` from the lower-left sidebar navigation to manage access groups.

The groups sidebar shows:

- `Manage super admins` for super admins.
- `Groups` with active access groups.
- `Archived groups` behind a toggle when archived groups exist.
- Search across active and archived groups.

The main panel shows either the selected group or super-admin management.

For a group admin or super admin, the group panel allows:

- Renaming the group.
- Updating default visibility and write policy.
- Adding users to the group.
- Changing user roles.
- Removing users from the group.
- Archiving or unarchiving the group.

Users without management access can see their accessible groups and read-only group information, but cannot change settings or membership.

## Super Admins

Super admins are global operators. They are not modeled as members of every group, and group membership changes should not be used as a break-glass path.

Super admins can:

- Create groups.
- Manage all groups and memberships.
- Promote or remove other super admins.
- Read and write all sessions.
- Move sessions between active groups.

Static session auth creates/restores the configured static user as a super admin. GitHub session auth restores users listed in `AUTH_GITHUB_ADMIN_USERS` as super admins on login. Keep at least one value in `AUTH_GITHUB_ADMIN_USERS` for recovery in GitHub-auth deployments.

## GitHub Auth And Default Access

For GitHub product login, configure these env vars:

```sh
API_AUTH_MODE=session
AUTH_PROVIDER=github
AUTH_GITHUB_ADMIN_USERS=octocat
AUTH_GITHUB_ALLOWED_USERS=
AUTH_GITHUB_ALLOWED_ORGANIZATIONS=
AUTH_GITHUB_DEFAULT_GROUP_ROLE=member
UNSAFE_AUTH_GITHUB_ALLOW_ALL=false
```

`AUTH_GITHUB_ADMIN_USERS` grants global super-admin access and restores it on login.

`AUTH_GITHUB_ALLOWED_USERS` and `AUTH_GITHUB_ALLOWED_ORGANIZATIONS` allow non-admin users to sign in. Allowed users are regular users and receive membership in the default group using `AUTH_GITHUB_DEFAULT_GROUP_ROLE`.

`AUTH_GITHUB_DEFAULT_GROUP_ROLE` accepts `viewer`, `member`, or `admin`. The default is `member`.

`UNSAFE_AUTH_GITHUB_ALLOW_ALL=true` allows any GitHub user to sign in and receive default group access. This is intended only for public trial-style deployments, not internal production deployments.

Removed/renamed env vars from the pre-RBAC model:

| Old env var                            | Replacement                                    |
| -------------------------------------- | ---------------------------------------------- |
| `AUTH_GITHUB_ADMIN_ORGANIZATIONS`      | Removed. Super admins are explicit users only. |
| `AUTH_GITHUB_VIEWER_USERS`             | `AUTH_GITHUB_ALLOWED_USERS`                    |
| `AUTH_GITHUB_VIEWER_ORGANIZATIONS`     | `AUTH_GITHUB_ALLOWED_ORGANIZATIONS`            |
| `UNSAFE_AUTH_GITHUB_ALLOW_ALL_VIEWERS` | `UNSAFE_AUTH_GITHUB_ALLOW_ALL`                 |

## Archived Groups

Groups are archived instead of deleted.

Archiving a group:

- Hides it from the active groups list.
- Prevents new sessions from being created in that group.
- Prevents sessions from being moved into that group.
- Suspends owned automation invocations without changing automation enabled state.
- Does not archive, delete, or move existing sessions.
- Does not remove existing group memberships.

Existing sessions owned by an archived group keep their access behavior. Unarchiving the group makes it available for new sessions, moves, and owned automation invocations again.

## Names And Uniqueness

Group names are trimmed before saving and must be globally unique, case-insensitively, across active and archived groups.

Examples that conflict:

- `Client access`
- `client access`
- `CLIENT ACCESS`

The API returns `409 group_name_exists` for duplicate names. The web UI also validates duplicates inline before saving when it has enough local group data to detect the conflict.

## Read-Only Experience

Users with read-only access can inspect accessible sessions, messages, artifacts, callbacks, services, and metadata. They cannot start new sessions or send follow-up messages unless their group role and the session write policy allow it.

The composer explains read-only access in the disabled textbox placeholder instead of showing a large global banner.

## Limitations In V1

- No nested groups.
- No custom roles or permission editor.
- No per-session user allowlists.
- No external directory sync yet.
- No group deletion.
- No tenant-isolation semantics beyond access checks.

External systems such as WorkOS, Okta, or SCIM can be added later by syncing external users/groups into the internal `groups` and `group_members` model. The authorization checks can continue to use internal effective membership.
