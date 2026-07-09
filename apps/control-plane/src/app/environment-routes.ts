import type { Context, Hono } from 'hono';
import { EnvironmentServiceError, type EnvironmentRepositoryInput } from '../environments/service.js';
import {
  canManageEnvironment,
  canManageGroup,
  canReadEnvironment,
  readRequestAuthorization,
  type RequestAuthorization,
} from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import { StoreConflictError, type EnvironmentShareMode, type EnvironmentWithDetailsRecord } from '../store/types.js';
import { writeError } from './http-error.js';
import { optionalString, readJsonBody } from './request.js';
import type { AppServices, AppVariables } from './server.js';

export function registerEnvironmentRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  app.get('/environments', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const environments = (await services.environments.list()).filter((environment) =>
      canReadEnvironment(auth, environment),
    );
    return c.json({
      environments: await Promise.all(
        environments.map((environment) => serializeEnvironment(services, auth, environment)),
      ),
    });
  });

  app.post('/environments', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const ownerGroupId = optionalString(body.ownerGroupId);
    if (!ownerGroupId) return writeError(c, 400, 'invalid_request', 'Expected ownerGroupId');
    if (!canManageGroup(auth, ownerGroupId)) return writeError(c, 403, 'forbidden', 'Group admin access is required');

    try {
      const shareMode = parseShareMode(body.shareMode);
      const environment = await services.environments.create({
        name: optionalString(body.name) ?? '',
        ownerGroupId,
        ...(shareMode ? { shareMode } : {}),
        repositories: parseRepositories(body.repositories),
        sharedGroupIds: parseSharedGroupIds(body.sharedGroupIds),
      });
      return c.json({ environment: await serializeEnvironment(services, auth, environment) }, 201);
    } catch (error) {
      return environmentErrorResponse(c, error);
    }
  });

  app.get('/environments/:environmentId', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const environment = await services.environments.get(c.req.param('environmentId'));
    if (!environment) return writeError(c, 404, 'not_found', 'Environment not found');
    if (!canReadEnvironment(auth, environment))
      return writeError(c, 403, 'forbidden', 'Environment access is required');
    return c.json({ environment: await serializeEnvironment(services, auth, environment) });
  });

  app.patch('/environments/:environmentId', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const existing = await services.environments.get(c.req.param('environmentId'));
    if (!existing) return writeError(c, 404, 'not_found', 'Environment not found');
    if (!canManageEnvironment(auth, existing))
      return writeError(c, 403, 'forbidden', 'Environment management access is required');

    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const nextOwnerGroupId = optionalString(body.ownerGroupId);
    if (nextOwnerGroupId && nextOwnerGroupId !== existing.ownerGroupId && !canManageGroup(auth, nextOwnerGroupId)) {
      return writeError(c, 403, 'forbidden', 'Group admin access is required for both groups');
    }

    try {
      const shareMode = body.shareMode !== undefined ? parseShareMode(body.shareMode) : undefined;
      const updated = await services.environments.update({
        id: existing.id,
        ...(body.name !== undefined ? { name: optionalString(body.name) ?? '' } : {}),
        ...(nextOwnerGroupId ? { ownerGroupId: nextOwnerGroupId } : {}),
        ...(shareMode ? { shareMode } : {}),
        ...(body.repositories !== undefined ? { repositories: parseRepositories(body.repositories) } : {}),
        ...(body.sharedGroupIds !== undefined ? { sharedGroupIds: parseSharedGroupIds(body.sharedGroupIds) } : {}),
      });
      return c.json({ environment: await serializeEnvironment(services, auth, updated) });
    } catch (error) {
      return environmentErrorResponse(c, error);
    }
  });

  app.post('/environments/:environmentId/archive', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const existing = await services.environments.get(c.req.param('environmentId'));
    if (!existing) return writeError(c, 404, 'not_found', 'Environment not found');
    if (!canManageEnvironment(auth, existing))
      return writeError(c, 403, 'forbidden', 'Environment management access is required');
    try {
      const archived = await services.environments.archive(existing.id);
      return c.json({ environment: await serializeEnvironment(services, auth, archived) });
    } catch (error) {
      return environmentErrorResponse(c, error);
    }
  });

  app.post('/environments/:environmentId/unarchive', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const existing = await services.environments.get(c.req.param('environmentId'));
    if (!existing) return writeError(c, 404, 'not_found', 'Environment not found');
    if (!canManageEnvironment(auth, existing))
      return writeError(c, 403, 'forbidden', 'Environment management access is required');
    try {
      const unarchived = await services.environments.unarchive(existing.id);
      return c.json({ environment: await serializeEnvironment(services, auth, unarchived) });
    } catch (error) {
      return environmentErrorResponse(c, error);
    }
  });
}

