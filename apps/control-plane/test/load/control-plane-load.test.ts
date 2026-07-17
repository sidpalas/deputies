import { appendFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { ArtifactService } from '../../src/artifacts/service.js';
import { EventService } from '../../src/events/service.js';
import { runMigrations } from '../../src/db/migrate.js';
import { GenericWebhookService } from '../../src/integrations/generic-webhook/service.js';
import { MessageService } from '../../src/messages/service.js';
import { FakeRunner } from '../../src/runner/fake.js';
import type { Runner, RunnerInput, RunnerResult } from '../../src/runner/types.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';
import type {
  ConnectSandboxInput,
  CreateSandboxInput,
  SandboxCapabilities,
  SandboxHandle,
  SandboxHealth,
  SandboxProvider,
  SandboxRef,
} from '../../src/sandbox/types.js';
import { SessionService } from '../../src/sessions/service.js';
import { SkillService } from '../../src/skills/service.js';
import { PostgresStore } from '../../src/store/postgres.js';
import { WorkerService } from '../../src/worker/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const sessionCount = readPositiveIntEnv('LOAD_SESSION_COUNT', 1_000);
const messagesPerSession = readPositiveIntEnv('LOAD_MESSAGES_PER_SESSION', 2);
const workerCount = readPositiveIntEnv('LOAD_WORKER_COUNT', 10);
const maxSeconds = readPositiveNumberEnv('LOAD_MAX_SECONDS', 120);

const contentionSessionCount = readPositiveIntEnv('LOAD_CONTENTION_SESSION_COUNT', Math.max(sessionCount, 1_000));
const contentionWorkerCount = readPositiveIntEnv('LOAD_CONTENTION_WORKER_COUNT', Math.max(workerCount * 5, 25));
const readSessionCount = readPositiveIntEnv('LOAD_READ_SESSION_COUNT', Math.max(sessionCount, 1_000));
const readEventsPerSession = readPositiveIntEnv('LOAD_READ_EVENTS_PER_SESSION', 10);
const readHotSessionEvents = readPositiveIntEnv('LOAD_READ_HOT_SESSION_EVENTS', 2_500);
const webhookDeliveryCount = readPositiveIntEnv('LOAD_WEBHOOK_DELIVERY_COUNT', 1_000);
const webhookConcurrency = readPositiveIntEnv('LOAD_WEBHOOK_CONCURRENCY', 20);

const maxListSessionsMs = readPositiveNumberEnv('LOAD_MAX_LIST_SESSIONS_MS', 1_000);
const maxListEventsMs = readPositiveNumberEnv('LOAD_MAX_LIST_EVENTS_MS', 1_500);
const maxHotSessionEventsMs = readPositiveNumberEnv('LOAD_MAX_HOT_SESSION_EVENTS_MS', 500);
const maxWebhookSeconds = readPositiveNumberEnv('LOAD_MAX_WEBHOOK_SECONDS', 30);

const reportPath = process.env.LOAD_REPORT_PATH;

describe.skipIf(!testDatabaseUrl)('control-plane load', () => {
  let pool: Pool;
  let store: PostgresStore;

  beforeAll(async () => {
    await runMigrations(testDatabaseUrl!);
    pool = new Pool({
      connectionString: testDatabaseUrl,
      max: Math.max(workerCount + contentionWorkerCount + webhookConcurrency + 8, 20),
    });
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

    const storeProfiler = new MethodProfiler();
    const eventProfiler = new MethodProfiler();
    const sandboxProfiler = new MethodProfiler();
    const runnerProfiler = new MethodProfiler();
    const processNextProfiler = new MethodProfiler();
    const profiledStore = profileObject(store, storeProfiler);
    const events = profileObject(new EventService(profiledStore), eventProfiler);
    const sandboxProvider = new ProfilingSandboxProvider(new FakeSandboxProvider(), sandboxProfiler);
    const runner = new ProfilingRunner(new FakeRunner(), runnerProfiler);
    const processedRunsByWorker = new Array<number>(workerCount).fill(0);
    const startedAt = performance.now();

    await Promise.all(
      processedRunsByWorker.map(async (_, index) => {
        const worker = createWorker({
          store: profiledStore,
          events,
          runner,
          sandboxProvider,
          leaseOwner: `load-worker-${index + 1}`,
        });
        while (await processNextProfiler.measure('processNext', () => worker.processNext())) {
          processedRunsByWorker[index] = (processedRunsByWorker[index] ?? 0) + 1;
        }
      }),
    );

    const elapsedSeconds = secondsSince(startedAt);
    const [messageCounts, runCounts, eventCount, sandboxCount] = await Promise.all([
      countByStatus(pool, 'messages'),
      countByStatus(pool, 'runs'),
      countRows(pool, 'events'),
      countRows(pool, 'sandboxes'),
    ]);
    const processedRuns = processedRunsByWorker.reduce((sum, count) => sum + count, 0);
    const summary = await writeLoadSummary('worker_backlog', {
      sessionCount,
      messagesPerSession,
      totalMessages,
      workerCount,
      elapsedSeconds,
      messagesPerSecond: rate(totalMessages, elapsedSeconds),
      runsPerSecond: rate(processedRuns, elapsedSeconds),
      processedRuns,
      processedRunsByWorker,
      messageCounts,
      runCounts,
      eventCount,
      sandboxCount,
      approximateStoreCallsPerRun: round(storeProfiler.totalCount / Math.max(processedRuns, 1), 2),
      approximateEventAppendsPerRun: round(
        (eventProfiler.snapshot().append?.count ?? 0) / Math.max(processedRuns, 1),
        2,
      ),
      processNext: processNextProfiler.summary(),
      storeMethods: storeProfiler.summary({ top: 16 }),
      eventMethods: eventProfiler.summary(),
      runnerMethods: runnerProfiler.summary(),
      sandboxProviderMethods: sandboxProfiler.summary(),
    });

    expect(messageCounts).toEqual({ completed: totalMessages });
    expect(runCounts).toEqual({ completed: sessionCount });
    expect(processedRuns).toBe(sessionCount);
    expect(sandboxCount).toBe(sessionCount);
    expect(eventCount).toBeGreaterThanOrEqual(sessionCount * 6);
    expect(summary.elapsedSeconds).toBeLessThan(maxSeconds);
  });

  it('claims pending work correctly under high worker contention and mixed session states', async () => {
    await seedContentionBacklog(pool, { sessionCount: contentionSessionCount });
    const expectedClaimableSessions = await countClaimableContentionSessions(pool);
    const startedAt = performance.now();
    const claimedByWorker = new Array<number>(contentionWorkerCount).fill(0);
    const claimedRunIds = new Set<string>();
    const claimedMessageIds = new Set<string>();

    await Promise.all(
      claimedByWorker.map(async (_, index) => {
        while (true) {
          const batch = await store.claimNextPendingMessageBatch({
            runId: uuidFromInt('7000', (index + 1) * 1_000_000 + claimedByWorker[index]! + 1),
            runnerType: 'fake',
            leaseOwner: `contention-worker-${index + 1}`,
            leaseExpiresAt: new Date(Date.now() + 60_000),
            now: new Date(),
          });
          if (!batch) return;
          claimedByWorker[index] = claimedByWorker[index]! + 1;
          claimedRunIds.add(batch.run.id);
          for (const message of batch.messages) claimedMessageIds.add(message.id);
        }
      }),
    );

    const elapsedSeconds = secondsSince(startedAt);
    const [messageCounts, sessionCounts, runCounts] = await Promise.all([
      countByStatus(pool, 'messages'),
      countByStatus(pool, 'sessions'),
      countByStatus(pool, 'runs'),
    ]);
    const claimedRuns = claimedByWorker.reduce((sum, count) => sum + count, 0);
    await writeLoadSummary('queue_contention', {
      sessionCount: contentionSessionCount,
      workerCount: contentionWorkerCount,
      expectedClaimableSessions,
      elapsedSeconds,
      claimsPerSecond: rate(claimedRuns, elapsedSeconds),
      claimedRuns,
      claimedMessages: claimedMessageIds.size,
      claimedByWorker,
      messageCounts,
      sessionCounts,
      runCounts,
    });

    expect(claimedRuns).toBe(expectedClaimableSessions);
    expect(claimedRunIds.size).toBe(claimedRuns);
    expect(claimedMessageIds.size).toBe(claimedRuns);
    expect(messageCounts.processing).toBe(expectedClaimableSessions);
    expect(messageCounts.pending).toBe(contentionSessionCount - expectedClaimableSessions);
    expect(runCounts.running).toBeGreaterThanOrEqual(expectedClaimableSessions);
    expect(runCounts.running).toBeLessThanOrEqual(expectedClaimableSessions + Math.ceil(contentionSessionCount / 19));
    expect(sessionCounts.active).toBe(expectedClaimableSessions);
    expect(sessionCounts.archived).toBeGreaterThan(0);
    expect(sessionCounts.queued).toBeGreaterThan(0);
  });

  it('keeps session-list and event-replay read paths bounded with large seeded histories', async () => {
    const hotSessionId = uuidFromInt('8100', 1);
    await seedReadHeavyDataset(pool, {
      sessionCount: readSessionCount,
      eventsPerSession: readEventsPerSession,
      hotSessionEvents: readHotSessionEvents,
    });

    const listSessions = await measureAsync(() => store.listSessions());
    const listAllEvents = await measureAsync(() => store.listEvents(0));
    const hotSessionEvents = await measureAsync(() => store.getEvents(hotSessionId));
    const afterCursorEvents = await measureAsync(() =>
      store.listEvents(Math.floor((readSessionCount * readEventsPerSession) / 2)),
    );

    await writeLoadSummary('read_paths', {
      sessionCount: readSessionCount,
      eventsPerSession: readEventsPerSession,
      hotSessionEventCount: readHotSessionEvents,
      totalEvents: readSessionCount * readEventsPerSession + readHotSessionEvents,
      listSessions: summarizeMeasurement(listSessions),
      listAllEvents: summarizeMeasurement(listAllEvents),
      hotSessionReplay: summarizeMeasurement(hotSessionEvents),
      afterCursorEvents: summarizeMeasurement(afterCursorEvents),
    });

    expect(listSessions.value).toHaveLength(readSessionCount + 1);
    expect(listAllEvents.value).toHaveLength(readSessionCount * readEventsPerSession + readHotSessionEvents);
    expect(hotSessionEvents.value).toHaveLength(readHotSessionEvents);
    expect(afterCursorEvents.value.length).toBeGreaterThan(0);
    expect(listSessions.elapsedMs).toBeLessThan(maxListSessionsMs);
    expect(listAllEvents.elapsedMs).toBeLessThan(maxListEventsMs);
    expect(hotSessionEvents.elapsedMs).toBeLessThan(maxHotSessionEventsMs);
  });

  it('ingests generic webhook deliveries with dedupe under concurrent load', async () => {
    await seedWebhookSource(pool);
    const events = new EventService(store);
    const service = new GenericWebhookService(
      store,
      new SessionService(store, events),
      new MessageService(store, events),
      new SkillService(store),
    );
    const startedAt = performance.now();

    const results = await runConcurrent(webhookDeliveryCount, webhookConcurrency, async (index) => {
      const dedupeIndex = index % 10 === 0 ? index - 1 : index;
      return service.handle({
        sourceKey: 'load-generic',
        authorization: 'Bearer load-token',
        payload: {
          thread: { externalId: `thread-${Math.floor(index / 3)}` },
          dedupeKey: `delivery-${Math.max(dedupeIndex, 0)}`,
          prompt: `Load webhook prompt ${index}`,
          title: `Webhook load thread ${Math.floor(index / 3)}`,
          context: { index, duplicateOf: dedupeIndex === index ? undefined : dedupeIndex },
        },
      });
    });

    const elapsedSeconds = secondsSince(startedAt);
    const duplicateCount = results.filter((result) => result.duplicate).length;
    const acceptedCount = results.filter((result) => result.accepted && !result.duplicate).length;
    const expectedThreads = Math.ceil(webhookDeliveryCount / 3);
    const [messageCounts, sessionCounts, deliveryCounts, externalThreadCount] = await Promise.all([
      countByStatus(pool, 'messages'),
      countByStatus(pool, 'sessions'),
      countByStatus(pool, 'integration_deliveries'),
      countRows(pool, 'external_threads'),
    ]);
    await writeLoadSummary('generic_webhook_ingestion', {
      deliveryCount: webhookDeliveryCount,
      concurrency: webhookConcurrency,
      elapsedSeconds,
      deliveriesPerSecond: rate(webhookDeliveryCount, elapsedSeconds),
      acceptedCount,
      duplicateCount,
      expectedThreads,
      externalThreadCount,
      messageCounts,
      sessionCounts,
      deliveryCounts,
    });

    expect(duplicateCount).toBeGreaterThan(0);
    expect(acceptedCount + duplicateCount).toBe(webhookDeliveryCount);
    expect(messageCounts.pending).toBe(acceptedCount);
    expect(sessionCounts.created ?? 0).toBe(0);
    expect(sessionCounts.queued).toBe(expectedThreads);
    expect(externalThreadCount).toBe(expectedThreads);
    expect(deliveryCounts.processed).toBe(acceptedCount);
    expect(elapsedSeconds).toBeLessThan(maxWebhookSeconds);
  });
});

function createWorker(input: {
  store: PostgresStore;
  events: EventService;
  sandboxProvider: SandboxProvider;
  leaseOwner: string;
  runner?: Runner;
}): WorkerService {
  return new WorkerService({
    store: input.store,
    events: input.events,
    artifacts: new ArtifactService(input.store, input.events),
    runner: input.runner ?? new FakeRunner(),
    runnerType: 'fake',
    sandboxProvider: input.sandboxProvider,
    leaseOwner: input.leaseOwner,
    leaseDurationMs: 60_000,
    heartbeatIntervalMs: 30_000,
    cancellationPollIntervalMs: 30_000,
  });
}

type MethodStats = { count: number; totalMs: number; maxMs: number };

class MethodProfiler {
  private readonly stats = new Map<string, MethodStats>();

  get totalCount(): number {
    return Array.from(this.stats.values()).reduce((sum, item) => sum + item.count, 0);
  }

  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      this.record(name, performance.now() - startedAt);
    }
  }

  record(name: string, elapsedMs: number): void {
    const existing = this.stats.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    existing.count += 1;
    existing.totalMs += elapsedMs;
    existing.maxMs = Math.max(existing.maxMs, elapsedMs);
    this.stats.set(name, existing);
  }

  snapshot(): Record<string, MethodStats> {
    return Object.fromEntries(Array.from(this.stats.entries()).map(([name, item]) => [name, { ...item }]));
  }

  summary(
    options: { top?: number } = {},
  ): Record<string, { count: number; totalMs: number; avgMs: number; maxMs: number }> {
    return Object.fromEntries(
      Array.from(this.stats.entries())
        .sort(([, left], [, right]) => right.totalMs - left.totalMs)
        .slice(0, options.top ?? Number.POSITIVE_INFINITY)
        .map(([name, item]) => [
          name,
          {
            count: item.count,
            totalMs: round(item.totalMs, 3),
            avgMs: round(item.totalMs / item.count, 3),
            maxMs: round(item.maxMs, 3),
          },
        ]),
    );
  }
}

