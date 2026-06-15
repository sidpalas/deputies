import { ModalSandboxProvider, type ModalClientLike, type ModalSandboxLike } from '../../src/sandbox/modal.js';

describe('ModalSandboxProvider', () => {
  it('creates a Modal sandbox handle with native exec and filesystem operations', async () => {
    const sandbox = createMockModalSandbox();
    const createCalls: unknown[] = [];
    const client: ModalClientLike = {
      apps: { fromName: vi.fn(async () => ({ appId: 'app-1' })) },
      images: { fromRegistry: vi.fn(() => ({ tag: 'image-1' })) },
      sandboxes: {
        create: vi.fn(async (_app, _image, params) => {
          createCalls.push(params);
          return sandbox;
        }),
        fromId: vi.fn(async () => sandbox),
      },
    };
    const provider = new ModalSandboxProvider({
      client,
      appName: 'deputies-test',
      image: 'ghcr.io/example/sandbox:test',
      workspacePath: '/workspace/custom',
      idleTimeoutMs: 900_000,
      timeoutMs: 3_600_000,
      cpu: 2,
      memoryMiB: 4096,
      envVars: { NODE_ENV: 'test' },
      tags: { team: 'agents' },
    });

    const handle = await provider.create({ sessionId: 'session-1', metadata: { owner: 'test' } });

    expect(client.apps.fromName).toHaveBeenCalledWith('deputies-test', { createIfMissing: true });
    expect(client.images.fromRegistry).toHaveBeenCalledWith('ghcr.io/example/sandbox:test');
    expect(createCalls[0]).toMatchObject({
      workdir: '/workspace/custom',
      idleTimeoutMs: 900_000,
      timeoutMs: 3_600_000,
      cpu: 2,
      memoryMiB: 4096,
      command: ['sh', '-lc', expect.stringContaining('sleep infinity')],
      tags: { team: 'agents', 'deputies-provider': 'modal', 'deputies-session-id': 'session-1' },
    });
    expect((createCalls[0] as { name: string }).name).toMatch(/^deputies-session-1-/);
    expect((createCalls[0] as { env: Record<string, string> }).env).toMatchObject({
      NODE_ENV: 'test',
      DEPUTIES_WORKSPACE: '/workspace/custom',
      DEPUTIES_SANDBOX_BRIDGE_HOST: '0.0.0.0',
      DEPUTIES_SANDBOX_BRIDGE_PORT: '8080',
    });
    expect((createCalls[0] as { env: Record<string, string> }).env.DEPUTIES_SANDBOX_TOKEN).toEqual(expect.any(String));
    expect(handle).toMatchObject({
      provider: 'modal',
      providerSandboxId: 'sb-1',
      sessionId: 'session-1',
      workspacePath: '/workspace/custom',
      metadata: {
        owner: 'test',
        appName: 'deputies-test',
        image: 'ghcr.io/example/sandbox:test',
        workspacePath: '/workspace/custom',
      },
      capabilities: { persistentFilesystem: false, exec: true, filesystem: true, previewUrls: true },
    });
    expect(handle.secrets?.bridgeToken).toEqual(expect.any(String));

    await expect(
      handle.exec({ command: 'echo ok', cwd: '/workspace/custom', env: { GREETING: 'hello' } }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'ran: echo ok', stderr: '' });
    expect(sandbox.exec).toHaveBeenCalledWith(['sh', '-lc', 'echo ok'], {
      stdout: 'pipe',
      stderr: 'pipe',
      workdir: '/workspace/custom',
      env: { GREETING: 'hello' },
    });

    await handle.fs?.writeFile('/workspace/custom/file.txt', 'hello');
    await expect(handle.fs?.readFile('/workspace/custom/file.txt')).resolves.toBe('hello');
    await expect(handle.fs?.readdir('/workspace/custom')).resolves.toEqual(['file.txt']);
    await expect(handle.fs?.stat('/workspace/custom/file.txt')).resolves.toMatchObject({
      isFile: true,
      isDirectory: false,
      size: 5,
      mtime: new Date(1_700_000_000_000),
    });
  });

  it('does not start Modal exec when the caller signal is already aborted', async () => {
    const sandbox = createMockModalSandbox();
    const provider = new ModalSandboxProvider({ client: createMockModalClient(sandbox) });
    const handle = await provider.create({ sessionId: 'session-1' });
    vi.mocked(sandbox.exec).mockClear();
    const abort = new AbortController();
    abort.abort();

    await expect(handle.exec({ command: 'sleep 20', signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it('reports health and treats missing destroy as idempotent', async () => {
    const sandbox = createMockModalSandbox();
    const client = createMockModalClient(sandbox);
    vi.mocked(client.sandboxes.fromId).mockImplementation(async (id) => {
      if (id === 'missing') throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      return sandbox;
    });
    const provider = new ModalSandboxProvider({ client });

    await expect(provider.health({ providerSandboxId: 'sb-1', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'ready',
    });
    sandbox.poll = vi.fn(async () => 137);
    await expect(provider.health({ providerSandboxId: 'sb-1', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'stopped',
      message: 'Modal sandbox exited with code 137',
    });
    await expect(provider.health({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(provider.destroy({ providerSandboxId: 'missing', sessionId: 'session-1' })).resolves.toBeUndefined();
  });

  it('returns Modal connect-token preview URLs backed by the sandbox bridge', async () => {
    const sandbox = createMockModalSandbox();
    const provider = new ModalSandboxProvider({
      client: createMockModalClient(sandbox),
      bridgeSkippedCookieNames: 'inner_deputies_preview,inner_deputies_session',
    });

    await expect(
      provider.getPreviewUrl({
        providerSandboxId: 'sb-1',
        sessionId: 'session-1',
        port: 3000,
        secrets: { bridgeToken: 'bridge-token' },
      }),
    ).resolves.toEqual({
      port: 3000,
      targetUrl: 'https://connect.modal.test/preview/3000?_modal_connect_token=modal-token',
      targetHeaders: { authorization: 'Bearer bridge-token' },
      preserveTargetHost: true,
      forwardPreviewHost: true,
      secrets: { bridgeToken: 'bridge-token' },
    });
    expect(sandbox.exec).toHaveBeenCalledWith(
      ['sh', '-lc', expect.stringContaining('DEPUTIES_SANDBOX_BRIDGE_PORT=8080')],
      { timeoutMs: 10_000 },
    );
    expect(sandbox.exec).toHaveBeenCalledWith(
      ['sh', '-lc', expect.stringContaining(`SKIP_COOKIE_NAMES='inner_deputies_preview,inner_deputies_session'`)],
      { timeoutMs: 10_000 },
    );
    expect(sandbox.createConnectToken).toHaveBeenCalledWith({
      userMetadata: JSON.stringify({ provider: 'modal', sessionId: 'session-1', port: 3000 }),
    });
  });
});

function createMockModalClient(sandbox: ModalSandboxLike): ModalClientLike {
  return {
    apps: { fromName: vi.fn(async () => ({ appId: 'app-1' })) },
    images: { fromRegistry: vi.fn(() => ({ tag: 'image-1' })) },
    sandboxes: {
      create: vi.fn(async () => sandbox),
      fromId: vi.fn(async () => sandbox),
    },
  };
}

function createMockModalSandbox(): ModalSandboxLike {
  const files = new Map<string, string>();
  const sandbox: ModalSandboxLike = {
    sandboxId: 'sb-1',
    filesystem: {
      readText: vi.fn(async (path) => files.get(path) ?? ''),
      readBytes: vi.fn(async (path) => Buffer.from(files.get(path) ?? '', 'utf-8')),
      writeText: vi.fn(async (data, path) => {
        files.set(path, data);
      }),
      writeBytes: vi.fn(async (data, path) => {
        files.set(path, Buffer.from(data).toString('utf-8'));
      }),
      stat: vi.fn(async (path) => ({
        name: path.split('/').pop() ?? path,
        path,
        type: 'file' as const,
        size: files.get(path)?.length ?? 0,
        modifiedTime: 1_700_000_000,
      })),
      listFiles: vi.fn(async () => [
        { name: 'file.txt', path: '/workspace/file.txt', type: 'file' as const, size: 5, modifiedTime: 1_700_000_000 },
      ]),
      makeDirectory: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    exec: vi.fn(async (command) => createMockProcess(command[2] === 'echo ok' ? 'ran: echo ok' : 'bridge ready')),
    poll: vi.fn(async () => null),
    terminate: vi.fn(async () => {}),
    createConnectToken: vi.fn(async () => ({ url: 'https://connect.modal.test', token: 'modal-token' })),
    waitUntilReady: vi.fn(async () => {}),
    detach: vi.fn(() => {}),
  };
  return sandbox;
}

function createMockProcess(stdout: string, stderr = '', exitCode = 0) {
  return {
    stdout: { readText: vi.fn(async () => stdout) },
    stderr: { readText: vi.fn(async () => stderr) },
    stdin: { writeText: vi.fn(async () => {}) },
    wait: vi.fn(async () => exitCode),
  };
}
