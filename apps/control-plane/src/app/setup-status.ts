import { constants } from 'node:fs';
import { access, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateBucketCommand, HeadBucketCommand, NoSuchBucket, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import type { AppConfig } from '../config/index.js';
import { configuredModels } from './model-availability.js';
import type { AppServices } from './server.js';

export type SetupStatusState = 'configured' | 'limited' | 'missing' | 'warning' | 'error';

export type SetupStatusItem = {
  id: string;
  label: string;
  state: SetupStatusState;
  summary: string;
  guidance?: string | undefined;
  guidanceItems?: string[] | undefined;
  details?: string[] | undefined;
  docsPath: string;
};

export type SetupStatusResponse = {
  checkedAt: string;
  items: SetupStatusItem[];
};

export async function buildSetupStatus(
  config: AppConfig,
  services?: Pick<AppServices, 'sandboxProvider'>,
): Promise<SetupStatusResponse> {
  const items: SetupStatusItem[] = [
    authStatus(config),
    slackIntegrationStatus(config),
    githubWebhookStatus(config),
    runnerStatus(config),
    await sandboxStatus(config, services),
    githubAppStatus(config),
    modelProviderStatus(config),
    await objectStoreStatus(config),
    await postgresStatus(config),
  ];

  return { checkedAt: new Date().toISOString(), items };
}

function authStatus(config: AppConfig): SetupStatusItem {
  if (config.apiAuthMode !== 'session') {
    return {
      id: 'auth',
      label: 'Authentication',
      state: config.apiAuthMode === 'none' ? 'warning' : 'configured',
      summary: `API auth is ${config.apiAuthMode}.`,
      guidance:
        config.apiAuthMode === 'none'
          ? 'Set API_AUTH_MODE=session and choose AUTH_PROVIDER=static or github before exposing the app.'
          : undefined,
      docsPath: 'README.md',
    };
  }

  return {
    id: 'auth',
    label: 'Authentication',
    state: config.authProvider === 'static' ? 'limited' : 'configured',
    summary: `Session auth is using the ${config.authProvider} provider.`,
    guidance:
      config.authProvider === 'static'
        ? 'Static auth is suitable for limited/admin-only deployments. Use AUTH_PROVIDER=github for GitHub-backed login.'
        : undefined,
    details: [`Provider: ${config.authProvider}`],
    docsPath: 'README.md',
  };
}

function slackIntegrationStatus(config: AppConfig): SetupStatusItem {
  const configured = Boolean(config.slackSigningSecret && config.slackBotToken);
  return {
    id: 'slack-integration',
    label: 'Slack Integration',
    state: configured ? 'configured' : 'missing',
    summary: configured ? 'Slack webhook and bot credentials are configured.' : 'Slack integration is not configured.',
    guidance: configured ? undefined : 'Set Slack webhook and bot credentials to receive and reply to Slack work.',
    guidanceItems: configured ? undefined : ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN'],
    details: [`Slack: ${config.slackSigningSecret && config.slackBotToken ? 'configured' : 'missing'}`],
    docsPath: 'README.md',
  };
}

function githubWebhookStatus(config: AppConfig): SetupStatusItem {
  const configured = Boolean(config.githubWebhookSecret);
  return {
    id: 'github-webhooks',
    label: 'GitHub Webhooks',
    state: configured ? 'configured' : 'missing',
    summary: configured ? 'GitHub webhook intake is configured.' : 'GitHub webhook intake is not configured.',
    guidance: configured ? undefined : 'Set the webhook secret and trigger phrases to receive GitHub issue/PR work.',
    guidanceItems: configured ? undefined : ['GITHUB_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_TRIGGER_PHRASES'],
    details: [`GitHub webhooks: ${configured ? 'configured' : 'missing'}`],
    docsPath: 'README.md',
  };
}

function runnerStatus(config: AppConfig): SetupStatusItem {
  const piRunnerSelected = config.runner === 'pi';
  return {
    id: 'runner',
    label: 'Runner',
    state: piRunnerSelected ? 'configured' : 'warning',
    summary: `${config.runner} runner selected.`,
    guidance: piRunnerSelected ? undefined : 'Use Pi for real agent execution.',
    guidanceItems: piRunnerSelected ? undefined : ['RUNNER=pi', 'RUNNER_MODEL_DEFAULT=<DEFAULT_MODEL_CHOICE>'],
    details: [`Runner: ${config.runner}`],
    docsPath: 'README.md',
  };
}

async function sandboxStatus(
  config: AppConfig,
  services?: Pick<AppServices, 'sandboxProvider'>,
): Promise<SetupStatusItem> {
  const missingDaytona = config.sandboxProvider === 'daytona' && !config.daytonaApiKey;
  const missingTensorlake =
    config.sandboxProvider === 'tensorlake' && (!config.tensorlakeApiKey || !config.tensorlakeRegisteredImage);
  const missingDockerOrchestrator =
    config.sandboxProvider === 'docker' && config.dockerOrchestratorMode === 'http' && !config.dockerOrchestratorUrl;
  const state =
    missingDaytona || missingTensorlake || missingDockerOrchestrator
      ? 'missing'
      : config.sandboxProvider === 'fake'
        ? 'warning'
        : 'configured';

  if (state !== 'configured') {
    return {
      id: 'sandbox',
      label: 'Sandbox Provider',
      state,
      summary: `${config.sandboxProvider} sandbox provider selected.`,
      guidance:
        state === 'missing'
          ? 'Provide the required credentials/endpoint for the selected sandbox provider.'
          : config.sandboxProvider === 'fake'
            ? 'Use docker or daytona for real agent work.'
            : undefined,
      details: [`Provider: ${config.sandboxProvider}`],
      docsPath: 'docs/sandbox-providers.md',
    };
  }

  if (!services?.sandboxProvider?.check) {
    return {
      id: 'sandbox',
      label: 'Sandbox Provider',
      state: 'warning',
      summary: `${config.sandboxProvider} sandbox provider is configured, but no connectivity check is available.`,
      details: [`Provider: ${config.sandboxProvider}`],
      docsPath: 'docs/sandbox-providers.md',
    };
  }

  try {
    const check = await services.sandboxProvider.check();
    return {
      id: 'sandbox',
      label: 'Sandbox Provider',
      state: check.status === 'ready' ? 'configured' : 'error',
      summary:
        check.status === 'ready'
          ? `${config.sandboxProvider} sandbox provider is reachable.`
          : `${config.sandboxProvider} sandbox provider health check failed.`,
      guidance: check.status === 'ready' ? undefined : 'Check sandbox provider credentials and network reachability.',
      details: [`Provider: ${config.sandboxProvider}`, ...(check.message ? [check.message] : [])],
      docsPath: 'docs/sandbox-providers.md',
    };
  } catch (error) {
    return {
      id: 'sandbox',
      label: 'Sandbox Provider',
      state: 'error',
      summary: `${config.sandboxProvider} sandbox provider health check failed.`,
      guidance: 'Check sandbox provider credentials and network reachability.',
      details: [
        `Provider: ${config.sandboxProvider}`,
        error instanceof Error ? error.message : 'Unknown sandbox error',
      ],
      docsPath: 'docs/sandbox-providers.md',
    };
  }
}

function githubAppStatus(config: AppConfig): SetupStatusItem {
  const configured = Boolean(config.githubAppId && config.githubAppPrivateKey);
  return {
    id: 'github-app',
    label: 'GitHub App Repo Access',
    state: configured ? 'configured' : 'missing',
    summary: configured
      ? 'GitHub App runtime credentials are configured.'
      : 'GitHub App runtime credentials are missing.',
    guidance: configured
      ? undefined
      : 'Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to enable repo access and git credentials.',
    details: [`Installation access: ${configured ? 'configured' : 'missing'}`],
    docsPath: 'README.md',
  };
}

function modelProviderStatus(config: AppConfig): SetupStatusItem {
  const providers = modelProviders(config);
  return {
    id: 'models',
    label: 'Model Providers',
    state: providers.length ? 'configured' : 'missing',
    summary: providers.length
      ? `${providers.join(', ')} model access configured.`
      : 'No model provider credentials detected.',
    guidance: providers.length ? undefined : 'Set model provider credentials, such as:',
    guidanceItems: providers.length
      ? undefined
      : ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'OPENAI_CODEX_AUTH_BASE64'],
    details: [`Models available: ${configuredModels(config).length}`],
    docsPath: 'README.md',
  };
}

