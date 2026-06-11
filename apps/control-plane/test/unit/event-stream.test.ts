import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';

import { writeGlobalEventStream, writeSessionEventStream } from '../../src/app/event-stream.js';
import type { EventService } from '../../src/events/service.js';
import type { EventRecord } from '../../src/store/types.js';

describe('event stream', () => {
  it('replays historical events before live events that arrive during replay', async () => {
    const abort = new AbortController();
    let subscriber: ((event: EventRecord) => void) | undefined;
    const historicalEvent = eventRecord(2);
    const liveEvent = eventRecord(3);
    const events = {
      async listBatch() {
        subscriber?.(liveEvent);
        return { events: [historicalEvent], cursor: historicalEvent.sequence, hasMore: false };
      },
      subscribe(_sessionId: string, writeEvent: (event: EventRecord) => void) {
        subscriber = writeEvent;
        return () => undefined;
      },
    } as unknown as EventService;

    const response = await writeSessionEventStream(context(abort), events, 'session-1', 1);

    try {
      await expect(readSseEvents(response, 2)).resolves.toEqual([
        expect.objectContaining({ sequence: 2 }),
        expect.objectContaining({ sequence: 3 }),
      ]);
    } finally {
      abort.abort();
      await response.body?.cancel().catch(() => undefined);
    }
  });

  it('streams more than the high-water mark of historical events to an active reader', async () => {
    const abort = new AbortController();
    const historicalEvents = Array.from({ length: 300 }, (_value, index) => eventRecord(index + 1));
    const events = {
      async listBatch(_sessionId: string, after: number, limit: number) {
        const batch = historicalEvents.filter((event) => event.sequence > after).slice(0, limit);
        return {
          events: batch,
          cursor: batch[batch.length - 1]?.sequence ?? after,
          hasMore: batch.length === limit,
        };
      },
      subscribe(_sessionId: string, _writeEvent: (event: EventRecord) => void) {
        return () => undefined;
      },
    } as unknown as EventService;

    const response = await writeSessionEventStream(context(abort), events, 'session-1', 0);
    const readEvents = readSseEvents(response, historicalEvents.length);

    try {
      await expect(readEvents).resolves.toEqual(
        historicalEvents.map((event) =>
          expect.objectContaining({
            id: event.id,
            sequence: event.sequence,
            type: event.type,
          }),
        ),
      );
    } finally {
      abort.abort();
      await response.body?.cancel().catch(() => undefined);
    }
  });

  it('replays large backlogs in batches without skipping or repeating events', async () => {
    const abort = new AbortController();
    const historicalEvents = Array.from({ length: 1_200 }, (_value, index) => eventRecord(index + 1));
    const listCalls: Array<{ after: number; limit: number }> = [];
    const events = {
      async listBatch(_sessionId: string, after: number, limit: number) {
        listCalls.push({ after, limit });
        const batch = historicalEvents.filter((event) => event.sequence > after).slice(0, limit);
        return {
          events: batch,
          cursor: batch[batch.length - 1]?.sequence ?? after,
          hasMore: batch.length === limit,
        };
      },
      subscribe(_sessionId: string, _writeEvent: (event: EventRecord) => void) {
        return () => undefined;
      },
    } as unknown as EventService;

    const response = await writeSessionEventStream(context(abort), events, 'session-1', 0);

    try {
      const streamed = await readSseEvents(response, historicalEvents.length);
      expect(streamed.map((event) => event.sequence)).toEqual(historicalEvents.map((event) => event.sequence));
      expect(listCalls.length).toBeGreaterThan(1);
      expect(listCalls[0]?.after).toBe(0);
    } finally {
      abort.abort();
      await response.body?.cancel().catch(() => undefined);
    }
  });

  it('advances past replay batches that are entirely filtered out', async () => {
    const abort = new AbortController();
    const historicalEvents = Array.from({ length: 600 }, (_value, index) => eventRecord(index + 1));
    const listAllCalls: number[] = [];
    const events = {
      async listAllBatch(after: number, limit: number) {
        listAllCalls.push(after);
        const batch = historicalEvents.filter((event) => event.id > after).slice(0, limit);
        return {
          events: batch,
          cursor: batch[batch.length - 1]?.id ?? after,
          hasMore: batch.length === limit,
        };
      },
      subscribeAllEvents(_writeEvent: (event: EventRecord) => void) {
        return () => undefined;
      },
    } as unknown as EventService;

    const response = await writeGlobalEventStream(context(abort), events, 0, true, true, {
      filter: (event) => event.id > 500,
    });

    try {
      const streamed = await readSseEvents(response, 100);
      expect(streamed.map((event) => event.id)).toEqual(Array.from({ length: 100 }, (_value, index) => index + 501));
      expect(listAllCalls).toEqual([0, 500]);
    } finally {
      abort.abort();
      await response.body?.cancel().catch(() => undefined);
    }
  });

  it('closes slow streams only when the live event backlog exceeds the high-water mark', async () => {
    const abort = new AbortController();
    let subscriber: ((event: EventRecord) => void) | undefined;
    let unsubscribed = false;
    const events = {
      async listBatch(_sessionId: string, after: number) {
        return { events: [], cursor: after, hasMore: false };
      },
      subscribe(_sessionId: string, writeEvent: (event: EventRecord) => void) {
        subscriber = writeEvent;
        return () => {
          unsubscribed = true;
        };
      },
    } as unknown as EventService;

    const response = await writeSessionEventStream(context(abort), events, 'session-1', 0);
    await readConnectedFrame(response);
    await Promise.resolve();

    for (let sequence = 1; sequence <= 256; sequence += 1) {
      subscriber?.(eventRecord(sequence));
    }
    await Promise.resolve();
    expect(unsubscribed).toBe(false);

    subscriber?.(eventRecord(257));

    await waitFor(() => unsubscribed);
    expect(unsubscribed).toBe(true);
    abort.abort();
  });
});

function context(abort: AbortController): Context {
  return { req: { raw: { signal: abort.signal } } } as Context;
}

function eventRecord(sequence: number): EventRecord {
  return {
    id: sequence,
    sequence,
    sessionId: 'session-1',
    type: 'message_created',
    payload: { sequence, source: null },
    createdAt: new Date(sequence),
  } satisfies EventRecord;
}

async function readConnectedFrame(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected response body');

  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('SSE stream ended before connected frame');
    buffer += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
}

async function readSseEvents(response: Response, count: number): Promise<EventRecord[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected response body');

  const decoder = new TextDecoder();
  const events: EventRecord[] = [];
  let buffer = '';

  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) throw new Error('SSE stream ended before expected events');
    buffer += decoder.decode(value, { stream: true });

    let eventEnd = buffer.indexOf('\n\n');
    while (eventEnd !== -1) {
      const frame = buffer.slice(0, eventEnd);
      buffer = buffer.slice(eventEnd + 2);
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length);
      if (data) events.push(JSON.parse(data) as EventRecord);
      eventEnd = buffer.indexOf('\n\n');
    }
  }

  reader.releaseLock();
  return events;
}

async function waitFor(readValue: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!readValue() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
