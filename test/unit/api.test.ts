import type { Server } from 'node:http';
import { createServer } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { expectErrorResponse, expectEventsResponse, expectMessageResponse, expectSessionResponse } from '../support/contracts.js';

describe('core API', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer(loadConfig({}));
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('reports health', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', runMode: 'all' });
  });

  it('protects product session routes when bearer auth is enabled', async () => {
    await closeServer(server);
    server = createServer(loadConfig({ API_AUTH_MODE: 'bearer', API_BEARER_TOKEN: 'secret' }));
    baseUrl = await listen(server);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    const missingAuth = await postJson(`${baseUrl}/sessions`, { title: 'Private' });
    expect(missingAuth.status).toBe(401);
    await expect(missingAuth.json()).resolves.toMatchObject({ error: 'unauthorized' });

    const invalidAuth = await postJson(`${baseUrl}/sessions`, { title: 'Private' }, 'wrong');
    expect(invalidAuth.status).toBe(401);

    const validAuth = await postJson(`${baseUrl}/sessions`, { title: 'Private' }, 'secret');
    expect(validAuth.status).toBe(201);
    expectSessionResponse(await validAuth.json());
  });

  it('creates a session, enqueues a message, and replays events', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Test session' });
    expect(createSession.status).toBe(201);

    const createSessionBody = await createSession.json();
    expectSessionResponse(createSessionBody);
    const { session } = createSessionBody;
    expect(session.title).toBe('Test session');

    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'Investigate the failing test',
    });
    expect(createMessage.status).toBe(202);

    const createMessageBody = await createMessage.json();
    expectMessageResponse(createMessageBody);
    const { message } = createMessageBody;
    expect(message).toMatchObject({
      sessionId: session.id,
      sequence: 1,
      status: 'pending',
      prompt: 'Investigate the failing test',
    });

    const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
    expect(eventsResponse.status).toBe(200);

    const eventsBody = await eventsResponse.json();
    expectEventsResponse(eventsBody);
    const { events } = eventsBody;
    expect(events.map((event) => event.type)).toEqual(['session_created', 'message_created']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);

    const replayResponse = await fetch(`${baseUrl}/sessions/${session.id}/events?after=1`);
    const replayBody = await replayResponse.json();
    expectEventsResponse(replayBody);
    const { events: replayed } = replayBody;
    expect(replayed.map((event) => event.type)).toEqual(['message_created']);
  });

  it('streams replayed and live events with SSE', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Stream session' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    const abort = new AbortController();
    const streamResponse = await fetch(`${baseUrl}/sessions/${session.id}/events/stream?after=1`, {
      signal: abort.signal,
    });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');

    const nextEvent = readNextSseEvent(streamResponse, abort);
    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'stream this',
    });
    expect(createMessage.status).toBe(202);

    await expect(nextEvent).resolves.toMatchObject({ type: 'message_created', sequence: 2 });
  });

  it('returns 404 when enqueueing a message for a missing session', async () => {
    const response = await postJson(`${baseUrl}/sessions/missing/messages`, { prompt: 'hello' });

    expect(response.status).toBe(404);
    const body = await response.json();
    expectErrorResponse(body);
    expect(body).toMatchObject({ error: 'not_found' });
  });

  it('validates message prompts', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, {});
    const { session } = (await createSession.json()) as { session: { id: string } };

    const response = await postJson(`${baseUrl}/sessions/${session.id}/messages`, { prompt: '' });

    expect(response.status).toBe(400);
    const body = await response.json();
    expectErrorResponse(body);
    expect(body).toMatchObject({ error: 'invalid_request' });
  });

  it('returns stable errors for invalid JSON bodies', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expectErrorResponse(body);
    expect(body).toMatchObject({ error: 'invalid_json' });
  });

  it('rejects oversized JSON bodies', async () => {
    await closeServer(server);
    server = createServer(loadConfig({ MAX_JSON_BODY_BYTES: '16' }));
    baseUrl = await listen(server);

    const response = await postJson(`${baseUrl}/sessions`, { title: 'this is too large' });

    expect(response.status).toBe(413);
    const body = await response.json();
    expectErrorResponse(body);
    expect(body).toMatchObject({ error: 'payload_too_large' });
  });
});

function postJson(url: string, body: unknown, bearerToken?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }
  return `http://${address.address}:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readNextSseEvent(response: Response, abort: AbortController): Promise<{ type: string; sequence: number }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected response body');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream ended before event');
      buffer += decoder.decode(value, { stream: true });

      const eventEnd = buffer.indexOf('\n\n');
      if (eventEnd === -1) continue;

      const frame = buffer.slice(0, eventEnd);
      buffer = buffer.slice(eventEnd + 2);
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length);
      if (!data) continue;

      return JSON.parse(data) as { type: string; sequence: number };
    }
  } finally {
    abort.abort();
    reader.releaseLock();
  }
}
