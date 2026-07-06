import { getModels, type KnownProvider } from '@earendil-works/pi-ai';
import { AMAZON_BEDROCK_INFERENCE_PROFILE_MODEL_IDS, AMAZON_BEDROCK_PROVIDER } from '../runner/bedrock.js';

export type RunMode = 'combined' | 'all' | 'api' | 'worker';
export type RunnerKind = 'fake' | 'flue' | 'pi';
export type SandboxProviderKind =
  | 'fake'
  | 'unsafe-local'
  | 'docker'
  | 'daytona'
  | 'tensorlake'
  | 'lambda-microvm'
  | 'k8s-agent-sandbox';
export type DockerOrchestratorMode = 'in-process' | 'http';
export type AgentSandboxOrchestratorMode = 'in-process' | 'http';
export type AppStoreKind = 'memory' | 'postgres';
export type ApiAuthMode = 'none' | 'bearer' | 'session';
export type AuthProviderKind = 'static' | 'github';
export type AuthCookieSameSite = 'lax' | 'none';
export type ArtifactStorageKind = 'disabled' | 'filesystem' | 's3';
export type AuthGithubDefaultGroupRole = 'viewer' | 'member' | 'admin';
export type WebSearchProviderKind = 'disabled' | 'auto' | 'brave' | 'duckduckgo';

