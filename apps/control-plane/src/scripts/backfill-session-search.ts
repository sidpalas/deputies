import { Pool, type QueryResult, type QueryResultRow } from 'pg';

type Args = { batchSize: number };
type DocKind = 'title' | 'prompt' | 'response';
type SearchDoc = { sessionId: string; kind: DocKind; sourceId: string; content: string; createdAt: Date };

type SessionRow = QueryResultRow & {
  id: string;
  title: string | null;
  created_at: Date;
};

type MessageRow = QueryResultRow & {
  id: string;
  session_id: string;
  prompt: string;
  created_at: Date;
};

type EventRow = QueryResultRow & {
  id: number | string;
  session_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
};

const maxIndexedContentChars = 16 * 1024;
const args = parseArgs(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required.');

const pool = new Pool({ connectionString: databaseUrl });

try {
  const highWaterEventId = await readHighWaterEventId(pool);
  const counts = {
    titles: await backfillTitles(pool, args.batchSize),
    prompts: await backfillPrompts(pool, args.batchSize),
    responses: await backfillResponses(pool, args.batchSize, highWaterEventId),
  };
  await seedCursor(pool, highWaterEventId);
  console.log(`Backfilled session search docs: ${JSON.stringify(counts)}`);
} finally {
  await pool.end();
}

function parseArgs(values: string[]): Args {
  const args: Args = { batchSize: 1_000 };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--batch-size') args.batchSize = Number(requiredValue(values, (index += 1), value));
    else if (value) throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1)
    throw new Error('--batch-size must be a positive integer.');
  return args;
}

function requiredValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

async function backfillTitles(pool: Pool, batchSize: number): Promise<number> {
  let cursor: { createdAt: Date; id: string } | null = null;
  let count = 0;
  for (;;) {
    const result: QueryResult<SessionRow> = await pool.query<SessionRow>(
      `SELECT id, title, created_at
       FROM sessions
       WHERE $1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::uuid)
       ORDER BY created_at ASC, id ASC
       LIMIT $3`,
      [cursor?.createdAt ?? null, cursor?.id ?? null, batchSize],
    );
    if (!result.rows.length) return count;
    await upsertDocs(
      pool,
      result.rows.map((row: SessionRow) => ({
        sessionId: row.id,
        kind: 'title',
        sourceId: row.id,
        content: row.title ?? '',
        createdAt: row.created_at,
      })),
    );
    count += result.rows.length;
    const last: SessionRow = result.rows.at(-1)!;
    cursor = { createdAt: last.created_at, id: last.id };
  }
}

async function backfillPrompts(pool: Pool, batchSize: number): Promise<number> {
  let cursor: { createdAt: Date; id: string } | null = null;
  let count = 0;
  for (;;) {
    const result: QueryResult<MessageRow> = await pool.query<MessageRow>(
      `SELECT id, session_id, prompt, created_at
       FROM messages
       WHERE $1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::uuid)
       ORDER BY created_at ASC, id ASC
       LIMIT $3`,
      [cursor?.createdAt ?? null, cursor?.id ?? null, batchSize],
    );
    if (!result.rows.length) return count;
    await upsertDocs(
      pool,
      result.rows.map((row: MessageRow) => ({
        sessionId: row.session_id,
        kind: 'prompt',
        sourceId: row.id,
        content: row.prompt,
        createdAt: row.created_at,
      })),
    );
    count += result.rows.length;
    const last: MessageRow = result.rows.at(-1)!;
    cursor = { createdAt: last.created_at, id: last.id };
  }
}

async function backfillResponses(pool: Pool, batchSize: number, highWaterEventId: number): Promise<number> {
  let afterId = 0;
  let count = 0;
  for (;;) {
    const result = await pool.query<EventRow>(
      `SELECT id, session_id, payload, created_at
       FROM events
       WHERE id > $1
          AND id <= $2
          AND type = 'agent_response_final'
          AND jsonb_typeof(payload->'text') = 'string'
       ORDER BY id ASC
       LIMIT $3`,
      [afterId, highWaterEventId, batchSize],
    );
    if (!result.rows.length) return count;
    await upsertDocs(
      pool,
      result.rows.map((row) => ({
        sessionId: row.session_id,
        kind: 'response',
        sourceId: String(row.id),
        content: String(row.payload.text),
        createdAt: row.created_at,
      })),
    );
    count += result.rows.length;
    afterId = Number(result.rows.at(-1)!.id);
  }
}

async function upsertDocs(pool: Pool, docs: SearchDoc[]): Promise<void> {
  if (!docs.length) return;
  await pool.query(
    `INSERT INTO session_search_docs (session_id, kind, source_id, content, created_at)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])
     ON CONFLICT (session_id, kind, source_id) DO UPDATE
     SET content = EXCLUDED.content,
         created_at = EXCLUDED.created_at`,
    [
      docs.map((doc) => doc.sessionId),
      docs.map((doc) => doc.kind),
      docs.map((doc) => doc.sourceId),
      docs.map((doc) => doc.content.replaceAll('\u0000', '').slice(0, maxIndexedContentChars)),
      docs.map((doc) => doc.createdAt),
    ],
  );
}

async function readHighWaterEventId(pool: Pool): Promise<number> {
  const result = await pool.query<{ max_id: number | string | null }>('SELECT max(id) AS max_id FROM events');
  return Number(result.rows[0]?.max_id ?? 0);
}

async function seedCursor(pool: Pool, highWaterEventId: number): Promise<void> {
  await pool.query(
    `INSERT INTO search_index_cursor (id, last_event_id)
     VALUES (true, $1)
     ON CONFLICT (id) DO UPDATE SET last_event_id = GREATEST(search_index_cursor.last_event_id, EXCLUDED.last_event_id)`,
    [highWaterEventId],
  );
}
