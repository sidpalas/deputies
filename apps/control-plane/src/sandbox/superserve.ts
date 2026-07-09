import { randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize, relative } from 'node:path/posix';
import { ConflictError, NotFoundError, Sandbox } from '@superserve/sdk';
import {
  sandboxBridgeEnvironment,
  sandboxBridgePort,
  sandboxBridgePreviewUrl,
  sandboxBridgeStartupCommand,
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
} from './types.js';

const superserveActivationRetryAttempts = 4;
const superserveActivationRetryDelayMs = 100;

type SuperserveStatus = 'active' | 'paused' | 'resuming' | 'failed';

export type SuperserveSandboxInfoLike = {
  id: string;
  name: string;
  status: SuperserveStatus;
  metadata: Record<string, string>;
};

export type SuperserveCreateOptions = {
  name: string;
  fromTemplate?: string;
  timeoutSeconds?: number;
  metadata?: Record<string, string>;
  envVars?: Record<string, string>;
};

export type SuperserveListOptions = {
  metadata?: Record<string, string>;
};

type SuperserveCommandOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type SuperserveCommandResult = { exitCode: number; stdout: string; stderr: string };
type SuperserveFilesystemOperation = 'stat' | 'readdir' | 'exists' | 'mkdir' | 'rm';

export type SuperserveSandboxLike = SuperserveSandboxInfoLike & {
  commands: {
    run(command: string, options?: SuperserveCommandOptions): Promise<SuperserveCommandResult>;
    spawn(
      command: string,
      options?: SuperserveCommandOptions,
    ): Promise<{
      stdin: { write(data: string | Uint8Array): void; close(): void };
      wait(): Promise<SuperserveCommandResult>;
      close(): Promise<void>;
    }>;
  };
  files: {
    read(path: string): Promise<Uint8Array>;
    readText(path: string): Promise<string>;
    write(path: string, content: string | Uint8Array): Promise<void>;
  };
  pause(): Promise<void>;
  getPreviewUrl(port: number): string;
};

export type SuperserveClientLike = {
  create(options: SuperserveCreateOptions): Promise<SuperserveSandboxLike>;
  connect(sandboxId: string): Promise<SuperserveSandboxLike>;
  list(options?: SuperserveListOptions): Promise<SuperserveSandboxInfoLike[]>;
  killById(sandboxId: string): Promise<void>;
};

export type SuperserveSandboxProviderOptions = {
  client?: SuperserveClientLike;
  apiKey?: string;
  baseUrl?: string;
  template?: string;
  workspacePath?: string;
  envVars?: Record<string, string>;
  bridgeSkippedCookieNames?: string;
};

