import { createGitHubCliTool, type GitHubCliRunner } from '../../src/runner-flue/github-cli-tool.js';
import type { GitHubRepositoryAccess } from '../../src/integrations/github/types.js';
import type { RepositoryToolServices } from '../../src/runner-flue/repository-tool.js';

describe('GitHub CLI Flue tool', () => {
  it('runs gh with repository-scoped installation token env and redacts output', async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const runner: GitHubCliRunner = async (input) => {
      calls.push({ args: input.args, env: input.env });
      return { exitCode: 0, stdout: `created with ${access.auth.token}`, stderr: '' };
    };
    const tool = createGitHubCliTool(repositoryServices(), { runner });

    const result = await tool.execute({ args: ['issue', 'create', '--title', 'Test', '--body', 'Body'] });

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
  });

  it('creates pull requests through the GitHub API', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ html_url: 'https://github.com/manaflow-ai/manaflow/pull/7' }), { status: 201 });
    };
    const tool = createGitHubCliTool(repositoryServices(), { fetchImpl });
    const abort = new AbortController();

    const result = await tool.execute({ args: ['pr', 'create', '--title', 'Add feature', '--body', '- Details', '--head', 'sp/feature', '--base', 'main', '--draft'] }, abort.signal);

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
  });

  it('creates pull requests with fill/defaults from the prepared repository', async () => {
    const services = repositoryServices();
    services.state.prepared = {
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
      access,
      workspacePath: '/workspace/manaflow',
    };
    services.agentRef.current = {
      shell: async (command: string) => {
        if (command === 'git log -1 --pretty=format:%s%n%n%b') return { exitCode: 0, stdout: 'Filled title\n\nFilled body', stderr: '' };
        if (command === 'git branch --show-current') return { exitCode: 0, stdout: 'sp/filled\n', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
      },
    } as never;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/repos/manaflow-ai/manaflow') && init?.method === 'GET') {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      }
      return new Response(JSON.stringify({ html_url: 'https://github.com/manaflow-ai/manaflow/pull/8' }), { status: 201 });
    };
    const tool = createGitHubCliTool(services, { fetchImpl });

    const result = await tool.execute({ args: ['pr', 'create', '--fill'] });

    expect(result).toContain('/pull/8');
  });

  it('updates pull requests through the GitHub API', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ html_url: 'https://github.com/manaflow-ai/manaflow/pull/7', number: 7 }), { status: 200 });
    };
    const tool = createGitHubCliTool(repositoryServices(), { fetchImpl });

    const result = await tool.execute({ args: ['pr', 'edit', '7', '--title', 'Updated', '--body', 'New body', '--base', 'develop', '--state', 'open', '--no-maintainer-edit'] });

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
    services.agentRef.current = {
      shell: async (command: string) => {
        if (command === 'git branch --show-current') return { exitCode: 0, stdout: 'sp/edit\n', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
      },
    } as never;
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (String(url).includes('/pulls?')) {
        return new Response(JSON.stringify([{ number: 9 }]), { status: 200 });
      }
      return new Response(JSON.stringify({ html_url: 'https://github.com/manaflow-ai/manaflow/pull/9', number: 9 }), { status: 200 });
    };
    const tool = createGitHubCliTool(services, { fetchImpl });
    const abort = new AbortController();

    const result = await tool.execute({ args: ['pr', 'edit', '--title', 'Branch update'] }, abort.signal);

    expect(result).toContain('/pull/9');
    expect(requests[0]?.url).toBe('https://api.github.com/repos/manaflow-ai/manaflow/pulls?head=manaflow-ai%3Asp%2Fedit&state=all&per_page=1');
    expect(requests[0]?.init.signal).toBe(abort.signal);
    expect(requests[1]?.url).toBe('https://api.github.com/repos/manaflow-ai/manaflow/pulls/9');
    expect(requests[1]?.init.signal).toBe(abort.signal);
  });

  it('rejects auth and clone escape-hatch commands', async () => {
    const tool = createGitHubCliTool(repositoryServices(), { runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });

    await expect(tool.execute({ args: ['auth', 'token'] })).rejects.toThrow('gh auth is not available');
    await expect(tool.execute({ args: ['repo', 'clone', 'manaflow-ai/manaflow'] })).rejects.toThrow('gh repo clone is not available');
    await expect(tool.execute({ args: ['gh', 'issue', 'list'] })).rejects.toThrow('omit the gh executable name');
    await expect(tool.execute({ args: ['api', 'repos/manaflow-ai/manaflow/git/refs/heads/main'] })).rejects.toThrow('GitHub Git Database API routes');
  });

  it('rejects direct issue and PR comment posting', async () => {
    const tool = createGitHubCliTool(repositoryServices(), { runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });

    await expect(tool.execute({ args: ['issue', 'comment', '42', '--body', 'Done'] })).rejects.toThrow('Posting GitHub issue/PR comments directly through gh is not available');
    await expect(tool.execute({ args: ['pr', 'comment', '42', '--body', 'Done'] })).rejects.toThrow('Posting GitHub issue/PR comments directly through gh is not available');
    await expect(tool.execute({ args: ['api', 'repos/manaflow-ai/manaflow/issues/42/comments', '--method', 'POST', '-f', 'body=Done'] })).rejects.toThrow('Posting GitHub issue/PR comments directly through gh is not available');
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
    github: { async getRepositoryAccess() { return access; } },
    sandbox: { workspacePath: '/workspace' } as never,
    agentRef: {},
    state: { context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } } },
    emit: async () => {},
    eventBase: { sessionId: 'session-1', runId: 'run-1', messageId: 'message-1' },
  };
}
