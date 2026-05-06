import { spawnSync } from 'node:child_process';
import { loadConfig, requireGitHubAppCredentials } from '../../src/config/index.js';
import { GitHubClient } from '../../src/integrations/github/client.js';
import { GitHubRepositoryAccessService } from '../../src/integrations/github/repository-access.js';
import { FlueRunner } from '../../src/runner-flue/runner.js';
import type { FlueAgentFactory } from '../../src/runner-flue/types.js';
import { DaytonaSandboxProvider, type DaytonaSandboxProviderOptions } from '../../src/sandbox/daytona.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';

const enabled = process.env.RUN_REAL_GITHUB_APP_UAT === 'true';
const daytonaEnabled = process.env.RUN_REAL_GITHUB_DAYTONA_UAT === 'true';

describe.skipIf(!enabled || !hasRequiredEnv())('real GitHub App UAT', () => {
  it('mints installation access and authenticates git read access', async () => {
    const config = loadConfig(process.env);
    const repository = concreteRepository(config.githubAllowedRepositories);
    expect(repository).toBeTruthy();
    if (!repository) return;

    const service = new GitHubRepositoryAccessService({
      ...requireGitHubAppCredentials(config),
      client: new GitHubClient({ apiBaseUrl: config.githubApiBaseUrl }),
      cloneBaseUrl: config.githubCloneBaseUrl,
      allowedRepositories: config.githubAllowedRepositories,
    });

    const access = await service.getRepositoryAccess(repository);
    expect(access).toMatchObject({
      provider: 'github',
      owner: repository.owner,
      repo: repository.repo,
      cloneUrl: `${config.githubCloneBaseUrl}/${repository.owner}/${repository.repo}.git`,
      auth: { type: 'bearer' },
    });
    expect(access.auth.token).toMatch(/^ghs_/);
    expect(access.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // This UAT only verifies the real installation token can authenticate git.
    // Production clone/fetch still runs inside the sandbox via repository setup.
    const result = spawnSync(
      'git',
      ['-c', 'http.extraHeader=GITHUB_AUTH_HEADER', 'ls-remote', '--heads', access.cloneUrl],
      {
        env: { ...process.env, GITHUB_AUTH_HEADER: gitAuthHeader(access.auth.token) },
        encoding: 'utf8',
      },
    );

    expect(redactToken(result.stderr)).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toContain('refs/heads/');
  }, 30_000);
});

describe.skipIf(!daytonaEnabled || !hasRequiredEnv() || !process.env.DAYTONA_API_KEY)('real GitHub App + Daytona UAT', () => {
  let provider: DaytonaSandboxProvider;
  let sandbox: SandboxHandle | undefined;

  beforeEach(() => {
    provider = new DaytonaSandboxProvider(daytonaOptions());
  });

  afterEach(async () => {
    if (!sandbox) return;
    await provider.destroy(sandbox).catch(() => undefined);
    sandbox = undefined;
  });

  it('clones an allowed repository inside a real Daytona sandbox', async () => {
    const config = loadConfig(process.env);
    const repository = concreteRepository(config.githubAllowedRepositories);
    expect(repository).toBeTruthy();
    if (!repository) return;

    const github = new GitHubRepositoryAccessService({
      ...requireGitHubAppCredentials(config),
      client: new GitHubClient({ apiBaseUrl: config.githubApiBaseUrl }),
      cloneBaseUrl: config.githubCloneBaseUrl,
      allowedRepositories: config.githubAllowedRepositories,
    });

    sandbox = await provider.create({ sessionId: 'real-github-daytona-uat' });
    const events: unknown[] = [];
    const result = await new FlueRunner(daytonaShellAgentFactory(), { repositoryAccess: { github } }).run({
      sessionId: 'real-github-daytona-uat',
      runId: 'real-github-daytona-uat-run',
      messageId: 'real-github-daytona-uat-message',
      prompt: 'verify repository clone',
      context: { repository: { provider: 'github', owner: repository.owner, repo: repository.repo } },
      sandbox,
      emit: async (event) => { events.push(event); },
    });

    const workspacePath = `${sandbox.workspacePath}/${repository.repo}`;
    expect(result.text).toContain('true');
    expect(result.text).toContain(`${config.githubCloneBaseUrl}/${repository.owner}/${repository.repo}.git`);
    expect(JSON.stringify(events)).not.toContain('ghs_');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'repository_ready',
      payload: expect.objectContaining({
        provider: 'github',
        owner: repository.owner,
        repo: repository.repo,
        workspacePath,
      }),
    }));
  }, 180_000);
});

function hasRequiredEnv(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID
      && process.env.GITHUB_APP_PRIVATE_KEY
      && concreteRepository((process.env.GITHUB_ALLOWED_REPOSITORIES ?? '').split(',').map((value) => value.trim()).filter(Boolean)),
  );
}

function concreteRepository(allowedRepositories: string[]): { owner: string; repo: string } | null {
  const value = allowedRepositories.find((repository) => /^[^/*]+\/[^/*]+$/.test(repository));
  if (!value) return null;
  const [owner, repo] = value.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

function redactToken(value: string): string {
  return value.trim().replace(/Bearer\s+[^\s]+/g, 'Bearer [REDACTED]').replace(/Basic\s+[^\s]+/g, 'Basic [REDACTED]');
}

function gitAuthHeader(token: string): string {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

function daytonaOptions(): DaytonaSandboxProviderOptions {
  const options: DaytonaSandboxProviderOptions = {
    idleTimeoutSeconds: 300,
    labels: { 'uat-kind': 'real-github-daytona' },
  };
  if (process.env.DAYTONA_API_KEY) options.apiKey = process.env.DAYTONA_API_KEY;
  if (process.env.DAYTONA_API_URL) options.apiUrl = process.env.DAYTONA_API_URL;
  if (process.env.DAYTONA_TARGET) options.target = process.env.DAYTONA_TARGET;
  if (process.env.DAYTONA_IMAGE) options.image = process.env.DAYTONA_IMAGE;
  if (process.env.DAYTONA_SNAPSHOT) options.snapshot = process.env.DAYTONA_SNAPSHOT;
  return options;
}

function daytonaShellAgentFactory(): FlueAgentFactory {
  return {
    async create(input) {
      return {
        async session() {
          return {
            async shell(command, options) {
              const result = await input.sandbox.exec({
                command,
                ...(options?.cwd ? { cwd: options.cwd } : {}),
                ...(options?.env ? { env: options.env } : {}),
                ...(options?.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
              });
              return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
            },
            async prompt() {
              const result = await input.sandbox.exec({
                command: 'git rev-parse --is-inside-work-tree && git remote get-url origin && git branch --show-current',
                ...(input.cwd ? { cwd: input.cwd } : {}),
                timeoutMs: 30_000,
              });
              if (result.exitCode !== 0) return { text: result.stderr || result.stdout };
              return { text: result.stdout };
            },
            abort() {},
          };
        },
      };
    },
  };
}