export const superserveCapabilities: SandboxCapabilities = {
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

export class SuperserveSandboxProvider implements SandboxProvider {
  readonly name = 'superserve';
  readonly capabilities = superserveCapabilities;
  private readonly client: SuperserveClientLike;

  constructor(private readonly options: SuperserveSandboxProviderOptions = {}) {
    this.client = options.client ?? createSuperserveClient(options);
  }

  async check(): Promise<SandboxProviderCheck> {
    try {
      await this.client.list();
      return { status: 'ready', checkedAt: new Date() };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown Superserve connectivity error',
        checkedAt: new Date(),
      };
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const bridgeToken = randomUUID();
    const sandbox = await this.client.create(this.createOptions(input));
    try {
      await ensureSuperserveWorkspace(sandbox, this.workspacePath);
      return this.toHandle(sandbox, input.sessionId, input.metadata ?? {}, { bridgeToken });
    } catch (error) {
      await this.destroy({ providerSandboxId: sandbox.id, sessionId: input.sessionId }).catch(() => undefined);
      throw error;
    }
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const sandbox = await this.connectSandbox(input.providerSandboxId);
    await ensureSuperserveWorkspace(sandbox, this.workspacePath);
    return this.toHandle(sandbox, input.sessionId, input.metadata ?? {}, input.secrets);
  }

  async destroy(input: SandboxRef): Promise<void> {
    try {
      await this.client.killById(input.providerSandboxId);
    } catch (error) {
      if (isSuperserveNotFoundError(error)) return;
      throw error;
    }
  }

  async start(input: SandboxRef): Promise<void> {
    await this.connectSandbox(input.providerSandboxId);
  }

  async stop(input: SandboxRef): Promise<void> {
    const sandbox = await this.connectSandbox(input.providerSandboxId);
    await sandbox.pause();
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    const info = (await this.client.list({ metadata: { 'deputies-session-id': input.sessionId } })).find(
      (sandbox) => sandbox.id === input.providerSandboxId,
    );
    if (!info) return { status: 'missing', checkedAt: new Date() };
    return superserveHealth(info);
  }

  async getServiceEndpoint(input: SandboxServiceEndpointInput): Promise<SandboxServiceEndpoint | null> {
    if (input.port === sandboxBridgePort) return null;
    const sandbox = await this.connectSandbox(input.providerSandboxId);
    const bridgeToken = input.secrets?.bridgeToken ?? randomUUID();
    await ensureSuperserveBridge(sandbox, this.workspacePath, bridgeToken, this.options.bridgeSkippedCookieNames);
    return {
      port: input.port,
      targetUrl: sandboxBridgePreviewUrl(sandbox.getPreviewUrl(sandboxBridgePort), input.port),
      targetHeaders: { authorization: `Bearer ${bridgeToken}` },
      preserveTargetHost: true,
      forwardPreviewHost: true,
      secrets: { bridgeToken },
    };
  }

  private get workspacePath(): string {
    return this.options.workspacePath ?? '/workspace';
  }

  private createOptions(input: CreateSandboxInput): SuperserveCreateOptions {
    const options: SuperserveCreateOptions = {
      name: `deputies-${safeId(input.sessionId)}-${randomUUID().slice(0, 8)}`,
      metadata: {
        'deputies-session-id': input.sessionId,
        ...stringMetadata(input.metadata ?? {}),
      },
      envVars: {
        ...(this.options.envVars ?? {}),
        DEPUTIES_WORKSPACE: this.workspacePath,
        DEPUTIES_SANDBOX_BRIDGE_HOST: '0.0.0.0',
        DEPUTIES_SANDBOX_BRIDGE_PORT: String(sandboxBridgePort),
      },
    };
    if (this.options.template) options.fromTemplate = this.options.template;
    return options;
  }

  private async connectSandbox(providerSandboxId: string): Promise<SuperserveSandboxLike> {
    for (let attempt = 0; attempt < superserveActivationRetryAttempts; attempt += 1) {
      try {
        return await this.client.connect(providerSandboxId);
      } catch (error) {
        if (!isSuperserveActivationConflict(error) || attempt === superserveActivationRetryAttempts - 1) throw error;
        await delay(superserveActivationRetryDelayMs * 2 ** attempt);
      }
    }
    throw new Error('Superserve activation retries exhausted');
  }

  private toHandle(
    sandbox: SuperserveSandboxLike,
    sessionId: string,
    metadata: Record<string, unknown>,
    secrets: Record<string, string> | undefined,
  ): SandboxHandle {
    return {
      provider: this.name,
      providerSandboxId: sandbox.id,
      sessionId,
      workspacePath: this.workspacePath,
      metadata: { ...sandbox.metadata, ...metadata, name: sandbox.name, status: sandbox.status },
      capabilities: this.capabilities,
      ...(secrets?.bridgeToken ? { secrets: { bridgeToken: secrets.bridgeToken } } : {}),
      fs: createSuperserveFileSystem(sandbox, this.workspacePath),
      exec: (command) => execSuperserveCommand(sandbox, command, this.workspacePath),
    };
  }
}

function createSuperserveClient(options: SuperserveSandboxProviderOptions): SuperserveClientLike {
  const connection = {
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
  return {
    async create(createOptions) {
      return Sandbox.create({ ...createOptions, ...connection });
    },
    async connect(sandboxId) {
      return Sandbox.connect(sandboxId, connection);
    },
    async list(options = {}) {
      return Sandbox.list({
        ...connection,
        ...(options.metadata ? { metadata: options.metadata } : {}),
      });
    },
    async killById(sandboxId) {
      await Sandbox.killById(sandboxId, connection);
    },
  };
}

async function ensureSuperserveWorkspace(sandbox: SuperserveSandboxLike, workspacePath: string): Promise<void> {
  const response = await sandbox.commands.run(`mkdir -p ${quoteShell(workspacePath)}`);
  if (response.exitCode !== 0)
    throw new Error(response.stderr || response.stdout || 'Superserve workspace setup failed');
}

function createSuperserveFileSystem(sandbox: SuperserveSandboxLike, workspacePath: string): SandboxFileSystem {
  return {
    async readFile(path) {
      return sandbox.files.readText(resolveSuperservePath(path, workspacePath));
    },
    async readFileBuffer(path) {
      return sandbox.files.read(resolveSuperservePath(path, workspacePath));
    },
    async writeFile(path, content) {
      await sandbox.files.write(resolveSuperservePath(path, workspacePath), content);
    },
    async stat(path) {
      const resolved = resolveSuperservePath(path, workspacePath);
      const result = await runSuperserveFsCommand(sandbox, 'stat', resolved);
      if (result.exitCode !== 0)
        throw Object.assign(new Error(result.stderr || `Superserve file not found: ${resolved}`), { statusCode: 404 });
      const value = JSON.parse(result.stdout) as Omit<FileStat, 'mtime'> & { mtimeMs: number };
      return { ...value, mtime: new Date(value.mtimeMs) };
    },
    async readdir(path) {
      const result = await runSuperserveFsCommand(sandbox, 'readdir', resolveSuperservePath(path, workspacePath));
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Superserve directory listing failed');
      return (JSON.parse(result.stdout) as { entries: string[] }).entries;
    },
    async exists(path) {
      const result = await runSuperserveFsCommand(sandbox, 'exists', resolveSuperservePath(path, workspacePath));
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Superserve existence check failed');
      return (JSON.parse(result.stdout) as { exists: boolean }).exists;
    },
    async mkdir(path, options) {
      const result = await runSuperserveFsCommand(sandbox, 'mkdir', resolveSuperservePath(path, workspacePath), {
        DEPUTIES_RECURSIVE: String(options?.recursive === true),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Superserve directory creation failed');
    },
    async rm(path, options) {
      const result = await runSuperserveFsCommand(sandbox, 'rm', resolveSuperservePath(path, workspacePath), {
        DEPUTIES_RECURSIVE: String(options?.recursive === true),
        DEPUTIES_FORCE: String(options?.force === true),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Superserve file removal failed');
    },
  };
}

async function runSuperserveFsCommand(
  sandbox: SuperserveSandboxLike,
  operation: SuperserveFilesystemOperation,
  path: string,
  env: Record<string, string> = {},
): Promise<SuperserveCommandResult> {
  return sandbox.commands.run(`node /opt/deputies/sandbox-bridge/dist/filesystem.js ${operation}`, {
    env: { DEPUTIES_PATH: path, ...env },
  });
}

async function execSuperserveCommand(
  sandbox: SuperserveSandboxLike,
  input: SandboxExecInput,
  workspacePath: string,
): Promise<SandboxExecResult> {
  if (input.signal?.aborted) throw abortError();
  const startedAt = new Date();
  const options: SuperserveCommandOptions = {};
  const cwd = resolveSuperservePath(input.cwd ?? '.', workspacePath);
  if (cwd) options.cwd = cwd;
  if (input.env) options.env = input.env;
  if (input.timeoutMs !== undefined) options.timeoutMs = input.timeoutMs;
  if (input.signal) options.signal = input.signal;

  let response: SuperserveCommandResult;
  if (input.stdin === undefined) {
    response = await sandbox.commands.run(input.command, options);
  } else {
    const session = await sandbox.commands.spawn(input.command, options);
    try {
      session.stdin.write(input.stdin);
      session.stdin.close();
      response = await session.wait();
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }
  return { ...response, startedAt, completedAt: new Date() };
}

async function ensureSuperserveBridge(
  sandbox: SuperserveSandboxLike,
  workspacePath: string,
  bridgeToken: string,
  skippedCookieNames?: string,
): Promise<void> {
  const response = await sandbox.commands.run(sandboxBridgeStartupCommand(), {
    env: sandboxBridgeEnvironment({ bridgeToken, workspacePath, skippedCookieNames }),
    timeoutMs: 10_000,
  });
  if (response.exitCode !== 0)
    throw new Error(response.stderr || response.stdout || 'Superserve sandbox bridge did not become ready');
}

function superserveHealth(info: SuperserveSandboxInfoLike): SandboxHealth {
  if (info.status === 'active') return { status: 'ready', checkedAt: new Date() };
  if (info.status === 'paused') return { status: 'stopped', checkedAt: new Date() };
  if (info.status === 'resuming') return { status: 'starting', checkedAt: new Date() };
  return { status: 'unhealthy', message: `Superserve sandbox state: ${info.status}`, checkedAt: new Date() };
}

function resolveSuperservePath(path: string, workspacePath: string): string {
  if (isAbsolute(path)) return normalize(path);
  const workspace = normalizeAbsolutePath(workspacePath);
  const resolved = normalize(join(workspace, path));
  const workspaceRelative = relative(workspace, resolved);
  if (workspaceRelative === '..' || workspaceRelative.startsWith('../') || isAbsolute(workspaceRelative))
    throw new Error(`Superserve path escapes workspace: ${path}`);
  return resolved;
}

function normalizeAbsolutePath(path: string): string {
  const normalized = normalize(path);
  return isAbsolute(normalized) ? normalized : `/${normalized}`;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stringMetadata(metadata: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => {
      if (typeof value === 'string') return [key, value];
      return [key, JSON.stringify(value) ?? String(value)];
    }),
  );
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

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}

function isSuperserveActivationConflict(error: unknown): boolean {
  if (error instanceof ConflictError) return true;
  if (!(error instanceof Error)) return false;
  const named = error as Error & { statusCode?: number; status?: number; code?: string };
  return named.statusCode === 409 || named.status === 409 || named.code === 'conflict';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isSuperserveNotFoundError(error: unknown): boolean {
  if (error instanceof NotFoundError) return true;
  if (!(error instanceof Error)) return false;
  const named = error as Error & { statusCode?: number; status?: number; code?: string };
  return (
    named.name.includes('NotFound') || named.statusCode === 404 || named.status === 404 || named.code === 'not_found'
  );
}
