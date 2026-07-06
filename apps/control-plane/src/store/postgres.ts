import { Pool, type PoolClient } from 'pg';
import type { NormalizedEvent } from '../events/types.js';
import { StoreConflictError } from './types.js';
import type {
  AppStore,
  ArtifactRecord,
  AutomationInvocationRecord,
  AutomationRecord,
  AuthSessionRecord,
  AuthUserRecord,
  CallbackDeliveryRecord,
  CreateAutomationInvocationRecord,
  CreateAutomationRecord,
  CreateArtifactRecord,
  CreateCallbackDeliveryRecord,
  CreateExternalResourceRecord,
  ClaimedMessage,
  ClaimedMessageBatch,
  CreateMessageRecord,
  CreateSandboxRecord,
  CreateSessionRecord,
  CreateSessionWithFirstMessageInput,
  CreateSessionWithFirstMessageResult,
  CreateWebhookSourceRecord,
  EventDeltaCompactionInput,
  EventRecord,
  ExternalResourceRecord,
  ExternalThreadRecord,
  GroupMemberRecord,
  GroupMemberWithUserRecord,
  GroupRecord,
  IntegrationDeliveryRecord,
  ListAutomationInvocationsOptions,
  MessageRecord,
  RecoveredRun,
  RunRecord,
  SandboxRecord,
  SandboxSecrets,
  SessionRecord,
  SessionVisibilityFilter,
  SessionWithSandboxRecord,
  UpdateAutomationRecord,
  UpsertAuthUserForAccountRecord,
  WebhookSourceRecord,
} from './types.js';
import { SecretCipher } from './encrypted-secrets.js';
import {
  automationInvocationSelectColumns,
  automationSelectColumns,
  getRunMessageIds,
  groupSelectColumns,
  sessionSelectColumns,
  toArtifact,
  toAutomation,
  toAutomationInvocation,
  toAuthSession,
  toAuthUser,
  toCallbackDelivery,
  toEvent,
  toExternalResource,
  toExternalThread,
  toGroup,
  toGroupMember,
  toGroupMemberWithUser,
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
  type ExternalResourceRow,
  type ExternalThreadRow,
  type GroupMemberRow,
  type GroupMemberWithUserRow,
  type GroupRow,
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
const joinedSessionSelectColumns = sessionSelectColumns
  .split(', ')
  .map((column) => `sessions.${column}`)
  .join(', ');

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
        `INSERT INTO groups (id, name, default_visibility, default_write_policy, automation_create_required_role, archived_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${groupSelectColumns}`,
        [
          record.id,
          record.name.trim(),
          record.defaultVisibility,
          record.defaultWritePolicy,
          record.automationCreateRequiredRole,
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
      `SELECT ${groupSelectColumns}
       FROM groups
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? toGroup(result.rows[0]) : null;
  }

  async listGroups(): Promise<GroupRecord[]> {
    const result = await this.pool.query<GroupRow>(
      `SELECT ${groupSelectColumns}
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
              automation_create_required_role = $5,
              archived_at = $6,
              updated_at = $7
          WHERE id = $1
          RETURNING ${groupSelectColumns}`,
        [
          record.id,
          record.name.trim(),
          record.defaultVisibility,
          record.defaultWritePolicy,
          record.automationCreateRequiredRole,
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
         parent_session_id,
         spawn_depth,
         owner_group_id,
         visibility,
         write_policy,
         created_by_user_id,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${sessionSelectColumns}`,
      [
        record.id,
        record.status,
        record.title ?? null,
        record.context ?? null,
        record.parentSessionId ?? null,
        record.spawnDepth ?? 0,
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

  async createSessionWithFirstMessage(
    input: CreateSessionWithFirstMessageInput,
  ): Promise<CreateSessionWithFirstMessageResult> {
    return this.transaction(async (client) => {
      if (input.parentChildLimit) {
        await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [
          input.parentChildLimit.parentSessionId,
        ]);
      }

      const existing = await client.query<SessionRow>(`SELECT ${sessionSelectColumns} FROM sessions WHERE id = $1`, [
        input.session.id,
      ]);
      if (existing.rows[0]) {
        const message = await client.query<MessageRow>(
          `SELECT id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at
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
           owner_group_id,
           visibility,
           write_policy,
           created_by_user_id,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${sessionSelectColumns}`,
        [
          input.session.id,
          input.session.status,
          input.session.title ?? null,
          input.session.context ?? null,
          input.session.parentSessionId ?? null,
          input.session.spawnDepth ?? 0,
          input.session.ownerGroupId,
          input.session.visibility,
          input.session.writePolicy,
          input.session.createdByUserId ?? null,
          input.session.createdAt,
          input.session.updatedAt,
        ],
      );

      await client.query(
        `INSERT INTO session_sequence_counters (session_id, kind, next_sequence)
         VALUES ($1, 'messages', 2), ($1, 'events', 3)`,
        [input.session.id],
      );

      const messageResult = await client.query<MessageRow>(
        `INSERT INTO messages (id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at)
         VALUES ($1, $2, 1, 'pending', $3, $4, $5, $6, $7, $8)
         RETURNING id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at`,
        [
          input.message.id,
          input.session.id,
          input.message.prompt,
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
      `SELECT ${sessionSelectColumns} FROM sessions ORDER BY updated_at DESC, created_at DESC`,
    );

    return result.rows.map(toSession);
  }

  async listSessionsWithLatestSandbox(
    provider: string,
    visibleTo?: SessionVisibilityFilter,
  ): Promise<SessionWithSandboxRecord[]> {
    const result = await this.pool.query<SessionWithSandboxRow>(
      `SELECT ${joinedSessionSelectColumns},
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
       FROM sessions
       LEFT JOIN LATERAL (
         SELECT id, provider, provider_sandbox_id, status, workspace_path, metadata,
                created_at, updated_at, last_health_check_at, keepalive_until, destroyed_at
         FROM sandboxes
         WHERE sandboxes.session_id = sessions.id
           AND sandboxes.provider = $1
         ORDER BY updated_at DESC
         LIMIT 1
       ) latest_sandbox ON TRUE
       ${visibleTo ? `WHERE sessions.visibility = 'organization' OR sessions.owner_group_id = ANY($2::uuid[])` : ''}
       ORDER BY sessions.updated_at DESC, sessions.created_at DESC`,
      visibleTo ? [provider, visibleTo.groupIds] : [provider],
    );

    return result.rows.map(toSessionWithSandbox);
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
            owner_group_id = $9,
            visibility = $10,
            write_policy = $11,
            created_by_user_id = $12
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

  async updateSessionWithEvent(
    record: SessionRecord,
    event: NormalizedEvent,
  ): Promise<{ session: SessionRecord; event: EventRecord }> {
    return this.transaction(async (client) => {
      const updated = await client.query<SessionRow>(
        `UPDATE sessions
         SET status = $2,
             title = $3,
             context = $4,
             created_at = $5,
             updated_at = $6,
              parent_session_id = $7,
              spawn_depth = $8,
              owner_group_id = $9,
              visibility = $10,
              write_policy = $11,
              created_by_user_id = $12
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
          record.ownerGroupId,
          record.visibility,
          record.writePolicy,
          record.createdByUserId ?? null,
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
            parent_session_id = $10,
            spawn_depth = $11,
            owner_group_id = $12,
            visibility = $13,
            write_policy = $14,
            created_by_user_id = $15
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
        input.record.parentSessionId ?? null,
        input.record.spawnDepth,
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

  async createAutomation(record: CreateAutomationRecord): Promise<AutomationRecord> {
    const result = await this.pool.query<AutomationRow>(
      `INSERT INTO automations (
         id,
         kind,
         name,
         prompt,
         schedule_cron,
         enabled,
         owner_group_id,
         visibility,
         write_policy,
         context,
         created_by_user_id,
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
        record.ownerGroupId,
        record.visibility,
        record.writePolicy,
        record.context ?? null,
        record.createdByUserId ?? null,
        record.nextInvocationAt ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );
    return toAutomation(result.rows[0]!);
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
    if (input.ownerGroupId !== undefined) addUpdate('owner_group_id', input.ownerGroupId);
    if (input.visibility !== undefined) addUpdate('visibility', input.visibility);
    if (input.writePolicy !== undefined) addUpdate('write_policy', input.writePolicy);
    if (input.context !== undefined) addUpdate('context', input.context);
    if (input.nextInvocationAt !== undefined) addUpdate('next_invocation_at', input.nextInvocationAt);

    const result = await this.pool.query<AutomationRow>(
      `UPDATE automations
        SET ${updates.join(', ')}
        WHERE id = $1
        RETURNING ${automationSelectColumns}`,
      values,
    );
    if (!result.rows[0]) throw new Error(`Automation does not exist: ${input.id}`);
    return toAutomation(result.rows[0]);
  }

  async archiveAutomation(input: { automationId: string; archivedAt: Date }): Promise<AutomationRecord | null> {
    const result = await this.pool.query<AutomationRow>(
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
    return result.rows[0] ? toAutomation(result.rows[0]) : null;
  }

  async unarchiveAutomation(input: { automationId: string; updatedAt: Date }): Promise<AutomationRecord | null> {
    const result = await this.pool.query<AutomationRow>(
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
    return result.rows[0] ? toAutomation(result.rows[0]) : null;
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
    const result = await this.pool.query<AutomationInvocationRow>(
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
         reason,
         error,
         metadata,
         created_at,
         completed_at
       )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
        record.reason ?? null,
        record.error ?? null,
        record.metadata,
        record.createdAt,
        record.completedAt ?? null,
      ],
    );
    return toAutomationInvocation(result.rows[0]!);
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
            reason = $9,
            error = $10,
            metadata = $11,
            created_at = $12,
            completed_at = $13
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
            RETURNING id, session_id, sequence, status, prompt, author_user_id, author_name, source, context, created_at`,
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
               updated_at = $2
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
