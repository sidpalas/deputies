import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { NormalizedEvent, NormalizedEventPayload, NormalizedEventType } from '../events/types.js';
import { defaultGroupId, StoreConflictError } from './types.js';
import type {
  AppStore,
  ArtifactRecord,
  AuthSessionRecord,
  AuthUserRecord,
  CallbackDeliveryRecord,
  CallbackDeliveryStatus,
  CreateArtifactRecord,
  CreateCallbackDeliveryRecord,
  CreateExternalResourceRecord,
  ClaimedMessage,
  ClaimedMessageBatch,
  CreateMessageRecord,
  CreateSandboxRecord,
  CreateSessionRecord,
  CreateWebhookSourceRecord,
  EventRecord,
  ExternalResourceRecord,
  ExternalThreadRecord,
  GroupMemberRecord,
  GroupMemberWithUserRecord,
  GroupRecord,
  GroupRole,
  IntegrationDeliveryRecord,
  MessageRecord,
  MessageStatus,
  RecoveredRun,
  RunRecord,
  RunStatus,
  SandboxRecord,
  SandboxSecrets,
  SandboxStatus,
  SessionRecord,
  SessionStatus,
  SessionVisibility,
  SessionWritePolicy,
  UpsertAuthUserForAccountRecord,
  WebhookSourceRecord,
} from './types.js';
import { SecretCipher } from './encrypted-secrets.js';

type SessionRow = QueryResultRow & {
  id: string;
  status: SessionStatus;
  title: string | null;
  context: Record<string, unknown> | null;
  owner_group_id: string;
  visibility: SessionVisibility;
  write_policy: SessionWritePolicy;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  queue_paused_at: Date | null;
};

type PgInteger = number | string;

const sessionSelectColumns =
  'id, status, title, context, owner_group_id, visibility, write_policy, created_by_user_id, created_at, updated_at, queue_paused_at';

type AuthUserRow = QueryResultRow & {
  id: string;
  username: string;
  role: 'user' | 'super_admin';
  display_name: string | null;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
};

