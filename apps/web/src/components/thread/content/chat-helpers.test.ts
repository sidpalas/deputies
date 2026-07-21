import { describe, expect, it } from 'vitest';
import type { AgentEvent, Message } from '../../../api.js';
import { groupDiagnosticsByRun, groupMessagesByRun } from './chat-helpers.js';

function message(sequence: number, status: string, steering = false): Message {
  return {
    id: `message-${sequence}`,
    sessionId: 'session-1',
    sequence,
    status,
    steering,
    prompt: `Message ${sequence}`,
    createdAt: '2026-07-21T00:00:00.000Z',
  };
}

describe('groupMessagesByRun', () => {
  it('fills only pending slots steering-first and preserves sequence within each partition', () => {
    const groups = groupMessagesByRun(
      [
        message(1, 'completed'),
        message(2, 'pending'),
        message(3, 'processing'),
        message(4, 'pending', true),
        message(5, 'pending', true),
        message(6, 'pending'),
      ],
      [],
    );

    expect(groups.map((group) => group.messages[0]?.sequence)).toEqual([1, 4, 3, 5, 2, 6]);
  });

  it('does not reorder messages in an already-started run batch', () => {
    const event = {
      id: 1,
      sessionId: 'session-1',
      sequence: 1,
      type: 'message_started',
      runId: 'run-1',
      messageId: 'message-1',
      payload: { sequences: [1, 2] },
      createdAt: '2026-07-21T00:00:00.000Z',
    } as AgentEvent;

    const groups = groupMessagesByRun([message(1, 'pending'), message(2, 'pending', true)], [event]);
    expect(groups[0]?.messages.map((item) => item.sequence)).toEqual([1, 2]);
  });

  it('ignores stale recovered run batches but applies a distinct replacement run batch', () => {
    const started = {
      id: 1,
      sessionId: 'session-1',
      sequence: 1,
      type: 'message_started',
      runId: 'stale-run',
      messageId: 'message-1',
      payload: { sequences: [1, 2] },
      createdAt: '2026-07-21T00:00:00.000Z',
    } as AgentEvent;
    const recovered = {
      ...started,
      id: 2,
      sequence: 2,
      type: 'run_failed',
      payload: { recovered: true },
    } as AgentEvent;
    const pendingMessages = [message(1, 'pending'), message(2, 'pending', true)];

    const recoveredGroups = groupMessagesByRun(pendingMessages, [started, recovered]);
    expect(recoveredGroups.map((group) => group.messages.map((item) => item.sequence))).toEqual([[2], [1]]);

    const replacement = {
      ...started,
      id: 3,
      sequence: 3,
      runId: 'replacement-run',
      createdAt: '2026-07-21T00:00:02.000Z',
    } as AgentEvent;
    const replacementGroups = groupMessagesByRun(pendingMessages, [started, recovered, replacement]);
    expect(replacementGroups).toHaveLength(1);
    expect(replacementGroups[0]?.runId).toBe('replacement-run');
    expect(replacementGroups[0]?.messages.map((item) => item.sequence)).toEqual([1, 2]);
  });
});

describe('groupDiagnosticsByRun', () => {
  it('omits message update events from visible activity', () => {
    const updated = {
      id: 1,
      sessionId: 'session-1',
      sequence: 1,
      type: 'message_updated',
      messageId: 'message-1',
      payload: { sequence: 1 },
      createdAt: '2026-07-21T00:00:00.000Z',
    } as AgentEvent;
    const started = {
      ...updated,
      id: 2,
      sequence: 2,
      type: 'message_started',
      runId: 'run-1',
      payload: { sequence: 1, sequences: [1], batchSize: 1 },
    } as AgentEvent;

    expect(groupDiagnosticsByRun([updated, started])).toEqual({
      'run-1': [started],
      'message-1': [started],
    });
  });
});
