import { Pool, type PoolClient } from 'pg';
import type { NormalizedEvent } from '../events/types.js';
import { PostgresSkillStore } from './postgres/skills.js';
import { StoreConflictError } from './types.js';
import type {
  AppStore,
  AgentSessionListOptions,
  ArtifactRecord,
  AutomationInvocationRecord,
  AutomationRecord,
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
  ClaimedMessage,
  ClaimedMessageBatch,
  CreateMessageRecord,
  CreateSandboxRecord,
  CreateSessionRecord,
  CreateSessionWithFirstMessageInput,
  CreateSessionWithFirstMessageResult,
  CreateSkillRecord,
  CreateSnippetRecord,
  CreateWebhookSourceRecord,
  EventDeltaCompactionInput,
  EnvironmentWithDetailsRecord,
  EnvironmentActivityRecord,
  EnvironmentRevisionRecord,
  EventRecord,
  ExternalResourceRecord,
  ExternalThreadRecord,
  IntegrationDeliveryRecord,
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
  SessionMessageSummary,
  SessionSearchDocInput,
  SessionSearchMatchKind,
  SessionSearchOptions,
  SessionSearchPage,
  SessionTitleUpdateInput,
  SessionTranscriptOptions,
  SessionTranscriptPage,
  SessionTagSummary,
  SessionWithSandboxPage,
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
} from './types.js';
import { SecretCipher } from './encrypted-secrets.js';
import {
  automationInvocationSelectColumns,
  automationSelectColumns,
  environmentRepositorySelectColumns,
  environmentRevisionSelectColumns,
  environmentActivitySelectColumns,
  environmentSelectColumns,
  getRunMessageIds,
  sessionSelectColumns,
  toArtifact,
  toAutomation,
  toAutomationInvocation,
  toAuthSession,
  toAuthUser,
  toCallbackDelivery,
  toEvent,
  toEnvironment,
  toEnvironmentActivity,
  toEnvironmentRepository,
  toEnvironmentRevision,
  toExternalResource,
  toExternalThread,
  toIntegrationDelivery,
  toMessage,
  toRun,
  toSandbox,
  toSession,
  toSessionWithSandbox,
  toWebhookSource,
  type AutomationInvocationRow,
  type AutomationRow,
  type ArtifactRow,
  type AuthSessionRow,
  type AuthUserRow,
  type CallbackDeliveryRow,
  type EventRow,
  type EnvironmentRepositoryRow,
  type EnvironmentRevisionRow,
  type EnvironmentActivityRow,
  type EnvironmentRow,
  type ExternalResourceRow,
  type ExternalThreadRow,
  type IntegrationDeliveryRow,
  type MessageRow,
  type PgInteger,
  type RunRow,
  type SandboxRow,
  type SessionRow,
  type SessionWithSandboxRow,
  type WebhookSourceRow,
} from './postgres/records.js';

const staleCallbackSendingMs = 15 * 60_000;
const eventNotificationChannel = 'app_events';
const maxSearchDocContentChars = 16 * 1024;
const joinedSessionSelectColumns = sessionSelectColumns
  .split(', ')
  .map((column) => `sessions.${column}`)
  .join(', ');
type SessionSearchRow = SessionWithSandboxRow & {
  snippet: string | null;
  match_kind: SessionSearchMatchKind;
  score: number | string;
};

export type PostgresEventListener = {
  close(): Promise<void>;
};

export class PostgresStore implements AppStore {
  private readonly pool: Pool;
  private readonly skillStore: PostgresSkillStore;
  private readonly secretCipher?: SecretCipher;

