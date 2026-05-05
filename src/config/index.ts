export type RunMode = 'all' | 'api' | 'worker';
export type RunnerKind = 'fake' | 'flue';
export type SandboxProviderKind = 'fake' | 'local-docker' | 'daytona' | 'kubernetes' | 'ecs';
export type AppStoreKind = 'memory' | 'postgres';

export type AppConfig = {
  port: number;
  runMode: RunMode;
  runner: RunnerKind;
  sandboxProvider: SandboxProviderKind;
  appStore: AppStoreKind;
  databaseUrl?: string;
  flueSessionStore: 'postgres' | 'memory';
  flueModel?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const config: AppConfig = {
    port: parsePort(env.PORT),
    runMode: parseEnum(env.RUN_MODE, ['all', 'api', 'worker'], 'all'),
    runner: parseEnum(env.RUNNER, ['fake', 'flue'], 'fake'),
    sandboxProvider: parseEnum(
      env.SANDBOX_PROVIDER,
      ['fake', 'local-docker', 'daytona', 'kubernetes', 'ecs'],
      'fake',
    ),
    appStore: parseEnum(env.APP_STORE, ['memory', 'postgres'], 'memory'),
    flueSessionStore: parseEnum(env.FLUE_SESSION_STORE, ['postgres', 'memory'], 'postgres'),
  };

  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
  if (env.FLUE_MODEL) config.flueModel = env.FLUE_MODEL;

  return config;
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

function parseEnum<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T[number];

  throw new Error(`Expected one of ${allowed.join(', ')}, received "${value}"`);
}
