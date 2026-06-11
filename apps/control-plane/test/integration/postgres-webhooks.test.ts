import { createServer, createServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import type { PostgresStore } from '../../src/store/postgres.js';
import { expectGenericWebhookResponse } from '../support/contracts.js';
import { closeServer, listen, postJsonWithAuth } from '../support/http.js';
import { setupPostgresStoreSuite, testDatabaseUrl } from '../support/postgres-store-suite.js';

describe.skipIf(!testDatabaseUrl)('Postgres webhook persistence', () => {
  let store: PostgresStore;
  let databaseUrl: string;

  setupPostgresStoreSuite('postgres_webhooks', (context) => {
    store = context.store;
    databaseUrl = context.databaseUrl;
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
    const server = createServer(
      loadConfig({ API_AUTH_MODE: 'none', APP_DATA_STORE: 'postgres', DATABASE_URL: databaseUrl }),
      services,
    );
    const baseUrl = await listen(server);

    try {
      const first = await postJsonWithAuth(`${baseUrl}/webhooks/generic/foo`, 'secret', {
        thread: { externalId: 'thread-1' },
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
        thread: { externalId: 'thread-1' },
        dedupeKey: 'delivery-1',
        prompt: 'do work again',
      });
      expect(duplicate.status).toBe(202);
      const duplicateBody = await duplicate.json();
      expectGenericWebhookResponse(duplicateBody);
      expect(duplicateBody).toMatchObject({ duplicate: true });

      const followUp = await postJsonWithAuth(`${baseUrl}/webhooks/generic/foo`, 'secret', {
        thread: { externalId: 'thread-1' },
        dedupeKey: 'delivery-2',
        prompt: 'follow up',
      });
      const followUpBody = await followUp.json();
      expectGenericWebhookResponse(followUpBody);
      expect(followUpBody.session?.id).toBe(firstBody.session?.id);

      await expect(
        postJsonWithAuth(`${baseUrl}/webhooks/generic/foo`, 'wrong', {
          thread: { externalId: 'thread-2' },
          dedupeKey: 'delivery-3',
          prompt: 'nope',
        }),
      ).resolves.toMatchObject({ status: 401 });

      const concurrentPayload = {
        thread: { externalId: 'thread-concurrent' },
        dedupeKey: 'delivery-concurrent',
        prompt: 'do work once',
      };
      const concurrent = await Promise.all([
        postJsonWithAuth(`${baseUrl}/webhooks/generic/foo`, 'secret', concurrentPayload),
        postJsonWithAuth(`${baseUrl}/webhooks/generic/foo`, 'secret', concurrentPayload),
      ]);
      const concurrentBodies = (await Promise.all(concurrent.map((response) => response.json()))) as Array<{
        duplicate: boolean;
        session: { id: string };
      }>;
      expect(concurrentBodies.map((body) => body.duplicate).sort()).toEqual([false, true]);
      const concurrentAccepted = concurrentBodies.find((body) => !body.duplicate)!;
      await expect(store.getMessages(concurrentAccepted.session.id)).resolves.toHaveLength(1);
    } finally {
      await closeServer(server);
    }
  });

  it('does not reclaim received deliveries but retries failed deliveries and dedupes processed ones', async () => {
    const now = new Date('2026-05-14T00:00:00.000Z');
    const staleReceivedBefore = new Date(now.getTime() - 15 * 60_000);

    const received = await store.createIntegrationDelivery({
      id: '00000000-0000-4000-8000-000000000301',
      source: 'github',
      dedupeKey: 'received-delivery',
      receivedAt: now,
      staleReceivedBefore,
      metadata: { attempt: 1 },
    });
    expect(received).toMatchObject({ status: 'received', metadata: { attempt: 1 } });
    await expect(
      store.createIntegrationDelivery({
        id: '00000000-0000-4000-8000-000000000302',
        source: 'github',
        dedupeKey: 'received-delivery',
        receivedAt: new Date(now.getTime() + 1_000),
        staleReceivedBefore,
        metadata: { attempt: 2 },
      }),
    ).resolves.toBeNull();
    await expect(
      store.createIntegrationDelivery({
        id: '00000000-0000-4000-8000-000000000302',
        source: 'github',
        dedupeKey: 'received-delivery',
        receivedAt: new Date(now.getTime() + 1_000),
        staleReceivedBefore: new Date(now.getTime() + 1),
        metadata: { attempt: 2 },
      }),
    ).resolves.toBeNull();

    const failed = await store.createIntegrationDelivery({
      id: '00000000-0000-4000-8000-000000000303',
      source: 'github',
      dedupeKey: 'failed-delivery',
      receivedAt: now,
      staleReceivedBefore,
      metadata: { attempt: 1 },
    });
    await expect(
      store.markIntegrationDeliveryFailed({
        id: failed!.id,
        source: 'github',
        dedupeKey: 'failed-delivery',
        failedAt: new Date(now.getTime() + 1_000),
        error: 'temporary_failure',
      }),
    ).resolves.toBe(true);
    const failedRetry = await store.createIntegrationDelivery({
      id: '00000000-0000-4000-8000-000000000304',
      source: 'github',
      dedupeKey: 'failed-delivery',
      receivedAt: new Date(now.getTime() + 2_000),
      staleReceivedBefore,
      metadata: { attempt: 2 },
    });
    expect(failedRetry).toMatchObject({ status: 'received', metadata: { attempt: 2 } });
    expect(failedRetry?.processedAt).toBeUndefined();
    expect(failedRetry?.error).toBeUndefined();

    await expect(
      store.markIntegrationDeliveryProcessed({
        id: failedRetry!.id,
        source: 'github',
        dedupeKey: 'failed-delivery',
        processedAt: new Date(now.getTime() + 3_000),
      }),
    ).resolves.toBe(true);
    await expect(
      store.createIntegrationDelivery({
        id: '00000000-0000-4000-8000-000000000305',
        source: 'github',
        dedupeKey: 'failed-delivery',
        receivedAt: new Date(now.getTime() + 4_000),
        staleReceivedBefore,
        metadata: { attempt: 3 },
      }),
    ).resolves.toBeNull();
  });

  it('fences integration delivery status updates by active lease', async () => {
    const now = new Date('2026-05-14T00:00:00.000Z');
    const first = await store.createIntegrationDelivery({
      id: '00000000-0000-4000-8000-000000000306',
      source: 'github',
      dedupeKey: 'fenced-delivery',
      receivedAt: now,
      staleReceivedBefore: new Date(now.getTime() - 1),
      metadata: { attempt: 1 },
    });
    await expect(
      store.markIntegrationDeliveryProcessed({
        id: first!.id,
        source: 'github',
        dedupeKey: 'fenced-delivery',
        processedAt: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toBe(true);
    await expect(
      store.markIntegrationDeliveryFailed({
        id: first!.id,
        source: 'github',
        dedupeKey: 'fenced-delivery',
        failedAt: new Date(now.getTime() + 2_000),
        error: 'late_failure',
      }),
    ).resolves.toBe(false);

    await expect(
      store.createIntegrationDelivery({
        id: '00000000-0000-4000-8000-000000000307',
        source: 'github',
        dedupeKey: 'fenced-delivery',
        receivedAt: new Date(now.getTime() + 3_000),
        staleReceivedBefore: new Date(now.getTime() + 3_000),
        metadata: { attempt: 2 },
      }),
    ).resolves.toBeNull();
  });

  it('reports lost integration delivery finalization leases', async () => {
    const now = new Date('2026-05-14T00:00:00.000Z');
    const delivery = await store.createIntegrationDelivery({
      id: '00000000-0000-4000-8000-000000000308',
      source: 'github',
      dedupeKey: 'lost-lease-delivery',
      receivedAt: now,
      staleReceivedBefore: new Date(now.getTime() - 1),
      metadata: {},
    });

    await expect(
      store.markIntegrationDeliveryProcessed({
        id: '00000000-0000-4000-8000-000000000309',
        source: 'github',
        dedupeKey: 'lost-lease-delivery',
        processedAt: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toBe(false);
    await expect(
      store.markIntegrationDeliveryProcessed({
        id: delivery!.id,
        source: 'github',
        dedupeKey: 'lost-lease-delivery',
        processedAt: new Date(now.getTime() + 2_000),
      }),
    ).resolves.toBe(true);
  });
});
