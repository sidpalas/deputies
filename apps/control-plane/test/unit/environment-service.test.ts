import { createServices } from '../../src/app/server.js';
import { EnvironmentServiceError } from '../../src/environments/service.js';
import { MemoryStore } from '../../src/store/memory.js';
import { defaultGroupId, type GroupRecord } from '../../src/store/types.js';

describe('environment service', () => {
  it('resolves selected-group environment snapshots with branch overrides', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const sharedGroup = await store.createGroup(groupRecord('00000000-0000-4000-8000-000000001001', 'Shared'));
    const unsharedGroup = await store.createGroup(groupRecord('00000000-0000-4000-8000-000000001002', 'Unshared'));
    const environment = await services.environments.create({
      name: 'Product surface',
      ownerGroupId: defaultGroupId,
      shareMode: 'selected_groups',
      sharedGroupIds: [sharedGroup.id],
      repositories: [
        { provider: 'github', owner: 'acme', repo: 'api', branch: 'main', primary: true },
        { provider: 'github', owner: 'acme', repo: 'web', primary: false },
      ],
    });

    const snapshot = await services.environments.resolveForGroup({
      environmentId: environment.id,
      groupId: sharedGroup.id,
      branchOverrides: [{ provider: 'github', owner: 'acme', repo: 'web', branch: 'release' }],
    });

    expect(snapshot).toEqual({
      id: environment.id,
      name: 'Product surface',
      ownerGroupId: defaultGroupId,
      codebase: {
        repositories: [
          { provider: 'github', owner: 'acme', repo: 'api', branch: 'main', primary: true },
          { provider: 'github', owner: 'acme', repo: 'web', branch: 'release', primary: false },
        ],
      },
    });
    await expect(
      services.environments.resolveForGroup({ environmentId: environment.id, groupId: unsharedGroup.id }),
    ).rejects.toMatchObject({ code: 'not_found' } satisfies Partial<EnvironmentServiceError>);
  });

  it('blocks archiving an environment while active automations reference it', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Automation target',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'ops', primary: true }],
    });
    const automation = await services.automations.createScheduled({
      name: 'Daily environment run',
      prompt: 'Check the environment',
      scheduleCron: '0 9 * * *',
      ownerGroupId: defaultGroupId,
      visibility: 'organization',
      writePolicy: 'group_members',
      environmentId: environment.id,
    });

    await expect(services.environments.archive(environment.id)).rejects.toMatchObject({
      code: 'automation_conflict',
      details: { automations: [{ id: automation.id, name: automation.name, ownerGroupId: defaultGroupId }] },
    } satisfies Partial<EnvironmentServiceError>);

    await services.automations.archive(automation.id);
    await expect(services.environments.archive(environment.id)).resolves.toMatchObject({
      id: environment.id,
      archivedAt: expect.any(Date),
    });
  });

  it('blocks removing repositories referenced by active automation branch overrides', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Automation target',
      ownerGroupId: defaultGroupId,
      repositories: [
        { provider: 'github', owner: 'acme', repo: 'api', primary: true },
        { provider: 'github', owner: 'acme', repo: 'web', primary: false },
      ],
    });
    const automation = await services.automations.createScheduled({
      name: 'Daily environment run',
      prompt: 'Check the environment',
      scheduleCron: '0 9 * * *',
      ownerGroupId: defaultGroupId,
      visibility: 'organization',
      writePolicy: 'group_members',
      environmentId: environment.id,
      context: {
        environmentBranchOverrides: [{ provider: 'github', owner: 'acme', repo: 'web', branch: 'release' }],
      },
    });

    await expect(
      services.environments.update({
        id: environment.id,
        repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
      }),
    ).rejects.toMatchObject({
      code: 'automation_conflict',
      details: { automations: [{ id: automation.id, name: automation.name, ownerGroupId: defaultGroupId }] },
    } satisfies Partial<EnvironmentServiceError>);
  });

  it('validates GitHub repository owner and repo names', async () => {
    const store = new MemoryStore();
    const services = createServices(store);

    await expect(
      services.environments.create({
        name: 'Invalid repo',
        ownerGroupId: defaultGroupId,
        repositories: [{ provider: 'github', owner: '-acme', repo: 'api.git', primary: true }],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Expected valid GitHub repository owner and name',
    } satisfies Partial<EnvironmentServiceError>);
  });

  it('restores archived environments', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Restorable codebase',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'app', primary: true }],
    });

    await services.environments.archive(environment.id);
    await expect(
      services.environments.resolveForGroup({ environmentId: environment.id, groupId: defaultGroupId }),
    ).rejects.toMatchObject({ code: 'archived' } satisfies Partial<EnvironmentServiceError>);

    const restored = await services.environments.unarchive(environment.id);

    expect(restored.id).toBe(environment.id);
    expect(restored.archivedAt).toBeUndefined();
    await expect(
      services.environments.resolveForGroup({ environmentId: environment.id, groupId: defaultGroupId }),
    ).resolves.toMatchObject({ id: environment.id, name: 'Restorable codebase' });
  });
});

function groupRecord(id: string, name: string): GroupRecord {
  const now = new Date();
  return {
    id,
    name,
    defaultVisibility: 'group',
    defaultWritePolicy: 'group_members',
    automationCreateRequiredRole: 'member',
    createdAt: now,
    updatedAt: now,
  };
}
