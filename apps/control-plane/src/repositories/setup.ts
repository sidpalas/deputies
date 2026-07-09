import type { SandboxHandle } from '../sandbox/types.js';
import { shellScript } from './shell.js';

export type GitHubRepository = {
  owner: string;
  repo: string;
};

export function sameRepositoryIdentity(left: GitHubRepository, right: GitHubRepository): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase();
}

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
  primary: boolean;
  environment?: { id: string; name: string };
  workspacePath: string;
  command: string;
  env: Record<string, string>;
};

export async function prepareRepositoryShellSetup(input: {
  context: Record<string, unknown>;
  sandbox: SandboxHandle;
  github?: RepositoryAccessProvider;
}): Promise<RepositoryShellSetup | null> {
  return (await prepareRepositoryShellSetups(input))[0] ?? null;
}

export async function prepareRepositoryShellSetups(input: {
  context: Record<string, unknown>;
  sandbox: SandboxHandle;
  github?: RepositoryAccessProvider;
}): Promise<RepositoryShellSetup[]> {
  const repositories = parseRepositoryContexts(input.context);
  if (!repositories.length) return [];
  if (!input.github)
    throw new RepositorySetupError('repository_access_unavailable', 'GitHub repository access is not configured');

  const setups = [];
  for (const repository of repositories) {
    const access = await input.github.getRepositoryAccess({ owner: repository.owner, repo: repository.repo });
    const workspacePath = joinPath(joinPath(input.sandbox.workspacePath, access.owner), access.repo);
    setups.push({
      access,
      primary: repository.primary,
      ...(repository.branch ? { branch: repository.branch } : {}),
      ...(repository.environment ? { environment: repository.environment } : {}),
      workspacePath,
      command: repositorySetupCommand(access, workspacePath, repository.branch, {
        failOnDirtyBranchMismatch: Boolean(repository.environment),
      }),
      env: { GITHUB_AUTH_HEADER: gitAuthHeader(access.auth.token) },
    });
  }
  return setups.sort((left, right) => Number(right.primary) - Number(left.primary));
}

export class RepositorySetupError extends Error {
  constructor(
    readonly code: 'unsupported_repository_provider' | 'repository_access_unavailable' | 'invalid_repository_context',
    message: string,
  ) {
    super(message);
  }
}

type RepositoryContext = GitHubRepository & {
  provider: 'github';
  primary: boolean;
  branch?: string;
  environment?: { id: string; name: string };
};

export function parseRepositoryContext(context: Record<string, unknown>): RepositoryContext | null {
  const repositories = parseRepositoryContexts(context);
  if (!repositories.length) return null;
  const active = parseRepositoryValue(context.activeRepository);
  const primary = repositories.find((repository) => repository.primary) ?? repositories[0]!;
  if (!active) return primary;
  return repositories.find((repository) => sameRepositoryIdentity(repository, active)) ?? primary;
}

export function parseRepositoryContexts(context: Record<string, unknown>): RepositoryContext[] {
  const environment = parseEnvironmentRepositoryContexts(context);
  if (environment.length) return environment;

  const direct = parseRepositoryValue(context.repository);
  if (direct) return [{ ...direct, primary: true, ...optionalBranch(parseBranchContext(context)) }];

  const github = context.github;
  if (!isRecord(github)) return [];
  const repository = parseRepositoryValue(github.repository);
  return repository ? [{ ...repository, primary: true, ...optionalBranch(parseBranchContext(context)) }] : [];
}