const MODEL_PROVIDER_AUTH: Array<{ provider: KnownProvider; env: string[] }> = [
  {
    provider: AMAZON_BEDROCK_PROVIDER,
    env: [
      'AWS_PROFILE',
      'AWS_ACCESS_KEY_ID',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
    ],
  },
  { provider: 'anthropic', env: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] },
  { provider: 'openai', env: ['OPENAI_API_KEY'] },
  { provider: 'openai-codex', env: ['OPENAI_CODEX_AUTH_FILE', 'OPENAI_CODEX_AUTH_BASE64'] },
  { provider: 'opencode', env: ['OPENCODE_API_KEY'] },
];
const sandboxSecretEncryptionKeyPlaceholder = 'replace-with-random-sandbox-secret';

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
  sandboxWorkspacePath: string;
  eventDeltaCompactionEnabled: boolean;
  eventDeltaCompactionRetentionMs: number;
  eventDeltaCompactionIntervalMs: number;
  eventDeltaCompactionBatchSize: number;
  repositorySetupScriptEnabled: boolean;
  repositorySetupScriptTimeoutMs: number;
  runMode: RunMode;
  runner: RunnerKind;
  sandboxProvider: SandboxProviderKind;
  localSandboxAllowedCommands: string[];
  dockerOrchestratorMode: DockerOrchestratorMode;
  dockerOrchestratorUrl?: string;
  dockerOrchestratorToken?: string;
  dockerSandboxImage: string;
  dockerSandboxBridgeHost: string;
  dockerSandboxNetwork?: string;
  dockerSandboxMemory?: string;
  dockerSandboxCpus?: string;
  dockerCliTimeoutMs: number;
  agentSandboxOrchestratorMode: AgentSandboxOrchestratorMode;
  agentSandboxOrchestratorUrl?: string;
  agentSandboxOrchestratorToken?: string;
  agentSandboxNamespace?: string;
  agentSandboxImage: string;
  agentSandboxStorageSize: string;
  agentSandboxStorageClassName?: string;
  sandboxSecretEncryptionKey?: string;
  appDataStore: AppStoreKind;
  apiAuthMode: ApiAuthMode;
  apiBearerToken?: string;
  authProvider: AuthProviderKind;
  authStaticUsername?: string;
  authStaticPassword?: string;
  authSessionSecret?: string;
  authCookieSecure: boolean;
  authCookieSameSite: AuthCookieSameSite;
  sessionCookieName: string;
  previewCookieName: string;
  webBaseUrl?: string;
  serviceBaseDomain?: string;
  serviceTrustForwardedHosts: boolean;
  githubOAuthClientId?: string;
  githubOAuthClientSecret?: string;
  githubOAuthCallbackUrl?: string;
  githubOAuthBaseUrl: string;
  authGithubAdminUsers: string[];
  authGithubAllowedUsers: string[];
  authGithubAllowedOrganizations: string[];
  authGithubDefaultGroupRole: AuthGithubDefaultGroupRole;
  unsafeAuthGithubAllowAll: boolean;
  databaseUrl?: string;
  runnerStateStore: 'postgres' | 'memory';
  runnerModelDefault?: string;
  runnerModelChoices: string[];
  openaiCodexAuthFile?: string;
  openaiCodexAuthBase64?: string;
  webSearchProvider: WebSearchProviderKind;
  webSearchBraveApiKey?: string;
  webSearchMaxResults: number;
  webSearchContentMaxChars: number;
  webSearchTimeoutMs: number;
  fakeRunnerArtifact?: Record<string, unknown>;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  daytonaImage?: string;
  daytonaSnapshot?: string;
  daytonaSandboxCpu?: number;
  daytonaSandboxGpu?: number;
  daytonaSandboxMemoryGiB?: number;
  daytonaSandboxDiskGiB?: number;
  tensorlakeApiKey?: string;
  tensorlakeRegisteredImage?: string;
  tensorlakeSandboxCpu?: number;
  tensorlakeSandboxMemoryMb?: number;
  tensorlakeSandboxDiskMb?: number;
  tensorlakeAllowInternetAccess?: boolean;
  lambdaMicrovmRegion?: string;
  lambdaMicrovmImageIdentifier?: string;
  lambdaMicrovmImageVersion?: string;
  lambdaMicrovmExecutionRoleArn?: string;
  lambdaMicrovmIngressNetworkConnectors: string[];
  lambdaMicrovmEgressNetworkConnectors: string[];
  lambdaMicrovmMaximumDurationSeconds: number;
  lambdaMicrovmAuthTokenTtlMinutes: number;
  lambdaMicrovmBridgePort: number;
  lambdaMicrovmLogGroup?: string;
  slackApiBaseUrl: string;
  slackSigningSecret?: string;
  slackBotToken?: string;
  unsafeSlackWebhookAllowAllIds: boolean;
  slackAllowedTeamIds: string[];
  slackAllowedChannelIds: string[];
  slackAllowedUserIds: string[];
  unsafeGithubWebhookAllowAllUsersAndOrgs: boolean;
  githubApiBaseUrl: string;
  githubCloneBaseUrl: string;
  githubAllowedRepositories: string[];
  githubWebhookAllowedUsers: string[];
  githubWebhookAllowedOrganizations: string[];
  githubWebhookTriggerPhrases: string[];
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
  artifactCreateMaxBytes: number;
  unsafeAllowLocalHttpCallbacks: boolean;
  hideSetupPage: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const runMode = parseEnum(env.RUN_MODE, ['combined', 'all', 'api', 'worker'], 'combined');
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
      parsePositiveInteger(
        env.SANDBOX_KEEPALIVE_MAX_EXTENSION_SECONDS,
        7200,
        'SANDBOX_KEEPALIVE_MAX_EXTENSION_SECONDS',
      ) * 1000,
    sandboxWorkspacePath: env.SANDBOX_WORKSPACE_PATH ?? '/workspace',
    eventDeltaCompactionEnabled: parseBoolean(
      env.EVENT_DELTA_COMPACTION_ENABLED,
      true,
      'EVENT_DELTA_COMPACTION_ENABLED',
    ),
    eventDeltaCompactionRetentionMs:
      parsePositiveInteger(
        env.EVENT_DELTA_COMPACTION_RETENTION_SECONDS,
        24 * 60 * 60,
        'EVENT_DELTA_COMPACTION_RETENTION_SECONDS',
      ) * 1000,
    eventDeltaCompactionIntervalMs:
      parsePositiveInteger(env.EVENT_DELTA_COMPACTION_INTERVAL_SECONDS, 60, 'EVENT_DELTA_COMPACTION_INTERVAL_SECONDS') *
      1000,
    eventDeltaCompactionBatchSize: parsePositiveInteger(
      env.EVENT_DELTA_COMPACTION_BATCH_SIZE,
      5_000,
      'EVENT_DELTA_COMPACTION_BATCH_SIZE',
    ),
    repositorySetupScriptEnabled: parseBoolean(
      env.REPOSITORY_SETUP_SCRIPT_ENABLED,
      true,
      'REPOSITORY_SETUP_SCRIPT_ENABLED',
    ),
    repositorySetupScriptTimeoutMs:
      parsePositiveInteger(
        env.REPOSITORY_SETUP_SCRIPT_TIMEOUT_SECONDS,
        600,
        'REPOSITORY_SETUP_SCRIPT_TIMEOUT_SECONDS',
      ) * 1000,
    runMode,
    runner: parseEnum(env.RUNNER, ['fake', 'flue', 'pi'], 'fake'),
    sandboxProvider: parseEnum(
      env.SANDBOX_PROVIDER,
      ['fake', 'unsafe-local', 'docker', 'daytona', 'tensorlake', 'lambda-microvm', 'k8s-agent-sandbox'],
      'fake',
    ),
    localSandboxAllowedCommands: parseStringList(env.LOCAL_SANDBOX_ALLOWED_COMMANDS),
    dockerOrchestratorMode: parseEnum(env.DOCKER_ORCHESTRATOR_MODE, ['in-process', 'http'], 'in-process'),
    dockerSandboxImage: env.DOCKER_SANDBOX_IMAGE ?? 'deputies-sandbox:local',
    dockerSandboxBridgeHost: env.DOCKER_SANDBOX_BRIDGE_HOST ?? '127.0.0.1',
    dockerCliTimeoutMs: parsePositiveInteger(env.DOCKER_CLI_TIMEOUT_MS, 30_000, 'DOCKER_CLI_TIMEOUT_MS'),
    agentSandboxOrchestratorMode: parseEnum(env.AGENT_SANDBOX_ORCHESTRATOR_MODE, ['in-process', 'http'], 'in-process'),
    agentSandboxImage: env.AGENT_SANDBOX_IMAGE ?? 'ghcr.io/sidpalas/deputies-docker-sandbox:sha-ac8a459',
    agentSandboxStorageSize: env.AGENT_SANDBOX_STORAGE_SIZE ?? '1Gi',
    appDataStore: parseEnum(env.APP_DATA_STORE, ['memory', 'postgres'], 'memory'),
    apiAuthMode: runModeStartsApi(runMode)
      ? parseRequiredEnum(env.API_AUTH_MODE, ['none', 'bearer', 'session'], 'API_AUTH_MODE')
      : parseEnum(env.API_AUTH_MODE, ['none', 'bearer', 'session'], 'none'),
    authProvider: parseEnum(env.AUTH_PROVIDER, ['static', 'github'], 'static'),
    authCookieSecure: parseBoolean(env.AUTH_COOKIE_SECURE, false, 'AUTH_COOKIE_SECURE'),
    authCookieSameSite: parseEnum(env.AUTH_COOKIE_SAME_SITE, ['lax', 'none'], 'lax'),
    sessionCookieName: parseCookieName(env.SESSION_COOKIE_NAME, 'dev_deputies_session', 'SESSION_COOKIE_NAME'),
    previewCookieName: parseCookieName(env.PREVIEW_COOKIE_NAME, 'deputies_preview', 'PREVIEW_COOKIE_NAME'),
    serviceTrustForwardedHosts: parseBoolean(env.SERVICE_TRUST_FORWARDED_HOSTS, false, 'SERVICE_TRUST_FORWARDED_HOSTS'),
    githubOAuthBaseUrl: env.GITHUB_OAUTH_BASE_URL ?? 'https://github.com',
    authGithubAdminUsers: parseStringList(env.AUTH_GITHUB_ADMIN_USERS),
    authGithubAllowedUsers: parseStringList(env.AUTH_GITHUB_ALLOWED_USERS),
    authGithubAllowedOrganizations: parseStringList(env.AUTH_GITHUB_ALLOWED_ORGANIZATIONS),
    authGithubDefaultGroupRole: parseEnum(env.AUTH_GITHUB_DEFAULT_GROUP_ROLE, ['viewer', 'member', 'admin'], 'member'),
    unsafeAuthGithubAllowAll: parseBoolean(env.UNSAFE_AUTH_GITHUB_ALLOW_ALL, false, 'UNSAFE_AUTH_GITHUB_ALLOW_ALL'),
    runnerStateStore: parseEnum(env.RUNNER_STATE_STORE, ['postgres', 'memory'], 'postgres'),
    runnerModelChoices: parseStringList(env.RUNNER_MODEL_CHOICES),
    webSearchProvider: parseEnum(env.WEB_SEARCH_PROVIDER, ['disabled', 'auto', 'brave', 'duckduckgo'], 'auto'),
    webSearchMaxResults: Math.min(parsePositiveInteger(env.WEB_SEARCH_MAX_RESULTS, 10, 'WEB_SEARCH_MAX_RESULTS'), 20),
    webSearchContentMaxChars: parsePositiveInteger(
      env.WEB_SEARCH_CONTENT_MAX_CHARS,
      5_000,
      'WEB_SEARCH_CONTENT_MAX_CHARS',
    ),
    webSearchTimeoutMs: parsePositiveInteger(env.WEB_SEARCH_TIMEOUT_MS, 10_000, 'WEB_SEARCH_TIMEOUT_MS'),
    slackApiBaseUrl: env.SLACK_API_BASE_URL ?? 'https://slack.com/api',
    unsafeSlackWebhookAllowAllIds: parseBoolean(
      env.UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS,
      false,
      'UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS',
    ),
    slackAllowedTeamIds: parseStringList(env.SLACK_ALLOWED_TEAM_IDS),
    slackAllowedChannelIds: parseStringList(env.SLACK_ALLOWED_CHANNEL_IDS),
    slackAllowedUserIds: parseStringList(env.SLACK_ALLOWED_USER_IDS),
    unsafeGithubWebhookAllowAllUsersAndOrgs: parseBoolean(
      env.UNSAFE_GITHUB_WEBHOOK_ALLOW_ALL_USERS_AND_ORGS,
      false,
      'UNSAFE_GITHUB_WEBHOOK_ALLOW_ALL_USERS_AND_ORGS',
    ),
    githubApiBaseUrl: env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
    githubCloneBaseUrl: env.GITHUB_CLONE_BASE_URL ?? 'https://github.com',
    githubAllowedRepositories: parseStringList(env.GITHUB_ALLOWED_REPOSITORIES),
    githubWebhookAllowedUsers: parseStringList(env.GITHUB_WEBHOOK_ALLOWED_USERS),
    githubWebhookAllowedOrganizations: parseStringList(env.GITHUB_WEBHOOK_ALLOWED_ORGANIZATIONS),
    githubWebhookTriggerPhrases: parseStringList(env.GITHUB_WEBHOOK_TRIGGER_PHRASES),
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
    artifactCreateMaxBytes: parsePositiveInteger(
      env.ARTIFACT_CREATE_MAX_BYTES,
      25 * 1024 * 1024,
      'ARTIFACT_CREATE_MAX_BYTES',
    ),
    lambdaMicrovmIngressNetworkConnectors: parseStringList(env.LAMBDA_MICROVM_INGRESS_NETWORK_CONNECTORS),
    lambdaMicrovmEgressNetworkConnectors: parseStringList(env.LAMBDA_MICROVM_EGRESS_NETWORK_CONNECTORS),
    lambdaMicrovmMaximumDurationSeconds: Math.min(
      parsePositiveInteger(
        env.LAMBDA_MICROVM_MAXIMUM_DURATION_SECONDS,
        28_800,
        'LAMBDA_MICROVM_MAXIMUM_DURATION_SECONDS',
      ),
      28_800,
    ),
    lambdaMicrovmAuthTokenTtlMinutes: Math.min(
      parsePositiveInteger(env.LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES, 30, 'LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES'),
      60,
    ),
    lambdaMicrovmBridgePort: parsePositiveInteger(env.LAMBDA_MICROVM_BRIDGE_PORT, 3584, 'LAMBDA_MICROVM_BRIDGE_PORT'),
    unsafeAllowLocalHttpCallbacks: parseBoolean(
      env.UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS,
      false,
      'UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS',
    ),
    hideSetupPage: parseBoolean(env.HIDE_SETUP_PAGE, false, 'HIDE_SETUP_PAGE'),
  };

  if (env.API_BEARER_TOKEN) config.apiBearerToken = env.API_BEARER_TOKEN;
  if (env.AUTH_STATIC_USERNAME) config.authStaticUsername = env.AUTH_STATIC_USERNAME;
  if (env.AUTH_STATIC_PASSWORD) config.authStaticPassword = env.AUTH_STATIC_PASSWORD;
  if (env.AUTH_SESSION_SECRET) config.authSessionSecret = env.AUTH_SESSION_SECRET;
  if (env.WEB_BASE_URL) config.webBaseUrl = env.WEB_BASE_URL;
  if (env.SERVICE_BASE_DOMAIN) config.serviceBaseDomain = env.SERVICE_BASE_DOMAIN;
  if (env.GITHUB_OAUTH_CLIENT_ID) config.githubOAuthClientId = env.GITHUB_OAUTH_CLIENT_ID;
  if (env.GITHUB_OAUTH_CLIENT_SECRET) config.githubOAuthClientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  if (env.GITHUB_OAUTH_CALLBACK_URL) config.githubOAuthCallbackUrl = env.GITHUB_OAUTH_CALLBACK_URL;
  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
  if (env.RUNNER_MODEL_DEFAULT) config.runnerModelDefault = env.RUNNER_MODEL_DEFAULT;
  if (env.OPENAI_CODEX_AUTH_FILE) config.openaiCodexAuthFile = env.OPENAI_CODEX_AUTH_FILE;
  if (env.OPENAI_CODEX_AUTH_BASE64) config.openaiCodexAuthBase64 = env.OPENAI_CODEX_AUTH_BASE64;
  const webSearchBraveApiKey = env.WEB_SEARCH_BRAVE_API_KEY ?? env.BRAVE_API_KEY;
  if (webSearchBraveApiKey) config.webSearchBraveApiKey = webSearchBraveApiKey;
  if (env.FAKE_RUNNER_ARTIFACT_JSON) {
    config.fakeRunnerArtifact = parseJsonRecord(env.FAKE_RUNNER_ARTIFACT_JSON, 'FAKE_RUNNER_ARTIFACT_JSON');
  }
  if (env.DOCKER_ORCHESTRATOR_URL) config.dockerOrchestratorUrl = env.DOCKER_ORCHESTRATOR_URL;
  if (env.DOCKER_ORCHESTRATOR_TOKEN) config.dockerOrchestratorToken = env.DOCKER_ORCHESTRATOR_TOKEN;
  if (env.DOCKER_SANDBOX_NETWORK) config.dockerSandboxNetwork = env.DOCKER_SANDBOX_NETWORK;
  if (env.DOCKER_SANDBOX_MEMORY) config.dockerSandboxMemory = env.DOCKER_SANDBOX_MEMORY;
  if (env.DOCKER_SANDBOX_CPUS) config.dockerSandboxCpus = env.DOCKER_SANDBOX_CPUS;
  if (env.AGENT_SANDBOX_ORCHESTRATOR_URL) config.agentSandboxOrchestratorUrl = env.AGENT_SANDBOX_ORCHESTRATOR_URL;
  if (env.AGENT_SANDBOX_ORCHESTRATOR_TOKEN) config.agentSandboxOrchestratorToken = env.AGENT_SANDBOX_ORCHESTRATOR_TOKEN;
  if (env.AGENT_SANDBOX_NAMESPACE) config.agentSandboxNamespace = env.AGENT_SANDBOX_NAMESPACE;
  if (env.AGENT_SANDBOX_STORAGE_CLASS_NAME) config.agentSandboxStorageClassName = env.AGENT_SANDBOX_STORAGE_CLASS_NAME;
  if (env.SANDBOX_SECRET_ENCRYPTION_KEY) config.sandboxSecretEncryptionKey = env.SANDBOX_SECRET_ENCRYPTION_KEY;
  if (env.DAYTONA_API_KEY) config.daytonaApiKey = env.DAYTONA_API_KEY;
  if (env.DAYTONA_API_URL) config.daytonaApiUrl = env.DAYTONA_API_URL;
  if (env.DAYTONA_TARGET) config.daytonaTarget = env.DAYTONA_TARGET;
  if (env.DAYTONA_IMAGE) config.daytonaImage = env.DAYTONA_IMAGE;
  if (env.DAYTONA_SNAPSHOT) config.daytonaSnapshot = env.DAYTONA_SNAPSHOT;
  if (env.DAYTONA_SANDBOX_CPU)
    config.daytonaSandboxCpu = parsePositiveNumber(env.DAYTONA_SANDBOX_CPU, 'DAYTONA_SANDBOX_CPU');
  if (env.DAYTONA_SANDBOX_GPU)
    config.daytonaSandboxGpu = parsePositiveNumber(env.DAYTONA_SANDBOX_GPU, 'DAYTONA_SANDBOX_GPU');
  if (env.DAYTONA_SANDBOX_MEMORY_GIB)
    config.daytonaSandboxMemoryGiB = parsePositiveNumber(env.DAYTONA_SANDBOX_MEMORY_GIB, 'DAYTONA_SANDBOX_MEMORY_GIB');
  if (env.DAYTONA_SANDBOX_DISK_GIB)
    config.daytonaSandboxDiskGiB = parsePositiveNumber(env.DAYTONA_SANDBOX_DISK_GIB, 'DAYTONA_SANDBOX_DISK_GIB');
  if (env.TENSORLAKE_API_KEY) config.tensorlakeApiKey = env.TENSORLAKE_API_KEY;
  if (env.TENSORLAKE_REGISTERED_IMAGE) config.tensorlakeRegisteredImage = env.TENSORLAKE_REGISTERED_IMAGE;
  if (env.TENSORLAKE_SANDBOX_CPU)
    config.tensorlakeSandboxCpu = parsePositiveNumber(env.TENSORLAKE_SANDBOX_CPU, 'TENSORLAKE_SANDBOX_CPU');
  if (env.TENSORLAKE_SANDBOX_MEMORY_MB)
    config.tensorlakeSandboxMemoryMb = parsePositiveInteger(
      env.TENSORLAKE_SANDBOX_MEMORY_MB,
      1024,
      'TENSORLAKE_SANDBOX_MEMORY_MB',
    );
  if (env.TENSORLAKE_SANDBOX_DISK_MB)
    config.tensorlakeSandboxDiskMb = parsePositiveInteger(
      env.TENSORLAKE_SANDBOX_DISK_MB,
      10240,
      'TENSORLAKE_SANDBOX_DISK_MB',
    );
  if (env.TENSORLAKE_ALLOW_INTERNET_ACCESS) {
    config.tensorlakeAllowInternetAccess = parseBoolean(
      env.TENSORLAKE_ALLOW_INTERNET_ACCESS,
      true,
      'TENSORLAKE_ALLOW_INTERNET_ACCESS',
    );
  }
  if (env.LAMBDA_MICROVM_REGION) config.lambdaMicrovmRegion = env.LAMBDA_MICROVM_REGION;
  else if (env.AWS_REGION) config.lambdaMicrovmRegion = env.AWS_REGION;
  else if (env.AWS_DEFAULT_REGION) config.lambdaMicrovmRegion = env.AWS_DEFAULT_REGION;
  if (env.LAMBDA_MICROVM_IMAGE_IDENTIFIER) config.lambdaMicrovmImageIdentifier = env.LAMBDA_MICROVM_IMAGE_IDENTIFIER;
  if (env.LAMBDA_MICROVM_IMAGE_VERSION) config.lambdaMicrovmImageVersion = env.LAMBDA_MICROVM_IMAGE_VERSION;
  if (env.LAMBDA_MICROVM_EXECUTION_ROLE_ARN)
    config.lambdaMicrovmExecutionRoleArn = env.LAMBDA_MICROVM_EXECUTION_ROLE_ARN;
  if (env.LAMBDA_MICROVM_LOG_GROUP) config.lambdaMicrovmLogGroup = env.LAMBDA_MICROVM_LOG_GROUP;
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

  config.runnerModelChoices = deriveRunnerModelChoices(env, config.runnerModelChoices, config.runnerModelDefault);

  if (runModeStartsApi(config.runMode)) {
    validateProductAuthConfig(config);
    validateInboundWebhookConfig(config);
  }
  validateArtifactStorageConfig(config);
  if (runModeStartsWorker(config.runMode)) validateWebSearchConfig(config);
  validateSandboxSecretConfig(config, env);
  validateAgentSandboxOrchestratorConfig(config);
  validateLambdaMicrovmConfig(config);

  return config;
}

