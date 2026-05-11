import { DaytonaSandboxProvider, type DaytonaClientLike, type DaytonaSandboxLike } from '../../src/sandbox/daytona.js';

describe('DaytonaSandboxProvider', () => {
  it('creates a Daytona sandbox handle with exec and filesystem operations', async () => {
    const sandbox = createMockDaytonaSandbox();
    const createCalls: unknown[] = [];
    const client: DaytonaClientLike = {
      async create(params) {
        createCalls.push(params);
        return sandbox;
      },
      async get() {
        return sandbox;
      },
    };

    const provider = new DaytonaSandboxProvider({
      client,
      image: 'ubuntu:latest',
      idleTimeoutMs: 900_000,
      envVars: { NODE_ENV: 'test' },
      labels: { app: 'flue-bg-agents' },
    });
    const handle = await provider.create({ sessionId: 'session-1', metadata: { owner: 'test' } });

    expect(createCalls).toEqual([
      {
        image: 'ubuntu:latest',
        autoStopInterval: 15,
        envVars: { NODE_ENV: 'test' },
        labels: { app: 'flue-bg-agents', 'flue-session-id': 'session-1' },
      },
    ]);
    expect(handle).toMatchObject({
      provider: 'daytona',
      providerSandboxId: 'sandbox-1',
      sessionId: 'session-1',
      workspacePath: '/workspace',
      metadata: { owner: 'test', target: 'us', state: 'started' },
      capabilities: { persistentFilesystem: true, exec: true, filesystem: true },
    });

    await expect(handle.exec({ command: 'echo ok', cwd: '/workspace' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'ran: echo ok',
      stderr: '',
    });
    await handle.fs?.writeFile('/workspace/file.txt', 'hello');
    await expect(handle.fs?.readFile('/workspace/file.txt')).resolves.toBe('hello');
    await expect(handle.fs?.readdir('/workspace')).resolves.toEqual(['file.txt']);
  });

  it('connects, reports health, and treats missing destroy as idempotent', async () => {
    const sandbox = createMockDaytonaSandbox();
    const client: DaytonaClientLike = {
      async create() {
        return sandbox;
      },
      async get(id) {
        if (id === 'missing') throw Object.assign(new Error('not found'), { statusCode: 404 });
        return sandbox;
      },
    };
    const provider = new DaytonaSandboxProvider({ client });

    const handle = await provider.connect({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });

    expect(handle.workspacePath).toBe('/workspace');
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'ready' });
    await expect(provider.health({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(provider.destroy({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toBeUndefined();
  });
});

function createMockDaytonaSandbox(): DaytonaSandboxLike {
  const files = new Map<string, Buffer>();
  return {
    id: 'sandbox-1',
    state: 'started',
    target: 'us',
    async getWorkDir() {
      return '/workspace';
    },
    async start() {},
    async stop() {},
    async delete() {},
    fs: {
      async downloadFile(path) {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return file;
      },
      async uploadFile(content, path) {
        files.set(path, content);
      },
      async getFileDetails(path) {
        if (!files.has(path)) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return { isDir: false, size: files.get(path)?.length ?? 0, modTime: '2026-05-05T00:00:00.000Z' };
      },
      async listFiles(path) {
        const prefix = path.endsWith('/') ? path : `${path}/`;
        return Array.from(files.keys())
          .filter((file) => file.startsWith(prefix))
          .map((file) => file.slice(prefix.length).split('/')[0])
          .filter((name): name is string => Boolean(name))
          .map((name) => ({ name }));
      },
      async createFolder() {},
      async deleteFile(path) {
        files.delete(path);
      },
    },
    process: {
      async executeCommand(command) {
        return { result: `ran: ${command}`, exitCode: 0 };
      },
    },
  };
}
