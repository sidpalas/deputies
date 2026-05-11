import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createSandboxBridgeServer } from '../src/server.js';

describe('sandbox bridge server', () => {
  let workspacePath: string;
  let server: Server;
  let baseUrl: string;
  const token = 'test-token';

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'deputies-sandbox-bridge-test-'));
    server = createSandboxBridgeServer({ workspacePath, token, maxOutputBytes: 128 * 1024 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('Expected server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { error ? reject(error) : resolve(); });
    });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('requires bearer auth', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(401);
  });

  it('reports health', async () => {
    const response = await bridgeFetch('/health');

    await expect(response.json()).resolves.toMatchObject({ status: 'ready', workspacePath });
  });

  it('round trips filesystem operations and rejects path escapes', async () => {
    await expect(bridgeFetch('/fs/mkdir', { method: 'POST', body: JSON.stringify({ path: 'nested', recursive: true }) })).resolves.toMatchObject({ status: 200 });
    await expect(bridgeFetch('/fs/write?path=nested/file.txt', { method: 'PUT', body: 'hello' })).resolves.toMatchObject({ status: 200 });

    const read = await bridgeFetch('/fs/read?path=nested/file.txt');
    await expect(read.text()).resolves.toBe('hello');
    await expect((await bridgeFetch('/fs/readdir?path=nested')).json()).resolves.toEqual({ entries: ['file.txt'] });
    await expect((await bridgeFetch('/fs/exists?path=nested/file.txt')).json()).resolves.toEqual({ exists: true });

    const escaped = await bridgeFetch('/fs/read?path=/tmp/outside.txt');
    expect(escaped.status).toBe(400);

    await expect(bridgeFetch('/fs/rm', { method: 'POST', body: JSON.stringify({ path: 'nested', recursive: true, force: true }) })).resolves.toMatchObject({ status: 200 });
    await expect((await bridgeFetch('/fs/exists?path=nested/file.txt')).json()).resolves.toEqual({ exists: false });
  });

  it('executes commands with cwd, env, stdin, and non-zero exit codes', async () => {
    await bridgeFetch('/fs/write?path=input.txt', { method: 'PUT', body: 'from-file' });

    const response = await bridgeFetch('/exec', {
      method: 'POST',
      body: JSON.stringify({
        command: 'read value && printf "$GREETING:$value:$(cat input.txt)" && exit 7',
        cwd: workspacePath,
        env: { GREETING: 'hello' },
        stdin: 'from-stdin\n',
      }),
    });

    await expect(response.json()).resolves.toMatchObject({
      exitCode: 7,
      stdout: 'hello:from-stdin:from-file',
      stderr: '',
    });
  });

  it('does not expose the bridge token to commands', async () => {
    process.env.DEPUTIES_SANDBOX_TOKEN = 'parent-token';

    const response = await bridgeFetch('/exec', {
      method: 'POST',
      body: JSON.stringify({ command: 'printf "${DEPUTIES_SANDBOX_TOKEN:-missing}"' }),
    });

    await expect(response.json()).resolves.toMatchObject({ stdout: 'missing' });
    delete process.env.DEPUTIES_SANDBOX_TOKEN;
  });

  it('times out commands using milliseconds', async () => {
    const response = await bridgeFetch('/exec', {
      method: 'POST',
      body: JSON.stringify({ command: 'sleep 5', timeoutMs: 50 }),
    });

    await expect(response.json()).resolves.toMatchObject({
      exitCode: 143,
      stderr: '[sandbox bridge] Command timed out after 50ms.',
    });
  });

  function bridgeFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
  }
});
