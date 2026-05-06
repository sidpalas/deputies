import type {
  ConnectSandboxInput,
  CreateSandboxInput,
  SandboxCapabilities,
  SandboxHandle,
  SandboxHealth,
  SandboxProvider,
  SandboxRef,
} from './types.js';

const capabilities: SandboxCapabilities = {
  persistentFilesystem: true,
  snapshots: false,
  stopStart: false,
  exec: true,
  filesystem: false,
  streamingLogs: false,
  portForwarding: false,
  objectStorageArtifacts: false,
};

export class FakeSandboxProvider implements SandboxProvider {
  readonly name = 'fake';
  readonly capabilities = capabilities;
  private readonly sandboxes = new Map<string, SandboxHandle>();
  private readonly stopped = new Set<string>();
  starts = 0;
  stops = 0;
  destroys = 0;

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const handle = createFakeHandle({
      providerSandboxId: `fake-${input.sessionId}`,
      sessionId: input.sessionId,
      metadata: input.metadata ?? {},
    });
    this.sandboxes.set(handle.providerSandboxId, handle);
    this.stopped.delete(handle.providerSandboxId);
    return handle;
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const existing = this.sandboxes.get(input.providerSandboxId);
    if (existing) return existing;

    const handle = createFakeHandle({
      providerSandboxId: input.providerSandboxId,
      sessionId: input.sessionId,
      metadata: input.metadata ?? {},
    });
    this.sandboxes.set(handle.providerSandboxId, handle);
    this.stopped.delete(handle.providerSandboxId);
    return handle;
  }

  async destroy(input: SandboxRef): Promise<void> {
    this.destroys += 1;
    this.sandboxes.delete(input.providerSandboxId);
    this.stopped.delete(input.providerSandboxId);
  }

  async start(input: SandboxRef): Promise<void> {
    this.starts += 1;
    if (!this.sandboxes.has(input.providerSandboxId)) {
      this.sandboxes.set(input.providerSandboxId, createFakeHandle({ ...input, metadata: {} }));
    }
    this.stopped.delete(input.providerSandboxId);
  }

  async stop(input: SandboxRef): Promise<void> {
    this.stops += 1;
    this.stopped.add(input.providerSandboxId);
  }

  markStopped(providerSandboxId: string): void {
    this.stopped.add(providerSandboxId);
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    if (this.stopped.has(input.providerSandboxId)) return { status: 'stopped', checkedAt: new Date() };
    return {
      status: this.sandboxes.has(input.providerSandboxId) ? 'ready' : 'missing',
      checkedAt: new Date(),
    };
  }
}

function createFakeHandle(input: SandboxRef & { metadata: Record<string, unknown> }): SandboxHandle {
  return {
    provider: 'fake',
    providerSandboxId: input.providerSandboxId,
    sessionId: input.sessionId,
    workspacePath: '/workspace',
    metadata: input.metadata,
    capabilities,
    async exec(command) {
      const now = new Date();
      return {
        exitCode: 0,
        stdout: `fake exec: ${command.command}`,
        stderr: '',
        startedAt: now,
        completedAt: now,
      };
    },
  };
}
