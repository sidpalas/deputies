import { EventEmitter } from 'node:events';
import {
  DockerSandboxProvider,
  HttpDockerOrchestratorClient,
  InProcessDockerOrchestrator,
  createDockerOrchestratorHttpHandler,
  dockerCapabilities,
  type DockerOrchestrator,
  type DockerSandboxDescriptor,
} from '../../src/sandbox/docker.js';
import type { FileStat, SandboxExecResult, SandboxHealth } from '../../src/sandbox/types.js';

describe('DockerSandboxProvider', () => {
  it('adapts Docker orchestrator descriptors into sandbox handles', async () => {
    const orchestrator = new FakeDockerOrchestrator();
    const provider = new DockerSandboxProvider({ orchestrator });

    const handle = await provider.create({ sessionId: 'session-1', metadata: { owner: 'test' } });

    expect(handle).toMatchObject({
      provider: 'docker',
      providerSandboxId: 'docker-session-1',
      sessionId: 'session-1',
      workspacePath: '/workspace',
      metadata: { owner: 'test' },
      secrets: { bridgeToken: 'token-session-1' },
      capabilities: dockerCapabilities,
    });

    await handle.fs?.writeFile('file.txt', 'hello');
    await expect(handle.fs?.readFile('file.txt')).resolves.toBe('hello');
    await expect(handle.fs?.exists('file.txt')).resolves.toBe(true);
    await expect(handle.fs?.readdir('.')).resolves.toEqual(['file.txt']);
    await expect(handle.exec({ command: 'printf ok', cwd: '/workspace' })).resolves.toMatchObject({
      stdout: 'ran: printf ok',
      exitCode: 0,
    });
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'ready' });

    await provider.stop(handle);
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'stopped' });
    await provider.start(handle);
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'ready' });
    await provider.destroy(handle);
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'missing' });
  });

  it('supports an HTTP orchestrator client/server boundary', async () => {
    const orchestrator = new FakeDockerOrchestrator();
    const handler = createDockerOrchestratorHttpHandler(orchestrator, 'orchestrator-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      return handler(new Request(input, init));
    });
    const provider = new DockerSandboxProvider({
      orchestrator: new HttpDockerOrchestratorClient({
        baseUrl: 'https://orchestrator.test',
        token: 'orchestrator-token',
      }),
    });

    try {
      const handle = await provider.create({ sessionId: 'session-2' });
      await handle.fs?.writeFile('nested/file.txt', Buffer.from('hello'));

      await expect(handle.fs?.readFileBuffer('nested/file.txt')).resolves.toEqual(new Uint8Array(Buffer.from('hello')));
      await expect(handle.exec({ command: 'pwd' })).resolves.toMatchObject({
        stdout: 'ran: pwd',
        startedAt: expect.any(Date),
        completedAt: expect.any(Date),
      });
      await expect(provider.health(handle)).resolves.toMatchObject({ status: 'ready', checkedAt: expect.any(Date) });
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('passes shared millisecond sandbox exec timeouts to the bridge', async () => {
    const orchestrator = new InProcessDockerOrchestrator();
    const descriptor = cacheDescriptor(orchestrator, 'session-3');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        exitCode: 0,
        stdout: '',
        stderr: '',
        startedAt: '2026-05-05T12:00:00.000Z',
        completedAt: '2026-05-05T12:00:00.000Z',
      }),
    );

    try {
      await orchestrator.exec({
        providerSandboxId: descriptor.providerSandboxId,
        sessionId: descriptor.sessionId,
        command: 'git clone repo',
        timeoutMs: 120_000,
      });

      const init = fetchMock.mock.calls[0]?.[1];
      expect(JSON.parse(String(init?.body))).toMatchObject({ timeoutMs: 120_000 });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('waits for cached Docker bridge descriptors when reconnecting', async () => {
    const orchestrator = new InProcessDockerOrchestrator();
    const descriptor = cacheDescriptor(orchestrator, 'session-4');
    const bridgeUrlMock = vi
      .spyOn(orchestrator as unknown as { bridgeUrl(providerSandboxId: string): Promise<string> }, 'bridgeUrl')
      .mockResolvedValue('https://bridge.test');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ status: 'ready', workspacePath: '/workspace' }));

    try {
      await expect(
        orchestrator.connect({ providerSandboxId: descriptor.providerSandboxId, sessionId: descriptor.sessionId }),
      ).resolves.toMatchObject({
        ...descriptor,
        metadata: { bridgeUrl: 'https://bridge.test' },
      });
      expect(bridgeUrlMock).toHaveBeenCalledWith(descriptor.providerSandboxId);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://bridge.test/health',
        expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer token-session-4' }) }),
      );
    } finally {
      fetchMock.mockRestore();
      bridgeUrlMock.mockRestore();
    }
  });

  it('removes a created container if bridge URL resolution fails and preserves the setup error', async () => {
    vi.resetModules();
    const commands: string[][] = [];
    const spawnMock = vi.fn((command: string, args: string[]) => {
      commands.push([command, ...args]);
      return mockDockerProcess(args);
    });
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    try {
      const { InProcessDockerOrchestrator: MockedInProcessDockerOrchestrator } =
        await import('../../src/sandbox/docker.js');
      const orchestrator = new MockedInProcessDockerOrchestrator();

      await expect(orchestrator.create({ sessionId: 'session-5' })).rejects.toThrow(
        'Docker bridge port is not published for container-1',
      );

      expect(commands).toEqual([
        expect.arrayContaining(['docker', 'run', '-d']),
        ['docker', 'port', 'container-1', '3584/tcp'],
        ['docker', 'rm', '-f', 'container-1'],
      ]);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('passes the bridge skip-cookie-names env to docker run', async () => {
    vi.resetModules();
    const commands: string[][] = [];
    const spawnMock = vi.fn((command: string, args: string[]) => {
      commands.push([command, ...args]);
      return mockDockerProcess(args);
    });
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    try {
      const { InProcessDockerOrchestrator: MockedInProcessDockerOrchestrator } =
        await import('../../src/sandbox/docker.js');
      const orchestrator = new MockedInProcessDockerOrchestrator({
        bridgeSkippedCookieNames: 'inner_deputies_preview,inner_deputies_session',
      });

      await orchestrator.create({ sessionId: 'session-6' }).catch(() => undefined);

      expect(commands[0]).toEqual(
        expect.arrayContaining([
          '-e',
          'DEPUTIES_SANDBOX_SKIP_COOKIE_NAMES=inner_deputies_preview,inner_deputies_session',
        ]),
      );
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('kills Docker CLI calls and rejects when they exceed the configured timeout', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const child = mockHangingDockerProcess();
    const spawnMock = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    try {
      const { InProcessDockerOrchestrator: MockedInProcessDockerOrchestrator } =
        await import('../../src/sandbox/docker.js');
      const orchestrator = new MockedInProcessDockerOrchestrator({ dockerCliTimeoutMs: 25 });
      const start = orchestrator.start({ providerSandboxId: 'container-1', sessionId: 'session-timeout' });
      const rejection = expect(start).rejects.toThrow('docker start timed out after 25ms');

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('lets allowFailure Docker timeouts return a result so destroy can clean local state', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const child = mockHangingDockerProcess();
    const spawnMock = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    try {
      const { InProcessDockerOrchestrator: MockedInProcessDockerOrchestrator } =
        await import('../../src/sandbox/docker.js');
      const orchestrator = new MockedInProcessDockerOrchestrator({ dockerCliTimeoutMs: 25 });
      const descriptor = cacheDescriptor(orchestrator, 'session-destroy-timeout');
      const destroy = orchestrator.destroy({
        providerSandboxId: descriptor.providerSandboxId,
        sessionId: descriptor.sessionId,
      });
      const rejection = expect(destroy).rejects.toThrow('docker rm timed out after 25ms');

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(
        (orchestrator as unknown as { descriptors: Map<string, DockerSandboxDescriptor> }).descriptors.has(
          descriptor.providerSandboxId,
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('ignores a Docker CLI close event after timeout rejection', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const child = mockHangingDockerProcess();
    const spawnMock = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    try {
      const { InProcessDockerOrchestrator: MockedInProcessDockerOrchestrator } =
        await import('../../src/sandbox/docker.js');
      const orchestrator = new MockedInProcessDockerOrchestrator({ dockerCliTimeoutMs: 25 });
      const start = orchestrator.start({ providerSandboxId: 'container-1', sessionId: 'session-timeout' });
      const rejection = expect(start).rejects.toThrow('docker start timed out after 25ms');

      await vi.advanceTimersByTimeAsync(25);
      child.emit('close', 0);

      await rejection;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('passes DOCKER_CLI_TIMEOUT_MS to the split HTTP orchestrator server', async () => {
    vi.resetModules();
    const originalDockerCliTimeoutMs = process.env.DOCKER_CLI_TIMEOUT_MS;
    const originalDockerOrchestratorPort = process.env.DOCKER_ORCHESTRATOR_PORT;
    process.env.DOCKER_CLI_TIMEOUT_MS = '45000';
    process.env.DOCKER_ORCHESTRATOR_PORT = '3586';

    const server = { listen: vi.fn((_port: number, _host: string, callback: () => void) => callback()) };
    const createServerMock = vi.fn(() => server);
    const inProcessDockerOrchestratorMock = vi.fn(function InProcessDockerOrchestrator() {});
    const createDockerOrchestratorHttpHandlerMock = vi.fn(() => async () => jsonResponse({ ok: true }));
    const consoleLogMock = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    vi.doMock('node:http', () => ({ createServer: createServerMock }));
    vi.doMock('../../src/sandbox/docker.js', () => ({
      InProcessDockerOrchestrator: inProcessDockerOrchestratorMock,
      createDockerOrchestratorHttpHandler: createDockerOrchestratorHttpHandlerMock,
    }));

    try {
      await import('../../src/sandbox/docker-orchestrator-server.js');

      expect(inProcessDockerOrchestratorMock).toHaveBeenCalledWith(
        expect.objectContaining({ dockerCliTimeoutMs: 45_000 }),
      );
      expect(server.listen).toHaveBeenCalledWith(3586, '0.0.0.0', expect.any(Function));
    } finally {
      if (originalDockerCliTimeoutMs === undefined) delete process.env.DOCKER_CLI_TIMEOUT_MS;
      else process.env.DOCKER_CLI_TIMEOUT_MS = originalDockerCliTimeoutMs;
      if (originalDockerOrchestratorPort === undefined) delete process.env.DOCKER_ORCHESTRATOR_PORT;
      else process.env.DOCKER_ORCHESTRATOR_PORT = originalDockerOrchestratorPort;
      consoleLogMock.mockRestore();
      vi.doUnmock('node:http');
      vi.doUnmock('../../src/sandbox/docker.js');
      vi.resetModules();
    }
  });
});

function mockDockerProcess(args: string[]): EventEmitter & {
  stdout: EventEmitter & { setEncoding(encoding: BufferEncoding): void };
  stderr: EventEmitter & { setEncoding(encoding: BufferEncoding): void };
  kill(signal?: NodeJS.Signals): boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding(encoding: BufferEncoding): void };
    stderr: EventEmitter & { setEncoding(encoding: BufferEncoding): void };
    kill(signal?: NodeJS.Signals): boolean;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.kill = vi.fn(() => true);
  queueMicrotask(() => {
    if (args[0] === 'run') child.stdout.emit('data', 'container-1\n');
    child.emit('close', 0);
  });
  return child;
}

function mockHangingDockerProcess(): EventEmitter & {
  stdout: EventEmitter & { setEncoding(encoding: BufferEncoding): void };
  stderr: EventEmitter & { setEncoding(encoding: BufferEncoding): void };
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding(encoding: BufferEncoding): void };
    stderr: EventEmitter & { setEncoding(encoding: BufferEncoding): void };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.kill = vi.fn(() => true);
  return child;
}

function cacheDescriptor(orchestrator: InProcessDockerOrchestrator, sessionId: string): DockerSandboxDescriptor {
  const descriptor = {
    providerSandboxId: 'container-1',
    sessionId,
    workspacePath: '/workspace',
    bridgeUrl: 'https://bridge.test',
    bridgeToken: `token-${sessionId}`,
    metadata: {},
  };
  (orchestrator as unknown as { descriptors: Map<string, DockerSandboxDescriptor> }).descriptors.set(
    descriptor.providerSandboxId,
    descriptor,
  );
  return descriptor;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

class FakeDockerOrchestrator implements DockerOrchestrator {
  private readonly sandboxes = new Map<string, DockerSandboxDescriptor>();
  private readonly files = new Map<string, Map<string, Uint8Array>>();
  private readonly stopped = new Set<string>();

  async create(input: { sessionId: string; metadata?: Record<string, unknown> }): Promise<DockerSandboxDescriptor> {
    const descriptor = {
      providerSandboxId: `docker-${input.sessionId}`,
      sessionId: input.sessionId,
      workspacePath: '/workspace',
      bridgeUrl: `https://bridge.test/${input.sessionId}`,
      bridgeToken: `token-${input.sessionId}`,
      metadata: { ...input.metadata },
    };
    this.sandboxes.set(descriptor.providerSandboxId, descriptor);
    this.files.set(descriptor.providerSandboxId, new Map());
    return descriptor;
  }

  async connect(input: { providerSandboxId: string }): Promise<DockerSandboxDescriptor> {
    const descriptor = this.sandboxes.get(input.providerSandboxId);
    if (!descriptor) throw new Error('missing');
    return descriptor;
  }

  async health(input: { providerSandboxId: string }): Promise<SandboxHealth> {
    if (!this.sandboxes.has(input.providerSandboxId)) return { status: 'missing', checkedAt: new Date() };
    if (this.stopped.has(input.providerSandboxId)) return { status: 'stopped', checkedAt: new Date() };
    return { status: 'ready', checkedAt: new Date() };
  }

  async start(input: { providerSandboxId: string }): Promise<void> {
    this.stopped.delete(input.providerSandboxId);
  }

  async stop(input: { providerSandboxId: string }): Promise<void> {
    this.stopped.add(input.providerSandboxId);
  }

  async destroy(input: { providerSandboxId: string }): Promise<void> {
    this.sandboxes.delete(input.providerSandboxId);
    this.files.delete(input.providerSandboxId);
  }

  async exec(input: { command: string }): Promise<SandboxExecResult> {
    const now = new Date();
    return { exitCode: 0, stdout: `ran: ${input.command}`, stderr: '', startedAt: now, completedAt: now };
  }

  async readFile(input: { providerSandboxId: string; path: string }): Promise<Uint8Array> {
    const file = this.fileMap(input.providerSandboxId).get(input.path);
    if (!file) throw new Error('missing file');
    return file;
  }

  async writeFile(input: { providerSandboxId: string; path: string; content: string | Uint8Array }): Promise<void> {
    this.fileMap(input.providerSandboxId).set(
      input.path,
      typeof input.content === 'string' ? Buffer.from(input.content) : input.content,
    );
  }

  async stat(input: { providerSandboxId: string; path: string }): Promise<FileStat> {
    const file = await this.readFile(input);
    return { isFile: true, isDirectory: false, isSymbolicLink: false, size: file.byteLength, mtime: new Date(0) };
  }

  async readdir(input: { providerSandboxId: string }): Promise<string[]> {
    return Array.from(this.fileMap(input.providerSandboxId).keys())
      .map((path) => path.split('/')[0]!)
      .filter((value, index, values) => values.indexOf(value) === index);
  }

  async exists(input: { providerSandboxId: string; path: string }): Promise<boolean> {
    return this.fileMap(input.providerSandboxId).has(input.path);
  }

  async mkdir(): Promise<void> {}

  async rm(input: { providerSandboxId: string; path: string }): Promise<void> {
    this.fileMap(input.providerSandboxId).delete(input.path);
  }

  private fileMap(providerSandboxId: string): Map<string, Uint8Array> {
    const files = this.files.get(providerSandboxId);
    if (!files) throw new Error('missing sandbox');
    return files;
  }
}
