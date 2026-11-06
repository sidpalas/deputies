---
name: managing-cycle
description: Manages Cycle.io infrastructure through its hosted MCP and Platform API. Use for Cycle provisioning, deployments, configuration, logs, diagnostics, and container or VM execution.
---

# Managing Cycle

Use Cycle's hosted MCP for supported operations and the Platform API for missing functionality.
This skill targets a full-access greenfield experiment, not a read-only connection.

## Connection

Read [reference/setup.md](reference/setup.md) for credential setup, regional endpoints,
and connection verification. Do not print credentials, inspect secret values, or put
them in source control or tool output. If configuration is missing, ask for setup
rather than inventing a hub or endpoint.

The bundled `cycle` MCP connection exposes all tools intentionally, including write
and exec tools. Discover the available tools and their schemas rather than guessing
tool names or arguments. Confirm the connected hub matches the intended target
before provisioning or changing resources.

## Workflow

1. Inspect the relevant resources and current state through MCP.
2. Prefer an MCP tool when it supports the requested operation. Use the Platform
   API only for functionality or fields the MCP does not expose.
3. Work autonomously within the experiment the user has authorized, including
   provisioning, deploying, configuring, and debugging. Full-access credentials
   are capability, not blanket authorization for unrelated actions. Ask before
   deleting persistent data, tearing down the hub, or affecting resources outside
   the requested experiment unless explicitly authorized.
4. Use dry runs when available for destructive operations. Identify the hub and
   affected resources before applying changes.
5. Follow asynchronous jobs to completion and inspect the resulting resource state.
   A successful request or accepted job is not proof that a deployment is healthy.
6. After a timeout or ambiguous failure, inspect jobs and resources before retrying
   a mutation; the first request may already have taken effect.

## Platform API fallback

Consult the current [Platform API reference](https://cycle.io/docs/api) for the exact
endpoint, method, schema, pagination, and job semantics. Use `CYCLE_API_BASE_URL`
as the versioned API base and send these headers:

- `Authorization: Bearer <CYCLE_API_KEY>`
- `X-Hub-Id: <CYCLE_HUB_ID>`
- `Content-Type: application/json` for JSON request bodies

Make direct HTTP requests from the executor with credentials read from its
environment. Do not paste literal keys into commands, enable shell tracing, use
verbose HTTP logging, or return sensitive configuration values in the transcript.
Fetch only the fields needed for the task and redact secrets from results.

A missing MCP operation is different from a permission denial. Do not bypass
denied permissions by switching to the API or escalating credentials. Some
endpoints are portal-only and return `403.restricted-portal`; API access does not
remove that restriction.

Keep the same hub and authorized scope across MCP and API calls. If a repeated
API-only workflow needs a helper, add one only for that concrete workflow rather
than generating a second catalog of the entire API.