function profileObject<T extends object>(target: T, profiler: MethodProfiler): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return (...args: unknown[]) => profiler.measure(property, () => Promise.resolve(value.apply(object, args)));
    },
  });
}

class ProfilingRunner implements Runner {
  constructor(
    private readonly delegate: Runner,
    private readonly profiler: MethodProfiler,
  ) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    return this.profiler.measure('run', () => this.delegate.run(input));
  }
}

class ProfilingSandboxProvider implements SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxCapabilities;

  constructor(
    private readonly delegate: SandboxProvider,
    private readonly profiler: MethodProfiler,
  ) {
    this.name = delegate.name;
    this.capabilities = delegate.capabilities;
  }

  create(input: CreateSandboxInput): Promise<SandboxHandle> {
    return this.profiler.measure('create', () => this.delegate.create(input));
  }

  connect(input: ConnectSandboxInput): Promise<SandboxHandle> {
    return this.profiler.measure('connect', () => this.delegate.connect(input));
  }

  start(input: SandboxRef): Promise<void> {
    return this.delegate.start ? this.profiler.measure('start', () => this.delegate.start!(input)) : Promise.resolve();
  }

  stop(input: SandboxRef): Promise<void> {
    return this.delegate.stop ? this.profiler.measure('stop', () => this.delegate.stop!(input)) : Promise.resolve();
  }

  destroy(input: SandboxRef): Promise<void> {
    return this.profiler.measure('destroy', () => this.delegate.destroy(input));
  }

  health(input: SandboxRef): Promise<SandboxHealth> {
    return this.profiler.measure('health', () => this.delegate.health(input));
  }
}

