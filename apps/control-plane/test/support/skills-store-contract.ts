import { describe, expect, it } from 'vitest';
import type { AppStore, CreateSkillRecord } from '../../src/store/types.js';

const baseTime = new Date('2026-07-15T00:00:00.000Z');
const userA = '00000000-0000-4000-8000-000000000101';
const userB = '00000000-0000-4000-8000-000000000102';

export function defineSkillsStoreContract(getStore: () => AppStore): void {
  describe('skills store contract', () => {
    it('keeps tenant and per-owner personal namespaces separate', async () => {
      const store = getStore();
      await seedUsers(store);
      const tenant = await store.createSkill(skill('00000000-0000-4000-8000-000000000301', 'Deploy', 'tenant'));
      const personalA = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000302', 'Deploy', 'personal', userA),
      );
      const personalB = await store.createSkill(
        skill('00000000-0000-4000-8000-000000000303', 'Deploy', 'personal', userB),
      );
      expect(personalA).toMatchObject({ scope: 'personal', ownerUserId: userA, autoLoad: false });
      await expect(store.listSkills({})).resolves.toMatchObject([{ id: tenant.id }]);
      expect((await store.listSkills({ userId: userA })).map((x) => x.id)).toEqual([tenant.id, personalA.id]);
      expect((await store.listSkills({ userId: userB })).map((x) => x.id)).toEqual([tenant.id, personalB.id]);
      await expect(
        store.createSkill(skill('00000000-0000-4000-8000-000000000304', 'dEpLoY', 'tenant')),
      ).rejects.toMatchObject({ code: 'skill_name_exists' });
      await expect(
        store.createSkill(skill('00000000-0000-4000-8000-000000000305', 'dEpLoY', 'personal', userA)),
      ).rejects.toMatchObject({ code: 'skill_name_exists' });
    });

    it('returns tenant plus caller personal candidates and excludes personal auto-load', async () => {
      const store = getStore();
      await seedUsers(store);
      const tenant = await store.createSkill(skill('00000000-0000-4000-8000-000000000321', 'automatic', 'tenant'));
      const personal = await store.createSkill({
        ...skill('00000000-0000-4000-8000-000000000322', 'manual', 'personal', userA),
        autoLoad: true,
      });
      await store.createSkill(skill('00000000-0000-4000-8000-000000000323', 'other', 'personal', userB));
      expect((await store.listSkillInvocationCandidates({ userId: userA })).map((x) => x.id)).toEqual([
        tenant.id,
        personal.id,
      ]);
      expect((await store.listSkillInvocationCandidates({})).map((x) => x.id)).toEqual([tenant.id]);
      expect((await store.listSkillsForRun({ userId: userA })).map((x) => x.id)).toEqual([tenant.id]);
      expect(
        (await store.listSkillsForRun({ userId: userA, invokedNames: ['manual', 'other'] })).map((x) => x.id),
      ).toEqual([tenant.id, personal.id]);
      await expect(
        store.listSkillsForRun({
          userId: userB,
          invokedRevisions: [{ skillId: personal.id, revisionId: personal.currentRevisionId }],
        }),
      ).resolves.toHaveLength(1);
      expect(
        (
          await store.listSkillsForRun({
            userId: userA,
            invokedRevisions: [{ skillId: personal.id, revisionId: personal.currentRevisionId }],
          })
        ).some((x) => x.id === personal.id),
      ).toBe(true);
    });

    it('allows archived personal duplicates but restore conflicts normally', async () => {
      const store = getStore();
      await seedUsers(store);
      const old = await store.createSkill(skill('00000000-0000-4000-8000-000000000331', 'legacy', 'personal', userA));
      await store.archiveSkill({ skillId: old.id, archivedAt: at(1) });
      await store.createSkill(skill('00000000-0000-4000-8000-000000000332', 'LEGACY', 'personal', userA));
      await expect(store.restoreSkill({ skillId: old.id, updatedAt: at(2) })).rejects.toMatchObject({
        code: 'skill_name_exists',
      });
    });
  });
}

function skill(id: string, name: string, scope: 'tenant' | 'personal', ownerUserId?: string): CreateSkillRecord {
  return {
    id,
    scope,
    ...(scope === 'personal' ? { ownerUserId: ownerUserId! } : {}),
    revision: {
      id,
      name,
      description: `${name} description`,
      body: `# ${name}`,
      actorType: 'user',
      actorUserId: userA,
      createdAt: baseTime,
    },
    createdByUserId: userA,
    createdAt: baseTime,
    updatedAt: baseTime,
  } as CreateSkillRecord;
}
async function seedUsers(store: AppStore) {
  for (const id of [userA, userB])
    if (!(await store.getAuthUser(id)))
      await store.upsertAuthUserForAccount({
        userId: id,
        accountId: id,
        provider: 'skills-contract',
        providerAccountId: id,
        username: id,
        role: 'member',
        profile: {},
        now: baseTime,
      });
}
function at(minutes: number) {
  return new Date(baseTime.getTime() + minutes * 60_000);
}
