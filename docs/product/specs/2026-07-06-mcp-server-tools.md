# Remote MCP Server Tools (Executor Proxy Integration)

## Status

Draft — implementation plan, ready for handoff. No code has been written.

## Context

Deputies users want agents to reach 3rd-party data sources without forking Deputies to add custom tools. The chosen entrypoint is a self-hosted [Executor](https://executor.sh/docs/mcp-proxy) instance: Executor is an MCP proxy that exposes **one streamable-HTTP MCP endpoint at `/mcp`** in front of many integrations. Credentials for upstream services are stored server-side in Executor and attached to upstream calls; per-tool policies (allow / require-approval / block) are enforced there. The agent never sees upstream credentials.

**Verified against the operator's live self-hosted instance (Executor 1.0.0 on Railway, probed 2026-07-06):** the MCP surface is **code-mode, not a flattened catalog**. `tools/list` returns exactly three meta-tools regardless of integration count:

- `execute` — run TypeScript in Executor's sandboxed runtime; the code discovers integrations via `tools.search({ query })`, inspects compact schemas via `tools.describe.tool({ path })`, and calls them as `tools.<integration>.<owner>.<connection>.<tool>(args)`; user-visible output via `emit(...)` (text, images, files as MCP content blocks).
- `skills` — fetches long-form usage guides on demand (e.g. `skills({ name: "execute" })`) instead of bloating tool descriptions.
- `resume` — resumes a paused execution (`executionId` + accept/decline/cancel); this is how approval-required policies surface, and connections with `elicitation_mode=model` allow the model itself to resume.

Consequences: the model-context footprint of connecting Executor is small and constant; agent-side tool filtering and proxy-mode patterns are unnecessary _for Executor_ (still relevant for other MCP servers); and approval-gated policies work without any Deputies-side approval machinery. The [MCP Proxy docs'](https://executor.sh/docs/mcp-proxy) "tools join your catalog" language describes the catalog _behind_ `execute`, not the MCP tool list.

Deputies has two runners in `apps/control-plane`:

- **Pi runner** (`src/runner-pi/`, primary going forward) — builds a `customTools: ToolDefinition[]` array per run in `createPiToolSet` (`src/runner-pi/runner.ts:309`) and passes it to `createAgentSession({ noTools: 'builtin', customTools })`. Pi (`@earendil-works/pi-coding-agent` 0.80.3) has **no MCP support**.
- **Flue runner** (`src/runner-flue/`) — assembles tools in `src/runner-flue/runner.ts` (~line 76) and passes them through the agent factory. Flue (`@flue/runtime` 0.11.1) **ships `connectMcpServer(name, options)`**, which connects to a remote MCP server (streamable HTTP or SSE), lists tools with pagination, and adapts them into ordinary Flue tool definitions named `mcp__<server>__<tool>`.

Flue's implementation is the reference design for the Pi adapter. It lives in `node_modules/@flue/runtime/dist/index.mjs` (search `//#region src/mcp.ts`) and does, in order: connect an `@modelcontextprotocol/sdk` `Client` over `StreamableHTTPClientTransport` (or `SSEClientTransport` for legacy servers), paginate `client.listTools()`, then for each tool build a definition with:

- name `mcp__<server>__<tool>` (unsupported chars → `_`, duplicates rejected);
- description composed from original name, server name, optional title, and the tool's own description;
- parameters = the MCP `inputSchema` normalized (`type` defaults to `object`, `properties` defaults to `{}`);
- an `execute` that calls `client.callTool({ name, arguments }, undefined, { signal })`, validates `structuredContent` against `outputSchema` (Ajv) when present, formats content parts (text / image / audio / resource / resource_link) into a single text block, and throws when `result.isError`.

Key execution-boundary fact (see `docs/architecture.md` "Flue Custom Tools"): custom tools run in the **trusted control-plane worker process**, not the sandbox. An MCP tool handler therefore calls Executor from the control plane; Executor auth headers never enter the sandbox. This matches Executor's own security model.

Relevant precedent in this repo: `src/runner-pi/web-search-tool.ts` wraps a plain JSON-Schema object as `ToolDefinition['parameters']` via a cast (`webSearchToolParameters as unknown as ToolDefinition['parameters']`). MCP `inputSchema` is JSON Schema, so the same pass-through works.

### Prior art considered and rejected as dependencies

- **[`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter)** (community package, MIT) adds MCP support to Pi as a **Pi extension** (`pi install npm:pi-mcp-adapter`). Not usable here as-is: extensions load through Pi's `ResourceLoader`, and the Deputies runner deliberately constructs its loader with `noExtensions: true` (`src/runner-pi/runner.ts`, `createPiResourceLoader`) — enabling extension discovery would jiti-load third-party JS from the agent dir inside the trusted control-plane worker. It is also configured via `mcp.json` files (including project-`cwd` files, which in Deputies would resolve against the worker filesystem, not the sandbox) rather than Deputies' env/config layer, and its OAuth flows assume an interactive client. **Two of its ideas are earmarked below**: the single **proxy tool** pattern (`mcp({ search })` / `mcp({ tool, args })`, ~200 tokens instead of a full catalog) as the mitigation for large flat-catalog MCP servers (Executor turned out not to need it — its own surface is already three meta-tools; see Context), and **lazy connect-on-first-call** lifecycle as the follow-up to per-run connection latency.
- **[`context-mode`](https://pi.dev/packages/context-mode)** is orthogonal to this feature (context-window optimization, not data-source connectivity) and is **unsafe in this architecture**: its `ctx_execute` tools run arbitrary code in the process hosting the MCP plugin, which for Deputies would be the trusted control-plane worker rather than the sandbox. Do not install it in the runner. If context savings for bulky MCP results are wanted later, that belongs in a Deputies-owned mechanism that executes inside the sandbox.

`@modelcontextprotocol/sdk` 1.29.0 is already in the pnpm lockfile (transitively); it must be added as a **direct dependency** of `apps/control-plane`.

## Goals

- Operators of Deputies (cloud or self-hosted) can point their deployment at one or more remote MCP servers — primarily a self-hosted Executor instance — via environment configuration only.
- Tools from those servers appear to the agent as ordinary tools (`mcp__<server>__<tool>`) in the **Pi runner** (primary) and the **Flue runner** (parity).
- MCP tool calls execute in the control-plane process; auth headers to the MCP endpoint are never exposed to the sandbox, prompts, events, artifacts, or logs.
- Tool start/finish activity flows through the existing normalized event pipeline with no event-schema changes (Pi's `tool_execution_start/end` → `tool_started`/`tool_finished` already handles any custom tool; see `normalizePiEvent` in `src/runner-pi/runner.ts:662`).
- Pi subagents get the same MCP tools as the parent session without reconnecting per subagent.

## Non-Goals

- Per-user or per-access-group MCP configuration stored in the database, and any web UI for managing MCP servers (future iteration; see Open Questions).
- OAuth flows between Deputies and MCP servers. Auth is static operator-supplied headers (bearer token / API key).
- Surfacing MCP elicitation/approval flows as interactive Deputies approvals. For Executor this turns out not to be needed: approval-gated calls pause the `execute` run and the agent resumes them itself through Executor's `resume` tool (connections with `elicitation_mode=model`) — plain tool calls from Deputies' perspective. Human-in-the-loop approval surfaced in the Deputies UI remains out of scope.
- Running MCP clients inside the sandbox, stdio-transport MCP servers, or MCP resources/prompts/sampling — tools only.
- Building Deputies' own public MCP server (tracked separately in `docs/product/specs/2026-07-05-deputy-session-control-tool.md`).

## Proposed Design

### 1. Configuration (`src/config/index.ts`)

Add one env var parsed and validated at startup, following existing config conventions (`parseEnum`, `parsePositiveInteger`, throw-on-invalid):

```sh
MCP_SERVERS='[
  {
    "name": "executor",
    "url": "https://<your-executor-host>/mcp",
    "headers": { "Authorization": "Bearer <executor-api-key>" },
    "transport": "streamable-http"
  }
]'
```

- `name` (required): unique per entry after sanitization (`[^A-Za-z0-9_-]` → `_`), used in the `mcp__<name>__` tool prefix.
- `url` (required): full MCP endpoint URL. For Executor self-hosted Docker this is `<base-url>/mcp`.
- `headers` (optional): merged into every transport request. **Executor's `/mcp` requires `Authorization: Bearer <token>`**, and the **API key generated in the Executor UI works directly as that token** — verified 2026-07-06 against the operator's live self-hosted instance (authenticated `initialize` → 200, unauthenticated → 401) and against Executor Cloud (401 with `WWW-Authenticate: Bearer resource_metadata=…`, metadata reporting `bearer_methods_supported: ["header"]`). The API key is the designed non-interactive path: the OAuth server (`signin.executor.sh`) advertises only human-in-the-loop grants (`authorization_code`, `refresh_token`, `device_code`; no `client_credentials`), so OAuth support in Deputies remains a Non-Goal. The API key also avoids token expiry/refresh lifecycle entirely (revocation happens in the Executor UI). The field is generic, so it equally carries other servers' credentials or fronting-layer headers.
- `transport` (optional): `'streamable-http'` (default) or `'sse'` for legacy servers.
- `allowedTools` (optional): array of original (unprefixed) tool names; when present, only listed tools are exposed. Cheap client-side narrowing on top of Executor policies.

Add supporting knobs with defaults, mirroring the web-search config style:

- `MCP_TOOL_TIMEOUT_MS` (default `60000`) — per tool call.
- `MCP_CONNECT_TIMEOUT_MS` (default `10000`) — connect + listTools budget per server per run.
- `MCP_TOOL_RESULT_MAX_CHARS` (default `100000`) — formatted result text is truncated with an explicit `[truncated]` marker.
- `MCP_RESPONSE_MAX_BYTES` (default `5242880`) — hard cap enforced while reading MCP transport responses, before SDK JSON/SSE buffering.

Config type: `mcpServers: McpServerConfig[]` (empty array when unset → feature disabled, zero behavior change). Validation errors must name the field and index but **never echo header values**.

### 2. Shared MCP client module (`src/mcp/`)

New runner-agnostic module so Pi and Flue don't duplicate protocol logic:

- `src/mcp/types.ts` — `McpServerConfig`, `McpToolSpec` (adapted name, original name, description, JSON-Schema parameters), `McpConnection` (`tools: McpToolSpec[]`, `callTool(originalName, args, signal)`, `close()`).
- `src/mcp/client.ts` — `connectMcpServer(config, options)` built directly on `@modelcontextprotocol/sdk` (`Client`, `StreamableHTTPClientTransport`, lazily-imported `SSEClientTransport`). Port Flue's logic faithfully:
  - paginate `listTools` via `nextCursor`, capped by total listed tool count and listed tool bytes;
  - adapted naming `mcp__<server>__<tool>` with sanitization; post-sanitization collisions are suffixed (`_2`, `_3`, ...) so the rest of the server stays usable;
  - description composition (original name, server, title, description);
  - `inputSchema` normalization (default `type: 'object'`, `properties: {}`);
  - result formatting for text/image/audio/resource/resource_link/structuredContent parts, `isError` → thrown error whose message is the formatted text;
  - close the client on connect/list failure before rethrowing.
  - Differences from Flue, deliberate: skip Ajv output-schema validation (avoid a new heavy dependency; structured content is still included in the formatted text), and apply `MCP_TOOL_RESULT_MAX_CHARS` truncation.
  - Every `callTool` uses `AbortSignal.any([runSignal, AbortSignal.timeout(toolTimeoutMs)])`.
  - The custom fetch wrapper enforces `MCP_RESPONSE_MAX_BYTES` on both streamable HTTP and SSE responses, blocks only bare streamable-HTTP `GET` requests, and allows `GET` requests carrying `last-event-id` so SDK stream resumption still works.
  - Error hygiene: catch transport errors and rethrow with server `name` + original tool name only; never include header values or full request dumps.

### 3. Pi runner integration (`src/runner-pi/`)

- New `src/runner-pi/mcp-tools.ts` — `createPiMcpToolDefinitions(connection: McpConnection): ToolDefinition[]`. Map each `McpToolSpec` to a Pi `ToolDefinition` following the `web-search-tool.ts` pattern: `name`/`label` = adapted name, `description`, `parameters` = JSON schema cast to `ToolDefinition['parameters']`, `executionMode: 'sequential'`, `execute(_toolCallId, params, signal)` → `connection.callTool(...)` returning `{ content: [{ type: 'text', text }] }`.
- `PiRunnerOptions` gains `mcpServers?: McpServerConfig[]` plus the timeout/cap settings (or a single `mcp?: {...}` options object).
- In `runUnlocked` (`src/runner-pi/runner.ts:131`): when configured, connect to all servers concurrently (and concurrently with `preparePiRepositorySetup`, which already runs before session creation), with the per-server connect budget. **A server that fails to connect must not fail the run**: log a redacted warning and prepend a short note to the prompt via the existing `withSetupNote` mechanism (e.g. "Note: MCP tools from server "executor" are unavailable this run."), so the model doesn't hallucinate missing tools.
- Pass the resulting tool definitions into `createPiToolSet` through `PiToolSetContext` (add `mcpTools?: ToolDefinition[]`). Because `createPiToolSet` is also called by `runPiSubagent`, subagents automatically share the same live connections — thread `mcpTools` through `RunPiSubagentInput` rather than reconnecting.
- Close all connections in the existing `finally` block, after `session.dispose()`, before `persistAndCleanup`. Connection lifetime == run lifetime (no cross-run caching in v1; see Risks).

### 4. Flue runner integration (`src/runner-flue/`)

Use Flue's native `connectMcpServer` (exported from `@flue/runtime`) rather than the shared client, since it already produces Flue `ToolDefinition`s with identical naming:

- In `FlueRunner.run` (`src/runner-flue/runner.ts`, where the `tools` array is built ~line 76): connect configured servers, append `connection.tools`, and `close()` each connection in the run's cleanup path. Same non-fatal failure policy as Pi.
- `FlueRunnerOptions` gains the same `mcpServers` config. The `allowedTools` filter is applied by filtering `connection.tools` on the adapted suffix.
- Flue's native MCP adapter is deprecated and does not honor `MCP_TOOL_TIMEOUT_MS` or `MCP_TOOL_RESULT_MAX_CHARS`; those two knobs are Pi/shared-client-only. Flue still uses `MCP_CONNECT_TIMEOUT_MS` and the custom fetch response byte cap.

### 5. Wiring (`src/index.ts`)

In `createRunner()` (`src/index.ts:361`): pass `config.mcpServers` (and knobs) into `PiRunnerOptions` and `FlueRunner` options when non-empty. No store, worker, event, or web changes required.

### 6. Documentation

- `docs/architecture.md` — extend "Choosing an extension point" with the remote-MCP path now being concrete: control-plane-hosted MCP client, credential boundary, Executor as the recommended aggregation proxy.
- Deployment docs (`deploy/` READMEs, AWS reference env list) — document `MCP_SERVERS` and the knobs, with an Executor self-hosted example (`https://<executor-host>/mcp`).
- `docs/feature-backlog.md` — check off / update lines 33–34 (agent auth to external services through MCP).

## Data Model / Schema Changes

None. No migrations. Session persistence is unaffected (MCP tools are recreated per run like every other custom tool; Pi session history stores tool calls/results as ordinary entries).

## API / Contract Changes

- New env contract: `MCP_SERVERS`, `MCP_TOOL_TIMEOUT_MS`, `MCP_CONNECT_TIMEOUT_MS`, `MCP_TOOL_RESULT_MAX_CHARS`, `MCP_RESPONSE_MAX_BYTES`.
- New direct dependency: `@modelcontextprotocol/sdk` in `apps/control-plane/package.json` (pin `1.29.0`, already in the lockfile transitively).
- Tool names `mcp__<server>__<tool>` will appear in `tool_started`/`tool_finished` events and therefore in the web session view — no UI change needed, but expect the prefix in rendered tool names.

## Testing Plan

- `test/unit/mcp-client.test.ts` — use the MCP SDK's `InMemoryTransport.createLinkedPair()` with an in-test `McpServer` to cover: tool listing with pagination and caps, name sanitization and collision suffixing, schema normalization, `allowedTools` filtering, result formatting for each content part type, `isError` → thrown, truncation cap, transport byte cap, per-call timeout, abort-signal propagation, streamable-HTTP `GET` resumption behavior, connect failure closes the client.
- `test/unit/pi-runner.test.ts` (extend existing) — with a fake/in-memory MCP server configured: MCP tools present in the session's custom tools; a prompted tool call round-trips; connect failure keeps the run alive and prepends the unavailability note; connections closed after the run, after run failure, after abort, and after early post-connect setup failure; subagent tool set includes MCP tools without a second connect.
- `test/unit/flue-runner.test.ts` (extend existing) — MCP tools appended and connection closed on completion/failure/abort.
- Config tests in `test/unit/config.test.ts` — parse/validate `MCP_SERVERS` (valid, invalid JSON, missing fields, duplicate names, bad transport), defaults for knobs including `MCP_RESPONSE_MAX_BYTES`.
- Manual UAT against the real Executor instance. **Endpoint already verified directly (2026-07-06)**: authenticated `initialize` → 200 (server `executor` 1.0.0), unauthenticated → 401, `tools/list` → the 3 code-mode tools, and a real `tools/call` (`skills`) round-trips. Remaining UAT after implementation: set `MCP_SERVERS` with the instance URL and `Authorization: Bearer <api-key>` header, run a Deputies session that exercises an Executor-proxied integration end-to-end (`execute` → `tools.search` → integration call → `emit`), verify `mcp__executor__*` tool events render in the web UI, and exercise a paused/`resume` round-trip and a blocked-policy call to confirm both surface cleanly.
- Repo checks: run tests per `AGENTS.md` (`npx pnpm@11.5.2 install`, mise tasks; CI runs unit tests).

## Rollout / Migration Plan

Single PR containing the whole feature. Suggested implementation order within the PR (each step keeps the tree green and builds on the previous):

1. Config parsing + validation (`MCP_SERVERS` and knobs) and the `@modelcontextprotocol/sdk` dependency, with config tests.
2. Shared `src/mcp/` client module with its unit tests (in-memory MCP server).
3. Pi runner integration (primary): `runner-pi/mcp-tools.ts`, `runUnlocked` lifecycle, subagent threading, wiring in `src/index.ts`, pi-runner tests.
4. Flue runner parity via `connectMcpServer`, flue-runner tests.
5. Docs: `docs/architecture.md` extension-point update, deploy env documentation with an Executor example, `docs/feature-backlog.md` update.

Manual UAT against the real Executor instance happens after merge/deploy (see Testing Plan) since it needs the deployed environment and instance credentials.

Feature is off unless `MCP_SERVERS` is set, so rollout is opt-in per deployment. Rollback = unset the env var.

## Risks And Tradeoffs

- **Per-run connect + listTools latency** (one HTTP round trip or two per server per run). Acceptable at current scale and the simplest correct lifecycle; mitigated by connecting concurrently with repository preparation. Follow-up optimization (not v1): lazy connect-on-first-call with idle disconnect, as `pi-mcp-adapter` does, and/or a control-plane catalog cache with TTL.
- **Large tool catalogs bloat the model context — for non-Executor servers.** Executor itself is immune: its live MCP surface is three code-mode meta-tools with catalog discovery happening inside `execute` (verified 2026-07-06; see Context), so integration count never inflates the model context. Other MCP servers configured via `MCP_SERVERS` may still expose large flat catalogs; mitigations: server-side trimming where available, the `allowedTools` client-side filter, and — if a genuinely large flat-catalog server becomes important — the proxy-tool pattern proven by `pi-mcp-adapter` (single `mcp` tool with `{ search }` / `{ tool, args }`) as a per-server `mode: 'direct' | 'proxy'` option in a follow-up PR.
- **Approval-required Executor policies** have no interactive counterpart in Deputies runs; such calls will error or hang until timeout. Documented guidance: use allow/block policies for Deputies agents in v1.
- **Secret handling**: header values live in env config alongside existing provider keys — same trust level as `WEB_SEARCH_BRAVE_API_KEY` etc. The main implementation discipline is redaction in logs and thrown errors (explicit test for this).
- **Prompt-injection via tool results**: MCP results are untrusted remote content entering model context, same class of risk as web-search results. Truncation cap applies; no additional sanitization in v1.
- **SDK protocol drift**: streamable HTTP is current-spec; pinning `@modelcontextprotocol/sdk@1.29.0` matches the already-locked version used by Pi's dependency tree.

## Open Questions

- ~~How MCP clients authenticate to Executor's `/mcp`~~ — resolved 2026-07-06: bearer token in the `Authorization` header; the operator's UI-generated API key was verified live against the self-hosted instance (200 authenticated / 401 unauthenticated). Nothing remains open here.
- Should MCP-server unavailability optionally fail the run (strict mode env flag) for automations that depend on a data source? Default in this plan: continue with a prompt note.
- Per-access-group MCP configuration (DB-backed, encrypted headers via the existing `sandboxSecretEncryptionKey` pattern) and a settings UI — likely the next iteration once instance-level config proves out.

## Links

- Related PRD: none (operator-facing config feature; this spec stands alone)
- Related decisions: `docs/architecture.md` §Flue Custom Tools / Choosing an extension point
- Reference: https://executor.sh/docs/mcp-proxy , https://executor.sh/docs/hosted/docker (endpoint `/mcp`, streamable HTTP)
- Reference implementation: `@flue/runtime` `connectMcpServer` — `node_modules/@flue/runtime/dist/index.mjs` (`//#region src/mcp.ts`) and `docs/guide/tools.md` in that package
- Repo precedent for JSON-Schema Pi tools: `apps/control-plane/src/runner-pi/web-search-tool.ts`
- Prior art (design input only, not dependencies): https://pi.dev/packages/pi-mcp-adapter (proxy tool + lazy lifecycle patterns), https://pi.dev/packages/context-mode (rejected — executes code in the host process)
