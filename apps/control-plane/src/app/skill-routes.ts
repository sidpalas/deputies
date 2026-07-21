import type { Context, Hono } from 'hono';
import {
  canCreateSessionInGroup,
  canCreateSkillInGroup,
  canInvokeSkillInSession,
  canManageSkill,
  canReadSkill,
  isSuperAdmin,
  readRequestAuthorization,
  type RequestAuthorization,
} from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import {
  listSkillInvocationCandidates,
  type RepositorySkillInvocationCandidate,
  type SkillInvocationCandidate,
} from '../skills/invocation.js';
import { SkillServiceError } from '../skills/service.js';
import { StoreConflictError } from '../store/types.js';
import type { GroupRecord, SkillRecord, SkillRunCandidate, SkillShareMode } from '../store/types.js';
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
    const auth = await requireAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const scope = c.req.query('scope');
    const groupId = optionalString(c.req.query('groupId'));
    let skills: SkillRecord[];
    if (scope === 'personal') {
      if (auth.bypass) return c.json({ skills: [] });
      skills = await services.skills.listPersonal(auth.user.id);
    } else if (scope === 'group' || scope === 'shared') {
      if (!groupId) return writeError(c, 400, 'invalid_request', 'Expected groupId for group skill scope');
      if (!uuidPattern.test(groupId)) return writeError(c, 400, 'invalid_request', 'Expected valid groupId');
      const group = await services.store.getGroup(groupId);
      if (!group) return writeError(c, 404, 'not_found', 'Group not found');
      if (
        !auth.bypass &&
        !isSuperAdmin(auth) &&
        !auth.memberships.some((membership) => membership.groupId === groupId)
      ) {
        return writeError(c, 403, 'forbidden', 'Group access is required');
      }
      skills =
        scope === 'group' ? await services.skills.listGroup(groupId) : await services.skills.listSharedInto(groupId);
    } else {
      return writeError(c, 400, 'invalid_request', 'Expected scope to be personal, group, or shared');
    }
    const source = scope === 'personal' ? 'personal' : scope === 'group' ? 'group' : 'shared';
    const visibleSkills = skills.filter((skill) => canReadSkill(auth, skill));
    const ownerGroups = await loadSkillOwnerGroups(services, visibleSkills);
    return c.json({
      skills: await Promise.all(
        visibleSkills.map((skill) => serializeSkill(services, auth, skill, source, ownerGroups)),
      ),
    });
  });

  app.post('/skills', async (c) => {
    const auth = await requireAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const ownerGroupId = optionalString(body.ownerGroupId);
    if (body.ownerGroupId !== undefined && !ownerGroupId) {
      return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: ownerGroupId');
    }
    if (ownerGroupId && !uuidPattern.test(ownerGroupId)) {
      return writeError(c, 400, 'invalid_request', 'Expected valid ownerGroupId');
    }
    if (body.autoLoad !== undefined && typeof body.autoLoad !== 'boolean') {
      return writeError(c, 400, 'invalid_request', 'Expected boolean field: autoLoad');
    }
    if (ownerGroupId) {
      const group = await services.store.getGroup(ownerGroupId);
      if (!group) return writeError(c, 404, 'not_found', 'Group not found');
      if (group.archivedAt) return writeError(c, 409, 'archived_group', 'Cannot create skills in an archived group');
      if (!canCreateSkillInGroup(auth, ownerGroupId)) {
        return writeError(c, 403, 'forbidden', 'Group member access is required to create skills');
      }
    } else if (auth.bypass) {
      return writeError(c, 400, 'invalid_request', 'Personal skills require an authenticated user');
    }
    const sharing =
      body.shareMode !== undefined || body.groupIds !== undefined
        ? await parseSkillSharingRequest(
            c,
            services,
            ownerGroupId ? { ownerKind: 'group', shareGroupIds: [] } : { ownerKind: 'user', shareGroupIds: [] },
            body,
          )
        : undefined;
    if (sharing instanceof Response) return sharing;

    try {
      const owner = ownerGroupId ? { ownerGroupId } : { ownerUserId: auth.bypass ? '' : auth.user.id };
      const skill = await services.skills.create({
        name: body.name as string,
        description: body.description as string,
        body: body.body as string,
        ...(body.autoLoad !== undefined ? { autoLoad: body.autoLoad } : {}),
        ...(sharing
          ? {
              shareMode: sharing.shareMode,
              ...(sharing.shareMode === 'specific' ? { shareGroupIds: sharing.groupIds } : {}),
            }
          : {}),
        ...owner,
        ...(auth.bypass ? {} : { createdByUserId: auth.user.id }),
        actor: skillMutationActor(auth),
      });
      return c.json({ skill: await serializeSkill(services, auth, skill, ownerGroupId ? 'group' : 'personal') }, 201);
    } catch (error) {
      return skillErrorResponse(c, error);
    }
  });

  app.get('/skills/invocation-candidates', async (c) => {
    const auth = await requireAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const ownerGroupId = optionalString(c.req.query('ownerGroupId'));
    if (!ownerGroupId || !uuidPattern.test(ownerGroupId)) {
      return writeError(c, 400, 'invalid_request', 'Expected valid ownerGroupId');
    }
    const group = await services.store.getGroup(ownerGroupId);
    if (!group) return writeError(c, 404, 'not_found', 'Group not found');
    if (group.archivedAt) return writeError(c, 409, 'archived_group', 'Cannot create sessions in an archived group');
    if (!canCreateSessionInGroup(auth, ownerGroupId)) {
      return writeError(c, 403, 'forbidden', 'Group member access is required');
    }
    const candidates = await listSkillInvocationCandidates({
      skills: services.skills,
      events: services.store,
      ownerGroupId,
      ...(!auth.bypass ? { userId: auth.user.id } : {}),
      repoSkillsEnabled: false,
      canUse: (skill) => canReadSkill(auth, skill),
    });
    const ownerGroups = await loadSkillOwnerGroups(services, candidates);
    return c.json({
      skills: await Promise.all(
        candidates.map((skill) => serializePickerCandidate(services, auth, skill, ownerGroups)),
      ),
    });
  });

  app.get('/skills/:skillId', async (c) => {
    const auth = await requireAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const skillId = c.req.param('skillId');
    if (!uuidPattern.test(skillId)) return writeError(c, 400, 'invalid_request', 'Expected valid skillId');
    const skill = await services.skills.get(skillId);
    if (!skill) return writeError(c, 404, 'not_found', 'Skill not found');
    if (!canReadSkill(auth, skill)) return writeError(c, 403, 'forbidden', 'Skill access is required');
    return c.json({ skill: await serializeSkill(services, auth, skill, skillSourceForAuth(auth, skill)) });
  });

  app.get('/skills/:skillId/revisions', async (c) => {
    const auth = await requireAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const skillId = c.req.param('skillId');
    if (!uuidPattern.test(skillId)) return writeError(c, 400, 'invalid_request', 'Expected valid skillId');
    const skill = await services.skills.get(skillId);
    if (!skill) return writeError(c, 404, 'not_found', 'Skill not found');
    if (!canManageSkill(auth, skill)) return writeError(c, 403, 'forbidden', 'Skill management access is required');
    return c.json({ revisions: await services.skills.listRevisions(skill.id) });
  });

  app.patch('/skills/:skillId', async (c) => {
    const auth = await requireAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const skillId = c.req.param('skillId');
    if (!uuidPattern.test(skillId)) return writeError(c, 400, 'invalid_request', 'Expected valid skillId');
    const skill = await services.skills.get(skillId);
    if (!skill) return writeError(c, 404, 'not_found', 'Skill not found');
    if (!canManageSkill(auth, skill)) return writeError(c, 403, 'forbidden', 'Skill management access is required');
    if (skill.archivedAt) return writeError(c, 409, 'skill_archived', 'Restore this skill before editing it');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const sharing =
      body.shareMode !== undefined || body.groupIds !== undefined
        ? await parseSkillSharingRequest(c, services, skill, body)
        : undefined;
    if (sharing instanceof Response) return sharing;
    for (const field of ['autoLoad', 'enabled'] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'boolean') {
        return writeError(c, 400, 'invalid_request', `Expected boolean field: ${field}`);
      }
    }
    const autoLoad = body.autoLoad as boolean | undefined;
    const enabled = body.enabled as boolean | undefined;
    const expectedCurrentRevisionId = optionalString(body.expectedCurrentRevisionId);
    if (body.expectedCurrentRevisionId !== undefined && !expectedCurrentRevisionId) {
      return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: expectedCurrentRevisionId');
    }
    if (expectedCurrentRevisionId && !uuidPattern.test(expectedCurrentRevisionId)) {
      return writeError(c, 400, 'invalid_request', 'Expected valid expectedCurrentRevisionId');
    }
    try {
      const updated = await services.skills.update({
        id: skill.id,
        ...(expectedCurrentRevisionId ? { expectedCurrentRevisionId } : {}),
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.description !== undefined ? { description: body.description as string } : {}),
        ...(body.body !== undefined ? { body: body.body as string } : {}),
        ...(autoLoad !== undefined ? { autoLoad } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(sharing
          ? {
              shareMode: sharing.shareMode,
              ...(sharing.shareMode === 'specific' ? { shareGroupIds: sharing.groupIds } : {}),
            }
          : {}),
        actor: skillMutationActor(auth),
      });
      return c.json({ skill: await serializeSkill(services, auth, updated, skillSourceForAuth(auth, updated)) });
    } catch (error) {
      return skillErrorResponse(c, error);
    }
  });

  app.post('/skills/:skillId/archive', (c) => mutateSkill(c, config, services, 'archive'));
  app.post('/skills/:skillId/restore', (c) => mutateSkill(c, config, services, 'restore'));

  app.post('/skills/:skillId/promote', async (c) => {
    const auth = await requireAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const skillId = c.req.param('skillId');
    if (!uuidPattern.test(skillId)) return writeError(c, 400, 'invalid_request', 'Expected valid skillId');
    const skill = await services.skills.get(skillId);
    if (!skill) return writeError(c, 404, 'not_found', 'Skill not found');
    if (auth.bypass || skill.ownerKind !== 'user' || (!isSuperAdmin(auth) && skill.ownerUserId !== auth.user.id)) {
      return writeError(c, 403, 'forbidden', 'Only the personal skill owner can promote it');
    }
    if (skill.archivedAt) return writeError(c, 409, 'skill_archived', 'Restore this skill before editing it');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const groupId = optionalString(body.groupId);
    if (!groupId) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: groupId');
    if (!uuidPattern.test(groupId)) return writeError(c, 400, 'invalid_request', 'Expected valid groupId');
    const group = await services.store.getGroup(groupId);
    if (!group) return writeError(c, 404, 'not_found', 'Group not found');
    if (group.archivedAt) return writeError(c, 409, 'archived_group', 'Cannot promote skills to an archived group');
    if (!canCreateSkillInGroup(auth, groupId)) {
      return writeError(c, 403, 'forbidden', 'Group member access is required to create skills');
    }
    try {
      const promoted = await services.skills.promote(skill.id, groupId);
      return c.json({ skill: await serializeSkill(services, auth, promoted, 'group') });
    } catch (error) {
      return skillErrorResponse(c, error);
    }
  });

  app.put('/skills/:skillId/shares', async (c) => {
    const auth = await requireAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const skillId = c.req.param('skillId');
    if (!uuidPattern.test(skillId)) return writeError(c, 400, 'invalid_request', 'Expected valid skillId');
    const skill = await services.skills.get(skillId);
    if (!skill) return writeError(c, 404, 'not_found', 'Skill not found');
    if (!canManageSkill(auth, skill)) return writeError(c, 403, 'forbidden', 'Skill management access is required');
    if (skill.archivedAt) return writeError(c, 409, 'skill_archived', 'Restore this skill before editing it');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const sharing = await parseSkillSharingRequest(c, services, skill, body);
    if (sharing instanceof Response) return sharing;
    try {
      const updated = await services.skills.setShares(skill.id, sharing.shareMode, sharing.groupIds);
      return c.json({ skill: await serializeSkill(services, auth, updated, 'group') });
    } catch (error) {
      return skillErrorResponse(c, error);
    }
  });

  app.get('/sessions/:sessionId/skills', async (c) => {
    const auth = await requireAuthorization(config, services, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const session = c.get('authorizedSession');
    if (!session || session.id !== c.req.param('sessionId'))
      return writeError(c, 404, 'not_found', 'Session not found');
    const authorUserId = auth.bypass ? undefined : auth.user.id;
    const candidates = await listSkillInvocationCandidates({
      skills: services.skills,
      events: services.store,
      ownerGroupId: session.ownerGroupId,
      ...(authorUserId ? { userId: authorUserId } : {}),
      sessionId: session.id,
      repoSkillsEnabled: config.repoSkillsEnabled,
      canUse: (skill) => canInvokeSkillInSession(auth, skill, session, authorUserId),
    });
    const ownerGroups = await loadSkillOwnerGroups(services, candidates);
    return c.json({
      skills: await Promise.all(
        candidates.map((skill) => serializePickerCandidate(services, auth, skill, ownerGroups)),
      ),
    });
  });
}

