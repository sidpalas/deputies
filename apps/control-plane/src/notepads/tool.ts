import { canWriteSession, type RequestAuthorization } from '../auth/authorization.js';
import type { AppStore, NotepadActor } from '../store/types.js';
import { NotepadService, NotepadServiceError } from './service.js';

export type NotepadToolBaseServices = { store: AppStore; notepads: NotepadService };
export type NotepadToolServices = NotepadToolBaseServices & { sessionId: string; runId: string; messageId: string };
type Action =
  | 'read'
  | 'replace'
  | 'patch'
  | 'append'
  | 'create'
  | 'list'
  | 'history'
  | 'read_revision'
  | 'restore_revision'
  | 'grant'
  | 'revoke'
  | 'search'
  | 'read_session'
  | 'replace_session'
  | 'patch_session'
  | 'append_session';

const maxReadBytes = 32 * 1024;
const defaultLineCount = 200;

export const notepadToolDescription =
  'Durable external memory for objectives, findings, blockers, and next actions. Read and update the current Session Notepad and associated Explicit Notepads; capability grants may additionally permit search or coordination. Updates do not send Messages or wake Sessions.';

export const notepadToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: [
        'read',
        'replace',
        'patch',
        'append',
        'create',
        'list',
        'history',
        'read_revision',
        'restore_revision',
        'grant',
        'revoke',
        'search',
        'read_session',
        'replace_session',
        'patch_session',
        'append_session',
      ],
    },
    notepadId: {
      type: 'string',
      description:
        'Explicit Notepad ID. Omit for read, replace, patch, append, history, read_revision, and restore_revision to target the current Session Notepad.',
    },
    sessionId: { type: 'string' },
    title: { type: 'string' },
    content: { type: 'string' },
    expectedRevision: {
      type: 'integer',
      minimum: 0,
      description: 'Current revision required for replace, patch, or restore.',
    },
    oldText: { type: 'string' },
    newText: { type: 'string' },
    append: { type: 'string' },
    revision: { type: 'integer', minimum: 1, description: 'Positive revision to read or restore.' },
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum number of results or revisions.' },
    startLine: { type: 'integer', minimum: 1, description: 'One-based first line for bounded reads.' },
    lineCount: { type: 'integer', minimum: 1, description: 'Maximum lines for bounded reads.' },
    cursor: { type: 'string' },
  },
} as const;

