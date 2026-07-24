import type { Context } from 'hono';
import type { AppConfig } from '../config/index.js';
import type {
  AuthStore,
  AuthUserRecord,
  AutomationRecord,
  EnvironmentWithDetailsRecord,
  ExplicitNotepadMetadata,
  SessionRecord,
  SkillRecord,
} from '../store/types.js';
import { readSessionId } from './session.js';

export type RequestAuthorization =
  | { bypass: true; user: null; agentSessionId?: undefined }
  | { bypass: true; user: null; agentSessionId: string }
  | { bypass: false; user: AuthUserRecord; agentSessionId?: undefined };

// Auth state is resolved by middlewares and handlers independently, so memoize the
// underlying lookups per request to avoid repeating the same store queries.
const requestAuthUserCache = new WeakMap<Request, Promise<AuthUserRecord | null>>();
const requestAuthorizationCache = new WeakMap<Request, Promise<RequestAuthorization | null>>();

export function readRequestAuthUser(config: AppConfig, store: AuthStore, c: Context): Promise<AuthUserRecord | null> {
  const request = c.req.raw;
  let user = requestAuthUserCache.get(request);
  if (!user) {
    const sessionId = readSessionId(config, c);
    user = sessionId ? store.getAuthUserBySession({ sessionId, now: new Date() }) : Promise.resolve(null);
    requestAuthUserCache.set(request, user);
  }
  return user;
}

export function readRequestAuthorization(
  config: AppConfig,
  store: AuthStore,
  c: Context,
): Promise<RequestAuthorization | null> {
  if (config.apiAuthMode !== 'session') return Promise.resolve({ bypass: true, user: null });
  const request = c.req.raw;
  let authorization = requestAuthorizationCache.get(request);
  if (!authorization) {
    authorization = (async (): Promise<RequestAuthorization | null> => {
      const user = await readRequestAuthUser(config, store, c);
      if (!user) return null;
      return { bypass: false, user };
    })();
    requestAuthorizationCache.set(request, authorization);
  }
  return authorization;
}

export function canReadSession(auth: RequestAuthorization, session: SessionRecord): boolean {
  if (session.visibility === 'private') {
    return auth.agentSessionId === session.id || (!auth.bypass && session.ownerUserId === auth.user.id);
  }
  return auth.bypass || Boolean(auth.user);
}

export function canWriteSession(auth: RequestAuthorization, session: SessionRecord): boolean {
  if (session.visibility === 'private') {
    return (
      auth.agentSessionId === session.id ||
      (!auth.bypass &&
        session.ownerUserId === auth.user.id &&
        (auth.user.role === 'member' || auth.user.role === 'admin'))
    );
  }
  return auth.bypass || auth.user.role === 'member' || auth.user.role === 'admin';
}

export function canReadNotepad(auth: RequestAuthorization, _notepad: ExplicitNotepadMetadata): boolean {
  return canReadTenantResources(auth);
}

export function canWriteNotepad(auth: RequestAuthorization, _notepad: ExplicitNotepadMetadata): boolean {
  return auth.bypass || auth.user.role === 'member' || auth.user.role === 'admin';
}

export function canManageNotepad(auth: RequestAuthorization, _notepad?: ExplicitNotepadMetadata): boolean {
  return auth.bypass || auth.user.role === 'member' || auth.user.role === 'admin';
}

export function canReadTenantResources(auth: RequestAuthorization): boolean {
  return auth.bypass || Boolean(auth.user);
}

export function canManageTenantResources(auth: RequestAuthorization): boolean {
  return auth.bypass || auth.user.role === 'member' || auth.user.role === 'admin';
}

export function canAdministerTenant(auth: RequestAuthorization): boolean {
  return auth.bypass || auth.user.role === 'admin';
}

export function canReadAutomation(auth: RequestAuthorization, _automation: AutomationRecord): boolean {
  return auth.bypass || Boolean(auth.user);
}

export function canManageAutomation(auth: RequestAuthorization, _automation?: AutomationRecord): boolean {
  return auth.bypass || auth.user.role === 'member' || auth.user.role === 'admin';
}

export function canReadSkill(auth: RequestAuthorization, skill: SkillRecord): boolean {
  return skill.scope === 'tenant'
    ? auth.bypass || Boolean(auth.user)
    : !auth.bypass && skill.ownerUserId === auth.user.id;
}

export function canManageSkill(auth: RequestAuthorization, skill: SkillRecord): boolean {
  if (skill.scope === 'personal') return !auth.bypass && skill.ownerUserId === auth.user.id;
  return auth.bypass || auth.user.role === 'member' || auth.user.role === 'admin';
}

export function canInvokeSkillInSession(
  auth: RequestAuthorization,
  skill: SkillRecord,
  _session: SessionRecord,
  _authorUserId: string | undefined = auth.bypass ? undefined : auth.user.id,
): boolean {
  return (
    skill.enabled &&
    !skill.archivedAt &&
    canReadSkill(auth, skill) &&
    (skill.scope === 'tenant' || (!auth.bypass && skill.ownerUserId === _authorUserId))
  );
}

export function canReadEnvironment(auth: RequestAuthorization, _environment: EnvironmentWithDetailsRecord): boolean {
  return auth.bypass || Boolean(auth.user);
}

export function canUseEnvironment(auth: RequestAuthorization, environment: EnvironmentWithDetailsRecord): boolean {
  return !environment.archivedAt && (auth.bypass || auth.user.role === 'member' || auth.user.role === 'admin');
}

export function canManageEnvironment(auth: RequestAuthorization, _environment?: EnvironmentWithDetailsRecord): boolean {
  return auth.bypass || auth.user.role === 'member' || auth.user.role === 'admin';
}