async function requireRequestAuthorization(
  config: AppConfig,
  services: AppServices,
  c: Context,
): Promise<RequestAuthorization | null> {
  return readRequestAuthorization(config, services.store, c);
}

async function serializeEnvironment(
  services: AppServices,
  auth: RequestAuthorization,
  environment: EnvironmentWithDetailsRecord,
) {
  const ownerGroup = await services.store.getGroup(environment.ownerGroupId);
  return {
    id: environment.id,
    name: environment.name,
    ownerGroupId: environment.ownerGroupId,
    ...(ownerGroup ? { ownerGroupName: ownerGroup.name } : {}),
    shareMode: environment.shareMode,
    sharedGroupIds: environment.sharedGroupIds,
    repositories: environment.repositories.map((repository) => ({
      id: repository.id,
      provider: repository.provider,
      owner: repository.owner,
      repo: repository.repo,
      primary: repository.isPrimary,
      position: repository.position,
      ...(repository.branch ? { branch: repository.branch } : {}),
    })),
    ...(environment.archivedAt ? { archivedAt: environment.archivedAt } : {}),
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
    canManage: canManageEnvironment(auth, environment),
  };
}

function parseShareMode(value: unknown): EnvironmentShareMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'private' || value === 'selected_groups' || value === 'all_groups') return value;
  throw new EnvironmentServiceError('invalid_request', 'Expected valid environment shareMode');
}

function parseRepositories(value: unknown): EnvironmentRepositoryInput[] {
  if (!Array.isArray(value)) throw new EnvironmentServiceError('invalid_request', 'Expected repositories array');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new EnvironmentServiceError('invalid_request', 'Expected repository object');
    }
    const record = item as Record<string, unknown>;
    if (record.provider !== undefined && record.provider !== 'github') {
      throw new EnvironmentServiceError('invalid_request', 'Only GitHub repositories are supported');
    }
    return {
      provider: 'github',
      owner: optionalString(record.owner) ?? '',
      repo: optionalString(record.repo) ?? '',
      ...(record.branch !== undefined ? { branch: optionalString(record.branch) ?? '' } : {}),
      primary: record.primary === true || record.isPrimary === true,
    };
  });
}

function parseSharedGroupIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new EnvironmentServiceError('invalid_request', 'Expected sharedGroupIds array');
  }
  return value;
}

function environmentErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof StoreConflictError && error.code === 'environment_name_exists') {
    return writeError(c, 409, error.code, error.message);
  }
  if (error instanceof EnvironmentServiceError) {
    if (error.code === 'not_found') return writeError(c, 404, 'not_found', error.message);
    if (error.code === 'archived') return writeError(c, 409, 'environment_archived', error.message, error.details);
    if (error.code === 'group_not_found') return writeError(c, 404, 'group_not_found', error.message, error.details);
    if (error.code === 'archived_group') return writeError(c, 409, 'archived_group', error.message, error.details);
    if (error.code === 'automation_conflict') {
      return writeError(c, 409, 'environment_automation_conflict', error.message, error.details);
    }
    return writeError(c, 400, 'invalid_request', error.message, error.details);
  }
  throw error;
}
