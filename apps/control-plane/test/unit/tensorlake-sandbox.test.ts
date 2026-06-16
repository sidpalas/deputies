import { SandboxStatus } from 'tensorlake';
import {
  TensorlakeSandboxProvider,
  type TensorlakeClientLike,
  type TensorlakeSandboxLike,
} from '../../src/sandbox/tensorlake.js';

describe('TensorlakeSandboxProvider', () => {
  it('creates a named Tensorlake sandbox handle with exec and filesystem operations', async () => {
    const sandbox = createMockTensorlakeSandbox();
    const createCalls: unknown[] = [];
    const client: TensorlakeClientLike = {
      async createAndConnect(options) {
        createCalls.push(options);
        return sandbox;
      },
      async connect() {
        return sandbox;
      },
      async list() {
        return [await sandbox.info()];
      },
      async get() {
        return sandbox.info();
      },
      async update(_id, options) {
        return sandbox.update(options);
      },
      async delete() {},
      async suspend() {},
      async resume() {},
    };
    const provider = new TensorlakeSandboxProvider({
      client,
      image: 'deputies-daytona-sandbox-ubuntu24-node24',
      idleTimeoutMs: 900_000,
      workspacePath: '/workspace/custom',
      cpus: 2,
      memoryMb: 4096,
      diskMb: 20480,
      allowInternetAccess: false,
    });

    const handle = await provider.create({ sessionId: 'session-1', metadata: { owner: 'test' } });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      image: 'deputies-daytona-sandbox-ubuntu24-node24',
      timeoutSecs: 900,
      cpus: 2,
      memoryMb: 4096,
      diskMb: 20480,
      allowInternetAccess: false,
    });
    expect((createCalls[0] as { name: string }).name).toMatch(/^deputies-session-1-[a-f0-9]{8}$/);
    expect(sandbox.commands[0]).toMatchObject({ command: 'bash', args: ['-lc', "mkdir -p '/workspace/custom'"] });
    expect(handle).toMatchObject({
      provider: 'tensorlake',
      providerSandboxId: 'sandbox-1',
      sessionId: 'session-1',
      workspacePath: '/workspace/custom',
      metadata: {
        owner: 'test',
        name: 'deputies-session-1',
        status: SandboxStatus.RUNNING,
        image: 'deputies-daytona-sandbox-ubuntu24-node24',
      },
      capabilities: { persistentFilesystem: true, exec: true, filesystem: true, stopStart: true },
    });

    await expect(handle.exec({ command: 'echo ok', cwd: '/workspace/custom', timeoutMs: 2500 })).resolves.toMatchObject(
      {
        exitCode: 0,
        stdout: 'ran: echo ok',
        stderr: '',
      },
    );
    expect(sandbox.commands.at(-1)).toMatchObject({
      command: 'bash',
      args: ['-lc', 'echo ok'],
      workingDir: '/workspace/custom',
      timeout: 3,
    });

    await expect(handle.exec({ command: 'echo default cwd' })).resolves.toMatchObject({ exitCode: 0 });
    expect(sandbox.commands.at(-1)).toMatchObject({
      command: 'bash',
      args: ['-lc', 'echo default cwd'],
      workingDir: '/workspace/custom',
    });

    await expect(handle.exec({ command: 'echo relative cwd', cwd: 'subdir' })).resolves.toMatchObject({ exitCode: 0 });
    expect(sandbox.commands.at(-1)).toMatchObject({
      command: 'bash',
      args: ['-lc', 'echo relative cwd'],
      workingDir: '/workspace/custom/subdir',
    });

    await expect(handle.exec({ command: 'cat', stdin: 'input' })).rejects.toThrow(
      'Tensorlake exec does not support stdin',
    );

    await handle.fs?.writeFile('/workspace/custom/file.txt', 'hello');
    await expect(handle.fs?.readFile('/workspace/custom/file.txt')).resolves.toBe('hello');
    await handle.fs?.writeFile('relative.txt', 'relative');
    await expect(handle.fs?.readFile('/workspace/custom/relative.txt')).resolves.toBe('relative');
    await expect(handle.fs?.readdir('/workspace/custom')).resolves.toEqual(['file.txt', 'relative.txt']);
    await expect(handle.fs?.stat('/workspace/custom/file.txt')).resolves.toMatchObject({
      isFile: true,
      isDirectory: false,
      size: 5,
    });
    await expect(handle.fs?.exists('/workspace/custom/missing.txt')).resolves.toBe(false);
    await expect(handle.fs?.readFile('../outside.txt')).rejects.toThrow('Tensorlake path escapes workspace');
  });

  it('connects, maps lifecycle health, and treats missing destroy as idempotent', async () => {
    const sandbox = createMockTensorlakeSandbox();
    const deleted: string[] = [];
    let status = SandboxStatus.RUNNING;
    const client: TensorlakeClientLike = {
      async createAndConnect() {
        return sandbox;
      },
      async connect() {
        return sandbox;
      },
      async list() {
        return [];
      },
      async get(id) {
        if (id === 'missing') throw Object.assign(new Error('not found'), { statusCode: 404 });
        return { ...(await sandbox.info()), status };
      },
      async update(_id, options) {
        return sandbox.update(options);
      },
      async delete(id) {
        if (id === 'missing') throw Object.assign(new Error('not found'), { statusCode: 404 });
        deleted.push(id);
      },
      async suspend() {
        status = SandboxStatus.SUSPENDED;
      },
      async resume() {
        status = SandboxStatus.RUNNING;
      },
    };
    const provider = new TensorlakeSandboxProvider({ client });

    const handle = await provider.connect({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });

    expect(handle.workspacePath).toBe('/workspace');
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'ready' });
    status = SandboxStatus.SUSPENDED;
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'stopped' });
    status = SandboxStatus.PENDING;
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'starting' });
    status = SandboxStatus.TERMINATED;
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'missing' });
    await expect(provider.health({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'missing',
    });

    await provider.destroy({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });
    await expect(provider.destroy({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toBeUndefined();
    expect(deleted).toEqual(['sandbox-1']);
  });

  it('exposes authenticated Tensorlake service endpoints through the Deputies proxy', async () => {
    const sandbox = createMockTensorlakeSandbox({ ingressEndpoint: 'https://sandbox.tensorlake.ai' });
    const provider = new TensorlakeSandboxProvider({
      apiKey: 'tensorlake-key',
      client: {
        async createAndConnect() {
          return sandbox;
        },
        async connect() {
          return sandbox;
        },
        async list() {
          return [await sandbox.info()];
        },
        async get() {
          return sandbox.info();
        },
        async update(_id, options) {
          return sandbox.update(options);
        },
        async delete() {},
        async suspend() {},
        async resume() {},
      },
    });

    await expect(
      provider.getServiceEndpoint({ providerSandboxId: 'sandbox-1', sessionId: 'session-1', port: 3000 }),
    ).resolves.toEqual({
      port: 3000,
      targetUrl: 'https://3000-sandbox-1.sandbox.tensorlake.ai',
      targetHeaders: { authorization: 'Bearer tensorlake-key' },
      preserveTargetHost: true,
    });
    expect(sandbox.updates).toEqual([{ exposedPorts: [3000], allowUnauthenticatedAccess: false }]);
  });

  it('rejects Tensorlake exec when the caller aborts before the SDK command starts', async () => {
    const sandbox = createMockTensorlakeSandbox();
    const provider = new TensorlakeSandboxProvider({
      client: {
        async createAndConnect() {
          return sandbox;
        },
        async connect() {
          return sandbox;
        },
        async list() {
          return [await sandbox.info()];
        },
        async get() {
          return sandbox.info();
        },
        async update(_id, options) {
          return sandbox.update(options);
        },
        async delete() {},
        async suspend() {},
        async resume() {},
      },
    });
    const handle = await provider.create({ sessionId: 'session-1' });
    const abort = new AbortController();
    abort.abort();

    await expect(handle.exec({ command: 'sleep 20', signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(sandbox.commands.some((command) => command.args?.[1] === 'sleep 20')).toBe(false);
  });
});

type MockTensorlakeSandbox = TensorlakeSandboxLike & {
  commands: Array<{ command: string; args?: string[]; workingDir?: string; timeout?: number }>;
  updates: Array<{ exposedPorts?: number[]; allowUnauthenticatedAccess?: boolean }>;
};

function createMockTensorlakeSandbox(input: { ingressEndpoint?: string } = {}): MockTensorlakeSandbox {
  const files = new Map<string, Uint8Array>();
  const commands: MockTensorlakeSandbox['commands'] = [];
  const updates: MockTensorlakeSandbox['updates'] = [];
  let exposedPorts: number[] = [];
  const sandbox: MockTensorlakeSandbox = {
    sandboxId: 'sandbox-1',
    name: 'deputies-session-1',
    commands,
    updates,
    async info() {
      const info = {
        sandboxId: 'sandbox-1',
        namespace: 'default',
        status: SandboxStatus.RUNNING,
        image: 'deputies-daytona-sandbox-ubuntu24-node24',
        resources: { cpus: 2, memoryMb: 4096, ephemeralDiskMb: 20480 },
        name: 'deputies-session-1',
        exposedPorts,
      };
      if (input.ingressEndpoint) Object.assign(info, { ingressEndpoint: input.ingressEndpoint });
      return info;
    },
    async update(options) {
      updates.push(options);
      exposedPorts = options.exposedPorts ?? exposedPorts;
      return this.info();
    },
    async run(command, options) {
      commands.push({ command, ...options });
      return { exitCode: 0, stdout: `ran: ${options?.args?.[1] ?? command}`, stderr: '' };
    },
    async readFile(path) {
      const file = files.get(path);
      if (!file) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return file;
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async deleteFile(path) {
      files.delete(path);
    },
    async listDirectory(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const entries = Array.from(files.entries())
        .filter(([file]) => file.startsWith(prefix))
        .map(([file, content]) => ({
          name: file.slice(prefix.length).split('/')[0]!,
          isDir: false,
          size: content.length,
        }))
        .filter(
          (entry, index, all) => entry.name && all.findIndex((candidate) => candidate.name === entry.name) === index,
        );
      return { entries };
    },
  };
  return sandbox;
}
