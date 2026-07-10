import { startSandboxService } from '../../src/sandbox/service-process.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';

describe('startSandboxService', () => {
  it('uses provider-managed service launch when available', async () => {
    const startService = vi.fn(async () => ({ pid: 42, status: 'running' as const }));
    const sandbox = createSandbox({ startService });

    await expect(startSandboxService(sandbox, { command: 'node server.js', port: 3000 })).resolves.toEqual({
      pid: 42,
      status: 'running',
    });
    expect(startService).toHaveBeenCalledWith({ command: 'node server.js', port: 3000 });
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it('rejects fallback services that exit during launch', async () => {
    const sandbox = createSandbox({
      exec: vi
        .fn()
        .mockResolvedValueOnce(execResult({ stdout: '42' }))
        .mockResolvedValueOnce(execResult({ exitCode: 1 })),
    });

    await expect(startSandboxService(sandbox, { command: 'missing-command', port: 3000 })).rejects.toThrow(
      'Sandbox service exited during launch',
    );
  });
});

function createSandbox(overrides: Partial<SandboxHandle> = {}): SandboxHandle {
  return {
    provider: 'test',
    providerSandboxId: 'sandbox-1',
    sessionId: 'session-1',
    workspacePath: '/workspace',
    metadata: {},
    capabilities: {
      persistentFilesystem: true,
      snapshots: false,
      stopStart: false,
      exec: true,
      filesystem: false,
      streamingLogs: false,
      portForwarding: false,
      serviceEndpoints: true,
      objectStorageArtifacts: false,
    },
    exec: vi.fn(async () => execResult()),
    ...overrides,
  };
}

function execResult(overrides: { exitCode?: number; stdout?: string } = {}) {
  const now = new Date();
  return {
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? '',
    stderr: '',
    startedAt: now,
    completedAt: now,
  };
}