async function loadSkillOwnerGroups(
  services: AppServices,
  skills: Array<SkillRecord | SkillInvocationCandidate>,
): Promise<Map<string, GroupRecord>> {
  const ownerGroupIds = [
    ...new Set(skills.flatMap((skill) => ('ownerGroupId' in skill && skill.ownerGroupId ? [skill.ownerGroupId] : []))),
  ];
  return new Map((await services.store.getGroups(ownerGroupIds)).map((group) => [group.id, group]));
}

async function mutateSkill(
  c: Context,
  config: AppConfig,
  services: AppServices,
  operation: 'archive' | 'restore',
): Promise<Response> {
  const auth = await requireAuthorization(config, services, c);
  if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
  const skillId = c.req.param('skillId');
  if (!skillId || !uuidPattern.test(skillId)) return writeError(c, 400, 'invalid_request', 'Expected valid skillId');
  const skill = await services.skills.get(skillId);
  if (!skill) return writeError(c, 404, 'not_found', 'Skill not found');
  if (!canManageSkill(auth, skill)) return writeError(c, 403, 'forbidden', 'Skill management access is required');
  try {
    const updated =
      operation === 'archive' ? await services.skills.archive(skill.id) : await services.skills.restore(skill.id);
    return c.json({ skill: await serializeSkill(services, auth, updated, skillSourceForAuth(auth, updated)) });
  } catch (error) {
    return skillErrorResponse(c, error);
  }
}

