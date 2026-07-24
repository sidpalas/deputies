import { randomUUID } from 'node:crypto';
import {
  canManageNotepad,
  canReadNotepad,
  canReadSession,
  canWriteNotepad,
  canWriteSession,
  type RequestAuthorization,
} from '../auth/authorization.js';
import type {
  AppStore,
  ExplicitNotepadRecord,
  NotepadActor,
  NotepadMutationKind,
  SessionNotepadCapabilityRecord,
} from '../store/types.js';
import type { EventService } from '../events/service.js';

export const notepadMaxBytes = 256 * 1024;
export const notepadRevisionReadMaxBytes = 32 * 1024;
export const notepadTitleMaxLength = 120;
export const notepadPageMaxLimit = 50;

export class NotepadServiceError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'not_found'
      | 'unauthenticated'
      | 'forbidden'
      | 'archived'
      | 'archived_group'
      | 'patch_not_found'
      | 'patch_ambiguous',
    message: string,
  ) {
    super(message);
  }
}

export class NotepadService {
  constructor(
    private readonly store: AppStore,
    private readonly events?: EventService,
  ) {}

  async readSession(auth: RequestAuthorization, sessionId: string) {
    const session = await this.requireSession(sessionId);
    this.allow(canReadSession(auth, session));
    return (
      (await this.store.getSessionNotepad(sessionId)) ?? {
        sessionId,
        revision: 0,
        content: '',
        sizeBytes: 0,
        createdAt: session.createdAt,
        updatedAt: session.createdAt,
      }
    );
  }

  async readCoordinatedSession(actorSessionId: string, targetSessionId: string, expectedGrantorUserId: string) {
    return this.store.readCoordinatedSessionNotepad(actorSessionId, targetSessionId, expectedGrantorUserId);
  }

  /** Coordinated patches must derive their replacement from a read performed
   * under the same live grantor authority that the mutation will recheck. */
  async patchCoordinatedSession(
    auth: RequestAuthorization,
    actorSessionId: string,
    targetSessionId: string,
    input: { oldText?: unknown; newText?: unknown; expectedRevision?: unknown },
    actor: NotepadActor,
    expectedGrantorUserId: string,
  ) {
    const session = await this.requireSession(targetSessionId);
    this.allow(canWriteSession(auth, session));
    if (session.status === 'archived') throw new NotepadServiceError('archived', 'Archived sessions are read-only');
    let source;
    try {
      source = await this.store.readCoordinatedSessionNotepad(actorSessionId, targetSessionId, expectedGrantorUserId);
    } catch {
      this.forbidden();
    }
    const content = patchedContent(source.content, input.oldText, input.newText);
    const result = await this.store.mutateSessionNotepad({
      sessionId: targetSessionId,
      content,
      expectedRevision: integerValue(input.expectedRevision, 'expectedRevision'),
      actor,
      expectedCoordinationGrantorUserId: expectedGrantorUserId,
      mutationKind: 'patch',
      now: new Date(),
    });
    await this.publishChange('session', targetSessionId, result.revision);
    return result;
  }

  async mutateSession(
    auth: RequestAuthorization,
    sessionId: string,
    input: { content?: unknown; append?: unknown; oldText?: unknown; newText?: unknown; expectedRevision?: unknown },
    actor: NotepadActor,
    expectedCoordinationGrantorUserId?: string,
  ) {
    const session = await this.requireSession(sessionId);
    this.allow(canWriteSession(auth, session));
    if (session.status === 'archived') throw new NotepadServiceError('archived', 'Archived sessions are read-only');
    const result = await this.mutate('session', sessionId, input, actor, undefined, expectedCoordinationGrantorUserId);
    await this.publishChange('session', sessionId, result.revision);
    return result;
  }

