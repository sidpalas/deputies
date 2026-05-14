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
  SandboxRef,
} from './types.js';

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

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const createOptions = this.options.createTimeoutSeconds
      ? { timeout: this.options.createTimeoutSeconds }
      : undefined;
    const sandbox = await this.client.create(this.createParams(input), createOptions);
    try {
      return await this.toHandle(sandbox, input.sessionId, input.metadata ?? {});
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const sandbox = await this.client.get(input.providerSandboxId);
    return this.toHandle(sandbox, input.sessionId, input.metadata ?? {});
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
    const preview = await resolveDaytonaPreviewUrl(sandbox, input.port);
    return preview ? { port: input.port, ...preview } : null;
  }

  private createParams(input: CreateSandboxInput): Record<string, unknown> {
    const labels = {
      ...this.options.labels,
      'flue-session-id': input.sessionId,
    };
    const params: Record<string, unknown> = { labels };
    if (this.options.idleTimeoutMs)
      params.autoStopInterval = Math.max(1, Math.ceil(this.options.idleTimeoutMs / 60_000));
    if (this.options.envVars) params.envVars = this.options.envVars;
    if (this.options.image) params.image = this.options.image;
    if (!this.options.image && this.options.snapshot) params.snapshot = this.options.snapshot;
    return params;
  }

  private async toHandle(
    sandbox: DaytonaSandboxLike,
    sessionId: string,
    metadata: Record<string, unknown>,
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
  if (typeof preview === 'string') return { targetUrl: preview };
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
  const startedAt = new Date();
  const response = await sandbox.process.executeCommand(input.command, input.cwd, input.env, input.timeoutMs);
  return {
    exitCode: response.exitCode ?? 0,
    stdout: response.result ?? '',
    stderr: '',
    startedAt,
    completedAt: new Date(),
  };
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
