import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const migrationsLockId = 742_358_002;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });

  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationsLockId]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS app_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const migrationFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

    for (const file of migrationFiles) {
      const applied = await client.query('SELECT 1 FROM app_migrations WHERE id = $1', [file]);
      if (applied.rowCount) continue;

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO app_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [migrationsLockId]);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  await runMigrations(databaseUrl);
}
