import type { Server } from 'node:http';
import { createServer, createServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('snippets API', () => {
  let server: Server;
  let baseUrl: string;
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    server = createServer(
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_SESSION_SECRET: 'test-secret',
        AUTH_STATIC_USERNAME: 'admin',
        AUTH_STATIC_PASSWORD: 'password',
      }),
      createServices(store),
    );
    baseUrl = await listen(server);
  });
  afterEach(() => closeServer(server));

  it('lists, reads, updates, archives, and restores snippets only for their owner', async () => {
    const user = await createUser('alice');
    const other = await createUser('bob');
    const createdResponse = await json('/snippets', user, 'POST', { name: 'review-pr', body: 'Review this' });
    expect(createdResponse.status).toBe(201);
    const created = ((await createdResponse.json()) as { snippet: { id: string } }).snippet;
    expect(created).not.toHaveProperty('ownerUserId');
    await expect(request('/snippets', other).then((r) => r.json())).resolves.toEqual({ snippets: [] });
    expect((await request(`/snippets/${created.id}`, other)).status).toBe(404);
    expect((await json(`/snippets/${created.id}`, other, 'PATCH', { body: 'Review carefully' })).status).toBe(404);
    await expect(
      json(`/snippets/${created.id}`, user, 'PATCH', { body: 'Review carefully' }).then((r) => r.json()),
    ).resolves.toMatchObject({ snippet: { body: 'Review carefully' } });
    const archived = await json(`/snippets/${created.id}/archive`, user, 'POST', {});
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ snippet: { archivedAt: expect.any(String) } });
    const restored = await json(`/snippets/${created.id}/restore`, user, 'POST', {});
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { snippet: object }).snippet).not.toHaveProperty('archivedAt');
  });

  it('validates names and non-empty/64-KiB bodies', async () => {
    const user = await createUser('validator');
    for (const body of [
      { name: 'Invalid Name', body: 'ok' },
      { name: 'valid', body: '  ' },
      { name: 'valid', body: 'x'.repeat(65537) },
    ]) {
      const response = await json('/snippets', user, 'POST', body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid' });
    }
  });

  it('rejects PATCH requests without a recognized changed field', async () => {
    const user = await createUser('empty-update');
    const created = (await (await json('/snippets', user, 'POST', { name: 'existing', body: 'Body' })).json()) as {
      snippet: { id: string };
    };
    for (const body of [{}, { unknown: true }]) {
      const response = await json(`/snippets/${created.snippet.id}`, user, 'PATCH', body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid' });
    }
  });

  it('allows viewers to manage their own snippets without seeing another user’s snippets', async () => {
    const member = await createUser('member');
    const viewer = await createUser('viewer', 'viewer');
    const created = (await (await json('/snippets', member, 'POST', { name: 'shared', body: 'Visible' })).json()) as {
      snippet: { id: string };
    };
    await expect(request('/snippets', viewer).then((r) => r.json())).resolves.toEqual({ snippets: [] });
    expect((await request(`/snippets/${created.snippet.id}`, viewer)).status).toBe(404);
    for (const [path, method, body] of [
      [`/snippets/${created.snippet.id}`, 'PATCH', { body: 'stolen' }],
      [`/snippets/${created.snippet.id}/archive`, 'POST', {}],
      [`/snippets/${created.snippet.id}/restore`, 'POST', {}],
    ] as const)
      expect((await json(path, viewer, method, body)).status).toBe(404);
    const own = await json('/snippets', viewer, 'POST', { name: 'mine', body: 'Private' });
    expect(own.status).toBe(201);
  });

  it('rejects malformed snippet ids before store access', async () => {
    const user = await createUser('malformed-id');
    for (const [path, method, body] of [
      ['/snippets/not-a-uuid', 'PATCH', { body: 'updated' }],
      ['/snippets/not-a-uuid/archive', 'POST', {}],
      ['/snippets/not-a-uuid/restore', 'POST', {}],
    ] as const) {
      const response = await json(path, user, method, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
    }
  });

  it('rejects auth bypass mode because snippets require a user identity', async () => {
    await closeServer(server);
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), createServices(store));
    baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/snippets`);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'unauthorized' });
  });

  async function createUser(
    username: string,
    role: 'viewer' | 'member' | 'admin' = 'member',
  ): Promise<{ cookie: string }> {
    const now = new Date();
    const suffix = String([...username].reduce((sum, char) => sum + char.charCodeAt(0), 0)).padStart(12, '0');
    const user = await store.upsertAuthUserForAccount({
      userId: `00000000-0000-4000-8000-${suffix}`,
      accountId: `10000000-0000-4000-8000-${suffix}`,
      provider: 'snippet-test',
      providerAccountId: username,
      username,
      role,
      profile: {},
      now,
    });
    const id = `${username}-session`;
    await store.createAuthSession({ id, userId: user.id, createdAt: now, expiresAt: new Date(now.getTime() + 60_000) });
    return { cookie: `dev_deputies_session=${id}` };
  }
  function request(path: string, auth: { cookie: string }, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, cookie: auth.cookie } });
  }
  function json(path: string, auth: { cookie: string }, method: string, body: unknown) {
    return request(path, auth, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://${address.address}:${address.port}`;
}
async function closeServer(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
