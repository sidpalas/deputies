import { createServices } from '../../src/app/server.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('store callback recovery', () => {
  it('reclaims stale sending callback deliveries', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Callback recovery' });
    const now = new Date('2026-05-07T00:00:00.000Z');
    await store.createCallbackDelivery({
      id: '00000000-0000-4000-8000-000000001101',
      sessionId: session.id,
      targetType: 'http',
      target: { url: 'https://example.com/callback' },
      eventType: 'message_completed',
      payload: { event: 'message_completed', sessionId: session.id, runId: 'run-1', messageId: 'message-1', text: 'done', artifacts: [] },
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      maxAttempts: 3,
    });

    const first = await store.claimDueCallbackDeliveries({ now, limit: 1 });
    const tooSoon = await store.claimDueCallbackDeliveries({ now: new Date(now.getTime() + 60_000), limit: 1 });
    const stale = await store.claimDueCallbackDeliveries({ now: new Date(now.getTime() + 16 * 60_000), limit: 1 });

    expect(first).toMatchObject([{ status: 'sending', attempts: 1 }]);
    expect(tooSoon).toEqual([]);
    expect(stale).toMatchObject([{ status: 'sending', attempts: 2 }]);
  });
});
