import { createServices } from '../../src/app/server.js';
import { MemoryStore } from '../../src/store/memory.js';

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
  });
});
