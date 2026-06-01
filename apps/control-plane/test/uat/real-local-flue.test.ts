import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, requireRunnerModel } from '../../src/config/index.js';
import { RealFlueAgentFactory } from '../../src/runner-flue/agent-factory.js';
import { FlueRunner } from '../../src/runner-flue/runner.js';
import type { RepositoryAccessProvider } from '../../src/repositories/setup.js';
import { LocalSandboxProvider } from '../../src/sandbox/local.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';

const enabled = process.env.RUN_REAL_LOCAL_FLUE_UAT === 'true';
const hasRequiredEnv = Boolean(process.env.RUNNER_MODEL);

describe.skipIf(!enabled || !hasRequiredEnv)('real Flue + local sandbox UAT', () => {
  let rootDir: string;
  let provider: LocalSandboxProvider;
  let sandbox: SandboxHandle | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'deputies-real-local-flue-uat-'));
    provider = new LocalSandboxProvider({ rootDir });
  });

  afterEach(async () => {
    if (sandbox) await provider.destroy(sandbox).catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
    sandbox = undefined;
  });

  it('runs a real Flue prompt with a prepared local git repository', async () => {
    const config = loadConfig(process.env);
    sandbox = await provider.create({ sessionId: 'real-local-flue-uat' });
    const remotePath = await createLocalGitRemote(sandbox);
    const events: unknown[] = [];

    const result = await new FlueRunner(new RealFlueAgentFactory({ model: requireRunnerModel(config) }), {
      repositoryAccess: { github: new LocalGitAccessProvider(remotePath) },
    }).run({
      sessionId: 'real-local-flue-uat',
      runId: 'real-local-flue-uat-run',
      messageId: 'real-local-flue-uat-message',
      prompt: 'Use the shell to run `cat README.md`, then reply with the exact file contents only.',
      context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } },
      sandbox,
      emit: async (event) => {
        events.push(event);
      },
    });

    expect(result.text).toContain('LOCAL_FLUE_UAT_OK');
    expect(JSON.stringify(events)).not.toContain('ghs_secret_token');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'repository_ready',
        payload: expect.objectContaining({
          provider: 'github',
          owner: 'manaflow-ai',
          repo: 'manaflow',
          workspacePath: `${sandbox.workspacePath}/manaflow`,
        }),
      }),
    );
    await expect(sandbox.fs?.readFile('manaflow/README.md')).resolves.toBe('LOCAL_FLUE_UAT_OK\n');
  }, 180_000);
});

async function createLocalGitRemote(sandbox: SandboxHandle): Promise<string> {
  const result = await sandbox.exec({
    cwd: sandbox.workspacePath,
    command: [
      'set -eu',
      'git init --bare remote.git',
      'git init seed',
      "git -C seed config user.name 'Test User'",
      "git -C seed config user.email 'test@example.com'",
      "printf 'LOCAL_FLUE_UAT_OK\\n' > seed/README.md",
      'git -C seed add README.md',
      "git -C seed commit -m 'initial commit'",
      'git -C seed branch -M main',
      'git -C seed remote add origin ../remote.git',
      'git -C seed push origin main',
    ].join('\n'),
  });
  if (result.exitCode !== 0) throw new Error(`Failed to create local git remote:\n${result.stdout}\n${result.stderr}`);
  return `${sandbox.workspacePath}/remote.git`;
}

class LocalGitAccessProvider implements RepositoryAccessProvider {
  constructor(private readonly cloneUrl: string) {}

  async getRepositoryAccess() {
    return {
      provider: 'github' as const,
      owner: 'manaflow-ai',
      repo: 'manaflow',
      cloneUrl: this.cloneUrl,
      expiresAt: new Date('2026-05-06T01:00:00.000Z'),
      auth: { type: 'bearer' as const, token: 'ghs_secret_token' },
    };
  }
}
