import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { EventService } from '../../src/events/service.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';
import { PostgresStore } from '../../src/store/postgres.js';
import { WorkerService } from '../../src/worker/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const sessionCount = readPositiveIntEnv('LOAD_SESSION_COUNT', 1_000);
const messagesPerSession = readPositiveIntEnv('LOAD_MESSAGES_PER_SESSION', 2);
const workerCount = readPositiveIntEnv('LOAD_WORKER_COUNT', 10);
const maxSeconds = readPositiveIntEnv('LOAD_MAX_SECONDS', 120);

describe.skipIf(!testDatabaseUrl)('control-plane load', () => {
  let pool: Pool;
  let store: PostgresStore;

  beforeAll(async () => {
    await runMigrations(testDatabaseUrl!);
    pool = new Pool({ connectionString: testDatabaseUrl, max: Math.max(workerCount + 4, 10) });
    store = new PostgresStore(pool);
  });

  beforeEach(async () => {
    await truncateAppTables(pool);
  });

  afterAll(async () => {
    await store.close();
  });

  it('processes a seeded pending-message backlog without duplicate claims', async () => {
    const totalMessages = sessionCount * messagesPerSession;
    await seedPendingBacklog(pool, { sessionCount, messagesPerSession });

    const events = new EventService(store);
    const sandboxProvider = new FakeSandboxProvider();
    const processedRunsByWorker = new Array<number>(workerCount).fill(0);
    const startedAt = performance.now();

    await Promise.all(processedRunsByWorker.map(async (_, index) => {
      const worker = new WorkerService({
        store,
        events,
        runner: new FakeRunner(),
        runnerType: 'fake',
        sandboxProvider,
        leaseOwner: `load-worker-${index + 1}`,
        leaseDurationMs: 60_000,
        heartbeatIntervalMs: 30_000,
        cancellationPollIntervalMs: 30_000,
      });

      while (await worker.processNext()) {
        processedRunsByWorker[index] = (processedRunsByWorker[index] ?? 0) + 1;
      }
    }));

    const elapsedSeconds = (performance.now() - startedAt) / 1_000;
    const [messageCounts, runCounts, eventCount, sandboxCount] = await Promise.all([
      countByStatus(pool, 'messages'),
      countByStatus(pool, 'runs'),
      countRows(pool, 'events'),
      countRows(pool, 'sandboxes'),
    ]);
    const processedRuns = processedRunsByWorker.reduce((sum, count) => sum + count, 0);
    const summary = {
      sessionCount,
      messagesPerSession,
      totalMessages,
      workerCount,
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      messagesPerSecond: Number((totalMessages / elapsedSeconds).toFixed(1)),
      runsPerSecond: Number((processedRuns / elapsedSeconds).toFixed(1)),
      processedRuns,
      processedRunsByWorker,
      messageCounts,
      runCounts,
      eventCount,
      sandboxCount,
    };

    process.stdout.write(`\nload summary: ${JSON.stringify(summary)}\n`);

    expect(messageCounts).toEqual({ completed: totalMessages });
    expect(runCounts).toEqual({ completed: sessionCount });
    expect(processedRuns).toBe(sessionCount);
    expect(sandboxCount).toBe(sessionCount);
    expect(eventCount).toBeGreaterThanOrEqual(sessionCount * 6);
    expect(elapsedSeconds).toBeLessThan(maxSeconds);
  });
});

async function truncateAppTables(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE flue_sessions, callback_deliveries, artifacts, integration_deliveries, external_threads, sandboxes, events, runs, messages, session_sequence_counters, webhook_sources, sessions RESTART IDENTITY CASCADE',
  );
}

async function seedPendingBacklog(pool: Pool, input: { sessionCount: number; messagesPerSession: number }): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, status, title, created_at, updated_at)
     SELECT session_id, 'idle', 'Load session ' || session_index, now(), now()
     FROM (
       SELECT generate_series(1, $1::int) AS session_index
     ) sessions
     CROSS JOIN LATERAL (
       SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(session_index), 12, '0'))::uuid AS session_id
     ) ids`,
    [input.sessionCount],
  );

  await pool.query(
    `INSERT INTO messages (id, session_id, sequence, status, prompt, source, context, created_at)
     SELECT
       ('00000000-0000-4000-9000-' || lpad(to_hex(((session_index - 1) * $2::int) + message_sequence), 12, '0'))::uuid,
       ('00000000-0000-4000-8000-' || lpad(to_hex(session_index), 12, '0'))::uuid,
       message_sequence,
       'pending',
       'Load prompt ' || session_index || '.' || message_sequence,
       'load-test',
       '{}'::jsonb,
       now() + ((((session_index - 1) * $2::int) + message_sequence) || ' microseconds')::interval
     FROM generate_series(1, $1::int) AS session_index
     CROSS JOIN generate_series(1, $2::int) AS message_sequence`,
    [input.sessionCount, input.messagesPerSession],
  );
}

async function countByStatus(pool: Pool, table: 'messages' | 'runs'): Promise<Record<string, number>> {
  const result = await pool.query<{ status: string; count: string }>(`SELECT status, count(*)::text AS count FROM ${table} GROUP BY status ORDER BY status`);
  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
}

async function countRows(pool: Pool, table: 'events' | 'sandboxes'): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]!.count);
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
