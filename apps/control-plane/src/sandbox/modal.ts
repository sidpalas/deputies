import { randomUUID } from 'node:crypto';
import { ModalClient, NotFoundError, Probe, SandboxFilesystemNotFoundError } from 'modal';
import type { ModalClientParams, SandboxCreateParams, SandboxExecParams } from 'modal';
import { sandboxBridgeSkipCookieNamesEnv } from './bridge-env.js';
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

const modalBridgePort = 8080;
const defaultModalAppName = 'deputies-sandboxes';
const defaultModalImage = 'ghcr.io/sidpalas/deputies-daytona-sandbox:latest';
const defaultModalSandboxTimeoutMs = 24 * 60 * 60 * 1000;

export type ModalClientLike = {
  apps: {
    fromName(name: string, params?: { environment?: string; createIfMissing?: boolean }): Promise<unknown>;
  };
  images: {
    fromRegistry(tag: string): unknown;
  };
  sandboxes: {
    create(app: unknown, image: unknown, params?: ModalSandboxCreateParams): Promise<ModalSandboxLike>;
    fromId(sandboxId: string): Promise<ModalSandboxLike>;
  };
  close?(): void;
};

export type ModalSandboxLike = {
  sandboxId: string;
  filesystem: ModalSandboxFilesystemLike;
  exec(command: string[], params?: ModalSandboxExecParams): Promise<ModalContainerProcessLike>;
  poll(): Promise<number | null>;
  terminate(params?: { wait?: boolean }): Promise<void | number>;
  createConnectToken(params?: { userMetadata?: string }): Promise<{ url: string; token: string }>;
  waitUntilReady?(timeoutMs?: number): Promise<void>;
  detach?(): void;
};

export type ModalSandboxFilesystemLike = {
  readText(remotePath: string): Promise<string>;
  readBytes(remotePath: string): Promise<Uint8Array>;
  writeText(data: string, remotePath: string): Promise<void>;
  writeBytes(data: Uint8Array | ArrayBuffer | Buffer, remotePath: string): Promise<void>;
  stat(remotePath: string): Promise<ModalFileInfoLike>;
  listFiles(remotePath: string): Promise<ModalFileInfoLike[]>;
  makeDirectory(remotePath: string, options?: { createParents?: boolean }): Promise<void>;
  remove(remotePath: string, options?: { recursive?: boolean }): Promise<void>;
};

type ModalFileInfoLike = {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedTime: number;
};

type ModalContainerProcessLike = {
  stdout: { readText(): Promise<string> };
  stderr: { readText(): Promise<string> };
  stdin?: { writeText(text: string): Promise<void> };
  closeStdin?(): Promise<void>;
  wait(): Promise<number>;
};

type ModalSandboxCreateParams = SandboxCreateParams & {
  command?: string[];
  env?: Record<string, string>;
  tags?: Record<string, string>;
};

