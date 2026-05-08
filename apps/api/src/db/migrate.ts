import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query('CREATE TABLE IF NOT EXISTS app_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const migrationFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

    for (const file of migrationFiles) {
      const applied = await pool.query('SELECT 1 FROM app_migrations WHERE id = $1', [file]);
      if (applied.rowCount) continue;

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query('INSERT INTO app_migrations (id) VALUES ($1)', [file]);
        await pool.query('COMMIT');
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  await runMigrations(databaseUrl);
}
