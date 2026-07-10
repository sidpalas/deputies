import { sandboxBridgeSkipCookieNamesEnv } from './bridge-env.js';

export const sandboxBridgePort = 3584;
export const sandboxBridgeTokenHeader = 'x-deputies-bridge-token';

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
  return `DEPUTIES_SANDBOX_BRIDGE_PORT=${port} /opt/deputies/ensure-sandbox-bridge.sh`;
}

export function sandboxBridgePreviewUrl(targetUrl: string, port: number): string {
  const target = new URL(targetUrl);
  const base = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname;
  target.pathname = `${base}/preview/${port}`;
  return target.toString();
}
