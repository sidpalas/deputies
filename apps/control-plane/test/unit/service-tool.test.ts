import { executeServiceTool, type ServiceToolServices } from '../../src/sessions/service-tool.js';

describe('service tool', () => {
  it('publishes, lists, and unpublishes services in session context', async () => {
    let context: Record<string, unknown> = {};
    const tool = createServiceTool({
      sessionId: 'session-1',
      providerSandboxId: 'sandbox-1',
      sandboxMetadata: { runtimeId: 'runtime-1' },
      keepalive: createKeepalive(),
      getContext: () => context,
      setContext: (next) => {
        context = next;
      },
      async updateSessionContext(next) {
        context = { ...context, ...next };
        return context;
      },
    });

    await expect(
      tool.execute({ action: 'publish', port: 5173, label: 'Vite app', path: '/dashboard' }).then(JSON.parse),
    ).resolves.toEqual({
      services: [
        { port: 5173, label: 'Vite app', path: '/dashboard', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
      ],
      keepalive: { keepaliveUntil: '2026-05-15T00:00:00.000Z', providerSync: 'not_supported' },
    });
    await expect(tool.execute({ action: 'list' }).then(JSON.parse)).resolves.toEqual({
      services: [
        { port: 5173, label: 'Vite app', path: '/dashboard', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
      ],
    });
    await expect(tool.execute({ action: 'unpublish', port: 5173 })).resolves.toBe(JSON.stringify({ services: [] }));
  });

  it('launches persistent services before publishing them', async () => {
    let context: Record<string, unknown> = {};
    const launches: Array<{ command: string; port: number; cwd?: string }> = [];
    const tool = createServiceTool({
      sessionId: 'session-1',
      providerSandboxId: 'sandbox-1',
      sandboxMetadata: { runtimeId: 'runtime-1' },
      keepalive: createKeepalive(),
      async launchService(input) {
        launches.push(input);
        return { pid: 42, status: 'starting' };
      },
      getContext: () => context,
      setContext: (next) => {
        context = next;
      },
      async updateSessionContext(next) {
        context = { ...context, ...next };
        return context;
      },
    });

    await expect(
      tool
        .execute({
          action: 'launch',
          command: 'pnpm dev --host 0.0.0.0',
          cwd: '/workspace/app',
          port: 5173,
          label: 'Web app',
        })
        .then(JSON.parse),
    ).resolves.toMatchObject({
      process: { pid: 42, status: 'starting' },
      services: [{ port: 5173, label: 'Web app', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' }],
    });
    expect(launches).toEqual([{ command: 'pnpm dev --host 0.0.0.0', cwd: '/workspace/app', port: 5173 }]);
  });

  it('keeps existing services by default when publishing', async () => {
    let context: Record<string, unknown> = {
      services: [{ port: 2343, label: 'Old server', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' }],
    };
    const tool = createServiceTool({
      sessionId: 'session-1',
      providerSandboxId: 'sandbox-1',
      sandboxMetadata: { runtimeId: 'runtime-1' },
      keepalive: createKeepalive(),
      getContext: () => context,
      setContext: (next) => {
        context = next;
      },
      async updateSessionContext(next) {
        context = { ...context, ...next };
        return context;
      },
    });

    await expect(
      tool.execute({ action: 'publish', port: 2344, label: 'New server' }).then(JSON.parse),
    ).resolves.toEqual({
      services: [
        { port: 2343, label: 'Old server', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
        { port: 2344, label: 'New server', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
      ],
      keepalive: { keepaliveUntil: '2026-05-15T00:00:00.000Z', providerSync: 'not_supported' },
    });
  });

  it('preserves services from other sandbox runtimes when publishing', async () => {
    let context: Record<string, unknown> = {
      services: [
        { port: 2343, label: 'Old runtime', providerSandboxId: 'sandbox-1', runtimeId: 'old-runtime' },
        { port: 2344, label: 'Current runtime', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
      ],
    };
    const tool = createServiceTool({
      sessionId: 'session-1',
      providerSandboxId: 'sandbox-1',
      sandboxMetadata: { runtimeId: 'runtime-1' },
      keepalive: createKeepalive(),
      getContext: () => context,
      setContext: (next) => {
        context = next;
      },
      async updateSessionContext(next) {
        context = { ...context, ...next };
        return context;
      },
    });

    await expect(
      tool.execute({ action: 'publish', port: 2345, label: 'New server' }).then(JSON.parse),
    ).resolves.toEqual({
      services: [
        { port: 2343, label: 'Old runtime', providerSandboxId: 'sandbox-1', runtimeId: 'old-runtime' },
        { port: 2344, label: 'Current runtime', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
        { port: 2345, label: 'New server', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
      ],
      keepalive: { keepaliveUntil: '2026-05-15T00:00:00.000Z', providerSync: 'not_supported' },
    });
    expect(context.services).toEqual([
      { port: 2343, label: 'Old runtime', providerSandboxId: 'sandbox-1', runtimeId: 'old-runtime' },
      { port: 2344, label: 'Current runtime', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
      { port: 2345, label: 'New server', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
    ]);
  });

  it('does not replace workspace tool services when publishing a new app service', async () => {
    let context: Record<string, unknown> = {
      services: [
        { port: 8080, label: 'VS Code', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
        { port: 7681, label: 'Hunk Diff', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
      ],
    };
    const tool = createServiceTool({
      sessionId: 'session-1',
      providerSandboxId: 'sandbox-1',
      sandboxMetadata: { runtimeId: 'runtime-1' },
      keepalive: createKeepalive(),
      getContext: () => context,
      setContext: (next) => {
        context = next;
      },
      async updateSessionContext(next) {
        context = { ...context, ...next };
        return context;
      },
    });

    await expect(tool.execute({ action: 'publish', port: 5173, label: 'Web app' }).then(JSON.parse)).resolves.toEqual({
      services: [
        { port: 5173, label: 'Web app', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
        { port: 7681, label: 'Hunk Diff', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
        { port: 8080, label: 'VS Code', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
      ],
      keepalive: { keepaliveUntil: '2026-05-15T00:00:00.000Z', providerSync: 'not_supported' },
    });
  });

  it('preserves services added after the run context was captured', async () => {
    let runnerContext: Record<string, unknown> = {};
    let persistedContext: Record<string, unknown> = {
      services: [{ port: 8080, label: 'VS Code', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' }],
    };
    const tool = createServiceTool({
      sessionId: 'session-1',
      providerSandboxId: 'sandbox-1',
      sandboxMetadata: { runtimeId: 'runtime-1' },
      keepalive: createKeepalive(),
      getContext: () => runnerContext,
      setContext: (next) => {
        runnerContext = next;
      },
      async updateSessionContext(next) {
        persistedContext = { ...persistedContext, ...next };
        return persistedContext;
      },
    });

    await expect(tool.execute({ action: 'publish', port: 5173, label: 'Web app' }).then(JSON.parse)).resolves.toEqual({
      services: [
        { port: 5173, label: 'Web app', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
        { port: 8080, label: 'VS Code', providerSandboxId: 'sandbox-1', runtimeId: 'runtime-1' },
      ],
      keepalive: { keepaliveUntil: '2026-05-15T00:00:00.000Z', providerSync: 'not_supported' },
    });
    expect(runnerContext.services).toEqual(persistedContext.services);
  });

  it('extends publish keepalive to at least the default service TTL', async () => {
    let context: Record<string, unknown> = {};
    const extensions: Array<{ durationMs: number; maxDurationMs: number; port?: number }> = [];
    const tool = createServiceTool({
      sessionId: 'session-1',
      providerSandboxId: 'sandbox-1',
      sandboxMetadata: { runtimeId: 'runtime-1' },
      keepaliveMaxExtensionMs: 7_200_000,
      keepalive: {
        async extend(input: { durationMs: number; maxDurationMs: number; port?: number }) {
          extensions.push(input);
          return { keepaliveUntil: new Date(), providerSync: 'not_supported', record: {} as never };
        },
      } as never,
      getContext: () => context,
      setContext: (next) => {
        context = next;
      },
      async updateSessionContext(next) {
        context = { ...context, ...next };
        return context;
      },
    });

    await tool.execute({ action: 'publish', port: 2344, label: 'New server', ttlSeconds: 10 });

    expect(extensions).toMatchObject([{ durationMs: 600_000, maxDurationMs: 7_200_000, port: 2344 }]);
  });
});

function createKeepalive() {
  return {
    async extend() {
      return {
        keepaliveUntil: new Date('2026-05-15T00:00:00.000Z'),
        providerSync: 'not_supported' as const,
        record: {} as never,
      };
    },
  } as never;
}

function createServiceTool(services: ServiceToolServices) {
  return {
    async execute(params: Record<string, unknown>): Promise<string> {
      return JSON.stringify(await executeServiceTool(services, params));
    },
  };
}
