import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NscNamespaceInstanceClient,
  NamespaceSandboxProvider,
  type NamespaceInstanceClientLike,
  type NamespaceInstanceCreateInput,
  type NamespaceInstanceDescriptor,
  type NamespaceInstanceExecInput,
  type NamespaceInstanceFileInput,
  type NamespaceInstanceMkdirInput,
  type NamespaceInstanceRmInput,
  type NamespaceInstanceWriteFileInput,
} from '../../src/sandbox/namespace.js';

describe('NamespaceSandboxProvider', () => {
  it('creates a Namespace instance handle with exec and filesystem operations', async () => {
    const client = new FakeNamespaceClient();
    const provider = new NamespaceSandboxProvider({
      client,
      image: 'ghcr.io/acme/deputies-namespace:test',
      duration: '8h',
      workspacePath: '/workspace/custom',
      machineType: '16x32',
      bridgeSkippedCookieNames: 'inner_preview,inner_session',
    });

    const handle = await provider.create({ sessionId: 'session-1', metadata: { owner: 'test' } });

    expect(client.createInputs).toHaveLength(1);
    expect(client.createInputs[0]).toMatchObject({
      sessionId: 'session-1',
      image: 'ghcr.io/acme/deputies-namespace:test',
      workspacePath: '/workspace/custom',
      duration: '8h',
      machineType: '16x32',
      bridgeSkippedCookieNames: 'inner_preview,inner_session',
    });
    expect(client.createInputs[0]?.bridgeToken).toEqual(expect.any(String));
    expect(handle).toMatchObject({
      provider: 'namespace',
      providerSandboxId: 'instance-1',
      sessionId: 'session-1',
      workspacePath: '/workspace/custom',
      metadata: {
        owner: 'test',
        namespaceInstanceId: 'instance-1',
        namespaceContainerName: client.createInputs[0]?.containerName,
        namespaceBridgeUrl: 'https://bridge-instance-1.namespaced.app',
        image: 'ghcr.io/acme/deputies-namespace:test',
      },
      capabilities: { persistentFilesystem: true, exec: true, filesystem: true, previewUrls: true, stopStart: false },
    });
    expect(handle.secrets?.bridgeToken).toEqual(expect.any(String));

    await expect(handle.exec({ command: 'echo ok', cwd: '/workspace/custom' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'ran: echo ok',
      stderr: '',
    });
    expect(client.execInputs[0]).toMatchObject({
      instanceId: 'instance-1',
      containerName: client.createInputs[0]?.containerName,
      command: 'echo ok',
    });
    await handle.fs?.writeFile('/workspace/custom/file.txt', 'hello');
    expect(client.writeInputs[0]).toMatchObject({
      instanceId: 'instance-1',
      containerName: client.createInputs[0]?.containerName,
      path: '/workspace/custom/file.txt',
    });
    await expect(handle.fs?.readFile('/workspace/custom/file.txt')).resolves.toBe('hello');
    await expect(handle.fs?.readdir('/workspace/custom')).resolves.toEqual(['file.txt']);
  });

  it('returns Namespace ingress-authenticated bridge preview URLs', async () => {
    const client = new FakeNamespaceClient();
    const provider = new NamespaceSandboxProvider({ client });
    const handle = await provider.create({ sessionId: 'session-1' });

    await expect(
      provider.getPreviewUrl({
        providerSandboxId: handle.providerSandboxId,
        sessionId: 'session-1',
        port: 3000,
        secrets: { bridgeToken: 'bridge-token' },
      }),
    ).resolves.toEqual({
      port: 3000,
      targetUrl: 'https://bridge-instance-1.namespaced.app/preview/3000',
      targetHeaders: {
        authorization: 'Bearer bridge-token',
        'x-nsc-ingress-auth': 'Bearer ingress-token-instance-1',
      },
      preserveTargetHost: true,
      forwardPreviewHost: true,
    });
    expect(client.ingressTokenCalls).toEqual(['instance-1']);

    await provider.getPreviewUrl({
      providerSandboxId: handle.providerSandboxId,
      sessionId: 'session-1',
      port: 3000,
      secrets: { bridgeToken: 'bridge-token' },
    });
    expect(client.ingressTokenCalls).toEqual(['instance-1', 'instance-1']);
  });

  it('uses NSC_TOKEN_FILE bearer_token for ingress auth without shelling out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deputies-namespace-token-test-'));
    const previous = process.env.NSC_TOKEN_FILE;
    try {
      const tokenFile = join(dir, 'token.json');
      await writeFile(tokenFile, JSON.stringify({ bearer_token: 'revokable-token' }));
      process.env.NSC_TOKEN_FILE = tokenFile;
      const client = new NscNamespaceInstanceClient({ nscBinary: 'missing-nsc-for-test' });

      await expect(client.ingressAccessToken('instance-1')).resolves.toBe('revokable-token');
    } finally {
      if (previous === undefined) delete process.env.NSC_TOKEN_FILE;
      else process.env.NSC_TOKEN_FILE = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports missing health and treats missing destroy as idempotent', async () => {
    const client = new FakeNamespaceClient();
    const provider = new NamespaceSandboxProvider({ client });

    await expect(provider.health({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(provider.destroy({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toBeUndefined();
  });

  it('extends Namespace instance duration during keepalive refresh', async () => {
    const client = new FakeNamespaceClient();
    const provider = new NamespaceSandboxProvider({ client });

    await provider.refreshKeepalive({ providerSandboxId: 'instance-1', sessionId: 'session-1', durationMs: 600_000 });

    expect(client.extendCalls).toEqual([{ instanceId: 'instance-1', durationMs: 600_000 }]);
  });
});

class FakeNamespaceClient implements NamespaceInstanceClientLike {
  readonly createInputs: NamespaceInstanceCreateInput[] = [];
  readonly execInputs: NamespaceInstanceExecInput[] = [];
  readonly writeInputs: NamespaceInstanceWriteFileInput[] = [];
  readonly ingressTokenCalls: string[] = [];
  readonly extendCalls: Array<{ instanceId: string; durationMs: number }> = [];
  private readonly descriptors = new Map<string, NamespaceInstanceDescriptor>();
  private readonly files = new Map<string, Uint8Array>();

  async check(): Promise<void> {}

  async create(input: NamespaceInstanceCreateInput): Promise<NamespaceInstanceDescriptor> {
    this.createInputs.push(input);
    const descriptor: NamespaceInstanceDescriptor = {
      id: 'instance-1',
      containerName: input.containerName,
      bridgeUrl: 'https://bridge-instance-1.namespaced.app',
      workspacePath: input.workspacePath,
      state: 'running',
      metadata: { image: input.image, workspacePath: input.workspacePath, containerName: input.containerName },
    };
    this.descriptors.set(descriptor.id, descriptor);
    return descriptor;
  }

  async describe(instanceId: string): Promise<NamespaceInstanceDescriptor | null> {
    return this.descriptors.get(instanceId) ?? null;
  }

  async exposeBridge(instanceId: string): Promise<string | null> {
    return this.descriptors.get(instanceId)?.bridgeUrl ?? null;
  }

  async destroy(instanceId: string): Promise<void> {
    this.descriptors.delete(instanceId);
  }

  async extendDuration(instanceId: string, durationMs: number): Promise<void> {
    this.extendCalls.push({ instanceId, durationMs });
  }

  async ingressAccessToken(instanceId: string): Promise<string> {
    this.ingressTokenCalls.push(instanceId);
    return `ingress-token-${instanceId}`;
  }

  async exec(input: NamespaceInstanceExecInput) {
    this.execInputs.push(input);
    return {
      exitCode: 0,
      stdout: `ran: ${input.command}`,
      stderr: '',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      completedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
  }

  async readFile(input: NamespaceInstanceFileInput): Promise<Uint8Array> {
    const value = this.files.get(input.path);
    if (!value) throw new Error('not found');
    return value;
  }

  async writeFile(input: NamespaceInstanceWriteFileInput): Promise<void> {
    this.writeInputs.push(input);
    this.files.set(input.path, typeof input.content === 'string' ? Buffer.from(input.content) : input.content);
  }

  async stat(input: NamespaceInstanceFileInput) {
    return {
      isFile: this.files.has(input.path),
      isDirectory: !this.files.has(input.path),
      isSymbolicLink: false,
      size: this.files.get(input.path)?.byteLength ?? 0,
      mtime: new Date('2026-01-01T00:00:00.000Z'),
    };
  }

  async readdir(input: NamespaceInstanceFileInput): Promise<string[]> {
    const prefix = input.path.replace(/\/$/, '') + '/';
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
  }

  async exists(input: NamespaceInstanceFileInput): Promise<boolean> {
    return this.files.has(input.path);
  }

  async mkdir(_input: NamespaceInstanceMkdirInput): Promise<void> {}

  async rm(input: NamespaceInstanceRmInput): Promise<void> {
    this.files.delete(input.path);
  }
}
