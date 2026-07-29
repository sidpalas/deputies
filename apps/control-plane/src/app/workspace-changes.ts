import { posix } from 'node:path';
import { canWriteSession, type RequestAuthorization } from '../auth/authorization.js';
import { parseStructuredGitHubRepository } from '../repositories/extract.js';
import { parseRepositoryContexts, RepositorySetupError } from '../repositories/setup.js';
import { SandboxLifecycleUnavailableError, type SandboxLifecycleService } from '../sandbox/service.js';
import type { SandboxExecInput, SandboxExecResult, SandboxHandle } from '../sandbox/types.js';
import type { SessionRecord } from '../store/types.js';
import { HttpRequestError } from './request.js';

const commandTimeoutMs = 5_000;
const maxFiles = 2_000;
const maxStatusBytes = 256 * 1024;
const maxPatchBytes = 512 * 1024;
const git =
  'GIT_LITERAL_PATHSPECS=1 GIT_OPTIONAL_LOCKS=0 LC_ALL=C git -c core.quotepath=false -c color.ui=false -c core.pager=cat -c pager.diff=false';
const maxRepositories = 10;

export type WorkspaceChangeFile = {
  id: string;
  path: string;
  oldPath?: string;
  indexChange?: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed' | 'unmerged';
  worktreeChange?: 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed' | 'untracked' | 'unmerged';
};

export function repositoryId(owner: string, name: string): string {
  return Buffer.from(`${owner}\0${name}`).toString('base64url');
}

export function fileId(path: string): string {
  return Buffer.from(path).toString('base64url');
}

export function decodeFileId(id: string): string {
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) invalidPath();
  let path: string;
  try {
    path = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    invalidPath();
  }
  if (fileId(path!) !== id || !validRelativePath(path!)) invalidPath();
  return path!;
}

function invalidPath(): never {
  throw new HttpRequestError(400, 'invalid_file', 'Expected a valid repository-relative file identifier');
}

function validRelativePath(path: string): boolean {
  return (
    Boolean(path) && !path.includes('\0') && !posix.isAbsolute(path) && path !== '..' && !path.split('/').includes('..')
  );
}

export async function connectReadyWorkspace(input: {
  sessionId: string;
  lifecycle: SandboxLifecycleService | undefined;
}) {
  if (!input.lifecycle) throw new HttpRequestError(409, 'sandbox_unavailable', 'A live workspace is not available');
  let connected;
  try {
    connected = await input.lifecycle.ensure(input.sessionId, { allowCreate: false });
  } catch (cause) {
    if (cause instanceof SandboxLifecycleUnavailableError)
      throw new HttpRequestError(409, 'sandbox_unavailable', 'The live workspace is unavailable', { cause });
    throw cause;
  }
  if (!connected) throw new HttpRequestError(409, 'sandbox_not_ready', 'The live workspace is not ready');
  return connected;
}

export function requireWorkspaceWrite(auth: RequestAuthorization | null, session: SessionRecord): void {
  if (!auth || !canWriteSession(auth, session))
    throw new HttpRequestError(403, 'forbidden', 'Session write access is required for source inspection');
}

function contexts(session: SessionRecord, sandbox: SandboxHandle) {
  let repositories;
  try {
    repositories = parseRepositoryContexts(session.context ?? {});
  } catch (error) {
    if (!(error instanceof RepositorySetupError)) throw error;
    throw new HttpRequestError(409, 'invalid_repository_context', 'The configured repositories are invalid');
  }
  if (repositories.length > maxRepositories)
    throw new HttpRequestError(409, 'invalid_repository_context', 'Too many configured repositories');
  const identities = new Set<string>();
  return repositories
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((repository) => {
      const validated = parseStructuredGitHubRepository(repository.owner, repository.repo);
      if (!validated)
        throw new HttpRequestError(409, 'invalid_repository_context', 'The configured repositories are invalid');
      const identity = `${validated.owner}/${validated.repo}`.toLowerCase();
      if (identities.has(identity))
        throw new HttpRequestError(409, 'invalid_repository_context', 'The configured repositories contain duplicates');
      identities.add(identity);
      return {
        ...repository,
        owner: validated.owner,
        repo: validated.repo,
        id: repositoryId(validated.owner, validated.repo),
        path: `${sandbox.workspacePath}/${validated.owner}/${validated.repo}`,
      };
    });
}

