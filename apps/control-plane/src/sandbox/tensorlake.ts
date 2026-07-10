import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path/posix';
import {
  Sandbox,
  SandboxNotFoundError,
  SandboxStatus as TensorlakeStatus,
  sandboxUrlFromIngressEndpoint,
  type CreateAndConnectOptions,
  type SandboxClientOptions,
  type SandboxInfo,
  type ProcessInfo,
  type StartProcessOptions,
} from 'tensorlake';
import {
  sandboxBridgeEnvironment,
  sandboxBridgePort,
  sandboxBridgePreviewUrl,
  sandboxBridgeStartupCommand,
  sandboxBridgeTokenHeader,
} from './bridge.js';
import type {
  ConnectSandboxInput,
  CreateSandboxInput,
  FileStat,
  SandboxCapabilities,
  SandboxExecInput,
  SandboxExecResult,
  SandboxFileSystem,
  SandboxHandle,
  SandboxHealth,
  SandboxProvider,
  SandboxProviderCheck,
  SandboxRef,
  SandboxServiceEndpoint,
  SandboxServiceEndpointInput,
  SandboxServiceProcess,
  SandboxServiceProcessInput,
} from './types.js';

export type TensorlakeSandboxProviderOptions = {
  client?: TensorlakeClientLike;
  apiKey?: string;
  image?: string;
  workspacePath?: string;
  idleTimeoutMs?: number;
  cpus?: number;
  memoryMb?: number;
  diskMb?: number;
  allowInternetAccess?: boolean;
  bridgeSkippedCookieNames?: string;
};

export type TensorlakeClientLike = {
  createAndConnect(options?: CreateAndConnectOptions): Promise<TensorlakeSandboxLike>;
  connect(identifier: string): Promise<TensorlakeSandboxLike>;
  list(): Promise<SandboxInfo[]>;
  get(sandboxId: string): Promise<SandboxInfo>;
  update(
    sandboxId: string,
    options: { exposedPorts?: number[]; allowUnauthenticatedAccess?: boolean },
  ): Promise<SandboxInfo>;
  delete(sandboxId: string): Promise<void>;
  suspend(sandboxId: string): Promise<void>;
  resume(sandboxId: string): Promise<void>;
};