  constructor(databaseUrl: string | Pool, options: { sandboxSecretEncryptionKey?: string } = {}) {
    this.pool = typeof databaseUrl === 'string' ? new Pool({ connectionString: databaseUrl }) : databaseUrl;
    this.skillStore = new PostgresSkillStore(this.pool);
    if (options.sandboxSecretEncryptionKey)
      this.secretCipher = new SecretCipher(options.sandboxSecretEncryptionKey, 'sandbox-secrets');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getSessionNotepad(sessionId: string): Promise<SessionNotepadRecord | null> {
    const r = await this.pool.query('SELECT * FROM session_notepads WHERE session_id=$1', [sessionId]);
    return r.rows[0] ? toSessionNotepad(r.rows[0]) : null;
  }
  async readCoordinatedSessionNotepad(
    actorSessionId: string,
    targetSessionId: string,
    expectedGrantorUserId: string,
  ): Promise<SessionNotepadRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.requirePgCoordinationAuthority(client, actorSessionId, targetSessionId, expectedGrantorUserId);
      const session = (await client.query('SELECT created_at FROM sessions WHERE id=$1', [targetSessionId])).rows[0];
      const row = (
        await client.query('SELECT * FROM session_notepads WHERE session_id=$1 FOR SHARE', [targetSessionId])
      ).rows[0];
      const result = row
        ? toSessionNotepad(row)
        : {
            sessionId: targetSessionId,
            revision: 0,
            content: '',
            sizeBytes: 0,
            createdAt: session.created_at,
            updatedAt: session.created_at,
          };
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    return this.mutatePgNotepad('session', input.sessionId, input) as Promise<SessionNotepadRecord>;
  }
  async restoreSessionNotepadRevision(input: {
    sessionId: string;
    revision: number;
    expectedRevision: number;
    actor: NotepadActor;
    expectedCoordinationGrantorUserId?: string;
    now: Date;
  }): Promise<SessionNotepadRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.actor.kind === 'agent' && input.actor.sessionId !== input.sessionId)
        await this.requirePgCoordinationAuthority(
          client,
          input.actor.sessionId,
          input.sessionId,
          input.expectedCoordinationGrantorUserId,
        );
      else await this.lockLiveSessions(client, [input.sessionId]);
      const old = (
        await client.query('SELECT * FROM session_notepads WHERE session_id=$1 FOR UPDATE', [input.sessionId])
      ).rows[0];
      if ((old?.revision ?? 0) !== input.expectedRevision)
        throw new StoreConflictError('stale_revision', 'Stale notepad revision');
      const target = (
        await client.query(
          "SELECT content,size_bytes FROM notepad_revisions WHERE notepad_kind='session' AND notepad_id=$1 AND revision=$2",
          [input.sessionId, input.revision],
        )
      ).rows[0];
      if (!target) throw new StoreConflictError('not_found', 'Revision not found');
      const revision = (old?.revision ?? 0) + 1;
      const row = (
        await client.query(
          'UPDATE session_notepads SET content=$2,size_bytes=$3,revision=$4,updated_at=$5 WHERE session_id=$1 RETURNING *',
          [input.sessionId, target.content, target.size_bytes, revision, input.now],
        )
      ).rows[0];
      await client.query(
        `INSERT INTO notepad_revisions(notepad_kind,notepad_id,revision,content,size_bytes,actor,mutation_kind,created_at) VALUES('session',$1,$2,$3,$4,$5,'restore',$6)`,
        [input.sessionId, revision, target.content, target.size_bytes, input.actor, input.now],
      );
      await client.query('COMMIT');
      return toSessionNotepad(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async createExplicitNotepad(input: {
    record: ExplicitNotepadRecord;
    actor: NotepadActor;
    activityId: string;
    initialAssociation?: NotepadAssociationRecord;
    associationActivityId?: string;
  }): Promise<ExplicitNotepadRecord> {
    const n = input.record;
    if (Boolean(input.initialAssociation) !== Boolean(input.associationActivityId))
      throw new StoreConflictError('not_found', 'Initial association and activity ID are required together');
    if (input.initialAssociation?.notepadId !== undefined && input.initialAssociation.notepadId !== n.id)
      throw new StoreConflictError('not_found', 'Initial association must reference the created Notepad');
    const sizeBytes = Buffer.byteLength(n.content, 'utf8');
    if (n.sizeBytes !== sizeBytes)
      throw new StoreConflictError('invalid_notepad_size', 'Notepad size does not match UTF-8 content');
    if (sizeBytes > 256 * 1024) throw new StoreConflictError('notepad_too_large', 'Notepad exceeds 256 KiB');
    const expectedRevision = n.content ? 1 : 0;
    if (n.revision !== expectedRevision)
      throw new StoreConflictError('invalid_notepad_revision', 'Initial Notepad revision does not match its content');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockLiveSessions(client, [
        ...(input.actor.kind === 'agent' ? [input.actor.sessionId] : []),
        ...(input.initialAssociation ? [input.initialAssociation.sessionId] : []),
      ]);
      if (input.initialAssociation) {
        const session = await client.query('SELECT status FROM sessions WHERE id=$1', [
          input.initialAssociation.sessionId,
        ]);
        if (!session.rows[0]) throw new StoreConflictError('not_found', 'Session not found');
        if (session.rows[0].status === 'archived')
          throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
      }
      const r = await client.query(
        `INSERT INTO explicit_notepads(id,title,revision,content,size_bytes,created_by_user_id,created_at,updated_at,archived_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          n.id,
          n.title,
          n.revision,
          n.content,
          sizeBytes,
          n.createdByUserId ?? null,
          n.createdAt,
          n.updatedAt,
          n.archivedAt ?? null,
        ],
      );
      if (n.revision === 1) {
        await client.query(
          `INSERT INTO notepad_revisions(notepad_kind,notepad_id,revision,content,size_bytes,actor,mutation_kind,created_at) VALUES('explicit',$1,1,$2,$3,$4,'replace',$5)`,
          [n.id, n.content, sizeBytes, input.actor, n.createdAt],
        );
      }
      await this.insertNotepadActivity(
        client,
        input.activityId,
        n.id,
        input.actor,
        'created',
        { title: n.title },
        n.createdAt,
      );
      if (input.initialAssociation) {
        const a = input.initialAssociation;
        await client.query(
          'INSERT INTO notepad_associations(notepad_id,session_id,created_by_user_id,created_at) VALUES($1,$2,$3,$4)',
          [n.id, a.sessionId, a.createdByUserId ?? null, a.createdAt],
        );
        await this.insertNotepadActivity(
          client,
          input.associationActivityId!,
          n.id,
          input.actor,
          'association_granted',
          { sessionId: a.sessionId },
          a.createdAt,
        );
      }
      await client.query('COMMIT');
      return toExplicitNotepad(r.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async getExplicitNotepad(id: string): Promise<ExplicitNotepadRecord | null> {
    const r = await this.pool.query('SELECT * FROM explicit_notepads WHERE id=$1', [id]);
    return r.rows[0] ? toExplicitNotepad(r.rows[0]) : null;
  }
  async getExplicitNotepadMetadata(id: string) {
    const r = await this.pool.query(
      'SELECT id,title,revision,size_bytes,created_by_user_id,created_at,updated_at,archived_at FROM explicit_notepads WHERE id=$1',
      [id],
    );
    return r.rows[0] ? toExplicitMetadata(r.rows[0]) : null;
  }
  async listExplicitNotepads(input: { limit: number; offset: number; includeDormant?: boolean; archived?: boolean }) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    conditions.push(input.archived ? 'n.archived_at IS NOT NULL' : 'n.archived_at IS NULL');
    if (!input.includeDormant)
      conditions.push(
        "EXISTS (SELECT 1 FROM notepad_associations a JOIN sessions s ON s.id=a.session_id WHERE a.notepad_id=n.id AND s.status<>'archived')",
      );
    values.push(input.limit + 1, input.offset);
    const r = await this.pool.query(
      `SELECT n.id,n.title,n.revision,n.size_bytes,n.created_by_user_id,n.created_at,n.updated_at,n.archived_at FROM explicit_notepads n WHERE ${conditions.join(' AND ')} ORDER BY n.updated_at DESC,n.id ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return sqlPage(r.rows.map(toExplicitMetadata), input.limit, input.offset);
  }
  async searchExplicitNotepads(input: { query: string; limit: number; archived?: boolean }) {
    const literal = input.query.replace(/[\\%_]/g, '\\$&');
    const r = await this.pool.query(
      `SELECT n.id,n.title,n.revision,n.size_bytes,n.created_by_user_id,n.created_at,n.updated_at,n.archived_at,
        substring(n.content FROM greatest(1, strpos(lower(n.content),lower($2))-80) FOR 240) AS snippet
       FROM explicit_notepads n WHERE n.archived_at IS ${input.archived ? 'NOT ' : ''}NULL
         AND EXISTS (SELECT 1 FROM notepad_associations a JOIN sessions s ON s.id=a.session_id WHERE a.notepad_id=n.id AND s.status<>'archived')
         AND (n.title ILIKE $1 ESCAPE '\\' OR n.content ILIKE $1 ESCAPE '\\') ORDER BY n.updated_at DESC,n.id ASC LIMIT $3`,
      [`%${literal}%`, input.query, input.limit],
    );
    return r.rows.map((row) => ({ ...toExplicitMetadata(row), snippet: row.snippet }));
  }
  async searchExplicitNotepadsWithCapability(input: {
    actorSessionId: string;
    expectedGrantorUserId: string;
    query: string;
    limit: number;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.requirePgExplicitSearchAuthority(client, input.actorSessionId, input.expectedGrantorUserId);
      const literal = input.query.replace(/[\\%_]/g, '\\$&');
      const r = await client.query(
        `SELECT n.id,n.title,n.revision,n.size_bytes,n.created_by_user_id,n.created_at,n.updated_at,n.archived_at,
          substring(n.content FROM greatest(1, strpos(lower(n.content),lower($2))-80) FOR 240) AS snippet
         FROM explicit_notepads n WHERE n.archived_at IS NULL
           AND EXISTS (SELECT 1 FROM notepad_associations a JOIN sessions s ON s.id=a.session_id WHERE a.notepad_id=n.id AND s.status<>'archived')
           AND (n.title ILIKE $1 ESCAPE '\\' OR n.content ILIKE $1 ESCAPE '\\') ORDER BY n.updated_at DESC,n.id ASC LIMIT $3`,
        [`%${literal}%`, input.query, input.limit],
      );
      await client.query('COMMIT');
      return r.rows.map((row) => ({ ...toExplicitMetadata(row), snippet: row.snippet }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async readExplicitNotepadWithCapability(input: {
    actorSessionId: string;
    expectedGrantorUserId: string;
    notepadId: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const discovered = (await client.query('SELECT 1 FROM explicit_notepads WHERE id=$1', [input.notepadId])).rows[0];
      if (!discovered) throw new StoreConflictError('not_found', 'Notepad access denied');
      await this.requirePgExplicitSearchAuthority(client, input.actorSessionId, input.expectedGrantorUserId);
      // Do not lock the Notepad after locking the acting Session: association
      // mutations lock those rows in the opposite order. MVCC gives this read
      // a coherent snapshot while the authority locks prevent revocation.
      const row = (await client.query('SELECT * FROM explicit_notepads WHERE id=$1', [input.notepadId])).rows[0];
      if (!row) throw new StoreConflictError('not_found', 'Notepad access denied');
      await client.query('COMMIT');
      return toExplicitNotepad(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async updateExplicitNotepadMetadata(input: {
    id: string;
    title?: string;
    actor: NotepadActor;
    activityId: string;
    now: Date;
  }): Promise<ExplicitNotepadRecord> {
    return this.withExplicitNotepadLock(input.id, async (client, old) => {
      if (old.archived_at) throw new StoreConflictError('not_found', 'Archived notepads are read-only');
      await this.lockLiveSessions(client, input.actor.kind === 'agent' ? [input.actor.sessionId] : []);
      await this.requirePgExplicitWriteAuthority(client, input.id, input.actor);
      const r = await client.query(
        `UPDATE explicit_notepads SET title=COALESCE($2,title),updated_at=$3 WHERE id=$1 RETURNING *`,
        [input.id, input.title ?? null, input.now],
      );
      const n = toExplicitNotepad(r.rows[0]);
      await this.insertNotepadActivity(
        client,
        input.activityId,
        input.id,
        input.actor,
        'metadata_changed',
        { title: n.title },
        input.now,
      );
      return n;
    });
  }
  async archiveExplicitNotepad(input: { id: string; archivedAt: Date }) {
    const result = await this.pool.query(
      'UPDATE explicit_notepads SET archived_at=$2,updated_at=$2 WHERE id=$1 RETURNING *',
      [input.id, input.archivedAt],
    );
    return result.rows[0] ? toExplicitNotepad(result.rows[0]) : null;
  }
  async restoreExplicitNotepad(input: { id: string; updatedAt: Date }) {
    const result = await this.pool.query(
      'UPDATE explicit_notepads SET archived_at=NULL,updated_at=$2 WHERE id=$1 RETURNING *',
      [input.id, input.updatedAt],
    );
    return result.rows[0] ? toExplicitNotepad(result.rows[0]) : null;
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
    return this.mutatePgNotepad('explicit', input.id, input) as Promise<ExplicitNotepadRecord>;
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
    return this.withExplicitNotepadLock(input.id, async (client, old) => {
      if (old.archived_at) throw new StoreConflictError('not_found', 'Archived notepads are read-only');
      if (input.associatedAuthority)
        await this.requirePgAssociatedAuthority(client, input.id, input.associatedAuthority);
      await this.lockLiveSessions(client, input.actor.kind === 'agent' ? [input.actor.sessionId] : []);
      await this.requirePgExplicitWriteAuthority(client, input.id, input.actor);
      if (old.revision !== input.expectedRevision)
        throw new StoreConflictError('stale_revision', 'Stale notepad revision');
      const target = (
        await client.query(
          "SELECT content,size_bytes FROM notepad_revisions WHERE notepad_kind='explicit' AND notepad_id=$1 AND revision=$2",
          [input.id, input.revision],
        )
      ).rows[0];
      if (!target) throw new StoreConflictError('not_found', 'Revision not found');
      const revision = old.revision + 1;
      const row = (
        await client.query(
          'UPDATE explicit_notepads SET content=$2,size_bytes=$3,revision=$4,updated_at=$5 WHERE id=$1 RETURNING *',
          [input.id, target.content, target.size_bytes, revision, input.now],
        )
      ).rows[0];
      await client.query(
        `INSERT INTO notepad_revisions(notepad_kind,notepad_id,revision,content,size_bytes,actor,mutation_kind,created_at) VALUES('explicit',$1,$2,$3,$4,$5,'restore',$6)`,
        [input.id, revision, target.content, target.size_bytes, input.actor, input.now],
      );
      await this.insertNotepadActivity(
        client,
        input.activityId,
        input.id,
        input.actor,
        'revision_restored',
        { revision: input.revision },
        input.now,
      );
      return toExplicitNotepad(row);
    });
  }
  async listNotepadRevisions(kind: 'session' | 'explicit', id: string, limit: number, beforeRevision: number) {
    const rows = (
      await this.pool.query(
        'SELECT notepad_kind,notepad_id,revision,size_bytes,actor,mutation_kind,created_at FROM notepad_revisions WHERE notepad_kind=$1 AND notepad_id=$2 AND ($3=0 OR revision<$3) ORDER BY revision DESC LIMIT $4',
        [kind, id, beforeRevision, limit + 1],
      )
    ).rows.map(toNotepadRevisionMetadata);
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { items, hasMore, nextCursor: hasMore ? String(items.at(-1)!.revision) : null };
  }
  async getNotepadRevision(kind: 'session' | 'explicit', id: string, revision: number) {
    const row = (
      await this.pool.query('SELECT * FROM notepad_revisions WHERE notepad_kind=$1 AND notepad_id=$2 AND revision=$3', [
        kind,
        id,
        revision,
      ])
    ).rows[0];
    return row ? toNotepadRevision(row) : null;
  }
  async putNotepadAssociation(input: {
    record: NotepadAssociationRecord;
    actor: NotepadActor;
    activityId: string;
  }): Promise<NotepadAssociationRecord> {
    const a = input.record;
    return this.withExplicitNotepadLock(a.notepadId, async (client, notepad) => {
      if (notepad.archived_at) throw new StoreConflictError('not_found', 'Archived notepads are read-only');
      // Global lock order for lifecycle commands: Explicit Notepad, then Session.
      await this.lockLiveSessions(client, [
        a.sessionId,
        ...(input.actor.kind === 'agent' ? [input.actor.sessionId] : []),
      ]);
      await this.requirePgExplicitWriteAuthority(client, a.notepadId, input.actor);
      const session = (await client.query('SELECT status,parent_session_id FROM sessions WHERE id=$1', [a.sessionId]))
        .rows[0];
      if (!session) throw new StoreConflictError('not_found', 'Session not found');
      if (
        input.actor.kind === 'agent' &&
        a.sessionId !== input.actor.sessionId &&
        session.parent_session_id !== input.actor.sessionId
      )
        throw new StoreConflictError(
          'notepad_association_forbidden',
          'Agents may associate notepads only with themselves or direct children',
        );
      if (session.status === 'archived')
        throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
      const existed =
        (
          await client.query('SELECT 1 FROM notepad_associations WHERE notepad_id=$1 AND session_id=$2', [
            a.notepadId,
            a.sessionId,
          ])
        ).rowCount === 1;
      const r = await client.query(
        `INSERT INTO notepad_associations(notepad_id,session_id,created_by_user_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(notepad_id,session_id) DO UPDATE SET created_by_user_id=excluded.created_by_user_id,created_at=excluded.created_at RETURNING *`,
        [a.notepadId, a.sessionId, a.createdByUserId ?? null, a.createdAt],
      );
      await this.insertNotepadActivity(
        client,
        input.activityId,
        a.notepadId,
        input.actor,
        existed ? 'association_changed' : 'association_granted',
        { sessionId: a.sessionId },
        a.createdAt,
      );
      return toAssociation(r.rows[0]);
    });
  }
  async removeNotepadAssociation(input: {
    notepadId: string;
    sessionId: string;
    actor: NotepadActor;
    activityId: string;
    now: Date;
  }): Promise<boolean> {
    return this.withExplicitNotepadLock(input.notepadId, async (client, _notepad) => {
      if (_notepad.archived_at) throw new StoreConflictError('not_found', 'Archived notepads are read-only');
      await this.lockLiveSessions(client, [
        input.sessionId,
        ...(input.actor.kind === 'agent' ? [input.actor.sessionId] : []),
      ]);
      await this.requirePgExplicitWriteAuthority(client, input.notepadId, input.actor);
      const session = (
        await client.query('SELECT status,parent_session_id FROM sessions WHERE id=$1', [input.sessionId])
      ).rows[0];
      if (!session) throw new StoreConflictError('not_found', 'Session not found');
      if (
        input.actor.kind === 'agent' &&
        input.sessionId !== input.actor.sessionId &&
        session.parent_session_id !== input.actor.sessionId
      )
        throw new StoreConflictError(
          'notepad_association_forbidden',
          'Agents may associate notepads only with themselves or direct children',
        );
      if (session.status === 'archived')
        throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
      const removed =
        (
          await client.query('DELETE FROM notepad_associations WHERE notepad_id=$1 AND session_id=$2', [
            input.notepadId,
            input.sessionId,
          ])
        ).rowCount === 1;
      if (removed)
        await this.insertNotepadActivity(
          client,
          input.activityId,
          input.notepadId,
          input.actor,
          'association_revoked',
          { sessionId: input.sessionId },
          input.now,
        );
      return removed;
    });
  }
  async listNotepadAssociations(id: string, limit: number, offset: number) {
    const rows = (
      await this.pool.query(
        'SELECT * FROM notepad_associations WHERE notepad_id=$1 ORDER BY created_at ASC,session_id ASC LIMIT $2 OFFSET $3',
        [id, limit + 1, offset],
      )
    ).rows.map(toAssociation);
    return sqlPage(rows, limit, offset);
  }
  async listNotepadAssociationSessionIdsAfter(notepadId: string, afterSessionId: string | null, limit: number) {
    return (
      await this.pool.query(
        `SELECT session_id FROM notepad_associations
         WHERE notepad_id=$1 AND ($2::uuid IS NULL OR session_id>$2) ORDER BY session_id ASC LIMIT $3`,
        [notepadId, afterSessionId, limit],
      )
    ).rows.map((row) => row.session_id as string);
  }
  async getNotepadAssociation(notepadId: string, sessionId: string) {
    const row = (
      await this.pool.query('SELECT * FROM notepad_associations WHERE notepad_id=$1 AND session_id=$2', [
        notepadId,
        sessionId,
      ])
    ).rows[0];
    return row ? toAssociation(row) : null;
  }
  async listSessionNotepadAssociations(id: string, limit: number, offset: number) {
    const rows = (
      await this.pool.query(
        `SELECT a.*,n.title,n.revision,n.size_bytes,
          n.created_by_user_id,n.created_at AS notepad_created_at,n.updated_at,n.archived_at
         FROM notepad_associations a JOIN explicit_notepads n ON n.id=a.notepad_id
         WHERE a.session_id=$1 ORDER BY a.created_at ASC,a.notepad_id ASC LIMIT $2 OFFSET $3`,
        [id, limit + 1, offset],
      )
    ).rows.map((row) => ({
      ...toAssociation(row),
      notepad: toExplicitMetadata({ ...row, created_at: row.notepad_created_at, id: row.notepad_id }),
    }));
    return sqlPage(rows, limit, offset);
  }
  async putSessionNotepadCapability(c: SessionNotepadCapabilityRecord): Promise<SessionNotepadCapabilityRecord> {
    return this.withLiveSessionLock(c.sessionId, async (client) => {
      const r = await client.query(
        `INSERT INTO session_notepad_capabilities(session_id,kind,granted_by_user_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(session_id,kind) DO UPDATE SET granted_by_user_id=excluded.granted_by_user_id,created_at=excluded.created_at RETURNING *`,
        [c.sessionId, c.kind, c.grantedByUserId, c.createdAt],
      );
      return toCapability(r.rows[0]);
    });
  }
  async removeSessionNotepadCapability(
    s: string,
    k: SessionNotepadCapabilityRecord['kind'],
    expected?: string,
  ): Promise<boolean> {
    return this.withLiveSessionLock(
      s,
      async (client) =>
        (
          await client.query(
            `DELETE FROM session_notepad_capabilities WHERE session_id=$1 AND kind=$2${expected ? ' AND granted_by_user_id=$3' : ''}`,
            expected ? [s, k, expected] : [s, k],
          )
        ).rowCount === 1,
    );
  }
  async listSessionNotepadCapabilities(s: string): Promise<SessionNotepadCapabilityRecord[]> {
    return (
      await this.pool.query(
        'SELECT * FROM session_notepad_capabilities WHERE session_id=$1 ORDER BY created_at ASC,kind ASC',
        [s],
      )
    ).rows.map(toCapability);
  }
  private async insertNotepadActivity(
    client: PoolClient,
    id: string,
    notepadId: string,
    actor: NotepadActor,
    kind: NotepadActivityRecord['kind'],
    metadata: Record<string, unknown>,
    createdAt: Date,
  ): Promise<void> {
    await client.query(
      'INSERT INTO notepad_activity(id,notepad_id,actor,kind,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [id, notepadId, actor, kind, metadata, createdAt],
    );
  }
  async listNotepadActivity(id: string, limit: number, offset: number) {
    const rows = (
      await this.pool.query(
        'SELECT * FROM notepad_activity WHERE notepad_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',
        [id, limit + 1, offset],
      )
    ).rows.map(toNotepadActivity);
    return sqlPage(rows, limit, offset);
  }

  private async withExplicitNotepadLock<T>(
    id: string,
    operation: (client: PoolClient, row: ExplicitNotepadRow) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM explicit_notepads WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new StoreConflictError('not_found', 'Notepad not found');
      const result = await operation(client, row);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockLiveSessions(client: PoolClient, ids: string[]) {
    for (const id of [...new Set(ids)].sort()) {
      const row = (await client.query('SELECT status FROM sessions WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new StoreConflictError('not_found', 'Session not found');
      if (row.status === 'archived')
        throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    }
  }

  private async requirePgExplicitWriteAuthority(client: PoolClient, notepadId: string, actor: NotepadActor) {
    if (actor.kind !== 'agent') return;
    const association = await client.query('SELECT 1 FROM notepad_associations WHERE notepad_id=$1 AND session_id=$2', [
      notepadId,
      actor.sessionId,
    ]);
    if (association.rowCount !== 1) throw new StoreConflictError('not_found', 'Notepad association is required');
  }
  private async requirePgAssociatedAuthority(
    client: PoolClient,
    notepadId: string,
    authority: import('./types.js').AssociatedNotepadAuthority,
  ) {
    const user = (await client.query('SELECT role FROM auth_users WHERE id=$1 FOR SHARE', [authority.expectedUserId]))
      .rows[0];
    await this.lockLiveSessions(client, [authority.associatedSessionId]);
    const association = await client.query(
      'SELECT 1 FROM notepad_associations WHERE notepad_id=$1 AND session_id=$2 FOR SHARE',
      [notepadId, authority.associatedSessionId],
    );
    if (association.rowCount !== 1 || (user?.role !== 'member' && user?.role !== 'admin'))
      throw new StoreConflictError('not_found', 'Associated Session authority is no longer valid');
  }
  private async requirePgExplicitSearchAuthority(client: PoolClient, actorSessionId: string, userId: string) {
    const user = (await client.query('SELECT role FROM auth_users WHERE id=$1 FOR SHARE', [userId])).rows[0];
    await this.lockLiveSessions(client, [actorSessionId]);
    const grant = (
      await client.query(
        "SELECT granted_by_user_id FROM session_notepad_capabilities WHERE session_id=$1 AND kind='explicit_search' FOR SHARE",
        [actorSessionId],
      )
    ).rows[0];
    if (!user || grant?.granted_by_user_id !== userId || (user.role !== 'admin' && user.role !== 'member'))
      throw new StoreConflictError('not_found', 'Notepad access denied');
  }

  private async requirePgCoordinationAuthority(
    client: PoolClient,
    actorSessionId: string,
    targetSessionId: string,
    expectedGrantorUserId?: string,
  ) {
    if (!expectedGrantorUserId)
      throw new StoreConflictError('not_found', 'Session Notepad coordination capability is required');
    const user = (await client.query('SELECT role FROM auth_users WHERE id=$1 FOR SHARE', [expectedGrantorUserId]))
      .rows[0];
    await this.lockLiveSessions(client, [actorSessionId, targetSessionId]);
    const capability = (
      await client.query(
        "SELECT granted_by_user_id FROM session_notepad_capabilities WHERE session_id=$1 AND kind='session_notepad_coordination' FOR SHARE",
        [actorSessionId],
      )
    ).rows[0];
    if (capability?.granted_by_user_id !== expectedGrantorUserId || (user?.role !== 'member' && user?.role !== 'admin'))
      throw new StoreConflictError('not_found', 'Coordination grantor is no longer authorized');
  }

  private async withLiveSessionLock<T>(id: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockLiveSessions(client, [id]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async mutatePgNotepad(
    kind: 'session' | 'explicit',
    id: string,
    input: {
      content?: string;
      append?: string;
      expectedRevision?: number;
      actor: NotepadActor;
      expectedCoordinationGrantorUserId?: string;
      associatedAuthority?: import('./types.js').AssociatedNotepadAuthority;
      mutationKind: NotepadMutationKind;
      now: Date;
    },
  ): Promise<SessionNotepadRecord | ExplicitNotepadRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (kind === 'session') {
        if (input.actor.kind === 'agent' && input.actor.sessionId !== id) {
          await this.requirePgCoordinationAuthority(
            client,
            input.actor.sessionId,
            id,
            input.expectedCoordinationGrantorUserId,
          );
        } else await this.lockLiveSessions(client, [id]);
        const session = await client.query('SELECT status FROM sessions WHERE id=$1', [id]);
        if (!session.rows[0]) throw new StoreConflictError('not_found', 'Notepad not found');
        if (session.rows[0].status === 'archived')
          throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
      }
      const table = kind === 'session' ? 'session_notepads' : 'explicit_notepads';
      const key = kind === 'session' ? 'session_id' : 'id';
      const old = (await client.query(`SELECT * FROM ${table} WHERE ${key}=$1 FOR UPDATE`, [id])).rows[0];
      if (kind === 'explicit')
        await this.lockLiveSessions(client, input.actor.kind === 'agent' ? [input.actor.sessionId] : []);
      if (kind === 'explicit' && input.associatedAuthority)
        await this.requirePgAssociatedAuthority(client, id, input.associatedAuthority);
      if (kind === 'explicit') await this.requirePgExplicitWriteAuthority(client, id, input.actor);
      if (kind === 'explicit' && !old) throw new StoreConflictError('not_found', 'Notepad not found');
      if (kind === 'explicit' && old.archived_at)
        throw new StoreConflictError('not_found', 'Archived notepads are read-only');
      const revision = old?.revision ?? 0;
      if (input.append === undefined && input.expectedRevision !== revision)
        throw new StoreConflictError('stale_revision', 'Stale notepad revision');
      const content = input.append === undefined ? (input.content ?? '') : `${old?.content ?? ''}${input.append}`;
      const size = Buffer.byteLength(content, 'utf8');
      if (size > 256 * 1024) throw new StoreConflictError('notepad_too_large', 'Notepad exceeds 256 KiB');
      let row;
      if (old)
        row = (
          await client.query(
            `UPDATE ${table} SET content=$2,size_bytes=$3,revision=revision+1,updated_at=$4 WHERE ${key}=$1 RETURNING *`,
            [id, content, size, input.now],
          )
        ).rows[0];
      else
        row = (
          await client.query(
            `INSERT INTO session_notepads(session_id,revision,content,size_bytes,created_at,updated_at) VALUES($1,1,$2,$3,$4,$4) RETURNING *`,
            [id, content, size, input.now],
          )
        ).rows[0];
      await client.query(
        `INSERT INTO notepad_revisions(notepad_kind,notepad_id,revision,content,size_bytes,actor,mutation_kind,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [kind, id, revision + 1, content, size, input.actor, input.mutationKind, input.now],
      );
      await client.query('COMMIT');
      return kind === 'session' ? toSessionNotepad(row) : toExplicitNotepad(row);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async createSnippet(record: CreateSnippetRecord): Promise<SnippetRecord> {
    try {
      const result = await this.pool.query(
        `INSERT INTO snippets (id, owner_user_id, name, body, archived_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          record.id,
          record.ownerUserId,
          record.name,
          record.body,
          record.archivedAt ?? null,
          record.createdAt,
          record.updatedAt,
        ],
      );
      return toSnippet(result.rows[0]);
    } catch (error) {
      throwSnippetConflict(error);
    }
  }

  async getSnippetForUser(id: string, ownerUserId: string): Promise<SnippetRecord | null> {
    const result = await this.pool.query('SELECT * FROM snippets WHERE id = $1 AND owner_user_id = $2', [
      id,
      ownerUserId,
    ]);
    return result.rows[0] ? toSnippet(result.rows[0]) : null;
  }

  async listSnippetsForUser(ownerUserId: string): Promise<SnippetRecord[]> {
    const result = await this.pool.query('SELECT * FROM snippets WHERE owner_user_id = $1 ORDER BY name', [
      ownerUserId,
    ]);
    return result.rows.map(toSnippet);
  }

  async updateSnippet(record: UpdateSnippetRecord): Promise<SnippetRecord | null> {
    try {
      const assignments = ['updated_at = $2'];
      const values: unknown[] = [record.id, record.updatedAt];
      if (record.name !== undefined) {
        values.push(record.name);
        assignments.push(`name = $${values.length}`);
      }
      if (record.body !== undefined) {
        values.push(record.body);
        assignments.push(`body = $${values.length}`);
      }
      const result = await this.pool.query(
        `UPDATE snippets SET ${assignments.join(', ')}
         WHERE id=$1 AND owner_user_id=$${values.push(record.ownerUserId)} AND archived_at IS NULL RETURNING *`,
        values,
      );
      return result.rows[0] ? toSnippet(result.rows[0]) : null;
    } catch (error) {
      throwSnippetConflict(error);
    }
  }

  async archiveSnippet(id: string, ownerUserId: string, archivedAt: Date): Promise<SnippetRecord | null> {
    const result = await this.pool.query(
      `UPDATE snippets
       SET archived_at=COALESCE(archived_at, $2),
           updated_at=CASE WHEN archived_at IS NULL THEN $2 ELSE updated_at END
       WHERE id=$1 AND owner_user_id=$3
       RETURNING *`,
      [id, archivedAt, ownerUserId],
    );
    return result.rows[0] ? toSnippet(result.rows[0]) : null;
  }

  async restoreSnippet(id: string, ownerUserId: string, updatedAt: Date): Promise<SnippetRecord | null> {
    try {
      const result = await this.pool.query(
        `UPDATE snippets
         SET archived_at=NULL,
             updated_at=CASE WHEN archived_at IS NOT NULL THEN $2 ELSE updated_at END
         WHERE id=$1 AND owner_user_id=$3
         RETURNING *`,
        [id, updatedAt, ownerUserId],
      );
      return result.rows[0] ? toSnippet(result.rows[0]) : null;
    } catch (error) {
      throwSnippetConflict(error);
    }
  }

  async listenEvents(onEvent: (event: EventRecord) => void): Promise<PostgresEventListener> {
    const client = await this.pool.connect();
    let closed = false;
    let notificationQueue: Promise<void> = Promise.resolve();
    const handleNotification = (message: { channel: string; payload?: string | undefined }) => {
      if (message.channel !== eventNotificationChannel || !message.payload) return;
      const payload = message.payload;
      notificationQueue = notificationQueue
        .then(async () => {
          const event = await this.eventFromNotification(payload);
          if (!closed && event) onEvent(event);
        })
        .catch(() => {});
    };

    client.on('notification', handleNotification);
    await client.query(`LISTEN ${eventNotificationChannel}`);

    return {
      close: async () => {
        if (closed) return;
        closed = true;
        client.off('notification', handleNotification);
        try {
          await client.query(`UNLISTEN ${eventNotificationChannel}`);
        } finally {
          client.release();
        }
      },
    };
  }

  async withAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1) AS acquired', [lockId]);
      if (!lock.rows[0]?.acquired) return null;
      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
      }
    } finally {
      client.release();
    }
  }

  async withExternalThreadLock<T>(source: string, externalId: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const lockKey = `${source}:${externalId}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
      client.release();
    }
  }

  async upsertAuthUserForAccount(record: UpsertAuthUserForAccountRecord): Promise<AuthUserRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The account row does not exist on first login, so a row lock cannot
      // serialize competing inserts. Stable PostgreSQL text hashes may
      // collide (which only adds harmless serialization), while the two-key
      // advisory-lock form keeps provider/account boundaries unambiguous.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        record.provider,
        record.providerAccountId,
      ]);
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM auth_accounts WHERE provider = $1 AND provider_account_id = $2',
        [record.provider, record.providerAccountId],
      );
      const userId = existing.rows[0]?.user_id ?? record.userId;
      const existingUser = await client.query<Pick<AuthUserRow, 'role'>>('SELECT role FROM auth_users WHERE id = $1', [
        userId,
      ]);
      const role = existingUser.rows[0]?.role ?? record.role;
      const userResult = await client.query<AuthUserRow>(
        `INSERT INTO auth_users (id, username, role, display_name, avatar_url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (id) DO UPDATE
         SET username = EXCLUDED.username,
             display_name = EXCLUDED.display_name,
             avatar_url = EXCLUDED.avatar_url,
             updated_at = EXCLUDED.updated_at
          RETURNING id, username, role, display_name, avatar_url, created_at, updated_at`,
        [userId, record.username, role, record.displayName ?? null, record.avatarUrl ?? null, record.now],
      );
      await client.query(
        `INSERT INTO auth_accounts (id, user_id, provider, provider_account_id, username, profile, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (provider, provider_account_id) DO UPDATE
         SET username = EXCLUDED.username,
             profile = EXCLUDED.profile,
             updated_at = EXCLUDED.updated_at`,
        [
          record.accountId,
          userId,
          record.provider,
          record.providerAccountId,
          record.username,
          record.profile,
          record.now,
        ],
      );
      await client.query('COMMIT');
      return toAuthUser(userResult.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createAuthSession(record: AuthSessionRecord): Promise<AuthSessionRecord> {
    const result = await this.pool.query<AuthSessionRow>(
      `INSERT INTO auth_sessions (id, user_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, created_at, expires_at`,
      [record.id, record.userId, record.createdAt, record.expiresAt],
    );
    return toAuthSession(result.rows[0]!);
  }

  async getAuthUserBySession(input: { sessionId: string; now: Date }): Promise<AuthUserRecord | null> {
    const result = await this.pool.query<AuthUserRow>(
      `SELECT u.id, u.username, u.role, u.display_name, u.avatar_url, u.created_at, u.updated_at
       FROM auth_sessions s
       JOIN auth_users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > $2`,
      [input.sessionId, input.now],
    );
    return result.rows[0] ? toAuthUser(result.rows[0]) : null;
  }

  async getAuthUser(id: string): Promise<AuthUserRecord | null> {
    const result = await this.pool.query<AuthUserRow>(
      `SELECT id, username, role, display_name, avatar_url, created_at, updated_at
       FROM auth_users
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? toAuthUser(result.rows[0]) : null;
  }

  async deleteAuthSession(sessionId: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_sessions WHERE id = $1', [sessionId]);
  }

  async listAuthUsers(input: { query?: string } = {}): Promise<AuthUserRecord[]> {
    const query = input.query?.trim();
    const result = query
      ? await this.pool.query<AuthUserRow>(
          `SELECT id, username, role, display_name, avatar_url, created_at, updated_at
           FROM auth_users
           WHERE username ILIKE $1 OR display_name ILIKE $1 OR id::text = $2
           ORDER BY username ASC`,
          [`%${query}%`, query],
        )
      : await this.pool.query<AuthUserRow>(
          `SELECT id, username, role, display_name, avatar_url, created_at, updated_at
           FROM auth_users
           ORDER BY username ASC`,
        );
    return result.rows.map(toAuthUser);
  }

  async updateAuthUserRole(input: { userId: string; role: AuthUserRecord['role']; updatedAt: Date }) {
    try {
      const result = await this.pool.query<AuthUserRow>(
        `UPDATE auth_users
         SET role = $2,
             updated_at = $3
         WHERE id = $1
         RETURNING id, username, role, display_name, avatar_url, created_at, updated_at`,
        [input.userId, input.role, input.updatedAt],
      );
      return result.rows[0] ? toAuthUser(result.rows[0]) : null;
    } catch (error) {
      if (error instanceof Error && error.message.includes('cannot demote or remove the final administrator')) {
        throw new StoreConflictError('last_admin', 'Cannot demote the final administrator');
      }
      throw error;
    }
  }

  async createSession(record: CreateSessionRecord): Promise<SessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (
         id,
         status,
         title,
         context,
         parent_session_id,
         spawn_depth,
         created_by_user_id,
          created_at,
          updated_at,
          last_activity_at,
          tags
        )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${sessionSelectColumns}`,
      [
        record.id,
        record.status,
        record.title ?? null,
        record.context ?? null,
        record.parentSessionId ?? null,
        record.spawnDepth ?? 0,
        record.createdByUserId ?? null,
        record.createdAt,
        record.updatedAt,
        record.lastActivityAt ?? record.updatedAt,
        record.tags ?? [],
      ],
    );

    return toSession(result.rows[0]!);
  }

  async createSessionWithFirstMessage(
    input: CreateSessionWithFirstMessageInput,
  ): Promise<CreateSessionWithFirstMessageResult> {
    return this.transaction(async (client) => {
      if (input.parentChildLimit) {
        if (input.session.parentSessionId !== input.parentChildLimit.parentSessionId) {
          throw new Error('Parent child limit must match the session parent');
        }
        const parent = await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [
          input.parentChildLimit.parentSessionId,
        ]);
        if (!parent.rows[0])
          throw new Error(`Parent session does not exist: ${input.parentChildLimit.parentSessionId}`);
      }

      const existing = await client.query<SessionRow>(`SELECT ${sessionSelectColumns} FROM sessions WHERE id = $1`, [
        input.session.id,
      ]);
      if (existing.rows[0]) {
        const message = await client.query<MessageRow>(
          `SELECT id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at
           FROM messages
           WHERE session_id = $1
           ORDER BY sequence ASC
           LIMIT 1`,
          [input.session.id],
        );
        if (!message.rows[0]) throw new Error(`First message does not exist for session: ${input.session.id}`);
        return {
          session: toSession(existing.rows[0]),
          message: toMessage(message.rows[0]),
          events: [],
          created: false,
        };
      }

      if (input.parentChildLimit) {
        const count = await client.query<{ child_count: PgInteger }>(
          `SELECT COUNT(*) AS child_count
           FROM sessions
           WHERE parent_session_id = $1
             AND status <> 'archived'`,
          [input.parentChildLimit.parentSessionId],
        );
        if (Number(count.rows[0]?.child_count ?? 0) >= input.parentChildLimit.maxNonArchivedChildren) {
          throw new Error(
            `Cannot spawn more than ${input.parentChildLimit.maxNonArchivedChildren} non-archived child sessions`,
          );
        }
      }

      const sessionResult = await client.query<SessionRow>(
        `INSERT INTO sessions (
           id,
           status,
           title,
           context,
           parent_session_id,
           spawn_depth,
           created_by_user_id,
            created_at,
            updated_at,
            last_activity_at,
            tags
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING ${sessionSelectColumns}`,
        [
          input.session.id,
          input.session.status,
          input.session.title ?? null,
          input.session.context ?? null,
          input.session.parentSessionId ?? null,
          input.session.spawnDepth ?? 0,
          input.session.createdByUserId ?? null,
          input.session.createdAt,
          input.session.updatedAt,
          input.session.lastActivityAt ?? input.session.updatedAt,
          input.session.tags ?? [],
        ],
      );

      await client.query(
        `INSERT INTO session_sequence_counters (session_id, kind, next_sequence)
         VALUES ($1, 'messages', 2), ($1, 'events', 3)`,
        [input.session.id],
      );

      const messageResult = await client.query<MessageRow>(
        `INSERT INTO messages (id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at)
         VALUES ($1, $2, 1, 'pending', $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at`,
        [
          input.message.id,
          input.session.id,
          input.message.prompt,
          input.message.steering ?? false,
          input.message.authorUserId ?? null,
          input.message.authorName ?? null,
          input.message.source ?? null,
          input.message.context ?? null,
          input.message.createdAt,
        ],
      );

      const eventValues = [
        {
          ...input.sessionCreatedEvent,
          sessionId: input.session.id,
          sequence: 1,
        },
        {
          ...input.messageCreatedEvent,
          sessionId: input.session.id,
          messageId: input.message.id,
          sequence: 2,
        },
      ] as Array<NormalizedEvent & { sequence: number }>;
      const childEvents: EventRecord[] = [];
      for (const event of eventValues) {
        const inserted = await client.query<EventRow>(
          `WITH inserted AS (
             INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, session_id, run_id, message_id, sequence, type, payload, created_at
           )
           SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at,
                  pg_notify($8, json_build_object('id', id)::text)
           FROM inserted`,
          [
            event.sessionId,
            event.runId ?? null,
            event.messageId ?? null,
            event.sequence,
            event.type,
            event.payload,
            event.createdAt,
            eventNotificationChannel,
          ],
        );
        childEvents.push(toEvent(inserted.rows[0]!));
      }

      const events = [...childEvents];
      if (input.parentSpawnedEvent) {
        const parentEvent = await client.query<EventRow>(
          `WITH next_sequence AS (
             INSERT INTO session_sequence_counters (session_id, kind, next_sequence)
             VALUES ($1, 'events', 2)
             ON CONFLICT (session_id, kind)
             DO UPDATE SET next_sequence = session_sequence_counters.next_sequence + 1
             RETURNING next_sequence - 1 AS sequence
           ), inserted AS (
             INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
             SELECT $1, $2, $3, sequence, $4, $5, $6
             FROM next_sequence
             RETURNING id, session_id, run_id, message_id, sequence, type, payload, created_at
           )
           SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at,
                  pg_notify($7, json_build_object('id', id)::text)
           FROM inserted`,
          [
            input.parentSpawnedEvent.sessionId,
            input.parentSpawnedEvent.runId ?? null,
            input.parentSpawnedEvent.messageId ?? null,
            input.parentSpawnedEvent.type,
            input.parentSpawnedEvent.payload,
            input.parentSpawnedEvent.createdAt,
            eventNotificationChannel,
          ],
        );
        events.push(toEvent(parentEvent.rows[0]!));
      }

      return {
        session: toSession(sessionResult.rows[0]!),
        message: toMessage(messageResult.rows[0]!),
        events,
        created: true,
      };
    });
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<SessionRow>(`SELECT ${sessionSelectColumns} FROM sessions WHERE id = $1`, [
      id,
    ]);

    const row = result.rows[0];
    return row ? toSession(row) : null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const result = await this.pool.query<SessionRow>(
      `SELECT ${sessionSelectColumns} FROM sessions ORDER BY last_activity_at DESC, created_at DESC, id DESC`,
    );

    return result.rows.map(toSession);
  }

  async listSessionsForAgent(input: AgentSessionListOptions): Promise<SessionRecord[]> {
    const scopePredicate = input.scope === 'children' ? `parent_session_id = $1` : `TRUE`;
    const result = await this.pool.query<SessionRow>(
      `SELECT ${sessionSelectColumns}
       FROM sessions
         WHERE ${scopePredicate}
           AND ($2::text IS NULL OR status = $2)
        ORDER BY last_activity_at DESC, created_at DESC, id DESC
        LIMIT $3`,
      [input.actingSessionId, input.status ?? null, input.limit],
    );
    return result.rows.map(toSession);
  }

  async listChildSessions(input: ChildSessionListOptions): Promise<SessionRecord[]> {
    const result = await this.pool.query<SessionRow>(
      `SELECT ${sessionSelectColumns}
       FROM sessions
        WHERE parent_session_id = $1
        ORDER BY last_activity_at DESC, created_at DESC, id DESC
        LIMIT $2`,
      [input.parentSessionId, input.limit],
    );
    return result.rows.map(toSession);
  }

  async listSessionsWithLatestSandbox(provider: string, options: SessionListOptions): Promise<SessionWithSandboxPage> {
    const values: unknown[] = [provider];
    const where: string[] = [];
    where.push(options.archived ? `sessions.status = 'archived'` : `sessions.status <> 'archived'`);
    appendSessionFilterWhereClauses(options, values, where);
    const childWhere: string[] = [];
    childWhere.push(options.archived ? `child.status = 'archived'` : `child.status <> 'archived'`);
    appendSessionFilterWhereClauses(options, values, childWhere, 'child');
    childWhere.push(`child.parent_session_id = sessions.id`);
    if (options.parentSessionId) {
      values.push(options.parentSessionId);
      where.push(`sessions.parent_session_id = $${values.length}::uuid`);
    }
    if (options.cursor) {
      values.push(options.cursor.lastActivityAt, options.cursor.createdAt, options.cursor.id);
      const lastActivityAtIndex = values.length - 2;
      const createdAtIndex = values.length - 1;
      const idIndex = values.length;
      where.push(
        `(sessions.last_activity_at, sessions.created_at, sessions.id) < ($${lastActivityAtIndex}::timestamptz, $${createdAtIndex}::timestamptz, $${idIndex}::uuid)`,
      );
    }
    values.push(options.limit + 1);
    const limitIndex = values.length;

    const result = await this.pool.query<SessionWithSandboxRow>(
      `SELECT ${joinedSessionSelectColumns},
              (SELECT COUNT(*) FROM sessions child WHERE ${childWhere.join(' AND ')}) AS direct_child_count,
               latest_sandbox.id AS sandbox_id,
              latest_sandbox.provider AS sandbox_provider,
              latest_sandbox.provider_sandbox_id AS sandbox_provider_sandbox_id,
              latest_sandbox.status AS sandbox_status,
              latest_sandbox.workspace_path AS sandbox_workspace_path,
              latest_sandbox.metadata AS sandbox_metadata,
              latest_sandbox.created_at AS sandbox_created_at,
              latest_sandbox.updated_at AS sandbox_updated_at,
              latest_sandbox.last_health_check_at AS sandbox_last_health_check_at,
              latest_sandbox.keepalive_until AS sandbox_keepalive_until,
              latest_sandbox.destroyed_at AS sandbox_destroyed_at
       FROM (
          SELECT ${sessionSelectColumns}
          FROM sessions
          WHERE ${where.join(' AND ')}
          ORDER BY last_activity_at DESC, created_at DESC, id DESC
          LIMIT $${limitIndex}
       ) sessions
       LEFT JOIN LATERAL (
         SELECT id, provider, provider_sandbox_id, status, workspace_path, metadata,
                created_at, updated_at, last_health_check_at, keepalive_until, destroyed_at
         FROM sandboxes
         WHERE sandboxes.session_id = sessions.id
          ORDER BY (provider = $1) DESC, updated_at DESC
          LIMIT 1
        ) latest_sandbox ON TRUE
         ORDER BY sessions.last_activity_at DESC, sessions.created_at DESC, sessions.id DESC`,
      values,
    );

    return pageSessionRows(result.rows, options.limit);
  }

  async searchSessions(provider: string, options: SessionSearchOptions): Promise<SessionSearchPage> {
    const values: unknown[] = [
      provider,
      options.query,
      likePattern(options.query),
      options.limit + 1,
      options.cursor ?? 0,
    ];
    const where: string[] = [];
    appendSessionFilterWhereClauses(options, values, where);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await this.pool.query<SessionSearchRow>(
      `WITH search_query AS (
         SELECT websearch_to_tsquery('simple', $2) AS tsq
       ), matches AS (
         SELECT docs.session_id,
                docs.kind,
                docs.content,
                ts_rank(docs.tsv, search_query.tsq) AS score
         FROM session_search_docs docs
         CROSS JOIN search_query
         WHERE docs.tsv @@ search_query.tsq
         UNION ALL
         SELECT sessions.id AS session_id,
                'title'::text AS kind,
                COALESCE(sessions.title, '') AS content,
                 1.0 AS score
         FROM sessions
         WHERE sessions.title ILIKE $3 ESCAPE '\\'
       ), best_match AS (
         SELECT session_id, kind, content, score
         FROM (
           SELECT matches.*,
                  row_number() OVER (PARTITION BY matches.session_id ORDER BY matches.score DESC, matches.kind ASC) AS rank
           FROM matches
         ) ranked
         WHERE rank = 1
       ), matched_sessions AS (
         SELECT sessions.*, best_match.kind AS match_kind, best_match.content, best_match.score
         FROM best_match
         JOIN sessions ON sessions.id = best_match.session_id
         ${whereSql}
          ORDER BY best_match.score DESC, sessions.last_activity_at DESC, sessions.created_at DESC, sessions.id DESC
          LIMIT $4 OFFSET $5
       )
       SELECT ${joinedSessionSelectColumns},
              sessions.match_kind,
              sessions.score,
              ts_headline(
                'simple',
                sessions.content,
                search_query.tsq,
                'MaxFragments=1, MaxWords=18, StartSel=<mark>, StopSel=</mark>'
              ) AS snippet,
              latest_sandbox.id AS sandbox_id,
              latest_sandbox.provider AS sandbox_provider,
              latest_sandbox.provider_sandbox_id AS sandbox_provider_sandbox_id,
              latest_sandbox.status AS sandbox_status,
              latest_sandbox.workspace_path AS sandbox_workspace_path,
              latest_sandbox.metadata AS sandbox_metadata,
              latest_sandbox.created_at AS sandbox_created_at,
              latest_sandbox.updated_at AS sandbox_updated_at,
              latest_sandbox.last_health_check_at AS sandbox_last_health_check_at,
              latest_sandbox.keepalive_until AS sandbox_keepalive_until,
              latest_sandbox.destroyed_at AS sandbox_destroyed_at
       FROM matched_sessions sessions
       CROSS JOIN search_query
       LEFT JOIN LATERAL (
         SELECT id, provider, provider_sandbox_id, status, workspace_path, metadata,
                created_at, updated_at, last_health_check_at, keepalive_until, destroyed_at
         FROM sandboxes
         WHERE sandboxes.session_id = sessions.id
         ORDER BY (provider = $1) DESC, updated_at DESC
         LIMIT 1
       ) latest_sandbox ON TRUE
        ORDER BY sessions.score DESC, sessions.last_activity_at DESC, sessions.created_at DESC, sessions.id DESC`,
      values,
    );
    const rows = result.rows.slice(0, options.limit);
    return {
      items: rows.map((row) => ({
        item: toSessionWithSandbox(row),
        snippet: row.snippet ?? '',
        matchKind: row.match_kind,
        score: Number(row.score),
      })),
      nextCursor: result.rows.length > options.limit ? (options.cursor ?? 0) + options.limit : null,
    };
  }

  async listSessionTags(options: { limit: number }): Promise<SessionTagSummary[]> {
    const values: unknown[] = [];
    const where: string[] = [];
    values.push(options.limit);
    const limitIndex = values.length;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await this.pool.query<{ tag: string; session_count: PgInteger }>(
      `SELECT session_tags.tag, COUNT(*) AS session_count
       FROM sessions
       CROSS JOIN LATERAL unnest(sessions.tags) AS session_tags(tag)
       ${whereSql}
       GROUP BY session_tags.tag
       ORDER BY session_count DESC, session_tags.tag ASC
       LIMIT $${limitIndex}`,
      values,
    );
    return result.rows.map((row) => ({ tag: row.tag, sessionCount: Number(row.session_count) }));
  }

  async starSession(input: { sessionId: string; userId: string; now: Date }): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_stars (user_id, session_id, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, session_id) DO NOTHING`,
      [input.userId, input.sessionId, input.now],
    );
  }

  async unstarSession(input: { sessionId: string; userId: string }): Promise<void> {
    await this.pool.query('DELETE FROM session_stars WHERE user_id = $1 AND session_id = $2', [
      input.userId,
      input.sessionId,
    ]);
  }

  async listStarredSessionIds(input: { userId: string; sessionIds: string[] }): Promise<Set<string>> {
    if (!input.sessionIds.length) return new Set();
    const result = await this.pool.query<{ session_id: string }>(
      `SELECT session_id
       FROM session_stars
       WHERE user_id = $1 AND session_id = ANY($2::uuid[])`,
      [input.userId, input.sessionIds],
    );
    return new Set(result.rows.map((row) => row.session_id));
  }

  async getSearchIndexCursor(): Promise<number> {
    const result = await this.pool.query<{ last_event_id: PgInteger }>(
      'SELECT last_event_id FROM search_index_cursor WHERE id = true',
    );
    return Number(result.rows[0]?.last_event_id ?? 0);
  }

  async setSearchIndexCursor(lastEventId: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO search_index_cursor (id, last_event_id)
       VALUES (true, $1)
       ON CONFLICT (id) DO UPDATE SET last_event_id = EXCLUDED.last_event_id`,
      [lastEventId],
    );
  }

  async upsertSessionSearchDocs(docs: SessionSearchDocInput[]): Promise<void> {
    const uniqueDocs = uniqueSessionSearchDocs(docs);
    if (!uniqueDocs.length) return;
    await this.pool.query(
      `INSERT INTO session_search_docs (session_id, kind, source_id, content, created_at)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])
       ON CONFLICT (session_id, kind, source_id) DO UPDATE
       SET content = EXCLUDED.content,
           created_at = EXCLUDED.created_at`,
      [
        uniqueDocs.map((doc) => doc.sessionId),
        uniqueDocs.map((doc) => doc.kind),
        uniqueDocs.map((doc) => doc.sourceId),
        uniqueDocs.map((doc) => cleanSearchDocContent(doc.content)),
        uniqueDocs.map((doc) => doc.createdAt),
      ],
    );
  }

  async updateSession(record: SessionRecord): Promise<SessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions
       SET status = $2,
           title = $3,
            context = $4,
            created_at = $5,
            updated_at = $6,
             parent_session_id = $7,
             spawn_depth = $8,
             created_by_user_id = $9,
             last_activity_at = $10,
             tags = $11
        WHERE id = $1
        RETURNING ${sessionSelectColumns}`,
      [
        record.id,
        record.status,
        record.title ?? null,
        record.context ?? null,
        record.createdAt,
        record.updatedAt,
        record.parentSessionId ?? null,
        record.spawnDepth,
        record.createdByUserId ?? null,
        record.lastActivityAt,
        record.tags,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new Error(`Session does not exist: ${record.id}`);
    return toSession(row);
  }

  async updateSessionContext(input: SessionContextUpdateInput): Promise<SessionRecord> {
    return this.transaction(async (client) => {
      const existing = await client.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1 FOR UPDATE', [
        input.id,
      ]);
      if (!existing.rows[0]) throw new Error(`Session does not exist: ${input.id}`);
      if (existing.rows[0].status === 'archived') {
        throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
      }
      const result = await client.query<SessionRow>(
        `UPDATE sessions
         SET context = $2,
             updated_at = $3
         WHERE id = $1
         RETURNING ${sessionSelectColumns}`,
        [input.id, input.context ?? null, input.updatedAt],
      );
      return toSession(result.rows[0]!);
    });
  }

  async updateSessionWithEvent(
    record: SessionRecord,
    event: NormalizedEvent,
    options?: { preserveTags?: boolean },
  ): Promise<{ session: SessionRecord; event: EventRecord }> {
    return this.transaction(async (client) => {
      const updated = await client.query<SessionRow>(
        `UPDATE sessions
         SET status = CASE WHEN last_activity_at > $10 THEN status ELSE $2 END,
             title = $3,
              context = CASE WHEN last_activity_at > $10 THEN context ELSE $4 END,
              created_at = $5,
              updated_at = $6,
               parent_session_id = $7,
               spawn_depth = $8,
               created_by_user_id = $9,
               last_activity_at = GREATEST(last_activity_at, $10),
               tags = CASE WHEN $12 THEN tags ELSE $11 END
            WHERE id = $1
           RETURNING ${sessionSelectColumns}`,
        [
          record.id,
          record.status,
          record.title ?? null,
          record.context ?? null,
          record.createdAt,
          record.updatedAt,
          record.parentSessionId ?? null,
          record.spawnDepth,
          record.createdByUserId ?? null,
          record.lastActivityAt,
          record.tags,
          options?.preserveTags === true,
        ],
      );
      const sessionRow = updated.rows[0];
      if (!sessionRow) throw new Error(`Session does not exist: ${record.id}`);

      const inserted = await client.query<EventRow>(
        `WITH next_sequence AS (
           INSERT INTO session_sequence_counters (session_id, kind, next_sequence)
           VALUES ($1, 'events', 2)
           ON CONFLICT (session_id, kind)
           DO UPDATE SET next_sequence = session_sequence_counters.next_sequence + 1
           RETURNING next_sequence - 1 AS sequence
         ), inserted AS (
           INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
           SELECT $1, $2, $3, sequence, $4, $5, $6
           FROM next_sequence
           RETURNING id, session_id, run_id, message_id, sequence, type, payload, created_at
         )
         SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at,
                pg_notify($7, json_build_object('id', id)::text)
         FROM inserted`,
        [
          event.sessionId,
          event.runId ?? null,
          event.messageId ?? null,
          event.type,
          event.payload,
          event.createdAt,
          eventNotificationChannel,
        ],
      );

      return { session: toSession(sessionRow), event: toEvent(inserted.rows[0]!) };
    });
  }

  async updateSessionMetadataWithEvent(
    input: SessionMetadataUpdateInput,
  ): Promise<{ session: SessionRecord; event: EventRecord }> {
    return this.transaction(async (client) => {
      const updated = await client.query<SessionRow>(
        `UPDATE sessions
         SET title = CASE WHEN $3 THEN $4 ELSE title END,
             updated_at = $2,
             tags = CASE WHEN $5 THEN $6::text[] ELSE tags END
         WHERE id = $1 AND (NOT $7 OR status <> 'archived')
         RETURNING ${sessionSelectColumns}`,
        [
          input.id,
          input.updatedAt,
          input.title !== undefined,
          input.title ?? null,
          input.tags !== undefined,
          input.tags ?? [],
          input.requireNonArchived ?? false,
        ],
      );
      const sessionRow = updated.rows[0];
      if (!sessionRow && input.requireNonArchived) {
        throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
      }
      if (!sessionRow) throw new Error(`Session does not exist: ${input.id}`);
      const session = toSession(sessionRow);

      const payload = {
        title: session.title ?? null,
        ...(input.tags !== undefined ? { tags: session.tags } : {}),
      };
      const inserted = await client.query<EventRow>(
        `WITH next_sequence AS (
           INSERT INTO session_sequence_counters (session_id, kind, next_sequence)
           VALUES ($1, 'events', 2)
           ON CONFLICT (session_id, kind)
           DO UPDATE SET next_sequence = session_sequence_counters.next_sequence + 1
           RETURNING next_sequence - 1 AS sequence
         ), inserted AS (
           INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
           SELECT $1, NULL, NULL, sequence, 'session_updated', $2, $3
           FROM next_sequence
           RETURNING id, session_id, run_id, message_id, sequence, type, payload, created_at
         )
         SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at,
                pg_notify($4, json_build_object('id', id)::text)
         FROM inserted`,
        [session.id, payload, input.updatedAt, eventNotificationChannel],
      );

      return { session, event: toEvent(inserted.rows[0]!) };
    });
  }

  async updateSessionTitleIfCurrent(
    input: SessionTitleUpdateInput,
  ): Promise<{ session: SessionRecord; event: EventRecord } | null> {
    return this.transaction(async (client) => {
      const updated = await client.query<SessionRow>(
        `UPDATE sessions
         SET title = $3, updated_at = $4
         WHERE id = $1
           AND title = $2
           AND status <> 'archived'
           AND EXISTS (
             SELECT 1 FROM runs
             WHERE id = $5
               AND session_id = $1
               AND (
                 status IN ('completed', 'failed')
                 OR (status = 'running' AND lease_owner = $6 AND lease_expires_at > $7)
               )
           )
         RETURNING ${sessionSelectColumns}`,
        [input.id, input.expectedTitle, input.title, input.updatedAt, input.runId, input.leaseOwner, input.now],
      );
      const row = updated.rows[0];
      if (!row) return null;
      const session = toSession(row);
      const event = await insertLifecycleEvent(client, {
        sessionId: session.id,
        type: 'session_updated',
        payload: { title: session.title ?? null },
        createdAt: input.updatedAt,
      });
      return { session, event };
    });
  }

  async archiveSession(input: { sessionId: string; archivedAt: Date }): Promise<{
    session: SessionRecord;
    cancelledMessages: MessageRecord[];
    events: EventRecord[];
  }> {
    return this.transaction(async (client) => {
      const locked = await client.query<SessionRow>(
        `SELECT ${sessionSelectColumns} FROM sessions WHERE id = $1 FOR UPDATE`,
        [input.sessionId],
      );
      const existingRow = locked.rows[0];
      if (!existingRow) throw new Error(`Session does not exist: ${input.sessionId}`);
      if (existingRow.status === 'archived') {
        return { session: toSession(existingRow), cancelledMessages: [], events: [] };
      }

      const cancelled = await client.query<MessageRow>(
        `UPDATE messages
         SET status = 'cancelled'
         WHERE session_id = $1 AND status = 'pending'
         RETURNING id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at`,
        [input.sessionId],
      );

      const result = await client.query<SessionRow>(
        `UPDATE sessions
         SET status = 'archived', updated_at = $2, last_activity_at = $2
         WHERE id = $1
         RETURNING ${sessionSelectColumns}`,
        [input.sessionId, input.archivedAt],
      );

      const row = result.rows[0];
      if (!row) throw new Error(`Session does not exist: ${input.sessionId}`);
      const cancelledMessages = cancelled.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence);
      const events: EventRecord[] = [];
      for (const message of cancelledMessages) {
        events.push(
          await insertLifecycleEvent(client, {
            sessionId: input.sessionId,
            messageId: message.id,
            type: 'message_cancelled',
            payload: { sequence: message.sequence, reason: 'session_archived' },
            createdAt: input.archivedAt,
          }),
        );
      }
      events.push(
        await insertLifecycleEvent(client, {
          sessionId: input.sessionId,
          type: 'session_archived',
          payload: {},
          createdAt: input.archivedAt,
        }),
      );
      return {
        session: toSession(row),
        cancelledMessages,
        events,
      };
    });
  }

  async unarchiveSession(input: { sessionId: string; unarchivedAt: Date }): Promise<{
    session: SessionRecord;
    events: EventRecord[];
  }> {
    return this.transaction(async (client) => {
      const locked = await client.query<SessionRow>(
        `SELECT ${sessionSelectColumns} FROM sessions WHERE id = $1 FOR UPDATE`,
        [input.sessionId],
      );
      const existingRow = locked.rows[0];
      if (!existingRow) throw new Error(`Session does not exist: ${input.sessionId}`);
      if (existingRow.status !== 'archived') return { session: toSession(existingRow), events: [] };

      const updated = await client.query<SessionRow>(
        `UPDATE sessions
         SET status = 'idle', updated_at = $2, last_activity_at = $2
         WHERE id = $1 AND status = 'archived'
         RETURNING ${sessionSelectColumns}`,
        [input.sessionId, input.unarchivedAt],
      );
      const row = updated.rows[0];
      if (!row) throw new Error(`Session does not exist: ${input.sessionId}`);
      const event = await insertLifecycleEvent(client, {
        sessionId: input.sessionId,
        type: 'session_unarchived',
        payload: {},
        createdAt: input.unarchivedAt,
      });
      return { session: toSession(row), events: [event] };
    });
  }

  async updateSessionForRun(input: {
    id: string;
    context: Record<string, unknown>;
    updatedAt: Date;
    runId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<SessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions
       SET context = $2,
           updated_at = $3
         WHERE id = $1
           AND status <> 'archived'
           AND EXISTS (
             SELECT 1 FROM runs
             WHERE id = $4
                AND session_id = $1
                AND lease_owner = $5
                AND status IN ('running', 'cancelling')
                AND lease_expires_at > $6
           )
       RETURNING ${sessionSelectColumns}`,
      [input.id, input.context ?? null, input.updatedAt, input.runId, input.leaseOwner, input.now],
    );

    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async pauseSessionQueue(input: { sessionId: string; pausedAt: Date }): Promise<SessionRecord> {
    return this.transaction(async (client) => {
      const result = await client.query<SessionRow>(
        `UPDATE sessions SET queue_paused_at = $2, updated_at = $2, last_activity_at = $2
         WHERE id = $1 AND status <> 'archived'
         RETURNING ${sessionSelectColumns}`,
        [input.sessionId, input.pausedAt],
      );
      const row = result.rows[0];
      if (!row) return this.rejectMissingOrArchivedSession(client, input.sessionId);
      return toSession(row);
    });
  }

  async resumeSessionQueue(input: { sessionId: string }): Promise<SessionRecord> {
    const now = new Date();
    return this.transaction(async (client) => {
      const result = await client.query<SessionRow>(
        `UPDATE sessions SET queue_paused_at = NULL, updated_at = $2, last_activity_at = $2
         WHERE id = $1 AND status <> 'archived'
         RETURNING ${sessionSelectColumns}`,
        [input.sessionId, now],
      );
      const row = result.rows[0];
      if (!row) return this.rejectMissingOrArchivedSession(client, input.sessionId);
      return toSession(row);
    });
  }

  private async rejectMissingOrArchivedSession(client: PoolClient, sessionId: string): Promise<never> {
    const result = await client.query<Pick<SessionRow, 'status'>>(
      'SELECT status FROM sessions WHERE id = $1 FOR UPDATE',
      [sessionId],
    );
    if (result.rows[0]?.status === 'archived') {
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    }
    throw new Error(`Session does not exist: ${sessionId}`);
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

  async createEnvironment(record: CreateEnvironmentRecord): Promise<EnvironmentWithDetailsRecord> {
    try {
      return await this.transaction(async (client) => {
        const environmentResult = await client.query<EnvironmentRow>(
          `INSERT INTO environments (
             id, name, current_revision_id, current_revision_number, archived_at, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${environmentSelectColumns}`,
          [
            record.environment.id,
            record.environment.name.trim(),
            record.environment.currentRevisionId,
            record.environment.currentRevisionNumber,
            record.environment.archivedAt ?? null,
            record.environment.createdAt,
            record.environment.updatedAt,
          ],
        );
        await insertEnvironmentRevision(client, record.revision);
        const repositories = await insertEnvironmentRepositories(client, record.repositories);
        await insertEnvironmentActivities(client, record.activities);
        return {
          ...toEnvironment(environmentResult.rows[0]!),
          repositories,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'environments_name_unique_idx')) {
        throw new StoreConflictError('environment_name_exists', 'Environment name already exists');
      }
      throw error;
    }
  }

  async getEnvironment(id: string): Promise<EnvironmentWithDetailsRecord | null> {
    const result = await this.pool.query<EnvironmentRow>(
      `SELECT ${environmentSelectColumns} FROM environments WHERE id = $1`,
      [id],
    );
    if (!result.rows[0]) return null;
    return {
      ...toEnvironment(result.rows[0]),
      repositories: await this.listEnvironmentRepositories(id),
    };
  }

  async listEnvironments(): Promise<EnvironmentWithDetailsRecord[]> {
    const result = await this.pool.query<EnvironmentRow>(
      `SELECT ${environmentSelectColumns}
       FROM environments
       ORDER BY updated_at DESC, created_at DESC`,
    );
    if (!result.rows.length) return [];
    const environmentIds = result.rows.map((row) => row.id);
    const repositoryResult = await this.pool.query<EnvironmentRepositoryRow & { environment_id: string }>(
      `SELECT r.*, e.id AS environment_id
       FROM environment_revision_repositories r
       JOIN environments e ON e.current_revision_id = r.revision_id
       WHERE e.id = ANY($1::uuid[])
       ORDER BY e.id ASC, r.position ASC`,
      [environmentIds],
    );
    const repositoriesByEnvironment = new Map<string, EnvironmentRepositoryRow[]>();
    for (const row of repositoryResult.rows) {
      const repositories = repositoriesByEnvironment.get(row.environment_id) ?? [];
      repositories.push(row);
      repositoriesByEnvironment.set(row.environment_id, repositories);
    }
    return result.rows.map((row) => ({
      ...toEnvironment(row),
      repositories: (repositoriesByEnvironment.get(row.id) ?? []).map(toEnvironmentRepository),
    }));
  }

  async getEnvironmentRevision(id: string): Promise<EnvironmentRevisionRecord | null> {
    const result = await this.pool.query<EnvironmentRevisionRow>(
      `SELECT ${environmentRevisionSelectColumns} FROM environment_revisions WHERE id = $1`,
      [id],
    );
    return result.rows[0]
      ? toEnvironmentRevision(result.rows[0], await this.listEnvironmentRevisionRepositories(id))
      : null;
  }

  async listEnvironmentRevisions(environmentId: string): Promise<EnvironmentRevisionRecord[]> {
    const result = await this.pool.query<EnvironmentRevisionRow>(
      `SELECT ${environmentRevisionSelectColumns}
       FROM environment_revisions
       WHERE environment_id = $1
       ORDER BY revision_number DESC`,
      [environmentId],
    );
    if (!result.rows.length) return [];
    const repositoryResult = await this.pool.query<EnvironmentRepositoryRow>(
      `SELECT ${environmentRepositorySelectColumns}
       FROM environment_revision_repositories
       WHERE revision_id = ANY($1::uuid[])
       ORDER BY revision_id ASC, position ASC`,
      [result.rows.map((row) => row.id)],
    );
    const repositoriesByRevision = new Map<string, EnvironmentRepositoryRow[]>();
    for (const row of repositoryResult.rows) {
      const repositories = repositoriesByRevision.get(row.revision_id) ?? [];
      repositories.push(row);
      repositoriesByRevision.set(row.revision_id, repositories);
    }
    return result.rows.map((row) =>
      toEnvironmentRevision(
        row,
        (repositoriesByRevision.get(row.id) ?? []).map((repositoryRow) => {
          const repository = toEnvironmentRepository(repositoryRow);
          return {
            provider: repository.provider,
            owner: repository.owner,
            repo: repository.repo,
            primary: repository.isPrimary,
            position: repository.position,
            ...(repository.branch ? { branch: repository.branch } : {}),
          };
        }),
      ),
    );
  }

  async listEnvironmentActivity(environmentId: string): Promise<EnvironmentActivityRecord[]> {
    const result = await this.pool.query<EnvironmentActivityRow>(
      `SELECT ${environmentActivitySelectColumns}
       FROM environment_activity
       WHERE environment_id = $1
       ORDER BY created_at DESC, id DESC`,
      [environmentId],
    );
    return result.rows.map(toEnvironmentActivity);
  }

  async updateEnvironment(record: UpdateEnvironmentRecord): Promise<EnvironmentWithDetailsRecord> {
    try {
      return await this.transaction(async (client) => {
        const locked = await client.query<{ updated_at: Date; archived_at: Date | null }>(
          'SELECT updated_at, archived_at FROM environments WHERE id = $1 FOR UPDATE',
          [record.environment.id],
        );
        if (!locked.rows[0]) throw new Error(`Environment does not exist: ${record.environment.id}`);
        if (locked.rows[0].archived_at) {
          throw new StoreConflictError('environment_archived', 'Restore this environment before editing it');
        }
        if (locked.rows[0].updated_at.getTime() !== record.expectedUpdatedAt.getTime()) {
          throw new StoreConflictError('environment_update_conflict', 'Environment changed while it was being edited');
        }
        const environmentResult = await client.query<EnvironmentRow>(
          `UPDATE environments
           SET name = $2,
               current_revision_id = $3,
               current_revision_number = $4,
               archived_at = $5,
               updated_at = $6
           WHERE id = $1
           RETURNING ${environmentSelectColumns}`,
          [
            record.environment.id,
            record.environment.name.trim(),
            record.environment.currentRevisionId,
            record.environment.currentRevisionNumber,
            record.environment.archivedAt ?? null,
            record.environment.updatedAt,
          ],
        );
        if (!environmentResult.rows[0]) throw new Error(`Environment does not exist: ${record.environment.id}`);
        if (record.revision) await insertEnvironmentRevision(client, record.revision);
        const repositories = record.revision
          ? await insertEnvironmentRepositories(client, record.repositories)
          : await listEnvironmentRepositoriesWithClient(client, record.environment.id);
        await insertEnvironmentActivities(client, record.activities);
        return {
          ...toEnvironment(environmentResult.rows[0]),
          repositories,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'environments_name_unique_idx')) {
        throw new StoreConflictError('environment_name_exists', 'Environment name already exists');
      }
      throw error;
    }
  }

  async archiveEnvironment(input: {
    environmentId: string;
    archivedAt: Date;
    activity: EnvironmentActivityRecord;
  }): Promise<EnvironmentWithDetailsRecord | null> {
    return this.transaction(async (client) => {
      const locked = await client.query<EnvironmentRow>(
        `SELECT ${environmentSelectColumns} FROM environments WHERE id = $1 FOR UPDATE`,
        [input.environmentId],
      );
      if (!locked.rows[0]) return null;
      if (locked.rows[0].archived_at) {
        return {
          ...toEnvironment(locked.rows[0]),
          repositories: await listEnvironmentRepositoriesWithClient(client, input.environmentId),
        };
      }
      const conflicts = await client.query<{ id: string; name: string }>(
        `SELECT id, name
         FROM automations
         WHERE environment_id = $1 AND archived_at IS NULL
         ORDER BY created_at`,
        [input.environmentId],
      );
      if (conflicts.rows.length) {
        throw new StoreConflictError('environment_automation_conflict', 'Environment is used by active automations', {
          automations: conflicts.rows.map((automation) => ({
            id: automation.id,
            name: automation.name,
          })),
        });
      }
      const result = await client.query<EnvironmentRow>(
        `UPDATE environments SET archived_at = $2, updated_at = $2 WHERE id = $1 RETURNING ${environmentSelectColumns}`,
        [input.environmentId, input.archivedAt],
      );
      await insertEnvironmentActivities(client, [
        { ...input.activity, revisionId: locked.rows[0].current_revision_id },
      ]);
      return {
        ...toEnvironment(result.rows[0]!),
        repositories: await listEnvironmentRepositoriesWithClient(client, input.environmentId),
      };
    });
  }

  async unarchiveEnvironment(input: {
    environmentId: string;
    updatedAt: Date;
    activity: EnvironmentActivityRecord;
  }): Promise<EnvironmentWithDetailsRecord | null> {
    try {
      return await this.transaction(async (client) => {
        const locked = await client.query<EnvironmentRow>(
          `SELECT ${environmentSelectColumns} FROM environments WHERE id = $1 FOR UPDATE`,
          [input.environmentId],
        );
        if (!locked.rows[0]) return null;
        if (!locked.rows[0].archived_at) {
          return {
            ...toEnvironment(locked.rows[0]),
            repositories: await listEnvironmentRepositoriesWithClient(client, input.environmentId),
          };
        }
        const result = await client.query<EnvironmentRow>(
          `UPDATE environments SET archived_at = NULL, updated_at = $2 WHERE id = $1 RETURNING ${environmentSelectColumns}`,
          [input.environmentId, input.updatedAt],
        );
        await insertEnvironmentActivities(client, [
          { ...input.activity, revisionId: locked.rows[0].current_revision_id },
        ]);
        return {
          ...toEnvironment(result.rows[0]!),
          repositories: await listEnvironmentRepositoriesWithClient(client, input.environmentId),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'environments_name_unique_idx')) {
        throw new StoreConflictError('environment_name_exists', 'Environment name already exists');
      }
      throw error;
    }
  }

  async createAutomation(record: CreateAutomationRecord): Promise<AutomationRecord> {
    return this.transaction(async (client) => {
      await assertAutomationEnvironmentAvailableWithClient(client, record.environmentId, record.environmentRevisionId);
      const result = await client.query<AutomationRow>(
        `INSERT INTO automations (
         id,
         kind,
         name,
         prompt,
         schedule_cron,
         enabled,
         context,
         created_by_user_id,
         environment_id,
         environment_revision_policy,
         environment_revision_id,
         next_invocation_at,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${automationSelectColumns}`,
        [
          record.id,
          record.kind,
          record.name,
          record.prompt,
          record.scheduleCron,
          record.enabled,
          record.context ?? null,
          record.createdByUserId ?? null,
          record.environmentId ?? null,
          record.environmentRevisionPolicy ?? null,
          record.environmentRevisionId ?? null,
          record.nextInvocationAt ?? null,
          record.createdAt,
          record.updatedAt,
        ],
      );
      return toAutomation(result.rows[0]!);
    });
  }

  async getAutomation(id: string): Promise<AutomationRecord | null> {
    const result = await this.pool.query<AutomationRow>(
      `SELECT ${automationSelectColumns} FROM automations WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? toAutomation(result.rows[0]) : null;
  }

  async listAutomations(): Promise<AutomationRecord[]> {
    const result = await this.pool.query<AutomationRow>(
      `SELECT ${automationSelectColumns} FROM automations ORDER BY updated_at DESC, created_at DESC`,
    );
    return result.rows.map(toAutomation);
  }

  async updateAutomation(input: UpdateAutomationRecord): Promise<AutomationRecord> {
    return this.transaction(async (client) => {
      const existing = await client.query<AutomationRow>(
        `SELECT ${automationSelectColumns} FROM automations WHERE id = $1 FOR UPDATE`,
        [input.id],
      );
      if (!existing.rows[0]) throw new Error(`Automation does not exist: ${input.id}`);
      const current = toAutomation(existing.rows[0]);
      if (current.archivedAt) {
        throw new StoreConflictError('automation_archived', 'Restore this automation before editing it');
      }
      await assertAutomationEnvironmentAvailableWithClient(
        client,
        input.environmentId === undefined ? current.environmentId : (input.environmentId ?? undefined),
        input.environmentRevisionId === undefined
          ? current.environmentRevisionId
          : (input.environmentRevisionId ?? undefined),
      );

      const updates = ['updated_at = $2'];
      const values: unknown[] = [input.id, input.updatedAt];

      function addUpdate(column: string, value: unknown): void {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      }

      if (input.name !== undefined) addUpdate('name', input.name);
      if (input.prompt !== undefined) addUpdate('prompt', input.prompt);
      if (input.scheduleCron !== undefined) addUpdate('schedule_cron', input.scheduleCron);
      if (input.enabled !== undefined) addUpdate('enabled', input.enabled);
      if (input.context !== undefined) addUpdate('context', input.context);
      if (input.environmentId !== undefined) addUpdate('environment_id', input.environmentId);
      if (input.environmentRevisionPolicy !== undefined)
        addUpdate('environment_revision_policy', input.environmentRevisionPolicy);
      if (input.environmentRevisionId !== undefined) addUpdate('environment_revision_id', input.environmentRevisionId);
      if (input.nextInvocationAt !== undefined) addUpdate('next_invocation_at', input.nextInvocationAt);

      const result = await client.query<AutomationRow>(
        `UPDATE automations
        SET ${updates.join(', ')}
        WHERE id = $1
        RETURNING ${automationSelectColumns}`,
        values,
      );
      return toAutomation(result.rows[0]!);
    });
  }

  async archiveAutomation(input: { automationId: string; archivedAt: Date }): Promise<AutomationRecord | null> {
    return this.transaction(async (client) => {
      const existing = await client.query('SELECT id FROM automations WHERE id = $1 FOR UPDATE', [input.automationId]);
      if (!existing.rows[0]) return null;
      const active = await client.query(
        `SELECT 1 FROM automation_invocations
         WHERE automation_id = $1 AND status = 'creating'
         LIMIT 1`,
        [input.automationId],
      );
      if (active.rows[0]) {
        throw new StoreConflictError('automation_invocation_active', 'Wait for the active invocation before archiving');
      }
      const result = await client.query<AutomationRow>(
        `UPDATE automations
         SET archived_at = COALESCE(archived_at, $2),
             enabled = false,
             scheduler_lock_owner = NULL,
             scheduler_locked_until = NULL,
             updated_at = $2
         WHERE id = $1
         RETURNING ${automationSelectColumns}`,
        [input.automationId, input.archivedAt],
      );
      return toAutomation(result.rows[0]!);
    });
  }

  async unarchiveAutomation(input: { automationId: string; updatedAt: Date }): Promise<AutomationRecord | null> {
    return this.transaction(async (client) => {
      const existing = await client.query<AutomationRow>(
        `SELECT ${automationSelectColumns} FROM automations WHERE id = $1 FOR UPDATE`,
        [input.automationId],
      );
      if (!existing.rows[0]) return null;
      const automation = toAutomation(existing.rows[0]);
      await assertAutomationEnvironmentAvailableWithClient(
        client,
        automation.environmentId,
        automation.environmentRevisionId,
      );
      const result = await client.query<AutomationRow>(
        `UPDATE automations
       SET archived_at = NULL,
           enabled = false,
           scheduler_lock_owner = NULL,
           scheduler_locked_until = NULL,
           updated_at = $2
       WHERE id = $1
       RETURNING ${automationSelectColumns}`,
        [input.automationId, input.updatedAt],
      );
      return toAutomation(result.rows[0]!);
    });
  }

  async claimAutomation(input: {
    automationId: string;
    now: Date;
    lockOwner: string;
    lockedUntil: Date;
  }): Promise<AutomationRecord | null> {
    const result = await this.pool.query<AutomationRow>(
      `UPDATE automations
       SET scheduler_lock_owner = $2,
           scheduler_locked_until = $3
        WHERE id = $1
           AND archived_at IS NULL
           AND (scheduler_locked_until IS NULL OR scheduler_locked_until <= $4)
         RETURNING ${automationSelectColumns}`,
      [input.automationId, input.lockOwner, input.lockedUntil, input.now],
    );
    return result.rows[0] ? toAutomation(result.rows[0]) : null;
  }

  async releaseAutomationClaim(input: { automationId: string; lockOwner: string }): Promise<AutomationRecord | null> {
    const result = await this.pool.query<AutomationRow>(
      `UPDATE automations
       SET scheduler_lock_owner = NULL,
           scheduler_locked_until = NULL
        WHERE id = $1 AND scheduler_lock_owner = $2
        RETURNING ${automationSelectColumns}`,
      [input.automationId, input.lockOwner],
    );
    return result.rows[0] ? toAutomation(result.rows[0]) : null;
  }

  async claimNextDueScheduledAutomation(input: {
    now: Date;
    lockOwner: string;
    lockedUntil: Date;
  }): Promise<AutomationRecord | null> {
    return this.transaction(async (client) => {
      const candidate = await client.query<{ id: string }>(
        `SELECT id
         FROM automations
          WHERE kind = 'scheduled'
            AND enabled = true
            AND archived_at IS NULL
            AND next_invocation_at IS NOT NULL
            AND next_invocation_at <= $1
           AND (scheduler_locked_until IS NULL OR scheduler_locked_until <= $1)
         ORDER BY next_invocation_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [input.now],
      );
      const automationId = candidate.rows[0]?.id;
      if (!automationId) return null;

      const result = await client.query<AutomationRow>(
        `UPDATE automations
          SET scheduler_lock_owner = $2,
              scheduler_locked_until = $3
          WHERE id = $1
          RETURNING ${automationSelectColumns}`,
        [automationId, input.lockOwner, input.lockedUntil],
      );
      return result.rows[0] ? toAutomation(result.rows[0]) : null;
    });
  }

  async completeScheduledAutomationClaim(input: {
    automationId: string;
    lockOwner: string;
    claimedScheduleCron: string;
    nextInvocationAt: Date;
  }): Promise<AutomationRecord | null> {
    const result = await this.pool.query<AutomationRow>(
      `UPDATE automations
       SET next_invocation_at = $3,
           scheduler_lock_owner = NULL,
           scheduler_locked_until = NULL
         WHERE id = $1 AND scheduler_lock_owner = $2 AND schedule_cron = $4
         RETURNING ${automationSelectColumns}`,
      [input.automationId, input.lockOwner, input.nextInvocationAt, input.claimedScheduleCron],
    );
    return result.rows[0] ? toAutomation(result.rows[0]) : null;
  }

  async createAutomationInvocation(record: CreateAutomationInvocationRecord): Promise<AutomationInvocationRecord> {
    return this.transaction(async (client) => {
      const automation = await client.query<{ archived_at: Date | null }>(
        'SELECT archived_at FROM automations WHERE id = $1 FOR UPDATE',
        [record.automationId],
      );
      if (!automation.rows[0]) throw new Error(`Automation does not exist: ${record.automationId}`);
      if (automation.rows[0].archived_at) {
        throw new StoreConflictError('automation_archived', 'Restore this automation before invoking it');
      }
      const result = await client.query<AutomationInvocationRow>(
        `INSERT INTO automation_invocations (
         id,
         automation_id,
         trigger,
         status,
         scheduled_at,
         session_id,
         message_id,
         reserved_session_id,
         reserved_message_id,
         requested_by_user_id,
         environment_id,
         environment_revision_id,
         reason,
         error,
         metadata,
         created_at,
         completed_at
       )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING ${automationInvocationSelectColumns}`,
        [
          record.id,
          record.automationId,
          record.trigger,
          record.status,
          record.scheduledAt ?? null,
          record.sessionId ?? null,
          record.messageId ?? null,
          record.reservedSessionId ?? null,
          record.reservedMessageId ?? null,
          record.requestedByUserId ?? null,
          record.environmentId ?? null,
          record.environmentRevisionId ?? null,
          record.reason ?? null,
          record.error ?? null,
          record.metadata,
          record.createdAt,
          record.completedAt ?? null,
        ],
      );
      return toAutomationInvocation(result.rows[0]!);
    });
  }

  async updateAutomationInvocation(record: AutomationInvocationRecord): Promise<AutomationInvocationRecord> {
    const result = await this.pool.query<AutomationInvocationRow>(
      `UPDATE automation_invocations
       SET status = $2,
            scheduled_at = $3,
            session_id = $4,
            message_id = $5,
            reserved_session_id = $6,
            reserved_message_id = $7,
            requested_by_user_id = $8,
            environment_id = $9,
            environment_revision_id = $10,
            reason = $11,
            error = $12,
            metadata = $13,
            created_at = $14,
            completed_at = $15
        WHERE id = $1
        RETURNING ${automationInvocationSelectColumns}`,
      [
        record.id,
        record.status,
        record.scheduledAt ?? null,
        record.sessionId ?? null,
        record.messageId ?? null,
        record.reservedSessionId ?? null,
        record.reservedMessageId ?? null,
        record.requestedByUserId ?? null,
        record.environmentId ?? null,
        record.environmentRevisionId ?? null,
        record.reason ?? null,
        record.error ?? null,
        record.metadata,
        record.createdAt,
        record.completedAt ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error(`Automation invocation does not exist: ${record.id}`);
    return toAutomationInvocation(result.rows[0]);
  }

  async getAutomationInvocationBySchedule(input: {
    automationId: string;
    scheduledAt: Date;
  }): Promise<AutomationInvocationRecord | null> {
    const result = await this.pool.query<AutomationInvocationRow>(
      `SELECT ${automationInvocationSelectColumns}
       FROM automation_invocations
       WHERE automation_id = $1 AND trigger = 'scheduled' AND scheduled_at = $2
       LIMIT 1`,
      [input.automationId, input.scheduledAt],
    );
    return result.rows[0] ? toAutomationInvocation(result.rows[0]) : null;
  }

  async getBlockingAutomationSession(automationId: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT ${joinedSessionSelectColumns}
       FROM automation_invocations
       JOIN sessions ON sessions.id = automation_invocations.session_id
       WHERE automation_invocations.automation_id = $1
         AND automation_invocations.status = 'created'
         AND sessions.status IN ('queued', 'active')
       ORDER BY automation_invocations.created_at DESC, automation_invocations.id DESC
       LIMIT 1`,
      [automationId],
    );
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async listAutomationInvocations(
    automationId: string,
    options: ListAutomationInvocationsOptions = {},
  ): Promise<AutomationInvocationRecord[]> {
    const params: unknown[] = [automationId];
    let cursorClause = '';
    if (options.before) {
      params.push(options.before.createdAt, options.before.id);
      cursorClause = `AND (created_at < $2 OR (created_at = $2 AND id < $3))`;
    }
    let limitClause = '';
    if (options.limit !== undefined) {
      params.push(options.limit);
      limitClause = `LIMIT $${params.length}`;
    }
    const result = await this.pool.query<AutomationInvocationRow>(
      `SELECT ${automationInvocationSelectColumns}
       FROM automation_invocations
       WHERE automation_id = $1
       ${cursorClause}
        ORDER BY created_at DESC, id DESC
        ${limitClause}`,
      params,
    );
    return result.rows.map(toAutomationInvocation);
  }

  async nextMessageSequence(sessionId: string): Promise<number> {
    return this.nextSequence(sessionId, 'messages');
  }

  async createMessage(record: CreateMessageRecord): Promise<MessageRecord> {
    return this.transaction(async (client) => {
      const session = await client.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1 FOR UPDATE', [
        record.sessionId,
      ]);
      if (!session.rows[0]) throw new Error(`Session does not exist: ${record.sessionId}`);
      if (session.rows[0].status === 'archived' && record.status === 'pending') {
        throw new StoreConflictError('session_archived', 'Cannot enqueue messages to an archived session');
      }
      const result = await client.query<MessageRow>(
        `INSERT INTO messages (id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at`,
        [
          record.id,
          record.sessionId,
          record.sequence,
          record.status,
          record.prompt,
          record.steering ?? false,
          record.authorUserId ?? null,
          record.authorName ?? null,
          record.source ?? null,
          record.context ?? null,
          record.createdAt,
        ],
      );

      if (record.status === 'pending') {
        await client.query(
          `UPDATE sessions
           SET status = CASE
               WHEN status = 'archived' THEN 'archived'
              WHEN status = 'active' THEN 'active'
                ELSE 'queued'
              END,
              updated_at = $2,
              last_activity_at = $2
            WHERE id = $1`,
          [record.sessionId, record.createdAt],
        );
      }

      return toMessage(result.rows[0]!);
    });
  }

  async getMessages(sessionId: string): Promise<MessageRecord[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at
       FROM messages
       WHERE session_id = $1
       ORDER BY sequence ASC`,
      [sessionId],
    );

    return result.rows.map(toMessage);
  }

  async getMessagesByIds(messageIds: string[]): Promise<MessageRecord[]> {
    if (!messageIds.length) return [];
    const result = await this.pool.query<MessageRow>(
      `SELECT id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at
       FROM messages
       WHERE id = ANY($1::uuid[])`,
      [messageIds],
    );

    return result.rows.map(toMessage);
  }

  async getMessage(input: { sessionId: string; messageId: string }): Promise<MessageRecord | null> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at
       FROM messages
       WHERE session_id = $1 AND id = $2`,
      [input.sessionId, input.messageId],
    );
    return result.rows[0] ? toMessage(result.rows[0]) : null;
  }

  async getSessionMessageSummary(sessionId: string): Promise<SessionMessageSummary> {
    const [countResult, lastMessageResult] = await Promise.all([
      this.pool.query<{ message_count: PgInteger }>(
        `SELECT COUNT(*) AS message_count FROM messages WHERE session_id = $1`,
        [sessionId],
      ),
      this.pool.query<MessageRow>(
        `SELECT id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at
         FROM messages
         WHERE session_id = $1
         ORDER BY sequence DESC
         LIMIT 1`,
        [sessionId],
      ),
    ]);
    return {
      count: Number(countResult.rows[0]?.message_count ?? 0),
      lastMessage: lastMessageResult.rows[0] ? toMessage(lastMessageResult.rows[0]) : null,
    };
  }

  async getSessionTranscript(input: SessionTranscriptOptions): Promise<SessionTranscriptPage> {
    const requested = input.limit + 1;
    const messageResult = await this.pool.query<MessageRow>(
      `SELECT id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at
       FROM messages
       WHERE session_id = $1
         AND ($2::bigint IS NULL OR sequence < $2)
       ORDER BY sequence DESC
       LIMIT $3`,
      [input.sessionId, input.beforeSequence ?? null, requested],
    );
    const hasMore = messageResult.rows.length > input.limit;
    const messages = messageResult.rows.slice(0, input.limit).map(toMessage);
    if (!messages.length) return { entries: [], hasMore: false };

    const finalResponses = await this.pool.query<EventRow>(
      `SELECT DISTINCT ON (message_id) id, session_id, run_id, message_id, sequence, type, payload, created_at
       FROM events
       WHERE session_id = $1
         AND type = 'agent_response_final'
         AND message_id = ANY($2::uuid[])
       ORDER BY message_id, sequence DESC`,
      [input.sessionId, messages.map((message) => message.id)],
    );
    const responseByMessageId = new Map<string, EventRecord>();
    for (const row of finalResponses.rows) {
      if (row.message_id) responseByMessageId.set(row.message_id, toEvent(row));
    }
    return {
      entries: messages.map((message) => ({ message, finalResponse: responseByMessageId.get(message.id) ?? null })),
      hasMore,
      ...(hasMore ? { nextBeforeSequence: messages[messages.length - 1]!.sequence } : {}),
    };
  }

  async updatePendingMessage(input: {
    sessionId: string;
    messageId: string;
    prompt?: string;
    steering?: boolean;
    context?: Record<string, unknown>;
  }): Promise<MessageRecord | null> {
    const result = await this.pool.query<MessageRow>(
      `UPDATE messages
       SET prompt = CASE WHEN $3::boolean THEN $4::text ELSE prompt END,
           context = CASE WHEN $5::boolean THEN $6::jsonb ELSE context END,
           steering = CASE WHEN $7::boolean THEN $8::boolean ELSE steering END
       WHERE session_id = $1 AND id = $2 AND status = 'pending'
       RETURNING id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at`,
      [
        input.sessionId,
        input.messageId,
        input.prompt !== undefined,
        input.prompt ?? null,
        input.context !== undefined,
        input.context ?? null,
        input.steering !== undefined,
        input.steering ?? null,
      ],
    );
    return result.rows[0] ? toMessage(result.rows[0]) : null;
  }

  async cancelPendingMessage(input: {
    sessionId: string;
    messageId: string;
    cancelledAt: Date;
  }): Promise<MessageRecord | null> {
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [input.sessionId]);

      const result = await client.query<MessageRow>(
        `UPDATE messages SET status = 'cancelled' WHERE session_id = $1 AND id = $2 AND status = 'pending'
         RETURNING id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at`,
        [input.sessionId, input.messageId],
      );
      if (!result.rows[0]) return null;

      await client.query(
        `UPDATE sessions
         SET status = CASE
             WHEN status = 'archived' THEN 'archived'
             WHEN status = 'active' THEN 'active'
              WHEN EXISTS (SELECT 1 FROM messages WHERE session_id = $1 AND status = 'pending') THEN 'queued'
              ELSE 'idle'
            END,
            updated_at = $2,
            last_activity_at = $2
          WHERE id = $1`,
        [input.sessionId, input.cancelledAt],
      );

      return toMessage(result.rows[0]);
    });
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
    const signature = executionSignature(input.signature);
    const result = await this.pool.query<RunRow>(
      `UPDATE runs
       SET metadata = metadata || jsonb_build_object('executionSignature', $4::jsonb)
       WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND lease_expires_at > $3
       RETURNING id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at,
                 attempt, started_at, completed_at, failed_at, error, metadata`,
      [input.runId, input.leaseOwner, input.now, signature],
    );
    return result.rows[0] ? toRun(result.rows[0]) : null;
  }

  async claimPendingSteeringMessages(input: {
    runId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<MessageRecord[]> {
    return this.transaction(async (client) => {
      const runResult = await client.query<RunRow>(
        `SELECT id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at,
                attempt, started_at, completed_at, failed_at, error, metadata
         FROM runs
         WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND lease_expires_at > $3
         FOR UPDATE`,
        [input.runId, input.leaseOwner, input.now],
      );
      const runRow = runResult.rows[0];
      if (!runRow) return [];

      const result = await client.query<MessageRow>(
        `UPDATE messages
         SET status = 'processing'
         WHERE id IN (
           SELECT m.id FROM messages m
           WHERE m.session_id = $1 AND m.status = 'pending' AND m.steering = true
             AND $2::jsonb IS NOT NULL
             AND COALESCE((
               SELECT jsonb_object_agg(entry.key, entry.value)
               FROM jsonb_each(COALESCE(m.context, '{}'::jsonb)) entry
               WHERE entry.key IN ('repository', 'branch', 'environment', 'model', 'reasoningLevel')
                 AND entry.value <> 'null'::jsonb
             ), '{}'::jsonb) = $2::jsonb
           ORDER BY m.sequence
           FOR UPDATE
         )
         RETURNING id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at`,
        [runRow.session_id, runRow.metadata.executionSignature ?? null],
      );
      const messages = result.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence);
      if (!messages.length) return [];
      const run = toRun(runRow);
      const messageIds = [...new Set([...getRunMessageIds(run), ...messages.map((message) => message.id)])];
      const existingSequences = Array.isArray(run.metadata.sequences)
        ? run.metadata.sequences.filter((sequence): sequence is number => typeof sequence === 'number')
        : [];
      const sequences = [...new Set([...existingSequences, ...messages.map((message) => message.sequence)])];
      await client.query('UPDATE runs SET metadata = metadata || $2::jsonb WHERE id = $1', [
        input.runId,
        { messageIds, sequences },
      ]);
      return messages;
    });
  }

  async claimNextPendingMessageBatch(input: {
    runId: string;
    runnerType: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessageBatch | null> {
    return this.transaction(async (client) => {
      // Expired active runs still satisfy runs_one_active_per_session_idx until recovery marks them stale.
      const candidate = await client.query<{ session_id: string }>(
        `SELECT m.session_id
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.status = 'pending'
           AND s.status <> 'archived'
           AND s.queue_paused_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM runs r
              WHERE r.session_id = s.id
                AND r.status IN ('starting', 'running', 'completing', 'cancelling')
            )
          ORDER BY m.created_at ASC, m.sequence ASC
          FOR UPDATE OF s SKIP LOCKED
          LIMIT 1`,
      );

      const sessionId = candidate.rows[0]?.session_id;
      if (!sessionId) return null;

      const updatedMessages = await client.query<MessageRow>(
        `UPDATE messages
         SET status = 'processing'
         WHERE session_id = $1 AND status = 'pending'
          RETURNING id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at`,
        [sessionId],
      );
      const messages = updatedMessages.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence);
      const firstMessage = messages[0];
      if (!firstMessage) return null;
      const metadata = {
        messageIds: messages.map((item) => item.id),
        sequences: messages.map((item) => item.sequence),
      };

      const run = await client.query<RunRow>(
        `INSERT INTO runs (id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, started_at, metadata)
          VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $7, $8)
         RETURNING id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata`,
        [
          input.runId,
          sessionId,
          firstMessage.id,
          input.runnerType,
          input.leaseOwner,
          input.leaseExpiresAt,
          input.now,
          metadata,
        ],
      );

      await client.query('UPDATE sessions SET status = $2, updated_at = $3, last_activity_at = $3 WHERE id = $1', [
        sessionId,
        'active',
        input.now,
      ]);

      return { messages, run: toRun(run.rows[0]!) };
    });
  }

  async completeRun(input: { runId: string; leaseOwner: string; completedAt: Date }): Promise<ClaimedMessage | null> {
    return this.finishRun(input.runId, input.leaseOwner, 'completed', input.completedAt);
  }

  async beginRunCompletion(input: {
    runId: string;
    leaseOwner: string;
    now: Date;
    result: Record<string, unknown>;
  }): Promise<ClaimedMessageBatch | null> {
    return this.transaction(async (client) => {
      const result = await client.query<RunRow>(
        `UPDATE runs SET status = 'completing', heartbeat_at = $3,
                         metadata = jsonb_set(metadata, '{runnerResult}', $4::jsonb, true)
         WHERE id = $1 AND lease_owner = $2 AND status = 'running' AND lease_expires_at > $3
         RETURNING id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata`,
        [input.runId, input.leaseOwner, input.now, input.result],
      );
      const row = result.rows[0];
      if (!row) return null;
      const messageResult = await client.query<MessageRow>(
        `SELECT id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at
         FROM messages WHERE id = ANY($1::uuid[]) ORDER BY sequence`,
        [getRunMessageIds(toRun(row))],
      );
      return { run: toRun(row), messages: messageResult.rows.map(toMessage) };
    });
  }

  async claimExpiredRunCompletion(input: {
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessageBatch | null> {
    return this.transaction(async (client) => {
      const result = await client.query<RunRow>(
        `UPDATE runs SET lease_owner = $1, lease_expires_at = $2, heartbeat_at = $3
         WHERE id = (SELECT id FROM runs WHERE status = 'completing' AND lease_expires_at <= $3
                     ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata`,
        [input.leaseOwner, input.leaseExpiresAt, input.now],
      );
      const row = result.rows[0];
      if (!row) return null;
      const messages = await client.query<MessageRow>(
        `SELECT id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at
         FROM messages WHERE id = ANY($1::uuid[]) ORDER BY sequence`,
        [getRunMessageIds(toRun(row))],
      );
      return { run: toRun(row), messages: messages.rows.map(toMessage) };
    });
  }

  async completeRunBatch(input: {
    runId: string;
    leaseOwner: string;
    completedAt: Date;
  }): Promise<ClaimedMessageBatch | null> {
    return this.finishRunBatch(input.runId, input.leaseOwner, 'completed', input.completedAt);
  }

  async renewRunLease(input: {
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    heartbeatAt: Date;
  }): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `UPDATE runs
       SET lease_expires_at = $3,
           heartbeat_at = $4
         WHERE id = $1 AND lease_owner = $2 AND status IN ('running', 'completing', 'cancelling') AND lease_expires_at > $4
       RETURNING id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata`,
      [input.runId, input.leaseOwner, input.leaseExpiresAt, input.heartbeatAt],
    );

    const row = result.rows[0];
    return row ? toRun(row) : null;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `SELECT id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata
       FROM runs
       WHERE id = $1`,
      [runId],
    );
    return result.rows[0] ? toRun(result.rows[0]) : null;
  }

  async getLatestRunForSession(sessionId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `SELECT id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata
       FROM runs
       WHERE session_id = $1
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [sessionId],
    );
    return result.rows[0] ? toRun(result.rows[0]) : null;
  }

  async recoverStaleRuns(input: { now: Date; limit: number }): Promise<RecoveredRun[]> {
    return this.transaction(async (client) => {
      const stale = await client.query<RunRow>(
        `SELECT id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata
         FROM runs
          WHERE status IN ('starting', 'running', 'cancelling') AND lease_expires_at <= $1
         ORDER BY lease_expires_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [input.now, input.limit],
      );

      const recovered: RecoveredRun[] = [];
      for (const staleRun of stale.rows) {
        const runResult = await client.query<RunRow>(
          `UPDATE runs
           SET status = 'stale',
               lease_owner = NULL,
               lease_expires_at = NULL,
               heartbeat_at = $2,
               failed_at = $2,
               error = 'Run lease expired'
           WHERE id = $1
           RETURNING id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata`,
          [staleRun.id, input.now],
        );

        const messageIds = getRunMessageIds(toRun(staleRun));
        const messageResult = await client.query<MessageRow>(
          `UPDATE messages
           SET status = 'pending'
          WHERE id = ANY($1::uuid[]) AND status IN ('processing', 'cancelling')
            RETURNING id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at`,
          [messageIds],
        );

        const messages = messageResult.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence);

        await client.query(
          `UPDATE sessions
           SET status = CASE
                 WHEN status = 'archived' THEN 'archived'
                  WHEN EXISTS (SELECT 1 FROM messages WHERE session_id = $1 AND status = 'pending') THEN 'queued'
                  ELSE 'idle'
                END,
                updated_at = $2,
                last_activity_at = $2
            WHERE id = $1`,
          [staleRun.session_id, input.now],
        );

        if (!messages[0]) continue;

        recovered.push({ message: messages[0], messages, run: toRun(runResult.rows[0]!) });
      }

      return recovered;
    });
  }

  async failRun(input: {
    runId: string;
    leaseOwner: string;
    failedAt: Date;
    error: string;
  }): Promise<ClaimedMessage | null> {
    return this.finishRun(input.runId, input.leaseOwner, 'failed', input.failedAt, input.error);
  }

  async failRunBatch(input: {
    runId: string;
    leaseOwner: string;
    failedAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null> {
    return this.finishRunBatch(input.runId, input.leaseOwner, 'failed', input.failedAt, input.error);
  }

  async requestRunCancellation(input: {
    sessionId: string;
    requestedAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null> {
    return this.transaction(async (client) => {
      const runResult = await client.query<RunRow>(
        `UPDATE runs
         SET status = 'cancelling',
             heartbeat_at = $2,
             error = $3
         WHERE id = (
           SELECT id FROM runs
           WHERE session_id = $1 AND status IN ('starting', 'running', 'cancelling')
           ORDER BY started_at DESC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata`,
        [input.sessionId, input.requestedAt, input.error],
      );

      const run = runResult.rows[0];
      if (!run) return null;

      const messageIds = getRunMessageIds(toRun(run));
      const messageResult = await client.query<MessageRow>(
        `UPDATE messages
         SET status = 'cancelling'
         WHERE id = ANY($1::uuid[]) AND status IN ('processing', 'cancelling')
          RETURNING id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at`,
        [messageIds],
      );

      await client.query(
        `UPDATE sessions
         SET status = CASE WHEN status = 'archived' THEN status ELSE $2 END,
             updated_at = $3,
             last_activity_at = $3
         WHERE id = $1`,
        [input.sessionId, 'active', input.requestedAt],
      );

      return { messages: messageResult.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence), run: toRun(run) };
    });
  }

  async finalizeRunCancellation(input: {
    runId: string;
    leaseOwner: string;
    cancelledAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null> {
    return this.finishRunBatch(input.runId, input.leaseOwner, 'cancelled', input.cancelledAt, input.error);
  }

  async getActiveSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null> {
    return (await this.listActiveSandboxes(sessionId, provider))[0] ?? null;
  }

  async getLatestSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null> {
    const result = await this.pool.query<SandboxRow>(
      `SELECT id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata,
              created_at, updated_at, last_health_check_at, keepalive_until, destroyed_at
       FROM sandboxes
       WHERE session_id = $1
         AND provider = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [sessionId, provider],
    );
    return result.rows[0] ? toSandbox(result.rows[0]) : null;
  }

  async getLatestSandboxForSession(sessionId: string, preferredProvider?: string): Promise<SandboxRecord | null> {
    const result = await this.pool.query<SandboxRow>(
      `SELECT id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata,
              created_at, updated_at, last_health_check_at, keepalive_until, destroyed_at
       FROM sandboxes
       WHERE session_id = $1
       ORDER BY ($2::text IS NOT NULL AND provider = $2::text) DESC, updated_at DESC
       LIMIT 1`,
      [sessionId, preferredProvider ?? null],
    );
    return result.rows[0] ? toSandbox(result.rows[0]) : null;
  }

  async listActiveSandboxes(sessionId: string, provider: string): Promise<SandboxRecord[]> {
    const result = await this.pool.query<SandboxRow>(
      `SELECT id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata,
              created_at, updated_at, last_health_check_at, keepalive_until, destroyed_at
       FROM sandboxes
       WHERE session_id = $1
         AND provider = $2
         AND destroyed_at IS NULL
         AND status IN ('ready', 'stopped', 'unhealthy')
        ORDER BY updated_at DESC
       `,
      [sessionId, provider],
    );
    return result.rows.map(toSandbox);
  }

  async listIdleSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]> {
    const result = await this.pool.query<SandboxRow>(
      `SELECT sb.id, sb.session_id, sb.provider, sb.provider_sandbox_id, sb.status, sb.workspace_path, sb.metadata,
              sb.created_at, sb.updated_at, sb.last_health_check_at, sb.keepalive_until, sb.destroyed_at
       FROM sandboxes sb
       JOIN sessions s ON s.id = sb.session_id
       WHERE sb.provider = $1
         AND sb.destroyed_at IS NULL
          AND sb.status IN ('ready', 'stopped', 'unhealthy')
          AND sb.updated_at <= $2
          AND (sb.keepalive_until IS NULL OR sb.keepalive_until <= now())
          AND s.status NOT IN ('active', 'queued')
       ORDER BY sb.updated_at ASC
       LIMIT $3`,
      [input.provider, input.idleBefore, input.limit],
    );
    return result.rows.map(toSandbox);
  }

  async listStoppableSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]> {
    const result = await this.pool.query<SandboxRow>(
      `SELECT sb.id, sb.session_id, sb.provider, sb.provider_sandbox_id, sb.status, sb.workspace_path, sb.metadata,
              sb.created_at, sb.updated_at, sb.last_health_check_at, sb.keepalive_until, sb.destroyed_at
       FROM sandboxes sb
       JOIN sessions s ON s.id = sb.session_id
       WHERE sb.provider = $1
         AND sb.destroyed_at IS NULL
          AND sb.status = 'ready'
          AND sb.updated_at <= $2
          AND (sb.keepalive_until IS NULL OR sb.keepalive_until <= now())
          AND s.status NOT IN ('active', 'queued')
         AND NOT EXISTS (
           SELECT 1 FROM messages m
           WHERE m.session_id = sb.session_id AND m.status = 'pending'
         )
       ORDER BY sb.updated_at ASC
       LIMIT $3`,
      [input.provider, input.idleBefore, input.limit],
    );
    return result.rows.map(toSandbox);
  }

  async createSandbox(record: CreateSandboxRecord): Promise<SandboxRecord> {
    const result = await this.pool.query<SandboxRow>(
      `INSERT INTO sandboxes (id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata, created_at, updated_at, keepalive_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata,
                 created_at, updated_at, last_health_check_at, keepalive_until, destroyed_at`,
      [
        record.id,
        record.sessionId,
        record.provider,
        record.providerSandboxId,
        record.status,
        record.workspacePath,
        record.metadata,
        record.createdAt,
        record.updatedAt,
        record.keepaliveUntil ?? null,
      ],
    );
    return toSandbox(result.rows[0]!);
  }

  async createSandboxWithSecrets(record: CreateSandboxRecord, secrets: SandboxSecrets): Promise<SandboxRecord> {
    if (!Object.keys(secrets).length) return this.createSandbox(record);
    const cipher = this.requireSandboxSecretCipher();
    const now = new Date();
    return this.transaction(async (client) => {
      const sandboxResult = await client.query<SandboxRow>(
        `INSERT INTO sandboxes (id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata, created_at, updated_at, keepalive_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata,
                   created_at, updated_at, last_health_check_at, keepalive_until, destroyed_at`,
        [
          record.id,
          record.sessionId,
          record.provider,
          record.providerSandboxId,
          record.status,
          record.workspacePath,
          record.metadata,
          record.createdAt,
          record.updatedAt,
          record.keepaliveUntil ?? null,
        ],
      );
      for (const [name, value] of Object.entries(secrets)) {
        const encrypted = cipher.encrypt(value);
        await client.query(
          `INSERT INTO sandbox_secrets (sandbox_id, name, ciphertext, iv, tag, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [record.id, name, encrypted.ciphertext, encrypted.iv, encrypted.tag, now, now],
        );
      }
      return toSandbox(sandboxResult.rows[0]!);
    });
  }

  async updateSandbox(record: SandboxRecord): Promise<SandboxRecord> {
    const result = await this.pool.query<SandboxRow>(
      `UPDATE sandboxes
       SET status = $2,
           workspace_path = $3,
           metadata = $4,
            updated_at = $5,
            last_health_check_at = $6,
            keepalive_until = $7,
            destroyed_at = $8
        WHERE id = $1
       RETURNING id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata,
                  created_at, updated_at, last_health_check_at, keepalive_until, destroyed_at`,
      [
        record.id,
        record.status,
        record.workspacePath,
        record.metadata,
        record.updatedAt,
        record.lastHealthCheckAt ?? null,
        record.keepaliveUntil ?? null,
        record.destroyedAt ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error(`Sandbox does not exist: ${record.id}`);
    return toSandbox(result.rows[0]);
  }

  async getSandboxSecrets(sandboxId: string): Promise<SandboxSecrets> {
    const result = await this.pool.query<{
      name: string;
      ciphertext: string;
      iv: string;
      tag: string;
    }>(`SELECT name, ciphertext, iv, tag FROM sandbox_secrets WHERE sandbox_id = $1`, [sandboxId]);
    if (!result.rows.length) return {};
    const cipher = this.requireSandboxSecretCipher();
    return Object.fromEntries(
      result.rows.map((row) => [row.name, cipher.decrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag })]),
    );
  }

  async setSandboxSecrets(sandboxId: string, secrets: SandboxSecrets): Promise<void> {
    if (!Object.keys(secrets).length) return;
    const cipher = this.requireSandboxSecretCipher();
    const now = new Date();
    for (const [name, value] of Object.entries(secrets)) {
      const encrypted = cipher.encrypt(value);
      await this.pool.query(
        `INSERT INTO sandbox_secrets (sandbox_id, name, ciphertext, iv, tag, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (sandbox_id, name) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext,
             iv = EXCLUDED.iv,
             tag = EXCLUDED.tag,
             updated_at = EXCLUDED.updated_at`,
        [sandboxId, name, encrypted.ciphertext, encrypted.iv, encrypted.tag, now, now],
      );
    }
  }

  private requireSandboxSecretCipher(): SecretCipher {
    if (!this.secretCipher) throw new Error('SANDBOX_SECRET_ENCRYPTION_KEY is required for sandbox secrets');
    return this.secretCipher;
  }

  async createArtifact(record: CreateArtifactRecord): Promise<ArtifactRecord> {
    const result = await this.pool.query<ArtifactRow>(
      `INSERT INTO artifacts (id, session_id, run_id, message_id, type, title, url, storage_key, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET id = artifacts.id
       WHERE (artifacts.session_id, artifacts.run_id, artifacts.message_id, artifacts.type, artifacts.title,
              artifacts.url, artifacts.storage_key, artifacts.payload)
         IS NOT DISTINCT FROM (EXCLUDED.session_id, EXCLUDED.run_id, EXCLUDED.message_id, EXCLUDED.type,
                               EXCLUDED.title, EXCLUDED.url, EXCLUDED.storage_key, EXCLUDED.payload)
       RETURNING id, session_id, run_id, message_id, type, title, url, storage_key, payload, created_at`,
      [
        record.id,
        record.sessionId,
        record.runId ?? null,
        record.messageId ?? null,
        record.type,
        record.title ?? null,
        record.url ?? null,
        record.storageKey ?? null,
        record.payload,
        record.createdAt,
      ],
    );
    if (!result.rows[0]) throw new Error(`Artifact idempotency mismatch: ${record.id}`);
    return toArtifact(result.rows[0]);
  }

  async getArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT id, session_id, run_id, message_id, type, title, url, storage_key, payload, created_at
       FROM artifacts
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId],
    );
    return result.rows.map(toArtifact);
  }

  async createExternalResource(record: CreateExternalResourceRecord): Promise<ExternalResourceRecord> {
    const result = await this.pool.query<ExternalResourceRow>(
      `INSERT INTO external_resources (id, session_id, run_id, message_id, type, title, url, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, session_id, run_id, message_id, type, title, url, metadata, created_at`,
      [
        record.id,
        record.sessionId,
        record.runId ?? null,
        record.messageId ?? null,
        record.type,
        record.title ?? null,
        record.url,
        record.metadata,
        record.createdAt,
      ],
    );
    return toExternalResource(result.rows[0]!);
  }

  async getExternalResources(sessionId: string): Promise<ExternalResourceRecord[]> {
    const result = await this.pool.query<ExternalResourceRow>(
      `SELECT id, session_id, run_id, message_id, type, title, url, metadata, created_at
       FROM external_resources
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId],
    );
    return result.rows.map(toExternalResource);
  }

  async createCallbackDelivery(record: CreateCallbackDeliveryRecord): Promise<CallbackDeliveryRecord> {
    const result = await this.pool.query<CallbackDeliveryRow>(
      `INSERT INTO callback_deliveries (id, session_id, run_id, message_id, target_type, target, status, event_type, payload, created_at, updated_at, next_attempt_at, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET id = callback_deliveries.id
       WHERE (callback_deliveries.session_id, callback_deliveries.run_id, callback_deliveries.message_id,
              callback_deliveries.target_type, callback_deliveries.target, callback_deliveries.event_type,
              callback_deliveries.payload)
         IS NOT DISTINCT FROM (EXCLUDED.session_id, EXCLUDED.run_id, EXCLUDED.message_id,
                               EXCLUDED.target_type, EXCLUDED.target, EXCLUDED.event_type, EXCLUDED.payload)
       RETURNING id, session_id, run_id, message_id, target_type, target, status, event_type, payload, attempts, max_attempts, last_error, created_at, updated_at, next_attempt_at, last_attempt_at, delivered_at`,
      [
        record.id,
        record.sessionId,
        record.runId ?? null,
        record.messageId ?? null,
        record.targetType,
        record.target,
        record.eventType,
        record.payload,
        record.createdAt,
        record.updatedAt,
        record.nextAttemptAt,
        record.maxAttempts ?? 5,
      ],
    );
    if (!result.rows[0]) throw new Error(`Callback idempotency mismatch: ${record.id}`);
    return toCallbackDelivery(result.rows[0]);
  }

  async listCallbackDeliveries(input: { sessionId: string; messageId?: string }): Promise<CallbackDeliveryRecord[]> {
    const result = await this.pool.query<CallbackDeliveryRow>(
      `SELECT id, session_id, run_id, message_id, target_type, target, status, event_type, payload, attempts, max_attempts, last_error, created_at, updated_at, next_attempt_at, last_attempt_at, delivered_at
       FROM callback_deliveries
       WHERE session_id = $1
         AND ($2::uuid IS NULL OR message_id = $2::uuid)
       ORDER BY created_at DESC`,
      [input.sessionId, input.messageId ?? null],
    );
    return result.rows.map(toCallbackDelivery);
  }

  async claimDueCallbackDeliveries(input: { now: Date; limit: number }): Promise<CallbackDeliveryRecord[]> {
    return this.transaction(async (client) => {
      const staleSendingBefore = new Date(input.now.getTime() - staleCallbackSendingMs);
      const due = await client.query<CallbackDeliveryRow>(
        `SELECT id, session_id, run_id, message_id, target_type, target, status, event_type, payload, attempts, max_attempts, last_error, created_at, updated_at, next_attempt_at, last_attempt_at, delivered_at
          FROM callback_deliveries
          WHERE (status = 'pending' OR (status = 'sending' AND last_attempt_at IS NOT NULL AND last_attempt_at <= $3))
            AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
            AND attempts < max_attempts
         ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [input.now, input.limit, staleSendingBefore],
      );
      if (!due.rows.length) return [];

      const claimed = await client.query<CallbackDeliveryRow>(
        `UPDATE callback_deliveries
         SET status = 'sending', attempts = attempts + 1, last_attempt_at = $2, updated_at = $2
         WHERE id = ANY($1::uuid[])
         RETURNING id, session_id, run_id, message_id, target_type, target, status, event_type, payload, attempts, max_attempts, last_error, created_at, updated_at, next_attempt_at, last_attempt_at, delivered_at`,
        [due.rows.map((row) => row.id), input.now],
      );
      return claimed.rows.map(toCallbackDelivery);
    });
  }

  async markCallbackDeliverySent(input: { id: string; deliveredAt: Date }): Promise<CallbackDeliveryRecord> {
    const result = await this.pool.query<CallbackDeliveryRow>(
      `UPDATE callback_deliveries
       SET status = 'sent', delivered_at = $2, updated_at = $2, next_attempt_at = NULL, last_error = NULL
       WHERE id = $1
         RETURNING id, session_id, run_id, message_id, target_type, target, status, event_type, payload, attempts, max_attempts, last_error, created_at, updated_at, next_attempt_at, last_attempt_at, delivered_at`,
      [input.id, input.deliveredAt],
    );
    if (!result.rows[0]) throw new Error(`Callback delivery does not exist: ${input.id}`);
    return toCallbackDelivery(result.rows[0]);
  }

  async markCallbackDeliveryFailed(input: {
    id: string;
    failedAt: Date;
    error: string;
    terminal: boolean;
    nextAttemptAt?: Date;
  }): Promise<CallbackDeliveryRecord> {
    const result = await this.pool.query<CallbackDeliveryRow>(
      `UPDATE callback_deliveries
       SET status = $2, last_error = $3, updated_at = $4, next_attempt_at = $5
       WHERE id = $1
       RETURNING id, session_id, run_id, message_id, target_type, target, status, event_type, payload, attempts, max_attempts, last_error, created_at, updated_at, next_attempt_at, last_attempt_at, delivered_at`,
      [input.id, input.terminal ? 'failed' : 'pending', input.error, input.failedAt, input.nextAttemptAt ?? null],
    );
    if (!result.rows[0]) throw new Error(`Callback delivery does not exist: ${input.id}`);
    return toCallbackDelivery(result.rows[0]);
  }

  async requestCallbackReplay(input: {
    sessionId: string;
    deliveryId: string;
    requestedAt: Date;
  }): Promise<CallbackDeliveryRecord | null> {
    const result = await this.pool.query<CallbackDeliveryRow>(
      `UPDATE callback_deliveries
       SET status = 'pending', next_attempt_at = $3, delivered_at = NULL, updated_at = $3, max_attempts = GREATEST(max_attempts, attempts + 1)
       WHERE id = $1
         AND session_id = $2
         AND status = 'failed'
       RETURNING id, session_id, run_id, message_id, target_type, target, status, event_type, payload, attempts, max_attempts, last_error, created_at, updated_at, next_attempt_at, last_attempt_at, delivered_at`,
      [input.deliveryId, input.sessionId, input.requestedAt],
    );
    return result.rows[0] ? toCallbackDelivery(result.rows[0]) : null;
  }

  async nextEventSequence(sessionId: string): Promise<number> {
    return this.nextSequence(sessionId, 'events');
  }

  async appendEvent(event: NormalizedEvent & { sequence: number }): Promise<EventRecord> {
    const result = await this.pool.query<EventRow>(
      `WITH inserted AS (
         INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, session_id, run_id, message_id, sequence, type, payload, created_at
       )
       SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at,
              pg_notify($8, json_build_object('id', id)::text)
       FROM inserted`,
      [
        event.sessionId,
        event.runId ?? null,
        event.messageId ?? null,
        event.sequence,
        event.type,
        event.payload,
        event.createdAt,
        eventNotificationChannel,
      ],
    );

    return toEvent(result.rows[0]!);
  }

  async appendEventWithNextSequence(event: NormalizedEvent): Promise<EventRecord> {
    const result = await this.pool.query<EventRow>(
      `WITH next_sequence AS (
         INSERT INTO session_sequence_counters (session_id, kind, next_sequence)
         VALUES ($1, 'events', 2)
         ON CONFLICT (session_id, kind)
         DO UPDATE SET next_sequence = session_sequence_counters.next_sequence + 1
         RETURNING next_sequence - 1 AS sequence
       ), inserted AS (
         INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
         SELECT $1, $2, $3, sequence, $4, $5, $6
         FROM next_sequence
         RETURNING id, session_id, run_id, message_id, sequence, type, payload, created_at
       )
       SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at,
              pg_notify($7, json_build_object('id', id)::text)
       FROM inserted`,
      [
        event.sessionId,
        event.runId ?? null,
        event.messageId ?? null,
        event.type,
        event.payload,
        event.createdAt,
        eventNotificationChannel,
      ],
    );

    return toEvent(result.rows[0]!);
  }

  async appendEventWithNextSequenceForRun(
    event: Omit<NormalizedEvent, 'runId'> & { runId: string },
    guard: { runId: string; leaseOwner: string; now: Date },
  ): Promise<EventRecord | null> {
    const result = await this.pool.query<EventRow>(
      `WITH owned_run AS (
         SELECT 1
         FROM runs
         WHERE id = $2
           AND id = $8
           AND lease_owner = $9
           AND status IN ('running', 'completing', 'cancelling')
           AND lease_expires_at > $10
         FOR UPDATE
       ), next_sequence AS (
         INSERT INTO session_sequence_counters (session_id, kind, next_sequence)
         SELECT $1, 'events', 2 FROM owned_run
         ON CONFLICT (session_id, kind)
         DO UPDATE SET next_sequence = session_sequence_counters.next_sequence + 1
         RETURNING next_sequence - 1 AS sequence
       ), inserted AS (
         INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
         SELECT $1, $2, $3, sequence, $4, $5, $6
         FROM next_sequence
         RETURNING id, session_id, run_id, message_id, sequence, type, payload, created_at
       )
       SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at,
              pg_notify($7, json_build_object('id', id)::text)
       FROM inserted`,
      [
        event.sessionId,
        event.runId,
        event.messageId ?? null,
        event.type,
        event.payload,
        event.createdAt,
        eventNotificationChannel,
        guard.runId,
        guard.leaseOwner,
        guard.now,
      ],
    );

    return result.rows[0] ? toEvent(result.rows[0]) : null;
  }

  async getEvents(sessionId: string, afterSequence = 0, limit?: number): Promise<EventRecord[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at
       FROM events
       WHERE session_id = $1 AND sequence > $2
       ORDER BY sequence ASC
       ${limit === undefined ? '' : 'LIMIT $3'}`,
      limit === undefined ? [sessionId, afterSequence] : [sessionId, afterSequence, limit],
    );

    return result.rows.map(toEvent);
  }

  async getLatestEventByType(sessionId: string, type: EventRecord['type']): Promise<EventRecord | null> {
    const result = await this.pool.query<EventRow>(
      `SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at
       FROM events
       WHERE session_id = $1 AND type = $2
       ORDER BY sequence DESC
       LIMIT 1`,
      [sessionId, type],
    );
    return result.rows[0] ? toEvent(result.rows[0]) : null;
  }

  async listEvents(afterId = 0, limit?: number): Promise<EventRecord[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at
       FROM events
       WHERE id > $1
       ORDER BY id ASC
       ${limit === undefined ? '' : 'LIMIT $2'}`,
      limit === undefined ? [afterId] : [afterId, limit],
    );

    return result.rows.map(toEvent);
  }

  async compactFinalizedAgentTextDeltas(input: EventDeltaCompactionInput): Promise<number> {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT delta.id
         FROM events delta
         WHERE delta.type = 'agent_text_delta'
           AND delta.message_id IS NOT NULL
           AND delta.created_at < $1
           AND EXISTS (
             SELECT 1
             FROM events final_event
             WHERE final_event.type = 'agent_response_final'
               AND final_event.session_id = delta.session_id
               AND final_event.message_id = delta.message_id
               AND final_event.sequence > delta.sequence
               AND final_event.created_at < $1
               AND jsonb_typeof(final_event.payload->'text') = 'string'
           )
         ORDER BY delta.id ASC
         LIMIT $2
       )
       DELETE FROM events
       WHERE id IN (SELECT id FROM candidates)`,
      [input.finalizedBefore, input.limit],
    );

    return result.rowCount ?? 0;
  }

  async createWebhookSource(record: CreateWebhookSourceRecord): Promise<WebhookSourceRecord> {
    const result = await this.pool.query<WebhookSourceRow>(
      `INSERT INTO webhook_sources (id, key, name, enabled, bearer_token, prompt_prefix, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key)
       DO UPDATE SET name = EXCLUDED.name,
                     enabled = EXCLUDED.enabled,
                     bearer_token = EXCLUDED.bearer_token,
                     prompt_prefix = EXCLUDED.prompt_prefix,
                     updated_at = EXCLUDED.updated_at
       RETURNING id, key, name, enabled, bearer_token, prompt_prefix, created_at, updated_at`,
      [
        record.id,
        record.key,
        record.name,
        record.enabled,
        record.bearerToken,
        record.promptPrefix ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );

    return toWebhookSource(result.rows[0]!);
  }

  async getWebhookSource(key: string): Promise<WebhookSourceRecord | null> {
    const result = await this.pool.query<WebhookSourceRow>(
      `SELECT id, key, name, enabled, bearer_token, prompt_prefix, created_at, updated_at
       FROM webhook_sources
       WHERE key = $1`,
      [key],
    );

    const row = result.rows[0];
    return row ? toWebhookSource(row) : null;
  }

  async getExternalThread(source: string, externalId: string): Promise<ExternalThreadRecord | null> {
    const result = await this.pool.query<ExternalThreadRow>(
      `SELECT id, source, external_id, session_id, metadata, created_at, updated_at
       FROM external_threads
       WHERE source = $1 AND external_id = $2`,
      [source, externalId],
    );

    const row = result.rows[0];
    return row ? toExternalThread(row) : null;
  }

  async createExternalThread(input: {
    id: string;
    source: string;
    externalId: string;
    sessionId: string;
    metadata: Record<string, unknown>;
    now: Date;
  }): Promise<ExternalThreadRecord> {
    const result = await this.pool.query<ExternalThreadRow>(
      `INSERT INTO external_threads (id, source, external_id, session_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (source, external_id) DO UPDATE SET updated_at = external_threads.updated_at
       RETURNING id, source, external_id, session_id, metadata, created_at, updated_at`,
      [input.id, input.source, input.externalId, input.sessionId, input.metadata, input.now],
    );

    return toExternalThread(result.rows[0]!);
  }

  async createIntegrationDelivery(input: {
    id: string;
    source: string;
    dedupeKey: string;
    receivedAt: Date;
    staleReceivedBefore: Date;
    metadata: Record<string, unknown>;
  }): Promise<IntegrationDeliveryRecord | null> {
    const result = await this.pool.query<IntegrationDeliveryRow>(
      `INSERT INTO integration_deliveries (id, source, dedupe_key, status, received_at, metadata)
       VALUES ($1, $2, $3, 'received', $4, $5)
        ON CONFLICT (source, dedupe_key) DO UPDATE
         SET id = EXCLUDED.id,
             status = 'received',
             received_at = EXCLUDED.received_at,
             processed_at = NULL,
             error = NULL,
             metadata = EXCLUDED.metadata
        WHERE integration_deliveries.status = 'failed'
        RETURNING id, source, dedupe_key, status, received_at, processed_at, error, metadata`,
      [input.id, input.source, input.dedupeKey, input.receivedAt, input.metadata],
    );

    const row = result.rows[0];
    return row ? toIntegrationDelivery(row) : null;
  }

  async markIntegrationDeliveryProcessed(input: {
    id: string;
    source: string;
    dedupeKey: string;
    processedAt: Date;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE integration_deliveries
       SET status = 'processed', processed_at = $3
       WHERE source = $1 AND dedupe_key = $2 AND id = $4 AND status = 'received'`,
      [input.source, input.dedupeKey, input.processedAt, input.id],
    );
    return result.rowCount === 1;
  }

  async markIntegrationDeliveryFailed(input: {
    id: string;
    source: string;
    dedupeKey: string;
    failedAt: Date;
    error: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE integration_deliveries
       SET status = 'failed', processed_at = $3, error = $4
       WHERE source = $1 AND dedupe_key = $2 AND id = $5 AND status = 'received'`,
      [input.source, input.dedupeKey, input.failedAt, input.error, input.id],
    );
    return result.rowCount === 1;
  }

  private async nextSequence(sessionId: string, kind: 'messages' | 'events'): Promise<number> {
    const result = await this.pool.query<{ sequence: PgInteger }>(
      `INSERT INTO session_sequence_counters (session_id, kind, next_sequence)
       VALUES ($1, $2, 2)
       ON CONFLICT (session_id, kind)
       DO UPDATE SET next_sequence = session_sequence_counters.next_sequence + 1
       RETURNING next_sequence - 1 AS sequence`,
      [sessionId, kind],
    );

    return Number(result.rows[0]!.sequence);
  }

  private async eventFromNotification(payload: string): Promise<EventRecord | null> {
    let id: unknown;
    try {
      id = (JSON.parse(payload) as { id?: unknown }).id;
    } catch {
      return null;
    }
    if (typeof id !== 'number' && typeof id !== 'string') return null;

    const result = await this.pool.query<EventRow>(
      `SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at
       FROM events
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? toEvent(result.rows[0]) : null;
  }

  private async finishRun(
    runId: string,
    leaseOwner: string,
    status: 'completed' | 'failed' | 'cancelled',
    finishedAt: Date,
    error?: string,
  ): Promise<ClaimedMessage | null> {
    const batch = await this.finishRunBatch(runId, leaseOwner, status, finishedAt, error);
    return batch ? { message: batch.messages[0]!, run: batch.run } : null;
  }

  private async finishRunBatch(
    runId: string,
    leaseOwner: string,
    status: 'completed' | 'failed' | 'cancelled',
    finishedAt: Date,
    error?: string,
  ): Promise<ClaimedMessageBatch | null> {
    return this.transaction(async (client) => {
      const runResult = await client.query<RunRow>(
        `UPDATE runs
         SET status = $2,
             lease_owner = NULL,
             lease_expires_at = NULL,
             heartbeat_at = $3,
              completed_at = CASE WHEN $2 = 'completed' THEN $3 ELSE completed_at END,
              failed_at = CASE WHEN $2 IN ('failed', 'cancelled') THEN $3 ELSE failed_at END,
             error = $4
         WHERE id = $1 AND lease_owner = $5
           AND (($2 = 'cancelled' AND status = 'cancelling')
             OR ($2 = 'completed' AND status = 'completing')
             OR ($2 = 'failed' AND status IN ('running', 'completing')))
           AND lease_expires_at > $3
           RETURNING id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata`,
        [runId, status, finishedAt, error ?? null, leaseOwner],
      );

      const run = runResult.rows[0];
      if (!run) return null;

      const messageIds = getRunMessageIds(toRun(run));
      const messageResult = await client.query<MessageRow>(
        `UPDATE messages
         SET status = $2
          WHERE id = ANY($1::uuid[]) AND status IN ('processing', 'cancelling')
            RETURNING id, session_id, sequence, status, prompt, steering, author_user_id, author_name, source, context, created_at`,
        [messageIds, status],
      );

      await client.query(
        `UPDATE sessions
        SET status = CASE
              WHEN status = 'archived' THEN 'archived'
              WHEN $2 = 'failed' THEN 'failed'
              WHEN EXISTS (SELECT 1 FROM messages WHERE session_id = $1 AND status = 'pending') THEN 'queued'
              ELSE 'idle'
            END,
            updated_at = $3,
            last_activity_at = $3
        WHERE id = $1`,
        [run.session_id, status, finishedAt],
      );
      const messages = messageResult.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence);
      const events: EventRecord[] = [];
      if (status === 'completed') {
        for (const message of messages) {
          const eventResult = await client.query<EventRow>(
            `WITH next_sequence AS (
               INSERT INTO session_sequence_counters (session_id, kind, next_sequence)
               VALUES ($1, 'events', 2)
               ON CONFLICT (session_id, kind) DO UPDATE
               SET next_sequence = session_sequence_counters.next_sequence + 1
               RETURNING next_sequence - 1 AS sequence
             ), inserted AS (
               INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
               SELECT $1, $2, $3, sequence, 'message_completed', $4, $5 FROM next_sequence
               ON CONFLICT (run_id, message_id, type) WHERE type = 'message_completed' DO NOTHING
               RETURNING id, session_id, run_id, message_id, sequence, type, payload, created_at
             )
             SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at,
                    pg_notify($6, json_build_object('id', id)::text)
             FROM inserted`,
            [run.session_id, run.id, message.id, { sequence: message.sequence }, finishedAt, eventNotificationChannel],
          );
          if (eventResult.rows[0]) events.push(toEvent(eventResult.rows[0]));
        }
      }

      return { messages, run: toRun(run), events };
    });
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async listEnvironmentRepositories(
    environmentId: string,
  ): Promise<EnvironmentWithDetailsRecord['repositories']> {
    const result = await this.pool.query<EnvironmentRepositoryRow>(
      `SELECT ${environmentRepositorySelectColumns}
       FROM environment_revision_repositories
       WHERE revision_id = (SELECT current_revision_id FROM environments WHERE id = $1)
       ORDER BY position ASC`,
      [environmentId],
    );
    return result.rows.map(toEnvironmentRepository);
  }

  private async listEnvironmentRevisionRepositories(
    revisionId: string,
  ): Promise<EnvironmentRevisionRecord['repositories']> {
    const result = await this.pool.query<EnvironmentRepositoryRow>(
      `SELECT ${environmentRepositorySelectColumns}
       FROM environment_revision_repositories
       WHERE revision_id = $1
       ORDER BY position ASC`,
      [revisionId],
    );
    return result.rows.map((row) => {
      const repository = toEnvironmentRepository(row);
      return {
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo,
        primary: repository.isPrimary,
        position: repository.position,
        ...(repository.branch ? { branch: repository.branch } : {}),
      };
    });
  }
}

async function insertEnvironmentRepositories(
  client: PoolClient,
  repositories: CreateEnvironmentRecord['repositories'],
): Promise<EnvironmentWithDetailsRecord['repositories']> {
  const inserted = [];
  for (const repository of repositories) {
    const result = await client.query<EnvironmentRepositoryRow>(
      `INSERT INTO environment_revision_repositories (
         id,
         revision_id,
         provider,
         owner,
         repo,
         branch,
         is_primary,
         position,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${environmentRepositorySelectColumns}`,
      [
        repository.id,
        repository.revisionId,
        repository.provider,
        repository.owner,
        repository.repo,
        repository.branch ?? null,
        repository.isPrimary,
        repository.position,
        repository.createdAt,
        repository.updatedAt,
      ],
    );
    inserted.push(toEnvironmentRepository(result.rows[0]!));
  }
  return inserted.sort((left, right) => left.position - right.position);
}

async function listEnvironmentRepositoriesWithClient(
  client: PoolClient,
  environmentId: string,
): Promise<EnvironmentWithDetailsRecord['repositories']> {
  const result = await client.query<EnvironmentRepositoryRow>(
    `SELECT ${environmentRepositorySelectColumns}
     FROM environment_revision_repositories
     WHERE revision_id = (SELECT current_revision_id FROM environments WHERE id = $1)
     ORDER BY position ASC`,
    [environmentId],
  );
  return result.rows.map(toEnvironmentRepository);
}

async function insertEnvironmentRevision(client: PoolClient, revision: EnvironmentRevisionRecord): Promise<void> {
  await client.query(
    `INSERT INTO environment_revisions (
       id, environment_id, revision_number, actor_type, actor_user_id, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      revision.id,
      revision.environmentId,
      revision.revisionNumber,
      revision.actorType,
      revision.actorUserId ?? null,
      revision.createdAt,
    ],
  );
}

async function insertEnvironmentActivities(client: PoolClient, activities: EnvironmentActivityRecord[]): Promise<void> {
  for (const activity of activities) {
    await client.query(
      `INSERT INTO environment_activity (
         id, environment_id, type, actor_type, actor_user_id, revision_id, payload, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        activity.id,
        activity.environmentId,
        activity.type,
        activity.actorType,
        activity.actorUserId ?? null,
        activity.revisionId ?? null,
        activity.payload,
        activity.createdAt,
      ],
    );
  }
}

function appendSessionFilterWhereClauses(
  options: {
    tags?: string[];
    createdByUserId?: string;
    participantUserId?: string;
    starredByUserId?: string;
  },
  values: unknown[],
  where: string[],
  alias = 'sessions',
): void {
  if (options.tags?.length) {
    values.push(options.tags);
    where.push(`${alias}.tags @> $${values.length}::text[]`);
  }
  if (options.createdByUserId) {
    values.push(options.createdByUserId);
    where.push(`${alias}.created_by_user_id = $${values.length}::uuid`);
  }
  if (options.participantUserId) {
    values.push(options.participantUserId);
    where.push(
      `EXISTS (SELECT 1 FROM messages WHERE messages.session_id = ${alias}.id AND messages.author_user_id = $${values.length}::uuid)`,
    );
  }
  if (options.starredByUserId) {
    values.push(options.starredByUserId);
    where.push(
      `EXISTS (SELECT 1 FROM session_stars WHERE session_stars.session_id = ${alias}.id AND session_stars.user_id = $${values.length}::uuid)`,
    );
  }
}

function pageSessionRows(rows: SessionWithSandboxRow[], limit: number): SessionWithSandboxPage {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(toSessionWithSandbox),
    nextCursor:
      rows.length > limit && last
        ? { lastActivityAt: last.last_activity_at, createdAt: last.created_at, id: last.id }
        : null,
  };
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function uniqueSessionSearchDocs(docs: SessionSearchDocInput[]): SessionSearchDocInput[] {
  const byKey = new Map<string, SessionSearchDocInput>();
  for (const doc of docs) byKey.set(`${doc.sessionId}:${doc.kind}:${doc.sourceId}`, doc);
  return [...byKey.values()];
}

function cleanSearchDocContent(value: string): string {
  return value.replaceAll('\u0000', '').slice(0, maxSearchDocContentChars);
}

async function insertLifecycleEvent(client: PoolClient, event: NormalizedEvent): Promise<EventRecord> {
  const inserted = await client.query<EventRow>(
    `WITH next_sequence AS (
       INSERT INTO session_sequence_counters (session_id, kind, next_sequence)
       VALUES ($1, 'events', 2)
       ON CONFLICT (session_id, kind)
       DO UPDATE SET next_sequence = session_sequence_counters.next_sequence + 1
       RETURNING next_sequence - 1 AS sequence
     ), inserted AS (
       INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
       SELECT $1, $2, $3, sequence, $4, $5, $6
       FROM next_sequence
       RETURNING id, session_id, run_id, message_id, sequence, type, payload, created_at
     )
     SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at,
            pg_notify($7, json_build_object('id', id)::text)
     FROM inserted`,
    [
      event.sessionId,
      event.runId ?? null,
      event.messageId ?? null,
      event.type,
      event.payload,
      event.createdAt,
      eventNotificationChannel,
    ],
  );
  return toEvent(inserted.rows[0]!);
}

async function assertAutomationEnvironmentAvailableWithClient(
  client: PoolClient,
  environmentId: string | undefined,
  environmentRevisionId: string | undefined,
): Promise<void> {
  if (!environmentId) return;
  const environment = await client.query<{ id: string }>(
    `SELECT id
     FROM environments
     WHERE id = $1 AND archived_at IS NULL
       AND ($2::uuid IS NULL OR EXISTS (
         SELECT 1
         FROM environment_revisions
         WHERE environment_id = $1 AND id = $2
       ))
     FOR SHARE`,
    [environmentId, environmentRevisionId ?? null],
  );
  if (!environment.rows[0]) {
    throw new StoreConflictError('automation_environment_unavailable', 'Environment is no longer available');
  }
}

const executionContextKeys = ['repository', 'branch', 'environment', 'model', 'reasoningLevel'] as const;

function executionSignature(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    executionContextKeys.filter((key) => context[key] != null).map((key) => [key, context[key]]),
  );
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint,
  );
}