type ModalSandboxExecParams = SandboxExecParams & {
  workdir?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

export type ModalSandboxProviderOptions = {
  client?: ModalClientLike;
  tokenId?: string;
  tokenSecret?: string;
  environment?: string;
  endpoint?: string;
  appName?: string;
  image?: string;
  workspacePath?: string;
  idleTimeoutMs?: number;
  timeoutMs?: number;
  cpu?: number;
  cpuLimit?: number;
  memoryMiB?: number;
  memoryLimitMiB?: number;
  gpu?: string;
  cloud?: string;
  regions?: string[];
  envVars?: Record<string, string>;
  tags?: Record<string, string>;
  bridgeSkippedCookieNames?: string;
  readinessTimeoutMs?: number;
};

export const modalCapabilities: SandboxCapabilities = {
  persistentFilesystem: false,
  snapshots: true,
  stopStart: false,
  exec: true,
  filesystem: true,
  streamingLogs: false,
  portForwarding: true,
  previewUrls: true,
  objectStorageArtifacts: false,
};

export class ModalSandboxProvider implements SandboxProvider {
  readonly name = 'modal';
  readonly capabilities = modalCapabilities;
  private readonly client: ModalClientLike;
  private readonly appName: string;
  private readonly image: string;
  private readonly workspacePath: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ModalSandboxProviderOptions = {}) {
    this.client = options.client ?? createModalClient(options);
    this.appName = options.appName ?? defaultModalAppName;
    this.image = options.image ?? defaultModalImage;
    this.workspacePath = options.workspacePath ?? '/workspace';
    this.timeoutMs = options.timeoutMs ?? defaultModalSandboxTimeoutMs;
  }

  async check(): Promise<SandboxProviderCheck> {
    try {
      await this.app();
      return { status: 'ready', checkedAt: new Date() };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown Modal connectivity error',
        checkedAt: new Date(),
      };
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const bridgeToken = randomUUID();
    const sandboxName = `deputies-${safeId(input.sessionId)}-${randomUUID().slice(0, 8)}`;
    const sandbox = await this.client.sandboxes.create(
      await this.app(),
      this.client.images.fromRegistry(this.image),
      this.createParams(input, sandboxName, bridgeToken),
    );
    try {
      await sandbox.waitUntilReady?.(this.options.readinessTimeoutMs ?? 60_000);
      return this.toHandle(sandbox, input.sessionId, input.metadata ?? {}, { bridgeToken, sandboxName });
    } catch (error) {
      await sandbox.terminate().catch(() => undefined);
      throw error;
    }
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const sandbox = await this.client.sandboxes.fromId(input.providerSandboxId);
    return this.toHandle(sandbox, input.sessionId, input.metadata ?? {}, input.secrets);
  }

  async destroy(input: SandboxRef): Promise<void> {
    try {
      const sandbox = await this.client.sandboxes.fromId(input.providerSandboxId);
      await sandbox.terminate();
    } catch (error) {
      if (isModalNotFoundError(error)) return;
      throw error;
    }
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    try {
      const sandbox = await this.client.sandboxes.fromId(input.providerSandboxId);
      const exitCode = await sandbox.poll();
      if (exitCode === null) return { status: 'ready', checkedAt: new Date() };
      return { status: 'stopped', message: `Modal sandbox exited with code ${exitCode}`, checkedAt: new Date() };
    } catch (error) {
      if (isModalNotFoundError(error)) return { status: 'missing', checkedAt: new Date() };
      throw error;
    }
  }

  async getPreviewUrl(input: SandboxPreviewUrlInput): Promise<SandboxPreviewUrl | null> {
    const sandbox = await this.client.sandboxes.fromId(input.providerSandboxId);
    const bridgeToken = input.secrets?.bridgeToken ?? randomUUID();
    await ensureModalBridge(sandbox, this.workspacePath, bridgeToken, this.options.bridgeSkippedCookieNames);
    const credentials = await sandbox.createConnectToken({
      userMetadata: JSON.stringify({ provider: this.name, sessionId: input.sessionId, port: input.port }),
    });
    return {
      port: input.port,
      targetUrl: modalBridgePreviewUrl(credentials.url, input.port, credentials.token),
      targetHeaders: { authorization: `Bearer ${bridgeToken}` },
      preserveTargetHost: true,
      forwardPreviewHost: true,
      secrets: { bridgeToken },
    };
  }

  private async app(): Promise<unknown> {
    return this.client.apps.fromName(this.appName, {
      createIfMissing: true,
      ...(this.options.environment ? { environment: this.options.environment } : {}),
    });
  }

  private createParams(input: CreateSandboxInput, sandboxName: string, bridgeToken: string): ModalSandboxCreateParams {
    const params: ModalSandboxCreateParams = {
      name: sandboxName,
      tags: {
        ...this.options.tags,
        'deputies-provider': this.name,
        'deputies-session-id': input.sessionId,
      },
      workdir: this.workspacePath,
      timeoutMs: this.timeoutMs,
      command: modalSandboxCommand(),
      readinessProbe: Probe.withTcp(modalBridgePort, { intervalMs: 250 }),
      env: {
        ...(this.options.envVars ?? {}),
        DEPUTIES_WORKSPACE: this.workspacePath,
        DEPUTIES_SANDBOX_TOKEN: bridgeToken,
        DEPUTIES_SANDBOX_BRIDGE_HOST: '0.0.0.0',
        DEPUTIES_SANDBOX_BRIDGE_PORT: String(modalBridgePort),
        ...(this.options.bridgeSkippedCookieNames
          ? { [sandboxBridgeSkipCookieNamesEnv]: this.options.bridgeSkippedCookieNames }
          : {}),
      },
    };
    if (this.options.idleTimeoutMs !== undefined) params.idleTimeoutMs = this.options.idleTimeoutMs;
    if (this.options.cpu !== undefined) params.cpu = this.options.cpu;
    if (this.options.cpuLimit !== undefined) params.cpuLimit = this.options.cpuLimit;
    if (this.options.memoryMiB !== undefined) params.memoryMiB = this.options.memoryMiB;
    if (this.options.memoryLimitMiB !== undefined) params.memoryLimitMiB = this.options.memoryLimitMiB;
    if (this.options.gpu !== undefined) params.gpu = this.options.gpu;
    if (this.options.cloud !== undefined) params.cloud = this.options.cloud;
    if (this.options.regions?.length) params.regions = this.options.regions;
    return params;
  }

  private toHandle(
    sandbox: ModalSandboxLike,
    sessionId: string,
    metadata: Record<string, unknown>,
    secrets: Record<string, string> | undefined,
  ): SandboxHandle {
    return {
      provider: this.name,
      providerSandboxId: sandbox.sandboxId,
      sessionId,
      workspacePath: this.workspacePath,
      metadata: {
        ...metadata,
        appName: this.appName,
        image: this.image,
        workspacePath: this.workspacePath,
      },
      ...(secrets?.bridgeToken ? { secrets: { bridgeToken: secrets.bridgeToken } } : {}),
      capabilities: this.capabilities,
      fs: createModalFileSystem(sandbox.filesystem),
      exec: (command) => execModalCommand(sandbox, command),
    };
  }
}

