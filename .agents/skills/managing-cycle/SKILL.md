---
name: managing-cycle
description: Manages Cycle.io via MCP and API. Use for provisioning, deployments, configuration, diagnostics, logs, and container or VM execution.
---

# Managing Cycle

Prefer Cycle's hosted MCP; use the Platform API for unsupported operations or fields.
The `cycle` connection intentionally exposes all tools, including write and exec.
Discover tool schemas before calling them. For missing configuration or connection
issues, read [reference/setup.md](reference/setup.md).

## Workflow

1. Confirm the target hub and inspect affected resources through MCP.
2. Work autonomously within the authorized experiment. Unless explicitly authorized,
   ask before deleting persistent data, tearing down the hub, or changing resources
   outside the experiment. Credentials do not confer authorization.
3. Use destructive-operation dry runs when available.
4. Await job completion and verify resource health; request acceptance is not success.
5. After ambiguous failures, reconcile jobs and resource state before retrying mutations.

## Platform API fallback

Consult the [Platform API reference](https://cycle.io/docs/api) for endpoints,
schemas, pagination, and job semantics. Send requests from the executor to
`CYCLE_API_BASE_URL` with credentials from its environment:

- `Authorization: Bearer <CYCLE_API_KEY>`
- `X-Hub-Id: <CYCLE_HUB_ID>`
- `Content-Type: application/json` for JSON request bodies

Keep MCP and API calls scoped to the same hub and authorization. Never bypass
permission denials through API fallback or credential escalation.
`403.restricted-portal` denotes a portal-only endpoint, not insufficient key permissions.

Never disclose or commit credentials, embed literal keys in commands, or enable
shell tracing or verbose HTTP logging. Minimize retrieved fields and redact secrets.
Add helpers only for recurring API-only workflows, not the entire API.