async function truncateAppTables(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE pi_sessions, callback_deliveries, artifacts, integration_deliveries, external_threads, sandboxes, events, runs, messages, session_sequence_counters, webhook_sources, auth_sessions, auth_accounts, auth_users, sessions RESTART IDENTITY CASCADE',
  );
}

async function seedPendingBacklog(
  pool: Pool,
  input: { sessionCount: number; messagesPerSession: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, status, title, created_at, updated_at)
     SELECT session_id, 'idle', 'Load session ' || session_index, now(), now()
     FROM generate_series(1, $1::int) AS session_index
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

async function seedContentionBacklog(pool: Pool, input: { sessionCount: number }): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, status, title, queue_paused_at, created_at, updated_at)
     SELECT
       ('00000000-0000-4000-a000-' || lpad(to_hex(session_index), 12, '0'))::uuid,
       CASE WHEN session_index % 17 = 0 THEN 'archived' ELSE 'queued' END,
       'Contention session ' || session_index,
       CASE WHEN session_index % 13 = 0 THEN now() ELSE NULL END,
       now() - (session_index || ' seconds')::interval,
       now() - (session_index || ' seconds')::interval
     FROM generate_series(1, $1::int) AS session_index`,
    [input.sessionCount],
  );

  await pool.query(
    `INSERT INTO messages (id, session_id, sequence, status, prompt, source, context, created_at)
     SELECT
       ('00000000-0000-4000-a100-' || lpad(to_hex(session_index), 12, '0'))::uuid,
       ('00000000-0000-4000-a000-' || lpad(to_hex(session_index), 12, '0'))::uuid,
       1,
       'pending',
       'Contention prompt ' || session_index,
       'load-contention',
       '{}'::jsonb,
       now() - (($1::int - session_index) || ' milliseconds')::interval
     FROM generate_series(1, $1::int) AS session_index`,
    [input.sessionCount],
  );

  await pool.query(
    `INSERT INTO runs (id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, started_at, metadata)
     SELECT
       ('00000000-0000-4000-a200-' || lpad(to_hex(session_index), 12, '0'))::uuid,
       ('00000000-0000-4000-a000-' || lpad(to_hex(session_index), 12, '0'))::uuid,
       ('00000000-0000-4000-a100-' || lpad(to_hex(session_index), 12, '0'))::uuid,
       'running',
       'fake',
       'existing-worker',
       now() + interval '1 minute',
       now(),
       now(),
       '{}'::jsonb
     FROM generate_series(1, $1::int) AS session_index
     WHERE session_index % 19 = 0`,
    [input.sessionCount],
  );
}

async function countClaimableContentionSessions(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     WHERE m.status = 'pending'
       AND s.status <> 'archived'
       AND s.queue_paused_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM runs r
         WHERE r.session_id = m.session_id
           AND r.status IN ('starting', 'running', 'cancelling')
           AND (r.lease_expires_at IS NULL OR r.lease_expires_at > now())
       )`,
  );
  return Number(result.rows[0]!.count);
}

