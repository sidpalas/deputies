# Browser Tool Transport Spike

Date: 2026-07-11

## Provisional Recommendation

The current evidence favors a native Pi `browser` tool backed by a run-scoped Playwright daemon inside the sandbox. Each tool call would execute a short-lived CLI through `SandboxHandle.exec` and communicate with the daemon over a private Unix-domain socket.

This is not a final transport decision: neither option completed an end-to-end browser-tool spike. Do not implement the MCP route through the browser-facing service preview without first adding a provider-neutral, worker-facing HTTP tunnel that works for remote Docker orchestrators as well as Daytona.

## Options Evaluated

### Per-run Playwright MCP over sandbox HTTP

Daytona can expose the sandbox bridge through its authenticated HTTPS preview. The bridge can proxy `/preview/<port>/mcp` to a Playwright MCP server bound inside the sandbox, and its streaming request/response implementation appears compatible with Streamable HTTP.

This path is not portable across the current providers:

- A remote Docker worker can receive a bridge URL based on the orchestrator's `127.0.0.1`, which is not reachable from the worker's network namespace.
- The browser-facing service proxy requires platform preview authentication and host routing intended for users, not ephemeral internal clients.
- `SandboxHandle` does not expose provider endpoint resolution, so the runner would need a new provider abstraction.
- Current MCP adaptation converts image results to text placeholders, so MCP screenshots would not be visible to the model without a multimodal result-contract change.
- Closing the MCP client does not stop the in-sandbox server or Chromium; a new run-owned service lifecycle is still required.

A real Daytona experiment installed and launched `@playwright/mcp` inside temporary sandboxes, then attempted to resolve its authenticated bridge endpoint and connect with Deputies' Streamable HTTP MCP client. Both the configured image and the published `latest` image failed endpoint setup because `/opt/deputies/ensure-sandbox-bridge.sh` was absent. The MCP process and sandboxes were cleaned up. This confirms that option (a) also depends on coordinated image rollout before its transport can be evaluated end to end; it did not displace the provider-portability blockers above.

MCP becomes attractive if Deputies later adds an authenticated abstraction such as `sandbox.openHttpEndpoint({ port, lifecycle: 'run' })` that tunnels arbitrary HTTP methods and streaming responses identically across providers.

### Native tool over sandbox exec

Docker and Daytona already implement the same `SandboxHandle.exec` contract. A one-shot CLI avoids worker-to-sandbox networking, service-preview authentication, per-run MCP configuration, and base64 screenshot transport. The daemon can write PNGs to the sandbox filesystem and the control-plane can return them through the same image-capable path used by the sandbox `read` tool.

The Daytona experiment created a real sandbox using the configured API credentials, launched a detached process with `nohup`, returned from the SDK exec call, probed the process from a second exec call, terminated it, and destroyed the sandbox. The process survived and cleanup succeeded. No API credential was printed or persisted.

## Proposed Shape

Install a browser daemon and CLI only in browser-enabled Docker and Daytona images. Use a random per-run socket and token:

```text
/tmp/deputies-browser-<run-id>/browser.sock
/tmp/deputies-browser-<run-id>/ready.json
```

The daemon owns one Chromium browser, one 1280x720 context, and one active page. The control-plane tool lazily starts it, retains the PID/socket/token in a run-local closure, and shuts it down from the runner's `finally` path.

Use a small versioned protocol with actions such as `open`, `snapshot`, `navigate`, `click`, `fill`, `press`, `screenshot`, and `close`. Accessibility references must carry a page revision; navigation and mutations invalidate references from earlier revisions. Bound snapshots by semantic node count, depth, and bytes.

Screenshots should return a sandbox path. The control-plane reads the PNG through `SandboxFileSystem.readFileBuffer` and returns model-visible image content. Artifact publication remains an explicit separate action.

## Required Foundations

1. Extend Pi tool-set construction with run-scoped disposables so daemon shutdown runs after success, failure, and cancellation.
2. Add an explicit browser-automation sandbox capability plus a defensive first-use executable probe. Provider-name checks are insufficient for custom or older images.
3. Add daemon-side action deadlines. Daytona abort currently stops waiting locally but does not reliably cancel the remote command.
4. Keep request payloads in command arguments or temporary files until Daytona forwards `SandboxExecInput.stdin`.
5. Use per-run sockets and tokens so a worker crash cannot cause a later run to attach to an orphaned browser.
6. Keep one context/page to limit memory pressure and preserve scripted recording as the preferred demo path.

## Verification Needed During Implementation

- Protocol version rejection, stale references, snapshot truncation, action serialization, and structured browser errors.
- Startup races, stale ready files, normal shutdown, forced process-group cleanup, and worker cancellation.
- Model-visible PNG delivery without base64 in exec output.
- Docker bridge smoke test and real Daytona smoke test with Chromium, including daemon survival and shutdown.
- Browserless-provider behavior: no advertised tool, or a clear capability error without failing the run.

## Outcome

Option (b) appears to be the lower-risk provider-neutral architecture, and generic detached-process survival on Daytona is empirically validated. Before making the final decision, run a focused implementation spike with an actual Playwright daemon and Unix socket on both Docker and Daytona, verify authenticated screenshot delivery, and complete the MCP transport test on an image containing the sandbox bridge. Production implementation should also wait for a run-scoped disposable mechanism; without guaranteed cleanup, persistent sandboxes can accumulate Chromium processes.
