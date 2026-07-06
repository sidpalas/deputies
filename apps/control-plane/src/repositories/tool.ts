import { type GitHubRepository, type GitHubRepositoryAccess, type RepositoryAccessProvider } from './setup.js';
import {
  executeRepositoryPreparation,
  planRepositoryPreparation,
  repositoryPreparationSummary,
  type PreparedRepository as PreparedRepositoryType,
} from './prepare.js';
import type { RepositorySetupScriptPolicy } from './setup-script.js';
import type { RepositoryShell } from './shell.js';
import type { RunnerInput } from '../runner/types.js';
import type { SandboxHandle } from '../sandbox/types.js';

export type PreparedRepository = PreparedRepositoryType;

export type RepositoryToolState = {
  context: Record<string, unknown>;
  prepared?: PreparedRepository;
};

export type RepositoryToolServices = {
  github: RepositoryAccessProvider;
  sandbox: SandboxHandle;
  shell: () => RepositoryShell | undefined;
  setupShell?: () => RepositoryShell | undefined;
  state: RepositoryToolState;
  emit: RunnerInput['emit'];
  eventBase: Pick<RunnerInput, 'sessionId' | 'runId' | 'messageId'>;
  updateSessionContext?: RunnerInput['updateSessionContext'];
  setupScript?: RepositorySetupScriptPolicy;
};

export const repositoryToolDescription =
  'Manage the active GitHub repository for this session. Use status to inspect current repo, list when uncertain, set when you have a confident repo choice, and prepare before reading/editing files. After setting a repo for ongoing work, prepare it in the same turn unless the user only asked to inspect or select. If the repo is unclear, ask the user instead of guessing.';

export const repositoryToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['status', 'list', 'set', 'prepare'] },
    owner: { type: 'string', description: 'GitHub repository owner; required for set.' },
    repo: { type: 'string', description: 'GitHub repository name; required for set.' },
    reason: { type: 'string', description: 'Why this repo was selected.' },
  },
} as const;

export async function executeRepositoryTool(
  services: RepositoryToolServices,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const action = typeof params.action === 'string' ? params.action : '';
  switch (action) {
    case 'status':
      return repositoryStatus(services);
    case 'list':
      return repositoryList(services);
    case 'set':
      return setRepositoryContext(services, params);
    case 'prepare':
      return prepareActiveRepository(services, signal);
    default:
      throw new Error('repository action must be one of: status, list, set, prepare');
  }
}

export function getActiveRepository(state: RepositoryToolState): (GitHubRepository & { provider: 'github' }) | null {
  return parseRepositoryValue(state.context.repository);
}

export async function resolveActiveRepositoryAccess(services: RepositoryToolServices): Promise<GitHubRepositoryAccess> {
  const repository = getActiveRepository(services.state);
  if (!repository)
    throw new Error(
      'No active repository is set. Use repository({ action: "set", owner, repo }) first, or repository({ action: "list" }) if unsure.',
    );
  return services.github.getRepositoryAccess(repository);
}

export function getPreparedRepository(services: RepositoryToolServices): PreparedRepository {
  const repository = getActiveRepository(services.state);
  if (!repository)
    throw new Error('No active repository is set. Use repository({ action: "set", owner, repo }) first.');
  if (
    !services.state.prepared ||
    services.state.prepared.repository.owner !== repository.owner ||
    services.state.prepared.repository.repo !== repository.repo
  ) {
    throw new Error(
      'The active repository has not been prepared in the sandbox. Use repository({ action: "prepare" }) first.',
    );
  }
  return services.state.prepared;
}