export function repositorySetupCommand(
  access: GitHubRepositoryAccess,
  workspacePath: string,
  branch?: string,
  options: { failOnDirtyBranchMismatch?: boolean } = {},
): string {
  const checkoutBranch = branch ? quoteShell(branch) : '"$default_branch"';
  const checkoutRemote = branch ? quoteShell(`origin/${branch}`) : '"origin/$default_branch"';
  const gitAuthConfig = authenticatedGitConfig(access.cloneUrl);
  const branchOverride = branch ? `default_branch=${quoteShell(branch)}` : '';
  return shellScript(`
    set -eu

    auth_header="$GITHUB_AUTH_HEADER"
    unset GITHUB_AUTH_HEADER
    export GIT_CONFIG_GLOBAL=/dev/null
    export GIT_CONFIG_SYSTEM=/dev/null

    mkdir -p ${quoteShell(parentPath(workspacePath))}
    repository_was_cloned=0

    if [ -d ${quoteShell(joinPath(workspacePath, '.git'))} ]; then
      git -C ${quoteShell(workspacePath)} remote set-url origin ${quoteShell(access.cloneUrl)}
      git ${gitAuthConfig} -C ${quoteShell(workspacePath)} fetch --prune origin
    else
      git ${gitAuthConfig} clone -- ${quoteShell(access.cloneUrl)} ${quoteShell(workspacePath)}
      repository_was_cloned=1
    fi

    default_branch="$(git -C ${quoteShell(workspacePath)} symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
    if [ -z "$default_branch" ]; then
      default_branch="$(git -C ${quoteShell(workspacePath)} for-each-ref --format='%(refname:short)' refs/remotes/origin/main refs/remotes/origin/master | sed 's#^origin/##' | head -n 1)"
    fi
    ${branchOverride}

    if [ -n "$default_branch" ]; then
      if [ "$repository_was_cloned" = "1" ] || [ -z "$(git -C ${quoteShell(workspacePath)} status --porcelain --untracked-files=normal --ignore-submodules)" ]; then
        git -c core.hooksPath=/dev/null -C ${quoteShell(workspacePath)} checkout -B ${checkoutBranch} ${checkoutRemote}
      else
        current_branch="$(git -C ${quoteShell(workspacePath)} branch --show-current || true)"
        if [ "$current_branch" != "$default_branch" ]; then
          if [ ${options.failOnDirtyBranchMismatch ? '1' : '0'} = "1" ]; then
            echo "Repository has uncommitted changes; refusing to switch from $current_branch to $default_branch." >&2
            exit 65
          fi
          echo "Repository has uncommitted changes; preserving checkout instead of switching branches." >&2
        fi
      fi
    fi

    git -C ${quoteShell(workspacePath)} config user.name 'DevDeputies'
    git -C ${quoteShell(workspacePath)} config user.email 'devdeputies@users.noreply.github.com'
    echo "deputies-repo-setup:cloned=$repository_was_cloned"
  `);
}

function authenticatedGitConfig(url: string): string {
  if (!/^https?:\/\//.test(url)) return '-c core.hooksPath=/dev/null';
  return `-c ${quoteShell(`http.${url}.extraHeader`)}="$auth_header" -c core.hooksPath=/dev/null`;
}

function parseBranchContext(context: Record<string, unknown>): string | undefined {
  const branch = context.branch;
  return typeof branch === 'string' && branch.trim() ? branch.trim() : undefined;
}

function parseEnvironmentRepositoryContexts(context: Record<string, unknown>): RepositoryContext[] {
  const environment = context.environment;
  if (!isRecord(environment)) return [];
  const id = typeof environment.id === 'string' ? environment.id : '';
  const name = typeof environment.name === 'string' ? environment.name : '';
  const codebase = environment.codebase;
  if (!isRecord(codebase) || !Array.isArray(codebase.repositories)) return [];
  const repositories = codebase.repositories.map((value) => {
    const repository = parseRepositoryValue(value);
    if (!repository) {
      throw new RepositorySetupError(
        'invalid_repository_context',
        'Expected environment codebase repositories with provider, owner, and repo',
      );
    }
    const record = value as Record<string, unknown>;
    return {
      ...repository,
      primary: record.primary === true,
      ...optionalBranch(typeof record.branch === 'string' ? record.branch.trim() : undefined),
      environment: { id, name },
    };
  });
  if (repositories.length && repositories.filter((repository) => repository.primary).length !== 1) {
    throw new RepositorySetupError('invalid_repository_context', 'Expected exactly one primary environment repository');
  }
  return repositories.sort((left, right) => Number(right.primary) - Number(left.primary));
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
  return { provider, owner, repo, primary: false };
}

function optionalBranch(branch: string | undefined): { branch?: string } {
  return branch ? { branch } : {};
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
