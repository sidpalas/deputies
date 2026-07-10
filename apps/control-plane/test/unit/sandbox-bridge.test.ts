import {
  sandboxBridgeEnvironment,
  sandboxBridgePreviewUrl,
  sandboxBridgeStartupCommand,
} from '../../src/sandbox/bridge.js';

describe('sandbox bridge helpers', () => {
  it('builds the shared bridge launch environment and readiness command', () => {
    expect(
      sandboxBridgeEnvironment({
        bridgeToken: 'bridge-token',
        workspacePath: '/workspace',
        skippedCookieNames: 'deputies_preview,deputies_session',
      }),
    ).toEqual({
      DEPUTIES_SANDBOX_TOKEN: 'bridge-token',
      DEPUTIES_WORKSPACE: '/workspace',
      DEPUTIES_SANDBOX_SKIP_COOKIE_NAMES: 'deputies_preview,deputies_session',
    });

    expect(sandboxBridgeStartupCommand()).toContain('/opt/deputies/ensure-sandbox-bridge.sh');
    expect(sandboxBridgeStartupCommand()).toContain('DEPUTIES_SANDBOX_BRIDGE_PORT=3584');
    expect(sandboxBridgeStartupCommand()).not.toContain('node');
  });

  it('routes a provider preview URL through the requested bridge preview path', () => {
    expect(sandboxBridgePreviewUrl('https://3584-sandbox.example.test/base/', 3000)).toBe(
      'https://3584-sandbox.example.test/base/preview/3000',
    );
  });
});
