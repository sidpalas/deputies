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

    services.state.context = {
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
      branch: 'old-feature',
    };
    await expect(tool.execute({ action: 'status' })).resolves.toContain('Active repository: manaflow-ai/manaflow');

    services.state.context = {
      environment: {
        id: 'env-1',
        name: 'Product surface',
        codebase: {
          repositories: [
            { provider: 'github', owner: 'manaflow-ai', repo: 'web', primary: false },
            { provider: 'github', owner: 'manaflow-ai', repo: 'api', primary: true },
          ],
        },
      },
    };
    await expect(tool.execute({ action: 'status' })).resolves.toContain('Active repository: manaflow-ai/api');
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

    const result = await tool.execute({
      action: 'set',
      owner: 'manaflow-ai',
      repo: 'manaflow',
      reason: 'User mentioned the app',
    });

    expect(result).toContain('Active repository set to manaflow-ai/manaflow');
    expect(result).toContain('use repository({ action: "prepare" }) now');
    expect(updates).toEqual([{ repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } }]);
    expect(services.state.context).toEqual({
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
    });
  });

  it('clears environment context when setting a direct repository', async () => {
    const updates: Record<string, unknown>[] = [];
    const services = repositoryServices({
      updateSessionContext: async (context) => {
        updates.push(context);
        return context;
      },
    });
    services.state.context = {
      environment: {
        id: 'env-1',
        name: 'Product surface',
        codebase: {
          repositories: [{ provider: 'github', owner: 'manaflow-ai', repo: 'api', primary: true }],
        },
      },
      environmentBranchOverrides: [{ provider: 'github', owner: 'manaflow-ai', repo: 'api', branch: 'release' }],
    };
    const tool = createRepositoryTool(services);

    await tool.execute({ action: 'set', owner: 'manaflow-ai', repo: 'manaflow' });

    expect(updates).toEqual([{ repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } }]);
    expect(services.state.context).toEqual({
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
    });
  });

  it('clears prepared state when changing repositories', async () => {
    const services = repositoryServices();
    services.state.context = { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } };
    services.state.prepared = {
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
      access,
      workspacePath: '/workspace/manaflow-ai/manaflow',
    };
    services.github = {
      async getRepositoryAccess(repository) {
        return { ...access, owner: repository.owner, repo: repository.repo };
      },
    };
    const tool = createRepositoryTool(services);

    await tool.execute({ action: 'set', owner: 'manaflow-ai', repo: 'other-repo' });

    expect(services.state.context).toEqual({
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'other-repo' },
    });
    expect(services.state.prepared).toBeUndefined();
  });

  it('prepares the active repository inside the sandbox', async () => {
    const shells: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = [];
    const events: NormalizedEvent[] = [];
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
          return { exitCode: 0, stdout: 'prepared', stderr: '' };
        },
      },
    };
    const services = repositoryServices({
      agentRef,
      emit: async (event) => {
        events.push(event);
      },
    });
    services.state.context = { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } };
    const tool = createRepositoryTool(services);

    const result = await tool.execute({ action: 'prepare' });

    expect(result).toContain('Workspace path: /workspace/manaflow-ai/manaflow');
    expect(shells).toHaveLength(1);
    expect(shells[0]?.cwd).toBe('/workspace');
    expect(shells[0]?.command).toContain(
      'git -c \'http.https://github.com/manaflow-ai/manaflow.git.extraHeader\'="$auth_header" -c core.hooksPath=/dev/null clone',
    );
    expect(shells[0]?.command).toContain('unset GITHUB_AUTH_HEADER');
    expect(shells[0]?.command).toContain('export GIT_CONFIG_GLOBAL=/dev/null');
    expect(shells[0]?.command).toContain('export GIT_CONFIG_SYSTEM=/dev/null');
    expect(shells[0]?.command).toContain('default_branch="$(git -C');
    expect(shells[0]?.command).toContain('status --porcelain --untracked-files=normal --ignore-submodules');
    expect(shells[0]?.command).toContain('preserving checkout instead of switching branches');
    expect(shells[0]?.command).toContain('git -c core.hooksPath=/dev/null');
    expect(shells[0]?.command).toContain('checkout -B "$default_branch" "origin/$default_branch"');
    expect(shells[0]?.command).toContain("git -C '/workspace/manaflow-ai/manaflow' config user.name 'DevDeputies'");
    expect(shells[0]?.command).toContain(
      "git -C '/workspace/manaflow-ai/manaflow' config user.email 'devdeputies@users.noreply.github.com'",
    );
    expect(shells[0]?.command).not.toContain('ghs_secret_token');
    expect(shells[0]?.env).toEqual({
      GITHUB_AUTH_HEADER: `Authorization: Basic ${Buffer.from('x-access-token:ghs_secret_token').toString('base64')}`,
    });
    expect(services.state.prepared?.workspacePath).toBe('/workspace/manaflow-ai/manaflow');
    expect(events.map((event) => event.type)).toEqual(['repository_ready']);
  });

  it('runs repository setup scripts during prepare and reports the outcome', async () => {
    const shells: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = [];
    const execCalls: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = [];
    const events: NormalizedEvent[] = [];
    const shellResponses = [{ exitCode: 0, stdout: 'prepared\ndeputies-repo-setup:cloned=1\n', stderr: '' }];
    const execResponses = [
      { exitCode: 0, stdout: 'deputies-setup:run reason=cloned hash=abc123 exec=0\n', stderr: '' },
      { exitCode: 0, stdout: 'setup ok', stderr: '' },
    ];
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
          return shellResponses.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    };
    const services = repositoryServices({
      agentRef,
      sandbox: {
        workspacePath: '/workspace',
        async exec(input: { command: string; cwd?: string; env?: Record<string, string> }) {
          const call: { command: string; cwd?: string; env?: Record<string, string> } = { command: input.command };
          if (input.cwd) call.cwd = input.cwd;
          if (input.env) call.env = input.env;
          execCalls.push(call);
          const now = new Date();
          return {
            ...(execResponses.shift() ?? { exitCode: 0, stdout: '', stderr: '' }),
            startedAt: now,
            completedAt: now,
          };
        },
      } as never,
      setupScript: { enabled: true, timeoutMs: 600_000 },
      emit: async (event) => {
        events.push(event);
      },
    });
    services.state.context = { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } };
    const tool = createRepositoryTool(services);

    const result = await tool.execute({ action: 'prepare' });

    expect(result).toContain('Setup script: ran successfully');
    expect(shells).toHaveLength(1);
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]?.cwd).toBe('/workspace/manaflow-ai/manaflow');
    expect(execCalls[1]?.env).toEqual({ DEPUTIES: '1', DEPUTIES_SETUP: '1' });
    expect(execCalls[1]?.command).toContain('bash "$setup_file"');
    expect(events.map((event) => event.type)).toEqual([
      'repository_ready',
      'setup_script_started',
      'setup_script_finished',
    ]);
  });

  it('returns repository prepare results when setup scripts fail', async () => {
    const shellResponses = [{ exitCode: 0, stdout: 'prepared\ndeputies-repo-setup:cloned=1\n', stderr: '' }];
    const execResponses = [
      { exitCode: 0, stdout: 'deputies-setup:run reason=cloned hash=abc123 exec=1\n', stderr: '' },
      { exitCode: 1, stdout: 'bad stdout', stderr: 'bad stderr' },
    ];
    const agentRef: AgentRef = {
      current: {
        async session() {
          throw new Error('not used');
        },
        async shell() {
          return shellResponses.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    };
    const services = repositoryServices({
      agentRef,
      sandbox: {
        workspacePath: '/workspace',
        async exec() {
          const now = new Date();
          return {
            ...(execResponses.shift() ?? { exitCode: 0, stdout: '', stderr: '' }),
            startedAt: now,
            completedAt: now,
          };
        },
      } as never,
      setupScript: { enabled: true, timeoutMs: 600_000 },
    });
    services.state.context = { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } };
    const tool = createRepositoryTool(services);

    const result = await tool.execute({ action: 'prepare' });

    expect(result).toContain('Repository prepared: manaflow-ai/manaflow');
    expect(result).toContain('Setup script: FAILED (exit 1)');
    expect(result).toContain('bad stdout\nbad stderr');
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
      async getRepositoryAccess() {
        return access;
      },
      listAllowedRepositories() {
        return ['manaflow-ai/manaflow'];
      },
    },
    sandbox: { workspacePath: '/workspace' } as never,
    agentRef: {},
    state: { context: {} },
    emit: async () => {},
    eventBase: { sessionId: 'session-1', runId: 'run-1', messageId: 'message-1' },
    ...overrides,
  };
}
