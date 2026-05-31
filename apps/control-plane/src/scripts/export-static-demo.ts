import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { Pool, type QueryResultRow } from 'pg';
import {
  FilesystemArtifactObjectStorage,
  S3ArtifactObjectStorage,
  type ArtifactObjectStorage,
} from '../artifacts/storage.js';

type Args = {
  artifactOut: string;
  artifactPublicBase: string;
  includeArtifacts: boolean;
  latest: boolean;
  limit: number;
  out: string;
  sessionIds: string[];
};

type ExportedService = Record<string, unknown> & { port: number };

type SessionRow = QueryResultRow & {
  id: string;
  status: string;
  title: string | null;
  context: Record<string, unknown> | null;
  owner_group_id: string;
  visibility: string;
  write_policy: string;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  queue_paused_at: Date | null;
};

type MessageRow = QueryResultRow & {
  id: string;
  session_id: string;
  sequence: number | string;
  status: string;
  prompt: string;
  author_user_id: string | null;
  author_name: string | null;
  source: string | null;
  context: Record<string, unknown> | null;
  created_at: Date;
};

type EventRow = QueryResultRow & {
  id: number | string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  sequence: number | string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
};

type ArtifactRow = QueryResultRow & {
  id: string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  type: string;
  title: string | null;
  url: string | null;
  storage_key: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
};

type ExternalResourceRow = QueryResultRow & {
  id: string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  type: string;
  title: string | null;
  url: string;
  metadata: Record<string, unknown>;
  created_at: Date;
};

type CallbackDeliveryRow = QueryResultRow & {
  id: string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  target_type: string;
  target: Record<string, unknown>;
  status: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  delivered_at: Date | null;
};

type SandboxRow = QueryResultRow & {
  id: string;
  session_id: string;
  provider: string;
  provider_sandbox_id: string;
  status: string;
  metadata: Record<string, unknown>;
  updated_at: Date;
  destroyed_at: Date | null;
};

const args = parseArgs(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new Pool({ connectionString: databaseUrl });
const artifactStorage = args.includeArtifacts ? createArtifactStorage(process.env) : null;

try {
  const sessions = await loadSessions(pool, args);
  const demoSessions = await Promise.all(
    sessions.map(async (session) => ({
      session: toSession(session),
      messages: (await loadMessages(pool, session.id)).map(toMessage),
      events: (await loadEvents(pool, session.id)).map(toEvent),
      artifacts: await Promise.all(
        (await loadArtifacts(pool, session.id)).map((artifact) => toArtifact(artifact, artifactStorage, args)),
      ),
      externalResources: (await loadExternalResources(pool, session.id)).map(toExternalResource),
      callbacks: (await loadCallbackDeliveries(pool, session.id)).map(toCallbackDelivery),
      services: toServices(session, await loadSandboxes(pool, session.id)),
    })),
  );

  const outPath = resolve(args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), sessions: demoSessions }, null, 2)}\n`,
  );
  console.log(`Exported ${demoSessions.length} demo session(s) to ${outPath}`);
} finally {
  await pool.end();
}

function parseArgs(values: string[]): Args {
  const args: Args = {
    artifactOut: '../../apps/web/public/demo/artifacts',
    artifactPublicBase: '/static-demo/demo/artifacts',
    includeArtifacts: false,
    latest: false,
    limit: 3,
    out: '../../apps/web/public/demo/sessions.json',
    sessionIds: [],
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--') {
      continue;
    } else if (value === '--include-artifacts') {
      args.includeArtifacts = true;
    } else if (value === '--artifact-out') {
      args.artifactOut = requiredValue(values, (index += 1), value);
    } else if (value === '--artifact-public-base') {
      args.artifactPublicBase = requiredValue(values, (index += 1), value).replace(/\/$/, '');
    } else if (value === '--latest') {
      args.latest = true;
    } else if (value === '--limit') {
      args.limit = Number(requiredValue(values, (index += 1), value));
    } else if (value === '--out') {
      args.out = requiredValue(values, (index += 1), value);
    } else if (value === '--session-id') {
      args.sessionIds.push(requiredValue(values, (index += 1), value));
    } else if (value) {
      args.sessionIds.push(value);
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer.');
  if (!args.latest && !args.sessionIds.length) {
    throw new Error('Pass one or more --session-id values, or use --latest to export recent sessions.');
  }
  return args;
}

function requiredValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

async function loadSessions(pool: Pool, args: Args): Promise<SessionRow[]> {
  if (args.sessionIds.length) {
    const result = await pool.query<SessionRow>(
      `SELECT id, status, title, context, owner_group_id, visibility, write_policy, created_by_user_id, created_at, updated_at, queue_paused_at
       FROM sessions
       WHERE id = ANY($1::uuid[])
       ORDER BY array_position($1::uuid[], id) ASC`,
      [args.sessionIds],
    );
    return result.rows;
  }

  const result = await pool.query<SessionRow>(
    `SELECT id, status, title, context, owner_group_id, visibility, write_policy, created_by_user_id, created_at, updated_at, queue_paused_at
     FROM sessions
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $1`,
    [args.limit],
  );
  return result.rows;
}

async function loadMessages(pool: Pool, sessionId: string): Promise<MessageRow[]> {
  const result = await pool.query<MessageRow>(
    `SELECT id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at
     FROM messages
     WHERE session_id = $1
     ORDER BY sequence ASC`,
    [sessionId],
  );
  return result.rows;
}

async function loadEvents(pool: Pool, sessionId: string): Promise<EventRow[]> {
  const result = await pool.query<EventRow>(
    `SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at
     FROM events
     WHERE session_id = $1
     ORDER BY sequence ASC`,
    [sessionId],
  );
  return result.rows;
}

async function loadArtifacts(pool: Pool, sessionId: string): Promise<ArtifactRow[]> {
  const result = await pool.query<ArtifactRow>(
    `SELECT id, session_id, run_id, message_id, type, title, url, storage_key, payload, created_at
     FROM artifacts
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId],
  );
  return result.rows;
}

