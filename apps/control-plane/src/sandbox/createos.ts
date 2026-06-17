import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path/posix';
import {
  CreateosSandboxClient,
  CreateosSandboxNotFoundError,
  type CreateSandboxRequest,
  type Sandbox as CreateosSandbox,
  type SandboxStatus as CreateosSandboxStatus,
} from '@nodeops-createos/sandbox';
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

export type CreateosSandboxProviderOptions = {
  client?: CreateosClientLike;
  apiKey?: string;
  baseUrl?: string;
  shape?: string;
  rootfs?: string;
  workspacePath?: string;
};

export type CreateosExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

// Minimal seam over the @nodeops-createos/sandbox SDK so unit tests can drive
// the provider without a live control plane. The real implementation wraps
// `CreateosSandboxClient` / `Sandbox` in `createCreateosClient`.
export type CreateosClientLike = {
  create(request: CreateSandboxRequest): Promise<CreateosSandboxLike>;
  get(sandboxId: string): Promise<CreateosSandboxLike>;
  ready(): Promise<boolean>;
};

export type CreateosSandboxLike = {
  readonly id: string;
  status(): CreateosSandboxStatus;
  runCommand(command: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CreateosExecResult>;
  uploadFile(path: string, data: Uint8Array): Promise<void>;
  downloadFile(path: string): Promise<Uint8Array>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;
  enableIngress(): Promise<string | undefined>;
};

const DEFAULT_WORKSPACE_PATH = '/workspace';
const DEFAULT_SHAPE = 's-2vcpu-4gb';
// The published SDK requires an explicit base URL, so default it here to the
// production control plane when the deployment does not pin CREATEOS_BASE_URL.
const DEFAULT_BASE_URL = 'https://api.sb.createos.sh';

export const createosCapabilities: SandboxCapabilities = {
  // The VM disk survives pause/resume, so the workspace persists across stops.
  persistentFilesystem: true,
  // fork() exists in the SDK but maps to "branch a new sandbox", not the
  // save/restore-a-named-checkpoint semantics Deputies models as snapshots.
  snapshots: false,
  stopStart: true,
  exec: true,
  filesystem: true,
  // streamCommand() exists in the SDK but Deputies has no streaming-logs hook.
  streamingLogs: false,
  portForwarding: false,
  // HTTP ingress is exposed via setIngress() + the ingress URL template.
  serviceEndpoints: true,
  objectStorageArtifacts: false,
};

export class CreateosSandboxProvider implements SandboxProvider {
  readonly name = 'createos';
  readonly capabilities = createosCapabilities;
  private readonly client: CreateosClientLike;
  private readonly shape: string;
  private readonly rootfs: string | undefined;
  private readonly workspacePath: string;

  constructor(private readonly options: CreateosSandboxProviderOptions = {}) {
    this.client = options.client ?? createCreateosClient(options);
    this.shape = options.shape ?? DEFAULT_SHAPE;
    this.rootfs = options.rootfs;
    this.workspacePath = options.workspacePath ?? DEFAULT_WORKSPACE_PATH;
  }

  async check(): Promise<SandboxProviderCheck> {
    try {
      const ready = await this.client.ready();
      return ready
        ? { status: 'ready', checkedAt: new Date() }
        : { status: 'unhealthy', message: 'CreateOS control plane is not ready', checkedAt: new Date() };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown CreateOS connectivity error',
        checkedAt: new Date(),
      };
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const request: CreateSandboxRequest = {
      shape: this.shape,
      name: createosSandboxName(input.sessionId),
      ...(this.rootfs ? { rootfs: this.rootfs } : {}),
    };
    const sandbox = await this.client.create(request);
    try {
      await this.ensureWorkspace(sandbox);
      return this.toHandle(sandbox, input.sessionId, input.metadata ?? {});
    } catch (error) {
      await this.destroy({ providerSandboxId: sandbox.id, sessionId: input.sessionId }).catch(() => undefined);
      throw error;
    }
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const sandbox = await this.client.get(input.providerSandboxId);
    return this.toHandle(sandbox, input.sessionId, input.metadata ?? {});
  }

  async start(input: SandboxRef): Promise<void> {
    const sandbox = await this.client.get(input.providerSandboxId);
    await sandbox.resume();
  }

  async stop(input: SandboxRef): Promise<void> {
    const sandbox = await this.client.get(input.providerSandboxId);
    await sandbox.pause();
  }

  async destroy(input: SandboxRef): Promise<void> {
    try {
      const sandbox = await this.client.get(input.providerSandboxId);
      await sandbox.destroy();
    } catch (error) {
      if (isCreateosNotFoundError(error)) return;
      throw error;
    }
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    try {
      const sandbox = await this.client.get(input.providerSandboxId);
      return createosHealth(sandbox.status());
    } catch (error) {
      if (isCreateosNotFoundError(error)) return { status: 'missing', checkedAt: new Date() };
      throw error;
    }
  }

  async getServiceEndpoint(input: SandboxServiceEndpointInput): Promise<SandboxServiceEndpoint | null> {
    const sandbox = await this.client.get(input.providerSandboxId);
    const template = await sandbox.enableIngress();
    if (!template) return null;
    return {
      port: input.port,
      targetUrl: template.replace('<port>', String(input.port)),
      preserveTargetHost: true,
    };
  }

  private async ensureWorkspace(sandbox: CreateosSandboxLike): Promise<void> {
    const result = await sandbox.runCommand(`mkdir -p ${quoteShell(this.workspacePath)}`);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'CreateOS workspace setup failed');
  }

  private toHandle(sandbox: CreateosSandboxLike, sessionId: string, metadata: Record<string, unknown>): SandboxHandle {
    return {
      provider: this.name,
      providerSandboxId: sandbox.id,
      sessionId,
      workspacePath: this.workspacePath,
      metadata,
      capabilities: this.capabilities,
      fs: createCreateosFileSystem(sandbox, this.workspacePath),
      exec: (execInput) => execCreateosCommand(sandbox, execInput, this.workspacePath),
    };
  }
}

