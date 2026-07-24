import type { Server } from 'node:http';
import { createServer, createServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { AuthRole } from '../../src/store/types.js';

describe('session HTTP role matrix', () => {
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
  afterEach(() => close(server));

  it('allows tenant-wide reads, member/admin cross-creator writes, and no viewer writes', async () => {
    const viewer = await user('viewer', 'viewer');
    const creator = await user('creator', 'member');
    const other = await user('other', 'member');
    const admin = await user('admin', 'admin');

    expect(
      (await request('/sessions', viewer, { method: 'POST', body: JSON.stringify({ title: 'no' }), headers: json }))
        .status,
    ).toBe(403);
    const createdResponse = await request('/sessions', creator, {
      method: 'POST',
      body: JSON.stringify({ title: 'shared' }),
      headers: json,
    });
    expect(createdResponse.status).toBe(201);
    const id = ((await createdResponse.json()) as { session: { id: string } }).session.id;

    for (const actor of [viewer, creator, other, admin])
      expect((await request(`/sessions/${id}`, actor)).status).toBe(200);
    expect((await request(`/sessions/${id}`, viewer, patch({ title: 'no' }))).status).toBe(403);
    expect((await request(`/sessions/${id}`, other, patch({ title: 'member changed it' }))).status).toBe(200);
    expect((await request(`/sessions/${id}`, admin, patch({ title: 'admin changed it' }))).status).toBe(200);

    expect((await request(`/sessions/${id}/archive`, viewer, { method: 'POST' })).status).toBe(403);
    expect((await request(`/sessions/${id}/archive`, other, { method: 'POST' })).status).toBe(200);
    for (const actor of [viewer, creator, other, admin])
      expect((await request(`/sessions/${id}`, actor)).status).toBe(200);
    expect((await request(`/sessions/${id}`, admin, patch({ title: 'archived write' }))).status).toBe(409);
    expect((await request(`/sessions/${id}/unarchive`, viewer, { method: 'POST' })).status).toBe(403);
    expect((await request(`/sessions/${id}/unarchive`, admin, { method: 'POST' })).status).toBe(200);
  });

  it('removes group routes and retains object guards for agent credentials', async () => {
    const member = await user('member', 'member');
    expect((await request('/groups', member)).status).toBe(404);
    const created = await request('/sessions', member, {
      method: 'POST',
      body: JSON.stringify({ title: 'guarded' }),
      headers: json,
    });
    const id = ((await created.json()) as { session: { id: string } }).session.id;
    // Human session cookies are tenant-role authorization; an arbitrary bearer token is not an agent credential.
    expect(
      (await fetch(`${baseUrl}/sessions/${id}`, { headers: { authorization: 'Bearer wrong-object-token' } })).status,
    ).toBe(401);
  });

  async function user(name: string, role: AuthRole) {
    const now = new Date();
    const id = `user-${name}`;
    await store.upsertAuthUserForAccount({
      userId: id,
      accountId: `account-${name}`,
      provider: 'test',
      providerAccountId: name,
      username: name,
      role,
      profile: {},
      now,
    });
    const sessionId = `auth-${name}`;
    await store.createAuthSession({
      id: sessionId,
      userId: id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    return { cookie: `dev_deputies_session=${sessionId}` };
  }
  function request(path: string, auth: { cookie: string }, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, cookie: auth.cookie } });
  }
});

const json = { 'content-type': 'application/json' };
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', headers: json, body: JSON.stringify(body) });
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  return `http://${address.address}:${address.port}`;
}
async function close(server: Server | undefined) {
  if (server?.listening)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
