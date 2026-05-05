import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { apiAuthMiddleware } from '../auth/middleware.js';
import type { AppConfig } from '../config/index.js';
import { EventService } from '../events/service.js';
import { GenericWebhookError, GenericWebhookService } from '../integrations/generic-webhook/service.js';
import { MessageService, MessageServiceError } from '../messages/service.js';
import { SessionService, SessionServiceError } from '../sessions/service.js';
import { MemoryStore } from '../store/memory.js';
import type { AppStore } from '../store/types.js';

type AppVariables = {
  requestId: string;
};

export type AppServices = {
  store: AppStore;
  events: EventService;
  sessions: SessionService;
  messages: MessageService;
  genericWebhooks: GenericWebhookService;
};

export function createServices(store: AppStore = new MemoryStore()): AppServices {
  const events = new EventService(store);
  const sessions = new SessionService(store, events);
  const messages = new MessageService(store, events);
  return {
    store,
    events,
    sessions,
    messages,
    genericWebhooks: new GenericWebhookService(store, sessions, messages),
  };
}

export function createApp(config: AppConfig, services = createServices()) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', requestIdMiddleware());
  app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type', 'x-request-id'], allowMethods: ['GET', 'POST', 'OPTIONS'] }));

  app.onError((error, c) => {
    if (error instanceof HttpRequestError) {
      return writeError(c, error.statusCode, error.code, error.message);
    }
    return writeError(c, 500, 'internal_error', error instanceof Error ? error.message : 'Unknown error');
  });

  app.notFound((c) => c.json({ error: 'not_found', message: 'Route not found' }, 404));

  app.get('/health', (c) => c.json({ status: 'ok', runMode: config.runMode, apiAuthMode: config.apiAuthMode }));

  app.use('/sessions/*', apiAuthMiddleware(config));
  app.use('/sessions', apiAuthMiddleware(config));

  app.post('/sessions', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const title = optionalString(body.title);
    const session = await services.sessions.create(title ? { title } : {});
    return c.json({ session }, 201);
  });

  app.get('/sessions', async (c) => {
    const sessions = await services.store.listSessions();
    return c.json({ sessions });
  });

  app.post('/webhooks/generic/:sourceKey', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);

    try {
      const result = await services.genericWebhooks.handle({
        sourceKey: c.req.param('sourceKey'),
        authorization: c.req.header('authorization'),
        payload: body,
      });
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof GenericWebhookError) {
        const status = error.code === 'unauthorized' ? 401 : error.code === 'not_found' ? 404 : 400;
        return writeError(c, status, error.code, error.message);
      }
      throw error;
    }
  });

  app.get('/sessions/:sessionId', async (c) => {
    const session = await services.sessions.get(c.req.param('sessionId'));
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');
    return c.json({ session });
  });

  app.patch('/sessions/:sessionId', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const title = optionalString(body.title);
    if (body.title !== undefined && !title) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: title');

    try {
      const session = await services.sessions.update({ id: c.req.param('sessionId'), ...(title ? { title } : {}) });
      return c.json({ session });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found') {
        return writeError(c, 404, 'not_found', 'Session not found');
      }
      throw error;
    }
  });

  app.post('/sessions/:sessionId/archive', async (c) => {
    try {
      const session = await services.sessions.archive(c.req.param('sessionId'));
      return c.json({ session });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found') {
        return writeError(c, 404, 'not_found', 'Session not found');
      }
      throw error;
    }
  });

  app.post('/sessions/:sessionId/unarchive', async (c) => {
    try {
      const session = await services.sessions.unarchive(c.req.param('sessionId'));
      return c.json({ session });
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === 'not_found') {
        return writeError(c, 404, 'not_found', 'Session not found');
      }
      throw error;
    }
  });

  app.post('/sessions/:sessionId/messages', async (c) => {
    const sessionId = c.req.param('sessionId');
    const body = await readJsonBody(c, config.maxJsonBodyBytes);
    const prompt = optionalString(body.prompt);
    if (!prompt) return writeError(c, 400, 'invalid_request', 'Expected non-empty string field: prompt');

    try {
      const message = await services.messages.enqueue({ sessionId, prompt });
      return c.json({ message }, 202);
    } catch (error) {
      if (error instanceof MessageServiceError && error.code === 'not_found') {
        return writeError(c, 404, 'not_found', 'Session not found');
      }
      throw error;
    }
  });

  app.get('/sessions/:sessionId/messages', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const messages = await services.messages.list(sessionId);
    return c.json({ messages });
  });

  app.get('/sessions/:sessionId/events', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const after = parseCursor(c.req.query('after') ?? null);
    const events = await services.events.list(sessionId, after);
    return c.json({ events });
  });

  app.get('/sessions/:sessionId/artifacts', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const artifacts = await services.store.getArtifacts(sessionId);
    return c.json({ artifacts });
  });

  app.get('/sessions/:sessionId/events/stream', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await services.sessions.get(sessionId);
    if (!session) return writeError(c, 404, 'not_found', 'Session not found');

    const after = parseCursor(c.req.query('after') ?? null) ?? 0;
    return writeEventStream(c, services, sessionId, after);
  });

  return app;
}

export function createServer(config: AppConfig, services = createServices()) {
  return createAdaptorServer({ fetch: createApp(config, services).fetch }) as Server;
}

function requestIdMiddleware(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    c.set('requestId', c.req.header('x-request-id') ?? randomUUID());
    await next();
  };
}

function writeError(c: Context, statusCode: number, error: string, message: string) {
  return c.json({ error, message }, statusCode as never);
}

async function writeEventStream(
  c: Context,
  services: AppServices,
  sessionId: string,
  afterSequence: number,
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let cursor = afterSequence;

  const write = async (chunk: string) => {
    await writer.write(encoder.encode(chunk));
  };
  const writeEvent = (event: Awaited<ReturnType<EventService['list']>>[number]) => {
    if (event.sequence <= cursor) return;
    cursor = event.sequence;
    write(`id: ${event.sequence}\n`)
      .then(() => write(`event: ${event.type}\n`))
      .then(() => write(`data: ${JSON.stringify(event)}\n\n`))
      .catch(() => {});
  };

  const unsubscribe = services.events.subscribe(sessionId, writeEvent);
  const heartbeat = setInterval(() => {
    write(': keep-alive\n\n').catch(() => {});
  }, 15_000);

  c.req.raw.signal.addEventListener('abort', () => {
    clearInterval(heartbeat);
    unsubscribe();
    writer.close().catch(() => {});
  });

  void (async () => {
    try {
      await write(': connected\n\n');
      for (const event of await services.events.list(sessionId, afterSequence)) {
        writeEvent(event);
      }
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

async function readJsonBody(c: Context, maxBytes: number): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new HttpRequestError(413, 'payload_too_large', `JSON body exceeds ${maxBytes} bytes`);
  }

  const trimmed = text.trim();
  if (!trimmed) return {};

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new HttpRequestError(400, 'invalid_json', 'Expected valid JSON request body');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpRequestError(400, 'invalid_request', 'Expected JSON object request body');
  }

  return value as Record<string, unknown>;
}

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseCursor(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}
