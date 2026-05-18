import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { AppConfig } from '../config/index.js';

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

export async function buildSetupStatus(config: AppConfig): Promise<SetupStatusResponse> {
  const items: SetupStatusItem[] = [
    authStatus(config),
    slackIntegrationStatus(config),
    githubWebhookStatus(config),
    runnerStatus(config),
    sandboxStatus(config),
    githubAppStatus(config),
    modelProviderStatus(config),
    objectStoreStatus(config),
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
    guidanceItems: configured ? undefined : ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TRIGGER_PHRASES'],
    details: [`GitHub webhooks: ${configured ? 'configured' : 'missing'}`],
    docsPath: 'README.md',
  };
}

function runnerStatus(config: AppConfig): SetupStatusItem {
  return {
    id: 'runner',
    label: 'Runner',
    state: config.runner === 'flue' ? 'configured' : 'warning',
    summary: `${config.runner} runner selected.`,
    guidance: config.runner === 'flue' ? undefined : 'Use Flue for real agent execution.',
    guidanceItems: config.runner === 'flue' ? undefined : ['RUNNER=flue', 'FLUE_MODEL=<DEFAULT_MODEL_CHOICE>'],
    details: [`Runner: ${config.runner}`],
    docsPath: 'README.md',
  };
}

function sandboxStatus(config: AppConfig): SetupStatusItem {
  const missingDaytona = config.sandboxProvider === 'daytona' && !config.daytonaApiKey;
  const missingDockerOrchestrator =
    config.sandboxProvider === 'docker' && config.dockerOrchestratorMode === 'http' && !config.dockerOrchestratorUrl;
  const state =
    missingDaytona || missingDockerOrchestrator
      ? 'missing'
      : config.sandboxProvider === 'fake'
        ? 'warning'
        : 'configured';

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
      : ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'FLUE_OPENAI_CODEX_AUTH_BASE64'],
    details: [`Models available: ${config.flueModelOptions.length}`],
    docsPath: 'README.md',
  };
}

function modelProviders(config: AppConfig): string[] {
  const providers: string[] = [];
  if (config.flueModelOptions.some((model) => model.startsWith('anthropic/'))) providers.push('Anthropic');
  if (config.flueModelOptions.some((model) => model.startsWith('openai/'))) providers.push('OpenAI');
  if (config.flueModelOptions.some((model) => model.startsWith('openai-codex/'))) providers.push('OpenAI Codex');
  return providers;
}

function objectStoreStatus(config: AppConfig): SetupStatusItem {
  return {
    id: 'object-store',
    label: 'Artifact Storage',
    state: config.artifactStorage === 'disabled' ? 'missing' : 'configured',
    summary:
      config.artifactStorage === 'disabled'
        ? 'Object storage is disabled.'
        : `${config.artifactStorage} artifact storage configured.`,
    guidance:
      config.artifactStorage === 'disabled'
        ? 'Set ARTIFACT_STORAGE_PROVIDER=s3 and provide the S3 bucket and credentials to persist downloadable artifacts.'
        : undefined,
    guidanceItems:
      config.artifactStorage === 'disabled'
        ? [
            'ARTIFACT_STORAGE_PROVIDER=s3',
            'ARTIFACT_STORAGE_S3_BUCKET',
            'ARTIFACT_STORAGE_S3_ACCESS_KEY_ID',
            'ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY',
          ]
        : undefined,
    details: [`Provider: ${config.artifactStorage}`],
    docsPath: 'README.md',
  };
}

async function postgresStatus(config: AppConfig): Promise<SetupStatusItem> {
  if (config.appStore !== 'postgres') {
    return {
      id: 'postgres',
      label: 'Postgres',
      state: 'warning',
      summary: `App store is ${config.appStore}; Postgres is not enabled.`,
      guidance: 'Set APP_STORE=postgres and DATABASE_URL for durable storage.',
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
    return {
      id: 'postgres',
      label: 'Postgres',
      state: missing.length ? 'warning' : 'configured',
      summary: missing.length
        ? `${missing.length} migration(s) have not been applied.`
        : 'Postgres connects and migrations are current.',
      guidance: missing.length ? 'Run pnpm control-plane:db:migrate.' : undefined,
      details: [`Applied migrations: ${appliedIds.size}/${expected.length}`],
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
