import type { Server } from 'node:http';
import { createServer, createServices, type AppServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { GroupRole } from '../../src/store/types.js';

const ownerGroupId = '00000000-0000-4000-8000-000000000101';
const targetGroupId = '00000000-0000-4000-8000-000000000102';
const replacementGroupId = '00000000-0000-4000-8000-000000000103';

describe('skills API', () => {
  let server: Server;
  let baseUrl: string;
  let store: MemoryStore;
  let services: AppServices;

  beforeEach(async () => {
    store = new MemoryStore();
    services = createServices(store);
    await createGroup(ownerGroupId, 'Owners');
    await createGroup(targetGroupId, 'Targets');
    server = createServer(
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_SESSION_SECRET: 'test-secret',
        AUTH_STATIC_USERNAME: 'admin',
        AUTH_STATIC_PASSWORD: 'password',
      }),
      services,
    );
    baseUrl = await listen(server);
  });

  afterEach(async () => closeServer(server));

  it('supports validated CRUD, creator/admin management, and viewer read-only access', async () => {
    const creator = await createUser('creator', [[ownerGroupId, 'member']]);
    const viewer = await createUser('viewer', [[ownerGroupId, 'viewer']]);
    const admin = await createUser('group-admin', [[ownerGroupId, 'admin']]);

    const invalid = await post('/skills', creator, {
      ownerGroupId,
      name: 'Invalid_Name',
      description: 'Description',
      body: 'Body',
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: 'invalid_request' });

    const created = await post('/skills', creator, {
      ownerGroupId,
      name: 'review-code',
      description: '  Review code  ',
      body: '# Review',
      autoLoad: false,
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { skill: { id: string; shareGroupIds?: string[] } };
    expect(createdBody.skill).toMatchObject({
      name: 'review-code',
      description: 'Review code',
      source: 'group',
      canManage: true,
      shareGroupIds: [],
    });

    const duplicate = await post('/skills', creator, {
      ownerGroupId,
      name: 'review-code',
      description: 'Duplicate',
      body: '',
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ error: 'skill_name_exists' });

    const viewerRead = await request(`/skills/${createdBody.skill.id}`, viewer);
    expect(viewerRead.status).toBe(200);
    const viewerReadBody = (await viewerRead.json()) as { skill: Record<string, unknown> };
    expect(viewerReadBody).toMatchObject({ skill: { body: '# Review', canManage: false } });
    expect((await (await request(`/skills/${createdBody.skill.id}`, viewer)).json()) as object).not.toHaveProperty(
      'skill.shareGroupIds',
    );

    const viewerEdit = await patch(`/skills/${createdBody.skill.id}`, viewer, { enabled: false });
    expect(viewerEdit.status).toBe(403);
    const adminEdit = await patch(`/skills/${createdBody.skill.id}`, admin, { enabled: false });
    expect(adminEdit.status).toBe(200);

    expect((await request('/groups', creator).then((response) => response.json())) as object).toMatchObject({
      groups: expect.arrayContaining([expect.objectContaining({ id: ownerGroupId, canCreateSkills: true })]),
    });
    expect((await request('/groups', viewer).then((response) => response.json())) as object).toMatchObject({
      groups: expect.arrayContaining([expect.objectContaining({ id: ownerGroupId, canCreateSkills: false })]),
    });

    const now = new Date();
    await store.upsertGroupMember({
      groupId: ownerGroupId,
      userId: creator.userId,
      role: 'viewer',
      createdAt: now,
      updatedAt: now,
    });
    expect((await patch(`/skills/${createdBody.skill.id}`, creator, { enabled: true })).status).toBe(403);
  });

  it('validates sharing targets and hides share ids from shared-in readers', async () => {
    const creator = await createUser('creator', [[ownerGroupId, 'member']]);
    const targetMember = await createUser('target-member', [[targetGroupId, 'member']]);
    const created = await post('/skills', creator, {
      ownerGroupId,
      name: 'deploy-check',
      description: 'Check deploys',
      body: 'Check carefully',
    });
    const skillId = ((await created.json()) as { skill: { id: string } }).skill.id;

    const emptySpecific = await put(`/skills/${skillId}/shares`, creator, { shareMode: 'specific', groupIds: [] });
    expect(emptySpecific.status).toBe(400);
    const shares = await put(`/skills/${skillId}/shares`, creator, {
      shareMode: 'specific',
      groupIds: [targetGroupId],
    });
    expect(shares.status).toBe(200);
    await expect(shares.json()).resolves.toMatchObject({ skill: { shareGroupIds: [targetGroupId] } });

    const shared = await request(`/skills?scope=shared&groupId=${targetGroupId}`, targetMember);
    expect(shared.status).toBe(200);
    const sharedBody = (await shared.json()) as { skills: Array<Record<string, unknown>> };
    expect(sharedBody.skills).toHaveLength(1);
    expect(sharedBody.skills[0]).toMatchObject({
      name: 'deploy-check',
      body: 'Check carefully',
      source: 'shared',
      canManage: false,
    });
    expect(sharedBody.skills[0]).not.toHaveProperty('shareGroupIds');

    const invalidModeShape = await put(`/skills/${skillId}/shares`, creator, {
      shareMode: 'all_groups',
      groupIds: [targetGroupId],
    });
    expect(invalidModeShape.status).toBe(400);
  });

  it('lists authorized revision metadata and canonicalizes managed invocations to immutable pins', async () => {
    const creator = await createUser('revision-creator', [[ownerGroupId, 'member']]);
    const viewer = await createUser('revision-viewer', [[ownerGroupId, 'viewer']]);
    const outsider = await createUser('revision-outsider', [[targetGroupId, 'member']]);
    const createdResponse = await post('/skills', creator, {
      ownerGroupId,
      name: 'revision-api',
      description: 'Revision one',
      body: 'First body',
    });
    const created = (await createdResponse.json()) as {
      skill: { id: string; currentRevisionId: string; currentRevisionNumber: number };
    };
    expect(created.skill.currentRevisionNumber).toBe(1);

    expect((await request(`/skills/${created.skill.id}/revisions`, outsider)).status).toBe(403);
    const viewerHistory = await request(`/skills/${created.skill.id}/revisions`, viewer);
    expect(viewerHistory.status).toBe(403);
    const initial = await request(`/skills/${created.skill.id}/revisions`, creator);
    await expect(initial.json()).resolves.toMatchObject({
      revisions: [
        {
          id: created.skill.currentRevisionId,
          revisionNumber: 1,
          name: 'revision-api',
          body: 'First body',
          actorType: 'user',
          actorUserId: creator.userId,
        },
      ],
    });

    expect((await patch(`/skills/${created.skill.id}`, creator, { autoLoad: false })).status).toBe(200);
    const afterMetadata = await request(`/skills/${created.skill.id}/revisions`, creator);
    expect(((await afterMetadata.json()) as { revisions: unknown[] }).revisions).toHaveLength(1);

    const revisedResponse = await patch(`/skills/${created.skill.id}`, creator, {
      description: 'Revision two',
      body: 'Second body',
    });
    const revised = (await revisedResponse.json()) as {
      skill: { currentRevisionId: string; currentRevisionNumber: number };
    };
    expect(revised.skill).toMatchObject({ currentRevisionNumber: 2 });
    const history = (await (await request(`/skills/${created.skill.id}/revisions`, creator)).json()) as {
      revisions: Array<{ id: string; revisionNumber: number }>;
    };
    expect(history.revisions.map(({ id, revisionNumber }) => [id, revisionNumber])).toEqual([
      [revised.skill.currentRevisionId, 2],
      [created.skill.currentRevisionId, 1],
    ]);
    const staleUpdate = await patch(`/skills/${created.skill.id}`, creator, {
      expectedCurrentRevisionId: created.skill.currentRevisionId,
      body: 'Stale overwrite',
    });
    expect(staleUpdate.status).toBe(409);
    await expect(staleUpdate.json()).resolves.toMatchObject({ error: 'skill_update_conflict' });

    const session = await services.sessions.create({
      ownerGroupId,
      createdByUserId: creator.userId,
      visibility: 'group',
      writePolicy: 'group_members',
    });
    const stalePin = await post(`/sessions/${session.id}/messages`, creator, {
      prompt: 'Use the first revision',
      context: {
        skills: ['revision-api'],
        skillRefs: [{ id: created.skill.id, name: 'revision-api', revisionId: created.skill.currentRevisionId }],
      },
    });
    expect(stalePin.status).toBe(400);
    await expect(stalePin.json()).resolves.toMatchObject({ error: 'unknown_skill' });

    const pinned = await post(`/sessions/${session.id}/messages`, creator, {
      prompt: 'Use the current revision',
      context: {
        skills: ['revision-api'],
        skillRefs: [{ id: created.skill.id, name: 'revision-api' }],
      },
    });
    expect(pinned.status).toBe(202);
    await expect(pinned.json()).resolves.toMatchObject({
      message: {
        context: {
          skillRefs: [{ id: created.skill.id, name: 'revision-api', revisionId: revised.skill.currentRevisionId }],
        },
      },
    });

    await patch(`/skills/${created.skill.id}`, creator, { enabled: false });
    const revoked = await post(`/sessions/${session.id}/messages`, creator, {
      prompt: 'Pinned access is still live-authorized',
      context: {
        skills: ['revision-api'],
        skillRefs: [{ id: created.skill.id, name: 'revision-api', revisionId: revised.skill.currentRevisionId }],
      },
    });
    expect(revoked.status).toBe(400);
    await expect(revoked.json()).resolves.toMatchObject({ error: 'unknown_skill' });
  });

  it('allows an archived existing share to be retained or removed but not newly granted', async () => {
    const creator = await createUser('archived-share-creator', [[ownerGroupId, 'member']]);
    await createGroup(replacementGroupId, 'Replacements');
    const created = await post('/skills', creator, {
      ownerGroupId,
      name: 'archived-share',
      description: 'Retain an existing archived share',
      body: 'Check carefully',
    });
    const skillId = ((await created.json()) as { skill: { id: string } }).skill.id;
    expect(
      (
        await put(`/skills/${skillId}/shares`, creator, {
          shareMode: 'specific',
          groupIds: [targetGroupId],
        })
      ).status,
    ).toBe(200);

    const target = await store.getGroup(targetGroupId);
    await store.updateGroup({ ...target!, archivedAt: new Date(), updatedAt: new Date() });

    const allGroups = await put(`/skills/${skillId}/shares`, creator, { shareMode: 'all_groups' });
    expect(allGroups.status).toBe(200);
    await expect(allGroups.json()).resolves.toMatchObject({
      skill: { shareMode: 'all_groups', shareGroupIds: [targetGroupId] },
    });

    const retained = await put(`/skills/${skillId}/shares`, creator, {
      shareMode: 'specific',
      groupIds: [targetGroupId, replacementGroupId],
    });
    expect(retained.status).toBe(200);
    await expect(retained.json()).resolves.toMatchObject({
      skill: { shareGroupIds: [targetGroupId, replacementGroupId] },
    });

    const removed = await put(`/skills/${skillId}/shares`, creator, {
      shareMode: 'specific',
      groupIds: [replacementGroupId],
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({ skill: { shareGroupIds: [replacementGroupId] } });

    const otherSkill = await post('/skills', creator, {
      ownerGroupId,
      name: 'new-archived-share',
      description: 'Reject a new archived share',
      body: 'Check carefully',
    });
    const otherSkillId = ((await otherSkill.json()) as { skill: { id: string } }).skill.id;
    const newlyGranted = await put(`/skills/${otherSkillId}/shares`, creator, {
      shareMode: 'specific',
      groupIds: [targetGroupId],
    });
    expect(newlyGranted.status).toBe(409);
    await expect(newlyGranted.json()).resolves.toMatchObject({ error: 'archived_group' });
  });

  it('allows super admins to list group and shared skills without direct membership', async () => {
    const creator = await createUser('creator', [[ownerGroupId, 'member']]);
    const superAdmin = await createUser('super-admin', [], 'super_admin');
    const created = await post('/skills', creator, {
      ownerGroupId,
      name: 'admin-visible',
      description: 'Visible to super admins',
      body: 'Review this skill',
    });
    expect(created.status).toBe(201);

    expect((await request(`/skills?scope=group&groupId=${ownerGroupId}`, superAdmin)).status).toBe(200);
    expect((await request(`/skills?scope=shared&groupId=${targetGroupId}`, superAdmin)).status).toBe(200);
  });

  it('restricts personal skills and promotes only the owner into an active creatable group', async () => {
    const owner = await createUser('personal-owner', [[targetGroupId, 'member']]);
    const outsider = await createUser('outsider', [[ownerGroupId, 'member']]);
    const created = await post('/skills', owner, {
      name: 'personal-helper',
      description: 'Personal helper',
      body: 'Help the owner',
    });
    expect(created.status).toBe(201);
    const skillId = ((await created.json()) as { skill: { id: string } }).skill.id;

    expect((await request(`/skills/${skillId}`, outsider)).status).toBe(403);
    expect((await put(`/skills/${skillId}/shares`, owner, { shareMode: 'all_groups' })).status).toBe(400);
    expect((await post(`/skills/${skillId}/promote`, outsider, { groupId: targetGroupId })).status).toBe(403);

    const target = await store.getGroup(targetGroupId);
    await store.updateGroup({ ...target!, archivedAt: new Date(), updatedAt: new Date() });
    const archivedTarget = await post(`/skills/${skillId}/promote`, owner, { groupId: targetGroupId });
    expect(archivedTarget.status).toBe(409);
    await expect(archivedTarget.json()).resolves.toMatchObject({ error: 'archived_group' });
    const archivedGroup = await store.getGroup(targetGroupId);
    const { archivedAt: _archivedAt, ...activeTarget } = archivedGroup!;
    await store.updateGroup({ ...activeTarget, updatedAt: new Date() });

    const promoted = await post(`/skills/${skillId}/promote`, owner, { groupId: targetGroupId });
    expect(promoted.status).toBe(200);
    await expect(promoted.json()).resolves.toMatchObject({
      skill: { ownerKind: 'group', ownerGroupId: targetGroupId, shareMode: 'none', source: 'group' },
    });

    const another = await post('/skills', owner, {
      name: 'admin-promoted-helper',
      description: 'Promoted by a super admin',
      body: 'Help the owner',
    });
    const anotherSkillId = ((await another.json()) as { skill: { id: string } }).skill.id;
    const superAdmin = await createUser('promotion-admin', [], 'super_admin');
    const adminPromoted = await post(`/skills/${anotherSkillId}/promote`, superAdmin, { groupId: ownerGroupId });
    expect(adminPromoted.status).toBe(200);
    await expect(adminPromoted.json()).resolves.toMatchObject({
      skill: { id: anotherSkillId, ownerKind: 'group', ownerGroupId },
    });
  });

  it('lists managed and latest repository skills and validates append/edit context without persisting it', async () => {
    const creator = await createUser('creator', [[ownerGroupId, 'member']]);
    const created = await post('/skills', creator, {
      ownerGroupId,
      name: 'review-code',
      description: 'Review code',
      body: 'Review carefully',
      autoLoad: false,
    });
    expect(created.status).toBe(201);
    const session = await services.sessions.create({
      title: 'Skills session',
      ownerGroupId,
      createdByUserId: creator.userId,
      visibility: 'group',
      writePolicy: 'group_members',
    });
    await services.events.append({
      sessionId: session.id,
      type: 'skills_loaded',
      payload: {
        skills: [
          { name: 'repo-helper', source: 'repo', repo: 'acme/widget' },
          { name: 'review-code', source: 'repo', repo: 'acme/widget' },
          { name: 'manual-repo', source: 'repo', repo: 'acme/widget', advertised: false },
        ],
        shadowed: [],
        diagnostics: [],
      },
    });

    const picker = await request(`/sessions/${session.id}/skills`, creator);
    expect(picker.status).toBe(200);
    const pickerBody = (await picker.json()) as {
      skills: Array<{ id: string; name: string; source: string; currentRevisionId?: string }>;
    };
    expect(pickerBody).toMatchObject({
      skills: expect.arrayContaining([
        expect.objectContaining({ name: 'review-code', source: 'group' }),
        expect.objectContaining({ name: 'repo-helper', source: 'repo' }),
        expect.objectContaining({ name: 'manual-repo', source: 'repo', advertised: false, autoLoad: false }),
      ]),
    });
    expect(pickerBody.skills.filter((skill) => skill.name === 'review-code')).toEqual([
      expect.objectContaining({ source: 'group' }),
      expect.objectContaining({ source: 'repo', id: 'repo:acme/widget:review-code' }),
    ]);

    const append = await post(`/sessions/${session.id}/messages`, creator, {
      prompt: 'Review this',
      context: {
        skills: ['review-code'],
        skillRefs: [{ id: pickerBody.skills.find((skill) => skill.source === 'group')!.id, name: 'review-code' }],
      },
    });
    expect(append.status).toBe(202);
    const message = ((await append.json()) as { message: { id: string; context: Record<string, unknown> } }).message;
    expect(message.context.skills).toEqual(['review-code']);
    expect(message.context.skillRefs).toEqual([
      {
        id: pickerBody.skills.find((skill) => skill.source === 'group')!.id,
        name: 'review-code',
        revisionId: pickerBody.skills.find((skill) => skill.source === 'group')!.currentRevisionId,
      },
    ]);
    expect(await store.getSession(session.id)).not.toHaveProperty('context.skills');

    const skillOnly = await post(`/sessions/${session.id}/messages`, creator, {
      prompt: '',
      context: {
        skills: ['review-code'],
        skillRefs: [{ id: pickerBody.skills.find((skill) => skill.source === 'group')!.id, name: 'review-code' }],
      },
    });
    expect(skillOnly.status).toBe(202);
    await expect(skillOnly.json()).resolves.toMatchObject({
      message: { prompt: '', context: { skills: ['review-code'] } },
    });

    const empty = await post(`/sessions/${session.id}/messages`, creator, { prompt: '', context: {} });
    expect(empty.status).toBe(400);

    const edit = await patch(`/sessions/${session.id}/messages/${message.id}`, creator, {
      prompt: 'Use the repo helper',
      context: { skills: ['repo-helper'] },
    });
    expect(edit.status).toBe(200);
    const edited = (await edit.json()) as { message: { context: Record<string, unknown> } };
    expect(edited.message.context.skills).toEqual(['repo-helper']);
    expect(edited.message.context.skillRefs).toEqual([{ id: 'repo:acme/widget:repo-helper', name: 'repo-helper' }]);

    const unknown = await post(`/sessions/${session.id}/messages`, creator, {
      prompt: 'Unknown',
      context: { skills: ['review-cod'] },
    });
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({
      error: 'unknown_skill',
      message: expect.stringContaining('review-cod'),
    });

    const tooMany = await post(`/sessions/${session.id}/messages`, creator, {
      prompt: 'Too many',
      context: { skills: Array.from({ length: 9 }, (_, index) => `skill-${index}`) },
    });
    expect(tooMany.status).toBe(400);
    await expect(tooMany.json()).resolves.toMatchObject({ error: 'invalid_request' });
  });

  it('authorizes picker candidates before resolving personal and group name collisions', async () => {
    const creator = await createUser('collision-creator', [[ownerGroupId, 'member']]);
    const collaborator = await createUser('collision-collaborator', [[ownerGroupId, 'member']]);
    const groupSkillResponse = await post('/skills', creator, {
      ownerGroupId,
      name: 'same-name',
      description: 'Group skill',
      body: 'Group body',
    });
    const creatorSkillResponse = await post('/skills', creator, {
      name: 'same-name',
      description: 'Personal skill',
      body: 'Private body',
    });
    const collaboratorSkillResponse = await post('/skills', collaborator, {
      name: 'same-name',
      description: 'Collaborator personal skill',
      body: 'Collaborator private body',
    });
    const groupSkillId = ((await groupSkillResponse.json()) as { skill: { id: string } }).skill.id;
    const creatorSkillId = ((await creatorSkillResponse.json()) as { skill: { id: string } }).skill.id;
    const collaboratorSkillId = ((await collaboratorSkillResponse.json()) as { skill: { id: string } }).skill.id;
    const session = await services.sessions.create({
      ownerGroupId,
      createdByUserId: creator.userId,
      visibility: 'group',
      writePolicy: 'group_members',
    });

    const preSession = await request(`/skills/invocation-candidates?ownerGroupId=${ownerGroupId}`, collaborator);
    expect(preSession.status).toBe(200);
    await expect(preSession.json()).resolves.toMatchObject({
      skills: expect.arrayContaining([
        expect.objectContaining({
          id: collaboratorSkillId,
          source: 'personal',
          provenance: { kind: 'personal', ownerUserId: collaborator.userId },
        }),
        expect.objectContaining({
          id: groupSkillId,
          source: 'group',
          provenance: { kind: 'group', ownerGroupId, ownerGroupName: 'Owners' },
        }),
      ]),
    });

    const picker = await request(`/sessions/${session.id}/skills`, collaborator);
    expect(picker.status).toBe(200);
    const body = (await picker.json()) as { skills: Array<{ id: string; name: string; source: string }> };
    expect(body.skills.filter((skill) => skill.name === 'same-name')).toEqual([
      expect.objectContaining({ id: collaboratorSkillId, source: 'personal' }),
      expect.objectContaining({ source: 'group' }),
    ]);
    expect(body.skills).not.toContainEqual(expect.objectContaining({ id: creatorSkillId }));

    const invoke = await post(`/sessions/${session.id}/messages`, collaborator, {
      prompt: 'Use the visible skill',
      context: {
        skills: ['same-name', 'same-name'],
        skillRefs: [
          { id: collaboratorSkillId, name: 'same-name' },
          { id: groupSkillId, name: 'same-name' },
        ],
      },
    });
    expect(invoke.status).toBe(202);

    const forbidden = await post(`/sessions/${session.id}/messages`, collaborator, {
      prompt: 'Try another personal skill',
      context: { skills: ['same-name'], skillRefs: [{ id: creatorSkillId, name: 'same-name' }] },
    });
    expect(forbidden.status).toBe(400);
    await expect(forbidden.json()).resolves.toMatchObject({ error: 'unknown_skill' });
  });

  it('returns controlled validation errors for malformed skill and group ids', async () => {
    const member = await createUser('id-validator', [[ownerGroupId, 'member']]);
    const groupSkill = await post('/skills', member, {
      ownerGroupId,
      name: 'id-group-skill',
      description: 'Group skill',
      body: '',
    });
    const groupSkillId = ((await groupSkill.json()) as { skill: { id: string } }).skill.id;
    const personalSkill = await post('/skills', member, {
      name: 'id-personal-skill',
      description: 'Personal skill',
      body: '',
    });
    const personalSkillId = ((await personalSkill.json()) as { skill: { id: string } }).skill.id;
    const responses = await Promise.all([
      request('/skills/not-a-uuid', member),
      patch('/skills/not-a-uuid', member, { enabled: false }),
      request('/skills?scope=group&groupId=not-a-uuid', member),
      post('/skills', member, {
        ownerGroupId: 'not-a-uuid',
        name: 'invalid-owner',
        description: 'Invalid owner',
        body: '',
      }),
      put(`/skills/${groupSkillId}/shares`, member, { shareMode: 'specific', groupIds: ['not-a-uuid'] }),
      post(`/skills/${personalSkillId}/promote`, member, { groupId: 'not-a-uuid' }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
    for (const response of responses)
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
  });

  it('gates historical repository skills and invocation when repository skills are disabled', async () => {
    await closeServer(server);
    server = createServer(
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_SESSION_SECRET: 'test-secret',
        AUTH_STATIC_USERNAME: 'admin',
        AUTH_STATIC_PASSWORD: 'password',
        REPO_SKILLS_ENABLED: 'false',
      }),
      services,
    );
    baseUrl = await listen(server);
    const member = await createUser('repo-disabled', [[ownerGroupId, 'member']]);
    const session = await services.sessions.create({
      ownerGroupId,
      createdByUserId: member.userId,
      visibility: 'group',
      writePolicy: 'group_members',
    });
    await services.events.append({
      sessionId: session.id,
      type: 'skills_loaded',
      payload: {
        skills: [{ name: 'historical-repo-skill', source: 'repo', repo: 'acme/widget' }],
        shadowed: [],
        diagnostics: [],
      },
    });

    const picker = await request(`/sessions/${session.id}/skills`, member);
    await expect(picker.json()).resolves.toEqual({ skills: [] });
    const invoke = await post(`/sessions/${session.id}/messages`, member, {
      prompt: 'Do not trust history',
      context: { skills: ['historical-repo-skill'] },
    });
    expect(invoke.status).toBe(400);
    await expect(invoke.json()).resolves.toMatchObject({ error: 'unknown_skill' });
  });

  it('exposes complete skill load details to session readers', async () => {
    const creator = await createUser('event-creator', [[ownerGroupId, 'member']]);
    const reader = await createUser('event-reader', [[ownerGroupId, 'member']]);
    const session = await services.sessions.create({
      ownerGroupId,
      createdByUserId: creator.userId,
      visibility: 'group',
      writePolicy: 'group_members',
    });
    await services.events.append({
      sessionId: session.id,
      type: 'skills_loaded',
      payload: {
        skills: [
          { name: 'private-helper', source: 'personal' },
          { name: 'group-helper', source: 'group' },
        ],
        shadowed: [
          { name: 'private-helper', source: 'group' },
          { name: 'shared-helper', source: 'shared' },
        ],
        diagnostics: ['Personal skill private-helper shadowed a group skill'],
      },
    });

    const creatorEvents = (await (await request(`/sessions/${session.id}/events`, creator)).json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(creatorEvents.events.find((event) => event.type === 'skills_loaded')?.payload).toMatchObject({
      skills: expect.arrayContaining([expect.objectContaining({ name: 'private-helper', source: 'personal' })]),
      diagnostics: ['Personal skill private-helper shadowed a group skill'],
    });

    const readerEvents = (await (await request(`/sessions/${session.id}/events`, reader)).json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(readerEvents.events.find((event) => event.type === 'skills_loaded')?.payload).toEqual(
      creatorEvents.events.find((event) => event.type === 'skills_loaded')?.payload,
    );
    const globalEvents = (await (await request('/events?include=all', reader)).json()) as {
      events: Array<{ sessionId: string; type: string; payload: Record<string, unknown> }>;
    };
    expect(
      globalEvents.events.find((event) => event.sessionId === session.id && event.type === 'skills_loaded')?.payload,
    ).toEqual(creatorEvents.events.find((event) => event.type === 'skills_loaded')?.payload);

    const abort = new AbortController();
    const stream = await request(`/sessions/${session.id}/events/stream?after=1`, reader, { signal: abort.signal });
    try {
      const streamed = await readFirstSseEvent(stream);
      expect(streamed.payload).toEqual(creatorEvents.events.find((event) => event.type === 'skills_loaded')?.payload);
    } finally {
      abort.abort();
      await stream.body?.cancel().catch(() => undefined);
    }
  });

  it('hides skill routes and rejects structured invocation when skills are disabled', async () => {
    await closeServer(server);
    server = createServer(
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_SESSION_SECRET: 'test-secret',
        AUTH_STATIC_USERNAME: 'admin',
        AUTH_STATIC_PASSWORD: 'password',
        SKILLS_ENABLED: 'false',
      }),
      services,
    );
    baseUrl = await listen(server);
    const member = await createUser('member', [[ownerGroupId, 'member']]);
    const session = await services.sessions.create({
      ownerGroupId,
      createdByUserId: member.userId,
      visibility: 'group',
      writePolicy: 'group_members',
    });

    expect((await fetch(`${baseUrl}/skills?scope=group&groupId=${ownerGroupId}`)).status).toBe(404);
    expect((await request('/skills?scope=group&groupId=' + ownerGroupId, member)).status).toBe(404);
    expect((await request(`/sessions/${session.id}/skills`, member)).status).toBe(404);
    const append = await post(`/sessions/${session.id}/messages`, member, {
      prompt: 'No skills',
      context: { skills: ['anything'] },
    });
    expect(append.status).toBe(400);
    await expect(append.json()).resolves.toMatchObject({ error: 'unknown_skill' });
  });

  async function createGroup(id: string, name: string): Promise<void> {
    const now = new Date();
    await store.createGroup({
      id,
      name,
      defaultVisibility: 'group',
      defaultWritePolicy: 'group_members',
      automationCreateRequiredRole: 'member',
      createdAt: now,
      updatedAt: now,
    });
  }

  async function createUser(
    username: string,
    memberships: Array<[string, GroupRole]>,
    role: 'user' | 'super_admin' = 'user',
  ): Promise<{ cookie: string; userId: string }> {
    const now = new Date();
    const suffix = String(username.length) + username.charCodeAt(0);
    const userId = `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
    const user = await store.upsertAuthUserForAccount({
      userId,
      accountId: `10000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
      provider: 'test',
      providerAccountId: username,
      username,
      role,
      profile: {},
      now,
    });
    for (const [groupId, role] of memberships) {
      await store.upsertGroupMember({ groupId, userId: user.id, role, createdAt: now, updatedAt: now });
    }
    const sessionId = `${username}-session`;
    await store.createAuthSession({
      id: sessionId,
      userId: user.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    return { cookie: `dev_deputies_session=${sessionId}`, userId: user.id };
  }

  function request(path: string, auth: { cookie: string }, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, cookie: auth.cookie } });
  }

  function post(path: string, auth: { cookie: string }, body: unknown): Promise<Response> {
    return request(path, auth, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function patch(path: string, auth: { cookie: string }, body: unknown): Promise<Response> {
    return request(path, auth, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function put(path: string, auth: { cookie: string }, body: unknown): Promise<Response> {
    return request(path, auth, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://${address.address}:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function readFirstSseEvent(response: Response): Promise<{ payload: Record<string, unknown> }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected SSE response body');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error('SSE stream ended before an event was received');
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length);
      if (data) return JSON.parse(data) as { payload: Record<string, unknown> };
    }
  }
}
