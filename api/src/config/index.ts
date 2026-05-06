export type RunMode = 'all' | 'api' | 'worker';
export type RunnerKind = 'fake' | 'flue';
export type SandboxProviderKind = 'fake' | 'local-docker' | 'daytona' | 'kubernetes' | 'ecs';
export type AppStoreKind = 'memory' | 'postgres';
export type ApiAuthMode = 'none' | 'bearer';

export type AppConfig = {
  port: number;
  maxJsonBodyBytes: number;
  sandboxIdleTimeoutSeconds: number;
  sandboxStopDelaySeconds: number;
  sandboxRetentionSeconds: number;
  runMode: RunMode;
  runner: RunnerKind;
  sandboxProvider: SandboxProviderKind;
  appStore: AppStoreKind;
  apiAuthMode: ApiAuthMode;
  apiBearerToken?: string;
  databaseUrl?: string;
  flueSessionStore: 'postgres' | 'memory';
  flueModel?: string;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  daytonaImage?: string;
  daytonaSnapshot?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const config: AppConfig = {
    port: parsePort(env.PORT),
    maxJsonBodyBytes: parsePositiveInteger(env.MAX_JSON_BODY_BYTES, 1_048_576, 'MAX_JSON_BODY_BYTES'),
    sandboxIdleTimeoutSeconds: parsePositiveInteger(env.SANDBOX_IDLE_TIMEOUT_SECONDS, 900, 'SANDBOX_IDLE_TIMEOUT_SECONDS'),
    sandboxStopDelaySeconds: parseNonNegativeInteger(env.SANDBOX_STOP_DELAY_SECONDS, 60, 'SANDBOX_STOP_DELAY_SECONDS'),
    sandboxRetentionSeconds: parsePositiveInteger(env.SANDBOX_RETENTION_SECONDS, 3600, 'SANDBOX_RETENTION_SECONDS'),
    runMode: parseEnum(env.RUN_MODE, ['all', 'api', 'worker'], 'all'),
    runner: parseEnum(env.RUNNER, ['fake', 'flue'], 'fake'),
    sandboxProvider: parseEnum(
      env.SANDBOX_PROVIDER,
      ['fake', 'local-docker', 'daytona', 'kubernetes', 'ecs'],
      'fake',
    ),
    appStore: parseEnum(env.APP_STORE, ['memory', 'postgres'], 'memory'),
    apiAuthMode: parseEnum(env.API_AUTH_MODE, ['none', 'bearer'], 'none'),
    flueSessionStore: parseEnum(env.FLUE_SESSION_STORE, ['postgres', 'memory'], 'postgres'),
  };

  if (env.API_BEARER_TOKEN) config.apiBearerToken = env.API_BEARER_TOKEN;
  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
  if (env.FLUE_MODEL) config.flueModel = env.FLUE_MODEL;
  if (env.DAYTONA_API_KEY) config.daytonaApiKey = env.DAYTONA_API_KEY;
  if (env.DAYTONA_API_URL) config.daytonaApiUrl = env.DAYTONA_API_URL;
  if (env.DAYTONA_TARGET) config.daytonaTarget = env.DAYTONA_TARGET;
  if (env.DAYTONA_IMAGE) config.daytonaImage = env.DAYTONA_IMAGE;
  if (env.DAYTONA_SNAPSHOT) config.daytonaSnapshot = env.DAYTONA_SNAPSHOT;

  return config;
}

export function requireApiBearerToken(config: AppConfig): string {
  if (!config.apiBearerToken) {
    throw new Error('API_BEARER_TOKEN is required when API_AUTH_MODE=bearer');
  }

  return config.apiBearerToken;
}

export function requireDaytonaApiKey(config: AppConfig): string {
  if (!config.daytonaApiKey) {
    throw new Error('DAYTONA_API_KEY is required when SANDBOX_PROVIDER=daytona');
  }

  return config.daytonaApiKey;
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

function parseEnum<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T[number];

  throw new Error(`Expected one of ${allowed.join(', ')}, received "${value}"`);
}