export async function prepareActiveRepository(services: RepositoryToolServices, signal?: AbortSignal): Promise<string> {
  const repository = getActiveRepository(services.state);
  if (!repository)
    throw new Error('No active repository is set. Use repository({ action: "set", owner, repo }) first.');
  const shell = services.shell();
  if (!shell) throw new Error('Repository preparation is unavailable before the sandbox shell is ready');
  const setupShell = services.setupShell?.() ?? shell;
  const plan = await planRepositoryPreparation({
    context: services.state.context,
    sandbox: services.sandbox,
    github: services.github,
  });
  if (!plan) throw new Error('No active repository is set. Use repository({ action: "set", owner, repo }) first.');
  const result = await executeRepositoryPreparation({
    plan,
    workspaceRoot: services.sandbox.workspacePath,
    shell,
    setupShell,
    emit: services.emit,
    eventBase: services.eventBase,
    ...(services.setupScript ? { setupScript: services.setupScript } : {}),
    ...(signal ? { signal } : {}),
  });

  services.state.prepared = result;
  return repositoryPreparationSummary(result);
}

function repositoryStatus(services: RepositoryToolServices): string {
  const repository = getActiveRepository(services.state);
  if (!repository) {
    return [
      'No active repository is set.',
      'If the task clearly implies a repo, use repository({ action: "set", owner, repo, reason }).',
      'If the repo is unclear, use repository({ action: "list" }) and ask the user to choose.',
    ].join('\n');
  }
  const prepared = services.state.prepared;
  const lines = [`Active repository: ${repository.owner}/${repository.repo}`];
  if (prepared && prepared.repository.owner === repository.owner && prepared.repository.repo === repository.repo) {
    lines.push(`Prepared workspace: ${prepared.workspacePath}`);
  } else {
    lines.push('Prepared workspace: not prepared in this run');
  }
  return lines.join('\n');
}

function repositoryList(services: RepositoryToolServices): string {
  const allowed = services.github.listAllowedRepositories?.() ?? [];
  if (!allowed.length)
    return 'No explicit repository allowlist is configured. Ask the user for a GitHub repo in owner/repo form.';
  const concrete = allowed.filter((item) => !item.endsWith('/*'));
  const patterns = allowed.filter((item) => item.endsWith('/*'));
  const lines: string[] = [];
  if (concrete.length) lines.push('Allowed repositories:', ...concrete.map((repo) => `- ${repo}`));
  if (patterns.length)
    lines.push(
      'Allowed repository patterns:',
      ...patterns.map((repo) => `- ${repo}`),
      'For a pattern, ask the user for the specific repo name.',
    );
  return lines.join('\n');
}

async function setRepositoryContext(
  services: RepositoryToolServices,
  params: Record<string, unknown>,
): Promise<string> {
  const owner = typeof params.owner === 'string' ? params.owner.trim() : '';
  const repo = typeof params.repo === 'string' ? params.repo.trim() : '';
  if (!owner || !repo) throw new Error('repository set requires owner and repo');
  const repository = { provider: 'github' as const, owner, repo };
  const previousRepository = getActiveRepository(services.state);
  await services.github.getRepositoryAccess(repository);
  const nextContext: Record<string, unknown> = { ...services.state.context, repository };
  if (previousRepository?.owner !== owner || previousRepository?.repo !== repo) {
    delete nextContext.branch;
  }
  services.state.context = services.updateSessionContext
    ? await services.updateSessionContext(nextContext)
    : nextContext;
  if (
    services.state.prepared &&
    (services.state.prepared.repository.owner !== owner || services.state.prepared.repository.repo !== repo)
  ) {
    delete services.state.prepared;
  }
  const reason = typeof params.reason === 'string' && params.reason.trim() ? `\nReason: ${params.reason.trim()}` : '';
  return `Active repository set to ${owner}/${repo}.${reason}\nNext step: use repository({ action: "prepare" }) now if the user intends any work in this repository.`;
}

function parseRepositoryValue(value: unknown): (GitHubRepository & { provider: 'github' }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === 'string' ? record.provider : 'github';
  const owner = typeof record.owner === 'string' ? record.owner.trim() : '';
  const repo = typeof record.repo === 'string' ? record.repo.trim() : '';
  return provider === 'github' && owner && repo ? { provider, owner, repo } : null;
}