export async function executeNotepadTool(s: NotepadToolServices, params: unknown): Promise<Record<string, unknown>> {
  let action: Action | undefined;
  try {
    const p = object(params);
    action = actionValue(p.action);
    const current = await requiredSession(s.store, s.sessionId);
    const readOnly = ['read', 'list', 'history', 'read_revision', 'search', 'read_session'];
    if (current.status === 'archived' && !readOnly.includes(action))
      throw new NotepadServiceError('archived', 'Archived sessions are read-only');
    const actor: NotepadActor = { kind: 'agent', sessionId: s.sessionId, runId: s.runId };
    const agentAuth: RequestAuthorization = { bypass: true, user: null, memberships: [] };
    const capability = async (kind: 'explicit_search' | 'session_notepad_coordination') =>
      (await s.store.listSessionNotepadCapabilities(s.sessionId)).find((c) => c.kind === kind);
    const ownSession = async () => bounded(await s.notepads.readSession(agentAuth, s.sessionId), p);
    if (action === 'read' && !p.notepadId) return ok(action, await ownSession());
    if (action === 'replace' && !p.notepadId)
      return ok(
        action,
        await s.notepads.mutateSession(
          agentAuth,
          s.sessionId,
          { content: p.content, expectedRevision: p.expectedRevision },
          actor,
        ),
      );
    if (action === 'patch' && !p.notepadId)
      return ok(
        action,
        await s.notepads.mutateSession(
          agentAuth,
          s.sessionId,
          { oldText: p.oldText, newText: p.newText, expectedRevision: p.expectedRevision },
          actor,
        ),
      );
    if (action === 'append' && !p.notepadId)
      return ok(action, await s.notepads.mutateSession(agentAuth, s.sessionId, { append: p.append }, actor));
    if (action.endsWith('_session')) {
      const targetId = p.sessionId === undefined ? s.sessionId : string(p.sessionId, 'sessionId');
      if (targetId === s.sessionId) {
        if (action === 'read_session') return ok(action, await ownSession());
        if (action === 'replace_session')
          return ok(
            action,
            await s.notepads.mutateSession(
              agentAuth,
              s.sessionId,
              { content: p.content, expectedRevision: p.expectedRevision },
              actor,
            ),
          );
        if (action === 'patch_session')
          return ok(
            action,
            await s.notepads.mutateSession(
              agentAuth,
              s.sessionId,
              { oldText: p.oldText, newText: p.newText, expectedRevision: p.expectedRevision },
              actor,
            ),
          );
        return ok(action, await s.notepads.mutateSession(agentAuth, s.sessionId, { append: p.append }, actor));
      }
      const coordinationCapability = await capability('session_notepad_coordination');
      if (!coordinationCapability) {
        if (action === 'patch_session') denied();
        throw new Error('Session Notepad coordination capability is required');
      }
      const target = await sameGroupSession(s.store, targetId, current.ownerGroupId);
      const targetAuth = await grantorAuth(s.store, coordinationCapability.grantedByUserId);
      if (action === 'read_session') {
        if (!canWriteSession(targetAuth, target)) denied();
        return ok(
          action,
          bounded(
            await s.notepads.readCoordinatedSession(s.sessionId, targetId, coordinationCapability.grantedByUserId),
            p,
          ),
        );
      }
      if (!canWriteSession(targetAuth, target)) denied();
      if (action === 'patch_session')
        return ok(
          action,
          await s.notepads.patchCoordinatedSession(
            targetAuth,
            s.sessionId,
            targetId,
            { oldText: p.oldText, newText: p.newText, expectedRevision: p.expectedRevision },
            actor,
            coordinationCapability.grantedByUserId,
          ),
        );
      const input =
        action === 'replace_session'
          ? { content: p.content, expectedRevision: p.expectedRevision }
          : { append: p.append };
      return ok(
        action,
        await s.notepads.mutateSession(targetAuth, targetId, input, actor, coordinationCapability.grantedByUserId),
      );
    }
    if (action === 'create') {
      const created = await s.notepads.createForSessionAgent(
        s.sessionId,
        { title: p.title, ...(p.content !== undefined ? { content: p.content } : {}) },
        actor,
      );
      return ok(action, acknowledgement(created));
    }
    if (action === 'list')
      return ok(action, {
        ...associationToolResult(
          await s.notepads.sessionAssociations(agentAuth, s.sessionId, p.limit ?? 50, cursor(p.cursor)),
        ),
      });
    if (action === 'history' && !p.notepadId)
      return ok(
        action,
        historyToolResult(await s.notepads.history(agentAuth, 'session', s.sessionId, p.limit ?? 50, cursor(p.cursor))),
      );
    if (action === 'read_revision' && !p.notepadId)
      return ok(
        action,
        bounded(await s.notepads.readRevision(agentAuth, 'session', s.sessionId, number(p.revision, 'revision')), p),
      );
    if (action === 'restore_revision' && !p.notepadId)
      return ok(
        action,
        await s.notepads.restoreRevision(
          agentAuth,
          'session',
          s.sessionId,
          number(p.revision, 'revision'),
          p.expectedRevision,
          actor,
        ),
      );
    if (action === 'search') {
      const grant = await capability('explicit_search');
      if (!grant) denied();
      const query = string(p.query, 'query').trim();
      if (!query || query.length > 200) throw new Error('query must be 1 to 200 characters');
      return ok(action, {
        results: await s.store
          .searchExplicitNotepadsWithCapability({
            actorSessionId: s.sessionId,
            expectedGrantorUserId: grant.grantedByUserId,
            groupId: current.ownerGroupId,
            query,
            limit: Math.min(number(p.limit ?? 20, 'limit'), 50),
          })
          .catch(() => denied()),
      });
    }
    const id = string(p.notepadId, 'notepadId');
    const association = await s.store.getNotepadAssociation(id, s.sessionId);
    const searchGrant = await capability('explicit_search');
    const broad = Boolean(searchGrant);
    if (!association && !(broad && action === 'read'))
      throw new Error('Notepad is not associated with the current Session');
    if (action === 'read') {
      let readAuth: RequestAuthorization = agentAuth;
      if (!association) {
        // Resolve metadata and owner boundary before loading content or applying
        // the grantor's canonical readability. Every failure is intentionally
        // indistinguishable to avoid existence and cross-group disclosure.
        if (!searchGrant) denied();
        const record = await s.store
          .readExplicitNotepadWithCapability({
            actorSessionId: s.sessionId,
            expectedGrantorUserId: searchGrant.grantedByUserId,
            notepadId: id,
          })
          .catch(() => denied());
        return ok(action, bounded(record, p));
      }
      return ok(
        action,
        bounded(
          await s.notepads.requireReadable(readAuth, id, association ? s.sessionId : undefined).catch(() => denied()),
          p,
        ),
      );
    }
    if (action === 'replace')
      return ok(
        action,
        await s.notepads.mutateExplicit(
          agentAuth,
          id,
          { content: p.content, expectedRevision: p.expectedRevision },
          actor,
          s.sessionId,
        ),
      );
    if (action === 'patch')
      return ok(
        action,
        await s.notepads.mutateExplicit(
          agentAuth,
          id,
          { oldText: p.oldText, newText: p.newText, expectedRevision: p.expectedRevision },
          actor,
          s.sessionId,
        ),
      );
    if (action === 'append')
      return ok(action, await s.notepads.mutateExplicit(agentAuth, id, { append: p.append }, actor, s.sessionId));
    if (action === 'history')
      return ok(
        action,
        historyToolResult(
          await s.notepads.history(agentAuth, 'explicit', id, p.limit ?? 50, cursor(p.cursor), s.sessionId),
        ),
      );
    if (action === 'read_revision') {
      const r = await s.notepads.readRevision(agentAuth, 'explicit', id, number(p.revision, 'revision'), s.sessionId);
      return ok(action, bounded(r, p));
    }
    if (action === 'restore_revision')
      return ok(
        action,
        await s.notepads.restoreRevision(
          agentAuth,
          'explicit',
          id,
          number(p.revision, 'revision'),
          p.expectedRevision,
          actor,
          s.sessionId,
        ),
      );
    if (action === 'grant') {
      const target = await sameGroupSession(s.store, string(p.sessionId, 'sessionId'), current.ownerGroupId);
      return ok(action, associationAck(await s.notepads.putAssociation(agentAuth, id, target.id, actor)));
    }
    if (action === 'revoke')
      return ok(action, {
        removed: await s.notepads.removeAssociation(agentAuth, id, string(p.sessionId, 'sessionId'), actor),
      });
    throw new Error('Unsupported notepad action');
  } catch (e) {
    return { ok: false, ...(action ? { action } : {}), error: errorMessage(e) };
  }
}

