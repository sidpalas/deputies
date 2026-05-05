import { loadConfig } from '../src/config/index.js';

describe('loadConfig', () => {
  it('uses portable defaults for local development and tests', () => {
    expect(loadConfig({})).toEqual({
      port: 3583,
      runMode: 'all',
      runner: 'fake',
      sandboxProvider: 'fake',
      flueSessionStore: 'postgres',
    });
  });

  it('parses supported run modes and providers', () => {
    expect(
      loadConfig({
        PORT: '4000',
        RUN_MODE: 'worker',
        RUNNER: 'flue',
        SANDBOX_PROVIDER: 'kubernetes',
        FLUE_SESSION_STORE: 'memory',
      }),
    ).toMatchObject({
      port: 4000,
      runMode: 'worker',
      runner: 'flue',
      sandboxProvider: 'kubernetes',
      flueSessionStore: 'memory',
    });
  });

  it('rejects invalid ports', () => {
    expect(() => loadConfig({ PORT: 'nope' })).toThrow('PORT must be an integer');
  });

  it('rejects invalid enum values', () => {
    expect(() => loadConfig({ RUN_MODE: 'cloudflare' })).toThrow('Expected one of all, api, worker');
  });
});
