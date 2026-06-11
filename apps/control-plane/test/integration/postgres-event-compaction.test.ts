import { createServices } from '../../src/app/server.js';
import type { PostgresStore } from '../../src/store/postgres.js';
import { setupPostgresStoreSuite, testDatabaseUrl } from '../support/postgres-store-suite.js';

describe.skipIf(!testDatabaseUrl)('Postgres event compaction', () => {
  let store: PostgresStore;

  setupPostgresStoreSuite('postgres_event_compaction', (context) => {
    store = context.store;
  });

  it('compacts finalized agent text deltas while preserving partial output', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Event compaction' });
    const finalized = await services.messages.enqueue({ sessionId: session.id, prompt: 'finalized' });
    const partial = await services.messages.enqueue({ sessionId: session.id, prompt: 'partial' });
    const recent = await services.messages.enqueue({ sessionId: session.id, prompt: 'recent' });
    const recentDelta = await services.messages.enqueue({ sessionId: session.id, prompt: 'recent delta' });
    const invalidFinal = await services.messages.enqueue({ sessionId: session.id, prompt: 'invalid final' });
    const old = new Date('2026-01-01T00:00:00.000Z');
    const recentDate = new Date('2026-01-08T00:00:00.000Z');
    const cutoff = new Date('2026-01-02T00:00:00.000Z');

    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: finalized.id,
      type: 'agent_text_delta',
      payload: { text: 'old ' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: finalized.id,
      type: 'agent_text_delta',
      payload: { text: 'finalized' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: finalized.id,
      type: 'agent_response_final',
      payload: { text: 'old finalized' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: finalized.id,
      type: 'agent_text_delta',
      payload: { text: 'after final' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: partial.id,
      type: 'agent_text_delta',
      payload: { text: 'partial' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: recent.id,
      type: 'agent_text_delta',
      payload: { text: 'recent' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: recent.id,
      type: 'agent_response_final',
      payload: { text: 'recent' },
      createdAt: recentDate,
    });
    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: recentDelta.id,
      type: 'agent_text_delta',
      payload: { text: 'recent delta' },
      createdAt: recentDate,
    });
    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: recentDelta.id,
      type: 'agent_response_final',
      payload: { text: 'old final after recent delta' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: invalidFinal.id,
      type: 'agent_text_delta',
      payload: { text: 'invalid final fallback' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId: session.id,
      messageId: invalidFinal.id,
      type: 'agent_response_final',
      payload: {} as { text: string },
      createdAt: old,
    });

    await expect(store.compactFinalizedAgentTextDeltas({ finalizedBefore: cutoff, limit: 1 })).resolves.toBe(1);
    await expect(store.compactFinalizedAgentTextDeltas({ finalizedBefore: cutoff, limit: 10 })).resolves.toBe(1);

    const events = await store.getEvents(session.id);
    expect(events.filter((event) => event.type === 'agent_text_delta').map((event) => event.payload.text)).toEqual([
      'after final',
      'partial',
      'recent',
      'recent delta',
      'invalid final fallback',
    ]);
    expect(events.filter((event) => event.type === 'agent_response_final').map((event) => event.messageId)).toEqual([
      finalized.id,
      recent.id,
      recentDelta.id,
      invalidFinal.id,
    ]);
    expect(
      events.find((event) => event.type === 'agent_response_final' && event.messageId === finalized.id)?.payload,
    ).toEqual({ text: 'old finalized' });
  });
});
