import { createServices } from '../../src/app/server.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('store archive queue behavior', () => {
  it('does not claim pending messages for archived sessions', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Archived queue' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'do not run' });
    await services.sessions.archive(session.id);

    await expect(store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000001001',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    })).resolves.toBeNull();
  });
});
