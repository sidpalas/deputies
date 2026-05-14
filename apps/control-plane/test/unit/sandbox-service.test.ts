import { SandboxLifecycleService } from '../../src/sandbox/service.js';
import type { SandboxCapabilities, SandboxHandle, SandboxProvider } from '../../src/sandbox/types.js';
import type { CreateSandboxRecord, SandboxRecord, SandboxStore } from '../../src/store/types.js';

const capabilities: SandboxCapabilities = {
  persistentFilesystem: true,
  snapshots: false,
  stopStart: false,
  exec: true,
  filesystem: false,
  streamingLogs: false,
  portForwarding: false,
  previewUrls: false,
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
});

function createProvider(handle: SandboxHandle): SandboxProvider {
  return {
    name: 'fake',
    capabilities,
    create: vi.fn(async () => handle),
    connect: vi.fn(async () => handle),
    destroy: vi.fn(async () => {}),
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

  async updateSandbox(record: SandboxRecord): Promise<SandboxRecord> {
    return record;
  }
}