function createModalClient(options: ModalSandboxProviderOptions): ModalClientLike {
  const params: ModalClientParams = {};
  if (options.tokenId) params.tokenId = options.tokenId;
  if (options.tokenSecret) params.tokenSecret = options.tokenSecret;
  if (options.environment) params.environment = options.environment;
  if (options.endpoint) params.endpoint = options.endpoint;
  return new ModalClient(params);
}

function modalSandboxCommand(): string[] {
  return [
    'sh',
    '-lc',
    [
      'set -eu;',
      'mkdir -p "$DEPUTIES_WORKSPACE" 2>/dev/null || true;',
      'if [ -f /opt/deputies/sandbox-bridge/dist/server.js ]; then',
      'node /opt/deputies/sandbox-bridge/dist/server.js >/tmp/deputies-sandbox-bridge.log 2>&1 &',
      'echo $! > /tmp/deputies-sandbox-bridge.pid;',
      'fi;',
      'sleep infinity',
    ].join(' '),
  ];
}

async function ensureModalBridge(
  sandbox: ModalSandboxLike,
  workspacePath: string,
  bridgeToken: string,
  skippedCookieNames?: string,
): Promise<void> {
  const response = await sandbox.exec(
    [
      'sh',
      '-lc',
      [
        `TOKEN=${quoteShell(bridgeToken)};`,
        `WORKSPACE=${quoteShell(workspacePath)};`,
        `SKIP_COOKIE_NAMES=${quoteShell(skippedCookieNames ?? '')};`,
        `HEALTH_URL=${quoteShell(`http://127.0.0.1:${modalBridgePort}/health`)};`,
        'export TOKEN HEALTH_URL;',
        `HEALTH_CHECK=${quoteShell(
          'const http=require("node:http");const req=http.get(process.env.HEALTH_URL,{headers:{Authorization:"Bearer "+process.env.TOKEN}},res=>{res.resume();process.exit(res.statusCode===200?0:1);});req.on("error",()=>process.exit(1));req.setTimeout(1000,()=>{req.destroy();process.exit(1);});',
        )};`,
        'health() { node -e "$HEALTH_CHECK" >/dev/null 2>&1; };',
        'start_bridge() {',
        'DEPUTIES_SANDBOX_TOKEN="$TOKEN"',
        'DEPUTIES_WORKSPACE="$WORKSPACE"',
        `${sandboxBridgeSkipCookieNamesEnv}="$SKIP_COOKIE_NAMES"`,
        'DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0',
        `DEPUTIES_SANDBOX_BRIDGE_PORT=${modalBridgePort}`,
        'nohup node /opt/deputies/sandbox-bridge/dist/server.js >> /tmp/deputies-sandbox-bridge.log 2>&1 & echo $! > /tmp/deputies-sandbox-bridge.pid;',
        '};',
        'if ! health; then',
        '[ -f /tmp/deputies-sandbox-bridge.pid ] && kill "$(cat /tmp/deputies-sandbox-bridge.pid)" 2>/dev/null || true;',
        'start_bridge;',
        'fi;',
        'for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
        'health && exit 0;',
        'sleep 0.25;',
        'done;',
        'echo "deputies sandbox bridge did not become ready" >&2;',
        'exit 1;',
      ].join(' '),
    ],
    { timeoutMs: 10_000 },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    response.stdout.readText(),
    response.stderr.readText(),
    response.wait(),
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout || 'Modal sandbox bridge did not become ready');
}

