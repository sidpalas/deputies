import { spawn, type ChildProcess } from 'node:child_process';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const uatPort = 4593;

describe.skipIf(!testDatabaseUrl)('built server UAT', () => {
  let pool: Pool;
  let server: ChildProcess;

  beforeAll(async () => {
    await runMigrations(testDatabaseUrl!);
    pool = new Pool({ connectionString: testDatabaseUrl });
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE integration_deliveries, external_threads, sandboxes, events, runs, messages, session_sequence_counters, webhook_sources, sessions RESTART IDENTITY CASCADE',
    );
    server = spawn(process.execPath, ['dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_STORE: 'postgres',
        DATABASE_URL: testDatabaseUrl!,
        PORT: String(uatPort),
        RUN_MODE: 'all',
        RUNNER: 'fake',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHealth();
  });

  afterEach(async () => {
    server.kill();
    await new Promise<void>((resolve) => server.once('exit', () => resolve()));
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
      'message_completed',
    ]);
  });

  it('accepts a generic webhook and completes it through the worker', async () => {
    const now = new Date();
    await pool.query(
      `INSERT INTO webhook_sources (id, key, name, enabled, bearer_token, prompt_prefix, created_at, updated_at)
       VALUES ($1, 'foo', 'Foo', true, 'secret', 'bar baz', $2, $2)`,
      ['00000000-0000-4000-8000-000000000301', now],
    );

    const response = await postJsonWithAuth('/webhooks/generic/foo', 'secret', {
      threadId: 'thread-1',
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
});

function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${uatPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

async function waitForHealth(): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${uatPort}/health`).catch(() => null);
    return response?.ok === true;
  });
}

async function waitForEvents(sessionId: string, terminalTypes: string[]): Promise<Array<{ type: string }>> {
  let lastEvents: Array<{ type: string }> = [];
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${uatPort}/sessions/${sessionId}/events`);
    const body = (await response.json()) as { events: Array<{ type: string }> };
    lastEvents = body.events;
    return terminalTypes.every((type) => lastEvents.some((event) => event.type === type));
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
