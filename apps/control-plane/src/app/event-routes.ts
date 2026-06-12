import type { Context, Hono } from 'hono';
import { canReadSession, readRequestAuthorization, type RequestAuthorization } from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import type { NormalizedEventType } from '../events/types.js';
import type { AppStore, EventRecord } from '../store/types.js';
import { writeGlobalEventStream } from './event-stream.js';
import { writeError } from './http-error.js';
import { parseCursor } from './request.js';
import type { AppServices, AppVariables } from './server.js';

const eventListDefaultLimit = 1000;
const eventListMaxLimit = 2000;
const eventReadCacheTtlMs = 30_000;
const eventReadCacheMaxSessions = 10_000;

// Session access events change the outcome of canReadSession, so they bypass the
// cache; they are ordered before any subsequent events for the same session, which
// keeps the cached decision current from the moment access changes.
const eventReadRefreshTypes = new Set<NormalizedEventType>(['session_created', 'session_updated']);

export function registerEventRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  app.get('/events', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const after = parseCursor(c.req.query('after') ?? null);
    const limit = parseEventListLimit(c.req.query('limit'));
    if (limit === null) return writeError(c, 400, 'invalid_request', 'Expected a positive integer limit');
    const includeAll = c.req.query('include') === 'all';
    const batch = await services.events.listAllBatch(after ?? 0, limit, includeAll);
    const events = await readableEvents(services.store, auth, batch.events);
    return c.json({ events, cursor: batch.cursor, hasMore: batch.hasMore });
  });

  app.get('/events/stream', async (c) => {
    const auth = await requireRequestAuthorization(config, services.store, c);
    if (!auth) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    const after = parseCursor(c.req.query('after') ?? c.req.header('last-event-id') ?? null) ?? 0;
    const includeAll = c.req.query('include') === 'all';
    return writeGlobalEventStream(c, services.events, after, c.req.query('replay') !== 'false', includeAll, {
      filter: createEventReadFilter(services.store, auth),
    });
  });
}

async function requireRequestAuthorization(
  config: AppConfig,
  store: AppStore,
  c: Context,
): Promise<RequestAuthorization | null> {
  return readRequestAuthorization(config, store, c);
}

async function readableEvents(
  store: AppStore,
  auth: RequestAuthorization,
  events: EventRecord[],
): Promise<EventRecord[]> {
  const filter = createEventReadFilter(store, auth);
  const readable: EventRecord[] = [];
  for (const event of events) {
    if (await filter(event)) readable.push(event);
  }
  return readable;
}

function parseEventListLimit(value: string | undefined): number | null {
  if (value === undefined) return eventListDefaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, eventListMaxLimit);
}

function createEventReadFilter(store: AppStore, auth: RequestAuthorization): (event: EventRecord) => Promise<boolean> {
  const decisions = new Map<string, { canRead: boolean; expiresAt: number }>();
  return async (event) => {
    const now = Date.now();
    if (!eventReadRefreshTypes.has(event.type)) {
      const cached = decisions.get(event.sessionId);
      if (cached && cached.expiresAt > now) return cached.canRead;
    }
    const session = await store.getSession(event.sessionId);
    const canRead = Boolean(session && canReadSession(auth, session));
    if (decisions.size >= eventReadCacheMaxSessions) decisions.clear();
    decisions.set(event.sessionId, { canRead, expiresAt: now + eventReadCacheTtlMs });
    return canRead;
  };
}
