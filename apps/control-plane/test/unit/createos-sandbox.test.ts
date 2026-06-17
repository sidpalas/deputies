import {
  CreateosSandboxProvider,
  type CreateosClientLike,
  type CreateosExecResult,
  type CreateosSandboxLike,
} from '../../src/sandbox/createos.js';

describe('CreateosSandboxProvider', () => {
  it('creates a named CreateOS sandbox handle with exec and filesystem operations', async () => {
    const sandbox = createMockCreateosSandbox();
    const createCalls: unknown[] = [];
    const client: CreateosClientLike = {
      async create(request) {
        createCalls.push(request);
        return sandbox;
      },
      async get() {
        return sandbox;
      },
      async ready() {
        return true;
      },
    };
    const provider = new CreateosSandboxProvider({
      client,
      shape: 's-4vcpu-4gb',
      rootfs: 'ubuntu24-node24',
      workspacePath: '/workspace/custom',
    });

    const handle = await provider.create({ sessionId: 'session-1', metadata: { owner: 'test' } });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({ shape: 's-4vcpu-4gb', rootfs: 'ubuntu24-node24' });
    const createdName = (createCalls[0] as { name: string }).name;
    expect(createdName).toMatch(/^dep-session-[a-f0-9]{6}$/);
    expect(createdName.length).toBeLessThanOrEqual(22);
    expect(sandbox.commands[0]).toBe("mkdir -p '/workspace/custom'");
    expect(handle).toMatchObject({
      provider: 'createos',
      providerSandboxId: 'sandbox-1',
      sessionId: 'session-1',
      workspacePath: '/workspace/custom',
      metadata: { owner: 'test' },
      capabilities: {
        persistentFilesystem: true,
        exec: true,
        filesystem: true,
        stopStart: true,
        serviceEndpoints: true,
      },
    });

    // exec emulates cwd + env inside the bash -lc script.
    await expect(
      handle.exec({ command: 'echo ok', cwd: '/workspace/custom', env: { FOO: 'bar' }, timeoutMs: 2500 }),
    ).resolves.toMatchObject({ exitCode: 0, stderr: '' });
    expect(sandbox.commands.at(-1)).toBe("cd '/workspace/custom' && export FOO='bar' && echo ok");

    await expect(handle.exec({ command: 'echo default cwd' })).resolves.toMatchObject({ exitCode: 0 });
    expect(sandbox.commands.at(-1)).toBe("cd '/workspace/custom' && echo default cwd");

    await expect(handle.exec({ command: 'echo relative', cwd: 'subdir' })).resolves.toMatchObject({ exitCode: 0 });
    expect(sandbox.commands.at(-1)).toBe("cd '/workspace/custom/subdir' && echo relative");

    await expect(handle.exec({ command: 'cat', stdin: 'input' })).rejects.toThrow(
      'CreateOS exec does not support stdin',
    );
    // cwd is jailed to the workspace.
    await expect(handle.exec({ command: 'ls', cwd: '/tmp/outside' })).rejects.toThrow(
      'CreateOS path escapes workspace',
    );
    await expect(handle.exec({ command: 'ls', cwd: '../escape' })).rejects.toThrow('CreateOS path escapes workspace');
    // env var names must be valid shell identifiers.
    await expect(handle.exec({ command: 'echo hi', env: { 'BAD NAME': 'x' } })).rejects.toThrow('invalid env var name');
    await expect(handle.exec({ command: 'echo hi', env: { 'X=Y; rm -rf /': '1' } })).rejects.toThrow(
      'invalid env var name',
    );

    // filesystem: write/read roundtrip via upload/download, metadata via shell.
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
    await expect(handle.fs?.readFile('/workspace/custom/missing.txt')).rejects.toMatchObject({ statusCode: 404 });
    // absolute and relative paths outside the workspace are both rejected.
    await expect(handle.fs?.readFile('../outside.txt')).rejects.toThrow('CreateOS path escapes workspace');
    await expect(handle.fs?.readFile('/etc/passwd')).rejects.toThrow('CreateOS path escapes workspace');
    await expect(handle.fs?.writeFile('/tmp/outside.txt', 'x')).rejects.toThrow('CreateOS path escapes workspace');
    await expect(handle.fs?.readdir('/tmp')).rejects.toThrow('CreateOS path escapes workspace');
  });

  it('connects, maps lifecycle health, and treats missing destroy as idempotent', async () => {
    const sandbox = createMockCreateosSandbox();
    const destroyed: string[] = [];
    const client: CreateosClientLike = {
      async create() {
        return sandbox;
      },
      async get(id) {
        if (id === 'missing') throw Object.assign(new Error('not found'), { statusCode: 404 });
        return sandbox;
      },
      async ready() {
        return true;
      },
    };
    sandbox.destroy = async () => {
      destroyed.push(sandbox.id);
    };
    const provider = new CreateosSandboxProvider({ client });

    const handle = await provider.connect({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });
    expect(handle.workspacePath).toBe('/workspace');

    sandbox.setStatus('running');
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'ready' });
    sandbox.setStatus('paused');
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'stopped' });
    sandbox.setStatus('creating');
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'starting' });
    sandbox.setStatus('destroyed');
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'missing' });
    sandbox.setStatus('failed');
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'unhealthy' });
    await expect(provider.health({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'missing',
    });

    await provider.destroy({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });
    await expect(provider.destroy({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toBeUndefined();
    expect(destroyed).toEqual(['sandbox-1']);
  });

  it('exposes CreateOS service endpoints from the ingress URL template', async () => {
    const sandbox = createMockCreateosSandbox({ ingressTemplate: 'https://<port>-sandbox-1.sb.example.com' });
    const provider = new CreateosSandboxProvider({
      client: {
        async create() {
          return sandbox;
        },
        async get() {
          return sandbox;
        },
        async ready() {
          return true;
        },
      },
    });

    await expect(
      provider.getServiceEndpoint({ providerSandboxId: 'sandbox-1', sessionId: 'session-1', port: 3000 }),
    ).resolves.toEqual({
      port: 3000,
      targetUrl: 'https://3000-sandbox-1.sb.example.com',
      preserveTargetHost: true,
    });
    expect(sandbox.ingressEnabled).toBe(true);
  });

  it('reports readiness through check() and rejects exec aborted before it starts', async () => {
    const sandbox = createMockCreateosSandbox();
    const createCalls: unknown[] = [];
    let ready = true;
    const provider = new CreateosSandboxProvider({
      client: {
        async create(request) {
          createCalls.push(request);
          return sandbox;
        },
        async get() {
          return sandbox;
        },
        async ready() {
          return ready;
        },
      },
    });

    await expect(provider.check()).resolves.toMatchObject({ status: 'ready' });
    ready = false;
    await expect(provider.check()).resolves.toMatchObject({ status: 'unhealthy' });

    const handle = await provider.create({ sessionId: 'session-1' });
    // shape defaults to s-2vcpu-4gb when none is configured.
    expect(createCalls[0]).toMatchObject({ shape: 's-2vcpu-4gb' });
    const abort = new AbortController();
    abort.abort();
    await expect(handle.exec({ command: 'sleep 20', signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(sandbox.commands.some((command) => command.includes('sleep 20'))).toBe(false);
  });
});

type CreateosSandboxStatus = ReturnType<CreateosSandboxLike['status']>;

type MockCreateosSandbox = CreateosSandboxLike & {
  commands: string[];
  files: Map<string, Uint8Array>;
  ingressEnabled: boolean;
  setStatus(next: CreateosSandboxStatus): void;
};

function createMockCreateosSandbox(input: { ingressTemplate?: string } = {}): MockCreateosSandbox {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['/workspace', '/workspace/custom']);
  const commands: string[] = [];
  let status: CreateosSandboxStatus = 'running';
  let ingressEnabled = false;

  const quoted = (command: string): string[] => [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
  const dirHasChildren = (dir: string): boolean =>
    [...files.keys(), ...dirs].some((path) => path !== dir && path.startsWith(`${dir}/`));

  const sandbox: MockCreateosSandbox = {
    id: 'sandbox-1',
    files,
    commands,
    get ingressEnabled() {
      return ingressEnabled;
    },
    set ingressEnabled(value: boolean) {
      ingressEnabled = value;
    },
    setStatus(next) {
      status = next;
    },
    status: () => status,
    async runCommand(command): Promise<CreateosExecResult> {
      commands.push(command);
      const ok = (stdout = ''): CreateosExecResult => ({ exitCode: 0, stdout, stderr: '' });
      const fail = (stderr = ''): CreateosExecResult => ({ exitCode: 1, stdout: '', stderr });

      if (command.startsWith('mkdir')) {
        const [path] = quoted(command);
        if (path) dirs.add(path);
        return ok();
      }
      if (command.startsWith('ls -1A ')) {
        const [dir] = quoted(command);
        if (!dir || (!dirs.has(dir) && !dirHasChildren(dir))) return fail('no such directory');
        const prefix = `${dir}/`;
        const names = new Set<string>();
        for (const path of [...files.keys(), ...dirs]) {
          if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('/')[0]!);
        }
        return ok([...names].sort().join('\n'));
      }
      if (command.startsWith('stat -c ')) {
        const tokens = quoted(command);
        const path = tokens[1];
        if (path && files.has(path)) return ok(`regular file|${files.get(path)!.length}|1700000000`);
        if (path && (dirs.has(path) || dirHasChildren(path))) return ok(`directory|4096|1700000000`);
        return fail('no such file');
      }
      if (command.startsWith('test -e ')) {
        const [path] = quoted(command);
        return path && (files.has(path) || dirs.has(path) || dirHasChildren(path)) ? ok() : fail();
      }
      if (command.startsWith('rm ')) {
        const tokens = quoted(command);
        const path = tokens.at(-1);
        if (path) {
          files.delete(path);
          dirs.delete(path);
        }
        return ok();
      }
      return ok(`ran: ${command}`);
    },
    async uploadFile(path, data) {
      files.set(path, data);
    },
    async downloadFile(path) {
      const file = files.get(path);
      if (!file) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return file;
    },
    async pause() {
      status = 'paused';
    },
    async resume() {
      status = 'running';
    },
    async destroy() {
      status = 'destroyed';
    },
    async enableIngress() {
      ingressEnabled = true;
      return input.ingressTemplate;
    },
  };
  return sandbox;
}
