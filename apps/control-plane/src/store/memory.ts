import type { NormalizedEvent } from '../events/types.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  nextOccurrence,
  occurrenceInstantsBetween,
  type NormalizedSchedule,
} from '../scheduled-follow-ups/recurrence.js';
import { MemorySkillStore } from './memory-skills.js';
import { notepadRevisionRetentionLimit, StoreConflictError } from './types.js';
import type {
  AppStore,
  AgentSessionListOptions,
  ArtifactRecord,
  AutomationInvocationRecord,
  AutomationRecord,
  AuthAccountRecord,
  AuthSessionRecord,
  AuthUserRecord,
  CallbackDeliveryRecord,
  ChildSessionListOptions,
  CreateAutomationInvocationRecord,
  CreateAutomationRecord,
  CreateArtifactRecord,
  CreateCallbackDeliveryRecord,
  CreateEnvironmentRecord,
  CreateExternalResourceRecord,
  CreateSandboxRecord,
  CreateWebhookSourceRecord,
  ExternalResourceRecord,
  ExternalThreadRecord,
  IntegrationDeliveryRecord,
  EventRecord,
  EventDeltaCompactionInput,
  EnvironmentWithDetailsRecord,
  EnvironmentActivityRecord,
  EnvironmentRevisionRecord,
  CreateMessageRecord,
  CreateSessionRecord,
  CreateSessionWithFirstMessageInput,
  CreateSessionWithFirstMessageResult,
  CreateSkillRecord,
  CreateSnippetRecord,
  ClaimedMessage,
  ClaimedMessageBatch,
  ListAutomationInvocationsOptions,
  MessageRecord,
  ExplicitNotepadRecord,
  SessionNotepadRecord,
  NotepadRevisionRecord,
  NotepadAssociationRecord,
  SessionNotepadCapabilityRecord,
  NotepadActivityRecord,
  NotepadActor,
  NotepadMutationKind,
  RecoveredRun,
  RunRecord,
  SandboxRecord,
  SandboxSecrets,
  SessionContextUpdateInput,
  SessionListOptions,
  SessionMetadataUpdateInput,
  SessionRecord,
  SessionSearchDocInput,
  SessionSearchMatchKind,
  SessionSearchOptions,
  SessionSearchPage,
  SessionTagSummary,
  SessionTitleUpdateInput,
  SessionWithSandboxPage,
  SessionMessageSummary,
  SessionTranscriptOptions,
  SessionTranscriptPage,
  SkillRecord,
  SkillRevisionRecord,
  SkillRevisionSelection,
  SkillRunCandidate,
  SnippetRecord,
  UpdateAutomationRecord,
  UpdateEnvironmentRecord,
  UpdateSkillRecord,
  UpdateSnippetRecord,
  UpsertAuthUserForAccountRecord,
  WebhookSourceRecord,
  CreateScheduledFollowUpRecordInput,
  ScheduledFollowUpActivationResult,
  ScheduledFollowUpClaim,
  ScheduledFollowUpMutationResult,
  ScheduledFollowUpOccurrenceCursor,
  ScheduledFollowUpOccurrenceRecord,
  ScheduledFollowUpRecord,
  UpdateScheduledFollowUpRecordInput,
} from './types.js';

const staleCallbackSendingMs = 15 * 60_000;
export class MemoryStore implements AppStore {
  private readonly authUsers = new Map<string, AuthUserRecord>();
  private readonly authAccounts = new Map<string, AuthAccountRecord>();
  private readonly authSessions = new Map<string, AuthSessionRecord>();
  private readonly operationLocks = new Map<string, Promise<void>>();
  private readonly skillStore = new MemorySkillStore();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly events = new Map<string, EventRecord[]>();
  private nextEventId = 1;
  private readonly sandboxes = new Map<string, SandboxRecord>();
  private readonly sandboxSecrets = new Map<string, SandboxSecrets>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly externalResources = new Map<string, ExternalResourceRecord>();
  private readonly callbacks = new Map<string, CallbackDeliveryRecord>();
  private readonly automations = new Map<string, AutomationRecord>();
  private readonly scheduledFollowUps = new Map<string, ScheduledFollowUpRecord>();
  private readonly scheduledFollowUpOccurrences = new Map<string, ScheduledFollowUpOccurrenceRecord[]>();
  private readonly automationInvocations = new Map<string, AutomationInvocationRecord>();
  private readonly environments = new Map<string, EnvironmentWithDetailsRecord>();
  private readonly environmentRevisions = new Map<string, EnvironmentRevisionRecord>();
  private readonly environmentActivity = new Map<string, EnvironmentActivityRecord[]>();
  private readonly webhookSources = new Map<string, WebhookSourceRecord>();
  private readonly externalThreads = new Map<string, ExternalThreadRecord>();
  private readonly integrationDeliveries = new Map<string, IntegrationDeliveryRecord>();
  private readonly sessionSearchDocs = new Map<string, SessionSearchDocInput>();
  private readonly sessionStars = new Map<string, Set<string>>();
  private readonly snippets = new Map<string, SnippetRecord>();
  private readonly sessionNotepads = new Map<string, SessionNotepadRecord>();
  private readonly explicitNotepads = new Map<string, ExplicitNotepadRecord>();
  private readonly notepadRevisions = new Map<string, NotepadRevisionRecord[]>();
  private readonly notepadAssociations = new Map<string, NotepadAssociationRecord>();
  private readonly notepadCapabilities = new Map<string, SessionNotepadCapabilityRecord>();
  private readonly notepadActivity = new Map<string, NotepadActivityRecord[]>();
  private searchIndexCursor = 0;

  async getSessionNotepad(sessionId: string): Promise<SessionNotepadRecord | null> {
    const value = this.sessionNotepads.get(sessionId);
    return value ? structuredClone(value) : null;
  }

  async readCoordinatedSessionNotepad(
    actorSessionId: string,
    targetSessionId: string,
    expectedGrantorUserId: string,
  ): Promise<SessionNotepadRecord> {
    const target = this.sessions.get(targetSessionId);
    if (!target) throw new StoreConflictError('not_found', 'Session not found');
    this.assertLiveSession(actorSessionId);
    this.assertLiveSession(targetSessionId);
    this.assertMemoryCoordinationAuthority(actorSessionId, target, expectedGrantorUserId);
    const value = this.sessionNotepads.get(targetSessionId) ?? {
      sessionId: targetSessionId,
      revision: 0,
      content: '',
      sizeBytes: 0,
      createdAt: target.createdAt,
      updatedAt: target.createdAt,
    };
    return structuredClone(value);
  }

  async mutateSessionNotepad(input: {
    sessionId: string;
    content?: string;
    append?: string;
    expectedRevision?: number;
    actor: NotepadActor;
    expectedCoordinationGrantorUserId?: string;
    mutationKind: NotepadMutationKind;
    now: Date;
  }): Promise<SessionNotepadRecord> {
    this.assertLiveNotepadActor(input.actor);
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new StoreConflictError('not_found', 'Session not found');
    if (session.status === 'archived')
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    if (input.actor.kind === 'agent' && input.actor.sessionId !== input.sessionId)
      this.assertMemoryCoordinationAuthority(input.actor.sessionId, session, input.expectedCoordinationGrantorUserId);
    const old = this.sessionNotepads.get(input.sessionId);
    return this.mutateMemoryNotepad('session', input.sessionId, old, input, (value) =>
      this.sessionNotepads.set(input.sessionId, value as SessionNotepadRecord),
    ) as SessionNotepadRecord;
  }
  async restoreSessionNotepadRevision(input: {
    sessionId: string;
    revision: number;
    expectedRevision: number;
    actor: NotepadActor;
    expectedCoordinationGrantorUserId?: string;
    now: Date;
  }): Promise<SessionNotepadRecord> {
    this.assertLiveNotepadActor(input.actor);
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new StoreConflictError('not_found', 'Session not found');
    if (session.status === 'archived')
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    if (input.actor.kind === 'agent' && input.actor.sessionId !== input.sessionId)
      this.assertMemoryCoordinationAuthority(input.actor.sessionId, session, input.expectedCoordinationGrantorUserId);
    const old = this.sessionNotepads.get(input.sessionId);
    if ((old?.revision ?? 0) !== input.expectedRevision)
      throw new StoreConflictError('stale_revision', 'Stale notepad revision');
    const target = (this.notepadRevisions.get(`session:${input.sessionId}`) ?? []).find(
      (record) => record.revision === input.revision,
    );
    if (!target) throw new StoreConflictError('not_found', 'Revision not found');
    return this.mutateMemoryNotepad(
      'session',
      input.sessionId,
      old,
      {
        content: target.content,
        expectedRevision: input.expectedRevision,
        actor: input.actor,
        mutationKind: 'restore',
        now: input.now,
      },
      (value) => this.sessionNotepads.set(input.sessionId, value as SessionNotepadRecord),
    ) as SessionNotepadRecord;
  }