function modelProviders(config: AppConfig): string[] {
  const models = configuredModels(config);
  const providers: string[] = [];
  if (models.some((model) => model.startsWith('amazon-bedrock/'))) providers.push('Amazon Bedrock');
  if (models.some((model) => model.startsWith('anthropic/'))) providers.push('Anthropic');
  if (models.some((model) => model.startsWith('openai/'))) providers.push('OpenAI');
  if (models.some((model) => model.startsWith('openai-codex/'))) providers.push('OpenAI Codex');
  if (models.some((model) => model.startsWith('opencode/'))) providers.push('OpenCode Zen');
  return providers;
}

async function objectStoreStatus(config: AppConfig): Promise<SetupStatusItem> {
  if (config.artifactStorage === 'filesystem') {
    try {
      await mkdir(config.artifactStorageFilesystemPath!, { recursive: true });
      await access(config.artifactStorageFilesystemPath!, constants.R_OK | constants.W_OK);
      return {
        id: 'object-store',
        label: 'Artifact Storage',
        state: 'configured',
        summary: 'Filesystem artifact storage is writable.',
        details: [`Provider: ${config.artifactStorage}`, `Path: ${config.artifactStorageFilesystemPath}`],
        docsPath: 'README.md',
      };
    } catch (error) {
      return objectStoreErrorStatus(config, error, 'Filesystem artifact storage check failed.');
    }
  }

  if (config.artifactStorage === 's3') {
    const client = new S3Client({
      region: config.artifactStorageS3Region,
      forcePathStyle: config.artifactStorageS3ForcePathStyle,
      ...(config.artifactStorageS3AccessKeyId && config.artifactStorageS3SecretAccessKey
        ? {
            credentials: {
              accessKeyId: config.artifactStorageS3AccessKeyId,
              secretAccessKey: config.artifactStorageS3SecretAccessKey,
            },
          }
        : {}),
      ...(config.artifactStorageS3Endpoint ? { endpoint: config.artifactStorageS3Endpoint } : {}),
    });
    try {
      await ensureS3Bucket(client, config.artifactStorageS3Bucket!, config.artifactStorageS3CreateBucket);
      return {
        id: 'object-store',
        label: 'Artifact Storage',
        state: 'configured',
        summary: 'S3 compatible artifact storage bucket is reachable.',
        details: [`Provider: ${config.artifactStorage}`, `Bucket: ${config.artifactStorageS3Bucket}`],
        docsPath: 'README.md',
      };
    } catch (error) {
      return objectStoreErrorStatus(config, error, 'S3 compatible artifact storage check failed.');
    }
  }

  return {
    id: 'object-store',
    label: 'Artifact Storage',
    state: 'missing',
    summary: 'Object storage is disabled.',
    guidance:
      'Set ARTIFACT_STORAGE_PROVIDER=s3 and provide the S3 bucket to persist downloadable artifacts. Native AWS deployments can use the task role credential chain; S3-compatible endpoints also need explicit credentials.',
    guidanceItems: ['ARTIFACT_STORAGE_PROVIDER=s3', 'ARTIFACT_STORAGE_S3_BUCKET'],
    details: [`Provider: ${config.artifactStorage}`],
    docsPath: 'README.md',
  };
}