async function serializeSkill(
  services: AppServices,
  auth: RequestAuthorization,
  skill: SkillRecord,
  source: 'personal' | 'group' | 'shared',
  ownerGroups?: ReadonlyMap<string, GroupRecord>,
) {
  const ownerGroup = skill.ownerGroupId
    ? (ownerGroups?.get(skill.ownerGroupId) ?? (ownerGroups ? null : await services.store.getGroup(skill.ownerGroupId)))
    : null;
  const canManage = canManageSkill(auth, skill);
  return {
    id: skill.id,
    ownerKind: skill.ownerKind,
    ...(skill.ownerUserId ? { ownerUserId: skill.ownerUserId } : {}),
    ...(skill.ownerGroupId ? { ownerGroupId: skill.ownerGroupId } : {}),
    ...(ownerGroup ? { ownerGroupName: ownerGroup.name } : {}),
    name: skill.name,
    description: skill.description,
    body: skill.body,
    currentRevisionId: skill.currentRevisionId,
    currentRevisionNumber: skill.currentRevisionNumber,
    autoLoad: skill.autoLoad,
    enabled: skill.enabled,
    shareMode: skill.shareMode,
    ...(canManage ? { shareGroupIds: skill.shareGroupIds } : {}),
    source,
    ...(skill.archivedAt ? { archivedAt: skill.archivedAt } : {}),
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    canManage,
  };
}

