import { randomUUID } from 'node:crypto';
import { Daytona } from '@daytona/sdk';
import type { Sandbox as DaytonaSandbox } from '@daytona/sdk';
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
  SandboxPreviewUrl,
  SandboxPreviewUrlInput,
  SandboxProvider,
  SandboxProviderCheck,
  SandboxRef,
} from './types.js';

const daytonaBridgePort = 3584;

export type DaytonaClientLike = {
  create(params?: Record<string, unknown>, options?: { timeout?: number }): Promise<DaytonaSandboxLike>;
  get(idOrName: string): Promise<DaytonaSandboxLike>;
};

export type DaytonaSandboxLike = Pick<DaytonaSandbox, 'id' | 'state' | 'errorReason' | 'target'> & {
  getWorkDir(): Promise<string | undefined>;
  start(timeout?: number): Promise<void>;
  stop(timeout?: number, force?: boolean): Promise<void>;
  delete(): Promise<void>;
  fs: {
    downloadFile(path: string): Promise<Buffer>;
    uploadFile(content: Buffer, path: string): Promise<void>;
    getFileDetails(path: string): Promise<{ isDir?: boolean; size?: number; modTime?: string }>;
    listFiles(path: string): Promise<Array<{ name?: string }>>;
    createFolder(path: string, mode: string): Promise<void>;
    deleteFile(path: string, recursive?: boolean): Promise<void>;
  };
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ result?: string; exitCode?: number }>;
  };
  getPreviewLink?(port: number): Promise<string | DaytonaPreviewLink>;
  getPreviewUrl?(port: number): Promise<string | DaytonaPreviewLink>;
  getPublicUrl?(port: number): Promise<string | DaytonaPreviewLink>;
  refreshActivity?(): Promise<void>;
  setAutostopInterval?(interval: number): Promise<void>;
};

export type DaytonaPreviewLink = {
  url?: string;
  token?: string;
};

export type DaytonaSandboxProviderOptions = {
  client?: DaytonaClientLike;
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  image?: string;
  snapshot?: string;
  workspacePath?: string;
  createTimeoutSeconds?: number;
  idleTimeoutMs?: number;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
};

