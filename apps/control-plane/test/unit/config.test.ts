import { loadConfig, requireTensorlakeRegisteredImage } from '../../src/config/index.js';

describe('loadConfig', () => {
  it('requires API_AUTH_MODE to be explicit', () => {
    expect(() => loadConfig({})).toThrow('API_AUTH_MODE is required');
    expect(() => loadConfig({ RUN_MODE: 'api' })).toThrow('API_AUTH_MODE is required');
  });

  it('does not require API auth config in worker-only mode', () => {
    expect(loadConfig({ RUN_MODE: 'worker' })).toMatchObject({
      runMode: 'worker',
      apiAuthMode: 'none',
    });
    expect(
      loadConfig({
        RUN_MODE: 'worker',
        API_AUTH_MODE: 'session',
        AUTH_PROVIDER: 'github',
        AUTH_SESSION_SECRET: 'session-secret',
      }),
    ).toMatchObject({
      runMode: 'worker',
      apiAuthMode: 'session',
      authProvider: 'github',
      authSessionSecret: 'session-secret',
    });
  });

  it('does not require inbound webhook allowlists in worker-only mode', () => {
    expect(
      loadConfig({
        RUN_MODE: 'worker',
        SLACK_SIGNING_SECRET: 'slack-secret',
        GITHUB_WEBHOOK_SECRET: 'github-secret',
      }),
    ).toMatchObject({
      runMode: 'worker',
      slackSigningSecret: 'slack-secret',
      githubWebhookSecret: 'github-secret',
    });
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
      eventDeltaCompactionEnabled: true,
      eventDeltaCompactionRetentionMs: 86_400_000,
      eventDeltaCompactionIntervalMs: 60_000,
      eventDeltaCompactionBatchSize: 5_000,
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
      sessionCookieName: 'dev_deputies_session',
      previewCookieName: 'deputies_preview',
      serviceTrustForwardedHosts: false,
      githubOAuthBaseUrl: 'https://github.com',
      authGithubAdminUsers: [],
      authGithubAllowedUsers: [],
      authGithubAllowedOrganizations: [],
      authGithubDefaultGroupRole: 'member',
      unsafeAuthGithubAllowAll: false,
      runnerStateStore: 'postgres',
      runnerModelChoices: [],
      webSearchProvider: 'auto',
      webSearchMaxResults: 10,
      webSearchContentMaxChars: 5000,
      webSearchTimeoutMs: 10000,
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

  it('derives OpenCode Zen model choices from Pi catalog when OPENCODE_API_KEY is set', () => {
    expect(loadConfig({ API_AUTH_MODE: 'none', OPENCODE_API_KEY: 'opencode-key' }).runnerModelChoices).toEqual(
      expect.arrayContaining(['opencode/kimi-k2.6', 'opencode/claude-sonnet-4-6', 'opencode/gpt-5.5']),
    );
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
        EVENT_DELTA_COMPACTION_ENABLED: 'false',
        EVENT_DELTA_COMPACTION_RETENTION_SECONDS: '86400',
        EVENT_DELTA_COMPACTION_INTERVAL_SECONDS: '300',
        EVENT_DELTA_COMPACTION_BATCH_SIZE: '250',
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
        SESSION_COOKIE_NAME: 'inner_deputies_session',
        PREVIEW_COOKIE_NAME: 'inner-deputies-preview',
        WEB_BASE_URL: 'https://deputies.example/app',
        AUTH_GITHUB_ADMIN_USERS: 'admin1, admin2',
        AUTH_GITHUB_ALLOWED_USERS: 'user1, user2',
        AUTH_GITHUB_ALLOWED_ORGANIZATIONS: 'users',
        AUTH_GITHUB_DEFAULT_GROUP_ROLE: 'member',
        UNSAFE_AUTH_GITHUB_ALLOW_ALL: 'true',
        DATABASE_URL: 'postgres://example',
        RUNNER_MODEL_DEFAULT: 'anthropic/claude-haiku-4-5',
        OPENAI_CODEX_AUTH_FILE: '/tmp/pi-auth.json',
        OPENAI_CODEX_AUTH_BASE64: 'eyJvcGVuYWktY29kZXgiOnsidHlwZSI6Im9hdXRoIn19',
        RUNNER_STATE_STORE: 'memory',
        WEB_SEARCH_PROVIDER: 'brave',
        BRAVE_API_KEY: 'brave-key',
        WEB_SEARCH_MAX_RESULTS: '7',
        WEB_SEARCH_CONTENT_MAX_CHARS: '8000',
        WEB_SEARCH_TIMEOUT_MS: '12000',
        DAYTONA_API_KEY: 'daytona-key',
        DAYTONA_API_URL: 'https://daytona.example',
        DAYTONA_TARGET: 'eu',
        DAYTONA_IMAGE: 'ubuntu:latest',
        DAYTONA_SNAPSHOT: 'snap-1',
        DAYTONA_SANDBOX_CPU: '2',
        DAYTONA_SANDBOX_GPU: '1',
        DAYTONA_SANDBOX_MEMORY_GIB: '4',
        DAYTONA_SANDBOX_DISK_GIB: '10',
        TENSORLAKE_API_KEY: 'tensorlake-key',
        TENSORLAKE_REGISTERED_IMAGE: 'deputies-daytona-sandbox-ubuntu24-node24',
        TENSORLAKE_SANDBOX_CPU: '2',
        TENSORLAKE_SANDBOX_MEMORY_MB: '4096',
        TENSORLAKE_SANDBOX_DISK_MB: '20480',
        TENSORLAKE_ALLOW_INTERNET_ACCESS: 'false',
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
      eventDeltaCompactionEnabled: false,
      eventDeltaCompactionRetentionMs: 86_400_000,
      eventDeltaCompactionIntervalMs: 300_000,
      eventDeltaCompactionBatchSize: 250,
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
      sessionCookieName: 'inner_deputies_session',
      previewCookieName: 'inner-deputies-preview',
      webBaseUrl: 'https://deputies.example/app',
      authGithubAdminUsers: ['admin1', 'admin2'],
      authGithubAllowedUsers: ['user1', 'user2'],
      authGithubAllowedOrganizations: ['users'],
      authGithubDefaultGroupRole: 'member',
      unsafeAuthGithubAllowAll: true,
      databaseUrl: 'postgres://example',
      runnerModelDefault: 'anthropic/claude-haiku-4-5',
      openaiCodexAuthFile: '/tmp/pi-auth.json',
      openaiCodexAuthBase64: 'eyJvcGVuYWktY29kZXgiOnsidHlwZSI6Im9hdXRoIn19',
      runnerStateStore: 'memory',
      webSearchProvider: 'brave',
      webSearchBraveApiKey: 'brave-key',
      webSearchMaxResults: 7,
      webSearchContentMaxChars: 8000,
      webSearchTimeoutMs: 12000,
      daytonaApiKey: 'daytona-key',
      daytonaApiUrl: 'https://daytona.example',
      daytonaTarget: 'eu',
      daytonaImage: 'ubuntu:latest',
      daytonaSnapshot: 'snap-1',
      daytonaSandboxCpu: 2,
      daytonaSandboxGpu: 1,
      daytonaSandboxMemoryGiB: 4,
      daytonaSandboxDiskGiB: 10,
      tensorlakeApiKey: 'tensorlake-key',
      tensorlakeRegisteredImage: 'deputies-daytona-sandbox-ubuntu24-node24',
      tensorlakeSandboxCpu: 2,
      tensorlakeSandboxMemoryMb: 4096,
      tensorlakeSandboxDiskMb: 20480,
      tensorlakeAllowInternetAccess: false,
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

  it('rejects invalid Daytona sandbox resource values', () => {
    expect(() => loadConfig({ API_AUTH_MODE: 'none', DAYTONA_SANDBOX_CPU: '0' })).toThrow(
      'DAYTONA_SANDBOX_CPU must be a positive number',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', DAYTONA_SANDBOX_MEMORY_GIB: 'large' })).toThrow(
      'DAYTONA_SANDBOX_MEMORY_GIB must be a positive number',
    );
  });

  it('rejects invalid Tensorlake sandbox resource values', () => {
    expect(() => loadConfig({ API_AUTH_MODE: 'none', TENSORLAKE_SANDBOX_CPU: '0' })).toThrow(
      'TENSORLAKE_SANDBOX_CPU must be a positive number',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', TENSORLAKE_SANDBOX_MEMORY_MB: 'large' })).toThrow(
      'TENSORLAKE_SANDBOX_MEMORY_MB must be a positive integer',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', TENSORLAKE_ALLOW_INTERNET_ACCESS: 'sometimes' })).toThrow(
      'TENSORLAKE_ALLOW_INTERNET_ACCESS must be true or false',
    );
  });

  it('requires a registered Tensorlake image name for the Tensorlake provider', () => {
    expect(() =>
      requireTensorlakeRegisteredImage(
        loadConfig({ API_AUTH_MODE: 'none', SANDBOX_PROVIDER: 'tensorlake', TENSORLAKE_API_KEY: 'key' }),
      ),
    ).toThrow('TENSORLAKE_REGISTERED_IMAGE is required when SANDBOX_PROVIDER=tensorlake');

    expect(() =>
      requireTensorlakeRegisteredImage(
        loadConfig({
          API_AUTH_MODE: 'none',
          SANDBOX_PROVIDER: 'tensorlake',
          TENSORLAKE_API_KEY: 'key',
          TENSORLAKE_REGISTERED_IMAGE: 'ghcr.io/acme/image:tag',
        }),
      ),
    ).toThrow('TENSORLAKE_REGISTERED_IMAGE must be a registered Tensorlake image name/id');

    expect(
      requireTensorlakeRegisteredImage(
        loadConfig({
          API_AUTH_MODE: 'none',
          SANDBOX_PROVIDER: 'tensorlake',
          TENSORLAKE_API_KEY: 'key',
          TENSORLAKE_REGISTERED_IMAGE: 'deputies-sandbox',
        }),
      ),
    ).toBe('deputies-sandbox');
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

  it('configures web search provider settings', () => {
    expect(loadConfig({ API_AUTH_MODE: 'none', WEB_SEARCH_PROVIDER: 'disabled' })).toMatchObject({
      webSearchProvider: 'disabled',
    });
    expect(loadConfig({ API_AUTH_MODE: 'none', BRAVE_API_KEY: 'brave-key' })).toMatchObject({
      webSearchProvider: 'auto',
      webSearchBraveApiKey: 'brave-key',
    });
    expect(
      loadConfig({ API_AUTH_MODE: 'none', WEB_SEARCH_PROVIDER: 'brave', WEB_SEARCH_BRAVE_API_KEY: 'web-search-key' }),
    ).toMatchObject({
      webSearchProvider: 'brave',
      webSearchBraveApiKey: 'web-search-key',
    });
    expect(loadConfig({ API_AUTH_MODE: 'none', WEB_SEARCH_MAX_RESULTS: '50' }).webSearchMaxResults).toBe(20);
    expect(() => loadConfig({ API_AUTH_MODE: 'none', WEB_SEARCH_PROVIDER: 'brave' })).toThrow(
      'WEB_SEARCH_BRAVE_API_KEY or BRAVE_API_KEY is required',
    );
    expect(loadConfig({ RUN_MODE: 'api', API_AUTH_MODE: 'none', WEB_SEARCH_PROVIDER: 'brave' })).toMatchObject({
      runMode: 'api',
      webSearchProvider: 'brave',
    });
    expect(() => loadConfig({ RUN_MODE: 'worker', WEB_SEARCH_PROVIDER: 'brave' })).toThrow(
      'WEB_SEARCH_BRAVE_API_KEY or BRAVE_API_KEY is required',
    );
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

  it('rejects invalid cookie names', () => {
    expect(() => loadConfig({ API_AUTH_MODE: 'none', SESSION_COOKIE_NAME: 'bad name' })).toThrow(
      'SESSION_COOKIE_NAME must contain only letters, digits, hyphens, and underscores',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', PREVIEW_COOKIE_NAME: 'bad.name' })).toThrow(
      'PREVIEW_COOKIE_NAME must contain only letters, digits, hyphens, and underscores',
    );
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

  it('rejects invalid event delta compaction intervals', () => {
    expect(() => loadConfig({ EVENT_DELTA_COMPACTION_INTERVAL_SECONDS: '0' })).toThrow(
      'EVENT_DELTA_COMPACTION_INTERVAL_SECONDS must be a positive integer',
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
      'Expected one of fake, unsafe-local, docker, daytona, tensorlake, createos, k8s-agent-sandbox, ecs',
    );
    expect(loadConfig({ API_AUTH_MODE: 'none', RUNNER: 'pi' }).runner).toBe('pi');
    expect(() => loadConfig({ API_AUTH_MODE: 'none', AUTH_COOKIE_SAME_SITE: 'strict' })).toThrow(
      'Expected one of lax, none',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', AUTH_GITHUB_DEFAULT_GROUP_ROLE: 'owner' })).toThrow(
      'Expected one of viewer, member, admin',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', WEB_SEARCH_PROVIDER: 'bing' })).toThrow(
      'Expected one of disabled, auto, brave, duckduckgo',
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
    expect(() => loadConfig({ API_AUTH_MODE: 'none', UNSAFE_AUTH_GITHUB_ALLOW_ALL: 'yes' })).toThrow(
      'UNSAFE_AUTH_GITHUB_ALLOW_ALL must be true or false',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS: 'yes' })).toThrow(
      'UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS must be true or false',
    );
    expect(() => loadConfig({ API_AUTH_MODE: 'none', EVENT_DELTA_COMPACTION_ENABLED: 'yes' })).toThrow(
      'EVENT_DELTA_COMPACTION_ENABLED must be true or false',
    );
  });
});
