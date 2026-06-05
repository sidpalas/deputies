import { basename, dirname } from 'node:path/posix';
import {
  OpenComputerSandboxProvider,
  type OpenComputerClientLike,
  type OpenComputerCreateSandboxOptions,
  type OpenComputerSandboxLike,
} from '../../src/sandbox/opencomputer.js';

describe('OpenComputerSandboxProvider', () => {
  const clearProxyCommand = 'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy';

  it('creates an OpenComputer sandbox handle with exec and filesystem operations', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const createCalls: unknown[] = [];
    const client: OpenComputerClientLike = {
      async create(params) {
        createCalls.push(params);
        return sandbox;
      },
      async connect() {
        return sandbox;
      },
    };

    const provider = new OpenComputerSandboxProvider({
      client,
      snapshot: 'deputies-base',
      idleTimeoutMs: 15_000,
      envVars: { NODE_ENV: 'test' },
      metadata: { app: 'flue-bg-agents' },
      cpuCount: 2,
      memoryMB: 8192,
      diskMB: 40960,
    });
    const handle = await provider.create({ sessionId: 'session-1', metadata: { owner: 'test' } });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      snapshot: 'deputies-base',
      timeout: 15,
      envs: {
        NODE_ENV: 'test',
        DEPUTIES_WORKSPACE: '/workspace',
        DEPUTIES_SANDBOX_BRIDGE_HOST: '0.0.0.0',
        DEPUTIES_SANDBOX_BRIDGE_PORT: '3584',
      },
      metadata: { app: 'flue-bg-agents', 'deputies-session-id': 'session-1' },
      cpuCount: 2,
      memoryMB: 8192,
      diskMB: 40960,
    });
    expect(handle).toMatchObject({
      provider: 'opencomputer',
      providerSandboxId: 'sandbox-1',
      sessionId: 'session-1',
      workspacePath: '/workspace',
      metadata: { owner: 'test', status: 'running', domain: 'sandbox-1-p80.workers.opencomputer.test' },
      secrets: { bridgeToken: expect.any(String) },
      capabilities: { persistentFilesystem: true, exec: true, filesystem: true, serviceEndpoints: true },
    });

    sandbox.execCalls.length = 0;
    await expect(handle.exec({ command: 'echo ok', cwd: '/workspace' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('echo ok'),
      stderr: '',
    });
    expect(sandbox.execCalls).toEqual([{ command: `${clearProxyCommand}; echo ok`, opts: { cwd: '/workspace' } }]);

    await handle.fs?.writeFile('/workspace/file.txt', 'hello');
    await expect(handle.fs?.readFile('/workspace/file.txt')).resolves.toBe('hello');
    await expect(handle.fs?.readdir('/workspace')).resolves.toEqual(['file.txt']);
    await expect(handle.fs?.stat('/workspace/file.txt')).resolves.toMatchObject({
      isFile: true,
      isDirectory: false,
      size: 5,
    });
  });

  it('converts OpenComputer exec timeouts from milliseconds to seconds', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });
    const handle = await provider.create({ sessionId: 'session-1' });
    sandbox.execCalls.length = 0;

    await handle.exec({ command: 'sleep 5', timeoutMs: 2500 });

    expect(sandbox.execCalls).toEqual([
      { command: `${clearProxyCommand}; sleep 5`, opts: { cwd: '/workspace', timeout: 3 } },
    ]);
  });

  it('requests the smallest supported memory tier by default', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const createCalls: unknown[] = [];
    const provider = new OpenComputerSandboxProvider({
      client: {
        async create(params) {
          createCalls.push(params);
          return sandbox;
        },
        async connect() {
          return sandbox;
        },
      },
    });

    await provider.create({ sessionId: 'session-1' });

    expect(createCalls[0]).toMatchObject({ memoryMB: 1024 });
  });

  it('waits for OpenComputer exec routing before returning a created handle', async () => {
    const sandbox = createMockOpenComputerSandbox();
    let routeReady = false;
    sandbox.exec.run = vi.fn(async (command, opts) => {
      sandbox.execCalls.push({ command, ...(opts ? { opts } : {}) });
      if (!routeReady) {
        routeReady = true;
        throw routingRace();
      }
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '' };
    });
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });

    await expect(provider.create({ sessionId: 'session-1' })).resolves.toMatchObject({
      providerSandboxId: 'sandbox-1',
    });

    expect(sandbox.execCalls.map((call) => call.command)).toEqual(['true', 'true', "mkdir -p '/workspace'"]);
  });

  it('waits for OpenComputer file routing before returning a created handle', async () => {
    const sandbox = createMockOpenComputerSandbox();
    let routeReady = false;
    let attempts = 0;
    const originalList = sandbox.files.list;
    sandbox.files.list = vi.fn(async (path = '/') => {
      attempts += 1;
      if (!routeReady && path === '/') {
        routeReady = true;
        throw routingRace();
      }
      return originalList(path);
    });
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });

    await expect(provider.create({ sessionId: 'session-1' })).resolves.toMatchObject({
      providerSandboxId: 'sandbox-1',
    });

    expect(attempts).toBe(2);
  });

  it('passes explicit command env to OpenComputer exec without adding parent env', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });
    const handle = await provider.connect({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });
    sandbox.execCalls.length = 0;

    await handle.exec({ command: 'env | sort', env: { GREETING: 'hello' } });

    expect(sandbox.execCalls).toEqual([
      { command: `${clearProxyCommand}; env | sort`, opts: { cwd: '/workspace', env: { GREETING: 'hello' } } },
    ]);
  });

  it('pipes stdin into OpenComputer exec commands', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });
    const handle = await provider.connect({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });
    sandbox.execCalls.length = 0;

    await handle.exec({ command: 'cat > input.txt', stdin: "hello ' world" });

    expect(sandbox.execCalls).toEqual([
      { command: `${clearProxyCommand}; printf %s 'hello '\\'' world' | cat > input.txt`, opts: { cwd: '/workspace' } },
    ]);
  });

  it('preserves explicit command proxy env when the caller supplies one', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });
    const handle = await provider.connect({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });
    sandbox.execCalls.length = 0;

    await handle.exec({ command: 'curl https://example.com', env: { HTTPS_PROXY: 'http://proxy.example:3128' } });

    expect(sandbox.execCalls).toEqual([
      {
        command: 'curl https://example.com',
        opts: { cwd: '/workspace', env: { HTTPS_PROXY: 'http://proxy.example:3128' } },
      },
    ]);
  });

  it('uses OpenComputer proxy egress when a SecretStore is configured', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const createCalls: unknown[] = [];
    const provider = new OpenComputerSandboxProvider({
      secretStore: 'deputies-git-egress',
      client: {
        async create(params) {
          createCalls.push(params);
          return sandbox;
        },
        async connect() {
          return sandbox;
        },
      },
    });
    const handle = await provider.create({ sessionId: 'session-1' });
    sandbox.execCalls.length = 0;

    await handle.exec({ command: 'git ls-remote https://github.com/example/repo.git' });

    expect(createCalls[0]).toMatchObject({ secretStore: 'deputies-git-egress' });
    expect(sandbox.execCalls).toEqual([
      {
        command: 'git ls-remote https://github.com/example/repo.git',
        opts: {
          cwd: '/workspace',
          env: { GIT_SSL_CAINFO: '/usr/local/share/ca-certificates/opensandbox-proxy.crt' },
        },
      },
    ]);
  });

  it('does not start OpenComputer exec when the caller signal is already aborted', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });
    const handle = await provider.create({ sessionId: 'session-1' });
    sandbox.execCalls.length = 0;
    const abort = new AbortController();
    abort.abort();

    await expect(handle.exec({ command: 'sleep 20', signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(sandbox.execCalls).toEqual([]);
  });

  it('rejects OpenComputer exec when the caller aborts while the SDK command is pending', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });
    const handle = await provider.create({ sessionId: 'session-1' });
    let resolveCommand: ((value: { exitCode: number; stdout: string; stderr: string }) => void) | undefined;
    const pendingCommand = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      resolveCommand = resolve;
    });
    sandbox.exec.run = vi.fn((command, opts) => {
      sandbox.execCalls.push({ command, ...(opts ? { opts } : {}) });
      return pendingCommand;
    });
    sandbox.execCalls.length = 0;
    const abort = new AbortController();

    const run = handle.exec({ command: 'sleep 20', signal: abort.signal });
    abort.abort();

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(sandbox.execCalls).toEqual([{ command: `${clearProxyCommand}; sleep 20`, opts: { cwd: '/workspace' } }]);
    resolveCommand?.({ exitCode: 0, stdout: 'late', stderr: '' });
    await pendingCommand;
  });

  it('connects, reports health, and treats missing destroy as idempotent', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const client: OpenComputerClientLike = {
      async create() {
        return sandbox;
      },
      async connect(id) {
        if (id === 'missing') throw Object.assign(new Error('not found: 404'), { statusCode: 404 });
        return sandbox;
      },
    };
    const provider = new OpenComputerSandboxProvider({ client });

    const handle = await provider.connect({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' });

    expect(handle.workspacePath).toBe('/workspace');
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'ready' });
    await expect(provider.health({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(provider.destroy({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toBeUndefined();
  });

  it('reports starting while OpenComputer exec routing is unavailable', async () => {
    const sandbox = createMockOpenComputerSandbox();
    sandbox.exec.run = vi.fn(async (command, opts) => {
      sandbox.execCalls.push({ command, ...(opts ? { opts } : {}) });
      throw routingRace();
    });
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });

    await expect(provider.health({ providerSandboxId: 'sandbox-1', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'starting',
      message: 'OpenComputer sandbox routes are not available yet',
    });
  });

  it('routes OpenComputer previews through an authenticated sandbox bridge preview', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });

    const preview = await provider.getServiceEndpoint({
      providerSandboxId: 'sandbox-1',
      sessionId: 'session-1',
      port: 3000,
    });

    expect(preview).toMatchObject({
      port: 3000,
      targetUrl: 'https://sandbox-1-p3584.workers.opencomputer.test/preview/3000',
      targetHeaders: { authorization: expect.stringMatching(/^Bearer .+$/) },
      preserveTargetHost: true,
      forwardPreviewHost: true,
      secrets: { bridgeToken: expect.any(String) },
    });
    expect(preview?.targetHeaders?.authorization).toBe(`Bearer ${preview?.secrets?.bridgeToken}`);
    expect(sandbox.previewCreateCalls).toEqual([]);
    expect(sandbox.execCalls.at(-1)?.command).toContain('/opt/deputies/ensure-sandbox-bridge.sh');
    expect(sandbox.execCalls.at(-1)?.opts).toMatchObject({
      env: { DEPUTIES_SANDBOX_TOKEN: expect.any(String) },
    });
  });

  it('returns false for missing optional context files without listing the file path', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });
    const handle = await provider.create({ sessionId: 'session-1' });
    sandbox.listCalls.length = 0;

    await expect(handle.fs?.exists('/workspace/AGENTS.md')).resolves.toBe(false);
    await expect(handle.fs?.exists('/workspace/.agents/skills')).resolves.toBe(false);

    expect(sandbox.listCalls).toContain('/workspace');
    expect(sandbox.listCalls).not.toContain('/workspace/AGENTS.md');
  });

  it('falls back to explicit preview creation when native preview domain is unavailable', async () => {
    const sandbox = createMockOpenComputerSandbox({ domain: '' });
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });

    await expect(
      provider.getServiceEndpoint({ providerSandboxId: 'sandbox-1', sessionId: 'session-1', port: 3000 }),
    ).resolves.toMatchObject({
      targetUrl: 'https://explicit-3584.opencomputer.test/preview/3000',
    });
    expect(sandbox.previewCreateCalls).toEqual([3584]);
  });

  it('refreshes timeout only when keepalive exceeds the fallback idle timeout', async () => {
    const sandbox = createMockOpenComputerSandbox();
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox), idleTimeoutMs: 120_000 });

    await provider.refreshKeepalive({ providerSandboxId: 'sandbox-1', sessionId: 'session-1', durationMs: 60_000 });
    await provider.refreshKeepalive({ providerSandboxId: 'sandbox-1', sessionId: 'session-1', durationMs: 300_000 });

    expect(sandbox.timeoutCalls).toEqual([300]);
  });

  it('kills a created sandbox if handle setup fails and preserves the setup error', async () => {
    const sandbox = createMockOpenComputerSandbox();
    sandbox.exec.run = vi.fn(async (command, opts) => {
      sandbox.execCalls.push({ command, ...(opts ? { opts } : {}) });
      return { exitCode: 1, stdout: '', stderr: 'workspace failed' };
    });
    const provider = new OpenComputerSandboxProvider({ client: createClient(sandbox) });

    await expect(provider.create({ sessionId: 'session-1' })).rejects.toThrow('workspace failed');
    expect(sandbox.killCalls).toBe(1);
  });
});

