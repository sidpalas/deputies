import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const uatPort = 4593;
const workerHealthPort = 4594;
let server: ChildProcess | undefined;
let worker: ChildProcess | undefined;

describe.skipIf(!testDatabaseUrl)('built server UAT', () => {
  let pool: Pool;

  beforeAll(async () => {
    await runMigrations(testDatabaseUrl!);
    pool = new Pool({ connectionString: testDatabaseUrl });
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE callback_deliveries, artifacts, integration_deliveries, external_threads, sandboxes, events, runs, messages, session_sequence_counters, webhook_sources, sessions RESTART IDENTITY CASCADE',
    );
    await startServer();
  });

  afterEach(async () => {
    await stopProcesses();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('accepts a message and completes it through the worker', async () => {
    const createSession = await postJson('/sessions', { title: 'Built server UAT' });
    expect(createSession.status).toBe(201);
    const { session } = (await createSession.json()) as { session: { id: string } };

    const createMessage = await postJson(`/sessions/${session.id}/messages`, { prompt: 'complete from built app' });
    expect(createMessage.status).toBe(202);

    const events = await waitForEvents(session.id, ['message_completed']);
    expect(events.map((event) => event.type)).toEqual([
      'session_created',
      'message_created',
      'message_started',
      'sandbox_starting',
      'sandbox_ready',
      'run_started',
      'agent_text_delta',
      'run_completed',
      'agent_response_final',
      'message_completed',
    ]);
  });

  it('completes messages with split API and worker processes', async () => {
    await stopProcesses();
    await startWorker({ WORKER_POLL_INTERVAL_MS: '60000' });
    await startServer({ RUN_MODE: 'api' });

    const createSession = await postJson('/sessions', { title: 'Split server UAT' });
    expect(createSession.status).toBe(201);
    const { session } = (await createSession.json()) as { session: { id: string } };

    const createMessage = await postJson(`/sessions/${session.id}/messages`, { prompt: 'complete from split app' });
    expect(createMessage.status).toBe(202);

    const events = await waitForEvents(session.id, ['message_completed'], {}, 3_000);
    expect(events.map((event) => event.type)).toEqual([
      'session_created',
      'message_created',
      'message_started',
      'sandbox_starting',
      'sandbox_ready',
      'run_started',
      'agent_text_delta',
      'run_completed',
      'agent_response_final',
      'message_completed',
    ]);
  });

  it('does not process queued work in API-only mode', async () => {
    await stopProcesses();
    await startServer({ RUN_MODE: 'api' });

    const createSession = await postJson('/sessions', { title: 'API-only UAT' });
    expect(createSession.status).toBe(201);
    const { session } = (await createSession.json()) as { session: { id: string } };

    const createMessage = await postJson(`/sessions/${session.id}/messages`, { prompt: 'stay queued' });
    expect(createMessage.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const messagesResponse = await fetch(`http://127.0.0.1:${uatPort}/sessions/${session.id}/messages`);
    expect(messagesResponse.status).toBe(200);
    await expect(messagesResponse.json()).resolves.toMatchObject({ messages: [{ status: 'pending' }] });

    const events = await waitForEvents(session.id, []);
    expect(events.map((event) => event.type)).toEqual(['session_created', 'message_created']);
  });

  it('exposes worker health without product API routes and processes existing work', async () => {
    await stopProcesses();
    await startServer({ RUN_MODE: 'api' });

    const createSession = await postJson('/sessions', { title: 'Worker-only UAT' });
    expect(createSession.status).toBe(201);
    const { session } = (await createSession.json()) as { session: { id: string } };
    const createMessage = await postJson(`/sessions/${session.id}/messages`, { prompt: 'worker only completion' });
    expect(createMessage.status).toBe(202);

    await stopServer();
    await startWorker();

    const health = await fetch(`http://127.0.0.1:${workerHealthPort}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: 'ok', runMode: 'worker' });

    const productRoute = await fetch(`http://127.0.0.1:${workerHealthPort}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Blocked on worker' }),
    });
    expect(productRoute.status).toBe(404);

    await waitFor(async () => {
      const { rows } = await pool.query<{ status: string }>('SELECT status FROM messages WHERE session_id = $1', [
        session.id,
      ]);
      return rows[0]?.status === 'completed';
    });
  });

  it('accepts a generic webhook and completes it through the worker', async () => {
    const now = new Date();
    await pool.query(
      `INSERT INTO webhook_sources (id, key, name, enabled, bearer_token, prompt_prefix, created_at, updated_at)
       VALUES ($1, 'foo', 'Foo', true, 'secret', 'bar baz', $2, $2)`,
      ['00000000-0000-4000-8000-000000000301', now],
    );

    const response = await postJsonWithAuth('/webhooks/generic/foo', 'secret', {
      thread: { externalId: 'thread-1' },
      dedupeKey: 'delivery-1',
      title: 'Webhook UAT',
      prompt: 'complete from webhook',
    });
    expect(response.status).toBe(202);
    const { session, message } = (await response.json()) as { session: { id: string }; message: { prompt: string } };
    expect(message.prompt).toBe('bar baz\n\ncomplete from webhook');

    const events = await waitForEvents(session.id, ['message_completed']);
    expect(events.map((event) => event.type)).toContain('message_completed');
  });

  it('protects product API routes when bearer auth is enabled', async () => {
    await restartServer({ API_AUTH_MODE: 'bearer', API_BEARER_TOKEN: 'secret' });

    const health = await fetch(`http://127.0.0.1:${uatPort}/health`);
    expect(health.status).toBe(200);

    const missingAuth = await postJson('/sessions', { title: 'Private UAT' });
    expect(missingAuth.status).toBe(401);

    const invalidAuth = await postJson('/sessions', { title: 'Private UAT' }, 'wrong');
    expect(invalidAuth.status).toBe(401);

    const createSession = await postJson('/sessions', { title: 'Private UAT' }, 'secret');
    expect(createSession.status).toBe(201);
    const { session } = (await createSession.json()) as { session: { id: string } };

    const createMessage = await postJson(
      `/sessions/${session.id}/messages`,
      { prompt: 'complete from authenticated API' },
      'secret',
    );
    expect(createMessage.status).toBe(202);

    const noAuthEvents = await fetch(`http://127.0.0.1:${uatPort}/sessions/${session.id}/events`);
    expect(noAuthEvents.status).toBe(401);

    const events = await waitForEvents(session.id, ['message_completed'], { bearerToken: 'secret' });
    expect(events.map((event) => event.type)).toContain('message_completed');
  });

  it('reuses the same sandbox for follow-up messages', async () => {
    const createSession = await postJson('/sessions', { title: 'Follow-up UAT' });
    expect(createSession.status).toBe(201);
    const { session } = (await createSession.json()) as { session: { id: string } };

    const firstMessage = await postJson(`/sessions/${session.id}/messages`, { prompt: 'first message' });
    expect(firstMessage.status).toBe(202);
    await waitForEventCount(session.id, 'message_completed', 1);

    const secondMessage = await postJson(`/sessions/${session.id}/messages`, { prompt: 'second message' });
    expect(secondMessage.status).toBe(202);
    const events = await waitForEventCount(session.id, 'message_completed', 2);

    const sandboxReadyEvents = events.filter((event) => event.type === 'sandbox_ready');
    expect(sandboxReadyEvents.map((event) => event.payload?.created)).toEqual([true, false]);
    expect(new Set(sandboxReadyEvents.map((event) => event.payload?.providerSandboxId)).size).toBe(1);
  });

  it('restarts a stopped sandbox for follow-up messages', async () => {
    const createSession = await postJson('/sessions', { title: 'Stopped sandbox UAT' });
    expect(createSession.status).toBe(201);
    const { session } = (await createSession.json()) as { session: { id: string } };

    const firstMessage = await postJson(`/sessions/${session.id}/messages`, { prompt: 'first message' });
    expect(firstMessage.status).toBe(202);
    await waitForEventCount(session.id, 'message_completed', 1);

    await pool.query("UPDATE sandboxes SET status = 'stopped', updated_at = now() WHERE session_id = $1", [session.id]);

    const secondMessage = await postJson(`/sessions/${session.id}/messages`, { prompt: 'second message' });
    expect(secondMessage.status).toBe(202);
    const events = await waitForEventCount(session.id, 'message_completed', 2);

    const sandboxReadyEvents = events.filter((event) => event.type === 'sandbox_ready');
    expect(sandboxReadyEvents.map((event) => event.payload?.created)).toEqual([true, false]);
    expect(new Set(sandboxReadyEvents.map((event) => event.payload?.providerSandboxId)).size).toBe(1);
  });

  it('updates, archives, and unarchives sessions', async () => {
    const createSession = await postJson('/sessions', { title: 'Initial title' });
    expect(createSession.status).toBe(201);
    const { session } = (await createSession.json()) as { session: { id: string } };

    const update = await patchJson(`/sessions/${session.id}`, { title: 'Updated title' });
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({ session: { title: 'Updated title' } });

    const archive = await postJson(`/sessions/${session.id}/archive`, {});
    expect(archive.status).toBe(200);
    await expect(archive.json()).resolves.toMatchObject({ session: { status: 'archived' } });

    const unarchive = await postJson(`/sessions/${session.id}/unarchive`, {});
    expect(unarchive.status).toBe(200);
    await expect(unarchive.json()).resolves.toMatchObject({ session: { status: 'idle' } });

    const list = await fetch(`http://127.0.0.1:${uatPort}/sessions`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      sessions: [{ id: session.id, title: 'Updated title', status: 'idle' }],
    });

    const events = await waitForEvents(session.id, ['session_unarchived']);
    expect(events.map((event) => event.type)).toEqual([
      'session_created',
      'session_updated',
      'session_archived',
      'session_unarchived',
    ]);
  });

  it('keeps generic webhook auth independent from product API auth', async () => {
    await restartServer({ API_AUTH_MODE: 'bearer', API_BEARER_TOKEN: 'product-secret' });
    const now = new Date();
    await pool.query(
      `INSERT INTO webhook_sources (id, key, name, enabled, bearer_token, prompt_prefix, created_at, updated_at)
       VALUES ($1, 'auth-split', 'Auth Split', true, 'webhook-secret', null, $2, $2)`,
      ['00000000-0000-4000-8000-000000000302', now],
    );

    const productApi = await postJson('/sessions', { title: 'Blocked' });
    expect(productApi.status).toBe(401);

    const wrongWebhookAuth = await postJsonWithAuth('/webhooks/generic/auth-split', 'product-secret', {
      thread: { externalId: 'thread-1' },
      dedupeKey: 'delivery-1',
      prompt: 'wrong auth',
    });
    expect(wrongWebhookAuth.status).toBe(401);

    const webhook = await postJsonWithAuth('/webhooks/generic/auth-split', 'webhook-secret', {
      thread: { externalId: 'thread-1' },
      dedupeKey: 'delivery-2',
      prompt: 'complete via webhook auth',
    });
    expect(webhook.status).toBe(202);
    const { session } = (await webhook.json()) as { session: { id: string } };

    const events = await waitForEvents(session.id, ['message_completed'], { bearerToken: 'product-secret' });
    expect(events.map((event) => event.type)).toContain('message_completed');
  });

  it('delivers generic webhook completion callbacks and records artifacts', async () => {
    const callbacks: unknown[] = [];
    const callbackServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        callbacks.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(204);
        response.end();
      });
    });
    const callbackUrl = await listenCallbackServer(callbackServer);

    try {
      const now = new Date();
      await pool.query(
        `INSERT INTO webhook_sources (id, key, name, enabled, bearer_token, prompt_prefix, created_at, updated_at)
         VALUES ($1, 'callback', 'Callback', true, 'secret', null, $2, $2)`,
        ['00000000-0000-4000-8000-000000000303', now],
      );

      const response = await postJsonWithAuth('/webhooks/generic/callback', 'secret', {
        thread: { externalId: 'thread-callback' },
        dedupeKey: 'delivery-callback',
        prompt: 'complete with callback',
        callback: { type: 'http', url: callbackUrl },
        context: {
          fakeArtifact: { type: 'external_link', url: 'https://example.com/result', payload: { ok: true } },
        },
      });
      expect(response.status).toBe(202);
      const { session } = (await response.json()) as { session: { id: string } };

      const events = await waitForEvents(session.id, ['callback_sent']);
      expect(events.map((event) => event.type)).toContain('artifact_created');
      expect(events.map((event) => event.type)).toContain('callback_sent');
      const artifactsResponse = await fetch(`http://127.0.0.1:${uatPort}/sessions/${session.id}/artifacts`);
      expect(artifactsResponse.status).toBe(200);
      const artifactsBody = (await artifactsResponse.json()) as { artifacts: Array<{ type: string; url?: string }> };
      expect(artifactsBody.artifacts).toMatchObject([{ type: 'external_link', url: 'https://example.com/result' }]);
      await waitFor(() => Promise.resolve(callbacks.length === 1));
      expect(callbacks[0]).toMatchObject({ event: 'message_completed', sessionId: session.id });
      expect((callbacks[0] as { artifacts: unknown[] }).artifacts).toHaveLength(1);
    } finally {
      await closeCallbackServer(callbackServer);
    }
  });
});

