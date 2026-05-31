import { loadConfig } from '../../src/config/index.js';

describe('loadConfig', () => {
  it('requires API_AUTH_MODE to be explicit', () => {
    expect(() => loadConfig({})).toThrow('API_AUTH_MODE is required');
  });

  it('uses portable defaults when auth is explicitly disabled for local development and tests', () => {
    expect(loadConfig({ API_AUTH_MODE: 'none' })).toEqual({
      port: 3583,
      maxJsonBodyBytes: 1048576,
      runCancellationPollIntervalMs: 1000,
      workerConcurrency: 4,
      workerPollIntervalMs: 1000,
      sandboxIdleTimeoutMs: 900_000,
      sandboxStopDelayMs: 60_000,
      sandboxRetentionMs: 3_600_000,
      sandboxKeepaliveMaxExtensionMs: 7_200_000,
      sandboxWorkspacePath: '/workspace',
      runMode: 'combined',
      runner: 'fake',
      sandboxProvider: 'fake',
      localSandboxAllowedCommands: [],
      dockerOrchestratorMode: 'in-process',
      dockerSandboxImage: 'deputies-sandbox:local',
      dockerSandboxBridgeHost: '127.0.0.1',
      dockerCliTimeoutMs: 30_000,
      agentSandboxOrchestratorMode: 'in-process',
      agentSandboxImage: 'ghcr.io/sidpalas/deputies-docker-sandbox:sha-ac8a459',
      agentSandboxStorageSize: '1Gi',
      appDataStore: 'memory',
      apiAuthMode: 'none',
      authProvider: 'static',
      authCookieSecure: false,
      authCookieSameSite: 'lax',
      serviceTrustForwardedHosts: false,
      githubOAuthBaseUrl: 'https://github.com',
      authGithubAdminUsers: [],
      authGithubAdminOrganizations: [],
      authGithubViewerUsers: [],
      authGithubViewerOrganizations: [],
      unsafeAuthGithubAllowAllViewers: false,
      flueStateStore: 'postgres',
      flueModelOptions: [],
      slackApiBaseUrl: 'https://slack.com/api',
      unsafeSlackWebhookAllowAllIds: false,
      slackAllowedTeamIds: [],
      slackAllowedChannelIds: [],
      slackAllowedUserIds: [],
      unsafeGithubWebhookAllowAllUsersAndOrgs: false,
      githubApiBaseUrl: 'https://api.github.com',
      githubCloneBaseUrl: 'https://github.com',
      githubAllowedRepositories: [],
      githubWebhookAllowedUsers: [],
      githubWebhookAllowedOrganizations: [],
      githubWebhookTriggerPhrases: [],
      artifactStorage: 'disabled',
      artifactStorageS3Region: 'us-east-1',
      artifactStorageS3ForcePathStyle: true,
      artifactStorageS3CreateBucket: false,
      artifactCreateMaxBytes: 26_214_400,
      unsafeAllowLocalHttpCallbacks: false,
      hideSetupPage: false,
    });
  });

  it('parses supported run modes and providers', () => {
    expect(loadConfig({ API_AUTH_MODE: 'none', RUN_MODE: 'all' }).runMode).toBe('all');

    expect(
      loadConfig({
        PORT: '4000',
        MAX_JSON_BODY_BYTES: '2048',
        RUN_CANCELLATION_POLL_INTERVAL_MS: '250',
        WORKER_CONCURRENCY: '3',
        WORKER_POLL_INTERVAL_MS: '60000',
        SANDBOX_IDLE_TIMEOUT_SECONDS: '120',
        SANDBOX_STOP_DELAY_SECONDS: '30',
        SANDBOX_RETENTION_SECONDS: '240',
        SANDBOX_KEEPALIVE_MAX_EXTENSION_SECONDS: '300',
        RUN_MODE: 'worker',
        RUNNER: 'flue',
        SANDBOX_PROVIDER: 'unsafe-local',
        LOCAL_SANDBOX_ALLOWED_COMMANDS: 'git,node,pnpm',
        DOCKER_ORCHESTRATOR_MODE: 'http',
        DOCKER_ORCHESTRATOR_URL: 'https://docker-orchestrator.example',
        DOCKER_ORCHESTRATOR_TOKEN: 'docker-token',
        DOCKER_SANDBOX_IMAGE: 'deputies-sandbox:test',
        SANDBOX_WORKSPACE_PATH: '/workspace/custom',
        DOCKER_SANDBOX_BRIDGE_HOST: 'docker-host.internal',
        DOCKER_SANDBOX_NETWORK: 'bridge',
        DOCKER_SANDBOX_MEMORY: '2g',
        DOCKER_SANDBOX_CPUS: '2',
        DOCKER_CLI_TIMEOUT_MS: '45000',
        AGENT_SANDBOX_ORCHESTRATOR_MODE: 'http',
        AGENT_SANDBOX_ORCHESTRATOR_URL: 'http://agent-sandbox-orchestrator:3587',
        AGENT_SANDBOX_ORCHESTRATOR_TOKEN: 'agent-sandbox-token',
        AGENT_SANDBOX_NAMESPACE: 'deputies-sandboxes',
        AGENT_SANDBOX_IMAGE: 'deputies-sandbox:k8s',
        AGENT_SANDBOX_STORAGE_SIZE: '20Gi',
        AGENT_SANDBOX_STORAGE_CLASS_NAME: 'standard',
        APP_DATA_STORE: 'postgres',
        API_AUTH_MODE: 'session',
        API_BEARER_TOKEN: 'api-token',
        AUTH_PROVIDER: 'github',
        AUTH_STATIC_USERNAME: 'dev',
        AUTH_STATIC_PASSWORD: 'password',
        AUTH_SESSION_SECRET: 'session-secret',
        AUTH_COOKIE_SECURE: 'true',
        AUTH_COOKIE_SAME_SITE: 'none',
        WEB_BASE_URL: 'https://deputies.example/app',
        AUTH_GITHUB_ADMIN_USERS: 'admin1, admin2',
        AUTH_GITHUB_ADMIN_ORGANIZATIONS: 'admins',
        AUTH_GITHUB_VIEWER_USERS: 'viewer1, viewer2',
        AUTH_GITHUB_VIEWER_ORGANIZATIONS: 'viewers',
        UNSAFE_AUTH_GITHUB_ALLOW_ALL_VIEWERS: 'true',
        DATABASE_URL: 'postgres://example',
        FLUE_MODEL: 'anthropic/claude-haiku-4-5',
        FLUE_OPENAI_CODEX_AUTH_FILE: '/tmp/pi-auth.json',
        FLUE_OPENAI_CODEX_AUTH_BASE64: 'eyJvcGVuYWktY29kZXgiOnsidHlwZSI6Im9hdXRoIn19',
        FLUE_STATE_STORE: 'memory',
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
        UNSAFE_GITHUB_WEBHOOK_ALLOW_ALL_USERS_AND_ORGS: 'true',
        GITHUB_API_BASE_URL: 'https://github.emulate.localhost/api',
        GITHUB_OAUTH_BASE_URL: 'https://github.example',
        GITHUB_CLONE_BASE_URL: 'https://github.emulate.localhost',
        GITHUB_APP_ID: '12345',
        GITHUB_OAUTH_CLIENT_ID: 'oauth-client',
        GITHUB_OAUTH_CLIENT_SECRET: 'oauth-secret',
        GITHUB_OAUTH_CALLBACK_URL: 'https://deputies.example/auth/oauth/github/callback',
        GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----',
        GITHUB_WEBHOOK_SECRET: 'github-secret',
        GITHUB_ALLOWED_REPOSITORIES: 'acme/widget, octo/*',
        GITHUB_WEBHOOK_ALLOWED_USERS: 'octocat,hubot',
        GITHUB_WEBHOOK_ALLOWED_ORGANIZATIONS: 'acme,octo',
        GITHUB_WEBHOOK_TRIGGER_PHRASES: '/deputies, deputies:, @acme/deputies',
        ARTIFACT_STORAGE_PROVIDER: 's3',
        ARTIFACT_STORAGE_S3_ENDPOINT: 'http://seaweedfs:8333',
        ARTIFACT_STORAGE_S3_REGION: 'local',
        ARTIFACT_STORAGE_S3_BUCKET: 'deputies-artifacts',
        ARTIFACT_STORAGE_S3_ACCESS_KEY_ID: 'seaweed',
        ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY: 'seaweed-secret',
        ARTIFACT_STORAGE_S3_FORCE_PATH_STYLE: 'false',
        ARTIFACT_STORAGE_S3_CREATE_BUCKET: 'true',
        ARTIFACT_CREATE_MAX_BYTES: '1024',
        UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS: 'true',
      }),
    ).toMatchObject({
      port: 4000,
      maxJsonBodyBytes: 2048,
      runCancellationPollIntervalMs: 250,
      workerConcurrency: 3,
      workerPollIntervalMs: 60_000,
      sandboxIdleTimeoutMs: 120_000,
      sandboxStopDelayMs: 30_000,
      sandboxRetentionMs: 240_000,
      sandboxKeepaliveMaxExtensionMs: 300_000,
      sandboxWorkspacePath: '/workspace/custom',
      runMode: 'worker',
      runner: 'flue',
      sandboxProvider: 'unsafe-local',
      localSandboxAllowedCommands: ['git', 'node', 'pnpm'],
      dockerOrchestratorMode: 'http',
      dockerOrchestratorUrl: 'https://docker-orchestrator.example',
      dockerOrchestratorToken: 'docker-token',
      dockerSandboxImage: 'deputies-sandbox:test',
      dockerSandboxBridgeHost: 'docker-host.internal',
      dockerSandboxNetwork: 'bridge',
      dockerSandboxMemory: '2g',
      dockerSandboxCpus: '2',
      dockerCliTimeoutMs: 45_000,
      agentSandboxOrchestratorMode: 'http',
      agentSandboxOrchestratorUrl: 'http://agent-sandbox-orchestrator:3587',
      agentSandboxOrchestratorToken: 'agent-sandbox-token',
      agentSandboxNamespace: 'deputies-sandboxes',
      agentSandboxImage: 'deputies-sandbox:k8s',
      agentSandboxStorageSize: '20Gi',
      agentSandboxStorageClassName: 'standard',
      appDataStore: 'postgres',
      apiAuthMode: 'session',
      apiBearerToken: 'api-token',
      authProvider: 'github',
      authStaticUsername: 'dev',
      authStaticPassword: 'password',
      authSessionSecret: 'session-secret',
      authCookieSecure: true,
      authCookieSameSite: 'none',
      webBaseUrl: 'https://deputies.example/app',
      authGithubAdminUsers: ['admin1', 'admin2'],
      authGithubAdminOrganizations: ['admins'],
      authGithubViewerUsers: ['viewer1', 'viewer2'],
      authGithubViewerOrganizations: ['viewers'],
      unsafeAuthGithubAllowAllViewers: true,
      databaseUrl: 'postgres://example',
      flueModel: 'anthropic/claude-haiku-4-5',
      flueOpenaiCodexAuthFile: '/tmp/pi-auth.json',
      flueOpenaiCodexAuthBase64: 'eyJvcGVuYWktY29kZXgiOnsidHlwZSI6Im9hdXRoIn19',
      flueStateStore: 'memory',
      daytonaApiKey: 'daytona-key',
      daytonaApiUrl: 'https://daytona.example',
      daytonaTarget: 'eu',
      daytonaImage: 'ubuntu:latest',
      daytonaSnapshot: 'snap-1',
      slackApiBaseUrl: 'https://slack.emulate.localhost/api',
      slackSigningSecret: 'slack-secret',
      slackBotToken: 'xoxb-token',
      unsafeSlackWebhookAllowAllIds: false,
      slackAllowedTeamIds: ['T123', 'T456'],
      slackAllowedChannelIds: ['C123', 'C456'],
      slackAllowedUserIds: ['U123', 'U456'],
      unsafeGithubWebhookAllowAllUsersAndOrgs: true,
      githubApiBaseUrl: 'https://github.emulate.localhost/api',
      githubOAuthBaseUrl: 'https://github.example',
      githubCloneBaseUrl: 'https://github.emulate.localhost',
      githubAppId: '12345',
      githubOAuthClientId: 'oauth-client',
      githubOAuthClientSecret: 'oauth-secret',
      githubOAuthCallbackUrl: 'https://deputies.example/auth/oauth/github/callback',
      githubAppPrivateKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
      githubWebhookSecret: 'github-secret',
      githubAllowedRepositories: ['acme/widget', 'octo/*'],
      githubWebhookAllowedUsers: ['octocat', 'hubot'],
      githubWebhookAllowedOrganizations: ['acme', 'octo'],
      githubWebhookTriggerPhrases: ['/deputies', 'deputies:', '@acme/deputies'],
      artifactStorage: 's3',
      artifactStorageS3Endpoint: 'http://seaweedfs:8333',
      artifactStorageS3Region: 'local',
      artifactStorageS3Bucket: 'deputies-artifacts',
      artifactStorageS3AccessKeyId: 'seaweed',
      artifactStorageS3SecretAccessKey: 'seaweed-secret',
      artifactStorageS3ForcePathStyle: false,
      artifactStorageS3CreateBucket: true,
      artifactCreateMaxBytes: 1024,
      unsafeAllowLocalHttpCallbacks: true,
    });
  });

  it.each(['docker', 'k8s-agent-sandbox'])(
    'requires an app secret encryption key for postgres-backed %s sandboxes',
    (provider) => {
      expect(() =>
        loadConfig({
          API_AUTH_MODE: 'none',
          APP_DATA_STORE: 'postgres',
          SANDBOX_PROVIDER: provider,
        }),
      ).toThrow('SANDBOX_SECRET_ENCRYPTION_KEY is required');
    },
  );

  it('requires URL and token for k8s-agent-sandbox HTTP orchestrator mode', () => {
    expect(() =>
      loadConfig({
        API_AUTH_MODE: 'none',
        SANDBOX_PROVIDER: 'k8s-agent-sandbox',
        AGENT_SANDBOX_ORCHESTRATOR_MODE: 'http',
      }),
    ).toThrow('AGENT_SANDBOX_ORCHESTRATOR_URL is required when AGENT_SANDBOX_ORCHESTRATOR_MODE=http');

    expect(() =>
      loadConfig({
        API_AUTH_MODE: 'none',
        SANDBOX_PROVIDER: 'k8s-agent-sandbox',
        AGENT_SANDBOX_ORCHESTRATOR_MODE: 'http',
        AGENT_SANDBOX_ORCHESTRATOR_URL: 'http://agent-sandbox-orchestrator:3587',
      }),
    ).toThrow('AGENT_SANDBOX_ORCHESTRATOR_TOKEN is required when AGENT_SANDBOX_ORCHESTRATOR_MODE=http');
  });

  it('allows the app secret placeholder locally but rejects it in production', () => {
    expect(() =>
      loadConfig({
        API_AUTH_MODE: 'none',
        APP_DATA_STORE: 'postgres',
        SANDBOX_PROVIDER: 'docker',
        SANDBOX_SECRET_ENCRYPTION_KEY: 'replace-with-random-sandbox-secret',
      }),
    ).not.toThrow();

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        API_AUTH_MODE: 'none',
        APP_DATA_STORE: 'postgres',
        SANDBOX_PROVIDER: 'docker',
        SANDBOX_SECRET_ENCRYPTION_KEY: 'replace-with-random-sandbox-secret',
      }),
    ).toThrow('SANDBOX_SECRET_ENCRYPTION_KEY must not use the .env.example placeholder in production');
  });

  it('validates artifact storage provider requirements', () => {
    expect(() => loadConfig({ API_AUTH_MODE: 'none', ARTIFACT_STORAGE_PROVIDER: 'filesystem' })).toThrow(
      'ARTIFACT_STORAGE_FILESYSTEM_PATH is required',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', ARTIFACT_STORAGE_PROVIDER: 's3' })).toThrow(
      'ARTIFACT_STORAGE_S3_BUCKET is required',
    );
    expect(() =>
      loadConfig({
        API_AUTH_MODE: 'none',
        ARTIFACT_STORAGE_PROVIDER: 's3',
        ARTIFACT_STORAGE_S3_BUCKET: 'artifacts',
      }),
    ).toThrow('ARTIFACT_STORAGE_S3_ACCESS_KEY_ID and ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY are required');
  });

  it('requires Slack allowlists unless unsafe allow-all is explicit', () => {
    expect(() => loadConfig({ API_AUTH_MODE: 'none', SLACK_SIGNING_SECRET: 'slack-secret' })).toThrow(
      'Slack allowlists are required',
    );
    expect(
      loadConfig({
        API_AUTH_MODE: 'none',
        SLACK_SIGNING_SECRET: 'slack-secret',
        UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS: 'true',
      }),
    ).toMatchObject({
      slackSigningSecret: 'slack-secret',
      unsafeSlackWebhookAllowAllIds: true,
      slackAllowedTeamIds: [],
      slackAllowedChannelIds: [],
      slackAllowedUserIds: [],
    });
    expect(
      loadConfig({ API_AUTH_MODE: 'none', SLACK_SIGNING_SECRET: 'slack-secret', SLACK_ALLOWED_TEAM_IDS: 'T123' }),
    ).toMatchObject({
      slackSigningSecret: 'slack-secret',
      unsafeSlackWebhookAllowAllIds: false,
      slackAllowedTeamIds: ['T123'],
    });
  });

  it('requires GitHub webhook allowlists unless unsafe allow-all is explicit', () => {
    expect(() => loadConfig({ API_AUTH_MODE: 'none', GITHUB_WEBHOOK_SECRET: 'github-secret' })).toThrow(
      'GitHub webhook allowlists are required',
    );
    expect(() =>
      loadConfig({
        API_AUTH_MODE: 'none',
        GITHUB_WEBHOOK_SECRET: 'github-secret',
        GITHUB_WEBHOOK_ALLOWED_USERS: 'octocat',
      }),
    ).toThrow('GITHUB_WEBHOOK_TRIGGER_PHRASES is required');
    expect(
      loadConfig({
        API_AUTH_MODE: 'none',
        GITHUB_WEBHOOK_SECRET: 'github-secret',
        UNSAFE_GITHUB_WEBHOOK_ALLOW_ALL_USERS_AND_ORGS: 'true',
        GITHUB_WEBHOOK_TRIGGER_PHRASES: 'deputies:',
      }),
    ).toMatchObject({
      githubWebhookSecret: 'github-secret',
      unsafeGithubWebhookAllowAllUsersAndOrgs: true,
      githubWebhookAllowedUsers: [],
      githubWebhookAllowedOrganizations: [],
      githubWebhookTriggerPhrases: ['deputies:'],
    });
    expect(
      loadConfig({
        API_AUTH_MODE: 'none',
        GITHUB_WEBHOOK_SECRET: 'github-secret',
        GITHUB_WEBHOOK_ALLOWED_USERS: 'octocat',
        GITHUB_WEBHOOK_TRIGGER_PHRASES: '/deputies',
      }),
    ).toMatchObject({
      githubWebhookSecret: 'github-secret',
      unsafeGithubWebhookAllowAllUsersAndOrgs: false,
      githubWebhookAllowedUsers: ['octocat'],
      githubWebhookTriggerPhrases: ['/deputies'],
    });
    expect(
      loadConfig({
        API_AUTH_MODE: 'none',
        GITHUB_WEBHOOK_SECRET: 'github-secret',
        GITHUB_WEBHOOK_ALLOWED_ORGANIZATIONS: 'acme',
        GITHUB_WEBHOOK_TRIGGER_PHRASES: '@acme/deputies',
      }),
    ).toMatchObject({
      githubWebhookSecret: 'github-secret',
      unsafeGithubWebhookAllowAllUsersAndOrgs: false,
      githubWebhookAllowedOrganizations: ['acme'],
      githubWebhookTriggerPhrases: ['@acme/deputies'],
    });
  });

  it('requires bearer auth credentials at startup', () => {
    expect(() => loadConfig({ API_AUTH_MODE: 'bearer' })).toThrow('API_BEARER_TOKEN is required');
    expect(loadConfig({ API_AUTH_MODE: 'bearer', API_BEARER_TOKEN: 'secret' })).toMatchObject({
      apiAuthMode: 'bearer',
      apiBearerToken: 'secret',
    });
  });

  it('requires static session auth credentials at startup', () => {
    expect(() => loadConfig({ API_AUTH_MODE: 'session' })).toThrow('AUTH_SESSION_SECRET is required');
    expect(() => loadConfig({ API_AUTH_MODE: 'session', AUTH_SESSION_SECRET: 'secret' })).toThrow(
      'AUTH_STATIC_USERNAME and AUTH_STATIC_PASSWORD are required',
    );
    expect(
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_PROVIDER: 'static',
        AUTH_SESSION_SECRET: 'secret',
        AUTH_STATIC_USERNAME: 'dev',
        AUTH_STATIC_PASSWORD: 'password',
      }),
    ).toMatchObject({
      apiAuthMode: 'session',
      authProvider: 'static',
      authSessionSecret: 'secret',
      authStaticUsername: 'dev',
      authStaticPassword: 'password',
    });
  });

  it('requires GitHub App session auth credentials at startup', () => {
    expect(() =>
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_PROVIDER: 'github',
        AUTH_SESSION_SECRET: 'secret',
      }),
    ).toThrow('GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are required');
    expect(
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_PROVIDER: 'github',
        AUTH_SESSION_SECRET: 'secret',
        GITHUB_OAUTH_CLIENT_ID: 'client-id',
        GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
      }),
    ).toMatchObject({
      apiAuthMode: 'session',
      authProvider: 'github',
      authSessionSecret: 'secret',
      githubOAuthClientId: 'client-id',
      githubOAuthClientSecret: 'client-secret',
    });
  });

  it('rejects invalid ports', () => {
    expect(() => loadConfig({ PORT: 'nope' })).toThrow('PORT must be an integer');
  });

  it('rejects invalid body limits', () => {
    expect(() => loadConfig({ MAX_JSON_BODY_BYTES: '0' })).toThrow('MAX_JSON_BODY_BYTES must be a positive integer');
  });

  it('rejects invalid run cancellation poll intervals', () => {
    expect(() => loadConfig({ RUN_CANCELLATION_POLL_INTERVAL_MS: '0' })).toThrow(
      'RUN_CANCELLATION_POLL_INTERVAL_MS must be a positive integer',
    );
  });

  it('rejects invalid worker poll intervals', () => {
    expect(() => loadConfig({ WORKER_POLL_INTERVAL_MS: '0' })).toThrow(
      'WORKER_POLL_INTERVAL_MS must be a positive integer',
    );
  });

  it('rejects invalid sandbox idle timeout', () => {
    expect(() => loadConfig({ SANDBOX_IDLE_TIMEOUT_SECONDS: '0' })).toThrow(
      'SANDBOX_IDLE_TIMEOUT_SECONDS must be a positive integer',
    );
  });

  it('rejects invalid sandbox retention', () => {
    expect(() => loadConfig({ SANDBOX_RETENTION_SECONDS: '0' })).toThrow(
      'SANDBOX_RETENTION_SECONDS must be a positive integer',
    );
  });

  it('rejects invalid sandbox stop delay', () => {
    expect(() => loadConfig({ SANDBOX_STOP_DELAY_SECONDS: '-1' })).toThrow(
      'SANDBOX_STOP_DELAY_SECONDS must be a non-negative integer',
    );
  });

  it('rejects invalid enum values', () => {
    expect(() => loadConfig({ RUN_MODE: 'cloudflare' })).toThrow('Expected one of combined, all, api, worker');
    expect(() => loadConfig({ API_AUTH_MODE: 'none', SANDBOX_PROVIDER: 'local' })).toThrow(
      'Expected one of fake, unsafe-local, docker, daytona, k8s-agent-sandbox, ecs',
    );
    expect(loadConfig({ API_AUTH_MODE: 'none', RUNNER: 'pi' }).runner).toBe('pi');
    expect(() => loadConfig({ API_AUTH_MODE: 'none', AUTH_COOKIE_SAME_SITE: 'strict' })).toThrow(
      'Expected one of lax, none',
    );
  });

  it('rejects invalid boolean values', () => {
    expect(() => loadConfig({ API_AUTH_MODE: 'none', AUTH_COOKIE_SECURE: 'yes' })).toThrow(
      'AUTH_COOKIE_SECURE must be true or false',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS: 'yes' })).toThrow(
      'UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS must be true or false',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', UNSAFE_GITHUB_WEBHOOK_ALLOW_ALL_USERS_AND_ORGS: 'yes' })).toThrow(
      'UNSAFE_GITHUB_WEBHOOK_ALLOW_ALL_USERS_AND_ORGS must be true or false',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', UNSAFE_AUTH_GITHUB_ALLOW_ALL_VIEWERS: 'yes' })).toThrow(
      'UNSAFE_AUTH_GITHUB_ALLOW_ALL_VIEWERS must be true or false',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS: 'yes' })).toThrow(
      'UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS must be true or false',
    );
  });
});
