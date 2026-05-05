import { loadConfig } from '../../src/config/index.js';

describe('loadConfig', () => {
  it('uses portable defaults for local development and tests', () => {
    expect(loadConfig({})).toEqual({
      port: 3583,
      maxJsonBodyBytes: 1048576,
      runMode: 'all',
      runner: 'fake',
      sandboxProvider: 'fake',
      appStore: 'memory',
      apiAuthMode: 'none',
      flueSessionStore: 'postgres',
    });
  });

  it('parses supported run modes and providers', () => {
    expect(
      loadConfig({
        PORT: '4000',
        MAX_JSON_BODY_BYTES: '2048',
        RUN_MODE: 'worker',
        RUNNER: 'flue',
        SANDBOX_PROVIDER: 'kubernetes',
        APP_STORE: 'postgres',
        API_AUTH_MODE: 'bearer',
        API_BEARER_TOKEN: 'api-token',
        DATABASE_URL: 'postgres://example',
        FLUE_MODEL: 'anthropic/claude-haiku-4-5',
        FLUE_SESSION_STORE: 'memory',
        DAYTONA_API_KEY: 'daytona-key',
        DAYTONA_API_URL: 'https://daytona.example',
        DAYTONA_TARGET: 'eu',
        DAYTONA_IMAGE: 'ubuntu:latest',
      }),
    ).toMatchObject({
      port: 4000,
      maxJsonBodyBytes: 2048,
      runMode: 'worker',
      runner: 'flue',
      sandboxProvider: 'kubernetes',
      appStore: 'postgres',
      apiAuthMode: 'bearer',
      apiBearerToken: 'api-token',
      databaseUrl: 'postgres://example',
      flueModel: 'anthropic/claude-haiku-4-5',
      flueSessionStore: 'memory',
      daytonaApiKey: 'daytona-key',
      daytonaApiUrl: 'https://daytona.example',
      daytonaTarget: 'eu',
      daytonaImage: 'ubuntu:latest',
    });
  });

  it('rejects invalid ports', () => {
    expect(() => loadConfig({ PORT: 'nope' })).toThrow('PORT must be an integer');
  });

  it('rejects invalid body limits', () => {
    expect(() => loadConfig({ MAX_JSON_BODY_BYTES: '0' })).toThrow('MAX_JSON_BODY_BYTES must be a positive integer');
  });

  it('rejects invalid enum values', () => {
    expect(() => loadConfig({ RUN_MODE: 'cloudflare' })).toThrow('Expected one of all, api, worker');
  });
});
