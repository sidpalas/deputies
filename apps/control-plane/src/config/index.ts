export type RunMode = 'all' | 'api' | 'worker';
export type RunnerKind = 'fake' | 'flue';
export type SandboxProviderKind = 'fake' | 'unsafe-local' | 'docker' | 'daytona' | 'kubernetes' | 'ecs';
export type DockerOrchestratorMode = 'in-process' | 'http';
export type AppStoreKind = 'memory' | 'postgres';
export type ApiAuthMode = 'none' | 'bearer' | 'session';
export type AuthProviderKind = 'static' | 'github';
export type AuthCookieSameSite = 'lax' | 'none';
export type ArtifactStorageKind = 'disabled' | 'filesystem' | 's3';

export type AppConfig = {
  port: number;
  maxJsonBodyBytes: number;
  runCancellationPollIntervalMs: number;
  workerConcurrency: number;
  workerPollIntervalMs: number;
  sandboxIdleTimeoutMs: number;
  sandboxStopDelayMs: number;
  sandboxRetentionMs: number;
  sandboxKeepaliveMaxExtensionMs: number;
  runMode: RunMode;
  runner: RunnerKind;
  sandboxProvider: SandboxProviderKind;
  localSandboxAllowedCommands: string[];
  dockerOrchestratorMode: DockerOrchestratorMode;
  dockerOrchestratorUrl?: string;
  dockerOrchestratorToken?: string;
  dockerSandboxImage: string;
  dockerSandboxWorkspacePath: string;
  dockerSandboxBridgeHost: string;
  dockerSandboxNetwork?: string;
  dockerSandboxMemory?: string;
  dockerSandboxCpus?: string;
  dockerCliTimeoutMs: number;
  appStore: AppStoreKind;
  apiAuthMode: ApiAuthMode;
  apiBearerToken?: string;
  authProvider: AuthProviderKind;
  authStaticUsername?: string;
  authStaticPassword?: string;
  authSessionSecret?: string;
  authCookieSecure: boolean;
  authCookieSameSite: AuthCookieSameSite;
  authCookieDomain?: string;
  authSuccessRedirectUrl?: string;
  webBaseUrl?: string;
  previewBaseDomain?: string;
  previewTrustForwardedHosts: boolean;
  githubAppClientId?: string;
  githubAppClientSecret?: string;
  githubAppCallbackUrl?: string;
  githubOAuthBaseUrl: string;
  authGithubAllowedUsers: string[];
  authGithubAllowedOrganizations: string[];
  databaseUrl?: string;
  flueSessionStore: 'postgres' | 'memory';
  flueModel?: string;
  flueOpenaiCodexAuthFile?: string;
  flueOpenaiCodexAuthJson?: string;
  flueOpenaiCodexAuthBase64?: string;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  daytonaImage?: string;
  daytonaSnapshot?: string;
  slackApiBaseUrl: string;
  slackSigningSecret?: string;
  slackBotToken?: string;
  unsafeAllowAllSlackIds: boolean;
  slackAllowedTeamIds: string[];
  slackAllowedChannelIds: string[];
  slackAllowedUserIds: string[];
  unsafeAllowAllGithubUsersAndOrgs: boolean;
  githubApiBaseUrl: string;
  githubCloneBaseUrl: string;
  githubAllowedRepositories: string[];
  githubAllowedUsers: string[];
  githubAllowedOrganizations: string[];
  githubTriggerPhrases: string[];
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubWebhookSecret?: string;
  artifactStorage: ArtifactStorageKind;
  artifactStorageFilesystemPath?: string;
  artifactStorageS3Endpoint?: string;
  artifactStorageS3Region: string;
  artifactStorageS3Bucket?: string;
  artifactStorageS3AccessKeyId?: string;
  artifactStorageS3SecretAccessKey?: string;
  artifactStorageS3ForcePathStyle: boolean;
  artifactStorageS3CreateBucket: boolean;
  artifactToolMaxBytes: number;
  unsafeAllowLocalHttpCallbacks: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const config: AppConfig = {
    port: parsePort(env.PORT),
    maxJsonBodyBytes: parsePositiveInteger(env.MAX_JSON_BODY_BYTES, 1_048_576, 'MAX_JSON_BODY_BYTES'),
    runCancellationPollIntervalMs: parsePositiveInteger(
      env.RUN_CANCELLATION_POLL_INTERVAL_MS,
      1_000,
      'RUN_CANCELLATION_POLL_INTERVAL_MS',
    ),
    workerConcurrency: parsePositiveInteger(env.WORKER_CONCURRENCY, 4, 'WORKER_CONCURRENCY'),
    workerPollIntervalMs: parsePositiveInteger(env.WORKER_POLL_INTERVAL_MS, 1_000, 'WORKER_POLL_INTERVAL_MS'),
    sandboxIdleTimeoutMs:
      parsePositiveInteger(env.SANDBOX_IDLE_TIMEOUT_SECONDS, 900, 'SANDBOX_IDLE_TIMEOUT_SECONDS') * 1000,
    sandboxStopDelayMs:
      parseNonNegativeInteger(env.SANDBOX_STOP_DELAY_SECONDS, 60, 'SANDBOX_STOP_DELAY_SECONDS') * 1000,
    sandboxRetentionMs: parsePositiveInteger(env.SANDBOX_RETENTION_SECONDS, 3600, 'SANDBOX_RETENTION_SECONDS') * 1000,
    sandboxKeepaliveMaxExtensionMs:
      parsePositiveInteger(env.SANDBOX_KEEPALIVE_MAX_EXTENSION_SECONDS, 7200, 'SANDBOX_KEEPALIVE_MAX_EXTENSION_SECONDS') *
      1000,
    runMode: parseEnum(env.RUN_MODE, ['all', 'api', 'worker'], 'all'),
    runner: parseEnum(env.RUNNER, ['fake', 'flue'], 'fake'),
    sandboxProvider: parseEnum(
      env.SANDBOX_PROVIDER,
      ['fake', 'unsafe-local', 'docker', 'daytona', 'kubernetes', 'ecs'],
      'fake',
    ),
    localSandboxAllowedCommands: parseStringList(env.LOCAL_SANDBOX_ALLOWED_COMMANDS),
    dockerOrchestratorMode: parseEnum(env.DOCKER_ORCHESTRATOR_MODE, ['in-process', 'http'], 'in-process'),
    dockerSandboxImage: env.DOCKER_SANDBOX_IMAGE ?? 'deputies-sandbox:local',
    dockerSandboxWorkspacePath: env.DOCKER_SANDBOX_WORKSPACE_PATH ?? '/workspace',
    dockerSandboxBridgeHost: env.DOCKER_SANDBOX_BRIDGE_HOST ?? '127.0.0.1',
    dockerCliTimeoutMs: parsePositiveInteger(env.DOCKER_CLI_TIMEOUT_MS, 30_000, 'DOCKER_CLI_TIMEOUT_MS'),
    appStore: parseEnum(env.APP_STORE, ['memory', 'postgres'], 'memory'),
    apiAuthMode: parseRequiredEnum(env.API_AUTH_MODE, ['none', 'bearer', 'session'], 'API_AUTH_MODE'),
    authProvider: parseEnum(env.AUTH_PROVIDER, ['static', 'github'], 'static'),
    authCookieSecure: parseBoolean(env.AUTH_COOKIE_SECURE, false, 'AUTH_COOKIE_SECURE'),
    authCookieSameSite: parseEnum(env.AUTH_COOKIE_SAME_SITE, ['lax', 'none'], 'lax'),
    previewTrustForwardedHosts: parseBoolean(env.PREVIEW_TRUST_FORWARDED_HOSTS, false, 'PREVIEW_TRUST_FORWARDED_HOSTS'),
    githubOAuthBaseUrl: env.GITHUB_OAUTH_BASE_URL ?? 'https://github.com',
    authGithubAllowedUsers: parseStringList(env.AUTH_GITHUB_ALLOWED_USERS),
    authGithubAllowedOrganizations: parseStringList(env.AUTH_GITHUB_ALLOWED_ORGANIZATIONS),
    flueSessionStore: parseEnum(env.FLUE_SESSION_STORE, ['postgres', 'memory'], 'postgres'),
    slackApiBaseUrl: env.SLACK_API_BASE_URL ?? 'https://slack.com/api',
    unsafeAllowAllSlackIds: parseBoolean(env.UNSAFE_ALLOW_ALL_SLACK_IDS, false, 'UNSAFE_ALLOW_ALL_SLACK_IDS'),
    slackAllowedTeamIds: parseStringList(env.SLACK_ALLOWED_TEAM_IDS),
    slackAllowedChannelIds: parseStringList(env.SLACK_ALLOWED_CHANNEL_IDS),
    slackAllowedUserIds: parseStringList(env.SLACK_ALLOWED_USER_IDS),
    unsafeAllowAllGithubUsersAndOrgs: parseBoolean(
      env.UNSAFE_ALLOW_ALL_GITHUB_USERS_AND_ORGS,
      false,
      'UNSAFE_ALLOW_ALL_GITHUB_USERS_AND_ORGS',
    ),
    githubApiBaseUrl: env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
    githubCloneBaseUrl: env.GITHUB_CLONE_BASE_URL ?? 'https://github.com',
    githubAllowedRepositories: parseStringList(env.GITHUB_ALLOWED_REPOSITORIES),
    githubAllowedUsers: parseStringList(env.GITHUB_ALLOWED_USERS),
    githubAllowedOrganizations: parseStringList(env.GITHUB_ALLOWED_ORGANIZATIONS),
    githubTriggerPhrases: parseStringList(env.GITHUB_TRIGGER_PHRASES),
    artifactStorage: parseEnum(env.ARTIFACT_STORAGE_PROVIDER, ['disabled', 'filesystem', 's3'], 'disabled'),
    artifactStorageS3Region: env.ARTIFACT_STORAGE_S3_REGION ?? 'us-east-1',
    artifactStorageS3ForcePathStyle: parseBoolean(
      env.ARTIFACT_STORAGE_S3_FORCE_PATH_STYLE,
      true,
      'ARTIFACT_STORAGE_S3_FORCE_PATH_STYLE',
    ),
    artifactStorageS3CreateBucket: parseBoolean(
      env.ARTIFACT_STORAGE_S3_CREATE_BUCKET,
      false,
      'ARTIFACT_STORAGE_S3_CREATE_BUCKET',
    ),
    artifactToolMaxBytes: parsePositiveInteger(
      env.ARTIFACT_TOOL_MAX_BYTES,
      25 * 1024 * 1024,
      'ARTIFACT_TOOL_MAX_BYTES',
    ),
    unsafeAllowLocalHttpCallbacks: parseBoolean(
      env.UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS,
      false,
      'UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS',
    ),
  };

  if (env.API_BEARER_TOKEN) config.apiBearerToken = env.API_BEARER_TOKEN;
  if (env.AUTH_STATIC_USERNAME) config.authStaticUsername = env.AUTH_STATIC_USERNAME;
  if (env.AUTH_STATIC_PASSWORD) config.authStaticPassword = env.AUTH_STATIC_PASSWORD;
  if (env.AUTH_SESSION_SECRET) config.authSessionSecret = env.AUTH_SESSION_SECRET;
  if (env.AUTH_COOKIE_DOMAIN) config.authCookieDomain = env.AUTH_COOKIE_DOMAIN;
  if (env.AUTH_SUCCESS_REDIRECT_URL) config.authSuccessRedirectUrl = env.AUTH_SUCCESS_REDIRECT_URL;
  if (env.WEB_BASE_URL) config.webBaseUrl = env.WEB_BASE_URL;
  if (env.PREVIEW_BASE_DOMAIN) config.previewBaseDomain = env.PREVIEW_BASE_DOMAIN;
  if (env.GITHUB_APP_CLIENT_ID) config.githubAppClientId = env.GITHUB_APP_CLIENT_ID;
  if (env.GITHUB_APP_CLIENT_SECRET) config.githubAppClientSecret = env.GITHUB_APP_CLIENT_SECRET;
  if (env.GITHUB_APP_CALLBACK_URL) config.githubAppCallbackUrl = env.GITHUB_APP_CALLBACK_URL;
  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
  if (env.FLUE_MODEL) config.flueModel = env.FLUE_MODEL;
  if (env.FLUE_OPENAI_CODEX_AUTH_FILE) config.flueOpenaiCodexAuthFile = env.FLUE_OPENAI_CODEX_AUTH_FILE;
  if (env.FLUE_OPENAI_CODEX_AUTH_JSON) config.flueOpenaiCodexAuthJson = env.FLUE_OPENAI_CODEX_AUTH_JSON;
  if (env.FLUE_OPENAI_CODEX_AUTH_BASE64) config.flueOpenaiCodexAuthBase64 = env.FLUE_OPENAI_CODEX_AUTH_BASE64;
  if (env.DOCKER_ORCHESTRATOR_URL) config.dockerOrchestratorUrl = env.DOCKER_ORCHESTRATOR_URL;
  if (env.DOCKER_ORCHESTRATOR_TOKEN) config.dockerOrchestratorToken = env.DOCKER_ORCHESTRATOR_TOKEN;
  if (env.DOCKER_SANDBOX_NETWORK) config.dockerSandboxNetwork = env.DOCKER_SANDBOX_NETWORK;
  if (env.DOCKER_SANDBOX_MEMORY) config.dockerSandboxMemory = env.DOCKER_SANDBOX_MEMORY;
  if (env.DOCKER_SANDBOX_CPUS) config.dockerSandboxCpus = env.DOCKER_SANDBOX_CPUS;
  if (env.DAYTONA_API_KEY) config.daytonaApiKey = env.DAYTONA_API_KEY;
  if (env.DAYTONA_API_URL) config.daytonaApiUrl = env.DAYTONA_API_URL;
  if (env.DAYTONA_TARGET) config.daytonaTarget = env.DAYTONA_TARGET;
  if (env.DAYTONA_IMAGE) config.daytonaImage = env.DAYTONA_IMAGE;
  if (env.DAYTONA_SNAPSHOT) config.daytonaSnapshot = env.DAYTONA_SNAPSHOT;
  if (env.SLACK_SIGNING_SECRET) config.slackSigningSecret = env.SLACK_SIGNING_SECRET;
  if (env.SLACK_BOT_TOKEN) config.slackBotToken = env.SLACK_BOT_TOKEN;
  if (env.GITHUB_APP_ID) config.githubAppId = env.GITHUB_APP_ID;
  if (env.GITHUB_APP_PRIVATE_KEY) config.githubAppPrivateKey = normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  if (env.GITHUB_WEBHOOK_SECRET) config.githubWebhookSecret = env.GITHUB_WEBHOOK_SECRET;
  if (env.ARTIFACT_STORAGE_FILESYSTEM_PATH) config.artifactStorageFilesystemPath = env.ARTIFACT_STORAGE_FILESYSTEM_PATH;
  if (env.ARTIFACT_STORAGE_S3_ENDPOINT) config.artifactStorageS3Endpoint = env.ARTIFACT_STORAGE_S3_ENDPOINT;
  if (env.ARTIFACT_STORAGE_S3_BUCKET) config.artifactStorageS3Bucket = env.ARTIFACT_STORAGE_S3_BUCKET;
  if (env.ARTIFACT_STORAGE_S3_ACCESS_KEY_ID)
    config.artifactStorageS3AccessKeyId = env.ARTIFACT_STORAGE_S3_ACCESS_KEY_ID;
  if (env.ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY)
    config.artifactStorageS3SecretAccessKey = env.ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY;

  validateProductAuthConfig(config);
  validateArtifactStorageConfig(config);

  if (config.slackSigningSecret && !config.unsafeAllowAllSlackIds && !hasAnySlackAllowlist(config)) {
    throw new Error(
      'Slack allowlists are required when SLACK_SIGNING_SECRET is set. Configure SLACK_ALLOWED_TEAM_IDS, SLACK_ALLOWED_CHANNEL_IDS, or SLACK_ALLOWED_USER_IDS, or set UNSAFE_ALLOW_ALL_SLACK_IDS=true for unrestricted Slack access.',
    );
  }
  if (config.githubWebhookSecret && !config.unsafeAllowAllGithubUsersAndOrgs && !hasAnyGitHubWebhookAllowlist(config)) {
    throw new Error(
      'GitHub webhook allowlists are required when GITHUB_WEBHOOK_SECRET is set. Configure GITHUB_ALLOWED_USERS or GITHUB_ALLOWED_ORGANIZATIONS, or set UNSAFE_ALLOW_ALL_GITHUB_USERS_AND_ORGS=true for unrestricted GitHub webhook access.',
    );
  }
  if (config.githubWebhookSecret && !config.githubTriggerPhrases.length) {
    throw new Error(
      'GITHUB_TRIGGER_PHRASES is required when GITHUB_WEBHOOK_SECRET is set so GitHub webhooks only process explicitly triggered requests.',
    );
  }

  return config;
}