function runModeStartsApi(runMode: RunMode): boolean {
  return runMode === 'combined' || runMode === 'all' || runMode === 'api';
}

function runModeStartsWorker(runMode: RunMode): boolean {
  return runMode === 'combined' || runMode === 'all' || runMode === 'worker';
}

function validateInboundWebhookConfig(config: AppConfig): void {
  if (config.slackSigningSecret && !config.unsafeSlackWebhookAllowAllIds && !hasAnySlackAllowlist(config)) {
    throw new Error(
      'Slack allowlists are required when SLACK_SIGNING_SECRET is set. Configure SLACK_ALLOWED_TEAM_IDS, SLACK_ALLOWED_CHANNEL_IDS, or SLACK_ALLOWED_USER_IDS, or set UNSAFE_SLACK_WEBHOOK_ALLOW_ALL_IDS=true for unrestricted Slack access.',
    );
  }
  if (
    config.githubWebhookSecret &&
    !config.unsafeGithubWebhookAllowAllUsersAndOrgs &&
    !hasAnyGitHubWebhookAllowlist(config)
  ) {
    throw new Error(
      'GitHub webhook allowlists are required when GITHUB_WEBHOOK_SECRET is set. Configure GITHUB_WEBHOOK_ALLOWED_USERS or GITHUB_WEBHOOK_ALLOWED_ORGANIZATIONS, or set UNSAFE_GITHUB_WEBHOOK_ALLOW_ALL_USERS_AND_ORGS=true for unrestricted GitHub webhook access.',
    );
  }
  if (config.githubWebhookSecret && !config.githubWebhookTriggerPhrases.length) {
    throw new Error(
      'GITHUB_WEBHOOK_TRIGGER_PHRASES is required when GITHUB_WEBHOOK_SECRET is set so GitHub webhooks only process explicitly triggered requests.',
    );
  }
}

