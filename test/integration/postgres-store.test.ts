import type { Server } from 'node:http';
import type { SessionData } from '@flue/sdk';
import { Pool } from 'pg';
import { createServer, createServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PostgresFlueSessionStore } from '../../src/runner-flue/session-store.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';
import { PostgresStore } from '../../src/store/postgres.js';
import { WorkerService } from '../../src/worker/service.js';
import { expectGenericWebhookResponse } from '../support/contracts.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('PostgresStore', () => {
  let pool: Pool;
  let store: PostgresStore;

  beforeAll(async () => {
    await runMigrations(testDatabaseUrl!);
    pool = new Pool({ connectionString: testDatabaseUrl });
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE flue_sessions, integration_deliveries, external_threads, events, runs, messages, session_sequence_counters, webhook_sources, sessions RESTART IDENTITY CASCADE',
    );
    store = new PostgresStore(testDatabaseUrl!);
  });

  afterEach(async () => {
    await store.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('preserves session, message, and event behavior', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres test' });
    const message = await services.messages.enqueue({
      sessionId: session.id,
      prompt: 'Persist this message',
      source: 'test',
      context: { issue: 123 },
    });

    expect(await services.sessions.get(session.id)).toMatchObject({
      id: session.id,
      title: 'Postgres test',
      status: 'created',
    });
    expect(await services.messages.list(session.id)).toMatchObject([
      {
        id: message.id,
        sessionId: session.id,
        sequence: 1,
        status: 'pending',
        prompt: 'Persist this message',
        source: 'test',
        context: { issue: 123 },
      },
    ]);

    const events = await services.events.list(session.id);
    expect(events.map((event) => event.type)).toEqual(['session_created', 'message_created']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);

    await store.close();
    store = new PostgresStore(testDatabaseUrl!);
    const restartedServices = createServices(store);

    const replayed = await restartedServices.events.list(session.id, 1);
    expect(replayed.map((event) => event.type)).toEqual(['message_created']);
  });

  it('persists Flue session data opaquely', async () => {
    const flueStore = new PostgresFlueSessionStore(testDatabaseUrl!);
    try {
      const data: SessionData = {
        version: 2,
        entries: [],
        leafId: null,
        metadata: { appSessionId: 'session-1' },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };

      await flueStore.save('agent-1:default', data);
      await expect(flueStore.load('agent-1:default')).resolves.toEqual(data);
      await flueStore.delete('agent-1:default');
      await expect(flueStore.load('agent-1:default')).resolves.toBeNull();
    } finally {
      await flueStore.close();
    }
  });

  it('claims each pending message once under concurrent workers', async () => {
    const services = createServices(store);
    const firstSession = await services.sessions.create({ title: 'First' });
    const secondSession = await services.sessions.create({ title: 'Second' });
    await services.messages.enqueue({ sessionId: firstSession.id, prompt: 'first' });
    await services.messages.enqueue({ sessionId: secondSession.id, prompt: 'second' });

    const now = new Date();
    const claims = await Promise.all([
      store.claimNextPendingMessage({
        runId: '00000000-0000-4000-8000-000000000001',
        runnerType: 'fake',
        leaseOwner: 'worker-1',
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        now,
      }),
      store.claimNextPendingMessage({
        runId: '00000000-0000-4000-8000-000000000002',
        runnerType: 'fake',
        leaseOwner: 'worker-2',
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        now,
      }),
    ]);

    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((claim) => claim!.message.id)).size).toBe(2);
    await expect(store.claimNextPendingMessage({
      runId: '00000000-0000-4000-8000-000000000003',
      runnerType: 'fake',
      leaseOwner: 'worker-3',
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      now,
    })).resolves.toBeNull();
  });

  it('recovers stale processing messages for retry', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Stale run' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'retry me' });

    const claimed = await store.claimNextPendingMessage({
      runId: '00000000-0000-4000-8000-000000000011',
      runnerType: 'fake',
      leaseOwner: 'crashed-worker',
      leaseExpiresAt: new Date(Date.now() - 1_000),
      now: new Date(Date.now() - 2_000),
    });
    expect(claimed).toBeTruthy();

    const recovered = await store.recoverStaleRuns({ now: new Date(), limit: 10 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.run.status).toBe('stale');
    expect(recovered[0]!.message.status).toBe('pending');

    const retried = await store.claimNextPendingMessage({
      runId: '00000000-0000-4000-8000-000000000012',
      runnerType: 'fake',
      leaseOwner: 'new-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    expect(retried?.message.id).toBe(claimed!.message.id);
  });

  it('renews run leases so active work is not recovered as stale', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Heartbeat' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'keep alive' });

    const claimedAt = new Date();
    const claimed = await store.claimNextPendingMessage({
      runId: '00000000-0000-4000-8000-000000000021',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(claimedAt.getTime() + 1_000),
      now: claimedAt,
    });
    expect(claimed).toBeTruthy();

    const renewed = await store.renewRunLease({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(claimedAt.getTime() + 60_000),
      heartbeatAt: new Date(claimedAt.getTime() + 500),
    });
    expect(renewed?.leaseOwner).toBe('worker-1');

    await expect(store.recoverStaleRuns({ now: new Date(claimedAt.getTime() + 2_000), limit: 10 })).resolves.toEqual([]);
  });

  it('processes an HTTP-created message through the worker using Postgres', async () => {
    const services = createServices(store);
    const server = createServer(loadConfig({ APP_STORE: 'postgres', DATABASE_URL: testDatabaseUrl! }), services);
    const baseUrl = await listen(server);

    try {
      const createSession = await postJson(`${baseUrl}/sessions`, { title: 'HTTP worker' });
      const { session } = (await createSession.json()) as { session: { id: string } };

      const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, { prompt: 'ship it' });
      expect(createMessage.status).toBe(202);

      const worker = new WorkerService({
        store,
        events: services.events,
        runner: new FakeRunner(),
        runnerType: 'fake',
        sandboxProvider: new FakeSandboxProvider(),
        leaseOwner: 'integration-worker',
      });
      await expect(worker.processNext()).resolves.toBe(true);

      const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
      const { events } = (await eventsResponse.json()) as { events: Array<{ type: string }> };
      expect(events.map((event) => event.type)).toEqual([
        'session_created',
        'message_created',
        'message_started',
        'run_started',
        'agent_text_delta',
        'run_completed',
        'message_completed',
      ]);
    } finally {
      await close(server);
    }
  });

  it('accepts generic webhooks with DB-backed source prompts and dedupe', async () => {
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000201',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      promptPrefix: 'bar baz',
      createdAt: now,
      updatedAt: now,
    });

    const server = createServer(loadConfig({ APP_STORE: 'postgres', DATABASE_URL: testDatabaseUrl! }), services);
    const baseUrl = await listen(server);

    try {
      const first = await postJsonWithAuth(`${baseUrl}/webhooks/generic/foo`, 'secret', {
        threadId: 'thread-1',
        dedupeKey: 'delivery-1',
        title: 'Foo task',
        prompt: 'do work',
      });
      expect(first.status).toBe(202);
      const firstBody = await first.json();
      expectGenericWebhookResponse(firstBody);
      expect(firstBody.duplicate).toBe(false);
      expect(firstBody.message?.prompt).toBe('bar baz\n\ndo work');

      const duplicate = await postJsonWithAuth(`${baseUrl}/webhooks/generic/foo`, 'secret', {
        threadId: 'thread-1',
        dedupeKey: 'delivery-1',
        prompt: 'do work again',
      });
      expect(duplicate.status).toBe(202);
      const duplicateBody = await duplicate.json();
      expectGenericWebhookResponse(duplicateBody);
      expect(duplicateBody).toMatchObject({ duplicate: true });

      const followUp = await postJsonWithAuth(`${baseUrl}/webhooks/generic/foo`, 'secret', {
        threadId: 'thread-1',
        dedupeKey: 'delivery-2',
        prompt: 'follow up',
      });
      const followUpBody = await followUp.json();
      expectGenericWebhookResponse(followUpBody);
      expect(followUpBody.session?.id).toBe(firstBody.session?.id);

      await expect(postJsonWithAuth(`${baseUrl}/webhooks/generic/foo`, 'wrong', {
        threadId: 'thread-2',
        dedupeKey: 'delivery-3',
        prompt: 'nope',
      })).resolves.toMatchObject({ status: 401 });
    } finally {
      await close(server);
    }
  });
});

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postJsonWithAuth(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://${address.address}:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
