import type { Server } from 'node:http';
import { createServer, createServices, type AppServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { AuthRole } from '../../src/store/types.js';

describe('skills API', () => {
  let server: Server;
  let baseUrl: string;
  let store: MemoryStore;
  let services: AppServices;

  beforeEach(async () => {
    store = new MemoryStore();
    services = createServices(store);
    server = createServer(
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_SESSION_SECRET: 'secret',
        AUTH_STATIC_USERNAME: 'admin',
        AUTH_STATIC_PASSWORD: 'password',
      }),
      services,
    );
    baseUrl = await listen(server);
  });
  afterEach(() => close(server));

  it('supports tenant CRUD and lets a member manage another creator while viewers only read', async () => {
    const creator = await user('creator', 'member');
    const member = await user('other', 'member');
    const viewer = await user('viewer', 'viewer');
    const admin = await user('admin', 'admin');
    expect((await post('/skills', viewer, skillBody('viewer-skill'))).status).toBe(403);
    const response = await post('/skills', creator, skillBody('review-code'));
    expect(response.status).toBe(201);
    const created = ((await response.json()) as { skill: { id: string; currentRevisionId: string } }).skill;
    expect((await get('/skills', viewer)).status).toBe(200);
    await expect((await get(`/skills/${created.id}`, viewer)).json()).resolves.toMatchObject({
      skill: { name: 'review-code', canManage: false },
    });
    expect((await patch(`/skills/${created.id}`, viewer, { body: 'no' })).status).toBe(403);
    expect(
      (
        await patch(`/skills/${created.id}`, member, {
          body: 'member revision',
          expectedCurrentRevisionId: created.currentRevisionId,
        })
      ).status,
    ).toBe(200);
    expect((await patch(`/skills/${created.id}`, admin, { enabled: false })).status).toBe(200);
  });

  it('preserves revisions, optimistic concurrency, archive/restore, and archived viewer reads', async () => {
    const member = await user('member', 'member');
    const viewer = await user('viewer', 'viewer');
    const created = (
      (await (await post('/skills', member, skillBody('revisions'))).json()) as {
        skill: { id: string; currentRevisionId: string };
      }
    ).skill;
    const revised = await patch(`/skills/${created.id}`, member, {
      body: 'v2',
      expectedCurrentRevisionId: created.currentRevisionId,
    });
    expect(revised.status).toBe(200);
    expect(
      (
        await patch(`/skills/${created.id}`, member, {
          body: 'stale',
          expectedCurrentRevisionId: created.currentRevisionId,
        })
      ).status,
    ).toBe(409);
    const revisions = (await (await get(`/skills/${created.id}/revisions`, viewer)).json()) as { revisions: unknown[] };
    expect(revisions.revisions).toHaveLength(2);
    expect((await post(`/skills/${created.id}/archive`, member)).status).toBe(200);
    expect((await get(`/skills/${created.id}`, viewer)).status).toBe(200);
    expect((await patch(`/skills/${created.id}`, member, { body: 'blocked' })).status).toBe(409);
    expect((await post(`/skills/${created.id}/restore`, viewer)).status).toBe(403);
    expect((await post(`/skills/${created.id}/restore`, member)).status).toBe(200);
  });

  it('lists invocation candidates and canonicalizes a pinned invocation', async () => {
    const member = await user('invoke', 'member');
    const created = (
      (await (await post('/skills', member, { ...skillBody('deploy-check'), autoLoad: false })).json()) as {
        skill: { id: string; currentRevisionId: string };
      }
    ).skill;
    const candidates = (await (await get('/skills/invocation-candidates', member)).json()) as {
      skills: Array<{ name: string }>;
    };
    expect(candidates.skills.map((skill) => skill.name)).toContain('deploy-check');
    const session = await services.sessions.create({ createdByUserId: 'user-invoke' });
    const append = await post(`/sessions/${session.id}/messages`, member, {
      prompt: 'deploy',
      context: { skills: ['deploy-check'] },
    });
    expect(append.status).toBe(202);
    const message = (await append.json()) as {
      message: { context: { skillRefs: Array<{ id: string; name: string; revisionId: string }> } };
    };
    expect(message.message.context.skillRefs).toEqual([
      { id: created.id, name: 'deploy-check', revisionId: created.currentRevisionId },
    ]);
  });

  it('keeps personal skills owner-only, manual-only, and manageable by viewer owners', async () => {
    const owner = await user('personal-owner', 'viewer');
    const other = await user('personal-other', 'admin');
    const response = await post('/skills', owner, { ...skillBody('my-review'), scope: 'personal', autoLoad: false });
    expect(response.status).toBe(201);
    const created = ((await response.json()) as { skill: { id: string; scope: string; autoLoad: boolean } }).skill;
    expect(created).toMatchObject({ scope: 'personal', autoLoad: false });
    expect((await get(`/skills/${created.id}`, other)).status).toBe(404);
    expect((await patch(`/skills/${created.id}`, other, { body: 'admin override' })).status).toBe(404);
    await expect((await get('/skills', other)).json()).resolves.not.toMatchObject({
      skills: [expect.objectContaining({ id: created.id })],
    });
    expect((await patch(`/skills/${created.id}`, owner, { body: 'owner revision' })).status).toBe(200);
    const candidates = (await (await get('/skills/invocation-candidates', owner)).json()) as {
      skills: Array<{ id: string; scope: string; autoLoad: boolean }>;
    };
    expect(candidates.skills).toContainEqual(
      expect.objectContaining({ id: created.id, scope: 'personal', autoLoad: false }),
    );
    expect(
      (await post('/skills', owner, { ...skillBody('invalid-personal'), scope: 'personal', autoLoad: true })).status,
    ).toBe(400);
  });

  it('rejects removed ownership, sharing, and promotion APIs', async () => {
    const member = await user('legacy', 'member');
    const created = ((await (await post('/skills', member, skillBody('modern'))).json()) as { skill: { id: string } })
      .skill;
    expect(
      (await request(`/skills/${created.id}/promote`, member, { method: 'POST', headers: json, body: '{}' })).status,
    ).toBe(404);
    expect(
      (await request(`/skills/${created.id}/shares`, member, { method: 'PUT', headers: json, body: '{}' })).status,
    ).toBe(404);
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
    const sid = `session-${name}`;
    await store.createAuthSession({ id: sid, userId: id, createdAt: now, expiresAt: new Date(now.getTime() + 60_000) });
    return { cookie: `dev_deputies_session=${sid}` };
  }
  function request(path: string, auth: { cookie: string }, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, cookie: auth.cookie } });
  }
  function get(path: string, auth: { cookie: string }) {
    return request(path, auth);
  }
  function post(path: string, auth: { cookie: string }, body?: unknown) {
    return request(path, auth, {
      method: 'POST',
      ...(body === undefined ? {} : { headers: json, body: JSON.stringify(body) }),
    });
  }
  function patch(path: string, auth: { cookie: string }, body: unknown) {
    return request(path, auth, { method: 'PATCH', headers: json, body: JSON.stringify(body) });
  }
});

const json = { 'content-type': 'application/json' };
const skillBody = (name: string) => ({ name, description: `Description for ${name}`, body: `Body for ${name}` });
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