function validateAgentSandboxOrchestratorConfig(config: AppConfig): void {
  if (config.sandboxProvider !== 'k8s-agent-sandbox' || config.agentSandboxOrchestratorMode !== 'http') return;
  requireAgentSandboxOrchestratorUrl(config);
  requireAgentSandboxOrchestratorToken(config);
}

function validateLambdaMicrovmConfig(config: AppConfig): void {
  if (config.sandboxProvider !== 'lambda-microvm') return;
  requireLambdaMicrovmImageIdentifier(config);
}

function validateSandboxSecretConfig(config: AppConfig, env: NodeJS.ProcessEnv): void {
  const sandboxSecretsRequired =
    config.sandboxProvider === 'docker' ||
    config.sandboxProvider === 'k8s-agent-sandbox' ||
    config.sandboxProvider === 'lambda-microvm';
  if (config.appDataStore === 'postgres' && sandboxSecretsRequired && !config.sandboxSecretEncryptionKey) {
    throw new Error(
      `SANDBOX_SECRET_ENCRYPTION_KEY is required when APP_DATA_STORE=postgres and SANDBOX_PROVIDER=${config.sandboxProvider}`,
    );
  }
  if (env.NODE_ENV === 'production' && config.sandboxSecretEncryptionKey === sandboxSecretEncryptionKeyPlaceholder) {
    throw new Error('SANDBOX_SECRET_ENCRYPTION_KEY must not use the .env.example placeholder in production');
  }
}

