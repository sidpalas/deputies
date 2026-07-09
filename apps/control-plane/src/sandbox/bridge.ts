import { sandboxBridgeSkipCookieNamesEnv } from './bridge-env.js';

export const sandboxBridgePort = 3584;

export type SandboxBridgeEnvironmentInput = {
  bridgeToken: string;
  workspacePath: string;
  skippedCookieNames?: string | undefined;
};

export function sandboxBridgeEnvironment(input: SandboxBridgeEnvironmentInput): Record<string, string> {
  return {
    DEPUTIES_SANDBOX_TOKEN: input.bridgeToken,
    DEPUTIES_WORKSPACE: input.workspacePath,
    [sandboxBridgeSkipCookieNamesEnv]: input.skippedCookieNames ?? '',
  };
}

export function sandboxBridgeStartupCommand(port = sandboxBridgePort): string {
  return [
    'PID_FILE=/tmp/deputies-sandbox-bridge.pid;',
    'LOG_FILE=/tmp/deputies-sandbox-bridge.log;',
    `HEALTH_URL=${quoteShell(`http://127.0.0.1:${port}/health`)};`,
    'export HEALTH_URL;',
    'health() { node /opt/deputies/sandbox-bridge/dist/healthcheck.js >/dev/null 2>&1; };',
    'start_bridge() {',
    `DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0 DEPUTIES_SANDBOX_BRIDGE_PORT=${port}`,
    'nohup node /opt/deputies/sandbox-bridge/dist/server.js >> "$LOG_FILE" 2>&1 & echo $! > "$PID_FILE";',
    '};',
    'if ! health; then',
    '[ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null || true;',
    'start_bridge;',
    'fi;',
    'for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
    'health && exit 0;',
    'sleep 0.25;',
    'done;',
    'echo "deputies sandbox bridge did not become ready" >&2;',
    'exit 1;',
  ].join(' ');
}

export function sandboxBridgePreviewUrl(targetUrl: string, port: number): string {
  const target = new URL(targetUrl);
  const base = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname;
  target.pathname = `${base}/preview/${port}`;
  return target.toString();
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
