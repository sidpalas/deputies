import { createServices } from '../../src/app/server.js';
import { runSessionSearchIndexerOnce } from '../../src/search/indexer.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('session search indexer', () => {
  it('keeps messages with the same ID in different sessions distinct', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const sharedMessageId = 'shared-message-id';
    const firstSession = await services.sessions.create({ title: 'First duplicate ID session' });
    await services.messages.enqueue({
      id: sharedMessageId,
      sessionId: firstSession.id,
      prompt: 'first duplicate ID prompt',
    });
    const secondSession = await services.sessions.create({ title: 'Second duplicate ID session' });
    await services.messages.enqueue({
      id: sharedMessageId,
      sessionId: secondSession.id,
      prompt: 'second duplicate ID prompt',
    });
    const upsertSearchDocs = vi.spyOn(store, 'upsertSessionSearchDocs');

    await runSessionSearchIndexerOnce({ store, events: services.events });

    expect(upsertSearchDocs).toHaveBeenCalledWith([
      expect.objectContaining({ sessionId: firstSession.id, kind: 'title' }),
      expect.objectContaining({
        sessionId: firstSession.id,
        kind: 'prompt',
        sourceId: sharedMessageId,
        content: 'first duplicate ID prompt',
      }),
      expect.objectContaining({ sessionId: secondSession.id, kind: 'title' }),
      expect.objectContaining({
        sessionId: secondSession.id,
        kind: 'prompt',
        sourceId: sharedMessageId,
        content: 'second duplicate ID prompt',
      }),
    ]);
  });

  it('does not load messages for event batches without message changes', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    await services.sessions.create({ title: 'Title-only event batch' });
    const getMessagesByIds = vi.spyOn(store, 'getMessagesByIds');

    await runSessionSearchIndexerOnce({ store, events: services.events });

    expect(getMessagesByIds).not.toHaveBeenCalled();
  });
});
