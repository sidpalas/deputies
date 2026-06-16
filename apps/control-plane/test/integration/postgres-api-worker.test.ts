import type { CompletionCallbackSender } from '../../src/callbacks/service.js';
import { createServer, createServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';
import { PostgresStore, type PostgresEventListener } from '../../src/store/postgres.js';
import { startWorkerLoop, WorkerService, type WorkerLoopHandle } from '../../src/worker/service.js';
import { closeServer, listen, postJson, waitFor } from '../support/http.js';
import { setupPostgresStoreSuite, testDatabaseUrl } from '../support/postgres-store-suite.js';

describe.skipIf(!testDatabaseUrl)('Postgres API and worker integration', () => {
  let store: PostgresStore;
  let databaseUrl: string;

  setupPostgresStoreSuite('postgres_api_worker', (context) => {
    store = context.store;
    databaseUrl = context.databaseUrl;
  });

  it('processes an HTTP-created message through the worker using Postgres', async () => {
    const services = createServices(store);
    const server = createServer(
      loadConfig({ API_AUTH_MODE: 'none', APP_DATA_STORE: 'postgres', DATABASE_URL: databaseUrl }),
      services,
    );
    const baseUrl = await listen(server);

    try {
      const createSession = await postJson(`${baseUrl}/sessions`, { title: 'HTTP worker' });
      const { session } = (await createSession.json()) as { session: { id: string } };

      const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, { prompt: 'ship it' });
      expect(createMessage.status).toBe(202);

      const worker = new WorkerService({
        store,
        events: services.events,
        artifacts: services.artifacts,
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
      await closeServer(server);
    }
  });

  it('accepts concurrent writes through multiple API replicas sharing Postgres', async () => {
    const replicaStoreA = new PostgresStore(databaseUrl);
    const replicaStoreB = new PostgresStore(databaseUrl);
    const serverA = createServer(
      loadConfig({ API_AUTH_MODE: 'none', APP_DATA_STORE: 'postgres', DATABASE_URL: databaseUrl }),
      createServices(replicaStoreA),
    );
    const serverB = createServer(
      loadConfig({ API_AUTH_MODE: 'none', APP_DATA_STORE: 'postgres', DATABASE_URL: databaseUrl }),
      createServices(replicaStoreB),
    );
    const [baseUrlA, baseUrlB] = await Promise.all([listen(serverA), listen(serverB)]);

    try {
      const createSession = await postJson(`${baseUrlA}/sessions`, { title: 'Multi API' });
      expect(createSession.status).toBe(201);
      const { session } = (await createSession.json()) as { session: { id: string } };

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          postJson(`${index % 2 === 0 ? baseUrlA : baseUrlB}/sessions/${session.id}/messages`, {
            prompt: `message ${index + 1}`,
          }),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual(new Array(20).fill(202));

      const messagesResponse = await fetch(`${baseUrlB}/sessions/${session.id}/messages`);
      const { messages } = (await messagesResponse.json()) as { messages: Array<{ sequence: number; status: string }> };
      expect(messages).toHaveLength(20);
      expect(messages.map((message) => message.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      expect(messages.every((message) => message.status === 'pending')).toBe(true);
    } finally {
      await Promise.all([closeServer(serverA), closeServer(serverB)]);
      await Promise.all([replicaStoreA.close(), replicaStoreB.close()]);
    }
  });

  it('wakes a worker loop on callback retry scheduled events from another Postgres connection', async () => {
    const apiStore = new PostgresStore(databaseUrl);
    const workerStore = new PostgresStore(databaseUrl);
    const apiServices = createServices(apiStore);
    const workerServices = createServices(workerStore);
    let listener: PostgresEventListener | undefined;
    let loop: WorkerLoopHandle | undefined;
    let processNextCalls = 0;
    let deliveryAttempts = 0;
    const sender: CompletionCallbackSender = {
      type: 'http',
      async deliver() {
        deliveryAttempts += 1;
      },
    };

    try {
      const worker = new WorkerService({
        store: workerStore,
        events: workerServices.events,
        artifacts: workerServices.artifacts,
        runner: new FakeRunner(),
        runnerType: 'fake',
        sandboxProvider: new FakeSandboxProvider(),
        leaseOwner: 'callback-retry-worker',
        callbackSenders: [sender],
      });
      loop = startWorkerLoop(
        {
          async processNext() {
            processNextCalls += 1;
            return worker.processNext();
          },
        },
        60_000,
      );
      listener = await workerStore.listenEvents((event) => {
        if (event.type === 'callback_retry_scheduled') loop?.wake();
      });
      await waitFor(() => Promise.resolve(processNextCalls === 1));

      const session = await apiServices.sessions.create({ title: 'Callback retry wake' });
      const now = new Date();
      const delivery = await apiStore.createCallbackDelivery({
        id: '00000000-0000-4000-8000-000000000401',
        sessionId: session.id,
        targetType: 'http',
        target: { url: 'https://example.com/callback' },
        eventType: 'message_completed',
        payload: {
          event: 'message_completed',
          sessionId: session.id,
          runId: '00000000-0000-4000-8000-000000000402',
          messageId: '00000000-0000-4000-8000-000000000403',
          text: 'completed',
          artifacts: [],
        },
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
      });

      await apiServices.events.append({
        sessionId: session.id,
        type: 'callback_retry_scheduled',
        payload: {
          deliveryId: delivery.id,
          error: 'previous attempt failed',
          targetType: delivery.targetType,
          attempts: delivery.attempts,
          nextAttemptAt: now.toISOString(),
        },
      });

      await waitFor(async () => {
        const deliveries = await apiStore.listCallbackDeliveries({ sessionId: session.id });
        const storedDelivery = deliveries.find((candidate) => candidate.id === delivery.id);
        return storedDelivery?.status === 'sent' && storedDelivery.attempts === 1;
      }, 3_000);
      await expect(apiStore.listCallbackDeliveries({ sessionId: session.id })).resolves.toMatchObject([
        { id: delivery.id, status: 'sent', attempts: 1 },
      ]);
    } finally {
      await loop?.stop();
      await listener?.close();
      await Promise.all([apiStore.close(), workerStore.close()]);
    }
  });
});