  async createExplicitNotepad(input: {
    record: ExplicitNotepadRecord;
    actor: NotepadActor;
    activityId: string;
    initialAssociation?: NotepadAssociationRecord;
    associationActivityId?: string;
  }): Promise<ExplicitNotepadRecord> {
    this.assertLiveNotepadActor(input.actor);
    const { record } = input;
    if (this.explicitNotepads.has(record.id)) throw new StoreConflictError('notepad_exists', 'Notepad exists');
    if (Boolean(input.initialAssociation) !== Boolean(input.associationActivityId))
      throw new StoreConflictError('not_found', 'Initial association and activity ID are required together');
    if (input.initialAssociation) {
      if (input.initialAssociation.notepadId !== record.id)
        throw new StoreConflictError('not_found', 'Initial association must reference the created Notepad');
      const session = this.sessions.get(input.initialAssociation.sessionId);
      if (!session) throw new StoreConflictError('not_found', 'Session not found');
      if (session.status === 'archived')
        throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    }
    const sizeBytes = Buffer.byteLength(record.content, 'utf8');
    if (record.sizeBytes !== sizeBytes)
      throw new StoreConflictError('invalid_notepad_size', 'Notepad size does not match UTF-8 content');
    if (sizeBytes > 256 * 1024) throw new StoreConflictError('notepad_too_large', 'Notepad exceeds 256 KiB');
    const expectedRevision = record.content ? 1 : 0;
    if (record.revision !== expectedRevision)
      throw new StoreConflictError('invalid_notepad_revision', 'Initial Notepad revision does not match its content');
    this.explicitNotepads.set(record.id, structuredClone({ ...record, sizeBytes }));
    if (record.revision === 1) {
      this.notepadRevisions.set(`explicit:${record.id}`, [
        structuredClone({
          notepadKind: 'explicit',
          notepadId: record.id,
          revision: 1,
          content: record.content,
          sizeBytes,
          actor: input.actor,
          mutationKind: 'replace',
          createdAt: record.createdAt,
        }),
      ]);
    }
    this.addMemoryActivity(
      record.id,
      input.activityId,
      input.actor,
      'created',
      {
        title: record.title,
      },
      record.createdAt,
    );
    if (input.initialAssociation) {
      this.notepadAssociations.set(
        `${record.id}:${input.initialAssociation.sessionId}`,
        structuredClone(input.initialAssociation),
      );
      this.addMemoryActivity(
        record.id,
        input.associationActivityId!,
        input.actor,
        'association_granted',
        { sessionId: input.initialAssociation.sessionId },
        input.initialAssociation.createdAt,
      );
    }
    return structuredClone({ ...record, sizeBytes });
  }
  async getExplicitNotepad(id: string): Promise<ExplicitNotepadRecord | null> {
    const value = this.explicitNotepads.get(id);
    return value ? structuredClone(value) : null;
  }
  async getExplicitNotepadMetadata(id: string) {
    const value = this.explicitNotepads.get(id);
    if (!value) return null;
    const { content: _content, ...metadata } = value;
    return structuredClone(metadata);
  }
  async listExplicitNotepads(input: { limit: number; offset: number; includeDormant?: boolean; archived?: boolean }) {
    const all = [...this.explicitNotepads.values()]
      .filter(
        (n) =>
          Boolean(n.archivedAt) === Boolean(input.archived) &&
          (input.includeDormant || this.hasLiveNotepadAssociation(n.id)),
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id));
    return memoryPage(
      all.map(({ content: _content, ...n }) => structuredClone(n)),
      input.offset,
      input.limit,
    );
  }
  async searchExplicitNotepads(input: { query: string; limit: number; archived?: boolean }) {
    const q = input.query.toLowerCase();
    return [...this.explicitNotepads.values()]
      .filter(
        (n) =>
          Boolean(n.archivedAt) === Boolean(input.archived) &&
          this.hasLiveNotepadAssociation(n.id) &&
          `${n.title}\n${n.content}`.toLowerCase().includes(q),
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, input.limit)
      .map(({ content, ...n }) => ({ ...structuredClone(n), snippet: notepadSnippet(content, input.query) }));
  }
  async searchExplicitNotepadsWithCapability(input: {
    actorSessionId: string;
    expectedGrantorUserId: string;
    query: string;
    limit: number;
  }) {
    this.assertMemoryExplicitSearchAuthority(input.actorSessionId, input.expectedGrantorUserId);
    return this.searchExplicitNotepads({ query: input.query, limit: input.limit });
  }
  async readExplicitNotepadWithCapability(input: {
    actorSessionId: string;
    expectedGrantorUserId: string;
    notepadId: string;
  }) {
    const notepad = this.explicitNotepads.get(input.notepadId);
    const actor = this.sessions.get(input.actorSessionId);
    if (!notepad || !actor) throw new StoreConflictError('not_found', 'Notepad access denied');
    this.assertMemoryExplicitSearchAuthority(input.actorSessionId, input.expectedGrantorUserId);
    return structuredClone(notepad);
  }
  async updateExplicitNotepadMetadata(input: {
    id: string;
    title?: string;
    actor: NotepadActor;
    activityId: string;
    now: Date;
  }): Promise<ExplicitNotepadRecord> {
    this.assertLiveNotepadActor(input.actor);
    this.assertMemoryExplicitWriteAuthority(input.id, input.actor);
    const existing = this.explicitNotepads.get(input.id);
    if (!existing) throw new StoreConflictError('not_found', 'Notepad not found');
    if (existing.archivedAt) throw new StoreConflictError('not_found', 'Archived notepads are read-only');
    const updated = {
      ...existing,
      ...(input.title === undefined ? {} : { title: input.title }),
      updatedAt: input.now,
    };
    this.explicitNotepads.set(input.id, structuredClone(updated));
    this.addMemoryActivity(
      input.id,
      input.activityId,
      input.actor,
      'metadata_changed',
      { title: updated.title },
      input.now,
    );
    return structuredClone(updated);
  }
  async mutateExplicitNotepad(input: {
    id: string;
    content?: string;
    append?: string;
    expectedRevision?: number;
    actor: NotepadActor;
    associatedAuthority?: import('./types.js').AssociatedNotepadAuthority;
    mutationKind: NotepadMutationKind;
    now: Date;
  }): Promise<ExplicitNotepadRecord> {
    this.assertLiveNotepadActor(input.actor);
    this.assertMemoryExplicitWriteAuthority(input.id, input.actor);
    if (input.associatedAuthority) this.assertMemoryAssociatedAuthority(input.id, input.associatedAuthority);
    const old = this.explicitNotepads.get(input.id);
    if (!old) throw new StoreConflictError('not_found', 'Notepad not found');
    if (old.archivedAt) throw new StoreConflictError('not_found', 'Archived notepads are read-only');
    return this.mutateMemoryNotepad('explicit', input.id, old, input, (v) =>
      this.explicitNotepads.set(input.id, v as ExplicitNotepadRecord),
    ) as ExplicitNotepadRecord;
  }
  async restoreExplicitNotepadRevision(input: {
    id: string;
    revision: number;
    expectedRevision: number;
    actor: NotepadActor;
    associatedAuthority?: import('./types.js').AssociatedNotepadAuthority;
    activityId: string;
    now: Date;
  }): Promise<ExplicitNotepadRecord> {
    this.assertLiveNotepadActor(input.actor);
    this.assertMemoryExplicitWriteAuthority(input.id, input.actor);
    if (input.associatedAuthority) this.assertMemoryAssociatedAuthority(input.id, input.associatedAuthority);
    const old = this.explicitNotepads.get(input.id);
    if (!old) throw new StoreConflictError('not_found', 'Notepad not found');
    if (old.archivedAt) throw new StoreConflictError('not_found', 'Archived notepads are read-only');
    if (old.revision !== input.expectedRevision)
      throw new StoreConflictError('stale_revision', 'Stale notepad revision');
    const target = (this.notepadRevisions.get(`explicit:${input.id}`) ?? []).find((r) => r.revision === input.revision);
    if (!target) throw new StoreConflictError('not_found', 'Revision not found');
    const result = this.mutateMemoryNotepad(
      'explicit',
      input.id,
      old,
      {
        content: target.content,
        expectedRevision: input.expectedRevision,
        actor: input.actor,
        mutationKind: 'restore',
        now: input.now,
      },
      (v) => this.explicitNotepads.set(input.id, v as ExplicitNotepadRecord),
    ) as ExplicitNotepadRecord;
    this.addMemoryActivity(
      input.id,
      input.activityId,
      input.actor,
      'revision_restored',
      { revision: input.revision },
      input.now,
    );
    return structuredClone(result);
  }
  async listNotepadRevisions(kind: 'session' | 'explicit', id: string, limit: number, beforeRevision: number) {
    const records = [...(this.notepadRevisions.get(`${kind}:${id}`) ?? [])]
      .filter((record) => beforeRevision === 0 || record.revision < beforeRevision)
      .sort((a, b) => b.revision - a.revision)
      .map(({ content: _content, ...r }) => r);
    const items = structuredClone(records.slice(0, limit));
    const hasMore = records.length > limit;
    return { items, hasMore, nextCursor: hasMore ? String(items.at(-1)!.revision) : null };
  }
  async getNotepadRevision(kind: 'session' | 'explicit', id: string, revision: number) {
    return structuredClone(
      (this.notepadRevisions.get(`${kind}:${id}`) ?? []).find((r) => r.revision === revision) ?? null,
    );
  }
  async putNotepadAssociation(input: {
    record: NotepadAssociationRecord;
    actor: NotepadActor;
    activityId: string;
  }): Promise<NotepadAssociationRecord> {
    this.assertLiveNotepadActor(input.actor);
    this.assertMemoryExplicitWriteAuthority(input.record.notepadId, input.actor);
    const { record } = input;
    const notepad = this.explicitNotepads.get(record.notepadId);
    const session = this.sessions.get(record.sessionId);
    if (!notepad || !session) throw new StoreConflictError('not_found', 'Notepad or Session not found');
    const actingSession = input.actor.kind === 'agent' ? this.sessions.get(input.actor.sessionId) : undefined;
    if (input.actor.kind === 'agent' && (!actingSession || !agentSessionCanRead(actingSession, session))) {
      throw new StoreConflictError('notepad_association_forbidden', 'Agent cannot access the target session');
    }
    if (notepad.archivedAt) throw new StoreConflictError('not_found', 'Archived notepads are read-only');
    if (session.status === 'archived')
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    const existed = this.notepadAssociations.has(`${record.notepadId}:${record.sessionId}`);
    this.notepadAssociations.set(`${record.notepadId}:${record.sessionId}`, structuredClone(record));
    this.addMemoryActivity(
      record.notepadId,
      input.activityId,
      input.actor,
      existed ? 'association_changed' : 'association_granted',
      { sessionId: record.sessionId },
      record.createdAt,
    );
    return structuredClone(record);
  }
  async removeNotepadAssociation(input: {
    notepadId: string;
    sessionId: string;
    actor: NotepadActor;
    activityId: string;
    now: Date;
  }): Promise<boolean> {
    this.assertLiveNotepadActor(input.actor);
    this.assertMemoryExplicitWriteAuthority(input.notepadId, input.actor);
    const notepad = this.explicitNotepads.get(input.notepadId);
    const session = this.sessions.get(input.sessionId);
    if (!notepad || !session) throw new StoreConflictError('not_found', 'Notepad or Session not found');
    const actingSession = input.actor.kind === 'agent' ? this.sessions.get(input.actor.sessionId) : undefined;
    if (input.actor.kind === 'agent' && (!actingSession || !agentSessionCanRead(actingSession, session))) {
      throw new StoreConflictError('notepad_association_forbidden', 'Agent cannot access the target session');
    }
    if (notepad.archivedAt) throw new StoreConflictError('not_found', 'Archived notepads are read-only');
    if (session.status === 'archived')
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    const removed = this.notepadAssociations.delete(`${input.notepadId}:${input.sessionId}`);
    if (removed)
      this.addMemoryActivity(
        input.notepadId,
        input.activityId,
        input.actor,
        'association_revoked',
        { sessionId: input.sessionId },
        input.now,
      );
    return removed;
  }
  async listNotepadAssociations(notepadId: string, limit: number, offset: number) {
    const all = [...this.notepadAssociations.values()]
      .filter((a) => a.notepadId === notepadId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.sessionId.localeCompare(b.sessionId))
      .map((a) => structuredClone(a));
    return memoryPage(all, offset, limit);
  }
  async listNotepadAssociationSessionIdsAfter(notepadId: string, afterSessionId: string | null, limit: number) {
    return [...this.notepadAssociations.values()]
      .filter(
        (association) =>
          association.notepadId === notepadId && (afterSessionId === null || association.sessionId > afterSessionId),
      )
      .map((association) => association.sessionId)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, limit);
  }
  async getNotepadAssociation(notepadId: string, sessionId: string) {
    const value = this.notepadAssociations.get(`${notepadId}:${sessionId}`);
    return value ? structuredClone(value) : null;
  }
  async listSessionNotepadAssociations(sessionId: string, limit: number, offset: number) {
    const all = [...this.notepadAssociations.values()]
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.notepadId.localeCompare(b.notepadId))
      .flatMap((a) => {
        const n = this.explicitNotepads.get(a.notepadId);
        if (!n) return [];
        const { content: _content, ...notepad } = n;
        return [{ ...structuredClone(a), notepad: structuredClone(notepad) }];
      });
    return memoryPage(all, offset, limit);
  }
  async putSessionNotepadCapability(record: SessionNotepadCapabilityRecord): Promise<SessionNotepadCapabilityRecord> {
    this.assertLiveSession(record.sessionId);
    this.notepadCapabilities.set(`${record.sessionId}:${record.kind}`, structuredClone(record));
    return structuredClone(record);
  }
  async removeSessionNotepadCapability(
    sessionId: string,
    kind: SessionNotepadCapabilityRecord['kind'],
    expectedGrantedByUserId?: string,
  ): Promise<boolean> {
    this.assertLiveSession(sessionId);
    const existing = this.notepadCapabilities.get(`${sessionId}:${kind}`);
    if (expectedGrantedByUserId && existing?.grantedByUserId !== expectedGrantedByUserId) return false;
    return this.notepadCapabilities.delete(`${sessionId}:${kind}`);
  }
  async listSessionNotepadCapabilities(sessionId: string): Promise<SessionNotepadCapabilityRecord[]> {
    return [...this.notepadCapabilities.values()]
      .filter((c) => c.sessionId === sessionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.kind.localeCompare(b.kind))
      .map((c) => structuredClone(c));
  }
  private addMemoryActivity(
    notepadId: string,
    id: string,
    actor: NotepadActor,
    kind: NotepadActivityRecord['kind'],
    metadata: Record<string, unknown>,
    createdAt: Date,
  ) {
    const record = structuredClone({ id, notepadId, actor, kind, metadata, createdAt });
    const records = this.notepadActivity.get(record.notepadId) ?? [];
    records.push(record);
    this.notepadActivity.set(record.notepadId, records);
  }
  private assertLiveNotepadActor(actor: NotepadActor) {
    if (actor.kind === 'agent') this.assertLiveSession(actor.sessionId);
  }
  private assertMemoryExplicitWriteAuthority(notepadId: string, actor: NotepadActor) {
    if (actor.kind === 'agent' && !this.notepadAssociations.has(`${notepadId}:${actor.sessionId}`))
      throw new StoreConflictError('not_found', 'Notepad association is required');
  }
  private assertMemoryAssociatedAuthority(
    notepadId: string,
    authority: import('./types.js').AssociatedNotepadAuthority,
  ) {
    const session = this.sessions.get(authority.associatedSessionId);
    if (!session || session.status === 'archived' || !this.notepadAssociations.has(`${notepadId}:${session.id}`))
      throw new StoreConflictError('not_found', 'Associated Session authority is no longer valid');
    if (!this.memoryUserCanWriteSession(authority.expectedUserId, session))
      throw new StoreConflictError('not_found', 'Associated Session authority is no longer valid');
  }
  async archiveExplicitNotepad(input: { id: string; archivedAt: Date }) {
    const record = this.explicitNotepads.get(input.id);
    if (!record) return null;
    const updated = { ...record, archivedAt: input.archivedAt, updatedAt: input.archivedAt };
    this.explicitNotepads.set(input.id, structuredClone(updated));
    return structuredClone(updated);
  }
  async restoreExplicitNotepad(input: { id: string; updatedAt: Date }) {
    const record = this.explicitNotepads.get(input.id);
    if (!record) return null;
    const { archivedAt: _archivedAt, ...active } = record;
    const updated = { ...active, updatedAt: input.updatedAt };
    this.explicitNotepads.set(input.id, structuredClone(updated));
    return structuredClone(updated);
  }
  private assertMemoryExplicitSearchAuthority(actorSessionId: string, userId: string) {
    const actor = this.sessions.get(actorSessionId);
    const grant = this.notepadCapabilities.get(`${actorSessionId}:explicit_search`);
    const user = this.authUsers.get(userId);
    if (!actor || actor.status === 'archived' || grant?.grantedByUserId !== userId || !user || user.role === 'viewer')
      throw new StoreConflictError('not_found', 'Notepad access denied');
  }
  private memoryUserCanWriteSession(userId: string, _session: SessionRecord) {
    const user = this.authUsers.get(userId);
    return Boolean(user && (user.role === 'member' || user.role === 'admin'));
  }
  private assertMemoryCoordinationAuthority(
    actorSessionId: string,
    target: SessionRecord,
    expectedGrantorUserId?: string,
  ) {
    const actor = this.sessions.get(actorSessionId);
    const capability = this.notepadCapabilities.get(`${actorSessionId}:session_notepad_coordination`);
    if (!actor || !expectedGrantorUserId || capability?.grantedByUserId !== expectedGrantorUserId)
      throw new StoreConflictError('not_found', 'Session Notepad coordination capability is required');
    const user = this.authUsers.get(expectedGrantorUserId);
    const authorized = user?.role === 'member' || user?.role === 'admin';
    const privateTargetAuthorized =
      target.visibility !== 'private' ||
      (actor.visibility === 'private' &&
        actor.ownerUserId === target.ownerUserId &&
        target.ownerUserId === expectedGrantorUserId);
    if (!user || !authorized || !privateTargetAuthorized) {
      throw new StoreConflictError('not_found', 'Coordination grantor is no longer authorized');
    }
  }
  private assertLiveSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new StoreConflictError('not_found', 'Session not found');
    if (session.status === 'archived')
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
  }
  private hasLiveNotepadAssociation(notepadId: string) {
    for (const association of this.notepadAssociations.values()) {
      if (association.notepadId !== notepadId) continue;
      const session = this.sessions.get(association.sessionId);
      if (session && session.status !== 'archived') return true;
    }
    return false;
  }
  async listNotepadActivity(notepadId: string, limit: number, offset: number) {
    const all = structuredClone(this.notepadActivity.get(notepadId) ?? []).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
    );
    return memoryPage(all, offset, limit);
  }

  private mutateMemoryNotepad(
    kind: 'session' | 'explicit',
    id: string,
    old: SessionNotepadRecord | ExplicitNotepadRecord | undefined,
    input: {
      content?: string;
      append?: string;
      expectedRevision?: number;
      actor: NotepadActor;
      mutationKind: NotepadMutationKind;
      now: Date;
    },
    save: (value: SessionNotepadRecord | ExplicitNotepadRecord) => void,
  ): SessionNotepadRecord | ExplicitNotepadRecord {
    const revision = old?.revision ?? 0;
    if (input.append === undefined && input.expectedRevision !== revision)
      throw new StoreConflictError('stale_revision', 'Stale notepad revision');
    const content = input.append !== undefined ? `${old?.content ?? ''}${input.append}` : (input.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024)
      throw new StoreConflictError('notepad_too_large', 'Notepad exceeds 256 KiB');
    const value = structuredClone({
      ...(old ?? (kind === 'session' ? { sessionId: id } : { id })),
      content,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      revision: revision + 1,
      createdAt: old?.createdAt ?? input.now,
      updatedAt: input.now,
    }) as SessionNotepadRecord | ExplicitNotepadRecord;
    save(value);
    const key = `${kind}:${id}`;
    const revisions = this.notepadRevisions.get(key) ?? [];
    revisions.push(
      structuredClone({
        notepadKind: kind,
        notepadId: id,
        revision: value.revision,
        content,
        sizeBytes: value.sizeBytes,
        actor: input.actor,
        mutationKind: input.mutationKind,
        createdAt: input.now,
      }),
    );
    if (revisions.length > notepadRevisionRetentionLimit)
      revisions.splice(0, revisions.length - notepadRevisionRetentionLimit);
    this.notepadRevisions.set(key, revisions);
    return structuredClone(value);
  }

  async createSnippet(record: CreateSnippetRecord): Promise<SnippetRecord> {
    if (!this.authUsers.has(record.ownerUserId)) throw new Error(`User does not exist: ${record.ownerUserId}`);
    this.assertSnippetName(record.name, record.ownerUserId);
    this.snippets.set(record.id, { ...record });
    return structuredClone(record);
  }

  async getSnippetForUser(id: string, ownerUserId: string): Promise<SnippetRecord | null> {
    const value = this.snippets.get(id);
    return value?.ownerUserId === ownerUserId ? { ...value } : null;
  }

  async listSnippetsForUser(ownerUserId: string): Promise<SnippetRecord[]> {
    return [...this.snippets.values()]
      .filter((item) => item.ownerUserId === ownerUserId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ ...item }));
  }

  async updateSnippet(record: UpdateSnippetRecord): Promise<SnippetRecord | null> {
    const existing = this.snippets.get(record.id);
    if (!existing || existing.ownerUserId !== record.ownerUserId || existing.archivedAt) return null;
    if (record.name !== undefined) this.assertSnippetName(record.name, record.ownerUserId, record.id);
    const updated = { ...existing, ...record };
    this.snippets.set(record.id, updated);
    return { ...updated };
  }

  async archiveSnippet(id: string, ownerUserId: string, archivedAt: Date): Promise<SnippetRecord | null> {
    const existing = this.snippets.get(id);
    if (!existing || existing.ownerUserId !== ownerUserId) return null;
    if (existing.archivedAt) return { ...existing };
    const updated = { ...existing, archivedAt: existing.archivedAt ?? archivedAt, updatedAt: archivedAt };
    this.snippets.set(id, updated);
    return { ...updated };
  }

  async restoreSnippet(id: string, ownerUserId: string, updatedAt: Date): Promise<SnippetRecord | null> {
    const existing = this.snippets.get(id);
    if (!existing || existing.ownerUserId !== ownerUserId) return null;
    if (!existing.archivedAt) return { ...existing };
    this.assertSnippetName(existing.name, ownerUserId, id);
    const { archivedAt: _, ...active } = existing;
    const updated = { ...active, updatedAt };
    this.snippets.set(id, updated);
    return { ...updated };
  }

  private assertSnippetName(name: string, ownerUserId: string, exceptId?: string): void {
    if (
      [...this.snippets.values()].some(
        (item) => !item.archivedAt && item.ownerUserId === ownerUserId && item.name === name && item.id !== exceptId,
      )
    )
      throw new StoreConflictError('snippet_name_exists', 'A snippet with this name already exists');
  }

  async upsertAuthUserForAccount(record: UpsertAuthUserForAccountRecord): Promise<AuthUserRecord> {
    const accountKey = authAccountKey(record.provider, record.providerAccountId);
    const existingAccount = this.authAccounts.get(accountKey);
    const existingUser = existingAccount ? this.authUsers.get(existingAccount.userId) : undefined;
    const user: AuthUserRecord = {
      id: existingUser?.id ?? record.userId,
      username: record.username,
      role: existingUser?.role ?? record.role,
      createdAt: existingUser?.createdAt ?? record.now,
      updatedAt: record.now,
      ...(record.displayName ? { displayName: record.displayName } : {}),
      ...(record.avatarUrl ? { avatarUrl: record.avatarUrl } : {}),
    };
    const account: AuthAccountRecord = {
      id: existingAccount?.id ?? record.accountId,
      userId: user.id,
      provider: record.provider,
      providerAccountId: record.providerAccountId,
      username: record.username,
      profile: record.profile,
      createdAt: existingAccount?.createdAt ?? record.now,
      updatedAt: record.now,
    };

    this.authUsers.set(user.id, user);
    this.authAccounts.set(accountKey, account);
    return user;
  }

  async createAuthSession(record: AuthSessionRecord): Promise<AuthSessionRecord> {
    this.authSessions.set(record.id, record);
    return record;
  }

  async getAuthUserBySession(input: { sessionId: string; now: Date }): Promise<AuthUserRecord | null> {
    const session = this.authSessions.get(input.sessionId);
    if (!session || session.expiresAt <= input.now) return null;
    return this.authUsers.get(session.userId) ?? null;
  }

  async getAuthUser(id: string): Promise<AuthUserRecord | null> {
    return this.authUsers.get(id) ?? null;
  }

  async deleteAuthSession(sessionId: string): Promise<void> {
    this.authSessions.delete(sessionId);
  }

  async listAuthUsers(input: { query?: string } = {}): Promise<AuthUserRecord[]> {
    const query = input.query?.trim().toLowerCase();
    return [...this.authUsers.values()]
      .filter((user) => {
        if (!query) return true;
        return (
          user.username.toLowerCase().includes(query) ||
          user.displayName?.toLowerCase().includes(query) ||
          user.id.toLowerCase() === query
        );
      })
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async updateAuthUserRole(input: { userId: string; role: AuthUserRecord['role']; updatedAt: Date }) {
    return this.withOperationLock(`user-write:${input.userId}`, () => this.updateAuthUserRoleUnlocked(input));
  }

  private async updateAuthUserRoleUnlocked(input: { userId: string; role: AuthUserRecord['role']; updatedAt: Date }) {
    const user = this.authUsers.get(input.userId);
    if (!user) return null;
    if (
      user.role === 'admin' &&
      input.role !== 'admin' &&
      ![...this.authUsers.values()].some((candidate) => candidate.id !== user.id && candidate.role === 'admin')
    ) {
      throw new StoreConflictError('last_admin', 'Cannot demote the final administrator');
    }
    const updated = { ...user, role: input.role, updatedAt: input.updatedAt };
    this.authUsers.set(input.userId, updated);
    return updated;
  }

  private setSession(id: string, session: SessionRecord): void {
    this.sessions.set(id, cloneSession(session));
  }

  async createSession(record: CreateSessionRecord): Promise<SessionRecord> {
    if (this.sessions.has(record.id)) {
      throw new Error(`Session already exists: ${record.id}`);
    }
    this.assertValidSessionOwner(record);

    const session = withSessionDefaults(record);
    this.setSession(record.id, session);
    return cloneSession(session);
  }

  async createSessionWithFirstMessage(
    input: CreateSessionWithFirstMessageInput,
  ): Promise<CreateSessionWithFirstMessageResult> {
    validateParentChildLimit(input, (parentSessionId) => this.sessions.has(parentSessionId));
    this.assertValidSessionOwner(input.session);
    const parent = input.parentChildLimit ? this.sessions.get(input.parentChildLimit.parentSessionId) : undefined;
    const existing = this.sessions.get(input.session.id);
    if (existing) {
      if (
        input.parentChildLimit &&
        (existing.parentSessionId !== input.parentChildLimit.parentSessionId ||
          (existing.visibility === 'private' &&
            (parent?.visibility !== 'private' || parent.ownerUserId !== existing.ownerUserId)))
      ) {
        throw new StoreConflictError('not_found', 'Spawned session not found');
      }
      const message = this.messages.get(input.session.id)?.[0];
      if (!message) throw new Error(`First message does not exist for session: ${input.session.id}`);
      return { session: cloneSession(existing), message, events: [], created: false };
    }

    if (input.parentChildLimit) {
      if (
        (input.session.visibility ?? 'tenant') !== parent!.visibility ||
        (input.session.ownerUserId ?? null) !== (parent!.ownerUserId ?? null)
      ) {
        throw new StoreConflictError('not_found', 'Parent session access changed while spawning child');
      }
      const childCount = [...this.sessions.values()].filter(
        (session) =>
          session.parentSessionId === input.parentChildLimit!.parentSessionId && session.status !== 'archived',
      ).length;
      if (childCount >= input.parentChildLimit.maxNonArchivedChildren) {
        throw new Error(
          `Cannot spawn more than ${input.parentChildLimit.maxNonArchivedChildren} non-archived child sessions`,
        );
      }
    }

    const session = withSessionDefaults(input.session);
    const message: MessageRecord = {
      ...input.message,
      sessionId: session.id,
      sequence: 1,
      status: 'pending',
      steering: input.message.steering ?? false,
    };
    this.setSession(session.id, session);
    this.messages.set(session.id, [message]);

    const events = [
      await this.appendEvent({ ...input.sessionCreatedEvent, sessionId: session.id, sequence: 1 }),
      await this.appendEvent({
        ...input.messageCreatedEvent,
        sessionId: session.id,
        messageId: message.id,
        sequence: 2,
      }),
    ];
    if (input.parentSpawnedEvent) events.push(await this.appendEventWithNextSequence(input.parentSpawnedEvent));
    return { session: cloneSession(session), message, events, created: true };
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(id);
    return session ? cloneSession(session) : null;
  }

  async withAgentSessionLease<T>(actingSessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.withOperationLock(`agent-session:${actingSessionId}`, operation);
  }

  async withUserWriteLease<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    return this.withOperationLock(`user-write:${userId}`, async () => {
      const user = this.authUsers.get(userId);
      if (!user || (user.role !== 'member' && user.role !== 'admin')) {
        throw new StoreConflictError('not_found', 'User write access is required');
      }
      return operation();
    });
  }

  async withPrivateSessionWriteLease<T>(userId: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.withOperationLock(`user-write:${userId}`, async () => {
      const user = this.authUsers.get(userId);
      const session = this.sessions.get(sessionId);
      if (
        !user ||
        (user.role !== 'member' && user.role !== 'admin') ||
        !session ||
        session.visibility !== 'private' ||
        session.ownerUserId !== userId
      ) {
        throw new StoreConflictError('not_found', 'Private session not found');
      }
      return operation();
    });
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.visibility !== 'private')
      .sort(compareSessionsNewestFirst)
      .map(cloneSession);
  }

  async listSessionsForAgent(input: AgentSessionListOptions): Promise<SessionRecord[]> {
    const acting = this.sessions.get(input.actingSessionId);
    return [...this.sessions.values()]
      .filter((session) => Boolean(acting && agentSessionCanRead(acting, session)))
      .sort(compareSessionsNewestFirst)
      .filter((session) => sessionMatchesAgentScope(session, input))
      .filter((session) => !input.status || session.status === input.status)
      .slice(0, input.limit)
      .map(cloneSession);
  }

  async listChildSessions(input: ChildSessionListOptions): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.parentSessionId === input.parentSessionId)
      .sort(compareSessionsNewestFirst)
      .map(cloneSession)
      .slice(0, input.limit);
  }

  async listSessionsWithLatestSandbox(provider: string, options: SessionListOptions): Promise<SessionWithSandboxPage> {
    const matchingSessions = [...this.sessions.values()]
      .filter((session) => (options.archived ? session.status === 'archived' : session.status !== 'archived'))
      .filter((session) => sessionMatchesListFilters(session, options, this.messages, this.sessionStars));
    const sessions = matchingSessions
      .filter((session) => !options.parentSessionId || session.parentSessionId === options.parentSessionId)
      .filter((session) => !options.cursor || isBeforeSessionCursor(session, options.cursor))
      .sort(compareSessionsNewestFirst);
    const page = sessions.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: await Promise.all(
        page.map(async (session) => ({
          session: cloneSession(session),
          sandbox: await this.getLatestSandboxForSession(session.id, provider),
          directChildCount: matchingSessions.filter((child) => child.parentSessionId === session.id).length,
        })),
      ),
      nextCursor:
        sessions.length > options.limit && last
          ? structuredClone({ lastActivityAt: last.lastActivityAt, createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async searchSessions(provider: string, options: SessionSearchOptions): Promise<SessionSearchPage> {
    const query = options.query.trim().toLowerCase();
    if (!query) return { items: [], nextCursor: null };
    const terms = query.split(/\s+/).filter(Boolean);
    const matches = [...this.sessions.values()]
      .filter((session) => sessionMatchesListFilters(session, options, this.messages, this.sessionStars))
      .map((session) => ({
        session,
        match: bestMemorySearchMatch(session, terms, this.memorySearchDocuments(session)),
      }))
      .filter((item): item is { session: SessionRecord; match: MemorySearchMatch } => item.match !== null)
      .sort((a, b) => b.match.score - a.match.score || compareSessionsNewestFirst(a.session, b.session));
    const offset = options.cursor ?? 0;
    const page = matches.slice(offset, offset + options.limit);
    return {
      items: await Promise.all(
        page.map(async ({ session, match }) => ({
          item: {
            session: cloneSession(session),
            sandbox: await this.getLatestSandboxForSession(session.id, provider),
          },
          snippet: match.snippet,
          matchKind: match.kind,
          score: match.score,
        })),
      ),
      nextCursor: matches.length > offset + options.limit ? offset + options.limit : null,
    };
  }

  async listSessionTags(options: { limit: number; visibleToUserId?: string }): Promise<SessionTagSummary[]> {
    const counts = new Map<string, number>();
    for (const session of this.sessions.values()) {
      if (!sessionVisibleToUser(session, options.visibleToUserId)) continue;
      for (const tag of session.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, sessionCount]) => ({ tag, sessionCount }))
      .sort((left, right) => right.sessionCount - left.sessionCount || compareStringAsc(left.tag, right.tag))
      .slice(0, options.limit);
  }

  async starSession(input: { sessionId: string; userId: string; now: Date }): Promise<void> {
    const starred = this.sessionStars.get(input.userId) ?? new Set<string>();
    starred.add(input.sessionId);
    this.sessionStars.set(input.userId, starred);
  }

  async unstarSession(input: { sessionId: string; userId: string }): Promise<void> {
    this.sessionStars.get(input.userId)?.delete(input.sessionId);
  }

  async listStarredSessionIds(input: { userId: string; sessionIds: string[] }): Promise<Set<string>> {
    const starred = this.sessionStars.get(input.userId) ?? new Set<string>();
    return new Set(input.sessionIds.filter((sessionId) => starred.has(sessionId)));
  }

  async getSearchIndexCursor(): Promise<number> {
    return this.searchIndexCursor;
  }

  async setSearchIndexCursor(lastEventId: number): Promise<void> {
    this.searchIndexCursor = lastEventId;
  }

  async upsertSessionSearchDocs(docs: SessionSearchDocInput[]): Promise<void> {
    for (const doc of docs) this.sessionSearchDocs.set(sessionSearchDocKey(doc), doc);
  }

  async updateSession(record: SessionRecord): Promise<SessionRecord> {
    return this.updateSessionSync(record);
  }

  private updateSessionSync(record: SessionRecord): SessionRecord {
    const existing = this.sessions.get(record.id);
    if (!existing) {
      throw new Error(`Session does not exist: ${record.id}`);
    }

    const updated = cloneSession({
      ...record,
      visibility: existing.visibility ?? 'tenant',
      ...(existing.ownerUserId ? { ownerUserId: existing.ownerUserId } : {}),
    });
    if (!existing.ownerUserId) delete updated.ownerUserId;
    this.setSession(record.id, updated);
    return cloneSession(updated);
  }

  private assertValidSessionOwner(record: CreateSessionRecord): void {
    if (record.visibility === 'private' && !record.ownerUserId) {
      throw new Error('Private sessions require an owner');
    }
    if (record.ownerUserId && !this.authUsers.has(record.ownerUserId)) {
      throw new Error('Session owner does not exist');
    }
  }

  async updateSessionContext(input: SessionContextUpdateInput): Promise<SessionRecord> {
    const existing = this.sessions.get(input.id);
    if (!existing) throw new Error(`Session does not exist: ${input.id}`);
    if (existing.status === 'archived') {
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    }
    const session: SessionRecord = { ...existing, updatedAt: input.updatedAt };
    if (input.context !== undefined) session.context = structuredClone(input.context);
    else delete session.context;
    this.setSession(input.id, session);
    return cloneSession(session);
  }

  async updateSessionWithEvent(
    record: SessionRecord,
    event: NormalizedEvent,
    options?: { preserveTags?: boolean },
  ): Promise<{ session: SessionRecord; event: EventRecord }> {
    const current = this.sessions.get(record.id);
    const newerActivity = current && current.lastActivityAt > record.lastActivityAt;
    const next: SessionRecord = { ...record };
    if (newerActivity) {
      next.status = current.status;
      next.lastActivityAt = current.lastActivityAt;
      if (current.context !== undefined) next.context = current.context;
      else delete next.context;
    }
    if (options?.preserveTags) next.tags = current?.tags ?? record.tags;
    const session = this.updateSessionSync(next);
    return { session: cloneSession(session), event: this.appendEventWithNextSequenceSync(event) };
  }

  async updateSessionMetadataWithEvent(
    input: SessionMetadataUpdateInput,
  ): Promise<{ session: SessionRecord; event: EventRecord }> {
    if (input.promoteToTenant) {
      return this.withOperationLock(`agent-session:${input.id}`, () =>
        this.updateSessionMetadataWithEventUnlocked(input),
      );
    }
    return this.updateSessionMetadataWithEventUnlocked(input);
  }

  private async updateSessionMetadataWithEventUnlocked(
    input: SessionMetadataUpdateInput,
  ): Promise<{ session: SessionRecord; event: EventRecord }> {
    const existing = this.sessions.get(input.id);
    if (!existing) throw new Error(`Session does not exist: ${input.id}`);
    if (input.requireNonArchived && existing.status === 'archived') {
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    }

    if (input.promoteToTenant) {
      if (existing.visibility !== 'private') {
        throw new StoreConflictError('not_found', 'Private session not found');
      }
      const promoted = { ...existing, visibility: 'tenant' as const, updatedAt: input.updatedAt };
      this.setSession(existing.id, promoted);
      const event = this.appendEventWithNextSequenceSync({
        sessionId: existing.id,
        type: 'session_visibility_changed',
        payload: { visibility: 'tenant' },
        createdAt: input.updatedAt,
      });
      return { session: cloneSession(promoted), event };
    }

    const session: SessionRecord = { ...existing, updatedAt: input.updatedAt };
    if (input.title !== undefined) session.title = input.title;
    if (input.tags !== undefined) session.tags = input.tags;
    this.setSession(input.id, session);

    const event = this.appendEventWithNextSequenceSync({
      sessionId: session.id,
      type: 'session_updated',
      payload: { title: session.title ?? null, ...(input.tags !== undefined ? { tags: session.tags } : {}) },
      createdAt: input.updatedAt,
    });
    return { session: cloneSession(session), event };
  }

  private async withOperationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.operationLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operationLocks.get(key) === queued) this.operationLocks.delete(key);
    }
  }

  async updateSessionTitleIfCurrent(
    input: SessionTitleUpdateInput,
  ): Promise<{ session: SessionRecord; event: EventRecord } | null> {
    const run = this.runs.get(input.runId);
    const validActiveRun =
      run?.status === 'running' &&
      run.leaseOwner === input.leaseOwner &&
      Boolean(run.leaseExpiresAt && run.leaseExpiresAt > input.now);
    if (
      !run ||
      run.sessionId !== input.id ||
      (!validActiveRun && run.status !== 'completed' && run.status !== 'failed')
    ) {
      return null;
    }
    const existing = this.sessions.get(input.id);
    if (!existing || existing.status === 'archived' || existing.title !== input.expectedTitle) return null;
    const session = { ...existing, title: input.title, updatedAt: input.updatedAt };
    this.setSession(input.id, session);
    const event = this.appendEventWithNextSequenceSync({
      sessionId: session.id,
      type: 'session_updated',
      payload: {
        title: session.title,
      },
      createdAt: input.updatedAt,
    });
    return { session: cloneSession(session), event };
  }

  async archiveSession(input: { sessionId: string; archivedAt: Date }): Promise<{
    session: SessionRecord;
    cancelledMessages: MessageRecord[];
    events: EventRecord[];
  }> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    if (existing.status === 'archived') return { session: cloneSession(existing), cancelledMessages: [], events: [] };

    const sessionMessages = this.messages.get(input.sessionId) ?? [];
    for (const followUp of this.scheduledFollowUps.values()) {
      if (followUp.sessionId === input.sessionId && followUp.status === 'active') {
        this.scheduledFollowUps.set(followUp.id, {
          ...followUp,
          status: 'cancelled',
          nextDueAt: undefined,
          schedulerLockOwner: undefined,
          schedulerLockedUntil: undefined,
          cancelledAt: input.archivedAt,
          updatedAt: input.archivedAt,
        });
      }
    }
    const cancelledMessages: MessageRecord[] = [];
    for (const message of sessionMessages) {
      if (message.status !== 'pending') continue;
      const cancelled: MessageRecord = { ...message, status: 'cancelled' };
      sessionMessages[sessionMessages.indexOf(message)] = cancelled;
      cancelledMessages.push(cancelled);
    }

    const session = {
      ...existing,
      status: 'archived' as const,
      updatedAt: input.archivedAt,
      lastActivityAt: input.archivedAt,
    };
    this.setSession(input.sessionId, session);
    const events: EventRecord[] = [];
    for (const followUp of this.scheduledFollowUps.values()) {
      if (followUp.sessionId === input.sessionId && followUp.cancelledAt?.getTime() === input.archivedAt.getTime()) {
        events.push(
          this.appendEventWithNextSequenceSync({
            sessionId: input.sessionId,
            type: 'scheduled_follow_up_cancelled',
            payload: { followUpId: followUp.id },
            createdAt: input.archivedAt,
          }),
        );
      }
    }
    for (const message of cancelledMessages) {
      events.push(
        this.appendEventWithNextSequenceSync({
          sessionId: session.id,
          messageId: message.id,
          type: 'message_cancelled',
          payload: { sequence: message.sequence, reason: 'session_archived' },
          createdAt: input.archivedAt,
        }),
      );
    }
    events.push(
      this.appendEventWithNextSequenceSync({
        sessionId: session.id,
        type: 'session_archived',
        payload: {},
        createdAt: input.archivedAt,
      }),
    );
    return { session: cloneSession(session), cancelledMessages, events };
  }

  async unarchiveSession(input: { sessionId: string; unarchivedAt: Date }): Promise<{
    session: SessionRecord;
    events: EventRecord[];
  }> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    if (existing.status !== 'archived') return { session: cloneSession(existing), events: [] };
    const session: SessionRecord = {
      ...existing,
      status: 'idle',
      updatedAt: input.unarchivedAt,
      lastActivityAt: input.unarchivedAt,
    };
    this.setSession(input.sessionId, session);
    const event = this.appendEventWithNextSequenceSync({
      sessionId: session.id,
      type: 'session_unarchived',
      payload: {},
      createdAt: input.unarchivedAt,
    });
    return { session: cloneSession(session), events: [event] };
  }

  async updateSessionForRun(input: {
    id: string;
    context: Record<string, unknown>;
    updatedAt: Date;
    runId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<SessionRecord | null> {
    const run = this.runs.get(input.runId);
    if (
      !run ||
      run.sessionId !== input.id ||
      (run.status !== 'running' && run.status !== 'cancelling') ||
      run.leaseOwner !== input.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= input.now
    ) {
      return null;
    }
    const existing = this.sessions.get(input.id);
    if (!existing) throw new Error(`Session does not exist: ${input.id}`);
    if (existing.status === 'archived') return null;
    const updated = { ...existing, context: structuredClone(input.context), updatedAt: input.updatedAt };
    this.setSession(input.id, updated);
    return cloneSession(updated);
  }

  async pauseSessionQueue(input: { sessionId: string; pausedAt: Date }): Promise<SessionRecord> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    if (existing.status === 'archived') {
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    }
    const updated = {
      ...existing,
      queuePausedAt: input.pausedAt,
      updatedAt: input.pausedAt,
      lastActivityAt: input.pausedAt,
    };
    this.setSession(input.sessionId, updated);
    return cloneSession(updated);
  }

  async resumeSessionQueue(input: { sessionId: string }): Promise<SessionRecord> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    if (existing.status === 'archived') {
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    }
    const now = new Date();
    const { queuePausedAt: _queuePausedAt, ...updated } = { ...existing, updatedAt: now, lastActivityAt: now };
    this.setSession(input.sessionId, updated);
    return cloneSession(updated);
  }

  async createSkill(record: CreateSkillRecord): Promise<SkillRecord> {
    return this.skillStore.createSkill(record);
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    return this.skillStore.getSkill(id);
  }

  async listSkillRevisions(skillId: string): Promise<SkillRevisionRecord[]> {
    return this.skillStore.listSkillRevisions(skillId);
  }

  async updateSkill(input: UpdateSkillRecord): Promise<SkillRecord> {
    return this.skillStore.updateSkill(input);
  }

  async archiveSkill(input: { skillId: string; archivedAt: Date }): Promise<SkillRecord | null> {
    return this.skillStore.archiveSkill(input);
  }

  async restoreSkill(input: { skillId: string; updatedAt: Date }): Promise<SkillRecord | null> {
    return this.skillStore.restoreSkill(input);
  }

  async listSkills(input: { userId?: string }): Promise<SkillRecord[]> {
    return this.skillStore.listSkills(input);
  }

  async listSkillInvocationCandidates(input: { userId?: string }): Promise<SkillRunCandidate[]> {
    return this.skillStore.listSkillInvocationCandidates(input);
  }

  async listSkillsForRun(input: {
    userId?: string;
    invokedNames?: string[];
    invokedRevisions?: SkillRevisionSelection[];
  }): Promise<SkillRunCandidate[]> {
    return this.skillStore.listSkillsForRun(input);
  }

  async createAutomation(record: CreateAutomationRecord): Promise<AutomationRecord> {
    if (this.automations.has(record.id)) throw new Error(`Automation already exists: ${record.id}`);
    this.assertAutomationEnvironmentAvailable(record.environmentId);
    this.automations.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async getAutomation(id: string): Promise<AutomationRecord | null> {
    return this.automations.get(id) ?? null;
  }

  async listAutomations(): Promise<AutomationRecord[]> {
    return [...this.automations.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async updateAutomation(input: UpdateAutomationRecord): Promise<AutomationRecord> {
    const existing = this.automations.get(input.id);
    if (!existing) throw new Error(`Automation does not exist: ${input.id}`);
    if (existing.archivedAt) {
      throw new StoreConflictError('automation_archived', 'Restore this automation before editing it');
    }
    this.assertAutomationEnvironmentAvailable(
      input.environmentId === undefined ? existing.environmentId : (input.environmentId ?? undefined),
    );
    const updated: AutomationRecord = {
      ...existing,
      updatedAt: input.updatedAt,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.scheduleCron !== undefined ? { scheduleCron: input.scheduleCron } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    if (input.context !== undefined) {
      if (input.context) updated.context = input.context;
      else delete updated.context;
    }
    if (input.environmentId !== undefined) {
      if (input.environmentId) updated.environmentId = input.environmentId;
      else delete updated.environmentId;
    }
    if (input.environmentRevisionPolicy !== undefined) {
      if (input.environmentRevisionPolicy) updated.environmentRevisionPolicy = input.environmentRevisionPolicy;
      else delete updated.environmentRevisionPolicy;
    }
    if (input.environmentRevisionId !== undefined) {
      if (input.environmentRevisionId) updated.environmentRevisionId = input.environmentRevisionId;
      else delete updated.environmentRevisionId;
    }
    if (input.nextInvocationAt !== undefined && input.nextInvocationAt !== null)
      updated.nextInvocationAt = input.nextInvocationAt;
    else if (input.nextInvocationAt === null) delete updated.nextInvocationAt;
    this.automations.set(input.id, updated);
    return updated;
  }

  async createEnvironment(record: CreateEnvironmentRecord): Promise<EnvironmentWithDetailsRecord> {
    if (this.environments.has(record.environment.id))
      throw new Error(`Environment already exists: ${record.environment.id}`);
    this.assertEnvironmentNameAvailable(record.environment.name);
    const created = this.environmentWithDetails(record);
    this.environments.set(created.id, created);
    this.environmentRevisions.set(record.revision.id, cloneEnvironmentRevision(record.revision));
    this.environmentActivity.set(created.id, record.activities.map(cloneEnvironmentActivity));
    return created;
  }

  async getEnvironment(id: string): Promise<EnvironmentWithDetailsRecord | null> {
    return cloneEnvironment(this.environments.get(id)) ?? null;
  }

  async listEnvironments(): Promise<EnvironmentWithDetailsRecord[]> {
    return [...this.environments.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((environment) => cloneEnvironment(environment)!);
  }

  async getEnvironmentRevision(id: string): Promise<EnvironmentRevisionRecord | null> {
    const revision = this.environmentRevisions.get(id);
    return revision ? cloneEnvironmentRevision(revision) : null;
  }

  async listEnvironmentRevisions(environmentId: string): Promise<EnvironmentRevisionRecord[]> {
    return [...this.environmentRevisions.values()]
      .filter((revision) => revision.environmentId === environmentId)
      .sort((left, right) => right.revisionNumber - left.revisionNumber)
      .map(cloneEnvironmentRevision);
  }

  async listEnvironmentActivity(environmentId: string): Promise<EnvironmentActivityRecord[]> {
    return (this.environmentActivity.get(environmentId) ?? [])
      .slice()
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(cloneEnvironmentActivity);
  }

  async updateEnvironment(record: UpdateEnvironmentRecord): Promise<EnvironmentWithDetailsRecord> {
    const existing = this.environments.get(record.environment.id);
    if (!existing) throw new Error(`Environment does not exist: ${record.environment.id}`);
    if (existing.archivedAt) {
      throw new StoreConflictError('environment_archived', 'Restore this environment before editing it');
    }
    if (existing.updatedAt.getTime() !== record.expectedUpdatedAt.getTime()) {
      throw new StoreConflictError('environment_update_conflict', 'Environment changed while it was being edited');
    }
    if (!existing.archivedAt && !record.environment.archivedAt && existing.name !== record.environment.name) {
      this.assertEnvironmentNameAvailable(record.environment.name, record.environment.id);
    }
    const updated = this.environmentWithDetails(record);
    this.environments.set(updated.id, updated);
    if (record.revision) this.environmentRevisions.set(record.revision.id, cloneEnvironmentRevision(record.revision));
    this.appendEnvironmentActivity(updated.id, record.activities);
    return cloneEnvironment(updated)!;
  }

  async archiveEnvironment(input: {
    environmentId: string;
    archivedAt: Date;
    activity: EnvironmentActivityRecord;
  }): Promise<EnvironmentWithDetailsRecord | null> {
    const existing = this.environments.get(input.environmentId);
    if (!existing) return null;
    if (existing.archivedAt) return cloneEnvironment(existing)!;
    const conflicts = [...this.automations.values()].filter(
      (automation) => automation.environmentId === input.environmentId && !automation.archivedAt,
    );
    if (conflicts.length) {
      throw new StoreConflictError('environment_automation_conflict', 'Environment is used by active automations', {
        automations: conflicts.map(automationConflictDetail),
      });
    }
    const archived: EnvironmentWithDetailsRecord = {
      ...existing,
      archivedAt: existing.archivedAt ?? input.archivedAt,
      updatedAt: input.archivedAt,
    };
    this.environments.set(input.environmentId, archived);
    this.appendEnvironmentActivity(input.environmentId, [
      { ...input.activity, revisionId: existing.currentRevisionId },
    ]);
    return cloneEnvironment(archived)!;
  }

  async unarchiveEnvironment(input: {
    environmentId: string;
    updatedAt: Date;
    activity: EnvironmentActivityRecord;
  }): Promise<EnvironmentWithDetailsRecord | null> {
    const existing = this.environments.get(input.environmentId);
    if (!existing) return null;
    if (!existing.archivedAt) return cloneEnvironment(existing)!;
    this.assertEnvironmentNameAvailable(existing.name, existing.id);
    const { archivedAt: _archivedAt, ...withoutArchive } = existing;
    const unarchived: EnvironmentWithDetailsRecord = {
      ...withoutArchive,
      updatedAt: input.updatedAt,
    };
    this.environments.set(input.environmentId, unarchived);
    this.appendEnvironmentActivity(input.environmentId, [
      { ...input.activity, revisionId: existing.currentRevisionId },
    ]);
    return cloneEnvironment(unarchived)!;
  }

  async archiveAutomation(input: { automationId: string; archivedAt: Date }): Promise<AutomationRecord | null> {
    const automation = this.automations.get(input.automationId);
    if (!automation) return null;
    if (
      [...this.automationInvocations.values()].some(
        (invocation) => invocation.automationId === input.automationId && invocation.status === 'creating',
      )
    ) {
      throw new StoreConflictError('automation_invocation_active', 'Wait for the active invocation before archiving');
    }
    const { schedulerLockOwner: _lockOwner, schedulerLockedUntil: _lockedUntil, ...withoutLock } = automation;
    const archived = {
      ...withoutLock,
      enabled: false,
      archivedAt: automation.archivedAt ?? input.archivedAt,
      updatedAt: input.archivedAt,
    };
    this.automations.set(input.automationId, archived);
    return archived;
  }

  async unarchiveAutomation(input: { automationId: string; updatedAt: Date }): Promise<AutomationRecord | null> {
    const automation = this.automations.get(input.automationId);
    if (!automation) return null;
    this.assertAutomationEnvironmentAvailable(automation.environmentId);
    const {
      archivedAt: _archivedAt,
      schedulerLockOwner: _lockOwner,
      schedulerLockedUntil: _lockedUntil,
      ...withoutArchiveAndLock
    } = automation;
    const unarchived = {
      ...withoutArchiveAndLock,
      enabled: false,
      updatedAt: input.updatedAt,
    };
    this.automations.set(input.automationId, unarchived);
    return unarchived;
  }

  async claimAutomation(input: {
    automationId: string;
    now: Date;
    lockOwner: string;
    lockedUntil: Date;
  }): Promise<AutomationRecord | null> {
    const automation = this.automations.get(input.automationId);
    if (!automation) return null;
    if (automation.archivedAt) return null;
    if (automation.schedulerLockedUntil && automation.schedulerLockedUntil > input.now) return null;
    const locked: AutomationRecord = {
      ...automation,
      schedulerLockOwner: input.lockOwner,
      schedulerLockedUntil: input.lockedUntil,
    };
    this.automations.set(automation.id, locked);
    return locked;
  }

  async releaseAutomationClaim(input: { automationId: string; lockOwner: string }): Promise<AutomationRecord | null> {
    const automation = this.automations.get(input.automationId);
    if (!automation || automation.schedulerLockOwner !== input.lockOwner) return null;
    const { schedulerLockOwner: _lockOwner, schedulerLockedUntil: _lockedUntil, ...withoutLock } = automation;
    const updated = { ...withoutLock };
    this.automations.set(input.automationId, updated);
    return updated;
  }

  async claimNextDueScheduledAutomation(input: {
    now: Date;
    lockOwner: string;
    lockedUntil: Date;
  }): Promise<AutomationRecord | null> {
    const automation = [...this.automations.values()]
      .filter((candidate) => candidate.kind === 'scheduled')
      .filter((candidate) => candidate.enabled)
      .filter((candidate) => !candidate.archivedAt)
      .filter((candidate) => candidate.nextInvocationAt && candidate.nextInvocationAt <= input.now)
      .filter((candidate) => !candidate.schedulerLockedUntil || candidate.schedulerLockedUntil <= input.now)
      .sort(
        (a, b) =>
          (a.nextInvocationAt?.getTime() ?? 0) - (b.nextInvocationAt?.getTime() ?? 0) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
    if (!automation) return null;

    const locked: AutomationRecord = {
      ...automation,
      schedulerLockOwner: input.lockOwner,
      schedulerLockedUntil: input.lockedUntil,
    };
    this.automations.set(automation.id, locked);
    return locked;
  }

  async completeScheduledAutomationClaim(input: {
    automationId: string;
    lockOwner: string;
    claimedScheduleCron: string;
    nextInvocationAt: Date;
  }): Promise<AutomationRecord | null> {
    const automation = this.automations.get(input.automationId);
    if (
      !automation ||
      automation.schedulerLockOwner !== input.lockOwner ||
      automation.scheduleCron !== input.claimedScheduleCron
    ) {
      return null;
    }
    const { schedulerLockOwner: _lockOwner, schedulerLockedUntil: _lockedUntil, ...withoutLock } = automation;
    const updated: AutomationRecord = {
      ...withoutLock,
      nextInvocationAt: input.nextInvocationAt,
    };
    this.automations.set(input.automationId, updated);
    return updated;
  }

  async createAutomationInvocation(record: CreateAutomationInvocationRecord): Promise<AutomationInvocationRecord> {
    const automation = this.automations.get(record.automationId);
    if (!automation) throw new Error(`Automation does not exist: ${record.automationId}`);
    if (automation.archivedAt) {
      throw new StoreConflictError('automation_archived', 'Restore this automation before invoking it');
    }
    if (this.automationInvocations.has(record.id)) {
      throw new Error(`Automation invocation already exists: ${record.id}`);
    }
    const duplicateScheduled = [...this.automationInvocations.values()].some(
      (candidate) =>
        candidate.automationId === record.automationId &&
        candidate.trigger === 'scheduled' &&
        record.trigger === 'scheduled' &&
        candidate.scheduledAt?.getTime() === record.scheduledAt?.getTime(),
    );
    if (duplicateScheduled) throw new Error(`Scheduled automation invocation already exists: ${record.automationId}`);
    this.automationInvocations.set(record.id, record);
    return record;
  }

  async updateAutomationInvocation(record: AutomationInvocationRecord): Promise<AutomationInvocationRecord> {
    if (!this.automationInvocations.has(record.id)) {
      throw new Error(`Automation invocation does not exist: ${record.id}`);
    }
    this.automationInvocations.set(record.id, record);
    return record;
  }

  async getAutomationInvocationBySchedule(input: {
    automationId: string;
    scheduledAt: Date;
  }): Promise<AutomationInvocationRecord | null> {
    return (
      [...this.automationInvocations.values()].find(
        (invocation) =>
          invocation.automationId === input.automationId &&
          invocation.trigger === 'scheduled' &&
          invocation.scheduledAt?.getTime() === input.scheduledAt.getTime(),
      ) ?? null
    );
  }

  async getBlockingAutomationSession(automationId: string): Promise<SessionRecord | null> {
    const invocation = [...this.automationInvocations.values()]
      .filter((candidate) => candidate.automationId === automationId)
      .filter((candidate) => candidate.status === 'created' && candidate.sessionId)
      .sort(compareAutomationInvocationsNewestFirst)
      .find((candidate) => {
        const session = this.sessions.get(candidate.sessionId!);
        return session?.status === 'queued' || session?.status === 'active';
      });
    const session = invocation?.sessionId ? this.sessions.get(invocation.sessionId) : undefined;
    return session ? cloneSession(session) : null;
  }

  async listAutomationInvocations(
    automationId: string,
    options: ListAutomationInvocationsOptions = {},
  ): Promise<AutomationInvocationRecord[]> {
    const invocations = [...this.automationInvocations.values()]
      .filter((invocation) => invocation.automationId === automationId)
      .filter((invocation) => !options.before || isBeforeAutomationInvocationCursor(invocation, options.before))
      .sort(compareAutomationInvocationsNewestFirst);
    return options.limit === undefined ? invocations : invocations.slice(0, options.limit);
  }

  async nextMessageSequence(sessionId: string): Promise<number> {
    return (this.messages.get(sessionId)?.length ?? 0) + 1;
  }

  async createMessage(record: CreateMessageRecord): Promise<MessageRecord> {
    const session = this.sessions.get(record.sessionId);
    if (!session) throw new Error(`Session does not exist: ${record.sessionId}`);
    if (session.status === 'archived' && record.status === 'pending') {
      throw new StoreConflictError('session_archived', 'Cannot enqueue messages to an archived session');
    }
    const sessionMessages = this.messages.get(record.sessionId) ?? [];
    const message: MessageRecord = { ...record, steering: record.steering ?? false };
    sessionMessages.push(message);
    this.messages.set(record.sessionId, sessionMessages);

    if (record.status === 'pending') {
      this.setSession(record.sessionId, {
        ...session,
        status: session.status === 'active' ? 'active' : 'queued',
        updatedAt: record.createdAt,
        lastActivityAt: record.createdAt,
      });
    }

    return message;
  }

  async getMessages(sessionId: string): Promise<MessageRecord[]> {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async getMessagesByIds(messageIds: string[]): Promise<MessageRecord[]> {
    if (!messageIds.length) return [];
    const requestedIds = new Set(messageIds);
    const matchingMessages: MessageRecord[] = [];
    for (const messages of this.messages.values()) {
      for (const message of messages) {
        if (requestedIds.has(message.id)) matchingMessages.push(message);
      }
    }
    return matchingMessages;
  }

  async getMessage(input: { sessionId: string; messageId: string }): Promise<MessageRecord | null> {
    return this.messages.get(input.sessionId)?.find((message) => message.id === input.messageId) ?? null;
  }

  async getSessionMessageSummary(sessionId: string): Promise<SessionMessageSummary> {
    const messages = await this.getMessages(sessionId);
    return { count: messages.length, lastMessage: messages[messages.length - 1] ?? null };
  }

  async getSessionTranscript(input: SessionTranscriptOptions): Promise<SessionTranscriptPage> {
    const candidates = (this.messages.get(input.sessionId) ?? [])
      .filter((message) => input.beforeSequence === undefined || message.sequence < input.beforeSequence)
      .sort((left, right) => right.sequence - left.sequence);
    const page = candidates.slice(0, input.limit);
    const entries = page.map((message) => ({
      message,
      finalResponse: latestFinalResponseForMessage(this.events.get(input.sessionId) ?? [], message.id),
    }));
    return {
      entries,
      hasMore: candidates.length > input.limit,
      ...(candidates.length > input.limit && entries.length
        ? { nextBeforeSequence: entries[entries.length - 1]!.message.sequence }
        : {}),
    };
  }

  async updatePendingMessage(input: {
    sessionId: string;
    messageId: string;
    prompt?: string;
    steering?: boolean;
    context?: Record<string, unknown>;
  }): Promise<MessageRecord | null> {
    const sessionMessages = this.messages.get(input.sessionId) ?? [];
    const message = sessionMessages.find(
      (candidate) =>
        candidate.id === input.messageId && candidate.status === 'pending' && !candidate.scheduledFollowUpId,
    );
    if (!message) return null;
    const updated = {
      ...message,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.steering !== undefined ? { steering: input.steering } : {}),
      ...(input.context !== undefined ? { context: structuredClone(input.context) } : {}),
    };
    sessionMessages[sessionMessages.indexOf(message)] = updated;
    return updated;
  }

  async retryScheduledMessage(input: {
    sessionId: string;
    messageId: string;
    retriedAt: Date;
  }): Promise<MessageRecord | null> {
    const messages = this.messages.get(input.sessionId) ?? [];
    const message = messages.find((candidate) => candidate.id === input.messageId);
    if (!message?.scheduledFollowUpId || message.status !== 'failed') return null;
    const session = this.sessions.get(input.sessionId);
    if (session?.status === 'archived') return null;
    if (
      messages.some(
        (candidate) =>
          candidate.scheduledFollowUpId === message.scheduledFollowUpId &&
          candidate.id !== message.id &&
          ['pending', 'processing', 'cancelling'].includes(candidate.status),
      )
    )
      return null;
    message.status = 'pending';
    if (session) {
      this.setSession(input.sessionId, {
        ...session,
        status: session.status === 'active' ? 'active' : 'queued',
        updatedAt: input.retriedAt,
        lastActivityAt: input.retriedAt,
      });
    }
    return structuredClone(message);
  }

  async cancelPendingMessage(input: {
    sessionId: string;
    messageId: string;
    cancelledAt: Date;
  }): Promise<MessageRecord | null> {
    const sessionMessages = this.messages.get(input.sessionId) ?? [];
    const message = sessionMessages.find(
      (candidate) => candidate.id === input.messageId && candidate.status === 'pending',
    );
    if (!message) return null;
    const updated: MessageRecord = { ...message, status: 'cancelled' };
    sessionMessages[sessionMessages.indexOf(message)] = updated;
    this.refreshQueuedSessionStatus(input.sessionId, input.cancelledAt);
    return updated;
  }

  async claimNextPendingMessage(input: {
    runId: string;
    runnerType: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessage | null> {
    const batch = await this.claimNextPendingMessageBatch(input);
    return batch ? { message: batch.messages[0]!, run: batch.run } : null;
  }

  async persistActiveRunExecutionSignature(input: {
    runId: string;
    leaseOwner: string;
    now: Date;
    signature: Record<string, unknown>;
  }): Promise<RunRecord | null> {
    const run = this.runs.get(input.runId);
    if (
      !run ||
      run.status !== 'running' ||
      run.leaseOwner !== input.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= input.now
    )
      return null;
    const updated = {
      ...run,
      metadata: { ...run.metadata, executionSignature: structuredClone(executionSignature(input.signature)) },
    };
    this.runs.set(run.id, updated);
    return updated;
  }

  async claimPendingSteeringMessages(input: {
    runId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<MessageRecord[]> {
    const run = this.runs.get(input.runId);
    if (
      !run ||
      run.status !== 'running' ||
      run.leaseOwner !== input.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= input.now
    )
      return [];
    const activeSignature = run.metadata.executionSignature;
    if (!isJsonObject(activeSignature)) return [];
    const sessionMessages = this.messages.get(run.sessionId) ?? [];
    const messages = sessionMessages
      .filter(
        (message) =>
          message.status === 'pending' &&
          message.steering &&
          deterministicJsonEqual(executionSignature(message.context ?? {}), activeSignature),
      )
      .sort((a, b) => a.sequence - b.sequence)
      .map((message) => ({ ...message, status: 'processing' as const }));
    if (!messages.length) return [];
    for (const message of messages) {
      const index = sessionMessages.findIndex((candidate) => candidate.id === message.id);
      sessionMessages[index] = message;
    }
    const existingIds = Array.isArray(run.metadata.messageIds) ? run.metadata.messageIds : [run.messageId];
    const existingSequences = Array.isArray(run.metadata.sequences) ? run.metadata.sequences : [];
    this.runs.set(run.id, {
      ...run,
      metadata: {
        ...run.metadata,
        messageIds: [...new Set([...existingIds, ...messages.map((message) => message.id)])],
        sequences: [...new Set([...existingSequences, ...messages.map((message) => message.sequence)])],
      },
    });
    return messages;
  }

  async claimNextPendingMessageBatch(input: {
    runId: string;
    runnerType: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessageBatch | null> {
    for (const [sessionId, sessionMessages] of this.messages) {
      const currentSession = this.sessions.get(sessionId);
      if (currentSession?.queuePausedAt || currentSession?.status === 'archived') continue;
      if (this.hasActiveRun(sessionId)) continue;

      const pendingMessages = sessionMessages
        .filter((candidate) => candidate.status === 'pending')
        .sort((a, b) => a.sequence - b.sequence);
      if (!pendingMessages.length) continue;

      const firstGeneratedId = pendingMessages.findIndex((message) => message.scheduledFollowUpId);
      const claimable = pendingMessages[0]!.scheduledFollowUpId
        ? pendingMessages.slice(0, 1)
        : firstGeneratedId < 0
          ? pendingMessages
          : pendingMessages.slice(0, firstGeneratedId);
      const processingMessages = claimable.map((message) => ({ ...message, status: 'processing' as const }));
      for (const message of processingMessages) {
        const existing = sessionMessages.find((candidate) => candidate.id === message.id)!;
        sessionMessages[sessionMessages.indexOf(existing)] = message;
      }

      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session does not exist: ${sessionId}`);
      this.setSession(sessionId, { ...session, status: 'active', updatedAt: input.now, lastActivityAt: input.now });

      const run: RunRecord = {
        id: input.runId,
        sessionId,
        messageId: processingMessages[0]!.id,
        status: 'running',
        runnerType: input.runnerType,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        heartbeatAt: input.now,
        attempt: 1,
        startedAt: input.now,
        metadata: {
          messageIds: processingMessages.map((message) => message.id),
          sequences: processingMessages.map((message) => message.sequence),
        },
      };
      this.runs.set(run.id, run);
      return { messages: processingMessages, run };
    }

    return null;
  }

  async completeRun(input: { runId: string; leaseOwner: string; completedAt: Date }): Promise<ClaimedMessage | null> {
    const batch = await this.completeRunBatch(input);
    return batch ? { message: batch.messages[0]!, run: batch.run } : null;
  }

  async beginRunCompletion(input: {
    runId: string;
    leaseOwner: string;
    now: Date;
    result: Record<string, unknown>;
  }): Promise<ClaimedMessageBatch | null> {
    const run = this.runs.get(input.runId);
    if (
      !run ||
      run.status !== 'running' ||
      run.leaseOwner !== input.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= input.now
    )
      return null;
    const completingRun: RunRecord = {
      ...run,
      status: 'completing',
      heartbeatAt: input.now,
      metadata: { ...run.metadata, runnerResult: input.result },
    };
    this.runs.set(run.id, completingRun);
    const messages = getRunMessageIds(run).map((id) => {
      const message = (this.messages.get(run.sessionId) ?? []).find((candidate) => candidate.id === id);
      if (!message) throw new Error(`Message does not exist: ${id}`);
      return message;
    });
    return { run: completingRun, messages };
  }

  async claimExpiredRunCompletion(input: {
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessageBatch | null> {
    const run = [...this.runs.values()]
      .filter(
        (candidate) =>
          candidate.status === 'completing' && !!candidate.leaseExpiresAt && candidate.leaseExpiresAt <= input.now,
      )
      .sort((a, b) => a.leaseExpiresAt!.getTime() - b.leaseExpiresAt!.getTime())[0];
    if (!run) return null;
    const claimed = {
      ...run,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      heartbeatAt: input.now,
    };
    this.runs.set(run.id, claimed);
    const messages = getRunMessageIds(run).map((id) => {
      const message = (this.messages.get(run.sessionId) ?? []).find((candidate) => candidate.id === id);
      if (!message) throw new Error(`Message does not exist: ${id}`);
      return message;
    });
    return { run: claimed, messages };
  }

  async completeRunBatch(input: {
    runId: string;
    leaseOwner: string;
    completedAt: Date;
  }): Promise<ClaimedMessageBatch | null> {
    return this.finishRun(input.runId, input.leaseOwner, input.completedAt, 'completed');
  }

  async renewRunLease(input: {
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    heartbeatAt: Date;
  }): Promise<RunRecord | null> {
    const run = this.runs.get(input.runId);
    if (
      !run ||
      (run.status !== 'running' && run.status !== 'completing' && run.status !== 'cancelling') ||
      run.leaseOwner !== input.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= input.heartbeatAt
    ) {
      return null;
    }

    const renewed: RunRecord = {
      ...run,
      leaseExpiresAt: input.leaseExpiresAt,
      heartbeatAt: input.heartbeatAt,
    };
    this.runs.set(input.runId, renewed);
    return renewed;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async getLatestRunForSession(sessionId: string): Promise<RunRecord | null> {
    return (
      Array.from(this.runs.values())
        .filter((run) => run.sessionId === sessionId)
        .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0] ?? null
    );
  }

  async recoverStaleRuns(input: { now: Date; limit: number }): Promise<RecoveredRun[]> {
    const recovered: RecoveredRun[] = [];
    let selected = 0;

    for (const run of this.runs.values()) {
      if (selected >= input.limit) break;
      if (run.status !== 'running' && run.status !== 'starting' && run.status !== 'cancelling') continue;
      if (!run.leaseExpiresAt || run.leaseExpiresAt > input.now) continue;
      selected += 1;

      const sessionMessages = this.messages.get(run.sessionId) ?? [];
      const pendingMessages: MessageRecord[] = [];
      for (const messageId of getRunMessageIds(run)) {
        const message = sessionMessages.find(
          (candidate) =>
            candidate.id === messageId && (candidate.status === 'processing' || candidate.status === 'cancelling'),
        );
        if (!message) continue;
        const pendingMessage: MessageRecord = { ...message, status: 'pending' };
        sessionMessages[sessionMessages.indexOf(message)] = pendingMessage;
        pendingMessages.push(pendingMessage);
      }

      const { leaseExpiresAt: _leaseExpiresAt, leaseOwner: _leaseOwner, ...runWithoutLease } = run;
      const staleRun: RunRecord = {
        ...runWithoutLease,
        status: 'stale',
        failedAt: input.now,
        heartbeatAt: input.now,
        error: 'Run lease expired',
      };
      this.runs.set(run.id, staleRun);

      const session = this.sessions.get(run.sessionId);
      if (session) {
        this.setSession(run.sessionId, {
          ...session,
          status:
            session.status === 'archived'
              ? 'archived'
              : sessionMessages.some((message) => message.status === 'pending')
                ? 'queued'
                : 'idle',
          updatedAt: input.now,
          lastActivityAt: input.now,
        });
      }

      if (!pendingMessages.length) continue;

      recovered.push({ message: pendingMessages[0]!, messages: pendingMessages, run: staleRun });
    }

    return recovered;
  }

  async failRun(input: {
    runId: string;
    leaseOwner: string;
    failedAt: Date;
    error: string;
  }): Promise<ClaimedMessage | null> {
    const batch = await this.failRunBatch(input);
    return batch ? { message: batch.messages[0]!, run: batch.run } : null;
  }

  async failRunBatch(input: {
    runId: string;
    leaseOwner: string;
    failedAt: Date;
    error: string;
    callbackDelivery?: CreateCallbackDeliveryRecord;
  }): Promise<ClaimedMessageBatch | null> {
    if (input.callbackDelivery) this.assertCallbackDeliveryIdempotent(input.callbackDelivery);
    const claimed = this.finishRun(input.runId, input.leaseOwner, input.failedAt, 'failed');
    if (!claimed) return null;
    this.runs.set(input.runId, { ...claimed.run, error: input.error });
    if (input.callbackDelivery) await this.createCallbackDelivery(input.callbackDelivery);
    return { ...claimed, run: this.runs.get(input.runId)! };
  }

  async requestRunCancellation(input: {
    sessionId: string;
    requestedAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null> {
    const run = [...this.runs.values()].find(
      (candidate) =>
        candidate.sessionId === input.sessionId &&
        (candidate.status === 'running' || candidate.status === 'starting' || candidate.status === 'cancelling'),
    );
    if (!run) return null;

    const sessionMessages = this.messages.get(run.sessionId) ?? [];
    const messages = getRunMessageIds(run).map((messageId) => {
      const message = sessionMessages.find((candidate) => candidate.id === messageId);
      if (!message) throw new Error(`Message does not exist: ${messageId}`);
      const cancellingMessage: MessageRecord = {
        ...message,
        status: message.status === 'cancelled' ? 'cancelled' : 'cancelling',
      };
      sessionMessages[sessionMessages.indexOf(message)] = cancellingMessage;
      return cancellingMessage;
    });
    const cancellingRun: RunRecord = {
      ...run,
      status: 'cancelling',
      heartbeatAt: input.requestedAt,
      error: input.error,
    };
    this.runs.set(run.id, cancellingRun);
    const session = this.sessions.get(input.sessionId);
    if (session) {
      this.setSession(input.sessionId, {
        ...session,
        status: session.status === 'archived' ? 'archived' : 'active',
        updatedAt: input.requestedAt,
        lastActivityAt: input.requestedAt,
      });
    }
    return { messages, run: cancellingRun };
  }

  async finalizeRunCancellation(input: {
    runId: string;
    leaseOwner: string;
    cancelledAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null> {
    const claimed = this.finishRun(input.runId, input.leaseOwner, input.cancelledAt, 'cancelled');
    if (!claimed) return null;
    const cancelledRun: RunRecord = { ...claimed.run, error: input.error };
    this.runs.set(input.runId, cancelledRun);
    return { ...claimed, run: cancelledRun };
  }

  async getActiveSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null> {
    return (await this.listActiveSandboxes(sessionId, provider))[0] ?? null;
  }

  async getLatestSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null> {
    return this.latestSandbox((sandbox) => sandbox.sessionId === sessionId && sandbox.provider === provider);
  }

  async getLatestSandboxForSession(sessionId: string, preferredProvider?: string): Promise<SandboxRecord | null> {
    return this.latestSandbox(
      (sandbox) => sandbox.sessionId === sessionId,
      preferredProvider ? (sandbox) => sandbox.provider === preferredProvider : undefined,
    );
  }

  private latestSandbox(
    predicate: (sandbox: SandboxRecord) => boolean,
    prefer?: (sandbox: SandboxRecord) => boolean,
  ): SandboxRecord | null {
    return (
      Array.from(this.sandboxes.values())
        .filter(predicate)
        .sort(
          (a, b) =>
            Number(Boolean(prefer?.(b))) - Number(Boolean(prefer?.(a))) ||
            b.updatedAt.getTime() - a.updatedAt.getTime(),
        )[0] ?? null
    );
  }

  async listActiveSandboxes(sessionId: string, provider: string): Promise<SandboxRecord[]> {
    return Array.from(this.sandboxes.values())
      .filter((sandbox) => sandbox.sessionId === sessionId && sandbox.provider === provider)
      .filter(isActiveSandbox)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async listIdleSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]> {
    return Array.from(this.sandboxes.values())
      .filter((sandbox) => sandbox.provider === input.provider)
      .filter(isActiveSandbox)
      .filter((sandbox) => sandbox.updatedAt <= input.idleBefore)
      .filter((sandbox) => !sandbox.keepaliveUntil || sandbox.keepaliveUntil <= new Date())
      .filter((sandbox) => !isSessionBusy(this.sessions.get(sandbox.sessionId)?.status))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, input.limit);
  }

  async listStoppableSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]> {
    return Array.from(this.sandboxes.values())
      .filter((sandbox) => sandbox.provider === input.provider)
      .filter((sandbox) => !sandbox.destroyedAt && sandbox.status === 'ready')
      .filter((sandbox) => sandbox.updatedAt <= input.idleBefore)
      .filter((sandbox) => !sandbox.keepaliveUntil || sandbox.keepaliveUntil <= new Date())
      .filter((sandbox) => !isSessionBusy(this.sessions.get(sandbox.sessionId)?.status))
      .filter(
        (sandbox) => !(this.messages.get(sandbox.sessionId) ?? []).some((message) => message.status === 'pending'),
      )
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, input.limit);
  }

  async createSandbox(record: CreateSandboxRecord): Promise<SandboxRecord> {
    if (this.sandboxes.has(record.id)) throw new Error(`Sandbox already exists: ${record.id}`);
    this.sandboxes.set(record.id, record);
    return record;
  }

  async createSandboxWithSecrets(record: CreateSandboxRecord, secrets: SandboxSecrets): Promise<SandboxRecord> {
    const created = await this.createSandbox(record);
    try {
      await this.setSandboxSecrets(created.id, secrets);
      return created;
    } catch (error) {
      this.sandboxes.delete(created.id);
      this.sandboxSecrets.delete(created.id);
      throw error;
    }
  }

  async updateSandbox(record: SandboxRecord): Promise<SandboxRecord> {
    if (!this.sandboxes.has(record.id)) throw new Error(`Sandbox does not exist: ${record.id}`);
    this.sandboxes.set(record.id, record);
    return record;
  }

  async getSandboxSecrets(sandboxId: string): Promise<SandboxSecrets> {
    return { ...(this.sandboxSecrets.get(sandboxId) ?? {}) };
  }

  async setSandboxSecrets(sandboxId: string, secrets: SandboxSecrets): Promise<void> {
    if (!this.sandboxes.has(sandboxId)) throw new Error(`Sandbox does not exist: ${sandboxId}`);
    this.sandboxSecrets.set(sandboxId, { ...secrets });
  }

  async createArtifact(record: CreateArtifactRecord): Promise<ArtifactRecord> {
    const existing = this.artifacts.get(record.id);
    if (existing) {
      const { createdAt: _existingAt, ...existingValue } = existing;
      const { createdAt: _recordAt, ...recordValue } = record;
      if (JSON.stringify(existingValue) !== JSON.stringify(recordValue))
        throw new Error(`Artifact idempotency mismatch: ${record.id}`);
      return existing;
    }
    this.artifacts.set(record.id, record);
    return record;
  }

  async getArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    return Array.from(this.artifacts.values()).filter((artifact) => artifact.sessionId === sessionId);
  }

  async createExternalResource(record: CreateExternalResourceRecord): Promise<ExternalResourceRecord> {
    if (this.externalResources.has(record.id)) throw new Error(`External resource already exists: ${record.id}`);
    this.externalResources.set(record.id, record);
    return record;
  }

  async getExternalResources(sessionId: string): Promise<ExternalResourceRecord[]> {
    return Array.from(this.externalResources.values()).filter((resource) => resource.sessionId === sessionId);
  }

  async createCallbackDelivery(record: CreateCallbackDeliveryRecord): Promise<CallbackDeliveryRecord> {
    this.assertCallbackDeliveryIdempotent(record);
    const existing = this.callbacks.get(record.id);
    if (existing) {
      return existing;
    }
    const delivery: CallbackDeliveryRecord = {
      ...record,
      status: 'pending',
      attempts: 0,
      maxAttempts: record.maxAttempts ?? 5,
    };
    this.callbacks.set(delivery.id, delivery);
    return delivery;
  }

  private assertCallbackDeliveryIdempotent(record: CreateCallbackDeliveryRecord): void {
    const existing = this.callbacks.get(record.id);
    if (
      existing &&
      (existing.sessionId !== record.sessionId ||
        existing.runId !== record.runId ||
        existing.messageId !== record.messageId ||
        existing.targetType !== record.targetType ||
        existing.eventType !== record.eventType ||
        JSON.stringify(existing.target) !== JSON.stringify(record.target) ||
        JSON.stringify(existing.payload) !== JSON.stringify(record.payload))
    )
      throw new Error(`Callback idempotency mismatch: ${record.id}`);
  }

  async listCallbackDeliveries(input: { sessionId: string; messageId?: string }): Promise<CallbackDeliveryRecord[]> {
    return Array.from(this.callbacks.values())
      .filter((delivery) => delivery.sessionId === input.sessionId)
      .filter((delivery) => !input.messageId || delivery.messageId === input.messageId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async claimDueCallbackDeliveries(input: { now: Date; limit: number }): Promise<CallbackDeliveryRecord[]> {
    const staleSendingBefore = new Date(input.now.getTime() - staleCallbackSendingMs);
    const due = Array.from(this.callbacks.values())
      .filter((delivery) => delivery.status === 'pending' || isStaleSendingCallback(delivery, staleSendingBefore))
      .filter((delivery) => !delivery.nextAttemptAt || delivery.nextAttemptAt <= input.now)
      .filter((delivery) => delivery.attempts < delivery.maxAttempts)
      .sort(
        (a, b) =>
          (a.nextAttemptAt?.getTime() ?? a.createdAt.getTime()) - (b.nextAttemptAt?.getTime() ?? b.createdAt.getTime()),
      )
      .slice(0, input.limit);
    const claimed = due.map((delivery) => {
      const updated: CallbackDeliveryRecord = {
        ...delivery,
        status: 'sending',
        attempts: delivery.attempts + 1,
        lastAttemptAt: input.now,
        updatedAt: input.now,
        claimToken: randomUUID(),
      };
      this.callbacks.set(delivery.id, updated);
      return updated;
    });
    return claimed;
  }

  async markCallbackDeliverySent(input: {
    id: string;
    claimToken: string;
    deliveredAt: Date;
  }): Promise<CallbackDeliveryRecord> {
    const existing = this.requireCallback(input.id);
    if (existing.claimToken !== input.claimToken) throw new Error(`Stale callback delivery claim: ${input.id}`);
    const {
      nextAttemptAt: _nextAttemptAt,
      lastError: _lastError,
      claimToken: _claimToken,
      ...withoutRetryState
    } = existing;
    const updated: CallbackDeliveryRecord = {
      ...withoutRetryState,
      status: 'sent',
      deliveredAt: input.deliveredAt,
      updatedAt: input.deliveredAt,
    };
    this.callbacks.set(input.id, updated);
    return updated;
  }

  async markCallbackDeliveryFailed(input: {
    id: string;
    claimToken: string;
    failedAt: Date;
    error: string;
    terminal: boolean;
    nextAttemptAt?: Date;
  }): Promise<CallbackDeliveryRecord> {
    const existing = this.requireCallback(input.id);
    if (existing.claimToken !== input.claimToken) throw new Error(`Stale callback delivery claim: ${input.id}`);
    const { nextAttemptAt: _nextAttemptAt, claimToken: _claimToken, ...withoutNextAttempt } = existing;
    const updated: CallbackDeliveryRecord = {
      ...withoutNextAttempt,
      status: input.terminal ? 'failed' : 'pending',
      lastError: input.error,
      updatedAt: input.failedAt,
    };
    if (input.nextAttemptAt) updated.nextAttemptAt = input.nextAttemptAt;
    this.callbacks.set(input.id, updated);
    return updated;
  }

  async requestCallbackReplay(input: {
    sessionId: string;
    deliveryId: string;
    requestedAt: Date;
  }): Promise<CallbackDeliveryRecord | null> {
    const existing = this.callbacks.get(input.deliveryId);
    if (!existing || existing.sessionId !== input.sessionId || existing.status !== 'failed') return null;
    const { deliveredAt: _deliveredAt, nextAttemptAt: _nextAttemptAt, ...withoutTerminalFields } = existing;
    const updated: CallbackDeliveryRecord = {
      ...withoutTerminalFields,
      status: 'pending',
      maxAttempts: Math.max(existing.maxAttempts, existing.attempts + 1),
      updatedAt: input.requestedAt,
      nextAttemptAt: input.requestedAt,
    };
    this.callbacks.set(input.deliveryId, updated);
    return updated;
  }

  async nextEventSequence(sessionId: string): Promise<number> {
    return this.nextEventSequenceSync(sessionId);
  }

  private nextEventSequenceSync(sessionId: string): number {
    const maxSequence = Math.max(0, ...(this.events.get(sessionId) ?? []).map((event) => event.sequence));
    return maxSequence + 1;
  }

  async appendEvent(event: NormalizedEvent & { sequence: number }): Promise<EventRecord> {
    return this.appendEventSync(event);
  }

  private appendEventSync(event: NormalizedEvent & { sequence: number }): EventRecord {
    const record = { ...event, id: this.nextEventId++ };
    const sessionEvents = this.events.get(event.sessionId) ?? [];
    sessionEvents.push(record);
    this.events.set(event.sessionId, sessionEvents);
    return record;
  }

  async appendEventWithNextSequence(event: NormalizedEvent): Promise<EventRecord> {
    return this.appendEventWithNextSequenceSync(event);
  }

  private appendEventWithNextSequenceSync(event: NormalizedEvent): EventRecord {
    return this.appendEventSync({ ...event, sequence: this.nextEventSequenceSync(event.sessionId) });
  }

  async appendEventWithNextSequenceForRun(
    event: Omit<NormalizedEvent, 'runId'> & { runId: string },
    guard: { runId: string; leaseOwner: string; now: Date },
  ): Promise<EventRecord | null> {
    const run = this.runs.get(guard.runId);
    if (
      !run ||
      event.runId !== guard.runId ||
      (run.status !== 'running' && run.status !== 'completing' && run.status !== 'cancelling') ||
      run.leaseOwner !== guard.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= guard.now
    ) {
      return null;
    }
    return this.appendEventWithNextSequence(event as NormalizedEvent);
  }

  async getEvents(sessionId: string, afterSequence = 0, limit?: number): Promise<EventRecord[]> {
    const events = (this.events.get(sessionId) ?? []).filter((event) => event.sequence > afterSequence);
    return limit === undefined ? events : events.slice(0, limit);
  }

  async getLatestEventByType(sessionId: string, type: EventRecord['type']): Promise<EventRecord | null> {
    return (
      (this.events.get(sessionId) ?? [])
        .filter((event) => event.type === type)
        .sort((a, b) => b.sequence - a.sequence)[0] ?? null
    );
  }

  async listEvents(afterId = 0, limit?: number): Promise<EventRecord[]> {
    const events = [...this.events.values()]
      .flat()
      .filter((event) => event.id > afterId)
      .sort((left, right) => left.id - right.id);
    return limit === undefined ? events : events.slice(0, limit);
  }

  async compactFinalizedAgentTextDeltas(input: EventDeltaCompactionInput): Promise<number> {
    let remaining = input.limit;
    let compacted = 0;
    const finalizedBeforeMs = input.finalizedBefore.getTime();

    for (const [sessionId, events] of this.events) {
      if (remaining <= 0) break;

      const finalizedMessageSequences = new Map<string, number>();
      for (const event of events) {
        if (
          event.type !== 'agent_response_final' ||
          !event.messageId ||
          event.createdAt.getTime() >= finalizedBeforeMs ||
          typeof event.payload.text !== 'string'
        ) {
          continue;
        }
        finalizedMessageSequences.set(
          event.messageId,
          Math.max(finalizedMessageSequences.get(event.messageId) ?? 0, event.sequence),
        );
      }
      if (!finalizedMessageSequences.size) continue;

      const kept: EventRecord[] = [];
      for (const event of events) {
        const finalSequence = event.messageId ? finalizedMessageSequences.get(event.messageId) : undefined;
        if (
          remaining > 0 &&
          event.type === 'agent_text_delta' &&
          event.createdAt.getTime() < finalizedBeforeMs &&
          finalSequence !== undefined &&
          event.sequence < finalSequence
        ) {
          remaining -= 1;
          compacted += 1;
          continue;
        }
        kept.push(event);
      }
      this.events.set(sessionId, kept);
    }

    return compacted;
  }

  async createWebhookSource(record: CreateWebhookSourceRecord): Promise<WebhookSourceRecord> {
    this.webhookSources.set(record.key, record);
    return record;
  }

  async getWebhookSource(key: string): Promise<WebhookSourceRecord | null> {
    return this.webhookSources.get(key) ?? null;
  }

  async getExternalThread(source: string, externalId: string): Promise<ExternalThreadRecord | null> {
    return this.externalThreads.get(externalThreadKey(source, externalId)) ?? null;
  }

  async getExternalThreadsForSession(sessionId: string): Promise<ExternalThreadRecord[]> {
    return [...this.externalThreads.values()]
      .filter((thread) => thread.sessionId === sessionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((thread) => structuredClone(thread));
  }

  async createScheduledFollowUp(input: CreateScheduledFollowUpRecordInput): Promise<ScheduledFollowUpMutationResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new StoreConflictError('not_found', 'Session not found');
    if (session.status === 'archived') throw new StoreConflictError('session_archived', 'Session is archived');
    if (input.createdByRunId && input.idempotencyKey) {
      const replay = [...this.scheduledFollowUps.values()].find(
        (item) => item.createdByRunId === input.createdByRunId && item.idempotencyKey === input.idempotencyKey,
      );
      if (replay) return { followUp: structuredClone(replay), events: [], idempotent: true };
    }
    if (
      [...this.scheduledFollowUps.values()].filter(
        (item) => item.sessionId === input.sessionId && item.status === 'active',
      ).length >= 25
    )
      throw new StoreConflictError('scheduled_follow_up_active_limit', 'Session has 25 active scheduled follow-ups');
    if (
      input.createdByRunId &&
      input.maxNewForRun !== undefined &&
      [...this.scheduledFollowUps.values()].filter(
        (item) => item.createdByRunId === input.createdByRunId && item.status === 'active',
      ).length >= input.maxNewForRun
    )
      throw new StoreConflictError(
        'scheduled_follow_up_run_limit',
        `Run has ${input.maxNewForRun} active scheduled follow-ups`,
      );
    const { maxNewForRun: _maxNewForRun, ...record } = input;
    const followUp: ScheduledFollowUpRecord = { ...structuredClone(record), status: 'active', definitionRevision: 1 };
    this.scheduledFollowUps.set(followUp.id, followUp);
    const event = this.appendEventWithNextSequenceSync({
      sessionId: input.sessionId,
      type: 'scheduled_follow_up_created',
      payload: { followUpId: followUp.id, nextDueAt: followUp.nextDueAt?.toISOString() ?? null },
      createdAt: input.createdAt,
    });
    return { followUp: structuredClone(followUp), events: [event] };
  }

  async getScheduledFollowUp(id: string): Promise<ScheduledFollowUpRecord | null> {
    return structuredClone(this.scheduledFollowUps.get(id) ?? null);
  }

  async getScheduledFollowUpByCreatorKey(
    createdByRunId: string,
    idempotencyKey: string,
  ): Promise<ScheduledFollowUpRecord | null> {
    const item = [...this.scheduledFollowUps.values()].find(
      (candidate) => candidate.createdByRunId === createdByRunId && candidate.idempotencyKey === idempotencyKey,
    );
    return item ? structuredClone(item) : null;
  }

  async listScheduledFollowUps(input: {
    sessionId: string;
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<ScheduledFollowUpRecord[]> {
    return [...this.scheduledFollowUps.values()]
      .filter(
        (item) =>
          item.sessionId === input.sessionId &&
          (!input.before ||
            item.createdAt < input.before.createdAt ||
            (item.createdAt.getTime() === input.before.createdAt.getTime() && item.id < input.before.id)),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, input.limit)
      .map((item) => structuredClone(item));
  }

  async updateScheduledFollowUp(input: UpdateScheduledFollowUpRecordInput): Promise<ScheduledFollowUpMutationResult> {
    const session = this.sessions.get(input.sessionId);
    const old = this.scheduledFollowUps.get(input.id);
    if (!session || !old || old.sessionId !== input.sessionId)
      throw new StoreConflictError('not_found', 'Scheduled follow-up not found');
    if (session.status === 'archived') throw new StoreConflictError('session_archived', 'Session is archived');
    if (old.status !== 'active' || old.definitionRevision !== input.expectedRevision)
      throw new StoreConflictError('stale_revision', 'Scheduled follow-up changed');
    const consumed = (this.scheduledFollowUpOccurrences.get(old.id) ?? []).length;
    if (input.normalizedSchedule.kind === 'recurring' && input.normalizedSchedule.maxOccurrences <= consumed)
      throw new StoreConflictError('stale_revision', 'Updated maximum is not greater than consumed occurrences');
    const latestScheduledAt = (this.scheduledFollowUpOccurrences.get(old.id) ?? []).at(-1)?.scheduledAt;
    const cutover = new Date(Math.max(input.updatedAt.getTime(), latestScheduledAt?.getTime() ?? 0));
    const nextDueAt = nextOccurrence(input.normalizedSchedule, cutover);
    if (!nextDueAt) throw new StoreConflictError('stale_revision', 'Updated schedule has no future occurrence');
    const next = {
      ...old,
      ...definedFields(input),
      contextOverrides: input.contextOverrides === null ? undefined : (input.contextOverrides ?? old.contextOverrides),
      nextDueAt,
      definitionRevision: old.definitionRevision + 1,
      schedulerLockOwner: undefined,
      schedulerLockedUntil: undefined,
    } as ScheduledFollowUpRecord;
    this.scheduledFollowUps.set(next.id, next);
    const event = this.appendEventWithNextSequenceSync({
      sessionId: next.sessionId,
      type: 'scheduled_follow_up_updated',
      payload: {
        followUpId: next.id,
        revision: next.definitionRevision,
        nextDueAt: next.nextDueAt?.toISOString() ?? null,
      },
      createdAt: input.updatedAt,
    });
    return { followUp: structuredClone(next), events: [event] };
  }

  async cancelScheduledFollowUp(input: {
    id: string;
    sessionId: string;
    expectedRevision: number;
    now: Date;
  }): Promise<ScheduledFollowUpMutationResult> {
    const old = this.scheduledFollowUps.get(input.id);
    if (!old || old.sessionId !== input.sessionId)
      throw new StoreConflictError('not_found', 'Scheduled follow-up not found');
    if (old.status !== 'active') throw new StoreConflictError('stale_revision', 'Scheduled follow-up changed');
    if (old.definitionRevision !== input.expectedRevision)
      throw new StoreConflictError('stale_revision', 'Scheduled follow-up changed');
    const next: ScheduledFollowUpRecord = {
      ...old,
      status: 'cancelled',
      nextDueAt: undefined,
      schedulerLockOwner: undefined,
      schedulerLockedUntil: undefined,
      cancelledAt: input.now,
      updatedAt: input.now,
      definitionRevision: old.definitionRevision + 1,
    };
    this.scheduledFollowUps.set(next.id, next);
    const events: EventRecord[] = [];
    for (const message of this.messages.get(input.sessionId) ?? [])
      if (message.scheduledFollowUpId === input.id && message.status === 'pending') {
        message.status = 'cancelled';
        events.push(
          this.appendEventWithNextSequenceSync({
            sessionId: input.sessionId,
            messageId: message.id,
            type: 'message_cancelled',
            payload: { sequence: message.sequence },
            createdAt: input.now,
          }),
        );
      }
    this.refreshQueuedSessionStatus(input.sessionId, input.now);
    events.push(
      this.appendEventWithNextSequenceSync({
        sessionId: input.sessionId,
        type: 'scheduled_follow_up_cancelled',
        payload: { followUpId: input.id },
        createdAt: input.now,
      }),
    );
    return { followUp: structuredClone(next), events };
  }

  async listScheduledFollowUpOccurrences(input: {
    followUpId: string;
    limit: number;
    before?: ScheduledFollowUpOccurrenceCursor;
  }): Promise<ScheduledFollowUpOccurrenceRecord[]> {
    return (this.scheduledFollowUpOccurrences.get(input.followUpId) ?? [])
      .filter((item) => !input.before || item.occurrenceNumber < input.before.occurrenceNumber)
      .sort((a, b) => b.occurrenceNumber - a.occurrenceNumber)
      .slice(0, input.limit)
      .map((item) => structuredClone(item));
  }

  async claimDueScheduledFollowUp(input: {
    lockOwner: string;
    now: Date;
    lockedUntil: Date;
  }): Promise<ScheduledFollowUpClaim | null> {
    const item = [...this.scheduledFollowUps.values()]
      .filter(
        (f) =>
          f.status === 'active' &&
          f.nextDueAt &&
          f.nextDueAt <= input.now &&
          (!f.schedulerLockedUntil || f.schedulerLockedUntil <= input.now),
      )
      .sort((a, b) => a.nextDueAt!.getTime() - b.nextDueAt!.getTime())[0];
    if (!item) return null;
    item.schedulerLockOwner = input.lockOwner;
    item.schedulerLockedUntil = input.lockedUntil;
    return { followUp: structuredClone(item), claimedRevision: item.definitionRevision };
  }

  async activateDueScheduledFollowUp(input: {
    id: string;
    lockOwner: string;
    claimedRevision: number;
    now: Date;
    resolvedContext: import('./types.js').ScheduledFollowUpResolvedContext;
    externalCallback?: { type: 'slack' | 'github'; target: Record<string, unknown> };
    externalBindingError?: string;
    expectedExternalThreadId?: string | null;
  }): Promise<ScheduledFollowUpActivationResult | null> {
    const f = this.scheduledFollowUps.get(input.id);
    const session = f ? this.sessions.get(f.sessionId) : undefined;
    if (
      !f ||
      !session ||
      f.status !== 'active' ||
      f.definitionRevision !== input.claimedRevision ||
      f.schedulerLockOwner !== input.lockOwner ||
      !f.schedulerLockedUntil ||
      f.schedulerLockedUntil <= input.now
    )
      return null;
    if (session.status === 'archived') {
      f.schedulerLockOwner = undefined;
      f.schedulerLockedUntil = undefined;
      return null;
    }
    const prior = this.scheduledFollowUpOccurrences.get(f.id) ?? [];
    const max = f.scheduleKind === 'once' ? 1 : (f.maxOccurrences ?? 100);
    const due = occurrenceInstantsBetween(
      recordSchedule(f),
      new Date(f.nextDueAt!.getTime() - 1),
      input.now,
      max - prior.length,
    );
    if (!due.length) {
      f.schedulerLockOwner = undefined;
      f.schedulerLockedUntil = undefined;
      return null;
    }
    const events: EventRecord[] = [];
    const made: ScheduledFollowUpOccurrenceRecord[] = [];
    let message: MessageRecord | undefined;
    const { callback: _untrustedCallback, ...sessionContext } = session.context ?? {};
    const currentBindings = [...this.externalThreads.values()].filter((thread) => thread.sessionId === f.sessionId);
    const expectedExternalThreadId = input.expectedExternalThreadId ?? null;
    const bindingChanged =
      currentBindings.length !== (expectedExternalThreadId ? 1 : 0) ||
      (expectedExternalThreadId !== null && currentBindings[0]?.id !== expectedExternalThreadId);
    let environmentChanged = false;
    const sourceSession =
      f.createdBySessionId && f.createdBySessionId !== f.sessionId
        ? this.sessions.get(f.createdBySessionId)
        : undefined;
    if (input.resolvedContext.status === 'valid') {
      const snapshot = input.resolvedContext.overrides.environment as
        | { id?: unknown; revisionId?: unknown }
        | undefined;
      if (typeof snapshot?.id === 'string' && typeof snapshot.revisionId === 'string') {
        const environment = this.environments.get(snapshot.id);
        const revision = this.environmentRevisions.get(snapshot.revisionId);
        environmentChanged = !environment || !!environment.archivedAt || revision?.environmentId !== snapshot.id;
      }
    }
    for (let i = 0; i < due.length; i++) {
      const number = prior.length + made.length + 1,
        scheduledAt = due[i]!;
      const latest = i === due.length - 1;
      let reason: ScheduledFollowUpOccurrenceRecord['reason'] = latest ? undefined : 'missed_during_downtime';
      if (
        latest &&
        (this.messages.get(f.sessionId) ?? []).some(
          (m) => m.scheduledFollowUpId === f.id && ['pending', 'processing', 'cancelling'].includes(m.status),
        )
      )
        reason = 'previous_message_unfinished';
      if (latest && input.externalBindingError) reason = 'external_binding_invalid';
      if (latest && bindingChanged) reason = 'external_binding_invalid';
      if (latest && !reason && environmentChanged) reason = 'resource_unavailable';
      if (latest && !reason && input.resolvedContext.status === 'invalid') reason = input.resolvedContext.reason;
      const occurrenceId = stableUuid(`${f.id}:${number}:${scheduledAt.toISOString()}`),
        messageId = stableUuid(`${occurrenceId}:message`);
      const occurrence: ScheduledFollowUpOccurrenceRecord = {
        id: occurrenceId,
        scheduledFollowUpId: f.id,
        occurrenceNumber: number,
        definitionRevision: f.definitionRevision,
        scheduledAt,
        activatedAt: input.now,
        outcome:
          reason === 'external_binding_invalid' || reason === 'invalid_context' || reason === 'resource_unavailable'
            ? 'pre_message_failed'
            : reason
              ? 'skipped'
              : 'message_created',
        ...(reason ? { reason } : {}),
        ...(reason === 'external_binding_invalid'
          ? { error: input.externalBindingError ?? 'External thread binding changed during activation' }
          : input.resolvedContext.status === 'invalid' && reason === input.resolvedContext.reason
            ? { error: input.resolvedContext.error }
            : environmentChanged && reason === 'resource_unavailable'
              ? { error: 'Environment became unavailable during activation' }
              : {}),
        ...(!reason
          ? {
              messageId,
              effectiveContext: (() => {
                const context = { ...sessionContext };
                if (input.resolvedContext.status === 'valid') {
                  for (const key of input.resolvedContext.clear) delete context[key];
                  Object.assign(context, input.resolvedContext.overrides);
                }
                if (input.externalCallback) context.callback = input.externalCallback.target;
                if (sourceSession) context.sourceSessionId = sourceSession.id;
                return context;
              })(),
            }
          : {}),
      };
      made.push(occurrence);
      if (occurrence.outcome === 'pre_message_failed' && input.externalCallback) {
        const callbackId = stableUuid(`${occurrenceId}:scheduled_follow_up_failed`);
        if (!this.callbacks.has(callbackId)) {
          this.callbacks.set(callbackId, {
            id: callbackId,
            sessionId: f.sessionId,
            targetType: input.externalCallback.type,
            target: structuredClone(input.externalCallback.target),
            status: 'pending',
            eventType: 'scheduled_follow_up_failed',
            payload: {
              event: 'scheduled_follow_up_failed',
              sessionId: f.sessionId,
              scheduledFollowUpId: f.id,
              occurrenceId,
              text: 'This scheduled follow-up could not be started.',
              artifacts: [],
            },
            attempts: 0,
            maxAttempts: 5,
            createdAt: input.now,
            updatedAt: input.now,
            nextAttemptAt: input.now,
          });
        }
      }
      if (!reason) {
        const list = this.messages.get(f.sessionId) ?? [];
        const created: MessageRecord = {
          id: messageId,
          sessionId: f.sessionId,
          sequence: Math.max(0, ...list.map((m) => m.sequence)) + 1,
          status: 'pending',
          prompt: f.prompt,
          steering: false,
          source: 'scheduled_follow_up',
          ...(sourceSession ? { authorName: `Deputy: ${sourceSession.title || sourceSession.id}` } : {}),
          ...(occurrence.effectiveContext ? { context: occurrence.effectiveContext } : {}),
          scheduledFollowUpId: f.id,
          scheduledFollowUpOccurrenceId: occurrenceId,
          createdAt: input.now,
        };
        message = created;
        list.push(created);
        this.messages.set(f.sessionId, list);
        this.refreshQueuedSessionStatus(f.sessionId, input.now);
        events.push(
          this.appendEventWithNextSequenceSync({
            sessionId: f.sessionId,
            messageId,
            type: 'message_created',
            payload: { sequence: created.sequence, source: created.source ?? null },
            createdAt: input.now,
          }),
        );
      }
      events.push(
        this.appendEventWithNextSequenceSync({
          sessionId: f.sessionId,
          messageId: occurrence.messageId,
          type:
            occurrence.outcome === 'message_created'
              ? 'scheduled_follow_up_occurrence_created'
              : occurrence.outcome === 'skipped'
                ? 'scheduled_follow_up_occurrence_skipped'
                : 'scheduled_follow_up_occurrence_failed',
          payload:
            occurrence.outcome === 'message_created'
              ? {
                  followUpId: f.id,
                  occurrenceId,
                  occurrenceNumber: number,
                  scheduledAt: scheduledAt.toISOString(),
                  messageId,
                }
              : {
                  followUpId: f.id,
                  occurrenceId,
                  occurrenceNumber: number,
                  scheduledAt: scheduledAt.toISOString(),
                  reason: reason!,
                },
          createdAt: input.now,
        } as NormalizedEvent),
      );
    }
    this.scheduledFollowUpOccurrences.set(f.id, [...prior, ...made]);
    const next = nextOccurrence(recordSchedule(f), due.at(-1)!);
    f.nextDueAt = next ?? undefined;
    f.schedulerLockOwner = undefined;
    f.schedulerLockedUntil = undefined;
    f.updatedAt = input.now;
    if (!next || prior.length + made.length >= max) {
      f.status = 'completed';
      f.completedAt = input.now;
      f.nextDueAt = undefined;
      events.push(
        this.appendEventWithNextSequenceSync({
          sessionId: f.sessionId,
          type: 'scheduled_follow_up_completed',
          payload: { followUpId: f.id },
          createdAt: input.now,
        }),
      );
    }
    return {
      followUp: structuredClone(f),
      occurrences: structuredClone(made),
      ...(message ? { message: structuredClone(message) } : {}),
      events,
    };
  }

  async createExternalThread(input: {
    id: string;
    source: string;
    externalId: string;
    sessionId: string;
    metadata: Record<string, unknown>;
    now: Date;
  }): Promise<ExternalThreadRecord> {
    const key = externalThreadKey(input.source, input.externalId);
    const existing = this.externalThreads.get(key);
    if (existing) return existing;

    const record: ExternalThreadRecord = {
      id: input.id,
      source: input.source,
      externalId: input.externalId,
      sessionId: input.sessionId,
      metadata: input.metadata,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.externalThreads.set(key, record);
    return record;
  }

  async createIntegrationDelivery(input: {
    id: string;
    source: string;
    dedupeKey: string;
    receivedAt: Date;
    staleReceivedBefore: Date;
    metadata: Record<string, unknown>;
  }): Promise<IntegrationDeliveryRecord | null> {
    const key = deliveryKey(input.source, input.dedupeKey);
    const existing = this.integrationDeliveries.get(key);
    if (existing?.status === 'processed') return null;
    if (existing?.status === 'received') return null;

    const record: IntegrationDeliveryRecord = {
      id: input.id,
      source: input.source,
      dedupeKey: input.dedupeKey,
      status: 'received',
      receivedAt: input.receivedAt,
      metadata: input.metadata,
    };
    this.integrationDeliveries.set(key, record);
    return record;
  }

  async markIntegrationDeliveryProcessed(input: {
    id: string;
    source: string;
    dedupeKey: string;
    processedAt: Date;
  }): Promise<boolean> {
    const key = deliveryKey(input.source, input.dedupeKey);
    const existing = this.integrationDeliveries.get(key);
    if (!existing || existing.id !== input.id || existing.status !== 'received') return false;
    this.integrationDeliveries.set(key, { ...existing, status: 'processed', processedAt: input.processedAt });
    return true;
  }

  async markIntegrationDeliveryFailed(input: {
    id: string;
    source: string;
    dedupeKey: string;
    failedAt: Date;
    error: string;
  }): Promise<boolean> {
    const key = deliveryKey(input.source, input.dedupeKey);
    const existing = this.integrationDeliveries.get(key);
    if (!existing || existing.id !== input.id || existing.status !== 'received') return false;
    this.integrationDeliveries.set(key, {
      ...existing,
      status: 'failed',
      processedAt: input.failedAt,
      error: input.error,
    });
    return true;
  }

  private hasActiveRun(sessionId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId) continue;
      if (
        run.status !== 'running' &&
        run.status !== 'completing' &&
        run.status !== 'starting' &&
        run.status !== 'cancelling'
      )
        continue;
      return true;
    }
    return false;
  }

  private finishRun(
    runId: string,
    leaseOwner: string,
    finishedAt: Date,
    status: 'completed' | 'failed' | 'cancelled',
  ): ClaimedMessageBatch | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const validStatus =
      status === 'cancelled'
        ? run.status === 'cancelling'
        : status === 'completed'
          ? run.status === 'completing'
          : run.status === 'running' || run.status === 'completing';
    if (!validStatus || run.leaseOwner !== leaseOwner) return null;
    if (!run.leaseExpiresAt || run.leaseExpiresAt <= finishedAt) return null;

    const sessionMessages = this.messages.get(run.sessionId) ?? [];
    const messageIds = getRunMessageIds(run);
    const terminalMessages: MessageRecord[] = [];

    for (const messageId of messageIds) {
      const message = sessionMessages.find((candidate) => candidate.id === messageId);
      if (!message) throw new Error(`Message does not exist: ${messageId}`);
      const terminalMessage: MessageRecord = { ...message, status };
      sessionMessages[sessionMessages.indexOf(message)] = terminalMessage;
      terminalMessages.push(terminalMessage);
    }

    const { leaseExpiresAt: _leaseExpiresAt, leaseOwner: _leaseOwner, ...runWithoutLease } = run;
    const terminalRun: RunRecord = { ...runWithoutLease, status, heartbeatAt: finishedAt };
    if (status === 'completed') terminalRun.completedAt = finishedAt;
    if (status === 'failed' || status === 'cancelled') terminalRun.failedAt = finishedAt;
    this.runs.set(runId, terminalRun);

    const session = this.sessions.get(run.sessionId);
    if (!session) throw new Error(`Session does not exist: ${run.sessionId}`);
    const hasPendingMessages = sessionMessages.some((message) => message.status === 'pending');
    this.setSession(run.sessionId, {
      ...session,
      status:
        session.status === 'archived'
          ? 'archived'
          : status === 'failed'
            ? 'failed'
            : hasPendingMessages
              ? 'queued'
              : 'idle',
      updatedAt: finishedAt,
      lastActivityAt: finishedAt,
    });
    const events =
      status === 'completed'
        ? terminalMessages.map((message) => {
            const existing = (this.events.get(run.sessionId) ?? []).find(
              (event) => event.runId === run.id && event.messageId === message.id && event.type === 'message_completed',
            );
            return (
              existing ??
              this.appendEventWithNextSequenceSync({
                sessionId: message.sessionId,
                runId: run.id,
                messageId: message.id,
                type: 'message_completed',
                payload: { sequence: message.sequence },
                createdAt: finishedAt,
              })
            );
          })
        : [];

    return { messages: terminalMessages, run: terminalRun, events };
  }

  private refreshQueuedSessionStatus(sessionId: string, updatedAt: Date): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'archived' || session.status === 'active') return;
    const hasPendingMessages = (this.messages.get(sessionId) ?? []).some((message) => message.status === 'pending');
    this.setSession(sessionId, {
      ...session,
      status: hasPendingMessages ? 'queued' : 'idle',
      updatedAt,
      lastActivityAt: updatedAt,
    });
  }

  private memorySearchDocuments(session: SessionRecord): Array<{ kind: SessionSearchMatchKind; content: string }> {
    return [
      { kind: 'title', content: session.title ?? '' },
      ...(this.messages.get(session.id) ?? []).map((message) => ({ kind: 'prompt' as const, content: message.prompt })),
      ...(this.events.get(session.id) ?? []).flatMap((event) => {
        if (event.type !== 'agent_response_final') return [];
        const payload = event.payload as { text?: unknown };
        return typeof payload.text === 'string' ? [{ kind: 'response' as const, content: payload.text }] : [];
      }),
      ...[...this.sessionSearchDocs.values()]
        .filter((doc) => doc.sessionId === session.id)
        .map((doc) => ({ kind: doc.kind, content: doc.content })),
    ];
  }

  private requireCallback(id: string): CallbackDeliveryRecord {
    const existing = this.callbacks.get(id);
    if (!existing) throw new Error(`Callback delivery does not exist: ${id}`);
    return existing;
  }

  private assertEnvironmentNameAvailable(name: string, exceptEnvironmentId?: string): void {
    const normalized = normalizedResourceName(name);
    const conflict = [...this.environments.values()].find(
      (environment) =>
        environment.id !== exceptEnvironmentId && normalizedResourceName(environment.name) === normalized,
    );
    if (conflict) throw new StoreConflictError('environment_name_exists', 'Environment name already exists');
  }

  private assertAutomationEnvironmentAvailable(environmentId: string | undefined): void {
    if (!environmentId) return;
    const environment = this.environments.get(environmentId);
    if (!environment || environment.archivedAt) {
      throw new StoreConflictError('automation_environment_unavailable', 'Environment is archived or unavailable');
    }
  }

  private environmentWithDetails(
    record: CreateEnvironmentRecord | UpdateEnvironmentRecord,
  ): EnvironmentWithDetailsRecord {
    return {
      ...record.environment,
      repositories: record.repositories
        .map((repository) => ({ ...repository }))
        .sort((left, right) => left.position - right.position),
    };
  }

  private appendEnvironmentActivity(environmentId: string, activity: EnvironmentActivityRecord[]): void {
    const existing = this.environmentActivity.get(environmentId) ?? [];
    this.environmentActivity.set(environmentId, [...existing, ...activity.map(cloneEnvironmentActivity)]);
  }
}

const executionContextKeys = ['repository', 'branch', 'environment', 'model', 'reasoningLevel'] as const;

function executionSignature(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    executionContextKeys.filter((key) => context[key] != null).map((key) => [key, context[key]]),
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deterministicJsonEqual(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!isJsonObject(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function authAccountKey(provider: string, providerAccountId: string): string {
  return `${provider}:${providerAccountId}`;
}

function memoryPage<T>(records: T[], offset: number, limit: number) {
  const items = records.slice(offset, offset + limit);
  const hasMore = offset + items.length < records.length;
  return { items, hasMore, nextCursor: hasMore ? String(offset + items.length) : null };
}

function notepadSnippet(content: string, query: string) {
  const match = content.toLowerCase().indexOf(query.toLowerCase());
  return content.slice(Math.max(0, match - 80), Math.max(0, match - 80) + 240);
}

function automationConflictDetail(automation: AutomationRecord): { id: string; name: string } {
  return { id: automation.id, name: automation.name };
}

function cloneEnvironment(
  environment: EnvironmentWithDetailsRecord | undefined,
): EnvironmentWithDetailsRecord | undefined {
  if (!environment) return undefined;
  return {
    ...environment,
    repositories: environment.repositories.map((repository) => ({ ...repository })),
  };
}

function cloneEnvironmentRevision(revision: EnvironmentRevisionRecord): EnvironmentRevisionRecord {
  return { ...revision, repositories: revision.repositories.map((repository) => ({ ...repository })) };
}

function cloneEnvironmentActivity(activity: EnvironmentActivityRecord): EnvironmentActivityRecord {
  return { ...activity, payload: structuredClone(activity.payload) };
}

function normalizedResourceName(name: string): string {
  return name.trim().toLowerCase();
}

function sessionMatchesListFilters(
  session: SessionRecord,
  options: {
    tags?: string[];
    createdByUserId?: string;
    participantUserId?: string;
    starredByUserId?: string;
    visibleToUserId?: string;
  },
  messages: Map<string, MessageRecord[]>,
  sessionStars: Map<string, Set<string>>,
): boolean {
  if (!sessionVisibleToUser(session, options.visibleToUserId)) return false;
  if (options.tags?.length && !options.tags.every((tag) => session.tags.includes(tag))) return false;
  if (options.createdByUserId && session.createdByUserId !== options.createdByUserId) return false;
  if (
    options.participantUserId &&
    !(messages.get(session.id) ?? []).some((message) => message.authorUserId === options.participantUserId)
  ) {
    return false;
  }
  if (options.starredByUserId && !sessionStars.get(options.starredByUserId)?.has(session.id)) return false;
  return true;
}

function sessionVisibleToUser(session: SessionRecord, userId: string | undefined): boolean {
  return session.visibility !== 'private' || Boolean(userId && session.ownerUserId === userId);
}

function agentSessionCanRead(acting: SessionRecord, target: SessionRecord): boolean {
  return (
    target.visibility !== 'private' ||
    Boolean(acting.visibility === 'private' && acting.ownerUserId && acting.ownerUserId === target.ownerUserId)
  );
}

function compareSessionsNewestFirst(a: SessionRecord, b: SessionRecord): number {
  return (
    b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    compareUuidDesc(a.id, b.id)
  );
}

function compareUuidDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function compareStringAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isBeforeSessionCursor(
  session: SessionRecord,
  cursor: { lastActivityAt: Date; createdAt: Date; id: string },
): boolean {
  return compareSessionsNewestFirst(session, { ...session, ...cursor }) > 0;
}

type MemorySearchMatch = {
  kind: SessionSearchMatchKind;
  score: number;
  snippet: string;
};

function bestMemorySearchMatch(
  session: SessionRecord,
  terms: string[],
  documents: Array<{ kind: SessionSearchMatchKind; content: string }>,
): MemorySearchMatch | null {
  let best: MemorySearchMatch | null = null;
  for (const document of documents) {
    const lower = document.content.toLowerCase();
    const score = terms.reduce((total, term) => total + countOccurrences(lower, term), 0);
    if (score === 0) continue;
    const match = { kind: document.kind, score, snippet: memorySearchSnippet(document.content, terms) };
    if (!best || match.score > best.score || (match.score === best.score && document.kind === 'title')) best = match;
  }
  if (best) return best;
  if (session.title?.toLowerCase().includes(terms.join(' '))) {
    return { kind: 'title', score: 1, snippet: memorySearchSnippet(session.title, terms) };
  }
  return null;
}

function countOccurrences(value: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = value.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function memorySearchSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const index = terms.reduce((best, term) => {
    const match = lower.indexOf(term);
    return match === -1 || (best !== -1 && best < match) ? best : match;
  }, -1);
  if (index === -1) return content.slice(0, 160);
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + 120);
  return `${start > 0 ? '...' : ''}${content.slice(start, end)}${end < content.length ? '...' : ''}`;
}

function sessionSearchDocKey(doc: Pick<SessionSearchDocInput, 'sessionId' | 'kind' | 'sourceId'>): string {
  return `${doc.sessionId}:${doc.kind}:${doc.sourceId}`;
}

function isStaleSendingCallback(delivery: CallbackDeliveryRecord, staleSendingBefore: Date): boolean {
  const lastAttemptAt = delivery.lastAttemptAt;
  return delivery.status === 'sending' && lastAttemptAt !== undefined && lastAttemptAt <= staleSendingBefore;
}

function isActiveSandbox(sandbox: SandboxRecord): boolean {
  return (
    !sandbox.destroyedAt &&
    (sandbox.status === 'ready' || sandbox.status === 'stopped' || sandbox.status === 'unhealthy')
  );
}

function compareAutomationInvocationsNewestFirst(a: AutomationInvocationRecord, b: AutomationInvocationRecord): number {
  const time = b.createdAt.getTime() - a.createdAt.getTime();
  if (time !== 0) return time;
  return compareUuidDesc(a.id, b.id);
}

function isBeforeAutomationInvocationCursor(
  invocation: AutomationInvocationRecord,
  cursor: { createdAt: Date; id: string },
): boolean {
  const time = invocation.createdAt.getTime() - cursor.createdAt.getTime();
  if (time !== 0) return time < 0;
  return invocation.id < cursor.id;
}

function isSessionBusy(status: string | undefined): boolean {
  return status === 'active' || status === 'queued';
}

function getRunMessageIds(run: RunRecord): string[] {
  const messageIds = run.metadata.messageIds;
  if (Array.isArray(messageIds) && messageIds.every((id) => typeof id === 'string')) return messageIds;
  return [run.messageId];
}

function validateParentChildLimit(
  input: CreateSessionWithFirstMessageInput,
  parentExists: (parentSessionId: string) => boolean,
): void {
  if (!input.parentChildLimit) return;
  if (input.session.parentSessionId !== input.parentChildLimit.parentSessionId) {
    throw new Error('Parent child limit must match the session parent');
  }
  if (!parentExists(input.parentChildLimit.parentSessionId)) {
    throw new Error(`Parent session does not exist: ${input.parentChildLimit.parentSessionId}`);
  }
}

function sessionMatchesAgentScope(session: SessionRecord, input: AgentSessionListOptions): boolean {
  if (input.scope === 'children') {
    return session.parentSessionId === input.actingSessionId;
  }
  return true;
}

function latestFinalResponseForMessage(events: EventRecord[], messageId: string): EventRecord | null {
  return (
    events
      .filter((event) => event.type === 'agent_response_final' && event.messageId === messageId)
      .sort((left, right) => right.sequence - left.sequence)[0] ?? null
  );
}

function externalThreadKey(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

function deliveryKey(source: string, dedupeKey: string): string {
  return `${source}:${dedupeKey}`;
}

function definedFields(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([k, v]) => v !== undefined && !['id', 'sessionId', 'expectedRevision'].includes(k)),
  );
}
function recordSchedule(f: ScheduledFollowUpRecord): NormalizedSchedule {
  return f.scheduleKind === 'once'
    ? { kind: 'once', runAt: f.runAt! }
    : {
        kind: 'recurring',
        dtstartLocal: f.dtstartLocal!,
        timezone: f.timezone!,
        rrule: f.rrule!,
        maxOccurrences: f.maxOccurrences!,
        ...(f.endsAt ? { endsAt: f.endsAt } : {}),
      };
}
function stableUuid(value: string): string {
  const h = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  h[12] = '5';
  h[16] = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8).join('')}-${h.slice(8, 12).join('')}-${h.slice(12, 16).join('')}-${h.slice(16, 20).join('')}-${h.slice(20).join('')}`;
}

function withSessionDefaults(record: CreateSessionRecord): SessionRecord {
  return {
    ...record,
    visibility: record.visibility ?? 'tenant',
    spawnDepth: record.spawnDepth ?? 0,
    lastActivityAt: record.lastActivityAt ?? record.updatedAt,
    tags: [...(record.tags ?? [])],
  };
}

function cloneSession(session: SessionRecord): SessionRecord {
  return structuredClone(session);
}
