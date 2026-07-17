import { SkillService, SkillServiceError } from '../../src/skills/service.js';
import { MemoryStore } from '../../src/store/memory.js';
import { defaultGroupId } from '../../src/store/types.js';

const now = new Date('2026-07-15T00:00:00.000Z');

describe('SkillService', () => {
  it('normalizes descriptions and validates all managed skill fields', async () => {
    const store = new MemoryStore();
    await createUser(store, 'user-1');
    const service = new SkillService(store);
    const created = await service.create({
      name: 'review-code',
      description: '  Review code carefully  ',
      body: '# Instructions',
      ownerUserId: 'user-1',
    });
    expect(created).toMatchObject({ description: 'Review code carefully', autoLoad: true, enabled: true });

    await expect(
      service.create({ name: 'Review_Code', description: 'valid', body: '', ownerUserId: 'user-1' }),
    ).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(
      service.create({ name: 'valid', description: ' ', body: '', ownerUserId: 'user-1' }),
    ).rejects.toMatchObject({ code: 'invalid_description' });
    await expect(
      service.create({ name: 'valid', description: 'valid', body: 'x'.repeat(64 * 1024 + 1), ownerUserId: 'user-1' }),
    ).rejects.toMatchObject({ code: 'invalid_body' });
  });

  it('rejects mutation of archived skills except restore', async () => {
    const store = new MemoryStore();
    await createUser(store, 'user-1');
    const service = new SkillService(store);
    const skill = await service.create({
      name: 'review-code',
      description: 'Review code',
      body: 'Instructions',
      ownerUserId: 'user-1',
    });
    await service.archive(skill.id);

    await expect(service.update({ id: skill.id, enabled: false })).rejects.toEqual(
      expect.objectContaining<Partial<SkillServiceError>>({ code: 'skill_archived' }),
    );
    await expect(service.promote(skill.id, 'group-1')).rejects.toMatchObject({ code: 'skill_archived' });
    expect(await service.restore(skill.id)).not.toHaveProperty('archivedAt');
  });

  it('publishes only normalized content changes while live flags stay on the parent', async () => {
    const store = new MemoryStore();
    await createUser(store, 'user-1');
    const service = new SkillService(store);
    const created = await service.create({
      name: 'normalized',
      description: 'Description',
      body: 'Line one\r\nLine two',
      ownerUserId: 'user-1',
      createdByUserId: 'user-1',
      actor: { type: 'user', userId: 'user-1' },
    });
    expect(created).toMatchObject({ currentRevisionNumber: 1, body: 'Line one\nLine two' });

    const normalizedNoOp = await service.update({
      id: created.id,
      description: '  Description  ',
      body: 'Line one\r\nLine two',
      actor: { type: 'user', userId: 'user-1' },
    });
    expect(normalizedNoOp).toEqual(created);
    await expect(service.listRevisions(created.id)).resolves.toHaveLength(1);

    const disabled = await service.update({ id: created.id, enabled: false });
    expect(disabled).toMatchObject({ enabled: false, currentRevisionNumber: 1 });
    await expect(service.listRevisions(created.id)).resolves.toHaveLength(1);

    const revised = await service.update({
      id: created.id,
      name: 'normalized-v2',
      body: 'New body',
      actor: { type: 'user', userId: 'user-1' },
    });
    expect(revised).toMatchObject({ name: 'normalized-v2', body: 'New body', currentRevisionNumber: 2 });
    await expect(service.listRevisions(created.id)).resolves.toMatchObject([
      { revisionNumber: 2, name: 'normalized-v2', actorType: 'user', actorUserId: 'user-1' },
      { revisionNumber: 1, name: 'normalized' },
    ]);
  });

  it('rechecks membership and super-admin status when resolving persisted invocations', async () => {
    const store = new MemoryStore();
    const memberId = '00000000-0000-4000-8000-000000000111';
    const adminId = '00000000-0000-4000-8000-000000000112';
    await createUser(store, memberId);
    await createUser(store, adminId, 'super_admin');
    await store.upsertGroupMember({
      groupId: defaultGroupId,
      userId: memberId,
      role: 'member',
      createdAt: now,
      updatedAt: now,
    });
    const service = new SkillService(store);
    const skill = await service.create({
      name: 'pinned-review',
      description: 'Review pinned work',
      body: 'Review carefully',
      ownerGroupId: defaultGroupId,
      autoLoad: false,
    });
    const request = (createdByUserId?: string) => ({
      ownerGroupId: defaultGroupId,
      ...(createdByUserId ? { createdByUserId } : {}),
      invokedNames: [],
      invokedRevisions: [{ skillId: skill.id, revisionId: skill.currentRevisionId }],
    });

    await expect(service.listForRun(request(memberId))).resolves.toHaveLength(1);
    await store.deleteGroupMember({ groupId: defaultGroupId, userId: memberId });
    await expect(service.listForRun(request(memberId))).resolves.toEqual([]);

    await expect(service.listForRun(request(adminId))).resolves.toHaveLength(1);
    await store.updateAuthUserRole({ userId: adminId, role: 'user', updatedAt: new Date(now.getTime() + 1) });
    await expect(service.listForRun(request(adminId))).resolves.toEqual([]);

    await expect(service.listForRun(request())).resolves.toHaveLength(1);
  });
});

async function createUser(store: MemoryStore, username: string, role: 'user' | 'super_admin' = 'user'): Promise<void> {
  await store.upsertAuthUserForAccount({
    userId: username,
    accountId: `${username}-account`,
    provider: 'test',
    providerAccountId: username,
    username,
    role,
    profile: {},
    now,
  });
}
