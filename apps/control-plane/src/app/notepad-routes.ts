import type { Context, Hono } from 'hono';
import { readRequestAuthorization, type RequestAuthorization } from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import { NotepadServiceError } from '../notepads/service.js';
import { StoreConflictError, type NotepadActor } from '../store/types.js';
import { writeError } from './http-error.js';
import { readJsonBody } from './request.js';
import type { AppServices, AppVariables } from './server.js';

type NotepadContext = Context<{ Variables: AppVariables }>;

export function registerNotepadRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  const authorized = async (c: NotepadContext) => {
    const auth = await readRequestAuthorization(config, services.store, c);
    if (!auth) throw new NotepadServiceError('unauthenticated', 'Authentication required');
    return auth;
  };
  const body = (c: NotepadContext) => readJsonBody(c, config.maxJsonBodyBytes);

  app.get('/sessions/:sessionId/notepad', async (c) =>
    handle(c, async () => {
      const notepad = await services.notepads.readSession(await authorized(c), uuidParam(c, 'sessionId'));
      if (c.req.query('metadata') !== 'true') return { notepad };
      const { content: _content, ...metadata } = notepad;
      return { notepad: metadata };
    }),
  );
  for (const [path, field] of [
    ['/sessions/:sessionId/notepad', 'content'],
    ['/sessions/:sessionId/notepad/append', 'append'],
    ['/sessions/:sessionId/notepad/patch', 'patch'],
  ] as const) {
    app.post(path, async (c) =>
      handle(c, async () => ({
        notepad: await services.notepads.mutateSession(
          await authorized(c),
          uuidParam(c, 'sessionId'),
          mutationInput(await body(c), field),
          actor(await authorized(c)),
        ),
      })),
    );
  }
  app.put('/sessions/:sessionId/notepad', async (c) =>
    handle(c, async () => ({
      notepad: await services.notepads.mutateSession(
        await authorized(c),
        uuidParam(c, 'sessionId'),
        await body(c),
        actor(await authorized(c)),
      ),
    })),
  );
  app.get('/sessions/:sessionId/notepad/history', async (c) =>
    handle(c, async () =>
      historyResponse(
        await services.notepads.history(
          await authorized(c),
          'session',
          uuidParam(c, 'sessionId'),
          queryInt(c, 'limit', 50),
          queryInt(c, 'cursor', 0),
        ),
      ),
    ),
  );
  app.get('/sessions/:sessionId/notepad/history/:revision', async (c) =>
    handle(c, async () => ({
      revision: await services.notepads.readRevision(
        await authorized(c),
        'session',
        uuidParam(c, 'sessionId'),
        revisionParam(c),
      ),
    })),
  );
  app.post('/sessions/:sessionId/notepad/restore/:revision', async (c) =>
    handle(c, async () => ({
      notepad: await services.notepads.restoreRevision(
        await authorized(c),
        'session',
        uuidParam(c, 'sessionId'),
        revisionParam(c),
        (await body(c)).expectedRevision,
        actor(await authorized(c)),
      ),
    })),
  );

  app.get('/notepads', async (c) =>
    handle(c, async () => ({
      notepads: await services.notepads.list(
        await authorized(c),
        optionalUuidQuery(c, 'groupId'),
        queryInt(c, 'limit', 50),
        queryInt(c, 'cursor', 0),
      ),
    })),
  );
  app.get('/notepads/search', async (c) =>
    handle(c, async () => ({
      results: await services.notepads.search(
        await authorized(c),
        requiredUuidQuery(c, 'groupId'),
        c.req.query('q'),
        queryInt(c, 'limit', 20),
      ),
    })),
  );
  app.get('/groups/:groupId/notepads/inventory', async (c) =>
    handle(c, async () => ({
      notepads: await services.notepads.inventory(
        await authorized(c),
        uuidParam(c, 'groupId'),
        queryInt(c, 'limit', 50),
        queryInt(c, 'cursor', 0),
      ),
    })),
  );
  app.post('/notepads', async (c) =>
    handle(
      c,
      async () => {
        const auth = await authorized(c);
        const input = await body(c);
        if (typeof input.ownerGroupId === 'string') validUuid(input.ownerGroupId, 'ownerGroupId');
        if ('initialWritableSessionId' in input) {
          if (typeof input.initialWritableSessionId !== 'string')
            throw new NotepadServiceError('invalid', 'initialWritableSessionId must be a UUID string');
          validUuid(input.initialWritableSessionId, 'initialWritableSessionId');
        }
        return {
          notepad: await services.notepads.create(
            auth,
            input,
            actor(auth),
            input.initialWritableSessionId as string | undefined,
          ),
        };
      },
      201,
    ),
  );
  app.get('/notepads/:id', async (c) =>
    handle(c, async () => ({
      notepad: await services.notepads.requireReadable(
        await authorized(c),
        uuidParam(c, 'id'),
        optionalUuidQuery(c, 'sessionId'),
      ),
    })),
  );
  app.patch('/notepads/:id', async (c) =>
    handle(c, async () => ({
      notepad: await services.notepads.metadata(
        await authorized(c),
        uuidParam(c, 'id'),
        await body(c),
        actor(await authorized(c)),
      ),
    })),
  );
  for (const [path, field] of [
    ['/notepads/:id/content', 'content'],
    ['/notepads/:id/append', 'append'],
    ['/notepads/:id/patch', 'patch'],
  ] as const) {
    app.post(path, async (c) =>
      handle(c, async () => ({
        notepad: await services.notepads.mutateExplicit(
          await authorized(c),
          uuidParam(c, 'id'),
          mutationInput(await body(c), field),
          actor(await authorized(c)),
          optionalUuidQuery(c, 'sessionId'),
        ),
      })),
    );
  }
  app.put('/notepads/:id/content', async (c) =>
    handle(c, async () => ({
      notepad: await services.notepads.mutateExplicit(
        await authorized(c),
        uuidParam(c, 'id'),
        await body(c),
        actor(await authorized(c)),
        optionalUuidQuery(c, 'sessionId'),
      ),
    })),
  );
  app.get('/notepads/:id/history', async (c) =>
    handle(c, async () =>
      historyResponse(
        await services.notepads.history(
          await authorized(c),
          'explicit',
          uuidParam(c, 'id'),
          queryInt(c, 'limit', 50),
          queryInt(c, 'cursor', 0),
          optionalUuidQuery(c, 'sessionId'),
        ),
      ),
    ),
  );
  app.get('/notepads/:id/history/:revision', async (c) =>
    handle(c, async () => ({
      revision: await services.notepads.readRevision(
        await authorized(c),
        'explicit',
        uuidParam(c, 'id'),
        revisionParam(c),
        optionalUuidQuery(c, 'sessionId'),
      ),
    })),
  );
  app.post('/notepads/:id/history/:revision/restore', async (c) =>
    handle(c, async () => ({
      notepad: await services.notepads.restoreRevision(
        await authorized(c),
        'explicit',
        uuidParam(c, 'id'),
        revisionParam(c),
        (await body(c)).expectedRevision,
        actor(await authorized(c)),
        optionalUuidQuery(c, 'sessionId'),
      ),
    })),
  );
  app.get('/notepads/:id/activity', async (c) =>
    handle(c, async () => ({
      activity: await services.notepads.activityList(
        await authorized(c),
        uuidParam(c, 'id'),
        queryInt(c, 'limit', 50),
        queryInt(c, 'cursor', 0),
      ),
    })),
  );
  app.get('/notepads/:id/associations', async (c) =>
    handle(c, async () => ({
      associations: await services.notepads.associations(
        await authorized(c),
        uuidParam(c, 'id'),
        queryInt(c, 'limit', 50),
        queryInt(c, 'cursor', 0),
      ),
    })),
  );
  app.put('/notepads/:id/associations/:sessionId', async (c) =>
    handle(c, async () => {
      const auth = await authorized(c);
      return {
        association: await services.notepads.putAssociation(
          auth,
          uuidParam(c, 'id'),
          uuidParam(c, 'sessionId'),
          actor(auth),
        ),
      };
    }),
  );
  app.delete('/notepads/:id/associations/:sessionId', async (c) =>
    handle(c, async () => {
      const auth = await authorized(c);
      return {
        removed: await services.notepads.removeAssociation(
          auth,
          uuidParam(c, 'id'),
          uuidParam(c, 'sessionId'),
          actor(auth),
        ),
      };
    }),
  );
  app.get('/sessions/:sessionId/notepad-associations', async (c) =>
    handle(c, async () => ({
      associations: await services.notepads.sessionAssociations(
        await authorized(c),
        uuidParam(c, 'sessionId'),
        queryInt(c, 'limit', 50),
        queryInt(c, 'cursor', 0),
      ),
    })),
  );
  app.get('/sessions/:sessionId/notepad-capabilities', async (c) =>
    handle(c, async () => ({
      capabilities: await services.notepads.capabilities(await authorized(c), uuidParam(c, 'sessionId')),
    })),
  );
  app.put('/sessions/:sessionId/notepad-capabilities/:kind', async (c) =>
    handle(c, async () => ({
      capability: await services.notepads.putCapability(
        await authorized(c),
        uuidParam(c, 'sessionId'),
        c.req.param('kind'),
      ),
    })),
  );
  app.delete('/sessions/:sessionId/notepad-capabilities/:kind', async (c) =>
    handle(c, async () => ({
      removed: await services.notepads.removeCapability(
        await authorized(c),
        uuidParam(c, 'sessionId'),
        c.req.param('kind') as import('../store/types.js').SessionNotepadCapabilityRecord['kind'],
      ),
    })),
  );
}

