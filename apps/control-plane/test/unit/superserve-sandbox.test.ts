import {
  SuperserveSandboxProvider,
  type SuperserveClientLike,
  type SuperserveSandboxLike,
} from '../../src/sandbox/superserve.js';

describe('SuperserveSandboxProvider', () => {
  it('creates a templated sandbox handle with exec and filesystem operations', async () => {
    const sandbox = createMockSuperserveSandbox();
    const createCalls: unknown[] = [];
    const client = createClient(sandbox, {
      async create(options) {
        createCalls.push(options);
        return sandbox;
      },
    });
    const provider = new SuperserveSandboxProvider({
      client,
      template: 'deputies',
      idleTimeoutMs: 900_000,
      workspacePath: '/workspace/custom',
    });

    const handle = await provider.create({ sessionId: 'Session 1', metadata: { owner: 'test', attempt: 2 } });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      fromTemplate: 'deputies',
      timeoutSeconds: 900,
      metadata: { 'deputies-session-id': 'Session 1', owner: 'test', attempt: '2' },
      envVars: {
        DEPUTIES_WORKSPACE: '/workspace/custom',
        DEPUTIES_SANDBOX_BRIDGE_HOST: '0.0.0.0',
        DEPUTIES_SANDBOX_BRIDGE_PORT: '3584',
      },
    });
    expect((createCalls[0] as { name: string }).name).toMatch(/^deputies-session-1-[a-f0-9]{8}$/);
    expect(handle).toMatchObject({
      provider: 'superserve',
      providerSandboxId: 'sandbox-1',
      sessionId: 'Session 1',
      workspacePath: '/workspace/custom',
      metadata: { owner: 'test', attempt: 2, name: 'deputies-session-1', status: 'active' },
      capabilities: { persistentFilesystem: true, snapshots: true, exec: true, filesystem: true, stopStart: true },
      secrets: { bridgeToken: expect.any(String) },
    });

    await expect(
      handle.exec({
        command: 'echo ok',
        cwd: 'subdir',
        env: { TEST_VALUE: 'yes' },
        timeoutMs: 2500,
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'ran: echo ok', stderr: '' });
    expect(sandbox.commandsRun.at(-1)).toMatchObject({
      command: 'echo ok',
      options: { cwd: '/workspace/custom/subdir', env: { TEST_VALUE: 'yes' }, timeoutMs: 2500 },
    });

    await expect(handle.exec({ command: 'cat', stdin: 'input' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'stdin: input',
    });
    expect(sandbox.spawnedStdin).toEqual(['input']);

    await handle.fs?.writeFile('file.txt', 'hello');
    await expect(handle.fs?.readFile('/workspace/custom/file.txt')).resolves.toBe('hello');
    await expect(handle.fs?.readFileBuffer('file.txt')).resolves.toEqual(Buffer.from('hello'));
    await expect(handle.fs?.readdir('.')).resolves.toEqual(['file.txt']);
    await expect(handle.fs?.stat('file.txt')).resolves.toMatchObject({ isFile: true, isDirectory: false, size: 5 });
    await expect(handle.fs?.exists('file.txt')).resolves.toBe(true);
    await expect(handle.fs?.exists('missing.txt')).resolves.toBe(false);
    await expect(handle.fs?.readFile('../outside.txt')).rejects.toThrow('Superserve path escapes workspace');
  });

  it('checks connectivity, maps lifecycle health, and treats missing destroy as idempotent', async () => {
    const sandbox = createMockSuperserveSandbox();
    let status: 'active' | 'paused' | 'resuming' | 'failed' = 'active';
    const killed: string[] = [];
    const client = createClient(sandbox, {
      async list() {
        return [{ id: 'sandbox-1', name: sandbox.name, status, metadata: {} }];
      },
      async killById(id) {
        if (id === 'missing') throw Object.assign(new Error('not found'), { statusCode: 404 });
        killed.push(id);
      },
    });
    const provider = new SuperserveSandboxProvider({ client });

    await expect(provider.check()).resolves.toMatchObject({ status: 'ready' });
    await expect(provider.health({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'ready',
    });
    status = 'paused';
    await expect(provider.health({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'stopped',
    });
    status = 'resuming';
    await expect(provider.health({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'starting',
    });
    status = 'failed';
    await expect(provider.health({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'unhealthy',
    });
    await expect(provider.health({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'missing',
    });

    await provider.stop({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });
    expect(sandbox.pauseCalls).toBe(1);
    await provider.start({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });
    expect(client.connect).toHaveBeenCalledTimes(2);
    await provider.destroy({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });
    await expect(provider.destroy({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toBeUndefined();
    expect(killed).toEqual(['sandbox-1']);
  });

  it('routes Superserve public ports through the authenticated Deputies bridge', async () => {
    const sandbox = createMockSuperserveSandbox();
    const provider = new SuperserveSandboxProvider({
      client: createClient(sandbox),
      workspacePath: '/workspace',
      bridgeSkippedCookieNames: 'deputies_session,deputies_preview',
    });

    await expect(
      provider.getServiceEndpoint({
        providerSandboxId: 'sandbox-1',
        sessionId: 'session-1',
        port: 3000,
        secrets: { bridgeToken: 'bridge-token' },
      }),
    ).resolves.toEqual({
      port: 3000,
      targetUrl: 'https://3584-sandbox-1.preview.superserve.test/preview/3000',
      targetHeaders: { authorization: 'Bearer bridge-token' },
      preserveTargetHost: true,
      forwardPreviewHost: true,
      secrets: { bridgeToken: 'bridge-token' },
    });
    expect(sandbox.previewPorts).toEqual([3584]);
    expect(sandbox.commandsRun.at(-1)).toMatchObject({
      command: expect.stringContaining('/opt/deputies/sandbox-bridge/dist/server.js'),
      options: {
        env: {
          DEPUTIES_SANDBOX_TOKEN: 'bridge-token',
          DEPUTIES_WORKSPACE: '/workspace',
          DEPUTIES_SANDBOX_SKIP_COOKIE_NAMES: 'deputies_session,deputies_preview',
        },
      },
    });
    await expect(
      provider.getServiceEndpoint({ providerSandboxId: 'sandbox-1', sessionId: 'session-1', port: 3584 }),
    ).resolves.toBeNull();
  });
});

type MockSuperserveSandbox = SuperserveSandboxLike & {
  commandsRun: Array<{ command: string; options?: Record<string, unknown> }>;
  pauseCalls: number;
  previewPorts: number[];
  spawnedStdin: string[];
};

function createMockSuperserveSandbox(): MockSuperserveSandbox {
  const files = new Map<string, Uint8Array>();
  const commandsRun: MockSuperserveSandbox['commandsRun'] = [];
  const previewPorts: number[] = [];
  const spawnedStdin: string[] = [];
  const sandbox: MockSuperserveSandbox = {
    id: 'sandbox-1',
    name: 'deputies-session-1',
    status: 'active',
    metadata: {},
    commandsRun,
    pauseCalls: 0,
    previewPorts,
    spawnedStdin,
    commands: {
      async run(command, options) {
        commandsRun.push({ command, ...(options ? { options } : {}) });
        const path = options?.env?.DEPUTIES_PATH;
        if (command.includes('readdirSync')) {
          const prefix = `${path?.replace(/\/$/, '')}/`;
          const entries = Array.from(files.keys())
            .filter((file) => file.startsWith(prefix))
            .map((file) => file.slice(prefix.length).split('/')[0])
            .filter((name, index, all) => name && all.indexOf(name) === index);
          return { exitCode: 0, stdout: JSON.stringify(entries), stderr: '' };
        }
        if (command.includes('lstatSync')) {
          const file = path ? files.get(path) : undefined;
          if (!file) return { exitCode: 1, stdout: '', stderr: 'not found' };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              isFile: true,
              isDirectory: false,
              isSymbolicLink: false,
              size: file.length,
              mtimeMs: 0,
            }),
            stderr: '',
          };
        }
        if (command.includes('existsSync')) {
          return { exitCode: 0, stdout: String(Boolean(path && files.has(path))), stderr: '' };
        }
        return { exitCode: 0, stdout: `ran: ${command}`, stderr: '' };
      },
      async spawn(_command, options) {
        let stdin = '';
        return {
          stdin: {
            write(data) {
              const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
              stdin += text;
              spawnedStdin.push(text);
            },
            close() {},
          },
          async wait() {
            return { exitCode: 0, stdout: `stdin: ${stdin}`, stderr: '' };
          },
          async close() {},
          async [Symbol.asyncDispose]() {},
          kill() {},
          options,
        };
      },
    },
    files: {
      async read(path) {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return file;
      },
      async readText(path) {
        return Buffer.from(await this.read(path)).toString('utf-8');
      },
      async write(path, content) {
        files.set(path, typeof content === 'string' ? Buffer.from(content) : new Uint8Array(content));
      },
    },
    async pause() {
      this.pauseCalls += 1;
    },
    getPreviewUrl(port) {
      previewPorts.push(port);
      return `https://${port}-sandbox-1.preview.superserve.test`;
    },
  };
  return sandbox;
}

function createClient(
  sandbox: MockSuperserveSandbox,
  overrides: Partial<SuperserveClientLike> = {},
): SuperserveClientLike {
  return {
    create: vi.fn(async () => sandbox),
    connect: vi.fn(async () => sandbox),
    list: vi.fn(async () => [{ id: sandbox.id, name: sandbox.name, status: sandbox.status, metadata: {} }]),
    killById: vi.fn(async () => undefined),
    ...overrides,
  };
}
