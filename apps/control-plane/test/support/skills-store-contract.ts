import { describe, expect, it } from 'vitest';
import type { AppStore, CreateSkillRecord, GroupRecord } from '../../src/store/types.js';

const baseTime = new Date('2026-07-15T00:00:00.000Z');
const userA = '00000000-0000-4000-8000-000000000101';
const userB = '00000000-0000-4000-8000-000000000102';
const ownerGroup = '00000000-0000-4000-8000-000000000201';
const targetGroup = '00000000-0000-4000-8000-000000000202';
const otherTargetGroup = '00000000-0000-4000-8000-000000000203';
const archivedOwnerGroup = '00000000-0000-4000-8000-000000000204';

export function defineSkillsStoreContract(getStore: () => AppStore): void {
  describe('skills store contract', () => {
    it('supports CRUD and case-insensitive uniqueness within each owner scope', async () => {
      const store = getStore();
      await seed(store);
      const personal = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000301', 'Deploy', {
          ownerKind: 'user',
          ownerUserId: userA,
        }),
      );
      const group = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000302', 'DEPLOY', {
          ownerKind: 'group',
          ownerGroupId: ownerGroup,
        }),
      );
      await store.createSkill(
        skill('00000000-0000-4000-8000-000000000303', 'deploy', {
          ownerKind: 'user',
          ownerUserId: userB,
        }),
      );
      await store.createSkill(
        skill('00000000-0000-4000-8000-000000000304', 'deploy', {
          ownerKind: 'group',
          ownerGroupId: targetGroup,
        }),
      );

      await expect(
        store.createSkill(
          skill('00000000-0000-4000-8000-000000000305', 'dEpLoY', {
            ownerKind: 'user',
            ownerUserId: userA,
          }),
        ),
      ).rejects.toMatchObject({ code: 'skill_name_exists' });
      await expect(
        store.createSkill(
          skill('00000000-0000-4000-8000-000000000306', 'deploy', {
            ownerKind: 'group',
            ownerGroupId: ownerGroup,
          }),
        ),
      ).rejects.toMatchObject({ code: 'skill_name_exists' });

      const updated = await store.updateSkill({
        id: personal.id,
        expectedCurrentRevisionId: personal.currentRevisionId,
        revision: revision(
          '00000000-0000-4000-8000-000000000501',
          personal,
          2,
          personal.name,
          'Updated description',
          'Updated body',
        ),
        autoLoad: false,
        enabled: false,
        updatedAt: at(1),
      });
      expect(updated).toMatchObject({
        name: 'Deploy',
        description: 'Updated description',
        body: 'Updated body',
        autoLoad: false,
        enabled: false,
      });
      await expect(store.getSkill(personal.id)).resolves.toEqual(updated);
      await expect(store.listSkillsForUser(userA)).resolves.toMatchObject([{ id: personal.id }]);
      expect((await store.listSkillsForGroups([ownerGroup])).map(({ id }) => id)).toEqual([group.id]);
      await expect(
        store.updateSkill({
          id: personal.id,
          expectedCurrentRevisionId: updated.currentRevisionId,
          revision: revision(
            '00000000-0000-4000-8000-000000000502',
            updated,
            3,
            'DEPLOY',
            updated.description,
            updated.body,
          ),
          updatedAt: at(2),
        }),
      ).resolves.toMatchObject({
        id: personal.id,
        name: 'DEPLOY',
      });
      const otherGroupSkill = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000307', 'other', {
          ownerKind: 'group',
          ownerGroupId: ownerGroup,
        }),
      );
      await expect(
        store.updateSkill({
          id: otherGroupSkill.id,
          expectedCurrentRevisionId: otherGroupSkill.currentRevisionId,
          revision: revision(
            '00000000-0000-4000-8000-000000000503',
            otherGroupSkill,
            2,
            'deploy',
            otherGroupSkill.description,
            otherGroupSkill.body,
          ),
          updatedAt: at(3),
        }),
      ).rejects.toMatchObject({ code: 'skill_name_exists' });
      await expect(store.getSkill(otherGroupSkill.id)).resolves.toMatchObject({ name: 'other' });
    });

    it('archives and restores skills while preserving the owner name reservation', async () => {
      const store = getStore();
      await seed(store);
      const created = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000311', 'archivable', {
          ownerKind: 'user',
          ownerUserId: userA,
        }),
      );

      const archived = await store.archiveSkill({ skillId: created.id, archivedAt: at(1) });
      expect(archived).toMatchObject({ id: created.id, archivedAt: at(1), updatedAt: at(1) });
      await expect(
        store.createSkill(
          skill('00000000-0000-4000-8000-000000000312', 'ARCHIVABLE', {
            ownerKind: 'user',
            ownerUserId: userA,
          }),
        ),
      ).rejects.toMatchObject({ code: 'skill_name_exists' });
      await expect(
        store.listSkillsForRun({ ownerGroupId: targetGroup, createdByUserId: userA, invokedNames: ['archivable'] }),
      ).resolves.toEqual([]);

      const restored = await store.restoreSkill({ skillId: created.id, updatedAt: at(2) });
      expect(restored).toMatchObject({ id: created.id, updatedAt: at(2) });
      expect(restored).not.toHaveProperty('archivedAt');
      await expect(
        store.archiveSkill({ skillId: '00000000-0000-4000-8000-000000000399', archivedAt: at(3) }),
      ).resolves.toBeNull();
      await expect(
        store.restoreSkill({ skillId: '00000000-0000-4000-8000-000000000399', updatedAt: at(3) }),
      ).resolves.toBeNull();
    });

    it('publishes immutable revisions, rejects stale publication, and resolves pins through live access', async () => {
      const store = getStore();
      await seed(store);
      const created = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000318', 'revisioned', {
          ownerKind: 'group',
          ownerGroupId: ownerGroup,
          autoLoad: false,
        }),
      );
      expect(created).toMatchObject({ currentRevisionId: created.id, currentRevisionNumber: 1 });
      await expect(store.listSkillRevisions(created.id)).resolves.toMatchObject([
        { id: created.currentRevisionId, skillId: created.id, revisionNumber: 1, name: 'revisioned' },
      ]);

      const secondRevision = revision(
        '00000000-0000-4000-8000-000000000506',
        created,
        2,
        created.name,
        'Second description',
        'Second body',
      );
      const revised = await store.updateSkill({
        id: created.id,
        expectedCurrentRevisionId: created.currentRevisionId,
        revision: secondRevision,
        updatedAt: at(2),
      });
      expect(revised).toMatchObject({
        currentRevisionId: secondRevision.id,
        currentRevisionNumber: 2,
        description: 'Second description',
      });
      await expect(store.listSkillRevisions(created.id)).resolves.toMatchObject([
        { id: secondRevision.id, revisionNumber: 2 },
        { id: created.currentRevisionId, revisionNumber: 1 },
      ]);

      await expect(
        store.updateSkill({
          id: created.id,
          expectedCurrentRevisionId: created.currentRevisionId,
          revision: revision(
            '00000000-0000-4000-8000-000000000507',
            created,
            2,
            created.name,
            'Racing description',
            'Racing body',
          ),
          updatedAt: at(3),
        }),
      ).rejects.toMatchObject({ code: 'skill_update_conflict' });

      await store.setSkillShares(created.id, 'specific', [targetGroup], at(3));
      await expect(store.listSkillRevisions(created.id)).resolves.toHaveLength(2);
      const pinned = await store.listSkillsForRun({
        ownerGroupId: targetGroup,
        invokedRevisions: [
          { skillId: created.id, revisionId: created.currentRevisionId },
          { skillId: created.id, revisionId: secondRevision.id },
        ],
      });
      expect(pinned.map(({ resolvedRevisionId, body }) => [resolvedRevisionId, body])).toEqual([
        [created.currentRevisionId, created.body],
        [secondRevision.id, secondRevision.body],
      ]);

      await store.updateSkill({
        id: created.id,
        expectedCurrentRevisionId: revised.currentRevisionId,
        enabled: false,
        updatedAt: at(4),
      });
      await expect(
        store.listSkillsForRun({
          ownerGroupId: targetGroup,
          invokedRevisions: [{ skillId: created.id, revisionId: created.currentRevisionId }],
        }),
      ).resolves.toEqual([]);
      await expect(store.listSkillRevisions(created.id)).resolves.toHaveLength(2);
    });

    it('assigns revision identity atomically under concurrent publication', async () => {
      const store = getStore();
      await seed(store);
      const created = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000319', 'atomic-revision', {
          ownerKind: 'group',
          ownerGroupId: ownerGroup,
        }),
      );
      const publish = (id: string, body: string) =>
        store.updateSkill({
          id: created.id,
          expectedCurrentRevisionId: created.currentRevisionId,
          revision: {
            id,
            name: created.name,
            description: created.description,
            body,
            actorType: 'user',
            actorUserId: userA,
            createdAt: at(2),
          },
          updatedAt: at(2),
        });

      const results = await Promise.allSettled([
        publish('00000000-0000-4000-8000-000000000508', 'First contender'),
        publish('00000000-0000-4000-8000-000000000509', 'Second contender'),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'skill_update_conflict' },
      });
      await expect(store.listSkillRevisions(created.id)).resolves.toMatchObject([
        { revisionNumber: 2 },
        { revisionNumber: 1 },
      ]);
    });

    it('rejects writes involving archived skills or groups', async () => {
      const store = getStore();
      await seed(store);
      await expect(
        store.createSkill(
          skill('00000000-0000-4000-8000-000000000313', 'archived-owner-create', {
            ownerKind: 'group',
            ownerGroupId: archivedOwnerGroup,
          }),
        ),
      ).rejects.toMatchObject({ code: 'archived_group' });

      const archivedSkill = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000314', 'archived-write', {
          ownerKind: 'user',
          ownerUserId: userA,
        }),
      );
      await store.archiveSkill({ skillId: archivedSkill.id, archivedAt: at(1) });
      await expect(
        store.updateSkill({
          id: archivedSkill.id,
          expectedCurrentRevisionId: archivedSkill.currentRevisionId,
          revision: revision(
            '00000000-0000-4000-8000-000000000504',
            archivedSkill,
            2,
            archivedSkill.name,
            'No',
            archivedSkill.body,
          ),
          updatedAt: at(2),
        }),
      ).rejects.toMatchObject({ code: 'skill_archived' });
      await expect(store.promoteSkill(archivedSkill.id, ownerGroup, at(2))).rejects.toMatchObject({
        code: 'skill_archived',
      });

      const personal = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000315', 'archived-promote-target', {
          ownerKind: 'user',
          ownerUserId: userA,
        }),
      );
      await expect(store.promoteSkill(personal.id, archivedOwnerGroup, at(2))).rejects.toMatchObject({
        code: 'archived_group',
      });

      const groupSkill = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000316', 'archived-share-target', {
          ownerKind: 'group',
          ownerGroupId: ownerGroup,
        }),
      );
      await expect(store.setSkillShares(groupSkill.id, 'specific', [archivedOwnerGroup], at(2))).rejects.toMatchObject({
        code: 'archived_group',
      });

      const group = (await store.getGroup(ownerGroup))!;
      await store.updateGroup({ ...group, archivedAt: at(3), updatedAt: at(3) });
      await expect(
        store.updateSkill({
          id: groupSkill.id,
          expectedCurrentRevisionId: groupSkill.currentRevisionId,
          revision: revision(
            '00000000-0000-4000-8000-000000000505',
            groupSkill,
            2,
            groupSkill.name,
            groupSkill.description,
            'No',
          ),
          updatedAt: at(4),
        }),
      ).rejects.toMatchObject({
        code: 'archived_group',
      });
      await expect(store.setSkillShares(groupSkill.id, 'all_groups', [], at(4))).rejects.toMatchObject({
        code: 'archived_group',
      });
      await store.archiveSkill({ skillId: groupSkill.id, archivedAt: at(4) });
      await expect(store.restoreSkill({ skillId: groupSkill.id, updatedAt: at(5) })).rejects.toMatchObject({
        code: 'archived_group',
      });
      const { archivedAt: _ownerArchivedAt, ...restoredGroup } = (await store.getGroup(ownerGroup))!;
      await store.updateGroup({ ...restoredGroup, updatedAt: at(5) });
      await expect(store.restoreSkill({ skillId: groupSkill.id, updatedAt: at(6) })).resolves.not.toHaveProperty(
        'archivedAt',
      );
    });

    it('retains archived existing share targets without allowing new archived targets', async () => {
      const store = getStore();
      await seed(store);
      const groupSkill = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000317', 'retain-archived-share', {
          ownerKind: 'group',
          ownerGroupId: ownerGroup,
        }),
      );
      await store.setSkillShares(groupSkill.id, 'specific', [targetGroup], at(1));
      const target = (await store.getGroup(targetGroup))!;
      await store.updateGroup({ ...target, archivedAt: at(2), updatedAt: at(2) });

      await expect(store.setSkillShares(groupSkill.id, 'specific', [targetGroup], at(3))).resolves.toMatchObject({
        shareGroupIds: [targetGroup],
      });
      await expect(
        store.setSkillShares(groupSkill.id, 'specific', [targetGroup, archivedOwnerGroup], at(4)),
      ).rejects.toMatchObject({ code: 'archived_group' });
      const { archivedAt: _targetArchivedAt, ...restoredTarget } = (await store.getGroup(targetGroup))!;
      await store.updateGroup({ ...restoredTarget, updatedAt: at(5) });
    });

    it('promotes personal skills atomically and rejects target-scope collisions', async () => {
      const store = getStore();
      await seed(store);
      const personal = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000321', 'promote-me', {
          ownerKind: 'user',
          ownerUserId: userA,
        }),
      );
      const promoted = await store.promoteSkill(personal.id, ownerGroup, at(1));
      expect(promoted).toMatchObject({
        id: personal.id,
        ownerKind: 'group',
        ownerGroupId: ownerGroup,
        shareMode: 'none',
        shareGroupIds: [],
      });
      expect(promoted).not.toHaveProperty('ownerUserId');
      await expect(store.promoteSkill(personal.id, targetGroup, at(2))).resolves.toBeNull();

      await store.createSkill(
        skill('00000000-0000-4000-8000-000000000322', 'collision', {
          ownerKind: 'group',
          ownerGroupId: targetGroup,
        }),
      );
      const collidingPersonal = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000323', 'COLLISION', {
          ownerKind: 'user',
          ownerUserId: userA,
        }),
      );
      await expect(store.promoteSkill(collidingPersonal.id, targetGroup, at(3))).rejects.toMatchObject({
        code: 'skill_name_exists',
      });
      await expect(store.getSkill(collidingPersonal.id)).resolves.toMatchObject({
        ownerKind: 'user',
        ownerUserId: userA,
      });

      const racing = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000324', 'race', {
          ownerKind: 'user',
          ownerUserId: userA,
        }),
      );
      const raceResults = await Promise.all([
        store.promoteSkill(racing.id, ownerGroup, at(4)),
        store.promoteSkill(racing.id, otherTargetGroup, at(4)),
      ]);
      expect(raceResults.filter(Boolean)).toHaveLength(1);
      expect([ownerGroup, otherTargetGroup]).toContain((await store.getSkill(racing.id))?.ownerGroupId);
    });

    it('replaces specific shares, retains them across mode flips, and updates reverse lookups', async () => {
      const store = getStore();
      await seed(store);
      const groupSkill = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000331', 'shared-skill', {
          ownerKind: 'group',
          ownerGroupId: ownerGroup,
        }),
      );
      const personal = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000332', 'personal-only', {
          ownerKind: 'user',
          ownerUserId: userA,
        }),
      );

      await expect(store.setSkillShares(personal.id, 'all_groups', [], at(1))).resolves.toBeNull();
      await expect(
        store.setSkillShares(groupSkill.id, 'specific', [targetGroup, otherTargetGroup, targetGroup], at(1)),
      ).resolves.toMatchObject({ shareMode: 'specific', shareGroupIds: [targetGroup, otherTargetGroup] });
      expect((await store.listSkillsSharedIntoGroups([targetGroup])).map(({ id }) => id)).toEqual([groupSkill.id]);

      await expect(store.setSkillShares(groupSkill.id, 'specific', [otherTargetGroup], at(2))).resolves.toMatchObject({
        shareGroupIds: [otherTargetGroup],
      });
      await expect(store.listSkillsSharedIntoGroups([targetGroup])).resolves.toEqual([]);
      expect((await store.listSkillsSharedIntoGroups([otherTargetGroup])).map(({ id }) => id)).toEqual([groupSkill.id]);

      await expect(store.setSkillShares(groupSkill.id, 'none', [], at(3))).resolves.toMatchObject({
        shareMode: 'none',
        shareGroupIds: [otherTargetGroup],
      });
      await expect(store.listSkillsSharedIntoGroups([otherTargetGroup])).resolves.toEqual([]);
      await expect(store.setSkillShares(groupSkill.id, 'all_groups', [], at(4))).resolves.toMatchObject({
        shareMode: 'all_groups',
        shareGroupIds: [otherTargetGroup],
      });
      expect((await store.listSkillsSharedIntoGroups([targetGroup])).map(({ id }) => id)).toEqual([groupSkill.id]);
      expect((await store.listSkillsForGroups([ownerGroup])).map(({ id }) => id)).toEqual([groupSkill.id]);
      await expect(store.listSkillsForGroups([])).resolves.toEqual([]);
      await expect(store.listSkillsSharedIntoGroups([])).resolves.toEqual([]);
    });

    it('resolves eligible run candidates with invocation and archived-owner filtering', async () => {
      const store = getStore();
      await seed(store);
      await createRunMatrix(store);

      const automatic = await store.listSkillsForRun({ ownerGroupId: targetGroup, createdByUserId: userA });
      expect(candidateKeys(automatic)).toEqual([
        'all-groups:shared',
        'own-auto:group',
        'personal-auto:personal',
        'specific-share:shared',
      ]);

      const invoked = await store.listSkillsForRun({
        ownerGroupId: targetGroup,
        createdByUserId: userA,
        invokedNames: ['own-manual', 'personal-manual', 'shared-manual', 'archived-skill', 'disabled-skill'],
      });
      expect(candidateKeys(invoked)).toEqual([
        'all-groups:shared',
        'own-auto:group',
        'own-manual:group',
        'personal-auto:personal',
        'personal-manual:personal',
        'shared-manual:shared',
        'specific-share:shared',
      ]);

      const automation = await store.listSkillsForRun({
        ownerGroupId: targetGroup,
        invokedNames: ['personal-manual', 'own-manual'],
      });
      expect(candidateKeys(automation)).toEqual([
        'all-groups:shared',
        'own-auto:group',
        'own-manual:group',
        'specific-share:shared',
      ]);

      const candidates = await store.listSkillInvocationCandidates({ ownerGroupId: targetGroup, userId: userA });
      expect(candidateKeys(candidates)).toEqual([
        'all-groups:shared',
        'own-auto:group',
        'own-manual:group',
        'personal-auto:personal',
        'personal-manual:personal',
        'shared-manual:shared',
        'specific-share:shared',
      ]);
    });
  });
}