function validateArtifactStorageConfig(config: AppConfig): void {
  if (config.artifactStorage === 'filesystem' && !config.artifactStorageFilesystemPath) {
    throw new Error('ARTIFACT_STORAGE_FILESYSTEM_PATH is required when ARTIFACT_STORAGE_PROVIDER=filesystem');
  }

  if (config.artifactStorage !== 's3') return;
  if (!config.artifactStorageS3Bucket) {
    throw new Error('ARTIFACT_STORAGE_S3_BUCKET is required when ARTIFACT_STORAGE_PROVIDER=s3');
  }
  if (Boolean(config.artifactStorageS3AccessKeyId) !== Boolean(config.artifactStorageS3SecretAccessKey)) {
    throw new Error(
      'ARTIFACT_STORAGE_S3_ACCESS_KEY_ID and ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY must be provided together',
    );
  }
  if (
    config.artifactStorageS3Endpoint &&
    (!config.artifactStorageS3AccessKeyId || !config.artifactStorageS3SecretAccessKey)
  ) {
    throw new Error(
      'ARTIFACT_STORAGE_S3_ACCESS_KEY_ID and ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY are required for S3-compatible artifact endpoints',
    );
  }
}

function validateWebSearchConfig(config: AppConfig): void {
  if (config.webSearchProvider === 'brave' && !config.webSearchBraveApiKey) {
    throw new Error('WEB_SEARCH_BRAVE_API_KEY or BRAVE_API_KEY is required when WEB_SEARCH_PROVIDER=brave');
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
  config: Pick<AppConfig, 'githubWebhookAllowedUsers' | 'githubWebhookAllowedOrganizations'>,
): boolean {
  return Boolean(config.githubWebhookAllowedUsers.length || config.githubWebhookAllowedOrganizations.length);
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
  if (!config.githubOAuthClientId || !config.githubOAuthClientSecret) {
    throw new Error('GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are required when AUTH_PROVIDER=github');
  }

  return { clientId: config.githubOAuthClientId, clientSecret: config.githubOAuthClientSecret };
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

export function requireTensorlakeApiKey(config: AppConfig): string {
  if (!config.tensorlakeApiKey) {
    throw new Error('TENSORLAKE_API_KEY is required when SANDBOX_PROVIDER=tensorlake');
  }

  return config.tensorlakeApiKey;
}

export function requireTensorlakeRegisteredImage(config: AppConfig): string {
  if (!config.tensorlakeRegisteredImage) {
    throw new Error('TENSORLAKE_REGISTERED_IMAGE is required when SANDBOX_PROVIDER=tensorlake');
  }
  if (isTensorlakeRegistryReference(config.tensorlakeRegisteredImage)) {
    throw new Error(
      'TENSORLAKE_REGISTERED_IMAGE must be a registered Tensorlake image name/id, not a registry reference',
    );
  }

  return config.tensorlakeRegisteredImage;
}

export function requireLambdaMicrovmImageIdentifier(config: AppConfig): string {
  if (!config.lambdaMicrovmImageIdentifier) {
    throw new Error('LAMBDA_MICROVM_IMAGE_IDENTIFIER is required when SANDBOX_PROVIDER=lambda-microvm');
  }

  return config.lambdaMicrovmImageIdentifier;
}

export function requireDockerOrchestratorUrl(config: AppConfig): string {
  if (!config.dockerOrchestratorUrl) {
    throw new Error('DOCKER_ORCHESTRATOR_URL is required when DOCKER_ORCHESTRATOR_MODE=http');
  }

  return config.dockerOrchestratorUrl;
}

export function requireAgentSandboxOrchestratorUrl(config: AppConfig): string {
  if (!config.agentSandboxOrchestratorUrl) {
    throw new Error('AGENT_SANDBOX_ORCHESTRATOR_URL is required when AGENT_SANDBOX_ORCHESTRATOR_MODE=http');
  }

  return config.agentSandboxOrchestratorUrl;
}

export function requireAgentSandboxOrchestratorToken(config: AppConfig): string {
  if (!config.agentSandboxOrchestratorToken) {
    throw new Error('AGENT_SANDBOX_ORCHESTRATOR_TOKEN is required when AGENT_SANDBOX_ORCHESTRATOR_MODE=http');
  }

  return config.agentSandboxOrchestratorToken;
}

export function requireRunnerModelDefault(config: AppConfig): string {
  if (!config.runnerModelDefault) {
    throw new Error('RUNNER_MODEL_DEFAULT is required when RUNNER=flue or RUNNER=pi');
  }

  return config.runnerModelDefault;
}

export function requireDatabaseUrl(config: AppConfig): string {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required when APP_DATA_STORE=postgres');
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

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, received "${value}"`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false, received "${value}"`);
}

function parseCookieName(value: string | undefined, fallback: string, name: string): string {
  if (!value) return fallback;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name} must contain only letters, digits, hyphens, and underscores, received "${value}"`);
  }
  return value;
}

function parseStringList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonRecord(value: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Fall through to the typed configuration error below.
  }
  throw new Error(`${name} must be a JSON object`);
}

function deriveRunnerModelChoices(
  env: NodeJS.ProcessEnv,
  explicitChoices: string[],
  defaultModel: string | undefined,
): string[] {
  const derived = explicitChoices.length ? explicitChoices : providerDerivedRunnerModels(env);
  return dedupeStrings(defaultModel ? [defaultModel, ...derived] : derived);
}

function providerDerivedRunnerModels(env: NodeJS.ProcessEnv): string[] {
  return MODEL_PROVIDER_AUTH.flatMap(({ provider, env: envNames }) =>
    envNames.some((name) => env[name]) ? providerModels(provider).map((model) => `${provider}/${model}`) : [],
  );
}

function providerModels(provider: KnownProvider): string[] {
  const catalogModels = getModels(provider).map((model) => model.id);
  if (provider === AMAZON_BEDROCK_PROVIDER) return [...AMAZON_BEDROCK_INFERENCE_PROFILE_MODEL_IDS, ...catalogModels];
  return catalogModels;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, '\n');
}

function isTensorlakeRegistryReference(value: string): boolean {
  return value.includes('/') || value.includes(':') || value.includes('@');
}

function parseEnum<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value;

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
