import type { SessionData, SessionStore } from '@flue/sdk';
import { Pool, type QueryResultRow } from 'pg';

type FlueSessionRow = QueryResultRow & {
  data: SessionData;
};

export class PostgresFlueSessionStore implements SessionStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string | Pool) {
    this.pool = typeof databaseUrl === 'string' ? new Pool({ connectionString: databaseUrl }) : databaseUrl;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async save(id: string, data: SessionData): Promise<void> {
    const now = new Date();
    await this.pool.query(
      `INSERT INTO flue_sessions (id, data, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data,
                     version = EXCLUDED.version,
                     updated_at = EXCLUDED.updated_at`,
      [id, data, data.version, now],
    );
  }

  async load(id: string): Promise<SessionData | null> {
    const result = await this.pool.query<FlueSessionRow>('SELECT data FROM flue_sessions WHERE id = $1', [id]);
    return result.rows[0]?.data ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM flue_sessions WHERE id = $1', [id]);
  }
}