async function createRunMatrix(store: AppStore): Promise<void> {
  const archivedGroup = (await store.getGroup(archivedOwnerGroup))!;
  const { archivedAt: _archivedAt, ...activeArchivedGroup } = archivedGroup;
  await store.updateGroup({ ...activeArchivedGroup, updatedAt: at(1) });
  const records: CreateSkillRecord[] = [
    skill('00000000-0000-4000-8000-000000000401', 'personal-auto', { ownerKind: 'user', ownerUserId: userA }),
    skill('00000000-0000-4000-8000-000000000402', 'personal-manual', {
      ownerKind: 'user',
      ownerUserId: userA,
      autoLoad: false,
    }),
    skill('00000000-0000-4000-8000-000000000403', 'other-personal', { ownerKind: 'user', ownerUserId: userB }),
    skill('00000000-0000-4000-8000-000000000404', 'own-auto', { ownerKind: 'group', ownerGroupId: targetGroup }),
    skill('00000000-0000-4000-8000-000000000405', 'own-manual', {
      ownerKind: 'group',
      ownerGroupId: targetGroup,
      autoLoad: false,
    }),
    skill('00000000-0000-4000-8000-000000000406', 'specific-share', {
      ownerKind: 'group',
      ownerGroupId: ownerGroup,
    }),
    skill('00000000-0000-4000-8000-000000000407', 'none-share', {
      ownerKind: 'group',
      ownerGroupId: ownerGroup,
    }),
    skill('00000000-0000-4000-8000-000000000408', 'all-groups', {
      ownerKind: 'group',
      ownerGroupId: otherTargetGroup,
    }),
    skill('00000000-0000-4000-8000-000000000409', 'shared-manual', {
      ownerKind: 'group',
      ownerGroupId: ownerGroup,
      autoLoad: false,
    }),
    skill('00000000-0000-4000-8000-000000000410', 'archived-skill', {
      ownerKind: 'group',
      ownerGroupId: targetGroup,
    }),
    skill('00000000-0000-4000-8000-000000000411', 'disabled-skill', {
      ownerKind: 'group',
      ownerGroupId: targetGroup,
      enabled: false,
    }),
    skill('00000000-0000-4000-8000-000000000412', 'archived-owner', {
      ownerKind: 'group',
      ownerGroupId: archivedOwnerGroup,
    }),
  ];
  for (const record of records) await store.createSkill(record);
  await store.updateGroup({ ...archivedGroup, archivedAt: at(2), updatedAt: at(2) });
  await store.setSkillShares(records[5]!.id, 'specific', [targetGroup], at(1));
  await store.setSkillShares(records[6]!.id, 'specific', [targetGroup], at(1));
  await store.setSkillShares(records[6]!.id, 'none', [], at(2));
  await store.setSkillShares(records[7]!.id, 'all_groups', [], at(1));
  await store.setSkillShares(records[8]!.id, 'specific', [targetGroup], at(1));
  await store.archiveSkill({ skillId: records[9]!.id, archivedAt: at(1) });
}

