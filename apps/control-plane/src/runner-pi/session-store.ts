import { Pool, type QueryResultRow } from 'pg';
import type { SessionEntry, SessionHeader } from '@earendil-works/pi-coding-agent';

export const PI_SESSION_DATA_VERSION = 1;

export type PiSessionData = {
  version: typeof PI_SESSION_DATA_VERSION;
  header: SessionHeader;
  entries: SessionEntry[];
};

export interface PiSessionStore {
  load(id: string): Promise<PiSessionData | null>;
  save(id: string, data: PiSessionData): Promise<void>;
  delete?(id: string): Promise<void>;
  withLock?<T>(id: string, operation: () => Promise<T>): Promise<T>;
}

type PiSessionRow = QueryResultRow & {
  data: unknown;
};

export class PostgresPiSessionStore implements PiSessionStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string | Pool) {
    this.pool = typeof databaseUrl === 'string' ? new Pool({ connectionString: databaseUrl }) : databaseUrl;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async save(id: string, data: PiSessionData): Promise<void> {
    const now = new Date();
    await this.pool.query(
      `INSERT INTO pi_sessions (id, data, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data,
                     updated_at = EXCLUDED.updated_at`,
      [id, data, now],
    );
  }

  async load(id: string): Promise<PiSessionData | null> {
    const result = await this.pool.query<PiSessionRow>('SELECT data FROM pi_sessions WHERE id = $1', [id]);
    const data = result.rows[0]?.data;
    return data === undefined ? null : parsePiSessionData(data);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM pi_sessions WHERE id = $1', [id]);
  }

  async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [id]);
      return await operation();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [id]).catch(() => undefined);
      client.release();
    }
  }
}

function parsePiSessionData(data: unknown): PiSessionData {
  if (
    !isRecord(data) ||
    data.version !== PI_SESSION_DATA_VERSION ||
    !isRecord(data.header) ||
    !Array.isArray(data.entries)
  ) {
    throw new Error('Stored Pi session data has an unsupported format');
  }
  return data as PiSessionData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