export type TensorlakeSandboxLike = {
  sandboxId: string;
  name: string | null;
  info(): Promise<SandboxInfo>;
  update(options: { exposedPorts?: number[]; allowUnauthenticatedAccess?: boolean }): Promise<SandboxInfo>;
  run(
    command: string,
    options?: { args?: string[]; env?: Record<string, string>; workingDir?: string; timeout?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  startProcess?(command: string, options?: StartProcessOptions): Promise<ProcessInfo>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listDirectory(
    path: string,
  ): Promise<{ entries: Array<{ name: string; isDir: boolean; size?: number; modifiedAt?: Date }> }>;
};

export const tensorlakeCapabilities: SandboxCapabilities = {
  persistentFilesystem: true,
  snapshots: true,
  stopStart: true,
  exec: true,
  filesystem: true,
  streamingLogs: false,
  portForwarding: true,
  serviceEndpoints: true,
  objectStorageArtifacts: false,
};

export class TensorlakeSandboxProvider implements SandboxProvider {
  readonly name = 'tensorlake';
  readonly capabilities = tensorlakeCapabilities;
  private readonly client: TensorlakeClientLike;

  constructor(private readonly options: TensorlakeSandboxProviderOptions = {}) {
    this.client = options.client ?? createTensorlakeClient(options);
  }

  async check(): Promise<SandboxProviderCheck> {
    try {
      await this.client.list();
      return { status: 'ready', checkedAt: new Date() };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown Tensorlake connectivity error',
        checkedAt: new Date(),
      };
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const bridgeToken = randomUUID();
    const sandbox = await this.client.createAndConnect(this.createOptions(input));
    try {
      await ensureWorkspace(sandbox, this.workspacePath);
      const info = await this.client.get(sandbox.sandboxId);
      return await this.toHandle(sandbox, info, input.sessionId, input.metadata ?? {}, { bridgeToken });
    } catch (error) {
      await this.destroy({ providerSandboxId: sandbox.sandboxId, sessionId: input.sessionId }).catch(() => undefined);
      throw error;
    }
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const info = await this.client.get(input.providerSandboxId);
    const sandbox = await this.client.connect(input.providerSandboxId);
    await ensureWorkspace(sandbox, this.workspacePath);
    return this.toHandle(sandbox, info, input.sessionId, input.metadata ?? {}, input.secrets);
  }

  async destroy(input: SandboxRef): Promise<void> {
    try {
      await this.client.delete(input.providerSandboxId);
    } catch (error) {
      if (isTensorlakeNotFoundError(error)) return;
      throw error;
    }
  }

  async start(input: SandboxRef): Promise<void> {
    await this.client.resume(input.providerSandboxId);
  }

  async stop(input: SandboxRef): Promise<void> {
    await this.client.suspend(input.providerSandboxId);
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    try {
      const info = await this.client.get(input.providerSandboxId);
      return tensorlakeHealth(info);
    } catch (error) {
      if (isTensorlakeNotFoundError(error)) return { status: 'missing', checkedAt: new Date() };
      throw error;
    }
  }

  async getServiceEndpoint(input: SandboxServiceEndpointInput): Promise<SandboxServiceEndpoint | null> {
    if (input.port === sandboxBridgePort || !this.options.apiKey) return null;
    const info = await this.client.get(input.providerSandboxId);
    const sandbox = await this.client.connect(input.providerSandboxId);
    const bridgeToken = input.secrets?.bridgeToken ?? randomUUID();
    await ensureTensorlakeBridge(sandbox, this.workspacePath, bridgeToken, this.options.bridgeSkippedCookieNames);
    const updated = await this.client.update(input.providerSandboxId, {
      exposedPorts: [sandboxBridgePort],
      allowUnauthenticatedAccess: false,
    });
    const ingressEndpoint = updated.ingressEndpoint ?? info.ingressEndpoint;
    if (!ingressEndpoint) return null;
    return {
      port: input.port,
      targetUrl: sandboxBridgePreviewUrl(
        sandboxUrlFromIngressEndpoint(ingressEndpoint, input.providerSandboxId, sandboxBridgePort),
        input.port,
      ),
      targetHeaders: {
        authorization: `Bearer ${this.options.apiKey}`,
        [sandboxBridgeTokenHeader]: bridgeToken,
      },
      preserveTargetHost: true,
      forwardPreviewHost: true,
      secrets: { bridgeToken },
    };
  }

  private get workspacePath(): string {
    return this.options.workspacePath ?? '/workspace';
  }

  private createOptions(input: CreateSandboxInput): CreateAndConnectOptions {
    const options: CreateAndConnectOptions = {
      name: `deputies-${safeId(input.sessionId)}-${randomUUID().slice(0, 8)}`,
    };
    if (this.options.idleTimeoutMs) options.timeoutSecs = Math.max(1, Math.ceil(this.options.idleTimeoutMs / 1000));
    if (this.options.image) options.image = this.options.image;
    if (this.options.cpus !== undefined) options.cpus = this.options.cpus;
    if (this.options.memoryMb !== undefined) options.memoryMb = this.options.memoryMb;
    if (this.options.diskMb !== undefined) options.diskMb = this.options.diskMb;
    if (this.options.allowInternetAccess !== undefined) options.allowInternetAccess = this.options.allowInternetAccess;
    return options;
  }

  private async toHandle(
    sandbox: TensorlakeSandboxLike,
    info: SandboxInfo,
    sessionId: string,
    metadata: Record<string, unknown>,
    secrets: Record<string, string> | undefined,
  ): Promise<SandboxHandle> {
    return {
      provider: this.name,
      providerSandboxId: sandbox.sandboxId,
      sessionId,
      workspacePath: this.workspacePath,
      metadata: {
        ...metadata,
        name: sandbox.name ?? info.name,
        status: info.status,
        image: info.image,
        ingressEndpoint: info.ingressEndpoint,
      },
      capabilities: this.capabilities,
      ...(secrets?.bridgeToken ? { secrets: { bridgeToken: secrets.bridgeToken } } : {}),
      fs: createTensorlakeFileSystem(sandbox, this.workspacePath),
      exec: (command) => execTensorlakeCommand(sandbox, command, this.workspacePath),
      startService: (input) => startTensorlakeService(sandbox, input, this.workspacePath),
    };
  }
}

async function startTensorlakeService(
  sandbox: TensorlakeSandboxLike,
  input: SandboxServiceProcessInput,
  workspacePath: string,
): Promise<SandboxServiceProcess> {
  if (!sandbox.startProcess) throw new Error('Tensorlake SDK does not support managed processes');
  const process = await sandbox.startProcess('bash', {
    args: ['-lc', `exec ${input.command}`],
    workingDir: resolveTensorlakePath(input.cwd ?? '.', workspacePath),
    ...(input.env ? { env: input.env } : {}),
    name: `deputies-service-${input.port}`,
    restart: { policy: 'on_failure', maxRestarts: 3, initialBackoffMs: 250, maxBackoffMs: 2000 },
    healthCheck: { type: 'tcp', port: input.port, initialDelayMs: 250, intervalMs: 500, timeoutMs: 500 },
  });
  return { pid: process.pid, status: process.managed?.status === 'running' ? 'running' : 'starting' };
}

function createTensorlakeClient(options: TensorlakeSandboxProviderOptions): TensorlakeClientLike {
  const config: Partial<SandboxClientOptions> = {};
  if (options.apiKey) config.apiKey = options.apiKey;
  return {
    async createAndConnect(createOptions?: CreateAndConnectOptions): Promise<TensorlakeSandboxLike> {
      return Sandbox.create({ ...(createOptions ?? {}), ...config });
    },
    async connect(identifier: string): Promise<TensorlakeSandboxLike> {
      return Sandbox.connect({ sandboxId: identifier, ...config });
    },
    async list(): Promise<SandboxInfo[]> {
      return Sandbox.list(config);
    },
    async get(sandboxId: string): Promise<SandboxInfo> {
      const sandbox = await Sandbox.connect({ sandboxId, ...config });
      return sandbox.info();
    },
    async update(
      sandboxId: string,
      updateOptions: { exposedPorts?: number[]; allowUnauthenticatedAccess?: boolean },
    ): Promise<SandboxInfo> {
      const sandbox = await Sandbox.connect({ sandboxId, ...config });
      return sandbox.update(updateOptions);
    },
    async delete(sandboxId: string): Promise<void> {
      const sandbox = await Sandbox.connect({ sandboxId, ...config });
      await sandbox.terminate();
    },
    async suspend(sandboxId: string): Promise<void> {
      const sandbox = await Sandbox.connect({ sandboxId, ...config });
      await sandbox.suspend();
    },
    async resume(sandboxId: string): Promise<void> {
      const sandbox = await Sandbox.connect({ sandboxId, ...config });
      await sandbox.resume();
    },
  };
}

async function ensureWorkspace(sandbox: TensorlakeSandboxLike, workspacePath: string): Promise<void> {
  const result = await execTensorlakeCommand(sandbox, { command: `mkdir -p ${quoteShell(workspacePath)}` });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Tensorlake workspace setup failed');
}

async function ensureTensorlakeBridge(
  sandbox: TensorlakeSandboxLike,
  workspacePath: string,
  bridgeToken: string,
  skippedCookieNames?: string,
): Promise<void> {
  const result = await execTensorlakeCommand(sandbox, {
    command: sandboxBridgeStartupCommand(),
    cwd: workspacePath,
    env: sandboxBridgeEnvironment({ bridgeToken, workspacePath, skippedCookieNames }),
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0)
    throw new Error(result.stderr || result.stdout || 'Tensorlake sandbox bridge did not become ready');
}

function createTensorlakeFileSystem(sandbox: TensorlakeSandboxLike, workspacePath: string): SandboxFileSystem {
  return {
    async readFile(path: string): Promise<string> {
      return Buffer.from(await sandbox.readFile(resolveTensorlakePath(path, workspacePath))).toString('utf-8');
    },
    async readFileBuffer(path: string): Promise<Uint8Array> {
      return sandbox.readFile(resolveTensorlakePath(path, workspacePath));
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      await sandbox.writeFile(resolveTensorlakePath(path, workspacePath), toUint8Array(content));
    },
    async stat(path: string): Promise<FileStat> {
      return statTensorlakePath(sandbox, resolveTensorlakePath(path, workspacePath));
    },
    async readdir(path: string): Promise<string[]> {
      const listing = await sandbox.listDirectory(resolveTensorlakePath(path, workspacePath));
      return listing.entries.map((entry) => entry.name);
    },
    async exists(path: string): Promise<boolean> {
      try {
        await statTensorlakePath(sandbox, resolveTensorlakePath(path, workspacePath));
        return true;
      } catch (error) {
        if (isTensorlakeNotFoundError(error)) return false;
        throw error;
      }
    },
    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      const flags = options?.recursive ? '-p ' : '';
      await execTensorlakeShell(sandbox, `mkdir ${flags}${quoteShell(resolveTensorlakePath(path, workspacePath))}`);
    },
    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      const resolved = resolveTensorlakePath(path, workspacePath);
      if (!options?.recursive && !options?.force) {
        await sandbox.deleteFile(resolved);
        return;
      }
      const flags = `${options.force ? 'f' : ''}${options.recursive ? 'r' : ''}`;
      await execTensorlakeShell(sandbox, `rm -${flags} ${quoteShell(resolved)}`);
    },
  };
}

async function statTensorlakePath(sandbox: TensorlakeSandboxLike, path: string): Promise<FileStat> {
  if (path === '/') {
    return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0, mtime: new Date(0) };
  }
  const parent = dirname(path);
  const name = basename(path);
  const listing = await sandbox.listDirectory(parent === '.' ? '/' : parent);
  const entry = listing.entries.find((candidate) => candidate.name === name);
  if (!entry) throw Object.assign(new Error(`Tensorlake file not found: ${path}`), { statusCode: 404 });
  return {
    isFile: !entry.isDir,
    isDirectory: entry.isDir,
    isSymbolicLink: false,
    size: entry.size ?? 0,
    mtime: entry.modifiedAt ?? new Date(0),
  };
}

