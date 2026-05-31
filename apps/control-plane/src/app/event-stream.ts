import type { Context } from 'hono';
import type { EventService } from '../events/service.js';
import type { EventRecord } from '../store/types.js';

const sseWriteQueueHighWater = 256;

export async function writeSessionEventStream(
  c: Context,
  events: EventService,
  sessionId: string,
  afterSequence: number,
): Promise<Response> {
  return writeEventStream(c, {
    after: afterSequence,
    id: (event) => event.sequence,
    list: () => events.list(sessionId, afterSequence),
    subscribe: (writeEvent) => events.subscribe(sessionId, writeEvent),
  });
}

export async function writeGlobalEventStream(
  c: Context,
  events: EventService,
  afterId: number,
  replay: boolean,
  includeAll: boolean,
  options: { filter?: (event: EventRecord) => boolean | Promise<boolean> } = {},
): Promise<Response> {
  return writeEventStream(c, {
    after: afterId,
    id: (event) => event.id,
    list: async () =>
      filterEvents(includeAll ? await events.listAllEvents(afterId) : await events.listAll(afterId), options.filter),
    replay,
    subscribe: (writeEvent) => (includeAll ? events.subscribeAllEvents(writeEvent) : events.subscribeAll(writeEvent)),
    ...(options.filter ? { filter: options.filter } : {}),
  });
}

async function writeEventStream(
  c: Context,
  options: {
    after: number;
    id: (event: EventRecord) => number;
    list: () => Promise<EventRecord[]>;
    replay?: boolean;
    subscribe: (writeEvent: (event: EventRecord) => void) => () => void;
    filter?: (event: EventRecord) => boolean | Promise<boolean>;
  },
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let cursor = options.after;
  let closed = false;
  let replaying = options.replay !== false;
  let queuedWrites = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  let emitQueue: Promise<void> = Promise.resolve();
  let liveBuffer: EventRecord[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const cleanup = (abortWriter = false) => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    if (abortWriter) {
      writer.abort().catch(() => {});
      return;
    }
    writer.close().catch(() => {});
  };

  const write = (chunk: string): Promise<void> => {
    if (closed) return Promise.resolve();
    if (queuedWrites >= sseWriteQueueHighWater) {
      cleanup(true);
      return Promise.reject(new Error('SSE client write queue exceeded high-water mark'));
    }

    queuedWrites += 1;
    const nextWrite = writeQueue.then(async () => {
      if (!closed) await writer.write(encoder.encode(chunk));
    });
    writeQueue = nextWrite.catch(() => {});
    nextWrite.then(
      () => {
        queuedWrites -= 1;
      },
      () => {
        queuedWrites -= 1;
      },
    );
    nextWrite.catch(() => cleanup());
    return nextWrite;
  };

  const eventFrame = (eventId: number, event: EventRecord) =>
    `id: ${eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

  const emitEvent = async (event: EventRecord): Promise<void> => {
    if (options.filter && !(await options.filter(event))) return;
    const eventId = options.id(event);
    if (eventId <= cursor || closed) return;
    cursor = eventId;
    await write(eventFrame(eventId, event));
  };
  const emitEventAndDrain = async (event: EventRecord): Promise<void> => {
    const eventId = options.id(event);
    if (eventId <= cursor || closed) return;
    cursor = eventId;
    await write(eventFrame(eventId, event));
  };
  const enqueueEvent = (event: EventRecord) => {
    emitQueue = emitQueue.then(() => emitEvent(event));
    emitQueue.catch(() => cleanup());
  };
  const writeEvent = (event: EventRecord) => {
    if (closed) return;
    if (replaying) {
      if (liveBuffer.length >= sseWriteQueueHighWater) {
        cleanup(true);
        return;
      }
      liveBuffer.push(event);
      return;
    }

    enqueueEvent(event);
  };

  unsubscribe = options.subscribe(writeEvent);
  heartbeat = setInterval(() => {
    write(': keep-alive\n\n').catch(() => {});
  }, 15_000);

  c.req.raw.signal.addEventListener('abort', () => cleanup(), { once: true });

  void (async () => {
    try {
      await write(': connected\n\n');
      if (options.replay !== false) {
        for (const event of await options.list()) {
          await emitEventAndDrain(event);
        }
      }
      replaying = false;
      const bufferedEvents = liveBuffer;
      liveBuffer = [];
      for (const event of bufferedEvents) {
        await emitEvent(event);
      }
    } catch {
      cleanup();
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

async function filterEvents(
  events: EventRecord[],
  filter: ((event: EventRecord) => boolean | Promise<boolean>) | undefined,
): Promise<EventRecord[]> {
  if (!filter) return events;
  const filtered: EventRecord[] = [];
  for (const event of events) {
    if (await filter(event)) filtered.push(event);
  }
  return filtered;
}
