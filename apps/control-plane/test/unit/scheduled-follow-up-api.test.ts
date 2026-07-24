import { randomUUID } from 'node:crypto';
import { createApp, createServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('scheduled follow-up API', () => {
  it('registers routes under ordinary configuration', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Routes registered' });
    const app = createApp(loadConfig({ API_AUTH_MODE: 'none' }), services);
    expect((await app.request(`/sessions/${session.id}/scheduled-follow-ups`)).status).toBe(200);
  });

  it('supports member lifecycle, stable validation errors, and list pagination', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const sessionId = randomUUID();
    const now = new Date();
    await store.createSession({
      id: sessionId,
      status: 'idle',
      title: 'API',
      tags: [],
      spawnDepth: 0,
      createdAt: now,
      updatedAt: now,
    });
    const app = createApp(loadConfig({ API_AUTH_MODE: 'none' }), services);
    const path = `/sessions/${sessionId}/scheduled-follow-ups`;

    for (const prompt of ['first', 'second']) {
      const response = await app.request(path, json({ prompt, schedule: future() }));
      expect(response.status).toBe(201);
    }
    const page = await app.request(`${path}?limit=1`);
    expect(page.status).toBe(200);
    const body = (await page.json()) as {
      scheduledFollowUps: Array<{ id: string; definitionRevision: number }>;
      hasMore: boolean;
      nextCursor: string;
    };
    expect(body).toMatchObject({ hasMore: true, scheduledFollowUps: [{ canManage: true }] });
    expect((await app.request(`${path}?limit=1&cursor=${body.nextCursor}`)).status).toBe(200);
    expect((await app.request(`${path}?cursor=garbage`)).status).toBe(400);
    expect((await app.request(path, json({ prompt: 'bad', schedule: { kind: 'once', runAt: 'nope' } }))).status).toBe(
      400,
    );

    const item = body.scheduledFollowUps[0]!;
    expect(
      (await app.request(`${path}/${item.id}`, json({ definitionRevision: 0, prompt: 'x' }, 'PATCH'))).status,
    ).toBe(400);
    const updated = await app.request(
      `${path}/${item.id}`,
      json({ definitionRevision: item.definitionRevision, prompt: 'updated' }, 'PATCH'),
    );
    expect(updated.status).toBe(200);
    expect((await app.request(`${path}/${item.id}?definitionRevision=2`, { method: 'DELETE' })).status).toBe(200);
  });
});

function future() {
  return { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString() };
}
function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