function validateArtifactStorageConfig(config: AppConfig): void {
  if (config.artifactStorage === 'filesystem' && !config.artifactStorageFilesystemPath) {
    throw new Error('ARTIFACT_STORAGE_FILESYSTEM_PATH is required when ARTIFACT_STORAGE_PROVIDER=filesystem');
  }

  if (config.artifactStorage !== 's3') return;
  if (!config.artifactStorageS3Bucket) {
    throw new Error('ARTIFACT_STORAGE_S3_BUCKET is required when ARTIFACT_STORAGE_PROVIDER=s3');
  }
  if (!config.artifactStorageS3AccessKeyId || !config.artifactStorageS3SecretAccessKey) {
    throw new Error(
      'ARTIFACT_STORAGE_S3_ACCESS_KEY_ID and ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY are required when ARTIFACT_STORAGE_PROVIDER=s3',
    );
  }
}

function validateProductAuthConfig(config: AppConfig): void {
  if (config.apiAuthMode === 'bearer') {
    requireApiBearerToken(config);
    return;
  }

  if (config.apiAuthMode !== 'session') return;

  requireAuthSessionSecret(config);
  if (config.authProvider === 'static') {
    requireStaticCredentials(config);
    return;
  }

  requireGitHubOAuthCredentials(config);
}