function actor(auth: RequestAuthorization): NotepadActor {
  return auth.bypass ? { kind: 'system' } : { kind: 'human', userId: auth.user.id };
}

function mutationInput(body: Record<string, unknown>, field: 'content' | 'append' | 'patch') {
  if (field === 'patch') return body;
  return { [field]: field === 'append' ? body.append : body.content, expectedRevision: body.expectedRevision };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validUuid(value: string | undefined, name: string) {
  if (!value || !uuidPattern.test(value)) throw new NotepadServiceError('invalid', `${name} must be a UUID`);
  return value;
}
function uuidParam(c: NotepadContext, name: string) {
  return validUuid(c.req.param(name), name);
}
function optionalUuidQuery(c: NotepadContext, name: string) {
  const value = c.req.query(name);
  return value === undefined ? undefined : validUuid(value, name);
}
function requiredUuidQuery(c: NotepadContext, name: string) {
  return validUuid(c.req.query(name), name);
}
function revisionParam(c: NotepadContext) {
  const value = c.req.param('revision');
  if (!value || !/^[1-9]\d*$/.test(value))
    throw new NotepadServiceError('invalid', 'revision must be a positive integer');
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new NotepadServiceError('invalid', 'revision must be a positive integer');
  return revision;
}
function queryInt(c: NotepadContext, name: string, fallback: number) {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new NotepadServiceError('invalid', `${name} must be a non-negative integer`);
  return Number(raw);
}
function historyResponse<T>(page: { items: T[]; hasMore: boolean; nextCursor: string | null }) {
  return { revisions: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor };
}

async function handle(c: NotepadContext, operation: () => Promise<object>, status: 200 | 201 = 200) {
  try {
    return c.json(await operation(), status);
  } catch (error) {
    if (error instanceof StoreConflictError) {
      const status = error.code === 'notepad_too_large' ? 413 : error.code === 'not_found' ? 404 : 409;
      return writeError(c, status, error.code, error.message);
    }
    if (error instanceof NotepadServiceError) {
      const statusCode =
        error.code === 'not_found'
          ? 404
          : error.code === 'unauthenticated'
            ? 401
            : error.code === 'forbidden'
              ? 403
              : error.code === 'archived' || error.code === 'archived_group'
                ? 409
                : 400;
      return writeError(c, statusCode, error.code, error.message);
    }
    throw error;
  }
}
