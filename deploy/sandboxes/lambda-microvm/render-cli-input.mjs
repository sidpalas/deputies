import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const mode = process.argv[2];
if (mode !== 'create' && mode !== 'update') {
  throw new Error('Usage: node render-cli-input.mjs create|update');
}

await mkdir('.build', { recursive: true });
await writeFile(`.build/${mode}-microvm-image.json`, `${JSON.stringify(input(mode), null, 2)}\n`);

function input(mode) {
  const artifactBucket = requiredEnv('MICROVM_ARTIFACT_BUCKET');
  const artifactKey = env(
    'MICROVM_ARTIFACT_KEY',
    `lambda-microvm/${process.env.MICROVM_ARTIFACT_VERSION || process.env.GITHUB_SHA || 'local'}/deputies-lambda-microvm.zip`,
  );
  const common = compact({
    baseImageArn: requiredEnv('MICROVM_BASE_IMAGE_ARN'),
    baseImageVersion: process.env.MICROVM_BASE_IMAGE_VERSION,
    buildRoleArn: requiredEnv('MICROVM_BUILD_ROLE_ARN'),
    description: env('MICROVM_IMAGE_DESCRIPTION', 'Deputies Lambda MicroVM sandbox image'),
    codeArtifact: { uri: `s3://${artifactBucket}/${artifactKey}` },
    logging: logGroup() ? { cloudWatch: { logGroup: logGroup() } } : undefined,
    egressNetworkConnectors: listEnv('MICROVM_IMAGE_EGRESS_NETWORK_CONNECTORS'),
    cpuConfigurations: [{ architecture: 'ARM_64' }],
    resources: [{ minimumMemoryInMiB: numberEnv('MICROVM_MIN_MEMORY_MIB', 512) }],
    additionalOsCapabilities: listEnv('MICROVM_ADDITIONAL_OS_CAPABILITIES'),
    hooks: hooks(),
    environmentVariables: compact({
      LAMBDA_MICROVM_HOOKS_PORT: String(numberEnv('MICROVM_HOOKS_PORT', 9000)),
    }),
    clientToken: randomUUID(),
  });

  if (mode === 'create') return { ...common, name: requiredEnv('MICROVM_IMAGE_NAME') };
  return { ...common, imageIdentifier: imageIdentifier() };
}

function imageIdentifier() {
  return requiredEnv('MICROVM_IMAGE_IDENTIFIER');
}

function hooks() {
  const microvmImageHooks = {
    ready: env('MICROVM_READY_HOOK', 'ENABLED'),
    readyTimeoutInSeconds: numberEnv('MICROVM_READY_TIMEOUT_SECONDS', 60),
    validate: env('MICROVM_VALIDATE_HOOK', 'DISABLED'),
    validateTimeoutInSeconds: numberEnv('MICROVM_VALIDATE_TIMEOUT_SECONDS', 60),
  };
  const microvmHooks = {
    run: env('MICROVM_RUN_HOOK', 'ENABLED'),
    runTimeoutInSeconds: numberEnv('MICROVM_RUN_TIMEOUT_SECONDS', 60),
    resume: env('MICROVM_RESUME_HOOK', 'ENABLED'),
    resumeTimeoutInSeconds: numberEnv('MICROVM_RESUME_TIMEOUT_SECONDS', 60),
    suspend: env('MICROVM_SUSPEND_HOOK', 'ENABLED'),
    suspendTimeoutInSeconds: numberEnv('MICROVM_SUSPEND_TIMEOUT_SECONDS', 30),
    terminate: env('MICROVM_TERMINATE_HOOK', 'ENABLED'),
    terminateTimeoutInSeconds: numberEnv('MICROVM_TERMINATE_TIMEOUT_SECONDS', 30),
  };
  if (
    !hasEnabledHook(microvmImageHooks, ['ready', 'validate']) &&
    !hasEnabledHook(microvmHooks, ['run', 'resume', 'suspend', 'terminate'])
  ) {
    return undefined;
  }
  return {
    port: numberEnv('MICROVM_HOOKS_PORT', 9000),
    microvmImageHooks,
    microvmHooks,
  };
}

function hasEnabledHook(hooks, names) {
  return names.some((name) => hooks[name] === 'ENABLED');
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function listEnv(name) {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
      throw new Error(`${name} must be a comma-separated list or JSON string array`);
    }
    return parsed.map((value) => value.trim()).filter(Boolean);
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function logGroup() {
  return process.env.MICROVM_LOG_GROUP || undefined;
}

function compact(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === undefined || value === null || value === '') return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }),
  );
}
