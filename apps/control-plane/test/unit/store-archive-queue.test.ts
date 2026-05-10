import { createServices } from '../../src/app/server.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('store archive queue behavior', () => {
  it('marks sessions as queued while messages are pending', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Queued session' });

    const message = await services.messages.enqueue({ sessionId: session.id, prompt: 'do run' });

    await expect(services.sessions.get(session.id)).resolves.toMatchObject({ status: 'queued' });
    await services.messages.cancelPending({ sessionId: session.id, messageId: message.id });
    await expect(services.sessions.get(session.id)).resolves.toMatchObject({ status: 'idle' });
  });

  it('keeps active sessions active when follow-up messages are queued', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Active queue' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });
    await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000001002',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });

    await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });

    await expect(services.sessions.get(session.id)).resolves.toMatchObject({ status: 'active' });
  });

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
