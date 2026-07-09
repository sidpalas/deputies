import { randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize, relative } from 'node:path/posix';
import { NotFoundError, Sandbox } from '@superserve/sdk';
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
  SandboxProvider,
  SandboxProviderCheck,
  SandboxRef,
  SandboxServiceEndpoint,
  SandboxServiceEndpointInput,
} from './types.js';

const superserveBridgePort = 3584;

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

type SuperserveCommandOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type SuperserveCommandResult = { exitCode: number; stdout: string; stderr: string };

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
  list(): Promise<SuperserveSandboxInfoLike[]>;
  killById(sandboxId: string): Promise<void>;
};

export type SuperserveSandboxProviderOptions = {
  client?: SuperserveClientLike;
  apiKey?: string;
  baseUrl?: string;
  template?: string;
  workspacePath?: string;
  idleTimeoutMs?: number;
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
    const sandbox = await this.client.connect(input.providerSandboxId);
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
    await this.client.connect(input.providerSandboxId);
  }

  async stop(input: SandboxRef): Promise<void> {
    const sandbox = await this.client.connect(input.providerSandboxId);
    await sandbox.pause();
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    const info = (await this.client.list()).find((sandbox) => sandbox.id === input.providerSandboxId);
    if (!info) return { status: 'missing', checkedAt: new Date() };
    return superserveHealth(info);
  }

  async getServiceEndpoint(input: SandboxServiceEndpointInput): Promise<SandboxServiceEndpoint | null> {
    if (input.port === superserveBridgePort) return null;
    const sandbox = await this.client.connect(input.providerSandboxId);
    const bridgeToken = input.secrets?.bridgeToken ?? randomUUID();
    await ensureSuperserveBridge(sandbox, this.workspacePath, bridgeToken, this.options.bridgeSkippedCookieNames);
    return {
      port: input.port,
      targetUrl: superserveBridgePreviewUrl(sandbox.getPreviewUrl(superserveBridgePort), input.port),
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
        DEPUTIES_SANDBOX_BRIDGE_PORT: String(superserveBridgePort),
      },
    };
    if (this.options.template) options.fromTemplate = this.options.template;
    if (this.options.idleTimeoutMs) options.timeoutSeconds = Math.max(1, Math.ceil(this.options.idleTimeoutMs / 1000));
    return options;
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
    async list() {
      return Sandbox.list(connection);
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
      const result = await runSuperserveFsCommand(sandbox, statScript, resolved);
      if (result.exitCode !== 0)
        throw Object.assign(new Error(result.stderr || `Superserve file not found: ${resolved}`), { statusCode: 404 });
      const value = JSON.parse(result.stdout) as Omit<FileStat, 'mtime'> & { mtimeMs: number };
      return { ...value, mtime: new Date(value.mtimeMs) };
    },
    async readdir(path) {
      const result = await runSuperserveFsCommand(sandbox, readdirScript, resolveSuperservePath(path, workspacePath));
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Superserve directory listing failed');
      return JSON.parse(result.stdout) as string[];
    },
    async exists(path) {
      const result = await runSuperserveFsCommand(sandbox, existsScript, resolveSuperservePath(path, workspacePath));
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Superserve existence check failed');
      return result.stdout.trim() === 'true';
    },
    async mkdir(path, options) {
      const result = await runSuperserveFsCommand(sandbox, mkdirScript, resolveSuperservePath(path, workspacePath), {
        DEPUTIES_RECURSIVE: String(options?.recursive === true),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Superserve directory creation failed');
    },
    async rm(path, options) {
      const result = await runSuperserveFsCommand(sandbox, rmScript, resolveSuperservePath(path, workspacePath), {
        DEPUTIES_RECURSIVE: String(options?.recursive === true),
        DEPUTIES_FORCE: String(options?.force === true),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Superserve file removal failed');
    },
  };
}

async function runSuperserveFsCommand(
  sandbox: SuperserveSandboxLike,
  command: string,
  path: string,
  env: Record<string, string> = {},
): Promise<SuperserveCommandResult> {
  return sandbox.commands.run(command, { env: { DEPUTIES_PATH: path, ...env } });
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
  const command = [
    'PID_FILE=/tmp/deputies-sandbox-bridge.pid;',
    'LOG_FILE=/tmp/deputies-sandbox-bridge.log;',
    `HEALTH_URL=http://127.0.0.1:${superserveBridgePort}/health;`,
    'export HEALTH_URL;',
    `HEALTH_CHECK=${quoteShell(
      'const http=require("node:http");const req=http.get(process.env.HEALTH_URL,{headers:{Authorization:"Bearer "+process.env.DEPUTIES_SANDBOX_TOKEN}},res=>{res.resume();process.exit(res.statusCode===200?0:1);});req.on("error",()=>process.exit(1));req.setTimeout(1000,()=>{req.destroy();process.exit(1);});',
    )};`,
    'health() { node -e "$HEALTH_CHECK" >/dev/null 2>&1; };',
    'start_bridge() {',
    `DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0 DEPUTIES_SANDBOX_BRIDGE_PORT=${superserveBridgePort}`,
    'nohup node /opt/deputies/sandbox-bridge/dist/server.js >> "$LOG_FILE" 2>&1 & echo $! > "$PID_FILE";',
    '};',
    'if ! health; then',
    '[ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null || true;',
    'start_bridge;',
    'fi;',
    'for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
    'health && exit 0;',
    'sleep 0.25;',
    'done;',
    'echo "deputies sandbox bridge did not become ready" >&2;',
    'exit 1;',
  ].join(' ');
  const response = await sandbox.commands.run(command, {
    env: {
      DEPUTIES_SANDBOX_TOKEN: bridgeToken,
      DEPUTIES_WORKSPACE: workspacePath,
      [sandboxBridgeSkipCookieNamesEnv]: skippedCookieNames ?? '',
    },
    timeoutMs: 10_000,
  });
  if (response.exitCode !== 0)
    throw new Error(response.stderr || response.stdout || 'Superserve sandbox bridge did not become ready');
}

function superserveBridgePreviewUrl(targetUrl: string, port: number): string {
  const target = new URL(targetUrl);
  const base = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname;
  target.pathname = `${base}/preview/${port}`;
  return target.toString();
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

function stringMetadata(metadata: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => {
      if (typeof value === 'string') return [key, value];
      return [key, JSON.stringify(value) ?? String(value)];
    }),
  );
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

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}

function isSuperserveNotFoundError(error: unknown): boolean {
  if (error instanceof NotFoundError) return true;
  if (!(error instanceof Error)) return false;
  const named = error as Error & { statusCode?: number; status?: number; code?: string };
  return (
    named.name.includes('NotFound') || named.statusCode === 404 || named.status === 404 || named.code === 'not_found'
  );
}

const statScript =
  'node -e \'const fs=require("node:fs");const s=fs.lstatSync(process.env.DEPUTIES_PATH);process.stdout.write(JSON.stringify({isFile:s.isFile(),isDirectory:s.isDirectory(),isSymbolicLink:s.isSymbolicLink(),size:s.size,mtimeMs:s.mtimeMs}))\'';
const readdirScript =
  'node -e \'const fs=require("node:fs");process.stdout.write(JSON.stringify(fs.readdirSync(process.env.DEPUTIES_PATH)))\'';
const existsScript =
  'node -e \'const fs=require("node:fs");process.stdout.write(String(fs.existsSync(process.env.DEPUTIES_PATH)))\'';
const mkdirScript =
  'node -e \'const fs=require("node:fs");fs.mkdirSync(process.env.DEPUTIES_PATH,{recursive:process.env.DEPUTIES_RECURSIVE==="true"})\'';
const rmScript =
  'node -e \'const fs=require("node:fs");fs.rmSync(process.env.DEPUTIES_PATH,{recursive:process.env.DEPUTIES_RECURSIVE==="true",force:process.env.DEPUTIES_FORCE==="true"})\'';
