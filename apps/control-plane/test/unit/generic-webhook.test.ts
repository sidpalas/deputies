import { createServices } from '../../src/app/server.js';
import { markIntegrationDeliveryProcessed } from '../../src/integrations/shared-utils.js';
import { MemoryStore } from '../../src/store/memory.js';
import { defaultGroupId } from '../../src/store/types.js';

describe('GenericWebhookService', () => {
  it('applies source prompt prefix and reuses external threads', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000101',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      promptPrefix: 'bar baz',
      createdAt: now,
      updatedAt: now,
    });

    const first = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload: {
        thread: { externalId: 'thread-1' },
        dedupeKey: 'delivery-1',
        title: 'Foo task',
        prompt: 'do work',
      },
    });
    const second = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload: {
        thread: { externalId: 'thread-1' },
        dedupeKey: 'delivery-2',
        prompt: 'follow up',
      },
    });

    expect(first.session?.id).toBe(second.session?.id);
    expect(first.session?.tags).toEqual(['webhook']);
    await expect(services.messages.list(first.session!.id)).resolves.toMatchObject([
      { prompt: 'bar baz\n\ndo work', source: 'generic:foo' },
      { prompt: 'bar baz\n\nfollow up', source: 'generic:foo' },
    ]);
  });

  it('deduplicates deliveries', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000102',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      createdAt: now,
      updatedAt: now,
    });

    const payload = { thread: { externalId: 'thread-1' }, dedupeKey: 'delivery-1', prompt: 'do work' };
    const first = await services.genericWebhooks.handle({ sourceKey: 'foo', authorization: 'Bearer secret', payload });
    const duplicate = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload,
    });

    expect(first.duplicate).toBe(false);
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true });
    await expect(services.messages.list(first.session!.id)).resolves.toHaveLength(1);
  });

  it.each<[string, string | undefined]>([
    ['same-length wrong token', 'Bearer secreX'],
    ['different-length wrong token', 'Bearer wrong-secret'],
    ['missing authorization', undefined],
  ])('rejects %s', async (_label, authorization) => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000108',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      services.genericWebhooks.handle({
        sourceKey: 'foo',
        authorization,
        payload: { thread: { externalId: 'thread-1' }, dedupeKey: 'delivery-1', prompt: 'do work' },
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('does not reclaim received deliveries and keeps failed retries and processed deliveries idempotent', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000104',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      createdAt: now,
      updatedAt: now,
    });

    await store.createIntegrationDelivery({
      id: '00000000-0000-4000-8000-000000000111',
      source: 'foo',
      dedupeKey: 'received-delivery',
      receivedAt: new Date(now.getTime() - 16 * 60_000),
      staleReceivedBefore: new Date(now.getTime() - 15 * 60_000),
      metadata: {},
    });
    const receivedRetry = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload: { thread: { externalId: 'thread-1' }, dedupeKey: 'received-delivery', prompt: 'retry received' },
    });

    const failedDelivery = await store.createIntegrationDelivery({
      id: '00000000-0000-4000-8000-000000000112',
      source: 'foo',
      dedupeKey: 'failed-delivery',
      receivedAt: now,
      staleReceivedBefore: new Date(now.getTime() - 15 * 60_000),
      metadata: {},
    });
    await store.markIntegrationDeliveryFailed({
      id: failedDelivery!.id,
      source: 'foo',
      dedupeKey: 'failed-delivery',
      failedAt: now,
      error: 'temporary_failure',
    });
    const failedRetry = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload: { thread: { externalId: 'thread-1' }, dedupeKey: 'failed-delivery', prompt: 'retry failed' },
    });

    const processed = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload: { thread: { externalId: 'thread-1' }, dedupeKey: 'processed-delivery', prompt: 'process once' },
    });
    const processedDuplicate = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload: { thread: { externalId: 'thread-1' }, dedupeKey: 'processed-delivery', prompt: 'process twice' },
    });

    expect(receivedRetry).toMatchObject({ accepted: true, duplicate: true });
    expect(failedRetry.duplicate).toBe(false);
    expect(processed.duplicate).toBe(false);
    expect(processedDuplicate).toMatchObject({ accepted: true, duplicate: true });
    await expect(services.messages.list(failedRetry.session!.id)).resolves.toHaveLength(2);
  });

  it('surfaces lost integration delivery finalization leases', async () => {
    const store = new MemoryStore();
    const now = new Date();
    const delivery = await store.createIntegrationDelivery({
      id: '00000000-0000-4000-8000-000000000118',
      source: 'foo',
      dedupeKey: 'delivery-1',
      receivedAt: now,
      staleReceivedBefore: new Date(now.getTime() - 1),
      metadata: {},
    });

    await expect(
      markIntegrationDeliveryProcessed(store, {
        id: '00000000-0000-4000-8000-000000000119',
        source: 'foo',
        dedupeKey: 'delivery-1',
      }),
    ).rejects.toThrow('Integration delivery lease lost before processing completed');
    await expect(
      store.markIntegrationDeliveryProcessed({
        id: delivery!.id,
        source: 'foo',
        dedupeKey: 'delivery-1',
        processedAt: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toBe(true);
  });

  it('does not process concurrent duplicate deliveries twice', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000105',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      createdAt: now,
      updatedAt: now,
    });

    const payload = { thread: { externalId: 'thread-1' }, dedupeKey: 'delivery-1', prompt: 'do work' };
    const results = await Promise.all([
      services.genericWebhooks.handle({ sourceKey: 'foo', authorization: 'Bearer secret', payload }),
      services.genericWebhooks.handle({ sourceKey: 'foo', authorization: 'Bearer secret', payload }),
    ]);

    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    const accepted = results.find((result) => !result.duplicate)!;
    await expect(services.messages.list(accepted.session!.id)).resolves.toHaveLength(1);
  });

  it('does not let stale failures regress processed deliveries', async () => {
    const store = new MemoryStore();
    const now = new Date();
    const delivery = await store.createIntegrationDelivery({
      id: '00000000-0000-4000-8000-000000000106',
      source: 'foo',
      dedupeKey: 'delivery-1',
      receivedAt: now,
      staleReceivedBefore: new Date(now.getTime() - 1),
      metadata: {},
    });

    await store.markIntegrationDeliveryProcessed({
      id: delivery!.id,
      source: 'foo',
      dedupeKey: 'delivery-1',
      processedAt: new Date(now.getTime() + 1_000),
    });
    await store.markIntegrationDeliveryFailed({
      id: delivery!.id,
      source: 'foo',
      dedupeKey: 'delivery-1',
      failedAt: new Date(now.getTime() + 2_000),
      error: 'late_failure',
    });

    await expect(
      store.createIntegrationDelivery({
        id: '00000000-0000-4000-8000-000000000107',
        source: 'foo',
        dedupeKey: 'delivery-1',
        receivedAt: new Date(now.getTime() + 3_000),
        staleReceivedBefore: new Date(now.getTime() + 3_000),
        metadata: {},
      }),
    ).resolves.toBeNull();
  });

  it('accepts the shared integration ingress fields', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000103',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      createdAt: now,
      updatedAt: now,
    });

    const result = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload: {
        thread: { externalId: 'thread-1', metadata: { project: 'alpha' } },
        dedupeKey: 'delivery-1',
        title: 'Foo task',
        prompt: 'do work',
        actor: { type: 'user', externalId: 'user-1', displayName: 'User One' },
        repository: { provider: 'github', owner: 'acme', repo: 'widget' },
        callback: { type: 'http', url: 'https://example.com/callback' },
        context: { priority: 'high' },
      },
    });

    expect(result.accepted).toBe(true);
    const [message] = await services.messages.list(result.session!.id);
    expect(message?.context).toMatchObject({
      source: 'foo',
      integration: {
        source: 'foo',
        thread: { source: 'foo', externalId: 'thread-1' },
        dedupeKey: 'delivery-1',
        actor: { type: 'user', externalId: 'user-1', displayName: 'User One' },
      },
      repository: { provider: 'github', owner: 'acme', repo: 'widget' },
      callback: { type: 'http', url: 'https://example.com/callback' },
      webhook: { sourceName: 'Foo', context: { priority: 'high' } },
      priority: 'high',
    });
  });

  it.each([
    ['owner hyphen and repo dot', 'acme-inc', 'widget.api'],
    ['single-character names', 'a', 'b'],
    ['repo punctuation', 'acme', '.github_repo-1'],
  ])('accepts valid GitHub repository payloads with %s', async (_label, owner, repo) => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000106',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      createdAt: now,
      updatedAt: now,
    });

    const result = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload: {
        thread: { externalId: 'thread-1' },
        dedupeKey: 'delivery-1',
        prompt: 'do work',
        repository: { provider: 'github', owner, repo },
      },
    });

    expect(result.accepted).toBe(true);
    const [message] = await services.messages.list(result.session!.id);
    expect(message?.context?.repository).toEqual({ provider: 'github', owner, repo });
  });

  it.each([
    ['owner with trailing slash', 'acme/', 'widget'],
    ['repo with trailing slash', 'acme', 'widget/'],
    ['repo with git suffix', 'acme', 'widget.git'],
    ['owner with whitespace', ' acme', 'widget'],
    ['repo with whitespace', 'acme', 'widget '],
    ['owner', '-bad', 'widget'],
    ['repo', 'acme', '..'],
  ])('rejects invalid GitHub repository %s in payloads', async (_field, owner, repo) => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000107',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      services.genericWebhooks.handle({
        sourceKey: 'foo',
        authorization: 'Bearer secret',
        payload: {
          thread: { externalId: 'thread-1' },
          dedupeKey: 'delivery-1',
          prompt: 'do work',
          repository: { provider: 'github', owner, repo },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('does not let generic webhook context override reserved integration fields', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000104',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      createdAt: now,
      updatedAt: now,
    });

    const result = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload: {
        thread: { externalId: 'thread-1' },
        dedupeKey: 'delivery-1',
        prompt: 'do work',
        callback: { type: 'http', url: 'https://example.com/callback' },
        context: {
          source: 'github',
          integration: { source: 'github', thread: { source: 'github', externalId: 'spoofed' } },
          repository: { provider: 'github', owner: 'spoofed', repo: 'repo' },
          callback: { type: 'github', owner: 'spoofed', repo: 'repo', issueNumber: 1 },
          webhook: { sourceName: 'Spoofed' },
          skills: ['untrusted-skill'],
          fakeArtifact: { type: 'external_link', url: 'https://example.com/artifact' },
        },
      },
    });

    const [message] = await services.messages.list(result.session!.id);
    expect(message?.context).toMatchObject({
      source: 'foo',
      integration: { source: 'foo', thread: { source: 'foo', externalId: 'thread-1' } },
      callback: { type: 'http', url: 'https://example.com/callback' },
      webhook: { sourceName: 'Foo' },
      fakeArtifact: { type: 'external_link', url: 'https://example.com/artifact' },
    });
    expect(message?.context).not.toMatchObject({ repository: { owner: 'spoofed' } });
    expect(message?.context).not.toHaveProperty('skills');
    expect(message?.context?.webhook).not.toMatchObject({ context: { skills: ['untrusted-skill'] } });
  });

  it('does not convert disabled or archived skill tokens into trusted webhook context', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.createWebhookSource({
      id: '00000000-0000-4000-8000-000000000120',
      key: 'foo',
      name: 'Foo',
      enabled: true,
      bearerToken: 'secret',
      createdAt: now,
      updatedAt: now,
    });
    const archived = await services.skills.create({
      name: 'archived-webhook',
      description: 'Archived',
      body: '',
      ownerGroupId: defaultGroupId,
    });
    await services.skills.archive(archived.id);
    const disabled = await services.skills.create({
      name: 'disabled-webhook',
      description: 'Disabled',
      body: '',
      ownerGroupId: defaultGroupId,
    });
    await services.skills.update({ id: disabled.id, enabled: false });

    for (const name of ['archived-webhook', 'disabled-webhook']) {
      const result = await services.genericWebhooks.handle({
        sourceKey: 'foo',
        authorization: 'Bearer secret',
        skillsEnabled: true,
        payload: {
          thread: { externalId: `thread-${name}` },
          dedupeKey: `delivery-${name}`,
          prompt: `/${name} keep this`,
          context: { skills: [name] },
        },
      });
      expect(result.message?.prompt).toBe(`/${name} keep this`);
      expect(result.message?.context).not.toHaveProperty('skills');
    }
  });

  it.each(['http://localhost/callback', 'http://[::ffff:127.0.0.1]/callback'])(
    'rejects unsafe HTTP callback targets at ingress: %s',
    async (url) => {
      const store = new MemoryStore();
      const services = createServices(store);
      const now = new Date();
      await store.createWebhookSource({
        id: '00000000-0000-4000-8000-000000000105',
        key: 'foo',
        name: 'Foo',
        enabled: true,
        bearerToken: 'secret',
        createdAt: now,
        updatedAt: now,
      });

      await expect(
        services.genericWebhooks.handle({
          sourceKey: 'foo',
          authorization: 'Bearer secret',
          payload: {
            thread: { externalId: 'thread-1' },
            dedupeKey: 'delivery-1',
            prompt: 'do work',
            callback: { type: 'http', url },
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    },
  );
});