async function loadExternalResources(pool: Pool, sessionId: string): Promise<ExternalResourceRow[]> {
  const result = await pool.query<ExternalResourceRow>(
    `SELECT id, session_id, run_id, message_id, type, title, url, metadata, created_at
     FROM external_resources
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId],
  );
  return result.rows;
}

async function loadCallbackDeliveries(pool: Pool, sessionId: string): Promise<CallbackDeliveryRow[]> {
  const result = await pool.query<CallbackDeliveryRow>(
    `SELECT id, session_id, run_id, message_id, target_type, target, status, event_type, payload, attempts,
            max_attempts, last_error, created_at, updated_at, next_attempt_at, last_attempt_at, delivered_at
     FROM callback_deliveries
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId],
  );
  return result.rows;
}

async function loadSandboxes(pool: Pool, sessionId: string): Promise<SandboxRow[]> {
  const result = await pool.query<SandboxRow>(
    `SELECT id, session_id, provider, provider_sandbox_id, status, metadata, updated_at, destroyed_at
     FROM sandboxes
     WHERE session_id = $1
     ORDER BY updated_at DESC`,
    [sessionId],
  );
  return result.rows;
}

function toSession(row: SessionRow) {
  return dropUndefined({
    id: row.id,
    status: row.status,
    title: row.title ?? undefined,
    context: row.context ?? undefined,
    ownerGroupId: row.owner_group_id,
    visibility: row.visibility,
    writePolicy: row.write_policy,
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    queuePausedAt: row.queue_paused_at?.toISOString(),
  });
}

function toMessage(row: MessageRow) {
  return dropUndefined({
    id: row.id,
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    status: row.status,
    prompt: row.prompt,
    createdAt: row.created_at.toISOString(),
    authorUserId: row.author_user_id ?? undefined,
    authorName: row.author_name ?? undefined,
    source: row.source ?? undefined,
    context: row.context ?? undefined,
  });
}

function toEvent(row: EventRow) {
  return dropUndefined({
    id: Number(row.id),
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
    runId: row.run_id ?? undefined,
    messageId: row.message_id ?? undefined,
  });
}

async function toArtifact(row: ArtifactRow, storage: ArtifactObjectStorage | null, args: Args) {
  const staticObject = storage && row.storage_key ? await exportArtifactObject(row, storage, args) : null;
  return dropUndefined({
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    payload: staticObject
      ? {
          ...row.payload,
          contentType: row.payload.contentType ?? staticObject.contentType,
          fileName: row.payload.fileName ?? staticObject.fileName,
          staticDemo: { contentType: staticObject.contentType, fileName: staticObject.fileName, url: staticObject.url },
        }
      : row.payload,
    createdAt: row.created_at.toISOString(),
    title: row.title ?? undefined,
    url: staticObject?.url ?? row.url ?? undefined,
    storageKey: row.storage_key ?? undefined,
    runId: row.run_id ?? undefined,
    messageId: row.message_id ?? undefined,
  });
}