export async function inspectWorkspaceChanges(session: SessionRecord, sandbox: SandboxHandle, runtimeId?: string) {
  const repositories = await Promise.all(
    contexts(session, sandbox).map(async (repository) => {
      const base = {
        id: repository.id,
        owner: repository.owner,
        name: repository.repo,
        isPrimary: repository.primary,
        branch: null as string | null,
        headOid: null as string | null,
      };
      try {
        const command = [
          repositoryGuard(sandbox.workspacePath, repository.owner, repository.repo),
          `head_oid="$(${git} rev-parse --verify HEAD 2>/dev/null || true)"`,
          `branch="$(${git} branch --show-current)"`,
          `printf '%s\\0%s\\0' "$head_oid" "$branch"`,
          `${git} status --porcelain=v1 -z --untracked-files=all --ignored=no | head -c ${maxStatusBytes + 1}`,
        ].join('\n');
        const result = await executeWorkspaceCommand(sandbox, {
          cwd: repository.path,
          timeoutMs: commandTimeoutMs,
          command: bash(command),
        });
        const first = result.stdout.indexOf('\0');
        const second = result.stdout.indexOf('\0', first + 1);
        if (first < 0 || second < 0) {
          if (/tim(?:e|ed) out/i.test(result.stderr))
            return { ...base, status: 'timed_out' as const, complete: false, truncated: false, files: [] };
          return { ...base, status: 'not_repository' as const, complete: true, truncated: false, files: [] };
        }
        const statusOutput = result.stdout.slice(second + 1);
        const sourceTruncated = Buffer.byteLength(statusOutput) > maxStatusBytes;
        // Capping the producer can surface as SIGPIPE (141) or a wrapper-specific
        // nonzero status. More than maxStatusBytes proves the guard and Git command
        // produced a valid, intentionally interrupted status stream.
        if (result.exitCode !== 0 && !sourceTruncated)
          return { ...base, status: 'error' as const, complete: false, truncated: false, files: [] };
        const status = parsePorcelain(statusOutput);
        const truncated = sourceTruncated || status.length > maxFiles;
        return {
          ...base,
          branch: result.stdout.slice(first + 1, second) || null,
          headOid: result.stdout.slice(0, first) || null,
          status: 'ready' as const,
          complete: !truncated,
          truncated,
          files: status.slice(0, maxFiles),
        };
      } catch (error) {
        const timedOut = error instanceof WorkspaceCommandError && error.kind === 'timed_out';
        return {
          ...base,
          status: timedOut ? ('timed_out' as const) : ('error' as const),
          complete: false,
          truncated: false,
          files: [],
        };
      }
    }),
  );
  return {
    source: 'live' as const,
    sandboxRuntimeId: runtimeId ?? null,
    observedAt: new Date().toISOString(),
    repositories,
  };
}

export function parsePorcelain(output: string): WorkspaceChangeFile[] {
  const fields = output.split('\0');
  if (!output.endsWith('\0')) fields.pop();
  const files: WorkspaceChangeFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!validRelativePath(path)) continue;
    const unmerged = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy);
    const indexChange = unmerged ? 'unmerged' : mapIndex(xy[0]);
    const worktreeChange = unmerged ? 'unmerged' : xy === '??' ? 'untracked' : mapWorktree(xy[1]);
    const hasOldPath = xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C';
    const oldPath = hasOldPath ? fields[++i] : undefined;
    if (hasOldPath && (!oldPath || !validRelativePath(oldPath))) continue;
    files.push({
      id: fileId(path),
      path,
      ...(oldPath ? { oldPath } : {}),
      ...(indexChange ? { indexChange } : {}),
      ...(worktreeChange ? { worktreeChange } : {}),
    });
  }
  return files;
}