type SnippetRow = {
  id: string;
  owner_user_id: string;
  name: string;
  body: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toSnippet(row: SnippetRow): SnippetRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    body: row.body,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function throwSnippetConflict(error: unknown): never {
  if (isUniqueViolation(error, 'snippets_active_owner_name_unique')) {
    throw new StoreConflictError('snippet_name_exists', 'A snippet with this name already exists');
  }
  throw error;
}

type SessionNotepadRow = {
  session_id: string;
  revision: number;
  content: string;
  size_bytes: number;
  created_at: Date;
  updated_at: Date;
};
type ExplicitNotepadRow = Omit<SessionNotepadRow, 'session_id'> & {
  id: string;
  title: string;
  created_by_user_id: string | null;
  archived_at: Date | null;
};
type NotepadRevisionRow = {
  notepad_kind: NotepadRevisionRecord['notepadKind'];
  notepad_id: string;
  revision: number;
  content: string;
  size_bytes: number;
  actor: unknown;
  mutation_kind: NotepadMutationKind;
  created_at: Date;
};
type NotepadAssociationRow = {
  notepad_id: string;
  session_id: string;
  created_by_user_id: string | null;
  created_at: Date;
};
type NotepadCapabilityRow = {
  session_id: string;
  kind: SessionNotepadCapabilityRecord['kind'];
  granted_by_user_id: string;
  created_at: Date;
};

function toSessionNotepad(r: SessionNotepadRow): SessionNotepadRecord {
  return {
    sessionId: r.session_id,
    revision: r.revision,
    content: r.content,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toExplicitNotepad(r: ExplicitNotepadRow): ExplicitNotepadRecord {
  return {
    id: r.id,
    title: r.title,
    revision: r.revision,
    content: r.content,
    sizeBytes: r.size_bytes,
    ...(r.created_by_user_id ? { createdByUserId: r.created_by_user_id } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.archived_at ? { archivedAt: r.archived_at } : {}),
  };
}
function toExplicitMetadata(r: Omit<ExplicitNotepadRow, 'content'>) {
  return {
    id: r.id,
    title: r.title,
    revision: r.revision,
    sizeBytes: r.size_bytes,
    ...(r.created_by_user_id ? { createdByUserId: r.created_by_user_id } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.archived_at ? { archivedAt: r.archived_at } : {}),
  };
}
function toNotepadRevision(r: NotepadRevisionRow): NotepadRevisionRecord {
  return {
    notepadKind: r.notepad_kind,
    notepadId: r.notepad_id,
    revision: r.revision,
    content: r.content,
    sizeBytes: r.size_bytes,
    actor: parseNotepadActor(r.actor),
    mutationKind: r.mutation_kind,
    createdAt: r.created_at,
  };
}
function toNotepadRevisionMetadata(r: Omit<NotepadRevisionRow, 'content'>) {
  return {
    notepadKind: r.notepad_kind,
    notepadId: r.notepad_id,
    revision: r.revision,
    sizeBytes: r.size_bytes,
    actor: parseNotepadActor(r.actor),
    mutationKind: r.mutation_kind,
    createdAt: r.created_at,
  };
}
function toAssociation(r: NotepadAssociationRow): NotepadAssociationRecord {
  return {
    notepadId: r.notepad_id,
    sessionId: r.session_id,
    ...(r.created_by_user_id ? { createdByUserId: r.created_by_user_id } : {}),
    createdAt: r.created_at,
  };
}
function toCapability(r: NotepadCapabilityRow): SessionNotepadCapabilityRecord {
  return { sessionId: r.session_id, kind: r.kind, grantedByUserId: r.granted_by_user_id, createdAt: r.created_at };
}
function toNotepadActivity(r: {
  id: string;
  notepad_id: string;
  actor: unknown;
  kind: NotepadActivityRecord['kind'];
  metadata: Record<string, unknown>;
  created_at: Date;
}): NotepadActivityRecord {
  return {
    id: r.id,
    notepadId: r.notepad_id,
    actor: parseNotepadActor(r.actor),
    kind: r.kind,
    metadata: r.metadata,
    createdAt: r.created_at,
  };
}

function parseNotepadActor(value: unknown): NotepadActor {
  if (!value || typeof value !== 'object' || !('kind' in value)) throw new Error('Invalid notepad revision actor');
  const actor = value as Record<string, unknown>;
  if (actor.kind === 'system') return { kind: 'system' };
  if (actor.kind === 'human' && typeof actor.userId === 'string') return { kind: 'human', userId: actor.userId };
  if (actor.kind === 'agent' && typeof actor.sessionId === 'string' && typeof actor.runId === 'string')
    return { kind: 'agent', sessionId: actor.sessionId, runId: actor.runId };
  throw new Error('Invalid notepad revision actor');
}

function sqlPage<T>(rows: T[], limit: number, offset: number) {
  const hasMore = rows.length > limit;
  return { items: rows.slice(0, limit), hasMore, nextCursor: hasMore ? String(offset + limit) : null };
}
