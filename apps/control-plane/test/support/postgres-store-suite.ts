import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { PostgresStore } from '../../src/store/postgres.js';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export type PostgresStoreSuiteContext = {
  databaseUrl: string;
  pool: Pool;
  store: PostgresStore;
};

const truncateTables =
  'TRUNCATE pi_sessions, flue_sessions, callback_deliveries, artifacts, integration_deliveries, external_threads, sandboxes, events, runs, messages, session_sequence_counters, webhook_sources, sessions RESTART IDENTITY CASCADE';

export function setupPostgresStoreSuite(suiteName: string, assign: (context: PostgresStoreSuiteContext) => void): void {
  let databaseUrl = '';
  let pool: Pool | undefined;
  let store: PostgresStore | undefined;

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    databaseUrl = await resetSuiteDatabase(testDatabaseUrl, suiteName);
    pool = new Pool({ connectionString: databaseUrl });
  });

  beforeEach(async () => {
    if (!pool) return;
    await pool.query(truncateTables);
    store = new PostgresStore(databaseUrl);
    assign({ databaseUrl, pool, store });
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
  });

  afterAll(async () => {
    await pool?.end();
  });
}

async function resetSuiteDatabase(baseDatabaseUrl: string, suiteName: string): Promise<string> {
  const suiteDatabaseUrl = suiteDatabaseUrlFor(baseDatabaseUrl, suiteName);
  const databaseName = new URL(suiteDatabaseUrl).pathname.replace(/^\//, '');
  if (!/test/i.test(databaseName)) {
    throw new Error(
      `Refusing to reset database "${databaseName}": TEST_DATABASE_URL must point at a dedicated test database (name containing "test", e.g. flue_test)`,
    );
  }

  const adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = '/postgres';
  const bootstrap = new Pool({ connectionString: adminUrl.toString() });
  try {
    await bootstrap.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await bootstrap.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await bootstrap.end();
  }

  await runMigrations(suiteDatabaseUrl);
  return suiteDatabaseUrl;
}

function suiteDatabaseUrlFor(baseDatabaseUrl: string, suiteName: string): string {
  const url = new URL(baseDatabaseUrl);
  const baseDatabaseName = url.pathname.replace(/^\//, '');
  const suffix = suiteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  url.pathname = `/${`${baseDatabaseName}_${suffix}`.slice(0, 63)}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