async function serializePickerSkill(
  services: AppServices,
  auth: RequestAuthorization,
  skill: SkillRunCandidate,
  ownerGroups: ReadonlyMap<string, GroupRecord>,
) {
  const serialized = await serializeSkill(services, auth, skill, skill.source, ownerGroups);
  const { body: _body, ...picker } = serialized;
  return {
    ...picker,
    provenance: {
      kind: skill.source,
      ...(skill.ownerUserId ? { ownerUserId: skill.ownerUserId } : {}),
      ...(skill.ownerGroupId ? { ownerGroupId: skill.ownerGroupId } : {}),
      ...(picker.ownerGroupName ? { ownerGroupName: picker.ownerGroupName } : {}),
    },
  };
}

async function serializePickerCandidate(
  services: AppServices,
  auth: RequestAuthorization,
  skill: SkillInvocationCandidate,
  ownerGroups: ReadonlyMap<string, GroupRecord>,
) {
  if (skill.source !== 'repo') return serializePickerSkill(services, auth, skill, ownerGroups);
  return serializeRepositoryPickerSkill(skill);
}

function serializeRepositoryPickerSkill(skill: RepositorySkillInvocationCandidate) {
  return {
    id: skill.id,
    name: skill.name,
    description: `Repository skill from ${skill.repo}`,
    autoLoad: skill.advertised,
    enabled: true,
    shareMode: 'none' as const,
    source: 'repo' as const,
    repo: skill.repo,
    advertised: skill.advertised,
    createdAt: skill.discoveredAt,
    updatedAt: skill.discoveredAt,
    provenance: { kind: 'repo' as const, repo: skill.repo },
  };
}

