import type { Context, Hono } from 'hono';
import {
  canInvokeSkillInSession,
  canManageSkill,
  canReadSkill,
  readRequestAuthorization,
  type RequestAuthorization,
} from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import { listSkillInvocationCandidates, type RepositorySkillInvocationCandidate } from '../skills/invocation.js';
import { SkillServiceError } from '../skills/service.js';
import { StoreConflictError } from '../store/types.js';
import type { SkillRecord } from '../store/types.js';
import { writeError } from './http-error.js';
import { optionalString, readJsonBody } from './request.js';
import type { AppServices, AppVariables } from './server.js';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerSkillRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  if (!config.skillsEnabled) return;
  app.get('/skills', async (c) => {
    const auth = await authorize(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    return c.json({
      skills: (await services.skills.list(auth.bypass ? undefined : auth.user.id))
        .filter((skill) => canReadSkill(auth, skill))
        .map((skill) => serialize(skill, auth)),
    });
  });
  app.post('/skills', async (c) => {
    const auth = await authorize(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const scope = body.scope ?? 'tenant';
    if (scope !== 'tenant' && scope !== 'personal')
      return writeError(c, 400, 'invalid_request', 'Expected scope to be tenant or personal');
    if (scope === 'personal' && auth.bypass)
      return writeError(c, 400, 'invalid_request', 'Personal skills require an authenticated user');
    if (scope === 'tenant' && !auth.bypass && auth.user.role === 'viewer')
      return writeError(c, 403, 'forbidden', 'Member access is required to create tenant skills');
    if (body.autoLoad !== undefined && typeof body.autoLoad !== 'boolean')
      return writeError(c, 400, 'invalid_request', 'Expected boolean field: autoLoad');
    try {
      const skill = await services.skills.create({
        scope,
        name: body.name as string,
        description: body.description as string,
        body: body.body as string,
        ...(body.autoLoad !== undefined ? { autoLoad: body.autoLoad } : {}),
        ...(!auth.bypass ? { createdByUserId: auth.user.id } : {}),
        actor: actor(auth),
      });
      return c.json({ skill: serialize(skill, auth) }, 201);
    } catch (error) {
      return skillError(c, error);
    }
  });
  app.get('/skills/invocation-candidates', async (c) => {
    const auth = await authorize(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const candidates = await services.skills.listInvocationCandidates(auth.bypass ? undefined : auth.user.id, (skill) =>
      canReadSkill(auth, skill),
    );
    return c.json({ skills: candidates.map((skill) => picker(skill, auth)) });
  });
  app.get('/skills/:skillId', async (c) => readOne(c, config, services, false));
  app.get('/skills/:skillId/revisions', async (c) => {
    const auth = await authorize(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const skill = await validSkill(c, services);
    if (skill instanceof Response) return skill;
    if (!canReadSkill(auth, skill)) return writeError(c, 404, 'not_found', 'Skill not found');
    return c.json({ revisions: await services.skills.listRevisions(skill.id) });
  });
  app.patch('/skills/:skillId', async (c) => {
    const auth = await authorize(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const skill = await validSkill(c, services);
    if (skill instanceof Response) return skill;
    if (!canManageSkill(auth, skill)) {
      return skill.scope === 'personal'
        ? writeError(c, 404, 'not_found', 'Skill not found')
        : writeError(c, 403, 'forbidden', 'Skill management access is required');
    }
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    for (const field of ['autoLoad', 'enabled'] as const)
      if (body[field] !== undefined && typeof body[field] !== 'boolean')
        return writeError(c, 400, 'invalid_request', `Expected boolean field: ${field}`);
    const expected = optionalString(body.expectedCurrentRevisionId);
    if (expected && !uuidPattern.test(expected))
      return writeError(c, 400, 'invalid_request', 'Expected valid expectedCurrentRevisionId');
    try {
      const updated = await services.skills.update({
        id: skill.id,
        ...(expected ? { expectedCurrentRevisionId: expected } : {}),
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.description !== undefined ? { description: body.description as string } : {}),
        ...(body.body !== undefined ? { body: body.body as string } : {}),
        ...(body.autoLoad !== undefined ? { autoLoad: body.autoLoad as boolean } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
        actor: actor(auth),
      });
      return c.json({ skill: serialize(updated, auth) });
    } catch (error) {
      return skillError(c, error);
    }
  });
  app.post('/skills/:skillId/archive', (c) => mutate(c, config, services, 'archive'));
  app.post('/skills/:skillId/restore', (c) => mutate(c, config, services, 'restore'));
  app.get('/sessions/:sessionId/skills', async (c) => {
    const auth = await authorize(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const session = c.get('authorizedSession');
    if (!session || session.id !== c.req.param('sessionId'))
      return writeError(c, 404, 'not_found', 'Session not found');
    const candidates = await listSkillInvocationCandidates({
      skills: services.skills,
      events: services.store,
      ...(!auth.bypass ? { userId: auth.user.id } : {}),
      sessionId: session.id,
      repoSkillsEnabled: config.repoSkillsEnabled,
      canUse: (skill) => canInvokeSkillInSession(auth, skill, session),
    });
    return c.json({
      skills: candidates.map((skill) => (skill.source === 'repo' ? repoPicker(skill) : picker(skill, auth))),
    });
  });
}
async function readOne(c: Context, config: AppConfig, services: AppServices, _unused: boolean) {
  const auth = await authorize(config, services, c);
  if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
  const skill = await validSkill(c, services);
  if (skill instanceof Response) return skill;
  if (!canReadSkill(auth, skill)) return writeError(c, 404, 'not_found', 'Skill not found');
  return c.json({ skill: serialize(skill, auth) });
}
async function validSkill(c: Context, services: AppServices): Promise<SkillRecord | Response> {
  const id = c.req.param('skillId');
  if (!id || !uuidPattern.test(id)) return writeError(c, 400, 'invalid_request', 'Expected valid skillId');
  return (await services.skills.get(id)) ?? writeError(c, 404, 'not_found', 'Skill not found');
}
async function mutate(c: Context, config: AppConfig, services: AppServices, op: 'archive' | 'restore') {
  const auth = await authorize(config, services, c);
  if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
  const skill = await validSkill(c, services);
  if (skill instanceof Response) return skill;
  if (!canManageSkill(auth, skill)) {
    return skill.scope === 'personal'
      ? writeError(c, 404, 'not_found', 'Skill not found')
      : writeError(c, 403, 'forbidden', 'Skill management access is required');
  }
  try {
    const updated =
      op === 'archive' ? await services.skills.archive(skill.id) : await services.skills.restore(skill.id);
    return c.json({ skill: serialize(updated, auth) });
  } catch (error) {
    return skillError(c, error);
  }
}
function serialize(skill: SkillRecord, auth: RequestAuthorization) {
  return {
    id: skill.id,
    scope: skill.scope,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    currentRevisionId: skill.currentRevisionId,
    currentRevisionNumber: skill.currentRevisionNumber,
    autoLoad: skill.autoLoad,
    enabled: skill.enabled,
    ...(skill.createdByUserId ? { createdByUserId: skill.createdByUserId } : {}),
    ...(skill.archivedAt ? { archivedAt: skill.archivedAt } : {}),
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    canManage: canManageSkill(auth, skill),
  };
}
function picker(skill: SkillRecord & { source?: 'managed' }, auth: RequestAuthorization) {
  const { body: _, ...value } = serialize(skill, auth);
  return {
    ...value,
    source: 'managed' as const,
    provenance: { kind: 'managed' as const, scope: skill.scope },
  };
}
function repoPicker(skill: RepositorySkillInvocationCandidate) {
  return {
    id: skill.id,
    name: skill.name,
    description: `Repository skill from ${skill.repo}`,
    autoLoad: skill.advertised,
    enabled: true,
    source: 'repo' as const,
    repo: skill.repo,
    advertised: skill.advertised,
    createdAt: skill.discoveredAt,
    updatedAt: skill.discoveredAt,
    provenance: { kind: 'repo' as const, repo: skill.repo },
  };
}
function authorize(config: AppConfig, services: AppServices, c: Context) {
  return readRequestAuthorization(config, services.store, c);
}
function actor(auth: RequestAuthorization) {
  return auth.bypass ? ({ type: 'system' } as const) : ({ type: 'user', userId: auth.user.id } as const);
}
function skillError(c: Context, error: unknown): Response {
  if (error instanceof StoreConflictError) return writeError(c, 409, error.code, error.message);
  if (error instanceof SkillServiceError) {
    if (error.code === 'not_found') return writeError(c, 404, 'not_found', error.message);
    if (error.code === 'skill_archived') return writeError(c, 409, error.code, error.message);
    return writeError(c, 400, 'invalid_request', error.message);
  }
  throw error;
}
