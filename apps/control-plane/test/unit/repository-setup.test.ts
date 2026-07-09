import {
  parseRepositoryContext,
  prepareRepositoryShellSetups,
  RepositorySetupError,
  type GitHubRepository,
  type RepositoryAccessProvider,
} from '../../src/repositories/setup.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';

describe('prepareRepositoryShellSetups', () => {
  it('uses the primary repository as the initial active repository regardless of input order', () => {
    expect(
      parseRepositoryContext({
        environment: {
          id: 'env-1',
          name: 'Product surface',
          codebase: {
            repositories: [
              { provider: 'github', owner: 'acme', repo: 'web', primary: false },
              { provider: 'github', owner: 'acme', repo: 'api', primary: true },
            ],
          },
        },
      }),
    ).toMatchObject({ owner: 'acme', repo: 'api', primary: true });
  });

  it('expands environment codebases into primary-first repository setup plans', async () => {
    const setups = await prepareRepositoryShellSetups({
      context: {
        environment: {
          id: 'env-1',
          name: 'Product surface',
          codebase: {
            repositories: [
              { provider: 'github', owner: 'acme', repo: 'web', branch: 'web-main', primary: false },
              { provider: 'github', owner: 'acme', repo: 'api', branch: 'api-main', primary: true },
            ],
          },
        },
      },
      sandbox: sandbox('/workspace'),
      github: fakeGitHubAccess,
    });

    expect(setups.map((setup) => `${setup.access.owner}/${setup.access.repo}`)).toEqual(['acme/api', 'acme/web']);
    expect(setups.map((setup) => setup.primary)).toEqual([true, false]);
    expect(setups.map((setup) => setup.workspacePath)).toEqual(['/workspace/acme/api', '/workspace/acme/web']);
    expect(setups.map((setup) => setup.environment)).toEqual([
      { id: 'env-1', name: 'Product surface' },
      { id: 'env-1', name: 'Product surface' },
    ]);
    expect(setups[0]?.command).toContain("checkout -B 'api-main' 'origin/api-main'");
    expect(setups[0]?.command).toContain('refusing to switch');
    expect(setups[0]?.command).toContain('status --porcelain --untracked-files=normal --ignore-submodules');
    expect(setups[1]?.command).toContain("checkout -B 'web-main' 'origin/web-main'");
  });

  it('rejects environment codebases without exactly one primary repository', async () => {
    await expect(
      prepareRepositoryShellSetups({
        context: {
          environment: {
            id: 'env-1',
            name: 'Invalid',
            codebase: {
              repositories: [
                { provider: 'github', owner: 'acme', repo: 'api', primary: false },
                { provider: 'github', owner: 'acme', repo: 'web', primary: false },
              ],
            },
          },
        },
        sandbox: sandbox('/workspace'),
        github: fakeGitHubAccess,
      }),
    ).rejects.toMatchObject({ code: 'invalid_repository_context' } satisfies Partial<RepositorySetupError>);
  });
});

const fakeGitHubAccess: RepositoryAccessProvider = {
  async getRepositoryAccess(repository: GitHubRepository) {
    return {
      provider: 'github',
      owner: repository.owner,
      repo: repository.repo,
      cloneUrl: `https://github.com/${repository.owner}/${repository.repo}.git`,
      expiresAt: new Date('2026-07-09T00:00:00Z'),
      auth: { type: 'bearer', token: 'test-token' },
    };
  },
};

function sandbox(workspacePath: string): SandboxHandle {
  return {
    provider: 'fake',
    providerSandboxId: 'sandbox-1',
    sessionId: 'session-1',
    workspacePath,
    metadata: {},
    capabilities: {
      persistentFilesystem: true,
      snapshots: true,
      stopStart: true,
      exec: true,
      filesystem: true,
      streamingLogs: false,
      portForwarding: false,
      serviceEndpoints: false,
      objectStorageArtifacts: false,
    },
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '', startedAt: new Date(), completedAt: new Date() };
    },
  };
}
