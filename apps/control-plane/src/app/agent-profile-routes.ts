import type { Hono, Context } from 'hono';
import type { AppConfig } from '../config/index.js';
import { readRequestAuthorization, type RequestAuthorization } from '../auth/authorization.js';
import {
  AgentProfileError,
  type BuiltinProfileSettingsWrite,
  type ManagedProfileWrite,
} from '../agent-profiles/service.js';
import { readJsonBody } from './request.js';
import { writeError } from './http-error.js';
import type { AppServices, AppVariables } from './server.js';

export function registerAgentProfileRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
) {
  const auth = async (c: Context, manage = false) => {
    const a = await readRequestAuthorization(config, services.store, c);
    if (!a) return writeError(c, 401, 'unauthorized', 'Missing or invalid session');
    if (manage && !a.bypass && a.user.role === 'viewer')
      return writeError(c, 403, 'forbidden', 'Member access is required to manage agent profiles');
    return a;
  };
  app.get('/agent-profiles', async (c) => {
    const a = await auth(c);
    if (a instanceof Response) return a;
    return c.json({ agentProfiles: await services.agentProfiles.list() });
  });
  app.get('/agent-profiles/configuration/default', async (c) => {
    const a = await auth(c);
    if (a instanceof Response) return a;
    return c.json({ configuration: await services.agentProfiles.getTenantConfiguration() });
  });
  app.patch('/agent-profiles/configuration/default', async (c) =>
    handle(
      c,
      async (authorization) => {
        const body = await readJsonBody(c, config.maxJsonBodyBytes);
        if (
          Object.keys(body).length !== 1 ||
          !Object.hasOwn(body, 'defaultProfileId') ||
          (body.defaultProfileId !== null &&
            (typeof body.defaultProfileId !== 'string' || !body.defaultProfileId.trim()))
        )
          throw new AgentProfileError('invalid', 'defaultProfileId must be a non-empty string or null');
        return {
          configuration: await services.agentProfiles.setTenantDefault(
            typeof body.defaultProfileId === 'string' ? body.defaultProfileId.trim() : null,
            authorization.bypass ? undefined : authorization.user.id,
          ),
        };
      },
      async (x) => {
        const authorization = await auth(x);
        if (authorization instanceof Response) return authorization;
        if (!authorization.bypass && authorization.user.role !== 'admin')
          return writeError(x, 403, 'forbidden', 'Admin access is required to configure the tenant default');
        return authorization;
      },
    ),
  );
  app.get('/agent-profiles/:profileId', async (c) => {
    const a = await auth(c);
    if (a instanceof Response) return a;
    const p = await services.agentProfiles.get(c.req.param('profileId'));
    return p ? c.json({ agentProfile: p }) : writeError(c, 404, 'not_found', 'Agent profile not found');
  });
  app.get('/agent-profiles/:profileId/revisions', async (c) =>
    handle(c, async () => ({ revisions: await services.agentProfiles.listRevisions(c.req.param('profileId')) }), auth),
  );
  app.post('/agent-profiles', async (c) =>
    handle(
      c,
      async (authorization) => ({
        agentProfile: await services.agentProfiles.create(
          read(await readJsonBody(c, config.maxJsonBodyBytes), true),
          authorization.bypass ? undefined : authorization.user.id,
        ),
      }),
      (x) => auth(x, true),
      201,
    ),
  );
  app.patch('/agent-profiles/:profileId', async (c) =>
    handle(
      c,
      async (authorization) => {
        const b = await readJsonBody(c, config.maxJsonBodyBytes);
        if (typeof b.expectedCurrentRevisionId !== 'string')
          throw new AgentProfileError('invalid', 'expectedCurrentRevisionId is required');
        return {
          agentProfile: await services.agentProfiles.update(
            c.req.param('profileId'),
            b.expectedCurrentRevisionId,
            read(b),
            authorization.bypass ? undefined : authorization.user.id,
          ),
        };
      },
      (x) => auth(x, true),
    ),
  );
  app.patch('/agent-profiles/:profileId/settings', async (c) =>
    handle(
      c,
      async (authorization) => ({
        agentProfile: await services.agentProfiles.updateBuiltinSettings(
          c.req.param('profileId'),
          readBuiltinSettings(await readJsonBody(c, config.maxJsonBodyBytes)),
          authorization.bypass ? undefined : authorization.user.id,
        ),
      }),
      (x) => auth(x, true),
    ),
  );
  for (const op of ['archive', 'restore'] as const)
    app.post(`/agent-profiles/:profileId/${op}`, async (c) =>
      handle(
        c,
        async () => ({ agentProfile: await services.agentProfiles[op](c.req.param('profileId')) }),
        (x) => auth(x, true),
      ),
    );
}
function readBuiltinSettings(b: Record<string, unknown>): BuiltinProfileSettingsWrite {
  if (!['enabled', 'defaultModel', 'defaultReasoningLevel'].some((field) => Object.hasOwn(b, field)))
    throw new AgentProfileError('invalid', 'At least one built-in setting is required');
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean')
    throw new AgentProfileError('invalid', 'enabled must be a boolean');
  for (const field of ['defaultModel', 'defaultReasoningLevel'] as const)
    if (b[field] !== undefined && b[field] !== null && typeof b[field] !== 'string')
      throw new AgentProfileError('invalid', `${field} must be a string or null`);
  return {
    ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
    ...(b.defaultModel === null || typeof b.defaultModel === 'string' ? { defaultModel: b.defaultModel } : {}),
    ...(b.defaultReasoningLevel === null || typeof b.defaultReasoningLevel === 'string'
      ? { defaultReasoningLevel: b.defaultReasoningLevel }
      : {}),
  };
}
function read(b: Record<string, unknown>, defaultInvocations = false): ManagedProfileWrite {
  if (Object.hasOwn(b, 'skillRevisions'))
    throw new AgentProfileError('invalid', 'Agent profiles do not support skill configuration');
  if (typeof b.name !== 'string' || typeof b.description !== 'string' || typeof b.instructions !== 'string')
    throw new AgentProfileError('invalid', 'name, description, and instructions must be strings');
  if (!Array.isArray(b.supportedInvocations) && !(defaultInvocations && b.supportedInvocations === undefined))
    throw new AgentProfileError('invalid', 'supportedInvocations must be an array');
  const supported = (b.supportedInvocations ?? ['agent', 'subagent']) as unknown[];
  if (supported.some((value) => value !== 'agent' && value !== 'subagent'))
    throw new AgentProfileError('invalid', 'supportedInvocations contains an unknown invocation');
  for (const field of ['defaultModel', 'defaultReasoningLevel'] as const) {
    if (field in b && typeof b[field] !== 'string')
      throw new AgentProfileError('invalid', `${field} must be a string when provided`);
    if (typeof b[field] === 'string' && !b[field].trim())
      throw new AgentProfileError('invalid', `${field} must not be empty`);
  }
  return {
    name: b.name,
    description: b.description,
    instructions: b.instructions,
    supportedInvocations: supported as ManagedProfileWrite['supportedInvocations'],
    ...(typeof b.defaultModel === 'string' ? { defaultModel: b.defaultModel } : {}),
    ...(typeof b.defaultReasoningLevel === 'string' ? { defaultReasoningLevel: b.defaultReasoningLevel } : {}),
  };
}
async function handle(
  c: Context,
  fn: (authorization: RequestAuthorization) => Promise<object>,
  authorize: (c: Context) => Promise<RequestAuthorization | Response>,
  status: 200 | 201 = 200,
) {
  const a = await authorize(c);
  if (a instanceof Response) return a;
  try {
    return c.json(await fn(a), status);
  } catch (e) {
    if (e instanceof AgentProfileError)
      return writeError(
        c,
        e.code === 'not_found'
          ? 404
          : e.code === 'immutable_builtin' ||
              e.code === 'conflict' ||
              e.code === 'name_collision' ||
              e.code === 'in_use'
            ? 409
            : 400,
        e.code,
        e.message,
      );
    throw e;
  }
}
