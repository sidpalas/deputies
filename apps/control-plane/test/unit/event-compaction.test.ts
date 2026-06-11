import { afterEach, describe, expect, it, vi } from 'vitest';

import { runEventCompactorOnce } from '../../src/events/compaction.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('event compaction', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('compacts one batch behind the configured retention window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));

    const compactFinalizedAgentTextDeltas = vi.fn(async () => 3);
    const store = {
      compactFinalizedAgentTextDeltas,
    };

    await expect(runEventCompactorOnce({ store, retentionMs: 60_000, batchSize: 25 })).resolves.toBe(3);
    expect(compactFinalizedAgentTextDeltas).toHaveBeenCalledWith({
      finalizedBefore: new Date('2026-06-11T11:59:00.000Z'),
      limit: 25,
    });
  });

  it('skips compaction when another postgres advisory lock holder is active', async () => {
    const compactFinalizedAgentTextDeltas = vi.fn(async () => 3);
    const store = {
      compactFinalizedAgentTextDeltas,
      async withAdvisoryLock() {
        return null;
      },
    };

    await expect(runEventCompactorOnce({ store, retentionMs: 60_000 })).resolves.toBe(0);
    expect(compactFinalizedAgentTextDeltas).not.toHaveBeenCalled();
  });

  it('removes only deltas for old finalized messages', async () => {
    const store = new MemoryStore();
    const sessionId = 'session-1';
    const finalizedMessageId = 'message-finalized';
    const partialMessageId = 'message-partial';
    const recentMessageId = 'message-recent';
    const recentDeltaMessageId = 'message-recent-delta';
    const invalidFinalMessageId = 'message-invalid-final';
    const old = new Date('2026-01-01T00:00:00.000Z');
    const recent = new Date('2026-01-08T00:00:00.000Z');

    await store.appendEventWithNextSequence({
      sessionId,
      messageId: finalizedMessageId,
      type: 'agent_text_delta',
      payload: { text: 'old ' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId,
      messageId: finalizedMessageId,
      type: 'agent_response_final',
      payload: { text: 'old final' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId,
      messageId: finalizedMessageId,
      type: 'agent_text_delta',
      payload: { text: 'after final' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId,
      messageId: partialMessageId,
      type: 'agent_text_delta',
      payload: { text: 'partial' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId,
      messageId: recentMessageId,
      type: 'agent_text_delta',
      payload: { text: 'recent' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId,
      messageId: recentMessageId,
      type: 'agent_response_final',
      payload: { text: 'recent final' },
      createdAt: recent,
    });
    await store.appendEventWithNextSequence({
      sessionId,
      messageId: recentDeltaMessageId,
      type: 'agent_text_delta',
      payload: { text: 'recent delta' },
      createdAt: recent,
    });
    await store.appendEventWithNextSequence({
      sessionId,
      messageId: recentDeltaMessageId,
      type: 'agent_response_final',
      payload: { text: 'old final after recent delta' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId,
      messageId: invalidFinalMessageId,
      type: 'agent_text_delta',
      payload: { text: 'invalid final fallback' },
      createdAt: old,
    });
    await store.appendEventWithNextSequence({
      sessionId,
      messageId: invalidFinalMessageId,
      type: 'agent_response_final',
      payload: {} as { text: string },
      createdAt: old,
    });

    await expect(
      store.compactFinalizedAgentTextDeltas({ finalizedBefore: new Date('2026-01-02T00:00:00.000Z'), limit: 10 }),
    ).resolves.toBe(1);

    const events = await store.getEvents(sessionId);
    expect(events.filter((event) => event.type === 'agent_text_delta').map((event) => event.payload.text)).toEqual([
      'after final',
      'partial',
      'recent',
      'recent delta',
      'invalid final fallback',
    ]);
    expect(
      events.find((event) => event.type === 'agent_response_final' && event.messageId === finalizedMessageId),
    ).toBeDefined();
    await expect(
      store.appendEventWithNextSequence({ sessionId, type: 'session_queue_paused', payload: {}, createdAt: old }),
    ).resolves.toMatchObject({ sequence: 11 });
  });
});
