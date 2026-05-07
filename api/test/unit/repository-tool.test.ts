import { createRepositoryTool, type RepositoryToolServices } from '../../src/runner-flue/repository-tool.js';
import type { AgentRef } from '../../src/runner-flue/git-tool.js';
import type { GitHubRepositoryAccess } from '../../src/integrations/github/types.js';
import type { NormalizedEvent } from '../../src/events/types.js';

describe('repository Flue tool', () => {
  it('reports current repository status and allowed repositories', async () => {
    const services = repositoryServices();
    const tool = createRepositoryTool(services);

    await expect(tool.execute({ action: 'status' })).resolves.toContain('No active repository is set');
    await expect(tool.execute({ action: 'list' })).resolves.toContain('- manaflow-ai/manaflow');

    services.state.context = { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } };
    await expect(tool.execute({ action: 'status' })).resolves.toContain('Active repository: manaflow-ai/manaflow');
  });

  it('sets validated session repository context', async () => {
    const updates: Record<string, unknown>[] = [];
    const services = repositoryServices({
      updateSessionContext: async (context) => {
        updates.push(context);
        return context;
      },
    });
    const tool = createRepositoryTool(services);

    const result = await tool.execute({ action: 'set', owner: 'manaflow-ai', repo: 'manaflow', reason: 'User mentioned the app' });

    expect(result).toContain('Active repository set to manaflow-ai/manaflow');
    expect(updates).toEqual([{ repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } }]);
    expect(services.state.context).toEqual({ repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } });
  });

  it('clears prepared state when changing repositories', async () => {
    const services = repositoryServices();
    services.state.context = { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } };
    services.state.prepared = {
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
      access,
      workspacePath: '/workspace/manaflow',
    };
    services.github = { async getRepositoryAccess(repository) { return { ...access, owner: repository.owner, repo: repository.repo }; } };
    const tool = createRepositoryTool(services);

    await tool.execute({ action: 'set', owner: 'manaflow-ai', repo: 'other-repo' });

    expect(services.state.context).toEqual({ repository: { provider: 'github', owner: 'manaflow-ai', repo: 'other-repo' } });
    expect(services.state.prepared).toBeUndefined();
  });

  it('prepares the active repository inside the sandbox', async () => {
    const shells: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = [];
    const events: NormalizedEvent[] = [];
    const agentRef: AgentRef = {
      current: {
        async session() { throw new Error('not used'); },
        async shell(command, options) {
          const shell: { command: string; cwd?: string; env?: Record<string, string> } = { command };
          if (options?.cwd) shell.cwd = options.cwd;
          if (options?.env) shell.env = options.env;
          shells.push(shell);
          return { exitCode: 0, stdout: 'prepared', stderr: '' };
        },
      },
    };
    const services = repositoryServices({ agentRef, emit: async (event) => { events.push(event); } });
    services.state.context = { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } };
    const tool = createRepositoryTool(services);

    const result = await tool.execute({ action: 'prepare' });

    expect(result).toContain('Workspace path: /workspace/manaflow');
    expect(shells[0]?.cwd).toBe('/workspace');
    expect(shells[0]?.command).toContain('git -c http.extraHeader="$GITHUB_AUTH_HEADER" clone');
    expect(shells[0]?.command).not.toContain('ghs_secret_token');
    expect(shells[0]?.env).toEqual({
      GITHUB_AUTH_HEADER: `Authorization: Basic ${Buffer.from('x-access-token:ghs_secret_token').toString('base64')}`,
    });
    expect(services.state.prepared?.workspacePath).toBe('/workspace/manaflow');
    expect(events.map((event) => event.type)).toEqual(['repository_ready']);
  });

  it('requires an active repository before prepare', async () => {
    const tool = createRepositoryTool(repositoryServices());

    await expect(tool.execute({ action: 'prepare' })).rejects.toThrow('No active repository is set');
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

function repositoryServices(overrides: Partial<RepositoryToolServices> = {}): RepositoryToolServices {
  return {
    github: {
      async getRepositoryAccess() { return access; },
      listAllowedRepositories() { return ['manaflow-ai/manaflow']; },
    },
    sandbox: { workspacePath: '/workspace' } as never,
    agentRef: {},
    state: { context: {} },
    emit: async () => {},
    eventBase: { sessionId: 'session-1', runId: 'run-1', messageId: 'message-1' },
    ...overrides,
  };
}
