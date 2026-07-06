import type { SandboxHandle } from '../sandbox/types.js';

export type GitHubRepository = {
  owner: string;
  repo: string;
};

export type GitHubRepositoryAccess = GitHubRepository & {
  provider: 'github';
  cloneUrl: string;
  expiresAt: Date;
  auth: { type: 'bearer'; token: string };
};

export type RepositoryAccessProvider = {
  getRepositoryAccess(repository: GitHubRepository): Promise<GitHubRepositoryAccess>;
  listAllowedRepositories?(): string[];
};

export type RepositoryShellSetup = {
  access: GitHubRepositoryAccess;
  branch?: string;
  workspacePath: string;
  command: string;
  env: Record<string, string>;
};

export async function prepareRepositoryShellSetup(input: {
  context: Record<string, unknown>;
  sandbox: SandboxHandle;
  github?: RepositoryAccessProvider;
}): Promise<RepositoryShellSetup | null> {
  const repository = parseRepositoryContext(input.context);
  if (!repository) return null;
  if (!input.github)
    throw new RepositorySetupError('repository_access_unavailable', 'GitHub repository access is not configured');

  const access = await input.github.getRepositoryAccess({ owner: repository.owner, repo: repository.repo });
  const branch = parseBranchContext(input.context);
  const workspacePath = joinPath(input.sandbox.workspacePath, access.repo);
  return {
    access,
    ...(branch ? { branch } : {}),
    workspacePath,
    command: repositorySetupCommand(access, workspacePath, branch),
    env: { GITHUB_AUTH_HEADER: gitAuthHeader(access.auth.token) },
  };
}

export class RepositorySetupError extends Error {
  constructor(
    readonly code: 'unsupported_repository_provider' | 'repository_access_unavailable' | 'invalid_repository_context',
    message: string,
  ) {
    super(message);
  }
}

type RepositoryContext = GitHubRepository & { provider: 'github' };

export function parseRepositoryContext(context: Record<string, unknown>): RepositoryContext | null {
  const direct = parseRepositoryValue(context.repository);
  if (direct) return direct;

  const github = context.github;
  if (!isRecord(github)) return null;
  return parseRepositoryValue(github.repository);
}

export function repositorySetupCommand(access: GitHubRepositoryAccess, workspacePath: string, branch?: string): string {
  const checkoutBranch = branch ? quoteShell(branch) : '"$default_branch"';
  const checkoutRemote = branch ? quoteShell(`origin/${branch}`) : '"origin/$default_branch"';
  return [
    'set -eu',
    `mkdir -p ${quoteShell(parentPath(workspacePath))}`,
    'repository_was_cloned=0',
    `if [ -d ${quoteShell(joinPath(workspacePath, '.git'))} ]; then`,
    `  git -C ${quoteShell(workspacePath)} remote set-url origin ${quoteShell(access.cloneUrl)}`,
    `  git -c http.extraHeader="$GITHUB_AUTH_HEADER" -C ${quoteShell(workspacePath)} fetch --prune origin`,
    'else',
    `  git -c http.extraHeader="$GITHUB_AUTH_HEADER" clone -- ${quoteShell(access.cloneUrl)} ${quoteShell(workspacePath)}`,
    '  repository_was_cloned=1',
    'fi',
    `default_branch="$(git -C ${quoteShell(workspacePath)} symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"`,
    `if [ -z "$default_branch" ]; then`,
    `  default_branch="$(git -C ${quoteShell(workspacePath)} for-each-ref --format='%(refname:short)' refs/remotes/origin/main refs/remotes/origin/master | sed 's#^origin/##' | head -n 1)"`,
    'fi',
    ...(branch ? [`default_branch=${quoteShell(branch)}`] : []),
    `if [ -n "$default_branch" ]; then`,
    `  if [ "$repository_was_cloned" = "1" ] || git -C ${quoteShell(workspacePath)} diff --quiet --ignore-submodules -- && git -C ${quoteShell(workspacePath)} diff --cached --quiet --ignore-submodules --; then`,
    `    git -C ${quoteShell(workspacePath)} checkout -B ${checkoutBranch} ${checkoutRemote}`,
    '  else',
    `    current_branch="$(git -C ${quoteShell(workspacePath)} branch --show-current || true)"`,
    '    if [ "$current_branch" != "$default_branch" ]; then',
    '      echo "Repository has uncommitted changes; preserving checkout instead of switching branches." >&2',
    '    fi',
    '  fi',
    'fi',
    `git -C ${quoteShell(workspacePath)} config user.name 'DevDeputies'`,
    `git -C ${quoteShell(workspacePath)} config user.email 'devdeputies@users.noreply.github.com'`,
    'echo "deputies-repo-setup:cloned=$repository_was_cloned"',
  ].join('\n');
}

function parseBranchContext(context: Record<string, unknown>): string | undefined {
  const branch = context.branch;
  return typeof branch === 'string' && branch.trim() ? branch.trim() : undefined;
}

function parseRepositoryValue(value: unknown): RepositoryContext | null {
  if (!isRecord(value)) return null;
  const provider = typeof value.provider === 'string' ? value.provider : 'github';
  const owner = typeof value.owner === 'string' ? value.owner.trim() : '';
  const repo = typeof value.repo === 'string' ? value.repo.trim() : '';
  if (!owner && !repo) return null;
  if (provider !== 'github' || !owner || !repo) {
    throw new RepositorySetupError(
      'invalid_repository_context',
      'Expected repository context with provider, owner, and repo',
    );
  }
  return { provider, owner, repo };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function joinPath(base: string, child: string): string {
  return `${base.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}`;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function gitAuthHeader(token: string): string {
  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `Authorization: Basic ${credentials}`;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
