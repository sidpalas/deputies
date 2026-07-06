import { createGitTool, type AgentRef } from '../../src/runner-flue/git-tool.js';
import type { GitHubRepositoryAccess } from '../../src/integrations/github/types.js';
import type { RepositoryToolServices } from '../../src/runner-flue/repository-tool.js';

describe('authenticated git Flue tool', () => {
  it('runs git inside the sandbox repo with command-scoped auth', async () => {
    const shells: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = [];
    const agentRef: AgentRef = {
      current: {
        async session() {
          throw new Error('not used');
        },
        async shell(command, options) {
          const shell: { command: string; cwd?: string; env?: Record<string, string> } = { command };
          if (options?.cwd) shell.cwd = options.cwd;
          if (options?.env) shell.env = options.env;
          shells.push(shell);
          return { exitCode: 0, stdout: 'pushed', stderr: '' };
        },
      },
    };
    const tool = createGitTool({ agentRef, repository: repositoryServices(agentRef) });

    const result = await tool.execute({ args: ['push', 'origin', 'sp/test'] });

    expect(result).toBe('exitCode: 0\nstdout:\npushed');
    expect(shells).toEqual([
      {
        command: [
          'set -eu',
          '',
          'auth_header="$GITHUB_AUTH_HEADER"',
          'unset GITHUB_AUTH_HEADER',
          'export GIT_CONFIG_GLOBAL=/dev/null',
          'export GIT_CONFIG_SYSTEM=/dev/null',
          '',
          "git remote set-url origin 'https://github.com/manaflow-ai/manaflow.git'",
          "git -c 'http.https://github.com/manaflow-ai/manaflow.git.extraHeader'=\"$auth_header\" -c core.hooksPath=/dev/null 'push' 'origin' 'sp/test'",
        ].join('\n'),
        cwd: '/workspace/manaflow',
        env: {
          GITHUB_AUTH_HEADER: `Authorization: Basic ${Buffer.from('x-access-token:ghs_secret_token').toString('base64')}`,
        },
      },
    ]);
  });

  it('redacts the full auth header from command output', async () => {
    const authHeader = `Authorization: Basic ${Buffer.from('x-access-token:ghs_secret_token').toString('base64')}`;
    const agentRef: AgentRef = {
      current: {
        async session() {
          throw new Error('not used');
        },
        async shell() {
          return { exitCode: 0, stdout: authHeader, stderr: '' };
        },
      },
    };
    const tool = createGitTool({ agentRef, repository: repositoryServices(agentRef) });

    await expect(tool.execute({ args: ['config', '--list'] })).resolves.toBe('exitCode: 0\nstdout:\n[redacted]');
  });

  it('rejects executable names and top-level flags', async () => {
    const tool = createGitTool({ agentRef: {}, repository: repositoryServices({}) });

    await expect(tool.execute({ args: ['git', 'push'] })).rejects.toThrow('omit the git executable name');
    await expect(tool.execute({ args: ['-c', 'http.extraHeader=bad', 'push'] })).rejects.toThrow('explicit subcommand');
  });

  it('rejects risky push options and refspecs', async () => {
    const tool = createGitTool({ agentRef: {}, repository: repositoryServices({}) });

    await expect(tool.execute({ args: ['push', '--force', 'origin', 'main'] })).rejects.toThrow('not available');
    await expect(tool.execute({ args: ['push', 'origin', '+main'] })).rejects.toThrow('force refspecs');
    await expect(tool.execute({ args: ['push', 'origin', ':old-branch'] })).rejects.toThrow('delete refspecs');
  });

  it('requires a prepared repository', async () => {
    const services = repositoryServices({});
    delete services.state.prepared;
    const tool = createGitTool({ agentRef: {}, repository: services });

    await expect(tool.execute({ args: ['push', 'origin', 'sp/test'] })).rejects.toThrow('has not been prepared');
  });
});

const access: GitHubRepositoryAccess = {
  provider: 'github',
  owner: 'manaflow-ai',
  repo: 'manaflow',
  cloneUrl: 'https://github.com/manaflow-ai/manaflow.git',
  expiresAt: new Date('2026-05-06T01:00:00.000Z'),
  auth: { type: 'bearer', token: 'ghs_secret_token' },
};

function repositoryServices(agentRef: AgentRef): RepositoryToolServices {
  return {
    github: {
      async getRepositoryAccess() {
        return access;
      },
    },
    sandbox: { workspacePath: '/workspace' } as never,
    agentRef,
    state: {
      context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } },
      prepared: {
        repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
        access,
        workspacePath: '/workspace/manaflow',
      },
    },
    emit: async () => {},
    eventBase: { sessionId: 'session-1', runId: 'run-1', messageId: 'message-1' },
  };
}
