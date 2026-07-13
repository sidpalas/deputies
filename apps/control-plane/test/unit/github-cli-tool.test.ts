import {
  executeGitHubCliTool,
  type GitHubCliRunner,
  type GitHubCliToolOptions,
} from '../../src/repositories/github-cli-tool.js';
import type { GitHubRepositoryAccess } from '../../src/integrations/github/types.js';
import type { RepositoryToolServices } from '../../src/repositories/tool.js';

describe('GitHub CLI tool', () => {
  it('runs gh with only repository-scoped installation token env and redacts output', async () => {
    const originalSecret = process.env.CONTROL_PLANE_SECRET;
    process.env.CONTROL_PLANE_SECRET = 'do-not-inherit';
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const runner: GitHubCliRunner = async (input) => {
      calls.push({ args: input.args, env: input.env });
      return { exitCode: 0, stdout: `created with ${access.auth.token}`, stderr: '' };
    };
    const tool = createGitHubCliTool(repositoryServices(), { runner });

    let result: string;
    try {
      result = await tool.execute({ args: ['issue', 'create', '--title', 'Test', '--body', 'Body'] });
    } finally {
      if (originalSecret === undefined) delete process.env.CONTROL_PLANE_SECRET;
      else process.env.CONTROL_PLANE_SECRET = originalSecret;
    }

    expect(result).toBe('exitCode: 0\nstdout:\ncreated with [redacted]');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['issue', 'create', '--title', 'Test', '--body', 'Body']);
    expect(calls[0]?.env).toMatchObject({
      GH_TOKEN: 'ghs_secret_token',
      GH_PROMPT_DISABLED: '1',
      GH_REPO: 'manaflow-ai/manaflow',
      NO_COLOR: '1',
    });
    expect(calls[0]?.env.GH_CONFIG_DIR).toContain('deputies-gh-');
    expect(calls[0]?.env.CONTROL_PLANE_SECRET).toBeUndefined();
  });

  it('creates pull requests through the GitHub API', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const createExternalResource = vi.fn(async () => ({}));
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ html_url: 'https://github.com/manaflow-ai/manaflow/pull/7', number: 7 }), {
        status: 201,
      });
    };
    const tool = createGitHubCliTool(repositoryServices(), {
      fetchImpl,
      externalResources: { create: createExternalResource } as never,
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
    });
    const abort = new AbortController();

    const result = await tool.execute(
      {
        args: [
          'pr',
          'create',
          '--title',
          'Add feature',
          '--body',
          '- Details',
          '--head',
          'sp/feature',
          '--base',
          'main',
          '--draft',
        ],
      },
      abort.signal,
    );

    expect(result).toBe('exitCode: 0\nstdout:\nhttps://github.com/manaflow-ai/manaflow/pull/7');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.github.com/repos/manaflow-ai/manaflow/pulls');
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.init.signal).toBe(abort.signal);
    expect(requests[0]?.init.headers).toMatchObject({ authorization: 'Bearer ghs_secret_token' });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      title: 'Add feature',
      body: '- Details',
      head: 'sp/feature',
      base: 'main',
      draft: true,
    });
    expect(createExternalResource).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      type: 'pull_request',
      title: 'Add feature',
      url: 'https://github.com/manaflow-ai/manaflow/pull/7',
      metadata: {
        provider: 'github',
        owner: 'manaflow-ai',
        repo: 'manaflow',
        number: 7,
        branch: 'sp/feature',
        base: 'main',
        draft: true,
      },
    });
  });

  it('creates pull requests with fill/defaults from the prepared repository', async () => {
    const services = repositoryServices();
    services.state.prepared = {
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
      access,
      workspacePath: '/workspace/manaflow',
    };
    services.shell = () => async (command: string) => {
      if (command === 'git log -1 --pretty=format:%s%n%n%b')
        return { exitCode: 0, stdout: 'Filled title\n\nFilled body', stderr: '' };
      if (command === 'git branch --show-current') return { exitCode: 0, stdout: 'sp/filled\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
    };
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/repos/manaflow-ai/manaflow') && init?.method === 'GET') {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      }
      return new Response(JSON.stringify({ html_url: 'https://github.com/manaflow-ai/manaflow/pull/8' }), {
        status: 201,
      });
    };
    const tool = createGitHubCliTool(services, { fetchImpl });

    const result = await tool.execute({ args: ['pr', 'create', '--fill'] });

    expect(result).toContain('/pull/8');
  });

  it('updates pull requests through the GitHub API', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ html_url: 'https://github.com/manaflow-ai/manaflow/pull/7', number: 7 }), {
        status: 200,
      });
    };
    const tool = createGitHubCliTool(repositoryServices(), { fetchImpl });

    const result = await tool.execute({
      args: [
        'pr',
        'edit',
        '7',
        '--title',
        'Updated',
        '--body',
        'New body',
        '--base',
        'develop',
        '--state',
        'open',
        '--no-maintainer-edit',
      ],
    });

    expect(result).toBe('exitCode: 0\nstdout:\nhttps://github.com/manaflow-ai/manaflow/pull/7');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.github.com/repos/manaflow-ai/manaflow/pulls/7');
    expect(requests[0]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      title: 'Updated',
      body: 'New body',
      base: 'develop',
      state: 'open',
      maintainer_can_modify: false,
    });
  });

  it('edits pull requests by resolving the prepared repository branch', async () => {
    const services = repositoryServices();
    services.state.prepared = {
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
      access,
      workspacePath: '/workspace/manaflow',
    };
    services.shell = () => async (command: string) => {
      if (command === 'git branch --show-current') return { exitCode: 0, stdout: 'sp/edit\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
    };
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (String(url).includes('/pulls?')) {
        return new Response(JSON.stringify([{ number: 9 }]), { status: 200 });
      }
      return new Response(JSON.stringify({ html_url: 'https://github.com/manaflow-ai/manaflow/pull/9', number: 9 }), {
        status: 200,
      });
    };
    const tool = createGitHubCliTool(services, { fetchImpl });
    const abort = new AbortController();

    const result = await tool.execute({ args: ['pr', 'edit', '--title', 'Branch update'] }, abort.signal);

    expect(result).toContain('/pull/9');
    expect(requests[0]?.url).toBe(
      'https://api.github.com/repos/manaflow-ai/manaflow/pulls?head=manaflow-ai%3Asp%2Fedit&state=all&per_page=1',
    );
    expect(requests[0]?.init.signal).toBe(abort.signal);
    expect(requests[1]?.url).toBe('https://api.github.com/repos/manaflow-ai/manaflow/pulls/9');
    expect(requests[1]?.init.signal).toBe(abort.signal);
  });

  it('edits pull requests by resolving fork branch selectors', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (String(url).includes('/pulls?')) return new Response(JSON.stringify([{ number: 10 }]), { status: 200 });
      return new Response(JSON.stringify({ html_url: 'https://github.com/manaflow-ai/manaflow/pull/10' }), {
        status: 200,
      });
    };
    const tool = createGitHubCliTool(repositoryServices(), { fetchImpl });

    const result = await tool.execute({ args: ['pr', 'edit', 'fork-user:feature', '--title', 'Fork update'] });

    expect(result).toContain('/pull/10');
    expect(requests[0]?.url).toBe(
      'https://api.github.com/repos/manaflow-ai/manaflow/pulls?head=fork-user%3Afeature&state=all&per_page=1',
    );
  });

  it('rejects auth and clone escape-hatch commands', async () => {
    const tool = createGitHubCliTool(repositoryServices(), {
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(tool.execute({ args: ['auth', 'token'] })).rejects.toThrow('gh auth is not available');
    await expect(tool.execute({ args: ['repo', 'clone', 'manaflow-ai/manaflow'] })).rejects.toThrow(
      'gh repo clone is not available',
    );
    await expect(tool.execute({ args: ['gh', 'issue', 'list'] })).rejects.toThrow('omit the gh executable name');
    await expect(tool.execute({ args: ['api', 'repos/manaflow-ai/manaflow/git/refs/heads/main'] })).rejects.toThrow(
      'GitHub Git Database API routes',
    );
  });

  it('rejects gh commands that can mutate control-plane files', async () => {
    const tool = createGitHubCliTool(repositoryServices(), {
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(tool.execute({ args: ['pr', 'checkout', '7'] })).rejects.toThrow(
      'backend gh cannot mutate control-plane files',
    );
    await expect(tool.execute({ args: ['repo', 'fork'] })).rejects.toThrow(
      'backend gh cannot mutate control-plane files',
    );
    await expect(tool.execute({ args: ['issue', 'develop', '42'] })).rejects.toThrow(
      'backend gh cannot mutate control-plane files',
    );
    await expect(tool.execute({ args: ['pr', 'view', '7', '--web'] })).rejects.toThrow(
      'backend gh cannot mutate control-plane files',
    );
    await expect(tool.execute({ args: ['run', 'download', '123'] })).rejects.toThrow(
      'backend gh cannot mutate control-plane files',
    );
    await expect(tool.execute({ args: ['browse'] })).rejects.toThrow('backend gh cannot mutate control-plane files');
  });

  it('rejects gh commands and options that can read control-plane files', async () => {
    const tool = createGitHubCliTool(repositoryServices(), {
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(
      tool.execute({ args: ['api', 'repos/manaflow-ai/manaflow/issues', '--input', '/etc/passwd'] }),
    ).rejects.toThrow('backend gh cannot read control-plane files');
    await expect(
      tool.execute({ args: ['api', 'repos/manaflow-ai/manaflow/issues', '--field', 'body=@/proc/self/environ'] }),
    ).rejects.toThrow('file expansion is not available');
    await expect(
      tool.execute({ args: ['issue', 'create', '--title', 'Test', '--body-file=/etc/passwd'] }),
    ).rejects.toThrow('backend gh cannot read control-plane files');
    await expect(tool.execute({ args: ['gist', 'create', '/etc/passwd'] })).rejects.toThrow('gh gist is not available');
    await expect(tool.execute({ args: ['release', 'upload', 'v1', '/etc/passwd'] })).rejects.toThrow(
      'gh release is not available',
    );
  });

  it('rejects direct issue and PR comment posting', async () => {
    const tool = createGitHubCliTool(repositoryServices(), {
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(tool.execute({ args: ['issue', 'comment', '42', '--body', 'Done'] })).rejects.toThrow(
      'Posting GitHub issue/PR comments directly through gh is not available',
    );
    await expect(tool.execute({ args: ['pr', 'comment', '42', '--body', 'Done'] })).rejects.toThrow(
      'Posting GitHub issue/PR comments directly through gh is not available',
    );
    await expect(
      tool.execute({
        args: ['api', 'repos/manaflow-ai/manaflow/issues/42/comments', '--method', 'POST', '-f', 'body=Done'],
      }),
    ).rejects.toThrow('Posting GitHub issue/PR comments directly through gh is not available');
    await expect(
      tool.execute({
        args: ['api', '--method=POST', 'repos/manaflow-ai/manaflow/issues/42/comments', '-f', 'body=Done'],
      }),
    ).rejects.toThrow('Posting GitHub issue/PR comments directly through gh is not available');
    await expect(
      tool.execute({
        args: ['api', '-XPOST', 'repos/manaflow-ai/manaflow/pulls/7/reviews', '-f', 'body=Done'],
      }),
    ).rejects.toThrow('Posting GitHub issue/PR comments directly through gh is not available');
    await expect(
      tool.execute({
        args: ['api', '-X', 'POST', 'repos/manaflow-ai/manaflow/pulls/comments/1/replies', '-f', 'body=Done'],
      }),
    ).rejects.toThrow('Posting GitHub issue/PR comments directly through gh is not available');
  });

  it('rejects Git Database API routes even when gh api flags precede the route', async () => {
    const tool = createGitHubCliTool(repositoryServices(), {
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(
      tool.execute({ args: ['api', '--method', 'GET', 'repos/manaflow-ai/manaflow/git/refs/heads/main'] }),
    ).rejects.toThrow('GitHub Git Database API routes');
    await expect(
      tool.execute({ args: ['api', '--paginate', 'repos/manaflow-ai/manaflow/git/refs/heads/main'] }),
    ).rejects.toThrow('GitHub Git Database API routes');
  });

  it('requires an active repository', async () => {
    const services = repositoryServices();
    services.state.context = {};
    const tool = createGitHubCliTool(services, { runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });

    await expect(tool.execute({ args: ['issue', 'list'] })).rejects.toThrow('No active repository is set');
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

function repositoryServices(): RepositoryToolServices {
  return {
    github: {
      async getRepositoryAccess() {
        return access;
      },
    },
    sandbox: { workspacePath: '/workspace' } as never,
    shell: () => undefined,
    state: { context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } } },
    emit: async () => {},
    eventBase: { sessionId: 'session-1', runId: 'run-1', messageId: 'message-1' },
  };
}

function createGitHubCliTool(repository: RepositoryToolServices, options: GitHubCliToolOptions) {
  return {
    execute: (params: Record<string, unknown>, signal?: AbortSignal) =>
      executeGitHubCliTool(repository, options, params, signal),
  };
}
