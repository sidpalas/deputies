import { loadConfig } from '../../src/config/index.js';

describe('loadConfig', () => {
  it('uses portable defaults for local development and tests', () => {
    expect(loadConfig({})).toEqual({
      port: 3583,
      maxJsonBodyBytes: 1048576,
      runCancellationPollIntervalMs: 1000,
      sandboxIdleTimeoutSeconds: 900,
      sandboxStopDelaySeconds: 60,
      sandboxRetentionSeconds: 3600,
      runMode: 'all',
      runner: 'fake',
      sandboxProvider: 'fake',
      localSandboxAllowedCommands: [],
      appStore: 'memory',
      apiAuthMode: 'none',
      authCookieSecure: false,
      flueSessionStore: 'postgres',
      slackApiBaseUrl: 'https://slack.com/api',
      unsafeAllowAllSlackIds: false,
      slackAllowedTeamIds: [],
      slackAllowedChannelIds: [],
      slackAllowedUserIds: [],
      unsafeAllowAllGithubUsersAndOrgs: false,
      githubApiBaseUrl: 'https://api.github.com',
      githubCloneBaseUrl: 'https://github.com',
      githubAllowedRepositories: [],
      githubAllowedUsers: [],
      githubAllowedOrganizations: [],
      githubTriggerHandles: [],
    });
  });

  it('parses supported run modes and providers', () => {
    expect(
      loadConfig({
        PORT: '4000',
        MAX_JSON_BODY_BYTES: '2048',
        RUN_CANCELLATION_POLL_INTERVAL_MS: '250',
        SANDBOX_IDLE_TIMEOUT_SECONDS: '120',
        SANDBOX_STOP_DELAY_SECONDS: '30',
        SANDBOX_RETENTION_SECONDS: '240',
        RUN_MODE: 'worker',
        RUNNER: 'flue',
        SANDBOX_PROVIDER: 'local',
        LOCAL_SANDBOX_ALLOWED_COMMANDS: 'git,node,pnpm',
        APP_STORE: 'postgres',
        API_AUTH_MODE: 'session',
        API_BEARER_TOKEN: 'api-token',
        AUTH_STATIC_USERNAME: 'dev',
        AUTH_STATIC_PASSWORD: 'password',
        AUTH_SESSION_SECRET: 'session-secret',
        AUTH_COOKIE_SECURE: 'true',
        DATABASE_URL: 'postgres://example',
        FLUE_MODEL: 'anthropic/claude-haiku-4-5',
        FLUE_SESSION_STORE: 'memory',
        DAYTONA_API_KEY: 'daytona-key',
        DAYTONA_API_URL: 'https://daytona.example',
        DAYTONA_TARGET: 'eu',
        DAYTONA_IMAGE: 'ubuntu:latest',
        DAYTONA_SNAPSHOT: 'snap-1',
        SLACK_API_BASE_URL: 'https://slack.emulate.localhost/api',
        SLACK_SIGNING_SECRET: 'slack-secret',
        SLACK_BOT_TOKEN: 'xoxb-token',
        SLACK_ALLOWED_TEAM_IDS: 'T123, T456',
        SLACK_ALLOWED_CHANNEL_IDS: 'C123,C456',
        SLACK_ALLOWED_USER_IDS: 'U123, U456',
        UNSAFE_ALLOW_ALL_GITHUB_USERS_AND_ORGS: 'true',
        GITHUB_API_BASE_URL: 'https://github.emulate.localhost/api',
        GITHUB_CLONE_BASE_URL: 'https://github.emulate.localhost',
        GITHUB_APP_ID: '12345',
        GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----',
        GITHUB_WEBHOOK_SECRET: 'github-secret',
        GITHUB_ALLOWED_REPOSITORIES: 'acme/widget, octo/*',
        GITHUB_ALLOWED_USERS: 'octocat,hubot',
        GITHUB_ALLOWED_ORGANIZATIONS: 'acme,octo',
        GITHUB_TRIGGER_HANDLES: 'dev-deputies, @devdeputies',
      }),
    ).toMatchObject({
      port: 4000,
      maxJsonBodyBytes: 2048,
      runCancellationPollIntervalMs: 250,
      sandboxIdleTimeoutSeconds: 120,
      sandboxStopDelaySeconds: 30,
      sandboxRetentionSeconds: 240,
      runMode: 'worker',
      runner: 'flue',
      sandboxProvider: 'local',
      localSandboxAllowedCommands: ['git', 'node', 'pnpm'],
      appStore: 'postgres',
      apiAuthMode: 'session',
      apiBearerToken: 'api-token',
      authStaticUsername: 'dev',
      authStaticPassword: 'password',
      authSessionSecret: 'session-secret',
      authCookieSecure: true,
      databaseUrl: 'postgres://example',
      flueModel: 'anthropic/claude-haiku-4-5',
      flueSessionStore: 'memory',
      daytonaApiKey: 'daytona-key',
      daytonaApiUrl: 'https://daytona.example',
      daytonaTarget: 'eu',
      daytonaImage: 'ubuntu:latest',
      daytonaSnapshot: 'snap-1',
      slackApiBaseUrl: 'https://slack.emulate.localhost/api',
      slackSigningSecret: 'slack-secret',
      slackBotToken: 'xoxb-token',
      unsafeAllowAllSlackIds: false,
      slackAllowedTeamIds: ['T123', 'T456'],
      slackAllowedChannelIds: ['C123', 'C456'],
      slackAllowedUserIds: ['U123', 'U456'],
      unsafeAllowAllGithubUsersAndOrgs: true,
      githubApiBaseUrl: 'https://github.emulate.localhost/api',
      githubCloneBaseUrl: 'https://github.emulate.localhost',
      githubAppId: '12345',
      githubAppPrivateKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
      githubWebhookSecret: 'github-secret',
      githubAllowedRepositories: ['acme/widget', 'octo/*'],
      githubAllowedUsers: ['octocat', 'hubot'],
      githubAllowedOrganizations: ['acme', 'octo'],
      githubTriggerHandles: ['dev-deputies', '@devdeputies'],
    });
  });

  it('requires Slack allowlists unless unsafe allow-all is explicit', () => {
    expect(() => loadConfig({ SLACK_SIGNING_SECRET: 'slack-secret' })).toThrow('Slack allowlists are required');
    expect(loadConfig({ SLACK_SIGNING_SECRET: 'slack-secret', UNSAFE_ALLOW_ALL_SLACK_IDS: 'true' })).toMatchObject({
      slackSigningSecret: 'slack-secret',
      unsafeAllowAllSlackIds: true,
      slackAllowedTeamIds: [],
      slackAllowedChannelIds: [],
      slackAllowedUserIds: [],
    });
    expect(loadConfig({ SLACK_SIGNING_SECRET: 'slack-secret', SLACK_ALLOWED_TEAM_IDS: 'T123' })).toMatchObject({
      slackSigningSecret: 'slack-secret',
      unsafeAllowAllSlackIds: false,
      slackAllowedTeamIds: ['T123'],
    });
  });

  it('requires GitHub webhook allowlists unless unsafe allow-all is explicit', () => {
    expect(() => loadConfig({ GITHUB_WEBHOOK_SECRET: 'github-secret' })).toThrow('GitHub webhook allowlists are required');
    expect(() => loadConfig({ GITHUB_WEBHOOK_SECRET: 'github-secret', GITHUB_ALLOWED_USERS: 'octocat' })).toThrow('GITHUB_TRIGGER_HANDLES is required');
    expect(loadConfig({ GITHUB_WEBHOOK_SECRET: 'github-secret', UNSAFE_ALLOW_ALL_GITHUB_USERS_AND_ORGS: 'true', GITHUB_TRIGGER_HANDLES: 'dev-deputies' })).toMatchObject({
      githubWebhookSecret: 'github-secret',
      unsafeAllowAllGithubUsersAndOrgs: true,
      githubAllowedUsers: [],
      githubAllowedOrganizations: [],
      githubTriggerHandles: ['dev-deputies'],
    });
    expect(loadConfig({ GITHUB_WEBHOOK_SECRET: 'github-secret', GITHUB_ALLOWED_USERS: 'octocat', GITHUB_TRIGGER_HANDLES: 'dev-deputies' })).toMatchObject({
      githubWebhookSecret: 'github-secret',
      unsafeAllowAllGithubUsersAndOrgs: false,
      githubAllowedUsers: ['octocat'],
      githubTriggerHandles: ['dev-deputies'],
    });
    expect(loadConfig({ GITHUB_WEBHOOK_SECRET: 'github-secret', GITHUB_ALLOWED_ORGANIZATIONS: 'acme', GITHUB_TRIGGER_HANDLES: 'dev-deputies' })).toMatchObject({
      githubWebhookSecret: 'github-secret',
      unsafeAllowAllGithubUsersAndOrgs: false,
      githubAllowedOrganizations: ['acme'],
      githubTriggerHandles: ['dev-deputies'],
    });
  });

  it('rejects invalid ports', () => {
    expect(() => loadConfig({ PORT: 'nope' })).toThrow('PORT must be an integer');
  });

  it('rejects invalid body limits', () => {
    expect(() => loadConfig({ MAX_JSON_BODY_BYTES: '0' })).toThrow('MAX_JSON_BODY_BYTES must be a positive integer');
  });

  it('rejects invalid run cancellation poll intervals', () => {
    expect(() => loadConfig({ RUN_CANCELLATION_POLL_INTERVAL_MS: '0' })).toThrow('RUN_CANCELLATION_POLL_INTERVAL_MS must be a positive integer');
  });

  it('rejects invalid sandbox idle timeout', () => {
    expect(() => loadConfig({ SANDBOX_IDLE_TIMEOUT_SECONDS: '0' })).toThrow('SANDBOX_IDLE_TIMEOUT_SECONDS must be a positive integer');
  });

  it('rejects invalid sandbox retention', () => {
    expect(() => loadConfig({ SANDBOX_RETENTION_SECONDS: '0' })).toThrow('SANDBOX_RETENTION_SECONDS must be a positive integer');
  });

  it('rejects invalid sandbox stop delay', () => {
    expect(() => loadConfig({ SANDBOX_STOP_DELAY_SECONDS: '-1' })).toThrow('SANDBOX_STOP_DELAY_SECONDS must be a non-negative integer');
  });

  it('rejects invalid enum values', () => {
    expect(() => loadConfig({ RUN_MODE: 'cloudflare' })).toThrow('Expected one of all, api, worker');
  });

  it('rejects invalid boolean values', () => {
    expect(() => loadConfig({ AUTH_COOKIE_SECURE: 'yes' })).toThrow('AUTH_COOKIE_SECURE must be true or false');
    expect(() => loadConfig({ UNSAFE_ALLOW_ALL_SLACK_IDS: 'yes' })).toThrow('UNSAFE_ALLOW_ALL_SLACK_IDS must be true or false');
    expect(() => loadConfig({ UNSAFE_ALLOW_ALL_GITHUB_USERS_AND_ORGS: 'yes' })).toThrow('UNSAFE_ALLOW_ALL_GITHUB_USERS_AND_ORGS must be true or false');
  });
});
