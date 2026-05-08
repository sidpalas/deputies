import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
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
  SandboxRef,
} from './types.js';

const maxOutputBytes = 1024 * 1024;
export const defaultLocalAllowedCommands = [
  'bash',
  'cat',
  'chmod',
  'corepack',
  'cp',
  'date',
  'dirname',
  'env',
  'find',
  'gh',
  'git',
  'grep',
  'head',
  'ls',
  'make',
  'mkdir',
  'mv',
  'node',
  'npm',
  'npx',
  'pnpm',
  'pwd',
  'python',
  'python3',
  'rg',
  'rm',
  'sed',
  'sh',
  'sort',
  'tail',
  'tar',
  'touch',
  'uname',
  'wc',
  'xargs',
] as const;
const inheritedEnvKeys = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SSH_AUTH_SOCK',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
] as const;

export type LocalSandboxProviderOptions = {
  rootDir?: string;
  allowedCommands?: string[];
};

export const localCapabilities: SandboxCapabilities = {
  persistentFilesystem: true,
  snapshots: false,
  stopStart: false,
  exec: true,
  filesystem: true,
  streamingLogs: false,
  portForwarding: false,
  objectStorageArtifacts: false,
};

export class LocalSandboxProvider implements SandboxProvider {
  readonly name = 'local';
  readonly capabilities = localCapabilities;

  constructor(private readonly options: LocalSandboxProviderOptions = {}) {}

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const rootDir = await this.ensureRootDir();
    const workspacePath = await mkdtemp(join(rootDir, `${safeId(input.sessionId)}-`));
    return this.toHandle({
      providerSandboxId: localProviderSandboxId(workspacePath),
      sessionId: input.sessionId,
      workspacePath,
      metadata: input.metadata ?? {},
    });
  }

  async connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    const workspacePath = workspacePathFromProviderSandboxId(input.providerSandboxId);
    await assertDirectory(workspacePath);
    return this.toHandle({
      providerSandboxId: input.providerSandboxId,
      sessionId: input.sessionId,
      workspacePath,
      metadata: input.metadata ?? {},
    });
  }

  async destroy(input: SandboxRef): Promise<void> {
    await rm(workspacePathFromProviderSandboxId(input.providerSandboxId), { recursive: true, force: true });
  }

  async health(input: SandboxRef): Promise<SandboxHealth> {
    try {
      await assertDirectory(workspacePathFromProviderSandboxId(input.providerSandboxId));
      return { status: 'ready', checkedAt: new Date() };
    } catch {
      return { status: 'missing', checkedAt: new Date() };
    }
  }

  private async ensureRootDir(): Promise<string> {
    const rootDir = this.options.rootDir ?? join(tmpdir(), 'deputies-local-sandboxes');
    await mkdir(rootDir, { recursive: true });
    return rootDir;
  }

  private async toHandle(input: {
    providerSandboxId: string;
    sessionId: string;
    workspacePath: string;
    metadata: Record<string, unknown>;
  }): Promise<SandboxHandle> {
    const toolPath = await createAllowedToolPath(input.workspacePath, this.options.allowedCommands ?? [...defaultLocalAllowedCommands]);
    return {
      provider: this.name,
      providerSandboxId: input.providerSandboxId,
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      metadata: input.metadata,
      capabilities: this.capabilities,
      fs: createLocalFileSystem(input.workspacePath),
      exec: async (command) => execLocalCommand(input.workspacePath, toolPath, command),
    };
  }
}

function createLocalFileSystem(rootDir: string): SandboxFileSystem {
  return {
    async readFile(path: string): Promise<string> {
      return readFile(resolveSandboxPath(rootDir, path), 'utf-8');
    },
    async readFileBuffer(path: string): Promise<Uint8Array> {
      return readFile(resolveSandboxPath(rootDir, path));
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      const resolvedPath = resolveSandboxPath(rootDir, path);
      await mkdir(dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, content);
    },
    async stat(path: string): Promise<FileStat> {
      const info = await stat(resolveSandboxPath(rootDir, path));
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        isSymbolicLink: info.isSymbolicLink(),
        size: info.size,
        mtime: info.mtime,
      };
    },
    async readdir(path: string): Promise<string[]> {
      return readdir(resolveSandboxPath(rootDir, path));
    },
    async exists(path: string): Promise<boolean> {
      try {
        await stat(resolveSandboxPath(rootDir, path));
        return true;
      } catch (error) {
        if (isMissingPathError(error)) return false;
        throw error;
      }
    },
    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      await mkdir(resolveSandboxPath(rootDir, path), options);
    },
    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      await rm(resolveSandboxPath(rootDir, path), options);
    },
  };
}

function execLocalCommand(rootDir: string, toolPath: string, input: SandboxExecInput): Promise<SandboxExecResult> {
  const startedAt = new Date();
  const cwd = input.cwd ? resolveSandboxPath(rootDir, input.cwd) : rootDir;
  const env = createLocalCommandEnv(toolPath, input.env);

  return new Promise((resolveResult, reject) => {
    const child = spawn(input.command, {
      cwd,
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = input.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, input.timeoutMs * 1000) : undefined;

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut && !stderr.trim()) stderr = `[local sandbox] Command timed out after ${input.timeoutMs} seconds.`;
      resolveResult({
        exitCode: code ?? signalExitCode(signal),
        stdout,
        stderr,
        startedAt,
        completedAt: new Date(),
      });
    });
    if (input.stdin) child.stdin.end(input.stdin);
    else child.stdin.end();
  });
}

function resolveSandboxPath(rootDir: string, path: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedRoot, path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Local sandbox path escapes workspace: ${path}`);
  }
  return resolvedPath;
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf-8') <= maxOutputBytes) return next;
  return next.slice(0, maxOutputBytes) + '\n[local sandbox] Output truncated.';
}

async function createAllowedToolPath(rootDir: string, allowedCommands: string[]): Promise<string> {
  const toolPath = join(rootDir, '.deputies-bin');
  await rm(toolPath, { recursive: true, force: true });
  await mkdir(toolPath, { recursive: true });
  for (const command of uniqueSafeCommands(allowedCommands)) {
    const resolved = resolveExecutable(command);
    if (!resolved) continue;
    await symlink(resolved, join(toolPath, command)).catch((error: unknown) => {
      if (isFileExistsError(error)) return;
      throw error;
    });
  }
  return toolPath;
}

function uniqueSafeCommands(commands: string[]): string[] {
  return Array.from(new Set(commands.map((command) => command.trim()).filter((command) => /^[a-zA-Z0-9._+-]+$/.test(command))));
}

function resolveExecutable(command: string): string | null {
  for (const directory of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      const result = statSync(candidate);
      if (result.isFile()) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function createLocalCommandEnv(toolPath: string, commandEnv: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of inheritedEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (commandEnv) Object.assign(env, commandEnv);
  env.PATH = toolPath;
  return env;
}

function localProviderSandboxId(workspacePath: string): string {
  return `local:${workspacePath}`;
}

function workspacePathFromProviderSandboxId(providerSandboxId: string): string {
  if (!providerSandboxId.startsWith('local:')) throw new Error(`Invalid local sandbox id: ${providerSandboxId}`);
  return providerSandboxId.slice('local:'.length);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48) || 'session';
}

async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`Local sandbox workspace is not a directory: ${path}`);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  return signal === 'SIGTERM' ? 143 : 1;
}
