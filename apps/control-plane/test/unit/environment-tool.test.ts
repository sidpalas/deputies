import { createServices } from '../../src/app/server.js';
import { executeEnvironmentTool, validateEnvironmentContext } from '../../src/environments/tool.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { RepositoryToolServices } from '../../src/repositories/tool.js';

describe('environment tool', () => {
  it('automatically selects one matching environment and prepares its primary repository', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
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
      { environments: services.environments, repository },
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
        repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
      });
    }
    const repository = repositoryServices({
      context: { repository: { provider: 'github', owner: 'acme', repo: 'api' } },
    });

    await expect(
      executeEnvironmentTool({ environments: services.environments, repository }, { action: 'auto' }),
    ).resolves.toContain('Multiple available environments contain acme/api');
    expect(repository.state.context).toEqual({ repository: { provider: 'github', owner: 'acme', repo: 'api' } });
  });

  it('continues from a saved snapshot after the environment is archived', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const snapshot = await services.environments.resolve({
      environmentId: environment.id,
    });
    await services.environments.archive(environment.id);

    await expect(validateEnvironmentContext(services.environments, { environment: snapshot })).resolves.toBe(
      `Note: environment "Product surface" (revision 1) is no longer available (it has been archived). Continuing with this session's saved environment snapshot.`,
    );
  });

  it('returns null for a still-available environment and rejects malformed snapshots', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const snapshot = await services.environments.resolve({
      environmentId: environment.id,
    });

    await expect(validateEnvironmentContext(services.environments, { environment: snapshot })).resolves.toBeNull();
    await expect(
      validateEnvironmentContext(services.environments, { environment: { id: environment.id } }),
    ).rejects.toThrow('Invalid environment session context');
  });

  it('rethrows unexpected live-environment lookup failures', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const snapshot = await services.environments.resolve({
      environmentId: environment.id,
    });
    services.environments.resolve = async () => {
      throw new Error('environment store unavailable');
    };

    await expect(validateEnvironmentContext(services.environments, { environment: snapshot })).rejects.toThrow(
      'environment store unavailable',
    );
  });

  it('reports saved-snapshot status but keeps new environment selection strict', async () => {
    const services = createServices(new MemoryStore());
    const environment = await services.environments.create({
      name: 'Product surface',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const snapshot = await services.environments.resolve({
      environmentId: environment.id,
    });
    await services.environments.archive(environment.id);
    const repository = repositoryServices({ context: { environment: snapshot } });

    await expect(
      executeEnvironmentTool({ environments: services.environments, repository }, { action: 'status' }),
    ).resolves.toContain("Continuing with this session's saved environment snapshot.");
    await expect(
      executeEnvironmentTool(
        { environments: services.environments, repository },
        { action: 'set', environmentId: environment.id },
      ),
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
