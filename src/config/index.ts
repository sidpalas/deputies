export type RunMode = 'all' | 'api' | 'worker';
export type RunnerKind = 'fake' | 'flue';
export type SandboxProviderKind = 'fake' | 'local-docker' | 'daytona' | 'kubernetes' | 'ecs';

export type AppConfig = {
  port: number;
  runMode: RunMode;
  runner: RunnerKind;
  sandboxProvider: SandboxProviderKind;
  flueSessionStore: 'postgres' | 'memory';
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    port: parsePort(env.PORT),
    runMode: parseEnum(env.RUN_MODE, ['all', 'api', 'worker'], 'all'),
    runner: parseEnum(env.RUNNER, ['fake', 'flue'], 'fake'),
    sandboxProvider: parseEnum(
      env.SANDBOX_PROVIDER,
      ['fake', 'local-docker', 'daytona', 'kubernetes', 'ecs'],
      'fake',
    ),
    flueSessionStore: parseEnum(env.FLUE_SESSION_STORE, ['postgres', 'memory'], 'postgres'),
  };
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