function skillSourceForAuth(auth: RequestAuthorization, skill: SkillRecord): 'personal' | 'group' | 'shared' {
  if (skill.ownerKind === 'user') return 'personal';
  if (auth.bypass || (skill.ownerGroupId && auth.memberships.some((member) => member.groupId === skill.ownerGroupId))) {
    return 'group';
  }
  return 'shared';
}

function parseShareMode(value: unknown): SkillShareMode | null {
  return value === 'none' || value === 'specific' || value === 'all_groups' ? value : null;
}

async function parseSkillSharingRequest(
  c: Context,
  services: AppServices,
  skill: Pick<SkillRecord, 'ownerKind' | 'shareGroupIds'>,
  body: Record<string, unknown>,
): Promise<{ shareMode: SkillShareMode; groupIds: string[] } | Response> {
  if (skill.ownerKind !== 'group') return writeError(c, 400, 'invalid_request', 'Personal skills cannot be shared');
  const shareMode = parseShareMode(body.shareMode);
  if (!shareMode) return writeError(c, 400, 'invalid_request', 'Expected valid shareMode');
  const groupIds = parseGroupIds(body.groupIds);
  if (shareMode === 'specific' && (!groupIds || !groupIds.length)) {
    return writeError(c, 400, 'invalid_request', 'Specific sharing requires at least one groupId');
  }
  if (shareMode !== 'specific' && body.groupIds !== undefined) {
    return writeError(c, 400, 'invalid_request', 'groupIds is only valid for specific sharing');
  }
  if (shareMode === 'specific') {
    if (!groupIds) return writeError(c, 400, 'invalid_request', 'Expected groupIds to be an array of strings');
    const existingShareGroupIds = new Set(skill.shareGroupIds);
    for (const groupId of groupIds) {
      if (!uuidPattern.test(groupId))
        return writeError(c, 400, 'invalid_request', `Expected valid groupId: ${groupId}`);
      const group = await services.store.getGroup(groupId);
      if (!group) return writeError(c, 404, 'not_found', `Group not found: ${groupId}`);
      if (group.archivedAt && !existingShareGroupIds.has(groupId)) {
        return writeError(c, 409, 'archived_group', `Cannot share skills with archived group: ${groupId}`);
      }
    }
  }
  return { shareMode, groupIds: groupIds ?? [] };
}

function parseGroupIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((groupId) => typeof groupId !== 'string' || !groupId.trim())) return null;
  return [...new Set(value as string[])];
}

function requireAuthorization(config: AppConfig, services: AppServices, c: Context) {
  return readRequestAuthorization(config, services.store, c);
}

function skillMutationActor(auth: RequestAuthorization) {
  return auth.bypass ? ({ type: 'system' } as const) : ({ type: 'user', userId: auth.user.id } as const);
}

function skillErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof StoreConflictError) {
    if (
      error.code === 'skill_name_exists' ||
      error.code === 'skill_update_conflict' ||
      error.code === 'skill_archived' ||
      error.code === 'archived_group'
    ) {
      return writeError(c, 409, error.code, error.message);
    }
  }
  if (error instanceof SkillServiceError) {
    if (error.code === 'not_found') return writeError(c, 404, 'not_found', error.message);
    if (error.code === 'skill_archived') return writeError(c, 409, error.code, error.message);
    return writeError(c, 400, 'invalid_request', error.message);
  }
  throw error;
}