function hasAnySlackAllowlist(
  config: Pick<AppConfig, 'slackAllowedTeamIds' | 'slackAllowedChannelIds' | 'slackAllowedUserIds'>,
): boolean {
  return Boolean(
    config.slackAllowedTeamIds.length || config.slackAllowedChannelIds.length || config.slackAllowedUserIds.length,
  );
}

function hasAnyGitHubWebhookAllowlist(
  config: Pick<AppConfig, 'githubAllowedUsers' | 'githubAllowedOrganizations'>,
): boolean {
  return Boolean(config.githubAllowedUsers.length || config.githubAllowedOrganizations.length);
}

export function requireApiBearerToken(config: AppConfig): string {
  if (!config.apiBearerToken) {
    throw new Error('API_BEARER_TOKEN is required when API_AUTH_MODE=bearer');
  }

  return config.apiBearerToken;
}

export function requireAuthSessionSecret(config: AppConfig): string {
  if (!config.authSessionSecret) {
    throw new Error('AUTH_SESSION_SECRET is required when API_AUTH_MODE=session');
  }

  return config.authSessionSecret;
}

export function requireGitHubOAuthCredentials(config: AppConfig): { clientId: string; clientSecret: string } {
  if (!config.githubAppClientId || !config.githubAppClientSecret) {
    throw new Error('GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET are required when AUTH_PROVIDER=github');
  }

  return { clientId: config.githubAppClientId, clientSecret: config.githubAppClientSecret };
}