function historyToolResult<T>(page: { items: T[]; hasMore: boolean; nextCursor: string | null }) {
  return { revisions: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor };
}

function associationToolResult<T>(page: { items: T[]; hasMore: boolean; nextCursor: string | null }) {
  return { notepads: page.items, items: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor };
}

function cursor(value: unknown) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('cursor must be a pagination cursor');
  return Number(value);
}

function bounded(
  record: { content: string; revision: number; sizeBytes: number } & Record<string, unknown>,
  p: Record<string, unknown>,
) {
  const bytes = Buffer.byteLength(record.content);
  const lines = record.content.split('\n');
  if (bytes <= maxReadBytes && p.startLine === undefined && p.lineCount === undefined) return record;
  const start = Math.max(1, p.startLine === undefined ? 1 : number(p.startLine, 'startLine'));
  const requested = p.lineCount === undefined ? defaultLineCount : number(p.lineCount, 'lineCount');
  let content = '';
  let end = start - 1;
  for (let i = start - 1; i < lines.length && i < start - 1 + requested; i++) {
    const candidate = content + (content ? '\n' : '') + lines[i];
    if (Buffer.byteLength(candidate) > maxReadBytes) {
      if (!content) {
        content = utf8Prefix(lines[i]!, maxReadBytes);
        end = i + 1;
      }
      break;
    }
    content = candidate;
    end = i + 1;
  }
  return {
    ...record,
    content,
    totalLines: lines.length,
    totalBytes: bytes,
    startLine: start,
    endLine: end,
    truncated: true,
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // A UTF-16 slice can end between a surrogate pair. Removing a dangling high
  // surrogate keeps both the returned string and its UTF-8 encoding valid.
  return /[\uD800-\uDBFF]$/.test(value.slice(0, low)) ? value.slice(0, low - 1) : value.slice(0, low);
}
async function grantorAuth(store: AppStore, userId: string): Promise<RequestAuthorization> {
  const user = await store.getAuthUser(userId);
  if (!user) throw new Error('Capability grantor is no longer active');
  const all = await store.listUserGroupMemberships(userId);
  const groups = await Promise.all(all.map((m) => store.getGroup(m.groupId)));
  const memberships = all.filter((_, i) => groups[i] && !groups[i].archivedAt);
  return { bypass: false, user, memberships };
}
async function explicitSearchGrantorAuth(
  store: AppStore,
  grant: { grantedByUserId: string } | undefined,
  groupId: string,
) {
  if (!grant) throw new Error('Explicit Notepad search capability is required');
  const auth = await grantorAuth(store, grant.grantedByUserId).catch(() => denied());
  if (
    auth.user!.role !== 'super_admin' &&
    !auth.memberships.some(
      (membership) => membership.groupId === groupId && (membership.role === 'member' || membership.role === 'admin'),
    )
  )
    denied();
  return auth;
}
async function requiredSession(store: AppStore, id: string) {
  const s = await store.getSession(id);
  if (!s) throw new Error('Session not found');
  return s;
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('notepad params must be an object');
  return v as Record<string, unknown>;
}
function actionValue(v: unknown): Action {
  if (typeof v !== 'string') throw new Error('notepad action is required');
  if (!notepadToolParameters.properties.action.enum.includes(v as Action)) throw new Error('Invalid notepad action');
  return v as Action;
}
function string(v: unknown, n: string) {
  if (typeof v !== 'string' || !v) throw new Error(`${n} is required`);
  return v;
}
function number(v: unknown, n: string) {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(`${n} must be a non-negative integer`);
  return v as number;
}
function denied(): never {
  throw new Error('Notepad access denied by current grantor authorization');
}
function ok(action: Action, value: unknown) {
  if (
    ['replace', 'patch', 'append', 'replace_session', 'patch_session', 'append_session', 'restore_revision'].includes(
      action,
    ) &&
    value &&
    typeof value === 'object' &&
    'revision' in value
  )
    value = acknowledgement(value as Parameters<typeof acknowledgement>[0]);
  return { ok: true, action, result: value };
}
function acknowledgement(record: {
  id?: string;
  sessionId?: string;
  revision: number;
  sizeBytes: number;
  updatedAt: Date;
}) {
  return {
    ...(record.id ? { id: record.id } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    revision: record.revision,
    sizeBytes: record.sizeBytes,
    updatedAt: record.updatedAt,
  };
}
function associationAck(record: { notepadId: string; sessionId: string }) {
  return { notepadId: record.notepadId, sessionId: record.sessionId };
}
async function sameGroupSession(store: AppStore, id: string, groupId: string) {
  const target = await store.getSession(id);
  if (!target || target.ownerGroupId !== groupId) throw new Error('Target unavailable');
  return target;
}
function errorMessage(e: unknown) {
  if (e instanceof NotepadServiceError && e.code === 'invalid' && /revision/i.test(e.message))
    return `Revision conflict: ${e.message}. Read the latest revision and retry.`;
  return e instanceof Error ? e.message : String(e);
}