async function seedReadHeavyDataset(
  pool: Pool,
  input: { sessionCount: number; eventsPerSession: number; hotSessionEvents: number },
): Promise<void> {
  const hotSessionId = uuidFromInt('8100', 1);
  await pool.query(
    `INSERT INTO sessions (id, status, title, context, created_at, updated_at)
     VALUES ($1, 'idle', 'Hot event session', '{"kind":"hot"}'::jsonb, now() - interval '7 days', now())`,
    [hotSessionId],
  );

  await pool.query(
    `INSERT INTO sessions (id, status, title, context, queue_paused_at, created_at, updated_at)
     SELECT
       ('00000000-0000-4000-8200-' || lpad(to_hex(session_index), 12, '0'))::uuid,
       CASE
         WHEN session_index % 29 = 0 THEN 'archived'
         WHEN session_index % 23 = 0 THEN 'active'
         WHEN session_index % 19 = 0 THEN 'failed'
         WHEN session_index % 17 = 0 THEN 'queued'
         ELSE 'idle'
       END,
       'Read session ' || session_index,
       jsonb_build_object('index', session_index, 'source', CASE WHEN session_index % 2 = 0 THEN 'github' ELSE 'slack' END),
       CASE WHEN session_index % 31 = 0 THEN now() - interval '1 hour' ELSE NULL END,
       now() - (session_index || ' minutes')::interval,
       now() - (session_index || ' seconds')::interval
     FROM generate_series(1, $1::int) AS session_index`,
    [input.sessionCount],
  );

  await pool.query(
    `INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
     SELECT
       ('00000000-0000-4000-8200-' || lpad(to_hex(session_index), 12, '0'))::uuid,
       NULL,
       NULL,
       event_sequence,
       CASE WHEN event_sequence % 5 = 0 THEN 'agent_text_delta' ELSE 'run_started' END,
       jsonb_build_object('index', event_sequence, 'text', repeat('event payload ', CASE WHEN event_sequence % 11 = 0 THEN 20 ELSE 1 END)),
       now() - (session_index || ' seconds')::interval + (event_sequence || ' milliseconds')::interval
     FROM generate_series(1, $1::int) AS session_index
     CROSS JOIN generate_series(1, $2::int) AS event_sequence`,
    [input.sessionCount, input.eventsPerSession],
  );

  await pool.query(
    `INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
     SELECT
       $1::uuid,
       NULL,
       NULL,
       event_sequence,
       CASE WHEN event_sequence % 3 = 0 THEN 'agent_text_delta' ELSE 'run_completed' END,
       jsonb_build_object('index', event_sequence, 'text', repeat('hot event payload ', CASE WHEN event_sequence % 7 = 0 THEN 50 ELSE 2 END)),
       now() - interval '1 day' + (event_sequence || ' milliseconds')::interval
     FROM generate_series(1, $2::int) AS event_sequence`,
    [hotSessionId, input.hotSessionEvents],
  );
}

