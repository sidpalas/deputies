import { createServices } from '../../src/app/server.js';
import { executeEnvironmentTool, validateEnvironmentContext } from '../../src/environments/tool.js';
import { MemoryStore } from '../../src/store/memory.js';
import { defaultGroupId, type GroupRecord } from '../../src/store/types.js';
import type { RepositoryToolServices } from '../../src/repositories/tool.js';

describe('environment tool', () => {
  it('automatically selects one matching environment and prepares its primary repository', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
      ownerGroupId: defaultGroupId,
      repositories: [
        { provider: 'github', owner: 'acme', repo: 'api', primary: true },
        { provider: 'github', owner: 'acme', repo: 'web', primary: false },
      ],
    });
    const updates: Record<string, unknown>[] = [];
    const repository = repositoryServices({
      context: { repository: { provider: 'github', owner: 'acme', repo: 'api' }, branch: 'main' },
      updateSessionContext: async (context) => {
        updates.push(context);
        return context;
      },
    });

    const result = await executeEnvironmentTool(
      { environments: services.environments, ownerGroupId: defaultGroupId, repository },
      { action: 'auto' },
    );

    expect(result).toContain(`Automatically selected environment ${environment.name} (revision 1)`);
    expect(result).toContain('Repository prepared: acme/api');
    expect(updates[0]).toMatchObject({ environment: { id: environment.id, revisionNumber: 1 } });
    expect(updates[0]).toMatchObject({ repository: undefined, branch: undefined });
    expect(repository.state.prepared).toMatchObject({ repository: { owner: 'acme', repo: 'api' } });
  });

  it('does not guess when multiple accessible environments contain the direct repository', async () => {
    const services = createServices(new MemoryStore());
    for (const name of ['Product surface', 'Operations surface']) {
      await services.environments.create({
        name,
        ownerGroupId: defaultGroupId,
        repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
      });
    }
    const repository = repositoryServices({
      context: { repository: { provider: 'github', owner: 'acme', repo: 'api' } },
    });

    await expect(
      executeEnvironmentTool(
        { environments: services.environments, ownerGroupId: defaultGroupId, repository },
        { action: 'auto' },
      ),
    ).resolves.toContain('Multiple available environments contain acme/api');
    expect(repository.state.context).toEqual({ repository: { provider: 'github', owner: 'acme', repo: 'api' } });
  });

  it('continues from a saved snapshot after the environment is archived', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const snapshot = await services.environments.resolveForGroup({
      environmentId: environment.id,
      groupId: defaultGroupId,
    });
    await services.environments.archive(environment.id);

    await expect(
      validateEnvironmentContext(services.environments, defaultGroupId, { environment: snapshot }),
    ).resolves.toBe(
      `Note: environment "Product surface" (revision 1) is no longer available (it has been archived). Continuing with this session's saved environment snapshot.`,
    );
  });

  it('warns when an environment is no longer shared with the session group', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const sharedGroup = await store.createGroup(groupRecord('00000000-0000-4000-8000-000000001101', 'Shared'));
    const environment = await services.environments.create({
      name: 'Product surface',
      ownerGroupId: defaultGroupId,
      shareMode: 'all_groups',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const snapshot = await services.environments.resolveForGroup({
      environmentId: environment.id,
      groupId: sharedGroup.id,
    });
    await services.environments.update({ id: environment.id, shareMode: 'private' });

    await expect(
      validateEnvironmentContext(services.environments, sharedGroup.id, { environment: snapshot }),
    ).resolves.toContain('this group no longer has access');
  });

  it('warns when the session owner group is archived', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Product surface',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const snapshot = await services.environments.resolveForGroup({
      environmentId: environment.id,
      groupId: defaultGroupId,
    });
    const ownerGroup = await store.getGroup(defaultGroupId);
    await store.updateGroup({ ...ownerGroup!, archivedAt: new Date(), updatedAt: new Date() });

    await expect(
      validateEnvironmentContext(services.environments, defaultGroupId, { environment: snapshot }),
    ).resolves.toContain('session owner group is archived');
  });

  it('returns null for a still-available environment and rejects malformed snapshots', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const snapshot = await services.environments.resolveForGroup({
      environmentId: environment.id,
      groupId: defaultGroupId,
    });

    await expect(
      validateEnvironmentContext(services.environments, defaultGroupId, { environment: snapshot }),
    ).resolves.toBeNull();
    await expect(
      validateEnvironmentContext(services.environments, defaultGroupId, { environment: { id: environment.id } }),
    ).rejects.toThrow('Invalid environment session context');
  });

  it('rethrows unexpected live-environment lookup failures', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const snapshot = await services.environments.resolveForGroup({
      environmentId: environment.id,
      groupId: defaultGroupId,
    });
    services.environments.resolveForGroup = async () => {
      throw new Error('environment store unavailable');
    };

    await expect(
      validateEnvironmentContext(services.environments, defaultGroupId, { environment: snapshot }),
    ).rejects.toThrow('environment store unavailable');
  });

  it('reports saved-snapshot status but keeps new environment selection strict', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
      ownerGroupId: defaultGroupId,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const snapshot = await services.environments.resolveForGroup({
      environmentId: environment.id,
      groupId: defaultGroupId,
    });
    await services.environments.archive(environment.id);
    const repository = repositoryServices({ context: { environment: snapshot } });

    await expect(
      executeEnvironmentTool(
        { environments: services.environments, ownerGroupId: defaultGroupId, repository },
        { action: 'status' },
      ),
    ).resolves.toContain("Continuing with this session's saved environment snapshot.");
    await expect(
      executeEnvironmentTool(
        { environments: services.environments, ownerGroupId: defaultGroupId, repository },
        { action: 'set', environmentId: environment.id },
      ),
    ).rejects.toMatchObject({ code: 'archived' });
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

function repositoryServices(input: {
  context: Record<string, unknown>;
  updateSessionContext?: (context: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): RepositoryToolServices {
  return {
    github: {
      async getRepositoryAccess(repository) {
        return {
          provider: 'github',
          owner: repository.owner,
          repo: repository.repo,
          cloneUrl: `https://github.com/${repository.owner}/${repository.repo}.git`,
          expiresAt: new Date('2026-07-09T00:00:00Z'),
          auth: { type: 'bearer', token: 'test-token' },
        };
      },
    },
    sandbox: { workspacePath: '/workspace' } as never,
    shell: () => async () => ({ exitCode: 0, stdout: 'deputies-repo-setup:cloned=1\n', stderr: '' }),
    state: { context: input.context },
    emit: async () => {},
    eventBase: { sessionId: 'session-1', runId: 'run-1', messageId: 'message-1' },
    ...(input.updateSessionContext ? { updateSessionContext: input.updateSessionContext } : {}),
  };
}
