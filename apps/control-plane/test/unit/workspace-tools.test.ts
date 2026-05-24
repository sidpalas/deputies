import { workspaceTool } from '../../src/app/workspace-tools.js';

describe('workspace tools', () => {
  it('opens Hunk Diff as a one-shot diff viewer', () => {
    const tool = workspaceTool('diff');

    const command = tool?.command({ cwd: '/workspace/repo', workspacePath: '/workspace' });

    expect(command).toContain('command hunk diff');
    expect(command).toContain('git status --porcelain --untracked-files=normal');
    expect(command).not.toContain('--watch');
    expect(command).not.toContain('--exclude-untracked');
  });
});
