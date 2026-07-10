import { createServices } from '../../src/app/server.js';
import { EnvironmentServiceError, MAX_ENVIRONMENT_REPOSITORIES } from '../../src/environments/service.js';
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
      revisionId: environment.currentRevisionId,
      revisionNumber: 1,
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

  it('publishes immutable revisions only when executable configuration changes', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Versioned codebase',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
      actor: { type: 'system' },
    });

    const renamed = await services.environments.update({
      id: environment.id,
      name: 'Renamed codebase',
      actor: { type: 'system' },
    });
    expect(renamed.currentRevisionId).toBe(environment.currentRevisionId);
    expect(renamed.currentRevisionNumber).toBe(1);

    const revised = await services.environments.update({
      id: environment.id,
      repositories: [
        { provider: 'github', owner: 'acme', repo: 'api', primary: true },
        { provider: 'github', owner: 'acme', repo: 'web' },
      ],
      actor: { type: 'system' },
    });
    expect(revised.currentRevisionId).not.toBe(environment.currentRevisionId);
    expect(revised.currentRevisionNumber).toBe(2);

    const original = await services.environments.resolveForGroup({
      environmentId: environment.id,
      groupId: defaultGroupId,
      revisionId: environment.currentRevisionId,
    });
    expect(original.codebase.repositories.map((repository) => repository.repo)).toEqual(['api']);
    expect(
      (await services.environments.listRevisions(environment.id)).map((revision) => revision.revisionNumber),
    ).toEqual([2, 1]);
    expect((await services.environments.listActivity(environment.id)).map((activity) => activity.type)).toEqual(
      expect.arrayContaining(['revision_published', 'environment_renamed', 'environment_created']),
    );
  });

  it('rejects concurrent environment edits based on the current revision', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Concurrent codebase',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const first = services.environments.update({
      id: environment.id,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'web', primary: true }],
    });
    const second = services.environments.update({
      id: environment.id,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'worker', primary: true }],
    });

    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: { code: 'environment_update_conflict' } },
    ]);
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

  it('caps environment codebases at ten repositories on create and repository updates', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const repositories = repositoryInputs(MAX_ENVIRONMENT_REPOSITORIES);

    const maximum = await services.environments.create({
      name: 'Maximum codebase',
      ownerGroupId: defaultGroupId,
      repositories,
    });
    expect(maximum.repositories).toHaveLength(MAX_ENVIRONMENT_REPOSITORIES);
    await expect(
      services.environments.create({
        name: 'Oversized codebase',
        ownerGroupId: defaultGroupId,
        repositories: repositoryInputs(MAX_ENVIRONMENT_REPOSITORIES + 1),
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Environment codebase cannot contain more than 10 repositories',
    } satisfies Partial<EnvironmentServiceError>);

    const environment = await services.environments.create({
      name: 'Editable codebase',
      ownerGroupId: defaultGroupId,
      repositories: repositoryInputs(1),
    });
    await expect(
      services.environments.update({
        id: environment.id,
        repositories: repositoryInputs(MAX_ENVIRONMENT_REPOSITORIES + 1),
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Environment codebase cannot contain more than 10 repositories',
    } satisfies Partial<EnvironmentServiceError>);

    const storedEnvironment = await store.getEnvironment(maximum.id);
    const environments = (store as unknown as { environments: Map<string, NonNullable<typeof storedEnvironment>> })
      .environments;
    const firstRepository = storedEnvironment!.repositories[0]!;
    environments.set(maximum.id, {
      ...storedEnvironment!,
      repositories: [
        ...storedEnvironment!.repositories,
        { ...firstRepository, id: 'pre-cap-repository', repo: 'repo-11', position: MAX_ENVIRONMENT_REPOSITORIES },
      ],
    });
    await expect(
      services.environments.update({ id: maximum.id, name: 'Renamed pre-cap codebase' }),
    ).resolves.toMatchObject({ name: 'Renamed pre-cap codebase', repositories: expect.any(Array) });
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

  it('records archive and restore activity only for actual lifecycle transitions', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Idempotent lifecycle codebase',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'app', primary: true }],
    });

    await services.environments.archive(environment.id);
    await services.environments.archive(environment.id);
    await services.environments.unarchive(environment.id);
    await services.environments.unarchive(environment.id);

    const activity = await services.environments.listActivity(environment.id);
    expect(activity.filter((entry) => entry.type === 'environment_archived')).toHaveLength(1);
    expect(activity.filter((entry) => entry.type === 'environment_unarchived')).toHaveLength(1);
    expect(activity.find((entry) => entry.type === 'environment_archived')?.revisionId).toBe(
      environment.currentRevisionId,
    );
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

function repositoryInputs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    provider: 'github' as const,
    owner: 'acme',
    repo: `repo-${index + 1}`,
    primary: index === 0,
  }));
}