type MockOpenComputerSandbox = OpenComputerSandboxLike & {
  execCalls: Array<{ command: string; opts?: unknown }>;
  previewCreateCalls: number[];
  timeoutCalls: number[];
  listCalls: string[];
  killCalls: number;
};

function createClient(sandbox: OpenComputerSandboxLike): OpenComputerClientLike {
  return {
    async create() {
      return sandbox;
    },
    async connect() {
      return sandbox;
    },
  };
}

function createMockOpenComputerSandbox(options: { domain?: string } = {}): MockOpenComputerSandbox {
  const files = new Map<string, Uint8Array>();
  const directories = new Set(['/']);
  const execCalls: MockOpenComputerSandbox['execCalls'] = [];
  const previewCreateCalls: number[] = [];
  const timeoutCalls: number[] = [];
  const listCalls: string[] = [];
  addDirectory(directories, '/workspace');
  const sandbox: MockOpenComputerSandbox = {
    sandboxId: 'sandbox-1',
    status: 'running',
    domain: options.domain ?? 'sandbox-1-p80.workers.opencomputer.test',
    execCalls,
    previewCreateCalls,
    timeoutCalls,
    listCalls,
    killCalls: 0,
    getPreviewDomain(port) {
      if (!this.domain) return '';
      return `sandbox-1-p${port}.workers.opencomputer.test`;
    },
    async kill() {
      this.killCalls += 1;
      this.status = 'stopped';
    },
    async hibernate() {
      this.status = 'hibernated';
    },
    async wake() {
      this.status = 'running';
    },
    async setTimeout(timeout) {
      timeoutCalls.push(timeout);
    },
    async createPreviewURL({ port }) {
      previewCreateCalls.push(port);
      return { hostname: `explicit-${port}.opencomputer.test` };
    },
    exec: {
      async run(command, opts) {
        execCalls.push({ command, ...(opts ? { opts } : {}) });
        return { exitCode: 0, stdout: `ran: ${command}`, stderr: '' };
      },
    },
    files: {
      async read(path) {
        const content = files.get(path);
        if (!content) throw notFound();
        return Buffer.from(content).toString('utf-8');
      },
      async readBytes(path) {
        const content = files.get(path);
        if (!content) throw notFound();
        return content;
      },
      async write(path, content) {
        addDirectory(directories, dirname(path));
        files.set(path, typeof content === 'string' ? Buffer.from(content, 'utf-8') : content);
      },
      async list(path = '/') {
        listCalls.push(path);
        if (!directories.has(path)) throw listFailed(path);
        const entries = new Map<string, { name: string; isDir: boolean; path: string; size: number }>();
        for (const directory of directories) {
          if (directory !== path && dirname(directory) === path) {
            entries.set(basename(directory), { name: basename(directory), isDir: true, path: directory, size: 0 });
          }
        }
        for (const [file, content] of files.entries()) {
          if (dirname(file) === path) {
            entries.set(basename(file), { name: basename(file), isDir: false, path: file, size: content.byteLength });
          }
        }
        return Array.from(entries.values());
      },
      async makeDir(path) {
        addDirectory(directories, path);
      },
      async remove(path) {
        if (files.delete(path)) return;
        if (!directories.has(path)) throw notFound();
        for (const file of Array.from(files.keys())) {
          if (file.startsWith(`${path}/`)) files.delete(file);
        }
        for (const directory of Array.from(directories)) {
          if (directory === path || directory.startsWith(`${path}/`)) directories.delete(directory);
        }
      },
      async exists(path) {
        return files.has(path);
      },
    },
  };
  return sandbox;
}

function addDirectory(directories: Set<string>, path: string): void {
  const normalized = path || '/';
  if (normalized === '/') {
    directories.add('/');
    return;
  }
  addDirectory(directories, dirname(normalized));
  directories.add(normalized);
}

function notFound(): Error {
  return Object.assign(new Error('not found: 404'), { statusCode: 404 });
}

function routingRace(): Error {
  return Object.assign(new Error('Failed to run command: 404 {"error":"sandbox not found"}'), { statusCode: 404 });
}

function listFailed(path: string): Error {
  return new Error(`Failed to list ${path}: 500`);
}
