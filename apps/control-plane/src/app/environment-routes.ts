import type { Context, Hono } from 'hono';
import { EnvironmentServiceError, type EnvironmentRepositoryInput } from '../environments/service.js';
import {
  canManageEnvironment,
  canReadEnvironment,
  readRequestAuthorization,
  type RequestAuthorization,
} from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import { StoreConflictError, type EnvironmentWithDetailsRecord } from '../store/types.js';
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
      environments: environments.map((environment) => serializeEnvironment(auth, environment)),
    });
  });

  app.post('/environments', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    if (!canManageEnvironment(auth)) return writeError(c, 403, 'forbidden', 'Member access is required');

    try {
      rejectLegacyAccessFields(body);
      const environment = await services.environments.create({
        name: optionalString(body.name) ?? '',
        repositories: parseRepositories(body.repositories),
        actor: environmentMutationActor(auth),
      });
      return c.json({ environment: serializeEnvironment(auth, environment) }, 201);
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
    return c.json({ environment: serializeEnvironment(auth, environment) });
  });

  app.get('/environments/:environmentId/revisions', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const environment = await services.environments.get(c.req.param('environmentId'));
    if (!environment) return writeError(c, 404, 'not_found', 'Environment not found');
    if (!canReadEnvironment(auth, environment))
      return writeError(c, 403, 'forbidden', 'Environment access is required');
    return c.json({ revisions: await services.environments.listRevisions(environment.id) });
  });

  app.get('/environments/:environmentId/activity', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const environment = await services.environments.get(c.req.param('environmentId'));
    if (!environment) return writeError(c, 404, 'not_found', 'Environment not found');
    if (!canReadEnvironment(auth, environment))
      return writeError(c, 403, 'forbidden', 'Environment access is required');
    return c.json({ activity: await services.environments.listActivity(environment.id) });
  });

  app.patch('/environments/:environmentId', async (c) => {
    const auth = await requireRequestAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const existing = await services.environments.get(c.req.param('environmentId'));
    if (!existing) return writeError(c, 404, 'not_found', 'Environment not found');
    if (!canManageEnvironment(auth, existing))
      return writeError(c, 403, 'forbidden', 'Environment management access is required');

    const body = await readJsonBody(c, config.maxJsonBodyBytes);

    try {
      rejectLegacyAccessFields(body);
      const updated = await services.environments.update({
        id: existing.id,
        ...(body.name !== undefined ? { name: optionalString(body.name) ?? '' } : {}),
        ...(body.repositories !== undefined ? { repositories: parseRepositories(body.repositories) } : {}),
        actor: environmentMutationActor(auth),
      });
      return c.json({ environment: serializeEnvironment(auth, updated) });
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
      const archived = await services.environments.archive(existing.id, environmentMutationActor(auth));
      return c.json({ environment: serializeEnvironment(auth, archived) });
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
      const unarchived = await services.environments.unarchive(existing.id, environmentMutationActor(auth));
      return c.json({ environment: serializeEnvironment(auth, unarchived) });
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

function serializeEnvironment(auth: RequestAuthorization, environment: EnvironmentWithDetailsRecord) {
  return {
    id: environment.id,
    name: environment.name,
    currentRevisionId: environment.currentRevisionId,
    currentRevisionNumber: environment.currentRevisionNumber,
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

function environmentMutationActor(auth: RequestAuthorization) {
  return auth.bypass ? ({ type: 'system' } as const) : ({ type: 'user', userId: auth.user.id } as const);
}

function rejectLegacyAccessFields(body: Record<string, unknown>): void {
  if (['ownerGroupId', 'shareMode', 'sharedGroupIds', 'allowedGroupIds'].some((field) => field in body))
    throw new EnvironmentServiceError('invalid_request', 'Environment ownership and sharing fields are not supported');
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

function environmentErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof StoreConflictError && error.code === 'environment_name_exists') {
    return writeError(c, 409, error.code, error.message);
  }
  if (error instanceof StoreConflictError && error.code === 'environment_update_conflict') {
    return writeError(c, 409, error.code, error.message);
  }
  if (error instanceof StoreConflictError && error.code === 'environment_automation_conflict') {
    return writeError(c, 409, error.code, error.message, error.details);
  }
  if (error instanceof EnvironmentServiceError) {
    if (error.code === 'not_found') return writeError(c, 404, 'not_found', error.message);
    if (error.code === 'archived') return writeError(c, 409, 'environment_archived', error.message, error.details);
    if (error.code === 'automation_conflict') {
      return writeError(c, 409, 'environment_automation_conflict', error.message, error.details);
    }
    return writeError(c, 400, 'invalid_request', error.message, error.details);
  }
  throw error;
}
