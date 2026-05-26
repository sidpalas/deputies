import {
  AgentSandboxProvider,
  HttpAgentSandboxOrchestratorClient,
  agentSandboxCapabilities,
  createAgentSandboxOrchestratorHttpHandler,
  type AgentSandboxDescriptor,
  type AgentSandboxOrchestrator,
} from '../../src/sandbox/k8s-agent-sandbox.js';
import type { FileStat, SandboxExecResult, SandboxHealth } from '../../src/sandbox/types.js';

describe('AgentSandboxProvider', () => {
  it('adapts Kubernetes agent-sandbox descriptors into sandbox handles', async () => {
    const orchestrator = new FakeAgentSandboxOrchestrator();
    const provider = new AgentSandboxProvider({ orchestrator });

    const handle = await provider.create({ sessionId: 'session-1', metadata: { owner: 'test' } });

    expect(handle).toMatchObject({
      provider: 'k8s-agent-sandbox',
      providerSandboxId: 'agent-sandbox-session-1',
      sessionId: 'session-1',
      workspacePath: '/workspace',
      metadata: { owner: 'test' },
      secrets: { bridgeToken: 'token-session-1' },
      capabilities: agentSandboxCapabilities,
    });

    await handle.fs?.writeFile('file.txt', 'hello');
    await expect(handle.fs?.readFile('file.txt')).resolves.toBe('hello');
    await expect(handle.fs?.exists('file.txt')).resolves.toBe(true);
    await expect(handle.exec({ command: 'printf ok', cwd: '/workspace' })).resolves.toMatchObject({
      stdout: 'ran: printf ok',
      exitCode: 0,
    });
    await expect(provider.health(handle)).resolves.toMatchObject({ status: 'ready' });
  });

  it('supports an HTTP orchestrator client/server boundary', async () => {
    const orchestrator = new FakeAgentSandboxOrchestrator();
    const handler = createAgentSandboxOrchestratorHttpHandler(orchestrator, 'orchestrator-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      return handler(new Request(input, init));
    });
    const provider = new AgentSandboxProvider({
      orchestrator: new HttpAgentSandboxOrchestratorClient({
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

  it('requires a matching bearer token for mutating HTTP orchestrator requests', async () => {
    const handler = createAgentSandboxOrchestratorHttpHandler(new FakeAgentSandboxOrchestrator(), 'orchestrator-token');
    const request = (token?: string) =>
      new Request('https://orchestrator.test/sandboxes', {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify({ sessionId: 'session-3' }),
      });

    await expect(handler(request())).resolves.toMatchObject({ status: 401 });
    await expect(handler(request('wrong-token'))).resolves.toMatchObject({ status: 401 });
    await expect(handler(request('orchestrator-token'))).resolves.toMatchObject({ status: 200 });

    await expect(handler(new Request('https://orchestrator.test/health'))).resolves.toMatchObject({ status: 200 });
  });
});

class FakeAgentSandboxOrchestrator implements AgentSandboxOrchestrator {
  private readonly files = new Map<string, Uint8Array>();
  private readonly descriptors = new Map<string, AgentSandboxDescriptor>();
  private readonly stopped = new Set<string>();

  async create(input: { sessionId: string; metadata?: Record<string, unknown> }): Promise<AgentSandboxDescriptor> {
    const descriptor: AgentSandboxDescriptor = {
      providerSandboxId: `agent-sandbox-${input.sessionId}`,
      sessionId: input.sessionId,
      workspacePath: '/workspace',
      bridgeUrl: `http://agent-sandbox-${input.sessionId}.default.svc:3584`,
      bridgeToken: `token-${input.sessionId}`,
      metadata: input.metadata ?? {},
    };
    this.descriptors.set(descriptor.providerSandboxId, descriptor);
    return descriptor;
  }

  async connect(input: { providerSandboxId: string }): Promise<AgentSandboxDescriptor> {
    const descriptor = this.descriptors.get(input.providerSandboxId);
    if (!descriptor) throw new Error('missing sandbox');
    return descriptor;
  }

  async health(input: { providerSandboxId: string }): Promise<SandboxHealth> {
    if (!this.descriptors.has(input.providerSandboxId)) return { status: 'missing', checkedAt: new Date() };
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
    this.descriptors.delete(input.providerSandboxId);
  }

  async exec(input: { command: string }): Promise<SandboxExecResult> {
    const now = new Date();
    return { exitCode: 0, stdout: `ran: ${input.command}`, stderr: '', startedAt: now, completedAt: now };
  }

  async readFile(input: { path: string }): Promise<Uint8Array> {
    return this.files.get(input.path) ?? new Uint8Array();
  }

  async writeFile(input: { path: string; content: string | Uint8Array }): Promise<void> {
    this.files.set(input.path, Buffer.from(input.content));
  }

  async stat(input: { path: string }): Promise<FileStat> {
    return {
      isFile: this.files.has(input.path),
      isDirectory: !this.files.has(input.path),
      isSymbolicLink: false,
      size: this.files.get(input.path)?.byteLength ?? 0,
      mtime: new Date(),
    };
  }

  async readdir(): Promise<string[]> {
    return [...this.files.keys()];
  }

  async exists(input: { path: string }): Promise<boolean> {
    return this.files.has(input.path);
  }

  async mkdir(): Promise<void> {}

  async rm(input: { path: string }): Promise<void> {
    this.files.delete(input.path);
  }
}