  async create(
    auth: RequestAuthorization,
    input: Record<string, unknown>,
    actor: NotepadActor = { kind: 'system' },
    initialWritableSessionId?: string,
  ) {
    this.allow(canManageNotepad(auth));
    if ('ownerGroupId' in input || 'visibility' in input || 'writePolicy' in input)
      throw new NotepadServiceError('invalid', 'Notepads are tenant-wide');
    const now = new Date();
    const content = input.content === undefined ? '' : stringValue(input.content, 'content');
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > notepadMaxBytes)
      throw new NotepadServiceError('invalid', `Content must not exceed ${notepadMaxBytes} UTF-8 bytes`);
    const record: ExplicitNotepadRecord = {
      id: randomUUID(),
      title: validTitle(input.title),
      revision: content ? 1 : 0,
      content,
      sizeBytes,
      ...(!auth.bypass ? { createdByUserId: auth.user.id } : {}),
      createdAt: now,
      updatedAt: now,
    };
    if (initialWritableSessionId) {
      const target = await this.requireSession(initialWritableSessionId);
      if (target.status === 'archived' || !canWriteSession(auth, target)) this.notFound('Session');
    }
    const result = await this.store.createExplicitNotepad({
      record,
      actor,
      activityId: randomUUID(),
      ...(initialWritableSessionId
        ? {
            initialAssociation: {
              notepadId: record.id,
              sessionId: initialWritableSessionId,
              ...(!auth.bypass ? { createdByUserId: auth.user.id } : {}),
              createdAt: now,
            },
            associationActivityId: randomUUID(),
          }
        : {}),
    });
    if (initialWritableSessionId) await this.publishAssociationChange(initialWritableSessionId);
    return result;
  }

  /** Agent-only creation path. The caller's Session is the authority and the
   * initial association is committed atomically with the Notepad. */
  async createForSessionAgent(sessionId: string, input: { title?: unknown; content?: unknown }, actor: NotepadActor) {
    const session = await this.requireSession(sessionId);
    if (session.status === 'archived') throw new NotepadServiceError('archived', 'Archived sessions are read-only');
    return this.create({ bypass: true, user: null }, { title: input.title, content: input.content }, actor, sessionId);
  }

  async requireReadable(auth: RequestAuthorization, id: string, associatedSessionId?: string) {
    const notepad = await this.requireExplicit(id);
    if (associatedSessionId) {
      const session = await this.requireSession(associatedSessionId);
      const association = await this.store.getNotepadAssociation(id, associatedSessionId);
      this.allow(Boolean(association && canReadSession(auth, session)));
      return notepad;
    }
    this.allow(canReadNotepad(auth, notepad));
    return notepad;
  }

  async list(auth: RequestAuthorization, limit: unknown = 50, cursor: unknown = 0, archived = false) {
    const bounded = boundedLimit(limit);
    const offset = integerValue(cursor, 'cursor');
    this.allow(canReadNotepad(auth, {} as ExplicitNotepadRecord));
    const records = await this.store.listExplicitNotepads({
      limit: bounded,
      offset,
      archived,
    });
    return { ...records, items: records.items.filter((item) => canReadNotepad(auth, item as ExplicitNotepadRecord)) };
  }

  async inventory(auth: RequestAuthorization, limit: unknown = 50, cursor: unknown = 0, archived = false) {
    this.allow(canManageNotepad(auth));
    return this.store.listExplicitNotepads({
      limit: boundedLimit(limit),
      offset: integerValue(cursor, 'cursor'),
      includeDormant: true,
      archived,
    });
  }

  async search(auth: RequestAuthorization, query: unknown, limit: unknown = 20, archived = false) {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 200)
      throw new NotepadServiceError('invalid', 'Query must be 1 to 200 characters');
    const bounded = Math.min(integerValue(limit, 'limit'), 50);
    this.allow(canReadNotepad(auth, {} as ExplicitNotepadRecord));
    return (
      await this.store.searchExplicitNotepads({
        query: query.trim(),
        limit: bounded,
        archived,
      })
    ).filter((n) => canReadNotepad(auth, n));
  }

  async mutateExplicit(
    auth: RequestAuthorization,
    id: string,
    input: Record<string, unknown>,
    actor: NotepadActor,
    associatedSessionId?: string,
  ) {
    const notepad = await this.requireExplicit(id);
    if (notepad.archivedAt) throw new NotepadServiceError('archived', 'Archived notepads are read-only');
    let writable = canWriteNotepad(auth, notepad);
    if (associatedSessionId) {
      const session = await this.requireSession(associatedSessionId);
      const association = await this.store.getNotepadAssociation(id, associatedSessionId);
      writable = Boolean(association && canWriteSession(auth, session));
      if (writable && session.status === 'archived')
        throw new NotepadServiceError('archived', 'Archived sessions are read-only');
    }
    this.allow(writable);
    const associatedAuthority =
      associatedSessionId && !auth.bypass ? { associatedSessionId, expectedUserId: auth.user.id } : undefined;
    const result = await this.mutate('explicit', id, input, actor, undefined, undefined, associatedAuthority);
    await this.publishChange('explicit', id, result.revision);
    return result;
  }

  async metadata(
    auth: RequestAuthorization,
    id: string,
    input: Record<string, unknown>,
    actor: NotepadActor = { kind: 'system' },
  ) {
    const notepad = await this.requireExplicit(id);
    this.allow(canManageNotepad(auth, notepad));
    if (notepad.archivedAt) throw new NotepadServiceError('archived', 'Archived notepads are read-only');
    if ('ownerGroupId' in input || 'visibility' in input || 'writePolicy' in input)
      throw new NotepadServiceError('invalid', 'Notepads are tenant-wide');
    return this.store.updateExplicitNotepadMetadata({
      id,
      ...(input.title === undefined ? {} : { title: validTitle(input.title) }),
      actor,
      activityId: randomUUID(),
      now: new Date(),
    });
  }

  async associations(auth: RequestAuthorization, id: string, limit: unknown = 50, cursor: unknown = 0) {
    const n = await this.requireExplicitMetadata(id);
    this.allow(canManageNotepad(auth, n));
    return this.store.listNotepadAssociations(n.id, boundedLimit(limit), integerValue(cursor, 'cursor'));
  }
  async putAssociation(auth: RequestAuthorization, id: string, sessionId: string, actor: NotepadActor) {
    const n = await this.requireExplicitMetadata(id);
    if (n.archivedAt) throw new NotepadServiceError('archived', 'Archived notepads are read-only');
    const s = await this.requireSession(sessionId);
    if (s.status === 'archived') throw new NotepadServiceError('archived', 'Archived sessions are read-only');
    this.allow(canWriteSession(auth, s) && canWriteNotepad(auth, n));
    const result = await this.store.putNotepadAssociation({
      record: {
        notepadId: id,
        sessionId,
        ...(!auth.bypass ? { createdByUserId: auth.user.id } : {}),
        createdAt: new Date(),
      },
      actor,
      activityId: randomUUID(),
    });
    await this.publishAssociationChange(sessionId);
    return result;
  }
  async removeAssociation(auth: RequestAuthorization, id: string, sessionId: string, actor: NotepadActor) {
    const n = await this.requireExplicitMetadata(id);
    if (n.archivedAt) throw new NotepadServiceError('archived', 'Archived notepads are read-only');
    const s = await this.requireSession(sessionId);
    if (s.status === 'archived') throw new NotepadServiceError('archived', 'Archived sessions are read-only');
    this.allow(canWriteSession(auth, s) && canWriteNotepad(auth, n));
    const removed = await this.store.removeNotepadAssociation({
      notepadId: id,
      sessionId,
      actor,
      activityId: randomUUID(),
      now: new Date(),
    });
    if (removed) await this.publishAssociationChange(sessionId);
    return removed;
  }
  async sessionAssociations(auth: RequestAuthorization, sessionId: string, limit: unknown = 50, cursor: unknown = 0) {
    const s = await this.requireSession(sessionId);
    this.allow(canReadSession(auth, s));
    const records = await this.store.listSessionNotepadAssociations(
      sessionId,
      boundedLimit(limit),
      integerValue(cursor, 'cursor'),
    );
    return {
      ...records,
      items: records.items.map((association) => ({
        ...association,
        canWrite: s.status !== 'archived' && canWriteSession(auth, s),
      })),
    };
  }
  async capabilities(auth: RequestAuthorization, sessionId: string) {
    const s = await this.requireSession(sessionId);
    if (s.status === 'archived') throw new NotepadServiceError('archived', 'Archived sessions are read-only');
    this.allow(canManageNotepad(auth));
    return this.store.listSessionNotepadCapabilities(sessionId);
  }
  async putCapability(auth: RequestAuthorization, sessionId: string, kind: unknown) {
    const s = await this.requireSession(sessionId);
    if (s.status === 'archived') throw new NotepadServiceError('archived', 'Archived sessions are read-only');
    if (kind !== 'explicit_search' && kind !== 'session_notepad_coordination')
      throw new NotepadServiceError('invalid', 'Invalid capability');
    this.allow(kind === 'explicit_search' ? canManageNotepad(auth) : canWriteSession(auth, s));
    if (auth.bypass) throw new NotepadServiceError('invalid', 'Capabilities require a human grantor');
    return this.store.putSessionNotepadCapability({
      sessionId,
      kind,
      grantedByUserId: auth.user.id,
      createdAt: new Date(),
    });
  }
  async removeCapability(auth: RequestAuthorization, sessionId: string, kind: SessionNotepadCapabilityRecord['kind']) {
    const s = await this.requireSession(sessionId);
    if (kind !== 'explicit_search' && kind !== 'session_notepad_coordination')
      throw new NotepadServiceError('invalid', 'Invalid capability');
    if (s.status === 'archived') throw new NotepadServiceError('archived', 'Archived sessions are read-only');
    const existing = (await this.store.listSessionNotepadCapabilities(sessionId)).find((c) => c.kind === kind);
    this.allow(canManageNotepad(auth) || (!auth.bypass && existing?.grantedByUserId === auth.user.id));
    const manager = canManageNotepad(auth);
    return this.store.removeSessionNotepadCapability(sessionId, kind, manager ? undefined : auth.user!.id);
  }
  async activityList(auth: RequestAuthorization, id: string, limit: unknown = 50, cursor: unknown = 0) {
    const notepad = await this.requireExplicitMetadata(id);
    this.allow(canManageNotepad(auth, notepad));
    return this.store.listNotepadActivity(id, boundedLimit(limit), integerValue(cursor, 'cursor'));
  }

  async history(
    auth: RequestAuthorization,
    kind: 'session' | 'explicit',
    id: string,
    limit: unknown = 50,
    cursor: unknown = 0,
    associatedSessionId?: string,
  ) {
    let manager = false;
    if (kind === 'session') {
      const session = await this.requireSession(id);
      this.allow(canReadSession(auth, session));
      manager = isHumanRevisionManager(auth);
    } else {
      const notepad = await this.requireExplicitMetadata(id);
      if (associatedSessionId) {
        const session = await this.requireSession(associatedSessionId);
        const association = await this.store.getNotepadAssociation(id, associatedSessionId);
        this.allow(Boolean(association && canReadSession(auth, session)));
      } else this.allow(canReadNotepad(auth, notepad));
      manager = isHumanRevisionManager(auth);
    }
    const records = await this.store.listNotepadRevisions(
      kind,
      id,
      boundedLimit(limit),
      integerValue(cursor, 'cursor'),
    );
    return {
      ...records,
      items: records.items.map(({ actor, ...r }) => ({ ...r, actor: manager ? actor : { kind: actor.kind } })),
    };
  }

  async readRevision(
    auth: RequestAuthorization,
    kind: 'session' | 'explicit',
    id: string,
    revision: number,
    associatedSessionId?: string,
  ) {
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new NotepadServiceError('invalid', 'revision must be a positive integer');
    if (kind === 'session') {
      const session = await this.requireSession(id);
      this.allow(canReadSession(auth, session));
    } else {
      const notepad = await this.requireExplicitMetadata(id);
      if (associatedSessionId) {
        const session = await this.requireSession(associatedSessionId);
        const association = await this.store.getNotepadAssociation(id, associatedSessionId);
        this.allow(Boolean(association && canReadSession(auth, session)));
      } else this.allow(canReadNotepad(auth, notepad));
    }
    const manager = isHumanRevisionManager(auth);
    const record = await this.store.getNotepadRevision(kind, id, revision);
    if (!record) this.notFound('Revision');
    const { actor, ...rest } = record;
    return { ...rest, actor: manager ? actor : { kind: actor.kind } };
  }

  async restoreRevision(
    auth: RequestAuthorization,
    kind: 'session' | 'explicit',
    id: string,
    revision: number,
    expectedRevision: unknown,
    actor: NotepadActor,
    associatedSessionId?: string,
  ) {
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new NotepadServiceError('invalid', 'revision must be a positive integer');
    if (kind === 'session') {
      const session = await this.requireSession(id);
      this.allow(canWriteSession(auth, session));
      if (session.status === 'archived') throw new NotepadServiceError('archived', 'Archived sessions are read-only');
      const result = await this.store.restoreSessionNotepadRevision({
        sessionId: id,
        revision,
        expectedRevision: integerValue(expectedRevision, 'expectedRevision'),
        actor,
        now: new Date(),
      });
      await this.publishChange('session', id, result.revision);
      return result;
    } else {
      const notepad = await this.requireExplicitMetadata(id);
      if (notepad.archivedAt) throw new NotepadServiceError('archived', 'Archived notepads are read-only');
      if (associatedSessionId) {
        const session = await this.requireSession(associatedSessionId);
        const association = await this.store.getNotepadAssociation(id, associatedSessionId);
        this.allow(Boolean(association && canWriteSession(auth, session)));
        if (session.status === 'archived') throw new NotepadServiceError('archived', 'Archived sessions are read-only');
      } else this.allow(canWriteNotepad(auth, notepad));
      const result = await this.store.restoreExplicitNotepadRevision({
        id,
        revision,
        expectedRevision: integerValue(expectedRevision, 'expectedRevision'),
        actor,
        ...(associatedSessionId && !auth.bypass
          ? { associatedAuthority: { associatedSessionId, expectedUserId: auth.user.id } }
          : {}),
        activityId: randomUUID(),
        now: new Date(),
      });
      await this.publishChange('explicit', id, result.revision);
      return result;
    }
  }

  private async publishChange(kind: 'session' | 'explicit', id: string, revision: number) {
    if (!this.events) return;
    try {
      if (kind === 'session') {
        await this.publishChangePage(kind, id, revision, [id]);
        return;
      }
      let afterSessionId: string | null = null;
      while (true) {
        const sessionIds = await this.store.listNotepadAssociationSessionIdsAfter(
          id,
          afterSessionId,
          notepadPageMaxLimit,
        );
        if (!sessionIds.length) return;
        await this.publishChangePage(kind, id, revision, sessionIds);
        if (sessionIds.length < notepadPageMaxLimit) return;
        afterSessionId = sessionIds.at(-1)!;
      }
    } catch {
      // The content mutation is already committed. A best-effort notification
      // failure must not make a successful write appear to have failed.
    }
  }

  async archive(auth: RequestAuthorization, id: string) {
    const notepad = await this.requireExplicitMetadata(id);
    this.allow(canManageNotepad(auth, notepad));
    return (await this.store.archiveExplicitNotepad({ id, archivedAt: new Date() })) ?? this.notFound('Notepad');
  }

  async restore(auth: RequestAuthorization, id: string) {
    const notepad = await this.requireExplicitMetadata(id);
    this.allow(canManageNotepad(auth, notepad));
    return (await this.store.restoreExplicitNotepad({ id, updatedAt: new Date() })) ?? this.notFound('Notepad');
  }

  private async publishAssociationChange(sessionId: string) {
    if (!this.events) return;
    try {
      await this.events.append({
        sessionId,
        type: 'notepad_associations_changed',
        payload: {},
      });
    } catch {
      // The association mutation is already committed. Realtime invalidation
      // remains best effort, like Notepad content-change notifications.
    }
  }

  private async publishChangePage(kind: 'session' | 'explicit', id: string, revision: number, sessionIds: string[]) {
    await Promise.allSettled(
      sessionIds.map((sessionId) =>
        this.events!.append({
          sessionId,
          type: 'notepad_changed',
          payload: { notepadKind: kind, notepadId: id, revision },
        }),
      ),
    );
  }

  private async mutate(
    kind: 'session' | 'explicit',
    id: string,
    input: Record<string, unknown>,
    actor: NotepadActor,
    forcedKind?: 'restore',
    expectedCoordinationGrantorUserId?: string,
    associatedAuthority?: { associatedSessionId: string; expectedUserId: string },
  ) {
    const current =
      kind === 'session' ? await this.store.getSessionNotepad(id) : await this.store.getExplicitNotepad(id);
    let content: string | undefined;
    let mutationKind: NotepadMutationKind = 'replace';
    if (input.append !== undefined) mutationKind = 'append';
    else if (input.oldText !== undefined || input.newText !== undefined) {
      mutationKind = 'patch';
      content = patchedContent(current?.content ?? '', input.oldText, input.newText);
    } else content = stringValue(input.content, 'content');
    if (forcedKind) mutationKind = forcedKind;
    const expectedRevision =
      input.expectedRevision === undefined && mutationKind === 'append'
        ? (current?.revision ?? 0)
        : integerValue(input.expectedRevision, 'expectedRevision');
    const common = { expectedRevision, actor, mutationKind, now: new Date() };
    if (kind === 'session')
      return this.store.mutateSessionNotepad({
        sessionId: id,
        ...(expectedCoordinationGrantorUserId ? { expectedCoordinationGrantorUserId } : {}),
        ...(mutationKind === 'append' ? { append: stringValue(input.append, 'append') } : { content: content! }),
        ...common,
      });
    return this.store.mutateExplicitNotepad({
      id,
      ...(associatedAuthority ? { associatedAuthority } : {}),
      ...(mutationKind === 'append' ? { append: stringValue(input.append, 'append') } : { content: content! }),
      ...common,
    });
  }

  private async requireSession(id: string) {
    return (await this.store.getSession(id)) ?? this.notFound('Session');
  }
  private async requireExplicit(id: string) {
    return (await this.store.getExplicitNotepad(id)) ?? this.notFound('Notepad');
  }
  private async requireExplicitMetadata(id: string) {
    return (await this.store.getExplicitNotepadMetadata(id)) ?? this.notFound('Notepad');
  }
  private allow(value: boolean) {
    if (!value) this.forbidden();
  }
  private forbidden(): never {
    throw new NotepadServiceError('forbidden', 'Notepad access denied');
  }
  private notFound(kind: string): never {
    throw new NotepadServiceError('not_found', `${kind} not found`);
  }
}

function validTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > notepadTitleMaxLength)
    throw new NotepadServiceError('invalid', `Title must be between 1 and ${notepadTitleMaxLength} characters`);
  return value.trim();
}
function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new NotepadServiceError('invalid', `${name} must be a string`);
  return value;
}
function patchedContent(source: string, oldTextValue: unknown, newTextValue: unknown): string {
  const oldText = stringValue(oldTextValue, 'oldText');
  const newText = stringValue(newTextValue, 'newText');
  if (!oldText) throw new NotepadServiceError('invalid', 'oldText must not be empty');
  const first = source.indexOf(oldText);
  if (first < 0) throw new NotepadServiceError('patch_not_found', 'oldText was not found');
  if (source.indexOf(oldText, first + oldText.length) >= 0)
    throw new NotepadServiceError('patch_ambiguous', 'oldText occurs more than once');
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}
function integerValue(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new NotepadServiceError('invalid', `${name} must be a non-negative integer`);
  return value as number;
}

function boundedLimit(value: unknown): number {
  const limit = integerValue(value, 'limit');
  if (limit < 1 || limit > notepadPageMaxLimit)
    throw new NotepadServiceError('invalid', `limit must be between 1 and ${notepadPageMaxLimit}`);
  return limit;
}

function isHumanRevisionManager(auth: RequestAuthorization): boolean {
  return !auth.bypass && canManageNotepad(auth);
}
