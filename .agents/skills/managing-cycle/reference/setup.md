# Cycle access setup

This repository skill bundles a hosted MCP connection plus instructions for direct
Platform API access. It does not create a Cycle key, provision infrastructure, or
grant permissions by itself.

## Create credentials

1. Choose the experiment hub, preferably separate from production.
2. In Cycle's **Hub Settings → API Keys**, create a dedicated key for this
   experiment. Assign a role with the full capabilities and resource ACL access
   required for read, write, and exec operations. API-key connections use the key's
   permissions, not the OAuth read/write/exec consent checkboxes.
   For this broad, low-friction experiment, start with **Admin** rather than
   Owner / Root, then inspect its actual capabilities for provisioning,
   deployments, console/SSH, and integrations. Admin is rank 7 and DevOps Engineer
   rank 5, but rank controls role hierarchy, not operational capabilities. Default
   roles can be edited, and the public docs do not enumerate the exact default
   capability difference. Admin is not unrestricted root; role management is
   documented as Owner-only by default. Do not assume either role's name grants
   every capability.
3. Copy the key when created; Cycle does not show it again. Copy the hub ID too.
4. Store the following in Amp's project **Secrets & Env Vars** settings for
   Deputies (or personal settings if only your orbs should receive them):

| Name                 | Type                 | Value                                                    |
| -------------------- | -------------------- | -------------------------------------------------------- |
| `CYCLE_API_KEY`      | Secret               | The dedicated Cycle API key                              |
| `CYCLE_HUB_ID`       | Environment variable | The experiment's hub ID                                  |
| `CYCLE_MCP_URL`      | Environment variable | `https://na.mcp.cycle.io/` or `https://eu.mcp.cycle.io/` |
| `CYCLE_API_BASE_URL` | Environment variable | Versioned Platform API base for the hub's control plane  |

The published Platform API reference uses `https://api.cycle.io/v1`. Confirm the
API base for your hub's control plane rather than deriving it from the MCP URL.
For custom control planes, obtain the MCP and API endpoints from the administrator
or Cycle support. The MCP region must match the hub.

Never commit the key, paste it into a thread, or put it in a non-secret environment
variable. Project secrets are available to project orbs; personal secrets apply to
your orbs, and personal values override project values with the same name. Choose
the scope deliberately. Full-access keys also enable direct API mutations, which
are not governed by approval policies on an Amp-managed remote MCP server.

## Activate and verify

1. Make these files available in the checkout used by Amp. This is a repository
   skill, not an automatically published personal or workspace skill.
2. Start a new orb after saving the variables, or run `amp orb restart-processes`
   in an existing orb to refresh its environment and restart managed processes.
   This can interrupt running services, so do it at a suitable stopping point.
3. Ask Amp to reload skills and MCP, then load `managing-cycle`. MCP tools remain
   hidden until the skill is loaded, though Amp connects during skill discovery.
4. Ask: “Use Cycle to list the environments in my experiment hub and their states.”
   Verify that Amp makes a real tool call against the intended hub.
5. Verify API fallback with the documented `GET /v1/environments` endpoint using
   the same hub and key. Compare environment IDs with the MCP result, accounting
   for pagination and filters. Do not mutate infrastructure just to test access.
   Read success alone does not prove every write or exec capability; verify those
   during the first authorized operation that needs them.

For a local runner, provide the same variables to its Amp executor environment;
orb settings do not automatically populate an ordinary local shell.

## Connection behavior

- Both `Authorization` and `X-Hub-Id` are required for API-key MCP connections.
- `includeTools: ["*"]` deliberately exposes all MCP tools for this experiment,
  including future tools, but only after the skill loads. Narrow this filter if
  the skill is later repurposed for a more restricted environment.
- Do not also register a `cycle` server in Amp settings unless intentionally
  overriding this skill's server. Direct configuration takes precedence and can
  make its tools visible without loading the skill.
- For multiple hubs, use explicitly named connections and separate configuration;
  never silently switch the hub under an operation.
- If authentication fails, check the region, hub ID, and key validity without
  printing the key. A missing capability requires reviewing the key's role/ACLs,
  not retrying through a different interface.
- Revoke the dedicated key when the experiment ends.

## Official references

- [Cycle MCP connection and regional endpoints](https://cycle.io/docs/mcp/connecting-to-cycle-mcp)
- [Cycle API keys and role/ACL permissions](https://cycle.io/docs/platform/api-keys)
- [Cycle roles and capabilities](https://cycle.io/docs/platform/roles-and-capabilities)
- [Cycle role hierarchy and default role-management access](https://cycle.io/docs/portal/managing-hub-members)
- [Cycle Platform API reference](https://cycle.io/docs/api)
- [Amp skills and bundled MCP configuration](https://ampcode.com/docs/customize/skills)
- [Amp orb secrets and environment variable scope](https://ampcode.com/docs/orbs/handling-secrets)