async function execTensorlakeShell(sandbox: TensorlakeSandboxLike, command: string): Promise<void> {
  const result = await execTensorlakeCommand(sandbox, { command });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `Tensorlake command failed: ${command}`);
}

async function execTensorlakeCommand(
  sandbox: TensorlakeSandboxLike,
  input: SandboxExecInput,
  workspacePath?: string,
): Promise<SandboxExecResult> {
  if (input.signal?.aborted) throw abortError();
  if (input.stdin !== undefined) throw new Error('Tensorlake exec does not support stdin');
  const startedAt = new Date();
  const workingDir = workspacePath ? resolveTensorlakePath(input.cwd ?? '.', workspacePath) : input.cwd;
  const response = await abortable(
    sandbox.run('bash', {
      args: ['-lc', input.command],
      ...(workingDir ? { workingDir } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.timeoutMs !== undefined ? { timeout: Math.max(1, Math.ceil(input.timeoutMs / 1000)) } : {}),
    }),
    input.signal,
  );
  return {
    exitCode: response.exitCode,
    stdout: response.stdout,
    stderr: response.stderr,
    startedAt,
    completedAt: new Date(),
  };
}

function tensorlakeHealth(info: SandboxInfo): SandboxHealth {
  if (info.status === TensorlakeStatus.RUNNING) return { status: 'ready', checkedAt: new Date() };
  if (
    info.status === TensorlakeStatus.PENDING ||
    info.status === TensorlakeStatus.SNAPSHOTTING ||
    info.status === TensorlakeStatus.SUSPENDING
  ) {
    return { status: 'starting', checkedAt: new Date() };
  }
  if (info.status === TensorlakeStatus.SUSPENDED) return { status: 'stopped', checkedAt: new Date() };
  if (info.status === TensorlakeStatus.TERMINATED || info.status === TensorlakeStatus.TIMEOUT) {
    return { status: 'missing', checkedAt: new Date() };
  }
  return { status: 'unhealthy', message: `Tensorlake sandbox state: ${String(info.status)}`, checkedAt: new Date() };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error('Tensorlake command failed', { cause: error }));
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}

function toUint8Array(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
}

function resolveTensorlakePath(path: string, workspacePath: string): string {
  if (isAbsolute(path)) return normalize(path);
  const workspace = normalizeAbsolutePath(workspacePath);
  const resolved = normalize(join(workspace, path));
  const workspaceRelative = relative(workspace, resolved);
  if (workspaceRelative === '..' || workspaceRelative.startsWith('../') || isAbsolute(workspaceRelative)) {
    throw new Error(`Tensorlake path escapes workspace: ${path}`);
  }
  return resolved;
}

function normalizeAbsolutePath(path: string): string {
  const normalized = normalize(path);
  return isAbsolute(normalized) ? normalized : `/${normalized}`;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'session'
  );
}

function isTensorlakeNotFoundError(error: unknown): boolean {
  if (error instanceof SandboxNotFoundError) return true;
  if (!(error instanceof Error)) return false;
  const named = error as Error & { statusCode?: number; status?: number; code?: string };
  return (
    named.name.includes('NotFound') || named.statusCode === 404 || named.status === 404 || named.code === 'not_found'
  );
}