function modalBridgePreviewUrl(targetUrl: string, port: number, modalConnectToken: string): string {
  const target = new URL(targetUrl);
  const base = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname;
  target.pathname = `${base}/preview/${port}`;
  target.searchParams.set('_modal_connect_token', modalConnectToken);
  return target.toString();
}

function createModalFileSystem(filesystem: ModalSandboxFilesystemLike): SandboxFileSystem {
  return {
    async readFile(path: string): Promise<string> {
      return filesystem.readText(path);
    },
    async readFileBuffer(path: string): Promise<Uint8Array> {
      return filesystem.readBytes(path);
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      if (typeof content === 'string') await filesystem.writeText(content, path);
      else await filesystem.writeBytes(content, path);
    },
    async stat(path: string): Promise<FileStat> {
      return modalFileStat(await filesystem.stat(path));
    },
    async readdir(path: string): Promise<string[]> {
      return (await filesystem.listFiles(path)).map((entry) => entry.name);
    },
    async exists(path: string): Promise<boolean> {
      try {
        await filesystem.stat(path);
        return true;
      } catch (error) {
        if (isModalNotFoundError(error)) return false;
        throw error;
      }
    },
    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      await filesystem.makeDirectory(path, { createParents: options?.recursive ?? true });
    },
    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      try {
        await filesystem.remove(path, options?.recursive === undefined ? undefined : { recursive: options.recursive });
      } catch (error) {
        if (options?.force && isModalNotFoundError(error)) return;
        throw error;
      }
    },
  };
}

function modalFileStat(info: ModalFileInfoLike): FileStat {
  return {
    isFile: info.type === 'file',
    isDirectory: info.type === 'directory',
    isSymbolicLink: info.type === 'symlink',
    size: info.size,
    mtime: new Date(info.modifiedTime * 1000),
  };
}

async function execModalCommand(sandbox: ModalSandboxLike, input: SandboxExecInput): Promise<SandboxExecResult> {
  if (input.signal?.aborted) throw abortError();
  const startedAt = new Date();
  const run = (async () => {
    const process = await sandbox.exec(['sh', '-lc', input.command], modalExecParams(input));
    if (input.stdin !== undefined) {
      await process.stdin?.writeText(input.stdin);
      await process.closeStdin?.();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      process.stdout.readText(),
      process.stderr.readText(),
      process.wait(),
    ]);
    return { exitCode, stdout, stderr, startedAt, completedAt: new Date() };
  })();
  return abortable(run, input.signal);
}

function modalExecParams(input: SandboxExecInput): ModalSandboxExecParams {
  const params: ModalSandboxExecParams = { stdout: 'pipe', stderr: 'pipe' };
  if (input.cwd) params.workdir = input.cwd;
  if (input.timeoutMs !== undefined) params.timeoutMs = input.timeoutMs;
  if (input.env) params.env = input.env;
  return params;
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
        reject(error instanceof Error ? error : new Error('Modal command failed', { cause: error }));
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
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

function isModalNotFoundError(error: unknown): boolean {
  if (error instanceof NotFoundError || error instanceof SandboxFilesystemNotFoundError) return true;
  if (!(error instanceof Error)) return false;
  const named = error as Error & { code?: string; status?: number; statusCode?: number };
  return (
    named.name.includes('NotFound') || named.code === 'not_found' || named.status === 404 || named.statusCode === 404
  );
}