function mapIndex(value: string | undefined): WorkspaceChangeFile['indexChange'] {
  return (
    { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type_changed', U: 'unmerged' } as const
  )[value ?? ''];
}
function mapWorktree(value: string | undefined): WorkspaceChangeFile['worktreeChange'] {
  return ({ M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type_changed', U: 'unmerged' } as const)[
    value ?? ''
  ];
}

export async function inspectWorkspacePatch(input: {
  session: SessionRecord;
  sandbox: SandboxHandle;
  repository: string;
  file: string;
  layer: string;
}) {
  if (!['index', 'worktree', 'combined'].includes(input.layer))
    throw new HttpRequestError(400, 'invalid_layer', 'Expected layer to be index, worktree, or combined');
  const repository = contexts(input.session, input.sandbox).find((item) => item.id === input.repository);
  if (!repository) throw new HttpRequestError(404, 'repository_not_found', 'Repository not found');
  const path = decodeFileId(input.file);
  const statusCommand = [
    repositoryGuard(input.sandbox.workspacePath, repository.owner, repository.repo),
    `${git} status --porcelain=v1 -z --untracked-files=all --ignored=no | head -c ${maxStatusBytes + 1}`,
  ].join('\n');
  const summary = await executePatchCommand(
    input.sandbox,
    { cwd: repository.path, timeoutMs: commandTimeoutMs, command: bash(statusCommand) },
    'repository_unavailable',
    'Repository is unavailable',
  );
  const statusTruncated = Buffer.byteLength(summary.stdout) > maxStatusBytes;
  if (summary.exitCode !== 0 && !statusTruncated)
    throw new HttpRequestError(409, 'repository_unavailable', 'Repository is unavailable');
  const changed = parsePorcelain(summary.stdout).find((item) => item.path === path);
  if (!changed) throw new HttpRequestError(404, 'file_not_changed', 'The file is not currently changed');
  const quoted = shellQuote(path);
  const changeForLayer =
    input.layer === 'index'
      ? changed.indexChange
      : input.layer === 'worktree'
        ? changed.worktreeChange
        : changed.indexChange === 'renamed' || changed.indexChange === 'copied'
          ? changed.indexChange
          : changed.worktreeChange;
  const pathspec =
    changed.oldPath && (changeForLayer === 'renamed' || changeForLayer === 'copied')
      ? `${shellQuote(changed.oldPath)} ${quoted}`
      : quoted;
  let command =
    input.layer === 'index'
      ? `${git} diff --no-ext-diff --no-textconv --cached -- ${pathspec}`
      : input.layer === 'worktree'
        ? `${git} diff --no-ext-diff --no-textconv -- ${pathspec}`
        : `base="$(${git} rev-parse --verify HEAD 2>/dev/null || ${git} hash-object -t tree /dev/null)"; ${git} diff --no-ext-diff --no-textconv "$base" -- ${pathspec}`;
  if (changed.worktreeChange === 'untracked' && input.layer !== 'index')
    command = `if test -L ${quoted}; then exit 0; else ${git} diff --no-ext-diff --no-textconv --no-index -- /dev/null ${quoted} || test $? -eq 1; fi`;
  const patchCommand = [
    repositoryGuard(input.sandbox.workspacePath, repository.owner, repository.repo),
    `{ ${command}; } | head -c ${maxPatchBytes + 1}`,
  ].join('\n');
  const result = await executePatchCommand(
    input.sandbox,
    { cwd: repository.path, timeoutMs: commandTimeoutMs, command: bash(patchCommand) },
    'patch_unavailable',
    'The patch is unavailable',
  );
  const sourceTruncated = Buffer.byteLength(result.stdout) > maxPatchBytes;
  if (result.exitCode !== 0 && !sourceTruncated)
    throw new HttpRequestError(409, 'patch_unavailable', 'The patch is unavailable');
  const capped = capUtf8(result.stdout, maxPatchBytes);
  return {
    repositoryId: repository.id,
    fileId: input.file,
    path,
    layer: input.layer as 'index' | 'worktree' | 'combined',
    patch: capped.text,
    truncated: capped.truncated,
    binary: /^(?:Binary files |GIT binary patch$)/m.test(capped.text),
    observedAt: new Date().toISOString(),
  };
}

class WorkspaceCommandError extends Error {
  constructor(
    readonly kind: 'timed_out' | 'unavailable',
    options: ErrorOptions,
  ) {
    super(kind === 'timed_out' ? 'Workspace command timed out' : 'Workspace command failed', options);
  }
}

async function executeWorkspaceCommand(sandbox: SandboxHandle, input: SandboxExecInput): Promise<SandboxExecResult> {
  try {
    return await sandbox.exec(input);
  } catch (cause) {
    const timedOut = cause instanceof Error && /tim(?:e|ed)\s*out/i.test(cause.message);
    throw new WorkspaceCommandError(timedOut ? 'timed_out' : 'unavailable', { cause });
  }
}

async function executePatchCommand(
  sandbox: SandboxHandle,
  input: SandboxExecInput,
  code: 'repository_unavailable' | 'patch_unavailable',
  message: string,
): Promise<SandboxExecResult> {
  try {
    return await executeWorkspaceCommand(sandbox, input);
  } catch (cause) {
    throw new HttpRequestError(409, code, message, { cause });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function bash(command: string): string {
  return `bash -o pipefail -c ${shellQuote(command)}`;
}
function repositoryGuard(workspacePath: string, owner: string, repo: string): string {
  const expectedSuffix = shellQuote(`/${owner}/${repo}`);
  return [
    `workspace_root="$(cd -- ${shellQuote(workspacePath)} && pwd -P)" || exit 66`,
    'repository_root="$(pwd -P)" || exit 66',
    `test "$repository_root" = "$workspace_root"${expectedSuffix} || exit 66`,
    `git_root="$(${git} rev-parse --show-toplevel 2>/dev/null)" || exit 66`,
    'git_root="$(cd -- "$git_root" && pwd -P)" || exit 66',
    'test "$git_root" = "$repository_root" || exit 66',
  ].join('\n');
}
function capUtf8(value: string, bytes: number) {
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return { text: value, truncated: false };
  return {
    text: buffer
      .subarray(0, bytes)
      .toString('utf8')
      .replace(/\uFFFD$/, ''),
    truncated: true,
  };
}