async function seedWebhookSource(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO webhook_sources (id, key, name, enabled, bearer_token, prompt_prefix, created_at, updated_at)
     VALUES ('00000000-0000-4000-b000-000000000001'::uuid, 'load-generic', 'Load Generic', true, 'load-token', 'Load prefix', now(), now())`,
  );
}

async function runConcurrent<T>(count: number, concurrency: number, task: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let nextIndex = 0;

  await Promise.all(
    new Array(Math.min(count, concurrency)).fill(0).map(async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= count) return;
        results[index] = await task(index);
      }
    }),
  );

  return results;
}

async function countByStatus(
  pool: Pool,
  table: 'messages' | 'runs' | 'sessions' | 'integration_deliveries',
): Promise<Record<string, number>> {
  const result = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM ${table} GROUP BY status ORDER BY status`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
}

async function countRows(pool: Pool, table: 'events' | 'external_threads' | 'sandboxes'): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]!.count);
}

async function measureAsync<T>(fn: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = performance.now();
  const value = await fn();
  return { value, elapsedMs: round(performance.now() - startedAt, 3) };
}

function summarizeMeasurement<T>(measurement: { value: T; elapsedMs: number }): { elapsedMs: number; rows?: number } {
  return {
    elapsedMs: measurement.elapsedMs,
    ...(Array.isArray(measurement.value) ? { rows: measurement.value.length } : {}),
  };
}

async function writeLoadSummary(name: string, metrics: Record<string, unknown>): Promise<Record<string, unknown>> {
  const summary = { name, timestamp: new Date().toISOString(), ...metrics };
  const line = JSON.stringify(summary);
  process.stdout.write(`\nload summary: ${line}\n`);
  if (reportPath) await appendFile(reportPath, `${line}\n`, 'utf8');
  return summary;
}

function secondsSince(startedAt: number): number {
  return round((performance.now() - startedAt) / 1_000, 3);
}

function rate(count: number, seconds: number): number {
  return round(count / Math.max(seconds, 0.001), 1);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function uuidFromInt(prefix: string, value: number): string {
  return `00000000-0000-4000-${prefix}-${value.toString(16).padStart(12, '0')}`;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = readPositiveNumberEnv(name, fallback);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}
