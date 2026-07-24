import { SandboxCleanupService, SandboxLifecycleService } from '../../src/sandbox/service.js';
import { EventService } from '../../src/events/service.js';
import { sandboxRuntimeId } from '../../src/sandbox/runtime.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { SandboxCapabilities, SandboxHandle, SandboxProvider } from '../../src/sandbox/types.js';
import { type CreateSandboxRecord, type SandboxRecord, type SandboxStore } from '../../src/store/types.js';

const capabilities: SandboxCapabilities = {
  persistentFilesystem: true,
  snapshots: false,
  stopStart: false,
  exec: true,
  filesystem: false,
  streamingLogs: false,
  portForwarding: false,
  serviceEndpoints: false,
  objectStorageArtifacts: false,
};

describe('SandboxLifecycleService', () => {
  it('destroys a created provider sandbox if persistence fails and preserves the store error', async () => {
    const storeError = new Error('store unavailable');
    const handle = createHandle('sandbox-1');
    const provider = createProvider(handle);
    const store = new FailingCreateSandboxStore(storeError);
    const lifecycle = new SandboxLifecycleService(store, provider);

    await expect(lifecycle.ensure('session-1')).rejects.toBe(storeError);
    expect(provider.destroy).toHaveBeenCalledWith(handle);
  });

  it('still preserves the store error if best-effort provider cleanup fails', async () => {
    const storeError = new Error('store unavailable');
    const handle = createHandle('sandbox-1');
    const provider = createProvider(handle);
    vi.mocked(provider.destroy).mockRejectedValueOnce(new Error('destroy failed'));
    const lifecycle = new SandboxLifecycleService(new FailingCreateSandboxStore(storeError), provider);

    await expect(lifecycle.ensure('session-1')).rejects.toBe(storeError);
    expect(provider.destroy).toHaveBeenCalledWith(handle);
  });

  it('rotates runtime metadata when reconnecting a stopped sandbox and preserves the new runtime', async () => {
    const store = new MemoryStore();
    const now = new Date();
    await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000001',
      sessionId: 'session-1',
      provider: 'fake',
      providerSandboxId: 'sandbox-1',
      status: 'stopped',
      workspacePath: '/workspace',
      metadata: { runtimeId: 'old-runtime', owner: 'test' },
      createdAt: now,
      updatedAt: now,
    });
    const handle = createHandle('sandbox-1');
    handle.metadata = { runtimeId: 'old-runtime', target: 'test' };
    const provider = createProvider(handle);
    vi.mocked(provider.health).mockResolvedValueOnce({ status: 'ready', checkedAt: new Date() });
    const lifecycle = new SandboxLifecycleService(store, provider);

    const result = await lifecycle.ensure('session-1');

    expect(result.created).toBe(false);
    expect(result.restarted).toBe(true);
    expect(sandboxRuntimeId(result.record)).toBeDefined();
    expect(sandboxRuntimeId(result.record)).not.toBe('old-runtime');
    expect(sandboxRuntimeId({ metadata: result.sandbox.metadata })).toBe(sandboxRuntimeId(result.record));
  });

  it('persists provider secrets and supplies them on reconnect', async () => {
    const store = new MemoryStore();
    const handle = createHandle('sandbox-1');
    handle.secrets = { bridgeToken: 'token-1' };
    const provider = createProvider(handle);
    const lifecycle = new SandboxLifecycleService(store, provider);

    const created = await lifecycle.ensure('session-1');
    expect(await store.getSandboxSecrets(created.record.id)).toEqual({ bridgeToken: 'token-1' });

    const reconnected = createHandle('sandbox-1');
    vi.mocked(provider.connect).mockResolvedValueOnce(reconnected);
    await lifecycle.ensure('session-1');

    expect(provider.connect).toHaveBeenCalledWith(expect.objectContaining({ secrets: { bridgeToken: 'token-1' } }));
  });

  it('destroys and recreates when sandbox secrets cannot be loaded', async () => {
    const store = new FailingGetSandboxSecretsStore(new Error('decrypt failed'));
    const consoleWarnMock = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const now = new Date();
    await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000003',
      sessionId: 'session-1',
      provider: 'fake',
      providerSandboxId: 'sandbox-1',
      status: 'ready',
      workspacePath: '/workspace',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    const replacement = createHandle('sandbox-2');
    const provider = createProvider(replacement);
    const lifecycle = new SandboxLifecycleService(store, provider);

    try {
      const result = await lifecycle.ensure('session-1');

      expect(result.created).toBe(true);
      expect(result.sandbox.providerSandboxId).toBe('sandbox-2');
      expect(provider.destroy).toHaveBeenCalledWith(expect.objectContaining({ providerSandboxId: 'sandbox-1' }));
      expect(provider.connect).not.toHaveBeenCalled();
      expect(provider.create).toHaveBeenCalled();
      expect(consoleWarnMock).toHaveBeenCalledWith(expect.stringContaining('decrypt failed'));
    } finally {
      consoleWarnMock.mockRestore();
    }
  });

  it('surfaces sandbox secret read failures when creation is disabled', async () => {
    const store = new FailingGetSandboxSecretsStore(new Error('decrypt failed'));
    const now = new Date();
    await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000004',
      sessionId: 'session-1',
      provider: 'fake',
      providerSandboxId: 'sandbox-1',
      status: 'ready',
      workspacePath: '/workspace',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    const provider = createProvider(createHandle('sandbox-1'));
    const lifecycle = new SandboxLifecycleService(store, provider);

    await expect(lifecycle.ensure('session-1', { allowCreate: false })).rejects.toThrow('decrypt failed');

    expect(provider.destroy).not.toHaveBeenCalled();
    expect(provider.connect).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('does not persist a sandbox record when transactional secret persistence fails', async () => {
    const store = new FailingSetSandboxSecretsStore(new Error('secret store unavailable'));
    const handle = createHandle('sandbox-1');
    handle.secrets = { bridgeToken: 'token-1' };
    const provider = createProvider(handle);
    const lifecycle = new SandboxLifecycleService(store, provider);

    await expect(lifecycle.ensure('session-1')).rejects.toThrow('secret store unavailable');

    expect(provider.destroy).toHaveBeenCalledWith(handle);
    await expect(store.getLatestSandbox('session-1', 'fake')).resolves.toBeNull();
  });

  it('skips stopping a sandbox that gained keepalive after being selected for cleanup', async () => {
    const store = new MemoryStore();
    const events = new EventService(store);
    const now = new Date();
    const oldRecord: SandboxRecord = {
      id: '00000000-0000-4000-8000-000000000002',
      sessionId: 'session-1',
      provider: 'fake',
      providerSandboxId: 'sandbox-1',
      status: 'ready',
      workspacePath: '/workspace',
      metadata: {},
      createdAt: now,
      updatedAt: new Date(now.getTime() - 60_000),
    };
    await store.createSession({
      id: 'session-1',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    await store.createSandbox(oldRecord);
    await store.updateSandbox({ ...oldRecord, keepaliveUntil: new Date(now.getTime() + 600_000), updatedAt: now });
    const provider = createProvider(createHandle('sandbox-1'));
    const cleanup = new SandboxCleanupService(new StaleIdleSandboxStore(store, oldRecord), events, provider);

    const result = await cleanup.stopIdleSandboxes({ idleBefore: now, limit: 10 });

    expect(result.stopped).toBe(0);
    expect(provider.stop).not.toHaveBeenCalled();
    await expect(store.getActiveSandbox('session-1', 'fake')).resolves.toMatchObject({ status: 'ready' });
  });
});

class StaleIdleSandboxStore extends MemoryStore {
  constructor(
    private readonly currentStore: MemoryStore,
    private readonly staleRecord: SandboxRecord,
  ) {
    super();
  }

  override async listStoppableSandboxes(): Promise<SandboxRecord[]> {
    return [this.staleRecord];
  }

  override async listActiveSandboxes(sessionId: string, provider: string): Promise<SandboxRecord[]> {
    return this.currentStore.listActiveSandboxes(sessionId, provider);
  }

  override async updateSandbox(record: SandboxRecord): Promise<SandboxRecord> {
    return this.currentStore.updateSandbox(record);
  }

  override async appendEventWithNextSequence(event: Parameters<MemoryStore['appendEventWithNextSequence']>[0]) {
    return this.currentStore.appendEventWithNextSequence(event);
  }
}

class FailingGetSandboxSecretsStore extends MemoryStore {
  constructor(private readonly error: Error) {
    super();
  }

  override async getSandboxSecrets(): Promise<Record<string, string>> {
    throw this.error;
  }
}

class FailingSetSandboxSecretsStore extends MemoryStore {
  constructor(private readonly error: Error) {
    super();
  }

  override async setSandboxSecrets(): Promise<void> {
    throw this.error;
  }
}

function createProvider(handle: SandboxHandle): SandboxProvider {
  return {
    name: 'fake',
    capabilities,
    create: vi.fn(async () => handle),
    connect: vi.fn(async () => handle),
    destroy: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    health: vi.fn(async () => ({ status: 'ready' as const, checkedAt: new Date() })),
  };
}

function createHandle(providerSandboxId: string): SandboxHandle {
  return {
    provider: 'fake',
    providerSandboxId,
    sessionId: 'session-1',
    workspacePath: '/workspace',
    metadata: { owner: 'test' },
    capabilities,
    async exec() {
      const now = new Date();
      return { exitCode: 0, stdout: '', stderr: '', startedAt: now, completedAt: now };
    },
  };
}

class FailingCreateSandboxStore implements SandboxStore {
  constructor(private readonly error: Error) {}

  async getActiveSandbox(): Promise<SandboxRecord | null> {
    return null;
  }

  async getLatestSandbox(): Promise<SandboxRecord | null> {
    return null;
  }

  async getLatestSandboxForSession(): Promise<SandboxRecord | null> {
    return null;
  }

  async listActiveSandboxes(): Promise<SandboxRecord[]> {
    return [];
  }

  async listIdleSandboxes(): Promise<SandboxRecord[]> {
    return [];
  }

  async listStoppableSandboxes(): Promise<SandboxRecord[]> {
    return [];
  }

  async createSandbox(_record: CreateSandboxRecord): Promise<SandboxRecord> {
    throw this.error;
  }

  async createSandboxWithSecrets(record: CreateSandboxRecord): Promise<SandboxRecord> {
    return this.createSandbox(record);
  }

  async updateSandbox(record: SandboxRecord): Promise<SandboxRecord> {
    return record;
  }

  async getSandboxSecrets(): Promise<Record<string, string>> {
    return {};
  }

  async setSandboxSecrets(): Promise<void> {}
}
