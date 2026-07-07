# Executor Data Tools

Use Executor when Deputies agents need access to third-party data tools such as MCP servers, CLIs, SaaS APIs, databases, or internal HTTP services.

Executor sits between Deputies and those upstream tools. Deputies connects to one Executor MCP endpoint, while Executor stores and uses the third-party credentials server-side. The agent receives the Executor tools, not the upstream secrets.

## Why Use Executor

Executor is useful when you want agents to use third-party data tools without wiring each tool directly into Deputies.

- Deputies only needs one MCP configuration for Executor.
- Third-party credentials stay in Executor instead of Deputies environment variables.
- Executor can connect to many upstream tools behind one endpoint.
- Executor policies can allow, require approval for, or block upstream operations.
- Agents get a small, consistent tool interface: discover capabilities with `skills`, run work with `execute`, and continue approval-gated work with `resume`.

## How Tool Discovery Works

Deputies does not receive one MCP tool for every upstream integration configured in Executor. When Deputies connects to Executor, Executor exposes a small fixed MCP tool set:

- `skills` for loading usage guidance.
- `execute` for running Executor code that can search, inspect, and call upstream tools.
- `resume` for continuing approval-gated executions.

Discovery of the actual third-party tools happens inside Executor. The agent can use `skills` to learn how to use `execute`, then call `execute` with code that searches Executor's connected tool catalog, inspects the relevant tool schemas, and calls the selected upstream tool. This keeps the Deputies tool list small even when Executor has many connected services.

## Setup

1. Choose an Executor runtime.
2. Create an Executor API key.
3. Configure `MCP_SERVERS` for Deputies.
4. Add and authenticate third-party tools in Executor.

## 1. Choose Executor Cloud Or Self-Hosted Executor

Use either:

- Executor Cloud, using the MCP endpoint assigned to your Executor workspace.
- A self-hosted Executor deployment, using that deployment's `https://<executor-host>/mcp` endpoint.

Keep Executor reachable from the Deputies control-plane worker. The Executor endpoint does not need to be reachable from agent sandboxes.

## 2. Create An Executor API Key

Create an API key in Executor for the Deputies deployment.

Use this key only as the bearer token for Executor's `/mcp` endpoint. When using Executor, you will not need to put third-party service credentials in Deputies environment variables; store those credentials in Executor when configuring each upstream tool.

## 3. Configure Deputies MCP Servers

Set `MCP_SERVERS` on the Deputies API/worker service environment:

```sh
MCP_SERVERS='[{"name":"executor","url":"https://<executor-mcp-host>/mcp","headers":{"Authorization":"Bearer <executor-api-key>"},"transport":"streamable-http","allowedTools":["execute","skills","resume"]}]'
```

Replace:

- `<executor-mcp-host>` with the Executor Cloud or self-hosted host.
- `<executor-api-key>` with the API key created in Executor.

`allowedTools` is optional, but keeping it to `execute`, `skills`, and `resume` limits Deputies to Executor's expected agent-facing tools.

After deployment, the agent sees these tools with the MCP prefix:

```txt
mcp__executor__execute
mcp__executor__skills
mcp__executor__resume
```

## 4. Add Third-Party Tools In Executor

Use Executor to connect and authenticate the upstream tools the agent should be able to use. Examples include:

- MCP servers.
- SaaS APIs.
- Internal HTTP APIs.
- Data warehouse or database CLIs.
- Custom command-line tools.

Store each upstream credential in Executor, then use Executor policies to allow, require approval for, or block the operations agents may run.

Agents should then call `mcp__executor__skills` for Executor usage guidance, `mcp__executor__execute` to discover and use connected upstream tools, and `mcp__executor__resume` when an approval-gated Executor operation is resumed.

## Operational Notes

- `MCP_SERVERS` is opt-in. If it is unset, Deputies does not connect to remote MCP servers.
- Deputies attaches the `Authorization` header from the control-plane worker process. It is not forwarded to the sandbox environment, prompts, artifacts, or session history.
- If Executor cannot be reached for a run, Deputies skips those tools non-fatally and tells the agent the Executor tools are unavailable for that run.
- See [Deployment](./deployment.md#remote-mcp-servers) for MCP timeout and response-size knobs.
