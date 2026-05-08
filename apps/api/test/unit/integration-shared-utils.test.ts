import { createServices } from '../../src/app/server.js';
import { getOrCreateExternalThreadSession } from '../../src/integrations/shared-utils.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { AppStore, ExternalThreadRecord } from '../../src/store/types.js';

describe('integration shared utils', () => {
  it('uses the session from the winning external-thread row after a concurrent create', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const winningSession = await services.sessions.create({ title: 'winner' });
    const now = new Date('2026-05-07T00:00:00.000Z');
    const winningThread: ExternalThreadRecord = {
      id: 'thread-1',
      source: 'github',
      externalId: 'acme/widget#42',
      sessionId: winningSession.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    const racingStore = {
      ...store,
      getExternalThread: async () => null,
      createExternalThread: async () => winningThread,
    } as unknown as AppStore;

    const session = await getOrCreateExternalThreadSession(racingStore, services.sessions, {
      source: 'github',
      externalId: 'acme/widget#42',
      metadata: {},
      title: 'loser',
    });

    expect(session.id).toBe(winningSession.id);
    expect(await store.listSessions()).toHaveLength(2);
  });
});
