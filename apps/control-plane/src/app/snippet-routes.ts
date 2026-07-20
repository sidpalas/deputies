import type { Context, Hono } from 'hono';
import { readRequestAuthorization } from '../auth/authorization.js';
import type { AppConfig } from '../config/index.js';
import { SnippetServiceError } from '../snippets/service.js';
import { StoreConflictError } from '../store/types.js';
import { writeError } from './http-error.js';
import { readJsonBody } from './request.js';
import type { AppServices, AppVariables } from './server.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerSnippetRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  const user = async (c: SnippetContext) => {
    const auth = await readRequestAuthorization(config, services.store, c);
    return !auth || auth.bypass ? null : auth.user;
  };
  app.get('/snippets', async (c) => {
    const owner = await user(c);
    if (!owner) return unauthorized(c);
    return c.json({ snippets: await services.snippets.list(owner.id) });
  });
  app.post('/snippets', async (c) => {
    const owner = await user(c);
    if (!owner) return unauthorized(c);
    try {
      const body = await readJsonBody(c, config.maxJsonBodyBytes);
      return c.json({ snippet: await services.snippets.create(owner.id, { name: body.name, body: body.body }) }, 201);
    } catch (e) {
      return error(c, e);
    }
  });
  app.patch('/snippets/:id', async (c) => {
    const owner = await user(c);
    if (!owner) return unauthorized(c);
    const id = c.req.param('id');
    if (!uuidPattern.test(id)) return invalidId(c);
    try {
      const body = await readJsonBody(c, config.maxJsonBodyBytes);
      return c.json({ snippet: await services.snippets.update(owner.id, id, body) });
    } catch (e) {
      return error(c, e);
    }
  });
  app.post('/snippets/:id/archive', async (c) => {
    const owner = await user(c);
    if (!owner) return unauthorized(c);
    const id = c.req.param('id');
    if (!uuidPattern.test(id)) return invalidId(c);
    try {
      return c.json({ snippet: await services.snippets.archive(owner.id, id) });
    } catch (e) {
      return error(c, e);
    }
  });
  app.post('/snippets/:id/restore', async (c) => {
    const owner = await user(c);
    if (!owner) return unauthorized(c);
    const id = c.req.param('id');
    if (!uuidPattern.test(id)) return invalidId(c);
    try {
      return c.json({ snippet: await services.snippets.restore(owner.id, id) });
    } catch (e) {
      return error(c, e);
    }
  });
}
type SnippetContext = Context<{ Variables: AppVariables }>;

function unauthorized(c: SnippetContext) {
  return writeError(c, 401, 'unauthorized', 'Snippets require an authenticated user session');
}
function invalidId(c: SnippetContext) {
  return writeError(c, 400, 'invalid_request', 'Expected valid snippet id');
}
function error(c: SnippetContext, value: unknown) {
  if (value instanceof StoreConflictError) return writeError(c, 409, value.code, value.message);
  if (value instanceof SnippetServiceError)
    return writeError(
      c,
      value.code === 'not_found' ? 404 : value.code === 'archived' ? 409 : 400,
      value.code,
      value.message,
    );
  throw value;
}