function createCreateosClient(options: CreateosSandboxProviderOptions): CreateosClientLike {
  const client = new CreateosSandboxClient({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
  });
  return {
    async create(request) {
      return wrapCreateosSandbox(await client.createSandbox(request));
    },
    async get(sandboxId) {
      return wrapCreateosSandbox(await client.getSandbox(sandboxId));
    },
    async ready() {
      const probe = await client.readyz();
      return probe.ready;
    },
  };
}

function wrapCreateosSandbox(sandbox: CreateosSandbox): CreateosSandboxLike {
  return {
    id: sandbox.id,
    status: () => sandbox.status,
    async runCommand(command, runOptions) {
      const response = await sandbox.runCommand('bash', ['-lc', command], {
        ...(runOptions?.signal ? { signal: runOptions.signal } : {}),
        ...(runOptions?.timeoutMs !== undefined ? { timeoutMs: runOptions.timeoutMs } : {}),
      });
      const result = response.result;
      return {
        exitCode: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.error ? { error: result.error } : {}),
      };
    },
    async uploadFile(path, data) {
      await sandbox.files.upload(path, data);
    },
    async downloadFile(path) {
      return new Uint8Array(await sandbox.files.download(path));
    },
    async pause() {
      // Settle to `paused` so a later resume() does not race a `pausing` state.
      await sandbox.pause();
      await sandbox.waitUntilPaused();
    },
    async resume() {
      await sandbox.resume();
      await sandbox.waitUntilRunning();
    },
    async destroy() {
      await sandbox.destroy();
    },
    async enableIngress() {
      await sandbox.setIngress(true);
      return sandbox.data.ingress_url_template;
    },
  };
}

// CreateOS exec has no per-command env, cwd, or stdin (the control plane
// overwrites the proto env with the sandbox's persistent envs and exposes no
// stdin field), so cwd and env are emulated inside the bash -lc script.
async function execCreateosCommand(
  sandbox: CreateosSandboxLike,
  input: SandboxExecInput,
  workspacePath: string,
): Promise<SandboxExecResult> {
  if (input.stdin !== undefined) throw new Error('CreateOS exec does not support stdin');
  if (input.signal?.aborted) throw abortError();
  const startedAt = new Date();
  const response = await sandbox.runCommand(buildExecScript(input, workspacePath), {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  const completedAt = new Date();
  if (response.error) throw new Error(response.error);
  return {
    exitCode: response.exitCode,
    stdout: response.stdout,
    stderr: response.stderr,
    startedAt,
    completedAt,
  };
}

function buildExecScript(input: SandboxExecInput, workspacePath: string): string {
  const segments: string[] = [];
  const cwd = input.cwd ? resolveCreateosPath(input.cwd, workspacePath) : workspacePath;
  segments.push(`cd ${quoteShell(cwd)}`);
  for (const [key, value] of Object.entries(input.env ?? {})) {
    segments.push(`export ${key}=${quoteShell(value)}`);
  }
  segments.push(input.command);
  return segments.join(' && ');
}

function createCreateosFileSystem(sandbox: CreateosSandboxLike, workspacePath: string): SandboxFileSystem {
  return {
    async readFile(path) {
      return Buffer.from(await readCreateosFile(sandbox, path, workspacePath)).toString('utf8');
    },
    async readFileBuffer(path) {
      return readCreateosFile(sandbox, path, workspacePath);
    },
    async writeFile(path, content) {
      const resolved = resolveCreateosPath(path, workspacePath);
      await ensureParentDirectory(sandbox, resolved);
      await sandbox.uploadFile(resolved, toUint8Array(content));
    },
    async stat(path) {
      return statCreateosPath(sandbox, resolveCreateosPath(path, workspacePath));
    },
    async readdir(path) {
      const resolved = resolveCreateosPath(path, workspacePath);
      const result = await sandbox.runCommand(`ls -1A ${quoteShell(resolved)}`);
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(`CreateOS directory not found: ${path}`), { statusCode: 404 });
      }
      return result.stdout.split('\n').filter((entry) => entry.length > 0);
    },
    async exists(path) {
      const resolved = resolveCreateosPath(path, workspacePath);
      const result = await sandbox.runCommand(`test -e ${quoteShell(resolved)}`);
      return result.exitCode === 0;
    },
    async mkdir(path, mkdirOptions) {
      const resolved = resolveCreateosPath(path, workspacePath);
      const flag = mkdirOptions?.recursive ? '-p ' : '';
      const result = await sandbox.runCommand(`mkdir ${flag}${quoteShell(resolved)}`);
      if (result.exitCode !== 0) throw new Error(result.stderr || `CreateOS mkdir failed: ${path}`);
    },
    async rm(path, rmOptions) {
      const resolved = resolveCreateosPath(path, workspacePath);
      const flags = `${rmOptions?.recursive ? 'r' : ''}${rmOptions?.force ? 'f' : ''}`;
      const flagArg = flags ? `-${flags} ` : '';
      const result = await sandbox.runCommand(`rm ${flagArg}${quoteShell(resolved)}`);
      if (result.exitCode !== 0 && !rmOptions?.force) {
        throw new Error(result.stderr || `CreateOS rm failed: ${path}`);
      }
    },
  };
}