async function exportArtifactObject(row: ArtifactRow, storage: ArtifactObjectStorage, args: Args) {
  if (!row.storage_key) return null;
  const object = await storage.get(row.storage_key);
  if (!object) {
    console.warn(`Artifact object missing for ${row.id}: ${row.storage_key}`);
    return null;
  }

  const contentType = stringPayload(row.payload.contentType) ?? object.contentType ?? 'application/octet-stream';
  const fileName = safeFileName(
    stringPayload(row.payload.fileName) ?? row.title ?? `${row.id}${extensionForContentType(contentType)}`,
  );
  const artifactDirectory = resolve(args.artifactOut, row.id);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(resolve(artifactDirectory, fileName), object.body);
  await writeFile(
    resolve(artifactDirectory, 'metadata.json'),
    `${JSON.stringify({ contentType, fileName, sizeBytes: object.body.byteLength }, null, 2)}\n`,
  );

  return {
    contentType,
    fileName,
    url: `${args.artifactPublicBase}/${encodeURIComponent(row.id)}/${encodeURIComponent(fileName)}`,
  };
}

function createArtifactStorage(env: NodeJS.ProcessEnv): ArtifactObjectStorage {
  const provider = env.ARTIFACT_STORAGE_PROVIDER ?? 'disabled';
  if (provider === 'filesystem') {
    if (!env.ARTIFACT_STORAGE_FILESYSTEM_PATH) {
      throw new Error('ARTIFACT_STORAGE_FILESYSTEM_PATH is required when exporting filesystem artifacts.');
    }
    return new FilesystemArtifactObjectStorage(env.ARTIFACT_STORAGE_FILESYSTEM_PATH);
  }
  if (provider === 's3') {
    if (!env.ARTIFACT_STORAGE_S3_BUCKET) throw new Error('ARTIFACT_STORAGE_S3_BUCKET is required.');
    if (!env.ARTIFACT_STORAGE_S3_ACCESS_KEY_ID) throw new Error('ARTIFACT_STORAGE_S3_ACCESS_KEY_ID is required.');
    if (!env.ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY)
      throw new Error('ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY is required.');
    return new S3ArtifactObjectStorage(
      new S3Client({
        region: env.ARTIFACT_STORAGE_S3_REGION ?? 'us-east-1',
        forcePathStyle: parseBoolean(env.ARTIFACT_STORAGE_S3_FORCE_PATH_STYLE, true),
        credentials: {
          accessKeyId: env.ARTIFACT_STORAGE_S3_ACCESS_KEY_ID,
          secretAccessKey: env.ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY,
        },
        ...(env.ARTIFACT_STORAGE_S3_ENDPOINT ? { endpoint: env.ARTIFACT_STORAGE_S3_ENDPOINT } : {}),
      }),
      env.ARTIFACT_STORAGE_S3_BUCKET,
    );
  }
  throw new Error('Set ARTIFACT_STORAGE_PROVIDER to filesystem or s3 when using --include-artifacts.');
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/^\.+$/, '')
    .trim();
  return cleaned || 'artifact.bin';
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'video/mp4') return '.mp4';
  if (normalized === 'text/plain') return '.txt';
  if (normalized === 'application/json') return '.json';
  return extname(normalized) || '.bin';
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function toExternalResource(row: ExternalResourceRow) {
  return dropUndefined({
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    url: row.url,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
    title: row.title ?? undefined,
    runId: row.run_id ?? undefined,
    messageId: row.message_id ?? undefined,
  });
}

function toCallbackDelivery(row: CallbackDeliveryRow) {
  return dropUndefined({
    id: row.id,
    sessionId: row.session_id,
    targetType: row.target_type,
    target: row.target,
    status: row.status,
    eventType: row.event_type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    runId: row.run_id ?? undefined,
    messageId: row.message_id ?? undefined,
    lastError: row.last_error ?? undefined,
    nextAttemptAt: row.next_attempt_at?.toISOString(),
    lastAttemptAt: row.last_attempt_at?.toISOString(),
    deliveredAt: row.delivered_at?.toISOString(),
  });
}

function toServices(session: SessionRow, sandboxes: SandboxRow[]) {
  const servicesByPort = new Map<number, ExportedService>();
  for (const service of servicesFromValue(session.context?.services)) {
    servicesByPort.set(service.port, service);
  }
  for (const sandbox of sandboxes) {
    if (sandbox.destroyed_at) continue;
    for (const service of servicesFromValue(sandbox.metadata.services)) {
      servicesByPort.set(service.port, { ...service, ...servicesByPort.get(service.port) });
    }
  }
  return [...servicesByPort.values()].sort((a, b) => Number(a.port) - Number(b.port));
}

function servicesFromValue(value: unknown): ExportedService[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const service = serviceFromValue(item);
    return service ? [service] : [];
  });
}

function serviceFromValue(value: unknown): ExportedService | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const service = value as Record<string, unknown>;
  if (typeof service.port !== 'number' || !Number.isInteger(service.port)) return null;
  return dropUndefined({
    port: service.port,
    url: '#',
    status: 'available',
    label: stringPayload(service.label),
    path: stringPayload(service.path),
    providerSandboxId: stringPayload(service.providerSandboxId),
    runtimeId: stringPayload(service.runtimeId),
  });
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
}
