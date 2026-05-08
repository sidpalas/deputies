import { sandboxHandleToFlueFactory } from '../../src/runner-flue/sandbox-factory.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';

describe('sandboxHandleToFlueFactory', () => {
  it('adapts a product sandbox handle to Flue SessionEnv', async () => {
    const files = new Map<string, string>();
    const commands: Array<{ command: string; cwd?: string }> = [];
    const handle: SandboxHandle = {
      provider: 'test',
      providerSandboxId: 'sandbox-1',
      sessionId: 'session-1',
      workspacePath: '/workspace',
      metadata: {},
      capabilities: {
        persistentFilesystem: true,
        snapshots: false,
        stopStart: false,
        exec: true,
        filesystem: true,
        streamingLogs: false,
        portForwarding: false,
        objectStorageArtifacts: false,
      },
      fs: {
        async readFile(path) {
          return files.get(path) ?? '';
        },
        async readFileBuffer(path) {
          return Buffer.from(files.get(path) ?? '');
        },
        async writeFile(path, content) {
          files.set(path, typeof content === 'string' ? content : Buffer.from(content).toString('utf-8'));
        },
        async stat() {
          return { isFile: true, isDirectory: false, isSymbolicLink: false, size: 1, mtime: new Date(0) };
        },
        async readdir() {
          return ['file.txt'];
        },
        async exists(path) {
          return files.has(path);
        },
        async mkdir() {},
        async rm(path) {
          files.delete(path);
        },
      },
      async exec(input) {
        const command = { command: input.command };
        if (input.cwd) Object.assign(command, { cwd: input.cwd });
        commands.push(command);
        return { exitCode: 0, stdout: 'ok', stderr: '', startedAt: new Date(0), completedAt: new Date(0) };
      },
    };

    const env = await sandboxHandleToFlueFactory(handle).createSessionEnv({ id: 'session-1', cwd: '/workspace/project' });

    await env.writeFile('file.txt', 'hello');
    expect(await env.readFile('file.txt')).toBe('hello');
    await expect(env.exec('pwd')).resolves.toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    expect(commands).toEqual([{ command: 'pwd', cwd: '/workspace/project' }]);
  });
});
