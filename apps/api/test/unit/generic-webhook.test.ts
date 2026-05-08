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
        threadId: 'thread-1',
        dedupeKey: 'delivery-1',
        title: 'Foo task',
        prompt: 'do work',
      },
    });
    const second = await services.genericWebhooks.handle({
      sourceKey: 'foo',
      authorization: 'Bearer secret',
      payload: {
        threadId: 'thread-1',
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

    const payload = { threadId: 'thread-1', dedupeKey: 'delivery-1', prompt: 'do work' };
    const first = await services.genericWebhooks.handle({ sourceKey: 'foo', authorization: 'Bearer secret', payload });
    const duplicate = await services.genericWebhooks.handle({ sourceKey: 'foo', authorization: 'Bearer secret', payload });

    expect(first.duplicate).toBe(false);
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true });
    await expect(services.messages.list(first.session!.id)).resolves.toHaveLength(1);
  });
});