async function startServer(extraEnv: Record<string, string> = {}): Promise<void> {
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_STORE: 'postgres',
      DATABASE_URL: testDatabaseUrl!,
      PORT: String(uatPort),
      RUN_MODE: 'all',
      RUNNER: 'fake',
      API_AUTH_MODE: 'none',
      UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS: 'true',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth();
}

async function startWorker(extraEnv: Record<string, string> = {}): Promise<void> {
  worker = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_STORE: 'postgres',
      DATABASE_URL: testDatabaseUrl!,
      PORT: String(workerHealthPort),
      RUN_MODE: 'worker',
      RUNNER: 'fake',
      API_AUTH_MODE: 'none',
      UNSAFE_ALLOW_LOCAL_HTTP_CALLBACKS: 'true',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth(workerHealthPort);
}

async function restartServer(extraEnv: Record<string, string>): Promise<void> {
  await stopServer();
  await startServer(extraEnv);
}

async function stopProcesses(): Promise<void> {
  await Promise.all([stopServer(), stopWorker()]);
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const current = server;
  server = undefined;
  current.kill();
  await new Promise<void>((resolve) => current.once('exit', () => resolve()));
}

async function stopWorker(): Promise<void> {
  if (!worker) return;
  const current = worker;
  worker = undefined;
  current.kill();
  await new Promise<void>((resolve) => current.once('exit', () => resolve()));
}