export function requireStaticCredentials(config: AppConfig): { username: string; password: string } {
  if (!config.authStaticUsername || !config.authStaticPassword) {
    throw new Error('AUTH_STATIC_USERNAME and AUTH_STATIC_PASSWORD are required when API_AUTH_MODE=session');
  }

  return { username: config.authStaticUsername, password: config.authStaticPassword };
}

export function requireDaytonaApiKey(config: AppConfig): string {
  if (!config.daytonaApiKey) {
    throw new Error('DAYTONA_API_KEY is required when SANDBOX_PROVIDER=daytona');
  }

  return config.daytonaApiKey;
}

export function requireDockerOrchestratorUrl(config: AppConfig): string {
  if (!config.dockerOrchestratorUrl) {
    throw new Error('DOCKER_ORCHESTRATOR_URL is required when DOCKER_ORCHESTRATOR_MODE=http');
  }

  return config.dockerOrchestratorUrl;
}

export function requireFlueModel(config: AppConfig): string {
  if (!config.flueModel) {
    throw new Error('FLUE_MODEL is required when RUNNER=flue');
  }

  return config.flueModel;
}

export function requireDatabaseUrl(config: AppConfig): string {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required when APP_STORE=postgres');
  }

  return config.databaseUrl;
}

export function requireSlackSigningSecret(config: AppConfig): string {
  if (!config.slackSigningSecret) {
    throw new Error('SLACK_SIGNING_SECRET is required for Slack webhooks');
  }

  return config.slackSigningSecret;
}

export function requireGitHubAppCredentials(config: AppConfig): { appId: string; privateKey: string } {
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required for GitHub App runtime access');
  }

  return { appId: config.githubAppId, privateKey: config.githubAppPrivateKey };
}

function parsePort(value: string | undefined): number {
  if (!value) return 3583;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${value}"`);
  }

  return port;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, received "${value}"`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, received "${value}"`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false, received "${value}"`);
}

function parseStringList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, '\n');
}

function parseEnum<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T[number];

  throw new Error(`Expected one of ${allowed.join(', ')}, received "${value}"`);
}

function parseRequiredEnum<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  name: string,
): T[number] {
  if (!value) throw new Error(`${name} is required. Expected one of ${allowed.join(', ')}`);
  return parseEnum(value, allowed, allowed[0]!);
}