export const daytonaCapabilities: SandboxCapabilities = {
  persistentFilesystem: true,
  snapshots: true,
  stopStart: true,
  exec: true,
  filesystem: true,
  streamingLogs: false,
  portForwarding: true,
  previewUrls: true,
  objectStorageArtifacts: false,
};

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = 'daytona';
  readonly capabilities = daytonaCapabilities;
  private readonly client: DaytonaClientLike;

  constructor(private readonly options: DaytonaSandboxProviderOptions = {}) {
    this.client = options.client ?? createDaytonaClient(options);
  }

  async check(): Promise<SandboxProviderCheck> {
    try {
      await this.client.get('__deputies_setup_connectivity_check__');
      return { status: 'ready', checkedAt: new Date() };
    } catch (error) {
      if (isNotFoundError(error)) return { status: 'ready', checkedAt: new Date() };
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown Daytona connectivity error',
        checkedAt: new Date(),
      };
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const createOptions = this.options.createTimeoutSeconds
      ? { timeout: this.options.createTimeoutSeconds }
      : undefined;
    const bridgeToken = randomUUID();
    const sandbox = await this.client.create(this.createParams(input, bridgeToken), createOptions);
    try {
      return await this.toHandle(sandbox, input.sessionId, input.metadata ?? {}, { bridgeToken });
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const sandbox = await this.client.get(input.providerSandboxId);
    return this.toHandle(sandbox, input.sessionId, input.metadata ?? {}, input.secrets);
  }

  async destroy(input: SandboxRef): Promise<void> {
    try {
      const sandbox = await this.client.get(input.providerSandboxId);
      await sandbox.delete();
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
  }

  async start(input: SandboxRef): Promise<void> {
    const sandbox = await this.client.get(input.providerSandboxId);
    await sandbox.start();
  }

  async stop(input: SandboxRef): Promise<void> {
    const sandbox = await this.client.get(input.providerSandboxId);
    await sandbox.stop();
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    try {
      const sandbox = await this.client.get(input.providerSandboxId);
      if (sandbox.state === 'started') return { status: 'ready', checkedAt: new Date() };
      if (sandbox.state === 'starting') return { status: 'starting', checkedAt: new Date() };
      if (sandbox.state === 'stopped') return { status: 'stopped', checkedAt: new Date() };
      return {
        status: 'unhealthy',
        message: sandbox.errorReason ?? `Daytona sandbox state: ${sandbox.state ?? 'unknown'}`,
        checkedAt: new Date(),
      };
    } catch (error) {
      if (isNotFoundError(error)) return { status: 'missing', checkedAt: new Date() };
      throw error;
    }
  }

  async getPreviewUrl(input: SandboxPreviewUrlInput): Promise<SandboxPreviewUrl | null> {
    const sandbox = await this.client.get(input.providerSandboxId);
    const bridgeToken = input.secrets?.bridgeToken ?? randomUUID();
    const workspacePath = this.options.workspacePath ?? (await sandbox.getWorkDir()) ?? '/workspace';
    await ensureDaytonaBridge(sandbox, workspacePath, bridgeToken);
    const preview = await resolveDaytonaPreviewUrl(sandbox, daytonaBridgePort);
    if (!preview) return null;
    return {
      port: input.port,
      targetUrl: daytonaBridgePreviewUrl(preview.targetUrl, input.port),
      targetHeaders: {
        ...preview.targetHeaders,
        authorization: `Bearer ${bridgeToken}`,
      },
      preserveTargetHost: true,
      secrets: { bridgeToken },
    };
  }

  async refreshKeepalive(input: SandboxRef & { durationMs: number }): Promise<void> {
    const sandbox = await this.client.get(input.providerSandboxId);
    const requestedMinutes = Math.max(1, Math.ceil(input.durationMs / 60_000));
    const fallbackMinutes = this.options.idleTimeoutMs
      ? Math.max(1, Math.ceil(this.options.idleTimeoutMs / 60_000))
      : 0;
    if (sandbox.setAutostopInterval && requestedMinutes > fallbackMinutes)
      await sandbox.setAutostopInterval(requestedMinutes);
    await sandbox.refreshActivity?.();
  }

  private createParams(input: CreateSandboxInput, bridgeToken: string): Record<string, unknown> {
    const labels = {
      ...this.options.labels,
      'flue-session-id': input.sessionId,
    };
    const params: Record<string, unknown> = { labels };
    if (this.options.idleTimeoutMs)
      params.autoStopInterval = Math.max(1, Math.ceil(this.options.idleTimeoutMs / 60_000));
    params.envVars = {
      ...(this.options.envVars ?? {}),
      DEPUTIES_SANDBOX_TOKEN: bridgeToken,
      DEPUTIES_WORKSPACE: this.options.workspacePath ?? '/workspace',
      DEPUTIES_SANDBOX_BRIDGE_HOST: '0.0.0.0',
      DEPUTIES_SANDBOX_BRIDGE_PORT: String(daytonaBridgePort),
    };
    if (this.options.image) params.image = this.options.image;
    if (!this.options.image && this.options.snapshot) params.snapshot = this.options.snapshot;
    return params;
  }

  private async toHandle(
    sandbox: DaytonaSandboxLike,
    sessionId: string,
    metadata: Record<string, unknown>,
    secrets: Record<string, string> | undefined,
  ): Promise<SandboxHandle> {
    const workspacePath = this.options.workspacePath ?? (await sandbox.getWorkDir()) ?? '/home/daytona';
    return {
      provider: this.name,
      providerSandboxId: sandbox.id,
      sessionId,
      workspacePath,
      metadata: {
        ...metadata,
        target: sandbox.target,
        state: sandbox.state,
      },
      capabilities: this.capabilities,
      ...(secrets?.bridgeToken ? { secrets: { bridgeToken: secrets.bridgeToken } } : {}),
      fs: createDaytonaFileSystem(sandbox),
      exec: (command) => execDaytonaCommand(sandbox, command),
    };
  }
}

function createDaytonaClient(options: DaytonaSandboxProviderOptions): DaytonaClientLike {
  const config: ConstructorParameters<typeof Daytona>[0] = {};
  if (options.apiKey) config.apiKey = options.apiKey;
  if (options.apiUrl) config.apiUrl = options.apiUrl;
  if (options.target) config.target = options.target;
  return new Daytona(config);
}

async function resolveDaytonaPreviewUrl(
  sandbox: DaytonaSandboxLike,
  port: number,
): Promise<{ targetUrl: string; targetHeaders?: Record<string, string> } | null> {
  const preview = sandbox.getPreviewLink
    ? await sandbox.getPreviewLink(port)
    : sandbox.getPreviewUrl
      ? await sandbox.getPreviewUrl(port)
      : sandbox.getPublicUrl
        ? await sandbox.getPublicUrl(port)
        : null;
  if (typeof preview === 'string') {
    return { targetUrl: preview, targetHeaders: { 'x-daytona-skip-preview-warning': 'true' } };
  }
  if (preview?.url) {
    return {
      targetUrl: preview.url,
      targetHeaders: {
        'x-daytona-skip-preview-warning': 'true',
        ...(preview.token ? { 'x-daytona-preview-token': preview.token } : {}),
      },
    };
  }
  return null;
}

function daytonaBridgePreviewUrl(targetUrl: string, port: number): string {
  const target = new URL(targetUrl);
  const base = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname;
  target.pathname = `${base}/preview/${port}`;
  return target.toString();
}

async function ensureDaytonaBridge(
  sandbox: DaytonaSandboxLike,
  workspacePath: string,
  bridgeToken: string,
): Promise<void> {
  const pidFile = '/tmp/deputies-sandbox-bridge.pid';
  const logFile = '/tmp/deputies-sandbox-bridge.log';
  await sandbox.process.executeCommand(
    [
      `if [ ! -f ${quoteShell(pidFile)} ] || ! kill -0 "$(cat ${quoteShell(pidFile)})" 2>/dev/null; then`,
      `DEPUTIES_SANDBOX_TOKEN=${quoteShell(bridgeToken)}`,
      `DEPUTIES_WORKSPACE=${quoteShell(workspacePath)}`,
      'DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0',
      `DEPUTIES_SANDBOX_BRIDGE_PORT=${daytonaBridgePort}`,
      'nohup node /opt/deputies/sandbox-bridge/dist/server.js',
      `>> ${quoteShell(logFile)} 2>&1 & echo $! > ${quoteShell(pidFile)};`,
      'fi',
    ].join(' '),
    undefined,
    undefined,
    5,
  );
}

function createDaytonaFileSystem(sandbox: DaytonaSandboxLike): SandboxFileSystem {
  return {
    async readFile(path: string): Promise<string> {
      const buffer = await sandbox.fs.downloadFile(path);
      return buffer.toString('utf-8');
    },
    async readFileBuffer(path: string): Promise<Uint8Array> {
      const buffer = await sandbox.fs.downloadFile(path);
      return new Uint8Array(buffer);
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      await sandbox.fs.uploadFile(toBuffer(content), path);
    },
    async stat(path: string): Promise<FileStat> {
      const info = await sandbox.fs.getFileDetails(path);
      return {
        isFile: !info.isDir,
        isDirectory: info.isDir ?? false,
        isSymbolicLink: false,
        size: info.size ?? 0,
        mtime: info.modTime ? new Date(info.modTime) : new Date(0),
      };
    },
    async readdir(path: string): Promise<string[]> {
      const entries = await sandbox.fs.listFiles(path);
      return entries.map((entry) => entry.name).filter((name): name is string => Boolean(name));
    },
    async exists(path: string): Promise<boolean> {
      try {
        await sandbox.fs.getFileDetails(path);
        return true;
      } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
      }
    },
    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      if (options?.recursive) {
        await execDaytonaCommand(sandbox, { command: `mkdir -p ${quoteShell(path)}` });
        return;
      }
      await sandbox.fs.createFolder(path, '755');
    },
    async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
      await sandbox.fs.deleteFile(path, options?.recursive);
    },
  };
}

async function execDaytonaCommand(sandbox: DaytonaSandboxLike, input: SandboxExecInput): Promise<SandboxExecResult> {
  if (input.signal?.aborted) throw abortError();
  const startedAt = new Date();
  // Daytona's direct executeCommand API does not expose a remote command cancel/kill handle.
  // Aborting here only stops Deputies from waiting; the remote command may keep mutating the sandbox.
  const response = await abortable(
    sandbox.process.executeCommand(input.command, input.cwd, input.env, daytonaTimeoutSeconds(input.timeoutMs)),
    input.signal,
  );
  return {
    exitCode: response.exitCode ?? 0,
    stdout: response.result ?? '',
    stderr: '',
    startedAt,
    completedAt: new Date(),
  };
}

function daytonaTimeoutSeconds(timeoutMs: number | undefined): number | undefined {
  return timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(timeoutMs / 1000));
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
        reject(error);
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const named = error as Error & { code?: string; statusCode?: number; status?: number };
  return (
    named.name.includes('NotFound') || named.code === 'not_found' || named.statusCode === 404 || named.status === 404
  );
}
