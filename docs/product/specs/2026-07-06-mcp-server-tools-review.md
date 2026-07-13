# Review Findings: Remote MCP Server Tools Implementation

Two independent reviews (standard + adversarial) of the MCP implementation on branch `claude/sharp-montalcini-757c06`, performed 2026-07-07 against the spec in `2026-07-06-mcp-server-tools.md`. This document is the handoff to the implementing agent: fix the items below, add the listed tests, and check off each item.

Verification status at review time: `tsc --noEmit` clean; unit suite 516/517 (the one failure is pre-existing and unrelated — `setup-script.test.ts` blocks on machines with `commit.gpgsign=true`; do not chase it).

**Confirmed clean (do not change):** credential redaction end to end (bearer value unreachable from errors, logs, events, session history, model context, artifacts; asserted in tests), config validation echoing field/index but never header values, name sanitization/duplicate rejection behavior, subagent connection sharing without reconnect, opt-in gating (feature fully off when `MCP_SERVERS` unset), connect-concurrent-with-repo-prep, non-fatal connect failure with `withSetupNote` note.

## Fix Status

- [x] 1. Response buffering capped with `MCP_RESPONSE_MAX_BYTES` and response-body limiting fetch wrappers for streamable HTTP and SSE.
- [x] 2. Streamable HTTP bare `GET` remains blocked, but `GET` with `last-event-id` is allowed for SDK stream resumption.
- [x] 3. Pi post-connect setup failures close established MCP connections before rethrowing.
- [x] 4. `MCP_TOOL_TIMEOUT_MS` and `MCP_TOOL_RESULT_MAX_CHARS` are enforced by the Pi/shared client.
- [x] 5. MCP errors now log/throw allowlisted categories instead of raw error names/messages.
- [x] 6. Post-sanitization tool-name collisions are suffixed instead of dropping the server.
- [x] 7. Tool result formatting/truncation now runs inside the redacting tool-call guard.
- [x] 8. `listTools` accumulation is capped by tool count and serialized tool bytes.
- [x] 9. Added lifecycle, abort, byte-cap, stream-resumption, and redacted-error regression tests.
- [x] 10. `.env.example` documents `MCP_SERVERS` and all MCP knobs.
- [x] 11. Removed the dead optional branch in `readMcpString` by replacing it with required-string parsing.

---

## Blocking

### 1. MAJOR — Unbounded response buffering allows OOM of the shared worker

`apps/control-plane/src/mcp/client.ts:66-80`. `MCP_TOOL_RESULT_MAX_CHARS` truncation runs **after** `await client.callTool(...)` has fully buffered the response. SDK 1.29 buffers the entire body (`streamableHttp.js:394` `await response.json()`; SSE path accumulates via `EventSourceParserStream`). The 60s `AbortSignal.timeout` bounds duration, not bytes — a malicious/compromised endpoint can deliver multi-GB inside the window and OOM the control-plane worker, which is shared by all concurrent sessions (`workerConcurrency`, default 4).

**Fix:** enforce a hard byte cap while receiving, not after. The client already injects a custom `fetch` (`createStreamableHttpMcpFetch`) — extend it to wrap the response body in a size-limiting stream (count bytes; abort/throw past a cap, e.g. new config `MCP_RESPONSE_MAX_BYTES`, default a few MB, validated like the other knobs). Ensure the failure surfaces as a redacted tool error, not a crash. Apply the same wrapper to the SSE transport path.

### 2. MAJOR — GET-blocking fetch wrapper disables SSE stream resumption, hanging in-flight calls

`apps/control-plane/src/mcp/client.ts:94-102, 129`. `createStreamableHttpMcpFetch` returns 405 for **every** GET. In SDK 1.29, when a POST-initiated SSE stream carrying an in-flight `tools/call` response drops, the transport resumes via **GET with a `last-event-id` header** (`_handleSseStream` → `_scheduleReconnection` → `_startOrAuthSse`); a 405 there is swallowed and the pending request never resolves. Real-world trigger: a multi-minute Executor `execute` call streamed through a proxy (e.g. Railway idle timeout) has its stream cut — a stock client resumes and completes; this client hangs until `MCP_TOOL_TIMEOUT_MS` and reports a redacted failure.

