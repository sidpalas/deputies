import { createServices } from '../../src/app/server.js';
import { executeEnvironmentTool, validateEnvironmentContext } from '../../src/environments/tool.js';
import { MemoryStore } from '../../src/store/memory.js';
import { defaultGroupId } from '../../src/store/types.js';
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

  it('rejects a persisted environment after it is archived', async () => {
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
    ).rejects.toMatchObject({ code: 'archived' });
  });
});

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