function candidateKeys(candidates: Awaited<ReturnType<AppStore['listSkillsForRun']>>): string[] {
  return candidates.map(({ name, source }) => `${name}:${source}`).sort();
}

async function seed(store: AppStore): Promise<void> {
  for (const [id, name, archived] of [
    [ownerGroup, 'Skill owner', false],
    [targetGroup, 'Skill target', false],
    [otherTargetGroup, 'Other skill target', false],
    [archivedOwnerGroup, 'Archived skill owner', true],
  ] as const) {
    if (!(await store.getGroup(id))) await store.createGroup(group(id, name, archived));
  }
  await createUser(store, userA, 'skill-user-a');
  await createUser(store, userB, 'skill-user-b');
}

async function createUser(store: AppStore, id: string, username: string): Promise<void> {
  await store.upsertAuthUserForAccount({
    userId: id,
    accountId: id.replace(/1$/, '9').replace(/2$/, '8'),
    provider: 'skills-contract',
    providerAccountId: username,
    username,
    role: 'user',
    profile: {},
    now: baseTime,
  });
}

function group(id: string, name: string, archived: boolean): GroupRecord {
  return {
    id,
    name,
    defaultVisibility: 'group',
    defaultWritePolicy: 'group_members',
    automationCreateRequiredRole: 'member',
    ...(archived ? { archivedAt: at(1) } : {}),
    createdAt: baseTime,
    updatedAt: archived ? at(1) : baseTime,
  };
}