async function readCreateosFile(
  sandbox: CreateosSandboxLike,
  path: string,
  workspacePath: string,
): Promise<Uint8Array> {
  try {
    return await sandbox.downloadFile(resolveCreateosPath(path, workspacePath));
  } catch (error) {
    if (isCreateosNotFoundError(error)) {
      throw Object.assign(new Error(`CreateOS file not found: ${path}`), { statusCode: 404 });
    }
    throw error;
  }
}

async function statCreateosPath(sandbox: CreateosSandboxLike, resolved: string): Promise<FileStat> {
  const result = await sandbox.runCommand(`stat -c '%F|%s|%Y' ${quoteShell(resolved)}`);
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(`CreateOS file not found: ${resolved}`), { statusCode: 404 });
  }
  const [kind = '', size = '0', mtime = '0'] = result.stdout.trim().split('|');
  return {
    isFile: kind === 'regular file' || kind === 'regular empty file',
    isDirectory: kind === 'directory',
    isSymbolicLink: kind === 'symbolic link',
    size: Number.parseInt(size, 10) || 0,
    mtime: new Date((Number.parseInt(mtime, 10) || 0) * 1000),
  };
}

async function ensureParentDirectory(sandbox: CreateosSandboxLike, resolvedPath: string): Promise<void> {
  const parent = dirname(resolvedPath);
  if (!parent || parent === '.' || parent === '/') return;
  const result = await sandbox.runCommand(`mkdir -p ${quoteShell(parent)}`);
  if (result.exitCode !== 0) throw new Error(result.stderr || `CreateOS mkdir failed: ${parent}`);
}

function createosHealth(status: CreateosSandboxStatus): SandboxHealth {
  const checkedAt = new Date();
  switch (status) {
    case 'running':
      return { status: 'ready', checkedAt };
    case 'creating':
    case 'resuming':
    case 'forking':
      return { status: 'starting', checkedAt };
    case 'pausing':
    case 'paused':
      return { status: 'stopped', checkedAt };
    case 'destroying':
    case 'destroyed':
      return { status: 'missing', checkedAt };
    default:
      return { status: 'unhealthy', message: `CreateOS sandbox state: ${String(status)}`, checkedAt };
  }
}

function resolveCreateosPath(path: string, workspacePath: string): string {
  if (isAbsolute(path)) return normalize(path);
  const workspace = normalizeAbsolutePath(workspacePath);
  const resolved = normalize(join(workspace, path));
  const workspaceRelative = relative(workspace, resolved);
  if (workspaceRelative === '..' || workspaceRelative.startsWith('../') || isAbsolute(workspaceRelative)) {
    throw new Error(`CreateOS path escapes workspace: ${path}`);
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

// CreateOS caps sandbox names at 22 characters. Keep a short session hint plus
// random uniqueness within that budget; Deputies tracks identity by the
// server-assigned providerSandboxId, not the name.
function createosSandboxName(sessionId: string): string {
  const session = safeId(sessionId).slice(0, 8).replace(/-+$/, '') || 'sb';
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  return `dep-${session}-${suffix}`.slice(0, 22);
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

function isCreateosNotFoundError(error: unknown): boolean {
  if (error instanceof CreateosSandboxNotFoundError) return true;
  if (!(error instanceof Error)) return false;
  const named = error as Error & { statusCode?: number; status?: number; code?: string };
  return (
    named.name.includes('NotFound') || named.statusCode === 404 || named.status === 404 || named.code === 'not_found'
  );
}

function toUint8Array(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}
