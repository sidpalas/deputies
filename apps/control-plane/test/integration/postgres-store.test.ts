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
      'TRUNCATE flue_sessions, callback_deliveries, artifacts, integration_deliveries, external_threads, sandboxes, events, runs, messages, session_sequence_counters, webhook_sources, sessions RESTART IDENTITY CASCADE',
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
      status: 'queued',
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
        version: 3,
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

  it('persists active sandbox lifecycle state', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Sandbox state' });
    const now = new Date();

    const created = await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000701',
      sessionId: session.id,
      provider: 'fake',
      providerSandboxId: 'fake-sandbox-1',
      status: 'ready',
      workspacePath: '/workspace',
      metadata: { target: 'test' },
      createdAt: now,
      updatedAt: now,
    });

    await expect(store.getActiveSandbox(session.id, 'fake')).resolves.toMatchObject({
      id: created.id,
      providerSandboxId: 'fake-sandbox-1',
      status: 'ready',
      metadata: { target: 'test' },
    });
    await expect(store.listActiveSandboxes(session.id, 'fake')).resolves.toMatchObject([{ id: created.id }]);
    await expect(store.listIdleSandboxes({ provider: 'fake', idleBefore: new Date(now.getTime() + 1_000), limit: 10 })).resolves.toMatchObject([{ id: created.id }]);
    await expect(store.listStoppableSandboxes({ provider: 'fake', idleBefore: new Date(now.getTime() + 1_000), limit: 10 })).resolves.toMatchObject([{ id: created.id }]);

    const checkedAt = new Date(now.getTime() + 1_000);
    await store.updateSandbox({
      ...created,
      status: 'unhealthy',
      lastHealthCheckAt: checkedAt,
      updatedAt: checkedAt,
    });
    await expect(store.getActiveSandbox(session.id, 'fake')).resolves.toMatchObject({
      status: 'unhealthy',
      lastHealthCheckAt: checkedAt,
    });

    await store.updateSandbox({
      ...created,
      status: 'stopped',
      lastHealthCheckAt: checkedAt,
      updatedAt: new Date(now.getTime() + 2_000),
    });
    await expect(store.getActiveSandbox(session.id, 'fake')).resolves.toMatchObject({
      status: 'stopped',
    });

    await store.updateSandbox({
      ...created,
      status: 'destroyed',
      destroyedAt: checkedAt,
      updatedAt: checkedAt,
    });
    await expect(store.getActiveSandbox(session.id, 'fake')).resolves.toBeNull();
    await expect(store.listIdleSandboxes({ provider: 'fake', idleBefore: new Date(now.getTime() + 3_000), limit: 10 })).resolves.toEqual([]);
  });

  it('claims pending messages as a queue batch and respects queue pause', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres queue' });
    const first = await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });
    const second = await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });

    await services.sessions.pauseQueue(session.id);
    await expect(store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000901',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    })).resolves.toBeNull();

    await expect(services.messages.updatePending({ sessionId: session.id, messageId: second.id, prompt: 'edited second' })).resolves.toMatchObject({ prompt: 'edited second' });
    await services.sessions.resumeQueue(session.id);

    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000902',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });

    expect(claimed?.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(claimed?.messages.map((message) => message.prompt)).toEqual(['first', 'edited second']);
    expect(claimed?.run.metadata).toMatchObject({ messageIds: [first.id, second.id], sequences: [1, 2] });

    const completed = await store.completeRunBatch({ runId: claimed!.run.id, completedAt: new Date() });
    expect(completed.messages.map((message) => message.status)).toEqual(['completed', 'completed']);
  });

  it('does not claim pending messages for archived sessions', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres archived queue' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'do not run' });
    await services.sessions.archive(session.id);

    await expect(store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-0000000009a1',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    })).resolves.toBeNull();
  });

  it('keeps cancelling postgres run batches active until finalized', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres cancel' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });

    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000903',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    expect(claimed?.messages).toHaveLength(2);
    if (!claimed) throw new Error('Expected batch to be claimed');

    const cancelling = await store.requestRunCancellation({ sessionId: session.id, requestedAt: new Date(), error: 'cancelled by test' });

    expect(cancelling?.run.status).toBe('cancelling');
    expect(cancelling?.messages.map((message) => message.status)).toEqual(['cancelling', 'cancelling']);
    await services.messages.enqueue({ sessionId: session.id, prompt: 'third' });
    await expect(store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000904',
      runnerType: 'fake',
      leaseOwner: 'worker-2',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    })).resolves.toBeNull();

    const cancelled = await store.finalizeRunCancellation({ runId: claimed.run.id, cancelledAt: new Date(), error: 'cancelled by test' });
    expect(cancelled.messages.map((message) => message.status)).toEqual(['cancelled', 'cancelled']);
    await expect(store.getRun(claimed.run.id)).resolves.toMatchObject({ status: 'cancelled', error: 'cancelled by test' });
    await expect(services.sessions.get(session.id)).resolves.toMatchObject({ status: 'queued' });
  });

  it('runs postgres advisory locks on only one holder', async () => {
    const locked = await store.withAdvisoryLock(12345, async () => {
      const competing = new PostgresStore(testDatabaseUrl!);
      try {
        return competing.withAdvisoryLock(12345, async () => 'competing');
      } finally {
        await competing.close();
      }
    });

    expect(locked).toBeNull();
    await expect(store.withAdvisoryLock(12345, async () => 'released')).resolves.toBe('released');
  });

  it('persists artifacts and callback deliveries', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Outputs' });
    const message = await services.messages.enqueue({ sessionId: session.id, prompt: 'produce output' });
    const now = new Date();

    const artifact = await store.createArtifact({
      id: '00000000-0000-4000-8000-000000000801',
      sessionId: session.id,
      messageId: message.id,
      type: 'external_link',
      url: 'https://example.com/result',
      payload: { ok: true },
      createdAt: now,
    });
    await expect(store.getArtifacts(session.id)).resolves.toMatchObject([{ id: artifact.id, url: 'https://example.com/result' }]);

    const delivery = await store.createCallbackDelivery({
      id: '00000000-0000-4000-8000-000000000802',
      sessionId: session.id,
      messageId: message.id,
      targetType: 'http',
      target: { url: 'https://example.com/callback' },
      eventType: 'message_completed',
      payload: { text: 'done' },
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
    expect(delivery.status).toBe('pending');

    await store.claimDueCallbackDeliveries({ now, limit: 1 });
    const sent = await store.markCallbackDeliverySent({ id: delivery.id, deliveredAt: new Date(now.getTime() + 1_000) });
    expect(sent).toMatchObject({ status: 'sent', attempts: 1 });

    await expect(store.listCallbackDeliveries({ sessionId: session.id })).resolves.toMatchObject([{ id: delivery.id, status: 'sent' }]);
  });

  it('requeues failed callback deliveries for replay', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Callback replay' });
    const now = new Date();
    const delivery = await store.createCallbackDelivery({
      id: '00000000-0000-4000-8000-000000000803',
      sessionId: session.id,
      targetType: 'http',
      target: { url: 'https://example.com/callback' },
      eventType: 'message_completed',
      payload: { text: 'done' },
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      maxAttempts: 1,
    });
    await store.claimDueCallbackDeliveries({ now, limit: 1 });
    await store.markCallbackDeliveryFailed({ id: delivery.id, failedAt: now, error: 'down', terminal: true });

    const replay = await store.requestCallbackReplay({ sessionId: session.id, deliveryId: delivery.id, requestedAt: new Date(now.getTime() + 1_000) });

    expect(replay).toMatchObject({ id: delivery.id, status: 'pending', attempts: 1 });
    await expect(store.claimDueCallbackDeliveries({ now: new Date(now.getTime() + 1_000), limit: 1 })).resolves.toMatchObject([{ id: delivery.id, status: 'sending' }]);
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
    const server = createServer(loadConfig({ API_AUTH_MODE: 'none', APP_STORE: 'postgres', DATABASE_URL: testDatabaseUrl! }), services);
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
        'sandbox_starting',
        'sandbox_ready',
        'run_started',
        'agent_text_delta',
        'run_completed',
        'agent_response_final',
        'message_completed',
      ]);
    } finally {
      await close(server);
    }
  });

  it('accepts concurrent writes through multiple API replicas sharing Postgres', async () => {
    const replicaStoreA = new PostgresStore(testDatabaseUrl!);
    const replicaStoreB = new PostgresStore(testDatabaseUrl!);
    const serverA = createServer(loadConfig({ API_AUTH_MODE: 'none', APP_STORE: 'postgres', DATABASE_URL: testDatabaseUrl! }), createServices(replicaStoreA));
    const serverB = createServer(loadConfig({ API_AUTH_MODE: 'none', APP_STORE: 'postgres', DATABASE_URL: testDatabaseUrl! }), createServices(replicaStoreB));
    const [baseUrlA, baseUrlB] = await Promise.all([listen(serverA), listen(serverB)]);

    try {
      const createSession = await postJson(`${baseUrlA}/sessions`, { title: 'Multi API' });
      expect(createSession.status).toBe(201);
      const { session } = (await createSession.json()) as { session: { id: string } };

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) => postJson(
          `${index % 2 === 0 ? baseUrlA : baseUrlB}/sessions/${session.id}/messages`,
          { prompt: `message ${index + 1}` },
        )),
      );

      expect(responses.map((response) => response.status)).toEqual(new Array(20).fill(202));

      const messagesResponse = await fetch(`${baseUrlB}/sessions/${session.id}/messages`);
      const { messages } = (await messagesResponse.json()) as { messages: Array<{ sequence: number; status: string }> };
      expect(messages).toHaveLength(20);
      expect(messages.map((message) => message.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      expect(messages.every((message) => message.status === 'pending')).toBe(true);
    } finally {
      await Promise.all([close(serverA), close(serverB)]);
      await Promise.all([replicaStoreA.close(), replicaStoreB.close()]);
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

    const server = createServer(loadConfig({ API_AUTH_MODE: 'none', APP_STORE: 'postgres', DATABASE_URL: testDatabaseUrl! }), services);
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
