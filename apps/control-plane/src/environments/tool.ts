import { executeRepositoryTool, type RepositoryToolServices } from '../repositories/tool.js';
import { parseRepositoryContext, sameRepositoryIdentity } from '../repositories/setup.js';
import { EnvironmentServiceError, type EnvironmentService } from './service.js';

export type EnvironmentToolServices = {
  environments: EnvironmentService;
  repository: RepositoryToolServices;
};

export const environmentToolDescription =
  'Manage the environment for this session. Use auto before repository-specific work when a direct repository is present but no environment was selected; it selects only one unambiguous accessible environment that contains that repository. Use list when auto cannot choose, and set to select an environment explicitly.';

export const environmentToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['status', 'list', 'auto', 'set'] },
    environmentId: { type: 'string', description: 'Environment id; required for set.' },
  },
} as const;

export async function executeEnvironmentTool(
  services: EnvironmentToolServices,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const action = typeof params.action === 'string' ? params.action : '';
  switch (action) {
    case 'status':
      return environmentStatus(services);
    case 'list':
      return environmentList(services);
    case 'auto':
      return autoSelectEnvironment(services, signal);
    case 'set': {
      const environmentId = typeof params.environmentId === 'string' ? params.environmentId.trim() : '';
      if (!environmentId) throw new Error('environment set requires environmentId');
      return selectEnvironment(services, environmentId, signal);
    }
    default:
      throw new Error('environment action must be one of: status, list, auto, set');
  }
}

async function environmentStatus(services: EnvironmentToolServices): Promise<string> {
  const environment = services.repository.state.context.environment;
  if (!isEnvironmentSnapshot(environment)) {
    return 'No environment is selected. Use environment({ action: "auto" }) when a direct repository is active, or environment({ action: "list" }) to choose one.';
  }
  const warning = await validateEnvironmentContext(services.environments, services.repository.state.context);
  return [
    `Environment: ${environment.name} (revision ${environment.revisionNumber})`,
    ...(warning ? [warning] : []),
    `Primary repository: ${environmentPrimaryRepository(environment)}`,
  ].join('\n');
}

async function environmentList(services: EnvironmentToolServices): Promise<string> {
  const environments = await accessibleEnvironments(services);
  if (!environments.length) return 'No environments are available to this tenant.';
  return [
    'Available environments:',
    ...environments.map(
      (environment) =>
        `- ${environment.name} (revision ${environment.currentRevisionNumber}; ${environment.repositories
          .map((repository) => `${repository.owner}/${repository.repo}${repository.isPrimary ? ' (primary)' : ''}`)
          .join(', ')}) [${environment.id}]`,
    ),
  ].join('\n');
}

async function autoSelectEnvironment(services: EnvironmentToolServices, signal?: AbortSignal): Promise<string> {
  if (isEnvironmentSnapshot(services.repository.state.context.environment)) return environmentStatus(services);
  const repository = parseRepositoryContext(services.repository.state.context);
  if (!repository) {
    return 'No direct repository is active, so no environment can be selected automatically. Use environment({ action: "list" }) and ask the user to choose.';
  }
  const matches = (await accessibleEnvironments(services)).filter((environment) =>
    environment.repositories.some((candidate) => sameRepositoryIdentity(candidate, repository)),
  );
  if (matches.length === 1) return selectEnvironment(services, matches[0]!.id, signal, 'Automatically selected');
  if (!matches.length) {
    return `No available environment contains ${repository.owner}/${repository.repo}. Continue with the direct repository or use environment({ action: "list" }).`;
  }
  return `Multiple available environments contain ${repository.owner}/${repository.repo}. Use environment({ action: "list" }) and ask the user to choose.`;
}

async function selectEnvironment(
  services: EnvironmentToolServices,
  environmentId: string,
  signal?: AbortSignal,
  prefix = 'Selected',
): Promise<string> {
  const snapshot = await services.environments.resolve({ environmentId });
  const nextContext = environmentContext(services.repository.state.context, snapshot);
  const persistedContext = services.repository.updateSessionContext
    ? await services.repository.updateSessionContext(nextContext)
    : nextContext;
  services.repository.state.context = persistedContext;
  delete services.repository.state.prepared;
  delete services.repository.state.preparedRepositories;
  const preparation = await executeRepositoryTool(services.repository, { action: 'prepare' }, signal);
  return `${prefix} environment ${snapshot.name} (revision ${snapshot.revisionNumber}).\n${preparation}`;
}

async function accessibleEnvironments(services: EnvironmentToolServices) {
  return (await services.environments.list()).filter((environment) => !environment.archivedAt);
}

function environmentContext(
  context: Record<string, unknown>,
  environment: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...context, environment };
  next.repository = undefined;
  next.branch = undefined;
  next.activeRepository = undefined;
  next.environmentBranchOverrides = undefined;
  return next;
}

function isEnvironmentSnapshot(value: unknown): value is {
  id: string;
  revisionId: string;
  name: string;
  revisionNumber: number;
  codebase: { repositories: Array<{ owner: string; repo: string; primary: boolean }> };
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const environment = value as Record<string, unknown>;
  return (
    typeof environment.id === 'string' &&
    typeof environment.revisionId === 'string' &&
    typeof environment.name === 'string' &&
    typeof environment.revisionNumber === 'number' &&
    isEnvironmentCodebase(environment.codebase)
  );
}

export async function validateEnvironmentContext(
  environments: EnvironmentService | undefined,
  context: Record<string, unknown>,
): Promise<string | null> {
  if (context.environment === undefined) return null;
  if (!isEnvironmentSnapshot(context.environment)) throw new Error('Invalid environment session context');
  if (!environments) return null;
  try {
    await environments.resolve({
      environmentId: context.environment.id,
      revisionId: context.environment.revisionId,
    });
    return null;
  } catch (error) {
    if (!isUnavailableEnvironmentError(error)) throw error;
    return `Note: environment "${context.environment.name}" (revision ${context.environment.revisionNumber}) is no longer available (${environmentUnavailableReason(error.code)}). Continuing with this session's saved environment snapshot.`;
  }
}

function isUnavailableEnvironmentError(error: unknown): error is EnvironmentServiceError & {
  code: 'archived' | 'not_found';
} {
  return error instanceof EnvironmentServiceError && ['archived', 'not_found'].includes(error.code);
}

function environmentUnavailableReason(code: 'archived' | 'not_found'): string {
  switch (code) {
    case 'archived':
      return 'it has been archived';
    case 'not_found':
      return 'it is unavailable';
  }
}

function isEnvironmentCodebase(value: unknown): value is {
  repositories: Array<{ owner: string; repo: string; primary: boolean }>;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const repositories = (value as Record<string, unknown>).repositories;
  return (
    Array.isArray(repositories) &&
    repositories.every(
      (repository) =>
        Boolean(repository) &&
        typeof repository === 'object' &&
        !Array.isArray(repository) &&
        typeof (repository as Record<string, unknown>).owner === 'string' &&
        typeof (repository as Record<string, unknown>).repo === 'string' &&
        typeof (repository as Record<string, unknown>).primary === 'boolean',
    )
  );
}

function environmentPrimaryRepository(environment: {
  codebase: { repositories: Array<{ owner: string; repo: string; primary: boolean }> };
}): string {
  const primary = environment.codebase.repositories.find((repository) => repository.primary);
  return primary ? `${primary.owner}/${primary.repo}` : 'unknown';
}
