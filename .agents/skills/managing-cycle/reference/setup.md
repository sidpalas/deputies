# Cycle access setup

## Credentials and endpoints

Use a dedicated experiment hub and API key (**Hub Settings → API Keys**).
Start with **Admin**; verify capabilities and resource ACLs for provisioning,
deployments, console/SSH, and integrations. Roles are editable; rank governs role
hierarchy, not capabilities. Admin is not root, and role management is Owner-only
by default. API keys inherit role permissions, not OAuth consent scopes.

Copy the key at creation; Cycle will not display it again. In Amp's personal
**Secrets & Env Vars** settings, configure:

| Name                 | Type                 | Value                                                    |
| -------------------- | -------------------- | -------------------------------------------------------- |
| `CYCLE_API_KEY`      | Secret               | The dedicated Cycle API key                              |
| `CYCLE_HUB_ID`       | Environment variable | The experiment's hub ID                                  |
| `CYCLE_MCP_URL`      | Environment variable | `https://na.mcp.cycle.io/` or `https://eu.mcp.cycle.io/` |
| `CYCLE_API_BASE_URL` | Environment variable | Versioned Platform API base for the hub's control plane  |

For NA, use `https://api.cycle.io/v1` as the API base. Match the MCP region to the
hub; confirm API endpoints for other control planes with Cycle or your administrator.

Store the key only as a secret, never in Git or a thread. Personal settings apply
to your orbs and override same-named project settings. Use project settings instead
for shared project access. Direct API calls are not subject to remote MCP tool
approval policies. Revoke the key when the experiment ends.

## Activate and verify

1. Use a checkout containing this repository skill.
2. Start a new orb or run `amp orb restart-processes` to refresh its environment
   (restarts managed processes and may interrupt services).
3. Reload skills and MCP, then load `managing-cycle`.
4. List environments through MCP. Verify the hub ID using API `GET /v1/hubs/current`.
5. Compare MCP results with API `GET /v1/environments`, accounting for pagination
   and filters. Validate write/exec permissions during authorized work, not by
   mutating resources solely to test access.

Local runners need these variables in their executor environment; orb settings do
not automatically populate local shells.

## Connection behavior

- API-key MCP requires both `Authorization` and `X-Hub-Id` headers.
- `includeTools: ["*"]` includes current and future tools. Amp connects during
  discovery but hides tools until skill load.
- Direct MCP configuration overrides this skill's `cycle` server and bypasses
  skill-based tool visibility. Avoid duplicate registration.
- Use separately named connections for multiple hubs; never silently retarget one.
- Authentication failure: check region, hub ID, and key validity.
- Permission denial: inspect role capabilities and ACLs, not another interface.
- `403.restricted-portal`: portal-only endpoint; broader permissions will not help.

## Official references

- [Cycle MCP connection and regional endpoints](https://cycle.io/docs/mcp/connecting-to-cycle-mcp)
- [Cycle API keys](https://cycle.io/docs/platform/api-keys)
- [Cycle roles and capabilities](https://cycle.io/docs/platform/roles-and-capabilities)
- [Cycle role management](https://cycle.io/docs/portal/managing-hub-members)
- [Cycle Platform API reference](https://cycle.io/docs/api)
- [Amp skills and bundled MCP configuration](https://ampcode.com/docs/customize/skills)
- [Amp orb secrets and environment variable scope](https://ampcode.com/docs/orbs/handling-secrets)