function postJson(path: string, body: unknown, bearerToken?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  return fetch(`http://127.0.0.1:${uatPort}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function postJsonWithAuth(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${uatPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function patchJson(path: string, body: unknown, bearerToken?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  return fetch(`http://127.0.0.1:${uatPort}${path}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

async function waitForHealth(port = uatPort): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
    return response?.ok === true;
  });
}

type UatEvent = { type: string; payload?: Record<string, unknown> };

async function waitForEvents(
  sessionId: string,
  terminalTypes: string[],
  options: { bearerToken?: string } = {},
  timeoutMs = 10_000,
): Promise<UatEvent[]> {
  let lastEvents: UatEvent[] = [];
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${uatPort}/sessions/${sessionId}/events`, {
      headers: options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {},
    });
    const body = (await response.json()) as { events: UatEvent[] };
    lastEvents = body.events;
    return terminalTypes.every((type) => lastEvents.some((event) => event.type === type));
  }, timeoutMs);

  return lastEvents;
}

async function waitForEventCount(sessionId: string, type: string, count: number): Promise<UatEvent[]> {
  let lastEvents: UatEvent[] = [];
  await waitFor(async () => {
    lastEvents = await waitForEvents(sessionId, []);
    return lastEvents.filter((event) => event.type === type).length >= count;
  });

  return lastEvents;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Timed out waiting for condition');
}

async function listenCallbackServer(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected callback server address');
  return `http://${address.address}:${address.port}/callback`;
}

async function closeCallbackServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
