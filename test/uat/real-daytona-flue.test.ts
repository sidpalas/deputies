import { spawn, type ChildProcess } from 'node:child_process';
import { Daytona } from '@daytona/sdk';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_REAL_DAYTONA_FLUE_UAT === 'true';
const hasRequiredEnv = Boolean(testDatabaseUrl && process.env.DAYTONA_API_KEY && process.env.FLUE_MODEL);
const uatPort = 4594;

describe.skipIf(!enabled || !hasRequiredEnv)('real Daytona + Flue UAT', () => {
  let pool: Pool;
  let server: ChildProcess | undefined;

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
        RUNNER: 'flue',
        SANDBOX_PROVIDER: 'daytona',
        FLUE_SESSION_STORE: 'postgres',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHealth();
  });

  afterEach(async () => {
    if (server) {
      server.kill();
      await new Promise<void>((resolve) => server?.once('exit', () => resolve()));
    }
    await cleanupDaytonaSandboxes(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('runs a Flue prompt against a real Daytona sandbox', async () => {
    const createSession = await postJson('/sessions', { title: 'Real Daytona Flue UAT' });
    expect(createSession.status).toBe(201);
    const { session } = (await createSession.json()) as { session: { id: string } };

    const createMessage = await postJson(`/sessions/${session.id}/messages`, {
      prompt: 'Use the shell to run: echo flue-daytona-uat. Then reply with the exact output.',
    });
    expect(createMessage.status).toBe(202);

    const events = await waitForEvents(session.id, ['message_completed'], 180_000);
    expect(events.map((event) => event.type)).toContain('sandbox_ready');
    expect(events.map((event) => event.type)).toContain('run_completed');
    expect(events.map((event) => event.type)).toContain('message_completed');
  }, 180_000);
});

async function cleanupDaytonaSandboxes(pool: Pool): Promise<void> {
  const result = await pool.query<{ provider_sandbox_id: string }>(
    "SELECT provider_sandbox_id FROM sandboxes WHERE provider = 'daytona' AND destroyed_at IS NULL",
  );
  if (result.rows.length === 0) return;

  const config: NonNullable<ConstructorParameters<typeof Daytona>[0]> = { apiKey: process.env.DAYTONA_API_KEY! };
  if (process.env.DAYTONA_API_URL) config.apiUrl = process.env.DAYTONA_API_URL;
  if (process.env.DAYTONA_TARGET) config.target = process.env.DAYTONA_TARGET;
  const daytona = new Daytona(config);

  await Promise.all(
    result.rows.map(async (row) => {
      try {
        const sandbox = await daytona.get(row.provider_sandbox_id);
        await sandbox.delete();
      } catch {
        // Best-effort cleanup for an opt-in infrastructure UAT.
      }
    }),
  );
}

function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${uatPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitForHealth(): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${uatPort}/health`).catch(() => null);
    return response?.ok === true;
  });
}

async function waitForEvents(
  sessionId: string,
  terminalTypes: string[],
  timeoutMs: number,
): Promise<Array<{ type: string }>> {
  let lastEvents: Array<{ type: string }> = [];
  let lastBody: unknown;
  let lastStatus = 0;
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${uatPort}/sessions/${sessionId}/events`);
      lastStatus = response.status;
      const body = (await response.json()) as { events?: Array<{ type: string }> };
      lastBody = body;
      if (!Array.isArray(body.events)) return false;
      lastEvents = body.events;
      return terminalTypes.every((type) => lastEvents.some((event) => event.type === type));
    }, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}. Last events response status=${lastStatus} body=${JSON.stringify(lastBody)}`,
    );
  }

  return lastEvents;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Timed out waiting for condition');
}