type GroupRow = QueryResultRow & {
  id: string;
  name: string;
  default_visibility: SessionVisibility;
  default_write_policy: SessionWritePolicy;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type GroupMemberRow = QueryResultRow & {
  group_id: string;
  user_id: string;
  role: GroupRole;
  created_at: Date;
  updated_at: Date;
};

type GroupMemberWithUserRow = GroupMemberRow & {
  username: string;
  user_role: 'user' | 'super_admin';
  display_name: string | null;
  avatar_url: string | null;
  user_created_at: Date;
  user_updated_at: Date;
};

type AuthSessionRow = QueryResultRow & {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
};

type MessageRow = QueryResultRow & {
  id: string;
  session_id: string;
  sequence: PgInteger;
  status: MessageStatus;
  prompt: string;
  author_user_id: string | null;
  author_name: string | null;
  source: string | null;
  context: Record<string, unknown> | null;
  created_at: Date;
};

type EventRow = QueryResultRow & {
  id: PgInteger;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  sequence: PgInteger;
  type: NormalizedEventType;
  payload: Record<string, unknown>;
  created_at: Date;
};

type RunRow = QueryResultRow & {
  id: string;
  session_id: string;
  message_id: string;
  status: RunStatus;
  runner_type: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  attempt: number;
  started_at: Date;
  completed_at: Date | null;
  failed_at: Date | null;
  error: string | null;
  metadata: Record<string, unknown>;
};

type SandboxRow = QueryResultRow & {
  id: string;
  session_id: string;
  provider: string;
  provider_sandbox_id: string;
  status: SandboxStatus;
  workspace_path: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  last_health_check_at: Date | null;
  keepalive_until: Date | null;
  destroyed_at: Date | null;
};

type ArtifactRow = QueryResultRow & {
  id: string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  type: string;
  title: string | null;
  url: string | null;
  storage_key: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
};

type ExternalResourceRow = QueryResultRow & {
  id: string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  type: string;
  title: string | null;
  url: string;
  metadata: Record<string, unknown>;
  created_at: Date;
};

type CallbackDeliveryRow = QueryResultRow & {
  id: string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  target_type: 'http' | 'slack' | 'github';
  target: Record<string, unknown>;
  status: CallbackDeliveryStatus;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  delivered_at: Date | null;
};

type WebhookSourceRow = QueryResultRow & {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  bearer_token: string;
  prompt_prefix: string | null;
  created_at: Date;
  updated_at: Date;
};

type ExternalThreadRow = QueryResultRow & {
  id: string;
  source: string;
  external_id: string;
  session_id: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type IntegrationDeliveryRow = QueryResultRow & {
  id: string;
  source: string;
  dedupe_key: string;
  status: 'received' | 'processed' | 'failed';
  received_at: Date;
  processed_at: Date | null;
  error: string | null;
  metadata: Record<string, unknown>;
};

const staleCallbackSendingMs = 15 * 60_000;
const eventNotificationChannel = 'app_events';

export type PostgresEventListener = {
  close(): Promise<void>;
};

export class PostgresStore implements AppStore {
  private readonly pool: Pool;
  private readonly secretCipher?: SecretCipher;

  constructor(databaseUrl: string | Pool, options: { sandboxSecretEncryptionKey?: string } = {}) {
    this.pool = typeof databaseUrl === 'string' ? new Pool({ connectionString: databaseUrl }) : databaseUrl;
    if (options.sandboxSecretEncryptionKey)
      this.secretCipher = new SecretCipher(options.sandboxSecretEncryptionKey, 'sandbox-secrets');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listenEvents(onEvent: (event: EventRecord) => void): Promise<PostgresEventListener> {
    const client = await this.pool.connect();
    let closed = false;
    const handleNotification = (message: { channel: string; payload?: string | undefined }) => {
      if (message.channel !== eventNotificationChannel || !message.payload) return;
      void this.eventFromNotification(message.payload)
        .then((event) => {
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
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM auth_accounts WHERE provider = $1 AND provider_account_id = $2',
        [record.provider, record.providerAccountId],
      );
      const userId = existing.rows[0]?.user_id ?? record.userId;
      const existingUser = await client.query<Pick<AuthUserRow, 'role'>>('SELECT role FROM auth_users WHERE id = $1', [
        userId,
      ]);
      const role = existingUser.rows[0]?.role === 'super_admin' ? 'super_admin' : record.role;
      const userResult = await client.query<AuthUserRow>(
        `INSERT INTO auth_users (id, username, role, display_name, avatar_url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (id) DO UPDATE
         SET username = EXCLUDED.username,
             role = EXCLUDED.role,
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
    const result = await this.pool.query<AuthUserRow>(
      `UPDATE auth_users
       SET role = $2,
           updated_at = $3
       WHERE id = $1
       RETURNING id, username, role, display_name, avatar_url, created_at, updated_at`,
      [input.userId, input.role, input.updatedAt],
    );
    return result.rows[0] ? toAuthUser(result.rows[0]) : null;
  }

  async createGroup(record: GroupRecord): Promise<GroupRecord> {
    try {
      const result = await this.pool.query<GroupRow>(
        `INSERT INTO groups (id, name, default_visibility, default_write_policy, archived_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, default_visibility, default_write_policy, archived_at, created_at, updated_at`,
        [
          record.id,
          record.name.trim(),
          record.defaultVisibility,
          record.defaultWritePolicy,
          record.archivedAt ?? null,
          record.createdAt,
          record.updatedAt,
        ],
      );
      return toGroup(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error, 'groups_name_unique_idx')) {
        throw new StoreConflictError('group_name_exists', 'Group name already exists');
      }
      throw error;
    }
  }

  async getGroup(id: string): Promise<GroupRecord | null> {
    const result = await this.pool.query<GroupRow>(
      `SELECT id, name, default_visibility, default_write_policy, archived_at, created_at, updated_at
       FROM groups
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? toGroup(result.rows[0]) : null;
  }

  async listGroups(): Promise<GroupRecord[]> {
    const result = await this.pool.query<GroupRow>(
      `SELECT id, name, default_visibility, default_write_policy, archived_at, created_at, updated_at
       FROM groups
       ORDER BY archived_at ASC NULLS FIRST, name ASC`,
    );
    return result.rows.map(toGroup);
  }

  async updateGroup(record: GroupRecord): Promise<GroupRecord> {
    try {
      const result = await this.pool.query<GroupRow>(
        `UPDATE groups
         SET name = $2,
             default_visibility = $3,
             default_write_policy = $4,
             archived_at = $5,
             updated_at = $6
         WHERE id = $1
         RETURNING id, name, default_visibility, default_write_policy, archived_at, created_at, updated_at`,
        [
          record.id,
          record.name.trim(),
          record.defaultVisibility,
          record.defaultWritePolicy,
          record.archivedAt ?? null,
          record.updatedAt,
        ],
      );
      if (!result.rows[0]) throw new Error(`Group does not exist: ${record.id}`);
      return toGroup(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error, 'groups_name_unique_idx')) {
        throw new StoreConflictError('group_name_exists', 'Group name already exists');
      }
      throw error;
    }
  }

  async upsertGroupMember(record: GroupMemberRecord): Promise<GroupMemberRecord> {
    const result = await this.pool.query<GroupMemberRow>(
      `INSERT INTO group_members (group_id, user_id, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_id, user_id) DO UPDATE
       SET role = EXCLUDED.role,
           updated_at = EXCLUDED.updated_at
       RETURNING group_id, user_id, role, created_at, updated_at`,
      [record.groupId, record.userId, record.role, record.createdAt, record.updatedAt],
    );
    return toGroupMember(result.rows[0]!);
  }

  async deleteGroupMember(input: { groupId: string; userId: string }): Promise<void> {
    await this.pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [
      input.groupId,
      input.userId,
    ]);
  }

  async getGroupMember(input: { groupId: string; userId: string }): Promise<GroupMemberRecord | null> {
    const result = await this.pool.query<GroupMemberRow>(
      `SELECT group_id, user_id, role, created_at, updated_at
       FROM group_members
       WHERE group_id = $1 AND user_id = $2`,
      [input.groupId, input.userId],
    );
    return result.rows[0] ? toGroupMember(result.rows[0]) : null;
  }

  async listGroupMembers(groupId: string): Promise<GroupMemberWithUserRecord[]> {
    const result = await this.pool.query<GroupMemberWithUserRow>(
      `SELECT m.group_id,
              m.user_id,
              m.role,
              m.created_at,
              m.updated_at,
              u.username,
              u.role AS user_role,
              u.display_name,
              u.avatar_url,
              u.created_at AS user_created_at,
              u.updated_at AS user_updated_at
       FROM group_members m
       JOIN auth_users u ON u.id = m.user_id
       WHERE m.group_id = $1
       ORDER BY u.username ASC`,
      [groupId],
    );
    return result.rows.map(toGroupMemberWithUser);
  }

  async listUserGroupMemberships(userId: string): Promise<GroupMemberRecord[]> {
    const result = await this.pool.query<GroupMemberRow>(
      `SELECT group_id, user_id, role, created_at, updated_at
       FROM group_members
       WHERE user_id = $1`,
      [userId],
    );
    return result.rows.map(toGroupMember);
  }

  async createSession(record: CreateSessionRecord): Promise<SessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (
         id,
         status,
         title,
         context,
         owner_group_id,
         visibility,
         write_policy,
         created_by_user_id,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${sessionSelectColumns}`,
      [
        record.id,
        record.status,
        record.title ?? null,
        record.context ?? null,
        record.ownerGroupId,
        record.visibility,
        record.writePolicy,
        record.createdByUserId ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );

    return toSession(result.rows[0]!);
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
      `SELECT ${sessionSelectColumns} FROM sessions ORDER BY updated_at DESC, created_at DESC`,
    );

    return result.rows.map(toSession);
  }

  async updateSession(record: SessionRecord): Promise<SessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions
       SET status = $2,
           title = $3,
           context = $4,
           created_at = $5,
           updated_at = $6,
           owner_group_id = $7,
           visibility = $8,
           write_policy = $9,
           created_by_user_id = $10
       WHERE id = $1
       RETURNING ${sessionSelectColumns}`,
      [
        record.id,
        record.status,
        record.title ?? null,
        record.context ?? null,
        record.createdAt,
        record.updatedAt,
        record.ownerGroupId,
        record.visibility,
        record.writePolicy,
        record.createdByUserId ?? null,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new Error(`Session does not exist: ${record.id}`);
    return toSession(row);
  }

  async archiveSession(input: { sessionId: string; archivedAt: Date }): Promise<{
    session: SessionRecord;
    cancelledMessages: MessageRecord[];
  }> {
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [input.sessionId]);

      const cancelled = await client.query<MessageRow>(
        `UPDATE messages
         SET status = 'cancelled'
         WHERE session_id = $1 AND status = 'pending'
         RETURNING id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at`,
        [input.sessionId],
      );

      const result = await client.query<SessionRow>(
        `UPDATE sessions
         SET status = 'archived', updated_at = $2
         WHERE id = $1
         RETURNING ${sessionSelectColumns}`,
        [input.sessionId, input.archivedAt],
      );

      const row = result.rows[0];
      if (!row) throw new Error(`Session does not exist: ${input.sessionId}`);
      return {
        session: toSession(row),
        cancelledMessages: cancelled.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence),
      };
    });
  }

  async updateSessionForRun(input: {
    record: SessionRecord;
    runId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<SessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions
       SET status = $2,
           title = $3,
           context = $4,
           created_at = $5,
           updated_at = $6,
           owner_group_id = $10,
           visibility = $11,
           write_policy = $12,
           created_by_user_id = $13
       WHERE id = $1
         AND EXISTS (
           SELECT 1 FROM runs
           WHERE id = $7
              AND session_id = $1
              AND lease_owner = $8
              AND status IN ('running', 'cancelling')
              AND lease_expires_at > $9
         )
       RETURNING ${sessionSelectColumns}`,
      [
        input.record.id,
        input.record.status,
        input.record.title ?? null,
        input.record.context ?? null,
        input.record.createdAt,
        input.record.updatedAt,
        input.runId,
        input.leaseOwner,
        input.now,
        input.record.ownerGroupId,
        input.record.visibility,
        input.record.writePolicy,
        input.record.createdByUserId ?? null,
      ],
    );

    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async pauseSessionQueue(input: { sessionId: string; pausedAt: Date }): Promise<SessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions SET queue_paused_at = $2, updated_at = $2 WHERE id = $1
       RETURNING ${sessionSelectColumns}`,
      [input.sessionId, input.pausedAt],
    );
    if (!result.rows[0]) throw new Error(`Session does not exist: ${input.sessionId}`);
    return toSession(result.rows[0]);
  }

  async resumeSessionQueue(input: { sessionId: string }): Promise<SessionRecord> {
    const now = new Date();
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions SET queue_paused_at = NULL, updated_at = $2 WHERE id = $1
       RETURNING ${sessionSelectColumns}`,
      [input.sessionId, now],
    );
    if (!result.rows[0]) throw new Error(`Session does not exist: ${input.sessionId}`);
    return toSession(result.rows[0]);
  }

  async nextMessageSequence(sessionId: string): Promise<number> {
    return this.nextSequence(sessionId, 'messages');
  }

  async createMessage(record: CreateMessageRecord): Promise<MessageRecord> {
    return this.transaction(async (client) => {
      const result = await client.query<MessageRow>(
        `INSERT INTO messages (id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at`,
        [
          record.id,
          record.sessionId,
          record.sequence,
          record.status,
          record.prompt,
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
             updated_at = $2
           WHERE id = $1`,
          [record.sessionId, record.createdAt],
        );
      }

      return toMessage(result.rows[0]!);
    });
  }

  async getMessages(sessionId: string): Promise<MessageRecord[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at
       FROM messages
       WHERE session_id = $1
       ORDER BY sequence ASC`,
      [sessionId],
    );

    return result.rows.map(toMessage);
  }

  async updatePendingMessage(input: {
    sessionId: string;
    messageId: string;
    prompt: string;
  }): Promise<MessageRecord | null> {
    const result = await this.pool.query<MessageRow>(
      `UPDATE messages SET prompt = $3 WHERE session_id = $1 AND id = $2 AND status = 'pending'
       RETURNING id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at`,
      [input.sessionId, input.messageId, input.prompt],
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
         RETURNING id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at`,
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
           updated_at = $2
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
                AND r.status IN ('starting', 'running', 'cancelling')
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
          RETURNING id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at`,
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

      await client.query('UPDATE sessions SET status = $2, updated_at = $3 WHERE id = $1', [
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
         WHERE id = $1 AND lease_owner = $2 AND status IN ('running', 'cancelling') AND lease_expires_at > $4
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
            RETURNING id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at`,
          [messageIds],
        );

        const messages = messageResult.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence);
        if (!messages[0]) continue;

        await client.query(
          `UPDATE sessions
           SET status = CASE
                 WHEN status = 'archived' THEN 'archived'
                 WHEN EXISTS (SELECT 1 FROM messages WHERE session_id = $1 AND status = 'pending') THEN 'queued'
                 ELSE 'idle'
               END,
               updated_at = $2
           WHERE id = $1`,
          [staleRun.session_id, input.now],
        );

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
          RETURNING id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at`,
        [messageIds],
      );

      await client.query('UPDATE sessions SET status = $2, updated_at = $3 WHERE id = $1', [
        input.sessionId,
        'active',
        input.requestedAt,
      ]);

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
    return toArtifact(result.rows[0]!);
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
    return toCallbackDelivery(result.rows[0]!);
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
           AND status IN ('running', 'cancelling')
           AND lease_expires_at > $10
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

  async getEvents(sessionId: string, afterSequence = 0): Promise<EventRecord[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at
       FROM events
       WHERE session_id = $1 AND sequence > $2
       ORDER BY sequence ASC`,
      [sessionId, afterSequence],
    );

    return result.rows.map(toEvent);
  }

  async listEvents(afterId = 0): Promise<EventRecord[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id, session_id, run_id, message_id, sequence, type, payload, created_at
       FROM events
       WHERE id > $1
       ORDER BY id ASC`,
      [afterId],
    );

    return result.rows.map(toEvent);
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
         WHERE id = $1 AND lease_owner = $5 AND status IN ('running', 'cancelling') AND lease_expires_at > $3
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
            RETURNING id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at`,
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
            updated_at = $3
        WHERE id = $1`,
        [run.session_id, status, finishedAt],
      );

      return { messages: messageResult.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence), run: toRun(run) };
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
}

function toAuthUser(row: AuthUserRow): AuthUserRecord {
  const user: AuthUserRecord = {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.display_name) user.displayName = row.display_name;
  if (row.avatar_url) user.avatarUrl = row.avatar_url;
  return user;
}

function toAuthSession(row: AuthSessionRow): AuthSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toGroup(row: GroupRow): GroupRecord {
  return {
    id: row.id,
    name: row.name,
    defaultVisibility: row.default_visibility,
    defaultWritePolicy: row.default_write_policy,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

function toGroupMember(row: GroupMemberRow): GroupMemberRecord {
  return {
    groupId: row.group_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGroupMemberWithUser(row: GroupMemberWithUserRow): GroupMemberWithUserRecord {
  return {
    ...toGroupMember(row),
    user: {
      id: row.user_id,
      username: row.username,
      role: row.user_role,
      createdAt: row.user_created_at,
      updatedAt: row.user_updated_at,
      ...(row.display_name ? { displayName: row.display_name } : {}),
      ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
    },
  };
}

function toSession(row: SessionRow): SessionRecord {
  const record: SessionRecord = {
    id: row.id,
    status: row.status,
    ownerGroupId: row.owner_group_id ?? defaultGroupId,
    visibility: row.visibility ?? 'organization',
    writePolicy: row.write_policy ?? 'group_members',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.title) record.title = row.title;
  if (row.queue_paused_at) record.queuePausedAt = row.queue_paused_at;
  if (row.created_by_user_id) record.createdByUserId = row.created_by_user_id;
  if (row.context) record.context = row.context;
  return record;
}

function getRunMessageIds(run: RunRecord): string[] {
  const messageIds = run.metadata.messageIds;
  if (Array.isArray(messageIds) && messageIds.every((id) => typeof id === 'string')) return messageIds;
  return [run.messageId];
}

function toMessage(row: MessageRow): MessageRecord {
  const record: MessageRecord = {
    id: row.id,
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    status: row.status,
    prompt: row.prompt,
    createdAt: row.created_at,
  };
  if (row.author_user_id) record.authorUserId = row.author_user_id;
  if (row.source) record.source = row.source;
  if (row.author_name) record.authorName = row.author_name;
  if (row.context) record.context = row.context;
  return record;
}

function toEvent(row: EventRow): EventRecord {
  const event = {
    id: Number(row.id),
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    type: row.type,
    payload: row.payload as NormalizedEventPayload,
    createdAt: row.created_at,
  } as EventRecord;
  if (row.run_id) event.runId = row.run_id;
  if (row.message_id) event.messageId = row.message_id;
  return event;
}

function toRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    status: row.status,
    runnerType: row.runner_type,
    attempt: row.attempt,
    startedAt: row.started_at,
    metadata: row.metadata,
  };
  if (row.lease_owner) run.leaseOwner = row.lease_owner;
  if (row.lease_expires_at) run.leaseExpiresAt = row.lease_expires_at;
  if (row.heartbeat_at) run.heartbeatAt = row.heartbeat_at;
  if (row.completed_at) run.completedAt = row.completed_at;
  if (row.failed_at) run.failedAt = row.failed_at;
  if (row.error) run.error = row.error;
  return run;
}

function toSandbox(row: SandboxRow): SandboxRecord {
  const record: SandboxRecord = {
    id: row.id,
    sessionId: row.session_id,
    provider: row.provider,
    providerSandboxId: row.provider_sandbox_id,
    status: row.status,
    workspacePath: row.workspace_path,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.last_health_check_at) record.lastHealthCheckAt = row.last_health_check_at;
  if (row.keepalive_until) record.keepaliveUntil = row.keepalive_until;
  if (row.destroyed_at) record.destroyedAt = row.destroyed_at;
  return record;
}

function toArtifact(row: ArtifactRow): ArtifactRecord {
  const record: ArtifactRecord = {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  };
  if (row.run_id) record.runId = row.run_id;
  if (row.message_id) record.messageId = row.message_id;
  if (row.title) record.title = row.title;
  if (row.url) record.url = row.url;
  if (row.storage_key) record.storageKey = row.storage_key;
  return record;
}

function toExternalResource(row: ExternalResourceRow): ExternalResourceRecord {
  const record: ExternalResourceRecord = {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    url: row.url,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
  if (row.run_id) record.runId = row.run_id;
  if (row.message_id) record.messageId = row.message_id;
  if (row.title) record.title = row.title;
  return record;
}

function toCallbackDelivery(row: CallbackDeliveryRow): CallbackDeliveryRecord {
  const record: CallbackDeliveryRecord = {
    id: row.id,
    sessionId: row.session_id,
    targetType: row.target_type,
    target: row.target,
    status: row.status,
    eventType: row.event_type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.run_id) record.runId = row.run_id;
  if (row.message_id) record.messageId = row.message_id;
  if (row.last_error) record.lastError = row.last_error;
  if (row.next_attempt_at) record.nextAttemptAt = row.next_attempt_at;
  if (row.last_attempt_at) record.lastAttemptAt = row.last_attempt_at;
  if (row.delivered_at) record.deliveredAt = row.delivered_at;
  return record;
}

function toWebhookSource(row: WebhookSourceRow): WebhookSourceRecord {
  const record: WebhookSourceRecord = {
    id: row.id,
    key: row.key,
    name: row.name,
    enabled: row.enabled,
    bearerToken: row.bearer_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.prompt_prefix) record.promptPrefix = row.prompt_prefix;
  return record;
}

function toExternalThread(row: ExternalThreadRow): ExternalThreadRecord {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    sessionId: row.session_id,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIntegrationDelivery(row: IntegrationDeliveryRow): IntegrationDeliveryRecord {
  const record: IntegrationDeliveryRecord = {
    id: row.id,
    source: row.source,
    dedupeKey: row.dedupe_key,
    status: row.status,
    receivedAt: row.received_at,
    metadata: row.metadata,
  };
  if (row.processed_at) record.processedAt = row.processed_at;
  if (row.error) record.error = row.error;
  return record;
}