function skill(
  id: string,
  name: string,
  owner: ({ ownerKind: 'group'; ownerGroupId: string } | { ownerKind: 'user'; ownerUserId: string }) &
    Partial<Pick<CreateSkillRecord, 'autoLoad' | 'enabled'>>,
): CreateSkillRecord {
  const record = {
    id,
    revision: {
      id,
      name,
      description: `${name} description`,
      body: `# ${name}`,
      actorType: 'user' as const,
      actorUserId: userA,
      createdAt: baseTime,
    },
    autoLoad: owner.autoLoad ?? true,
    enabled: owner.enabled ?? true,
    createdByUserId: userA,
    createdAt: baseTime,
    updatedAt: baseTime,
  };
  return owner.ownerKind === 'group'
    ? { ...record, ownerKind: owner.ownerKind, ownerGroupId: owner.ownerGroupId }
    : { ...record, ownerKind: owner.ownerKind, ownerUserId: owner.ownerUserId };
}

function revision(
  id: string,
  skill: { id: string },
  revisionNumber: number,
  name: string,
  description: string,
  body: string,
) {
  return {
    id,
    name,
    description,
    body,
    actorType: 'user' as const,
    actorUserId: userA,
    createdAt: at(revisionNumber),
  };
}

function at(minutes: number): Date {
  return new Date(baseTime.getTime() + minutes * 60_000);
}
