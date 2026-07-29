import { workspaceTool } from '../../src/app/workspace-tools.js';

describe('workspace tools', () => {
  it('opens a writable browser terminal at the workspace root', () => {
    const tool = workspaceTool('terminal');

    const command = tool?.command({ cwd: '/workspace', workspacePath: '/workspace' });

    expect(tool).toMatchObject({ id: 'terminal', label: 'Terminal', port: 7681 });
    expect(command).toContain('ttyd -i 0.0.0.0 -p 7681 -W bash -l');
    expect(command).not.toContain('hunk');
  });

  it('does not expose the removed diff workspace tool', () => {
    expect(workspaceTool('diff')).toBeNull();
  });
});