async function ensureS3Bucket(client: S3Client, bucket: string, createBucket: boolean): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!createBucket || !isS3BucketNotFoundError(error)) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

function isS3BucketNotFoundError(error: unknown): boolean {
  if (error instanceof NoSuchBucket) return true;
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? error.name : undefined;
  const statusCode = '$metadata' in error && isRecord(error.$metadata) ? error.$metadata.httpStatusCode : undefined;
  return name === 'NoSuchBucket' || name === 'NotFound' || statusCode === 404;
}

function objectStoreErrorStatus(config: AppConfig, error: unknown, summary: string): SetupStatusItem {
  return {
    id: 'object-store',
    label: 'Artifact Storage',
    state: 'error',
    summary,
    guidance: 'Check artifact storage credentials and network reachability.',
    details: [`Provider: ${config.artifactStorage}`, error instanceof Error ? error.message : 'Unknown storage error'],
    docsPath: 'README.md',
  };
}

async function postgresStatus(config: AppConfig): Promise<SetupStatusItem> {
  if (config.appDataStore !== 'postgres') {
    return {
      id: 'postgres',
      label: 'Postgres',
      state: 'warning',
      summary: `App data store is ${config.appDataStore}; Postgres is not enabled.`,
      guidance: 'Set APP_DATA_STORE=postgres and DATABASE_URL for durable storage.',
      docsPath: 'README.md',
    };
  }

  if (!config.databaseUrl) {
    return {
      id: 'postgres',
      label: 'Postgres',
      state: 'missing',
      summary: 'Postgres is selected but DATABASE_URL is missing.',
      guidance: 'Set DATABASE_URL and run pnpm control-plane:db:migrate.',
      docsPath: 'README.md',
    };
  }

  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  try {
    await pool.query('SELECT 1');
    const expected = await migrationFiles();
    const applied = await pool.query<{ id: string }>('SELECT id FROM app_migrations');
    const appliedIds = new Set(applied.rows.map((row) => row.id));
    const missing = expected.filter((file) => !appliedIds.has(file));
    // Count only currently expected migration files; old squashed migration rows may remain in deployed databases.
    const appliedExpected = expected.length - missing.length;
    return {
      id: 'postgres',
      label: 'Postgres',
      state: missing.length ? 'warning' : 'configured',
      summary: missing.length
        ? `${missing.length} migration(s) have not been applied.`
        : 'Postgres connects and migrations are current.',
      guidance: missing.length ? 'Run pnpm control-plane:db:migrate.' : undefined,
      details: [`Applied migrations: ${appliedExpected}/${expected.length}`],
      docsPath: 'README.md',
    };
  } catch (error) {
    return {
      id: 'postgres',
      label: 'Postgres',
      state: 'error',
      summary: 'Postgres connection or migration check failed.',
      guidance: 'Check DATABASE_URL, database reachability, and run pnpm control-plane:db:migrate.',
      details: [error instanceof Error ? error.message : 'Unknown database error'],
      docsPath: 'README.md',
    };
  } finally {
    await pool.end();
  }
}

async function migrationFiles(): Promise<string[]> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
  return (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
