import { dirname, isAbsolute, join, normalize, relative } from 'node:path/posix';
import type { FileStat, SandboxExecInput, SandboxExecResult, SandboxFileSystem } from './types.js';

// Shared "remote shell filesystem" for providers whose sandboxes expose only a
// command channel plus file upload/download (CreateOS today; Tensorlake/Docker
// could adopt it next). It owns the single jailed path resolver, shell quoting,
// `ls`/`stat` parsing, and env emulation so each provider supplies only a thin
// driver instead of copying this machinery — and the workspace jail is audited
// in one place rather than per provider.

export type RemoteShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export type RemoteShellDriver = {
  /** Human label used in thrown error messages, e.g. `CreateOS`. */
  readonly label: string;
  runShell(command: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<RemoteShellResult>;
  uploadFile(path: string, data: Uint8Array): Promise<void>;
  downloadFile(path: string): Promise<Uint8Array>;
  isNotFoundError(error: unknown): boolean;
};

// POSIX env var names: a letter or underscore, then letters/digits/underscores.
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Resolve a caller path against the workspace and reject anything outside it.
// Absolute paths must equal the workspace or sit under it; relative paths are
// joined onto the workspace. Both are normalized first so `..` cannot escape.
export function resolveWorkspacePath(path: string, workspacePath: string, label: string): string {
  const workspace = normalizeAbsolutePath(workspacePath);
  const resolved = isAbsolute(path) ? normalize(path) : normalize(join(workspace, path));
  const workspaceRelative = relative(workspace, resolved);
  if (workspaceRelative === '..' || workspaceRelative.startsWith('../') || isAbsolute(workspaceRelative)) {
    throw new Error(`${label} path escapes workspace: ${path}`);
  }
  return resolved;
}

// Emulate cwd + env for command channels that accept neither (CreateOS exec has
// no per-command env, cwd, or stdin) by composing a `bash -lc` script. cwd is
// jailed; env names are validated so a malformed key cannot become shell syntax.
export function buildShellExecScript(input: SandboxExecInput, workspacePath: string, label: string): string {
  if (input.stdin !== undefined) throw new Error(`${label} exec does not support stdin`);
  const segments: string[] = [];
  const cwd = input.cwd ? resolveWorkspacePath(input.cwd, workspacePath, label) : normalizeAbsolutePath(workspacePath);
  segments.push(`cd ${quoteShell(cwd)}`);
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!ENV_NAME_PATTERN.test(key)) throw new Error(`${label} exec received an invalid env var name: ${key}`);
    segments.push(`export ${key}=${quoteShell(value)}`);
  }
  segments.push(input.command);
  return segments.join(' && ');
}

export async function execRemoteShell(
  driver: RemoteShellDriver,
  input: SandboxExecInput,
  workspacePath: string,
): Promise<SandboxExecResult> {
  if (input.signal?.aborted) throw abortError();
  const script = buildShellExecScript(input, workspacePath, driver.label);
  const startedAt = new Date();
  const result = await driver.runShell(script, {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  const completedAt = new Date();
  if (result.error) throw new Error(result.error);
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, startedAt, completedAt };
}

export function createRemoteShellFileSystem(driver: RemoteShellDriver, workspacePath: string): SandboxFileSystem {
  const resolve = (path: string) => resolveWorkspacePath(path, workspacePath, driver.label);
  return {
    async readFile(path) {
      return Buffer.from(await readRemoteFile(driver, resolve(path))).toString('utf8');
    },
    async readFileBuffer(path) {
      return readRemoteFile(driver, resolve(path));
    },
    async writeFile(path, content) {
      const resolved = resolve(path);
      await ensureParentDirectory(driver, resolved);
      await driver.uploadFile(resolved, toUint8Array(content));
    },
    async stat(path) {
      return statRemotePath(driver, resolve(path));
    },
    async readdir(path) {
      const resolved = resolve(path);
      const result = await driver.runShell(`ls -1A ${quoteShell(resolved)}`);
      if (result.exitCode !== 0) throw notFoundError(`${driver.label} directory not found: ${path}`);
      return result.stdout.split('\n').filter((entry) => entry.length > 0);
    },
    async exists(path) {
      const result = await driver.runShell(`test -e ${quoteShell(resolve(path))}`);
      return result.exitCode === 0;
    },
    async mkdir(path, options) {
      const flag = options?.recursive ? '-p ' : '';
      const result = await driver.runShell(`mkdir ${flag}${quoteShell(resolve(path))}`);
      if (result.exitCode !== 0) throw new Error(result.stderr || `${driver.label} mkdir failed: ${path}`);
    },
    async rm(path, options) {
      const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
      const flagArg = flags ? `-${flags} ` : '';
      const result = await driver.runShell(`rm ${flagArg}${quoteShell(resolve(path))}`);
      if (result.exitCode !== 0 && !options?.force)
        throw new Error(result.stderr || `${driver.label} rm failed: ${path}`);
    },
  };
}

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function readRemoteFile(driver: RemoteShellDriver, resolved: string): Promise<Uint8Array> {
  try {
    return await driver.downloadFile(resolved);
  } catch (error) {
    if (driver.isNotFoundError(error)) throw notFoundError(`${driver.label} file not found: ${resolved}`);
    throw error;
  }
}

async function statRemotePath(driver: RemoteShellDriver, resolved: string): Promise<FileStat> {
  const result = await driver.runShell(`stat -c '%F|%s|%Y' ${quoteShell(resolved)}`);
  if (result.exitCode !== 0) throw notFoundError(`${driver.label} file not found: ${resolved}`);
  const [kind = '', size = '0', mtime = '0'] = result.stdout.trim().split('|');
  return {
    isFile: kind === 'regular file' || kind === 'regular empty file',
    isDirectory: kind === 'directory',
    isSymbolicLink: kind === 'symbolic link',
    size: Number.parseInt(size, 10) || 0,
    mtime: new Date((Number.parseInt(mtime, 10) || 0) * 1000),
  };
}

async function ensureParentDirectory(driver: RemoteShellDriver, resolvedPath: string): Promise<void> {
  const parent = dirname(resolvedPath);
  if (!parent || parent === '.' || parent === '/') return;
  const result = await driver.runShell(`mkdir -p ${quoteShell(parent)}`);
  if (result.exitCode !== 0) throw new Error(result.stderr || `${driver.label} mkdir failed: ${parent}`);
}

function notFoundError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function normalizeAbsolutePath(path: string): string {
  const normalized = normalize(path);
  return isAbsolute(normalized) ? normalized : `/${normalized}`;
}

function toUint8Array(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}
