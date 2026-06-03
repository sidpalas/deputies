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
        envVars: {
          NODE_ENV: 'test',
          DEPUTIES_SANDBOX_TOKEN: expect.any(String),
          DEPUTIES_WORKSPACE: '/workspace',
          DEPUTIES_SANDBOX_BRIDGE_HOST: '0.0.0.0',
          DEPUTIES_SANDBOX_BRIDGE_PORT: '3584',
        },
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
    expect(handle.secrets?.bridgeToken).toEqual(expect.any(String));

    await expect(handle.exec({ command: 'echo ok', cwd: '/workspace' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'ran: echo ok',
      stderr: '',
    });
    await handle.fs?.writeFile('/workspace/file.txt', 'hello');
    await expect(handle.fs?.readFile('/workspace/file.txt')).resolves.toBe('hello');
    await expect(handle.fs?.readdir('/workspace')).resolves.toEqual(['file.txt']);
  });

  it('converts Daytona exec timeouts from milliseconds to seconds', async () => {
    const sandbox = createMockDaytonaSandbox();
    const calls: unknown[][] = [];
    sandbox.process.executeCommand = async (...args) => {
      calls.push(args);
      return { result: 'ok', exitCode: 0 };
    };
    const provider = new DaytonaSandboxProvider({
      client: {
        async create() {
          return sandbox;
        },
        async get() {
          return sandbox;
        },
      },
    });
    const handle = await provider.create({ sessionId: 'session-1' });

    await handle.exec({ command: 'sleep 5', timeoutMs: 2500 });

    expect(calls).toEqual([['sleep 5', undefined, undefined, 3]]);
  });

  it('does not start Daytona exec when the caller signal is already aborted', async () => {
    const sandbox = createMockDaytonaSandbox();
    sandbox.process.executeCommand = vi.fn(async () => ({ result: 'late', exitCode: 0 }));
    const provider = new DaytonaSandboxProvider({
      client: {
        async create() {
          return sandbox;
        },
        async get() {
          return sandbox;
        },
      },
    });
    const handle = await provider.create({ sessionId: 'session-1' });
    const abort = new AbortController();
    abort.abort();

    await expect(handle.exec({ command: 'sleep 20', signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(sandbox.process.executeCommand).not.toHaveBeenCalled();
  });

  it('rejects Daytona exec when the caller aborts while the SDK command is pending', async () => {
    const sandbox = createMockDaytonaSandbox();
    let resolveCommand: ((value: { result?: string; exitCode?: number }) => void) | undefined;
    const pendingCommand = new Promise<{ result?: string; exitCode?: number }>((resolve) => {
      resolveCommand = resolve;
    });
    sandbox.process.executeCommand = vi.fn(() => pendingCommand);
    const provider = new DaytonaSandboxProvider({
      client: {
        async create() {
          return sandbox;
        },
        async get() {
          return sandbox;
        },
      },
    });
    const handle = await provider.create({ sessionId: 'session-1' });
    const abort = new AbortController();

    const run = handle.exec({ command: 'sleep 20', signal: abort.signal });
    abort.abort();

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(sandbox.process.executeCommand).toHaveBeenCalledWith('sleep 20', undefined, undefined, undefined);
    resolveCommand?.({ result: 'late', exitCode: 0 });
    await pendingCommand;
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

  it('returns Daytona bridge preview URLs with provider and bridge auth headers', async () => {
    const sandbox = createMockDaytonaSandbox();
    const previewPorts: number[] = [];
    sandbox.getPreviewLink = async (port) => {
      previewPorts.push(port);
      return { url: `https://${port}-sandbox.daytona.test`, token: 'preview-token' };
    };
    sandbox.process.executeCommand = vi.fn(async () => ({ result: 'bridge started', exitCode: 0 }));
    const provider = new DaytonaSandboxProvider({
      client: {
        async create() {
          return sandbox;
        },
        async get() {
          return sandbox;
        },
      },
    });

    await expect(
      provider.getPreviewUrl({
        providerSandboxId: 'sandbox-1',
        sessionId: 'session-1',
        port: 3000,
        secrets: { bridgeToken: 'bridge-token' },
      }),
    ).resolves.toEqual({
      port: 3000,
      targetUrl: 'https://3584-sandbox.daytona.test/preview/3000',
      targetHeaders: {
        authorization: 'Bearer bridge-token',
        'x-daytona-preview-token': 'preview-token',
        'x-daytona-skip-preview-warning': 'true',
      },
      preserveTargetHost: true,
      forwardPreviewHost: true,
      secrets: { bridgeToken: 'bridge-token' },
    });
    expect(previewPorts).toEqual([3584]);
    expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining('/opt/deputies/sandbox-bridge/dist/server.js'),
      undefined,
      undefined,
      10,
    );
    expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:3584/health'),
      undefined,
      undefined,
      10,
    );
  });

  it('rejects Daytona bridge preview URLs when the bridge does not become ready', async () => {
    const sandbox = createMockDaytonaSandbox();
    sandbox.getPreviewLink = async (port) => ({ url: `https://${port}-sandbox.daytona.test`, token: 'preview-token' });
    sandbox.process.executeCommand = vi.fn(async () => ({ result: 'bridge failed', exitCode: 1 }));
    const provider = new DaytonaSandboxProvider({
      client: {
        async create() {
          return sandbox;
        },
        async get() {
          return sandbox;
        },
      },
    });

    await expect(
      provider.getPreviewUrl({
        providerSandboxId: 'sandbox-1',
        sessionId: 'session-1',
        port: 3000,
        secrets: { bridgeToken: 'bridge-token' },
      }),
    ).rejects.toThrow('bridge failed');
  });

  it('refreshes activity and extends autostop when keepalive exceeds fallback', async () => {
    const sandbox = createMockDaytonaSandbox();
    sandbox.refreshActivity = vi.fn(async () => {});
    sandbox.setAutostopInterval = vi.fn(async () => {});
    const provider = new DaytonaSandboxProvider({
      idleTimeoutMs: 120_000,
      client: {
        async create() {
          return sandbox;
        },
        async get() {
          return sandbox;
        },
      },
    });

    await provider.refreshKeepalive({ providerSandboxId: 'sandbox-1', sessionId: 'session-1', durationMs: 300_000 });

    expect(sandbox.setAutostopInterval).toHaveBeenCalledWith(5);
    expect(sandbox.refreshActivity).toHaveBeenCalledTimes(1);
  });

  it('refreshes activity without extending autostop when fallback is already long enough', async () => {
    const sandbox = createMockDaytonaSandbox();
    sandbox.refreshActivity = vi.fn(async () => {});
    sandbox.setAutostopInterval = vi.fn(async () => {});
    const provider = new DaytonaSandboxProvider({
      idleTimeoutMs: 600_000,
      client: {
        async create() {
          return sandbox;
        },
        async get() {
          return sandbox;
        },
      },
    });

    await provider.refreshKeepalive({ providerSandboxId: 'sandbox-1', sessionId: 'session-1', durationMs: 300_000 });

    expect(sandbox.setAutostopInterval).not.toHaveBeenCalled();
    expect(sandbox.refreshActivity).toHaveBeenCalledTimes(1);
  });

  it('deletes a created sandbox if handle setup fails and preserves the setup error', async () => {
    const setupError = new Error('workdir unavailable');
    const sandbox = createMockDaytonaSandbox();
    const deleteMock = vi.fn(async () => {});
    sandbox.getWorkDir = async () => {
      throw setupError;
    };
    sandbox.delete = deleteMock;
    const provider = new DaytonaSandboxProvider({
      client: {
        async create() {
          return sandbox;
        },
        async get() {
          return sandbox;
        },
      },
    });

    await expect(provider.create({ sessionId: 'session-1' })).rejects.toBe(setupError);
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the setup error if best-effort created sandbox deletion fails', async () => {
    const setupError = new Error('workdir unavailable');
    const sandbox = createMockDaytonaSandbox();
    sandbox.getWorkDir = async () => {
      throw setupError;
    };
    sandbox.delete = vi.fn(async () => {
      throw new Error('delete failed');
    });
    const provider = new DaytonaSandboxProvider({
      client: {
        async create() {
          return sandbox;
        },
        async get() {
          return sandbox;
        },
      },
    });

    await expect(provider.create({ sessionId: 'session-1' })).rejects.toBe(setupError);
    expect(sandbox.delete).toHaveBeenCalledTimes(1);
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
