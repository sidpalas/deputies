import { createGitHubCliTool, type GitHubCliRunner } from '../../src/runner-flue/github-cli-tool.js';
import type { GitHubRepositoryAccess } from '../../src/integrations/github/types.js';

describe('GitHub CLI Flue tool', () => {
  it('runs gh with repository-scoped installation token env and redacts output', async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const runner: GitHubCliRunner = async (input) => {
      calls.push({ args: input.args, env: input.env });
      return { exitCode: 0, stdout: `created with ${access.auth.token}`, stderr: '' };
    };
    const tool = createGitHubCliTool(access, { runner });

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
    expect(calls[0]?.env.GH_CONFIG_DIR).toContain('dev-deputies-gh-');
  });

  it('rejects auth and clone escape-hatch commands', async () => {
    const tool = createGitHubCliTool(access, { runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });

    await expect(tool.execute({ args: ['auth', 'token'] })).rejects.toThrow('gh auth is not available');
    await expect(tool.execute({ args: ['repo', 'clone', 'manaflow-ai/manaflow'] })).rejects.toThrow('gh repo clone is not available');
    await expect(tool.execute({ args: ['gh', 'issue', 'list'] })).rejects.toThrow('omit the gh executable name');
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
