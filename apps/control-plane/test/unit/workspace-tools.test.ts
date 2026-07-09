import { workspaceTool, workspaceToolWorkingDirectory } from '../../src/app/workspace-tools.js';

describe('workspace tools', () => {
  it('opens Hunk Diff as a one-shot diff viewer', () => {
    const tool = workspaceTool('diff');

    const command = tool?.command({ cwd: '/workspace/repo', workspacePath: '/workspace' });

    expect(command).toContain('command hunk diff');
    expect(command).toContain('git status --porcelain --untracked-files=normal');
    expect(command).not.toContain('--watch');
    expect(command).not.toContain('--exclude-untracked');
  });

  it('uses the active repository workspace for Hunk Diff', () => {
    const tool = workspaceTool('diff');
    expect(tool).toBeTruthy();

    expect(
      workspaceToolWorkingDirectory(
        tool!,
        {
          repository: { provider: 'github', owner: 'acme', repo: 'api' },
        },
        '/workspace',
      ),
    ).toBe('/workspace/acme/api');

    expect(
      workspaceToolWorkingDirectory(
        tool!,
        {
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
        },
        '/workspace',
      ),
    ).toBe('/workspace/acme/api');
  });
});
