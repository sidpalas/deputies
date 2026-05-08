import { FakeSandboxProvider } from '../../src/sandbox/fake.js';

describe('FakeSandboxProvider', () => {
  it('creates, health checks, executes, and destroys a sandbox', async () => {
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create({ sessionId: 'session-1' });

    await expect(provider.health(sandbox)).resolves.toMatchObject({ status: 'ready' });
    await expect(sandbox.exec({ command: 'echo ok' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'fake exec: echo ok',
    });

    await provider.destroy(sandbox);
    await expect(provider.health(sandbox)).resolves.toMatchObject({ status: 'missing' });
  });
});