**Fix:** in the wrapper, allow GET requests that carry a `last-event-id` header (the discriminator for resumption); keep blocking bare GETs (standalone server-push stream, which is the thing intentionally suppressed).

### 3. MAJOR — Pi runner leaks connections thrown between connect and the `try`/`finally`

`apps/control-plane/src/runner-pi/runner.ts:148-216`. Connections close in the connect-failure catch (:153-156) and the run `finally` (:275), but a throw from `getSessionLease` (:159, async, store/DB-backed), the `Pi model is not available` throw (:164), or `resourceLoader.reload()` (:167) leaks the connected MCP clients (abort listeners, timers, server-side Executor session). With `MCP_SERVERS` set, every early-failed run leaks.

**Fix:** either move the MCP connect to just before the existing `try` with nothing throwable in between, or wrap the whole post-connect region so any throw before the main `try` closes connections (e.g. `try { lease/model/loader … } catch (e) { await closeAll(); throw e; }`).

## Minor

5. **Redaction discards all diagnostic signal** — `apps/control-plane/src/mcp/client.ts:217-227`, `src/mcp/runner.ts:5-8`. Only `error.name` survives, so an expired API key (HTTP 401), DNS failure, and protocol error all log as `(Error)`; operators cannot diagnose a dead integration. Fix: build a small allowlisted classifier — map to safe categories (`unauthorized`/`forbidden`/`not_found` from HTTP status when available, `dns_error`, `timeout`, `connection_refused`, `protocol_error`, `unknown`) and log that category. Never include raw `error.message` (SDK errors embed response bodies).
6. **One sanitization collision disables the whole server** — `client.ts:133-151`. Two tool names colliding post-sanitization (`a.b` vs `a_b` → `mcp__s__a_b`) throws and drops every tool from that server. Fix: skip/suffix the colliding tool (e.g. `_2`) or exclude just the duplicates, log the safe tool names involved, keep the rest of the server usable.
7. **`formatMcpResult` runs outside the redacting try/catch** — `client.ts:77`. Pathologically deep `structuredContent` can make `JSON.stringify` throw a raw `RangeError` that bypasses `redactedToolError` and truncation. Fix: move formatting+truncation inside the guarded region (or its own try/catch mapping to the redacted error path).
8. **Unbounded `listTools` pagination and schema size** — `client.ts:52-59, 161-167`. Bounded only by the 10s connect budget. Fix: cap accumulated tool count (e.g. 1,000) and total listed bytes; treat exceeding the cap as a connect failure (non-fatal to the run, as usual).
9. **Missing spec-mandated lifecycle tests** — `test/unit/pi-runner.test.ts`. Add: connections closed on run abort; connections closed on run failure (this is the regression test for finding 3 — make it fail before the fix); run-signal abort propagates into an in-flight `callTool`; tool-call error at runner level surfaces redacted. Also add tests for the fixes to 1 (oversized body → redacted error, no OOM) and 2 (GET with `last-event-id` passes through, bare GET still 405).
10. **`.env.example` not updated** — add the `MCP_SERVERS` + `MCP_*` block alongside the existing `WEB_SEARCH_*` documentation (lines ~115-121).
11. **Dead branch in `readMcpString`** — `apps/control-plane/src/config/index.ts`: the `required=false` branch throws even for `undefined` and is never exercised; remove the parameter or fix the branch.

## Process notes

- After fixes: `tsc --noEmit`, full unit suite (`npx pnpm@11.5.2` if plain pnpm is broken), and update `2026-07-06-mcp-server-tools.md` if any behavior/config surface changed (e.g. new `MCP_RESPONSE_MAX_BYTES` knob, Pi-only knob documentation).
- Do not weaken the redaction guarantees while fixing 5/7 — the tests asserting header-value non-leakage must keep passing, and new error text must come from allowlisted categories only.
