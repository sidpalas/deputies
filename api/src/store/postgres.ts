import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { NormalizedEvent, NormalizedEventType } from '../events/types.js';
import type {
  AppStore,
  ArtifactRecord,
  CallbackDeliveryRecord,
  CallbackDeliveryStatus,
  CreateArtifactRecord,
  CreateCallbackDeliveryRecord,
  ClaimedMessage,
  ClaimedMessageBatch,
  CreateMessageRecord,
  CreateSandboxRecord,
  CreateSessionRecord,
  CreateWebhookSourceRecord,
  ExternalThreadRecord,
  IntegrationDeliveryRecord,
  MessageRecord,
  MessageStatus,
  RecoveredRun,
  RunRecord,
  RunStatus,
  SandboxRecord,
  SandboxStatus,
  SessionRecord,
  SessionStatus,
  WebhookSourceRecord,
} from './types.js';

type SessionRow = QueryResultRow & {
  id: string;
  status: SessionStatus;
  title: string | null;
  context: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  queue_paused_at: Date | null;
};

type PgInteger = number | string;

type MessageRow = QueryResultRow & {
  id: string;
  session_id: string;
  sequence: PgInteger;
  status: MessageStatus;
  prompt: string;
  source: string | null;
  context: Record<string, unknown> | null;
  created_at: Date;
};

type EventRow = QueryResultRow & {
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

type CallbackDeliveryRow = QueryResultRow & {
  id: string;
  session_id: string;
  run_id: string | null;
  message_id: string | null;
  target_type: 'http' | 'slack';
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

export class PostgresStore implements AppStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string | Pool) {
    this.pool = typeof databaseUrl === 'string' ? new Pool({ connectionString: databaseUrl }) : databaseUrl;
  }

  async close(): Promise<void> {
    await this.pool.end();
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

  async createSession(record: CreateSessionRecord): Promise<SessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (id, status, title, context, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, status, title, context, created_at, updated_at, queue_paused_at`,
      [record.id, record.status, record.title ?? null, record.context ?? null, record.createdAt, record.updatedAt],
    );

    return toSession(result.rows[0]!);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      'SELECT id, status, title, context, created_at, updated_at, queue_paused_at FROM sessions WHERE id = $1',
      [id],
    );

    const row = result.rows[0];
    return row ? toSession(row) : null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const result = await this.pool.query<SessionRow>(
      'SELECT id, status, title, context, created_at, updated_at, queue_paused_at FROM sessions ORDER BY updated_at DESC, created_at DESC',
    );

    return result.rows.map(toSession);
  }

  async updateSession(record: SessionRecord): Promise<SessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions
       SET status = $2, title = $3, context = $4, created_at = $5, updated_at = $6
       WHERE id = $1
       RETURNING id, status, title, context, created_at, updated_at, queue_paused_at`,
      [record.id, record.status, record.title ?? null, record.context ?? null, record.createdAt, record.updatedAt],
    );

    const row = result.rows[0];
    if (!row) throw new Error(`Session does not exist: ${record.id}`);
    return toSession(row);
  }

  async pauseSessionQueue(input: { sessionId: string; pausedAt: Date }): Promise<SessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions SET queue_paused_at = $2, updated_at = $2 WHERE id = $1
       RETURNING id, status, title, context, created_at, updated_at, queue_paused_at`,
      [input.sessionId, input.pausedAt],
    );
    if (!result.rows[0]) throw new Error(`Session does not exist: ${input.sessionId}`);
    return toSession(result.rows[0]);
  }

  async resumeSessionQueue(input: { sessionId: string }): Promise<SessionRecord> {
    const now = new Date();
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions SET queue_paused_at = NULL, updated_at = $2 WHERE id = $1
       RETURNING id, status, title, context, created_at, updated_at, queue_paused_at`,
      [input.sessionId, now],
    );
    if (!result.rows[0]) throw new Error(`Session does not exist: ${input.sessionId}`);
    return toSession(result.rows[0]);
  }

  async nextMessageSequence(sessionId: string): Promise<number> {
    return this.nextSequence(sessionId, 'messages');
  }

  async createMessage(record: CreateMessageRecord): Promise<MessageRecord> {
    const result = await this.pool.query<MessageRow>(
      `INSERT INTO messages (id, session_id, sequence, status, prompt, source, context, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, session_id, sequence, status, prompt, source, context, created_at`,
      [
        record.id,
        record.sessionId,
        record.sequence,
        record.status,
        record.prompt,
        record.source ?? null,
        record.context ?? null,
        record.createdAt,
      ],
    );

    return toMessage(result.rows[0]!);
  }

  async getMessages(sessionId: string): Promise<MessageRecord[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, session_id, sequence, status, prompt, source, context, created_at
       FROM messages
       WHERE session_id = $1
       ORDER BY sequence ASC`,
      [sessionId],
    );

    return result.rows.map(toMessage);
  }

  async updatePendingMessage(input: { sessionId: string; messageId: string; prompt: string }): Promise<MessageRecord | null> {
    const result = await this.pool.query<MessageRow>(
      `UPDATE messages SET prompt = $3 WHERE session_id = $1 AND id = $2 AND status = 'pending'
       RETURNING id, session_id, sequence, status, prompt, source, context, created_at`,
      [input.sessionId, input.messageId, input.prompt],
    );
    return result.rows[0] ? toMessage(result.rows[0]) : null;
  }

  async cancelPendingMessage(input: { sessionId: string; messageId: string; cancelledAt: Date }): Promise<MessageRecord | null> {
    const result = await this.pool.query<MessageRow>(
      `UPDATE messages SET status = 'cancelled' WHERE session_id = $1 AND id = $2 AND status = 'pending'
       RETURNING id, session_id, sequence, status, prompt, source, context, created_at`,
      [input.sessionId, input.messageId],
    );
    return result.rows[0] ? toMessage(result.rows[0]) : null;
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
      const candidate = await client.query<MessageRow>(
        `SELECT m.id, m.session_id, m.sequence, m.status, m.prompt, m.source, m.context, m.created_at
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.status = 'pending'
           AND s.queue_paused_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM runs r
             WHERE r.session_id = m.session_id
                AND r.status IN ('starting', 'running', 'cancelling')
               AND (r.lease_expires_at IS NULL OR r.lease_expires_at > $1)
           )
         ORDER BY m.created_at ASC, m.sequence ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [input.now],
      );

      const message = candidate.rows[0];
      if (!message) return null;

      const updatedMessages = await client.query<MessageRow>(
        `UPDATE messages
         SET status = 'processing'
         WHERE session_id = $1 AND status = 'pending'
         RETURNING id, session_id, sequence, status, prompt, source, context, created_at`,
        [message.session_id],
      );
      const messages = updatedMessages.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence);
      const metadata = { messageIds: messages.map((item) => item.id), sequences: messages.map((item) => item.sequence) };

      const run = await client.query<RunRow>(
        `INSERT INTO runs (id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, started_at, metadata)
         VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $7, $8)
         RETURNING id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata`,
        [input.runId, message.session_id, message.id, input.runnerType, input.leaseOwner, input.leaseExpiresAt, input.now, metadata],
      );

      await client.query('UPDATE sessions SET status = $2, updated_at = $3 WHERE id = $1', [
        message.session_id,
        'active',
        input.now,
      ]);

      return { messages, run: toRun(run.rows[0]!) };
    });
  }

  async completeRun(input: { runId: string; completedAt: Date }): Promise<ClaimedMessage> {
    return this.finishRun(input.runId, 'completed', input.completedAt);
  }

  async completeRunBatch(input: { runId: string; completedAt: Date }): Promise<ClaimedMessageBatch> {
    return this.finishRunBatch(input.runId, 'completed', input.completedAt);
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
        WHERE id = $1 AND lease_owner = $2 AND status IN ('running', 'cancelling')
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
           RETURNING id, session_id, sequence, status, prompt, source, context, created_at`,
          [messageIds],
        );

        if (!messageResult.rows[0]) continue;

        await client.query('UPDATE sessions SET status = $2, updated_at = $3 WHERE id = $1', [
          staleRun.session_id,
          'idle',
          input.now,
        ]);

        recovered.push({ message: toMessage(messageResult.rows[0]), run: toRun(runResult.rows[0]!) });
      }

      return recovered;
    });
  }

  async failRun(input: { runId: string; failedAt: Date; error: string }): Promise<ClaimedMessage> {
    return this.finishRun(input.runId, 'failed', input.failedAt, input.error);
  }

  async failRunBatch(input: { runId: string; failedAt: Date; error: string }): Promise<ClaimedMessageBatch> {
    return this.finishRunBatch(input.runId, 'failed', input.failedAt, input.error);
  }

  async requestRunCancellation(input: { sessionId: string; requestedAt: Date; error: string }): Promise<ClaimedMessageBatch | null> {
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
         RETURNING id, session_id, sequence, status, prompt, source, context, created_at`,
        [messageIds],
      );

      await client.query('UPDATE sessions SET status = $2, updated_at = $3 WHERE id = $1', [input.sessionId, 'active', input.requestedAt]);

      return { messages: messageResult.rows.map(toMessage).sort((a, b) => a.sequence - b.sequence), run: toRun(run) };
    });
  }

  async finalizeRunCancellation(input: { runId: string; cancelledAt: Date; error: string }): Promise<ClaimedMessageBatch> {
    return this.finishRunBatch(input.runId, 'cancelled', input.cancelledAt, input.error);
  }

  async getActiveSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null> {
    return (await this.listActiveSandboxes(sessionId, provider))[0] ?? null;
  }

  async listActiveSandboxes(sessionId: string, provider: string): Promise<SandboxRecord[]> {
    const result = await this.pool.query<SandboxRow>(
      `SELECT id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata,
              created_at, updated_at, last_health_check_at, destroyed_at
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
              sb.created_at, sb.updated_at, sb.last_health_check_at, sb.destroyed_at
       FROM sandboxes sb
       JOIN sessions s ON s.id = sb.session_id
       WHERE sb.provider = $1
         AND sb.destroyed_at IS NULL
         AND sb.status IN ('ready', 'stopped', 'unhealthy')
         AND sb.updated_at <= $2
         AND s.status <> 'active'
       ORDER BY sb.updated_at ASC
       LIMIT $3`,
      [input.provider, input.idleBefore, input.limit],
    );
    return result.rows.map(toSandbox);
  }

  async listStoppableSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]> {
    const result = await this.pool.query<SandboxRow>(
      `SELECT sb.id, sb.session_id, sb.provider, sb.provider_sandbox_id, sb.status, sb.workspace_path, sb.metadata,
              sb.created_at, sb.updated_at, sb.last_health_check_at, sb.destroyed_at
       FROM sandboxes sb
       JOIN sessions s ON s.id = sb.session_id
       WHERE sb.provider = $1
         AND sb.destroyed_at IS NULL
         AND sb.status = 'ready'
         AND sb.updated_at <= $2
         AND s.status <> 'active'
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
      `INSERT INTO sandboxes (id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata,
                 created_at, updated_at, last_health_check_at, destroyed_at`,
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
      ],
    );
    return toSandbox(result.rows[0]!);
  }

  async updateSandbox(record: SandboxRecord): Promise<SandboxRecord> {
    const result = await this.pool.query<SandboxRow>(
      `UPDATE sandboxes
       SET status = $2,
           workspace_path = $3,
           metadata = $4,
           updated_at = $5,
           last_health_check_at = $6,
           destroyed_at = $7
       WHERE id = $1
       RETURNING id, session_id, provider, provider_sandbox_id, status, workspace_path, metadata,
                 created_at, updated_at, last_health_check_at, destroyed_at`,
      [
        record.id,
        record.status,
        record.workspacePath,
        record.metadata,
        record.updatedAt,
        record.lastHealthCheckAt ?? null,
        record.destroyedAt ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error(`Sandbox does not exist: ${record.id}`);
    return toSandbox(result.rows[0]);
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
      const due = await client.query<CallbackDeliveryRow>(
        `SELECT id, session_id, run_id, message_id, target_type, target, status, event_type, payload, attempts, max_attempts, last_error, created_at, updated_at, next_attempt_at, last_attempt_at, delivered_at
         FROM callback_deliveries
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
           AND attempts < max_attempts
         ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [input.now, input.limit],
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

  async markCallbackDeliveryFailed(input: { id: string; failedAt: Date; error: string; terminal: boolean; nextAttemptAt?: Date }): Promise<CallbackDeliveryRecord> {
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

  async requestCallbackReplay(input: { sessionId: string; deliveryId: string; requestedAt: Date }): Promise<CallbackDeliveryRecord | null> {
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

  async appendEvent(event: NormalizedEvent & { sequence: number }): Promise<NormalizedEvent & { sequence: number }> {
    const result = await this.pool.query<EventRow>(
      `INSERT INTO events (session_id, run_id, message_id, sequence, type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING session_id, run_id, message_id, sequence, type, payload, created_at`,
      [
        event.sessionId,
        event.runId ?? null,
        event.messageId ?? null,
        event.sequence,
        event.type,
        event.payload,
        event.createdAt,
      ],
    );

    return toEvent(result.rows[0]!);
  }

  async getEvents(sessionId: string, afterSequence = 0): Promise<Array<NormalizedEvent & { sequence: number }>> {
    const result = await this.pool.query<EventRow>(
      `SELECT session_id, run_id, message_id, sequence, type, payload, created_at
       FROM events
       WHERE session_id = $1 AND sequence > $2
       ORDER BY sequence ASC`,
      [sessionId, afterSequence],
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
    metadata: Record<string, unknown>;
  }): Promise<IntegrationDeliveryRecord | null> {
    const result = await this.pool.query<IntegrationDeliveryRow>(
      `INSERT INTO integration_deliveries (id, source, dedupe_key, status, received_at, metadata)
       VALUES ($1, $2, $3, 'received', $4, $5)
       ON CONFLICT (source, dedupe_key) DO NOTHING
       RETURNING id, source, dedupe_key, status, received_at, processed_at, error, metadata`,
      [input.id, input.source, input.dedupeKey, input.receivedAt, input.metadata],
    );

    const row = result.rows[0];
    return row ? toIntegrationDelivery(row) : null;
  }

  async markIntegrationDeliveryProcessed(input: { source: string; dedupeKey: string; processedAt: Date }): Promise<void> {
    await this.pool.query(
      `UPDATE integration_deliveries
       SET status = 'processed', processed_at = $3
       WHERE source = $1 AND dedupe_key = $2`,
      [input.source, input.dedupeKey, input.processedAt],
    );
  }

  async markIntegrationDeliveryFailed(input: { source: string; dedupeKey: string; failedAt: Date; error: string }): Promise<void> {
    await this.pool.query(
      `UPDATE integration_deliveries
       SET status = 'failed', processed_at = $3, error = $4
       WHERE source = $1 AND dedupe_key = $2`,
      [input.source, input.dedupeKey, input.failedAt, input.error],
    );
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

  private async finishRun(
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    finishedAt: Date,
    error?: string,
  ): Promise<ClaimedMessage> {
    const batch = await this.finishRunBatch(runId, status, finishedAt, error);
    return { message: batch.messages[0]!, run: batch.run };
  }

  private async finishRunBatch(
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    finishedAt: Date,
    error?: string,
  ): Promise<ClaimedMessageBatch> {
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
         WHERE id = $1
         RETURNING id, session_id, message_id, status, runner_type, lease_owner, lease_expires_at, heartbeat_at, attempt, started_at, completed_at, failed_at, error, metadata`,
        [runId, status, finishedAt, error ?? null],
      );

      const run = runResult.rows[0];
      if (!run) throw new Error(`Run does not exist: ${runId}`);

      const messageIds = getRunMessageIds(toRun(run));
      const messageResult = await client.query<MessageRow>(
        `UPDATE messages
         SET status = $2
          WHERE id = ANY($1::uuid[])
          RETURNING id, session_id, sequence, status, prompt, source, context, created_at`,
        [messageIds, status],
      );

      await client.query('UPDATE sessions SET status = $2, updated_at = $3 WHERE id = $1', [
        run.session_id,
        status === 'failed' ? 'failed' : 'idle',
        finishedAt,
      ]);

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

function toSession(row: SessionRow): SessionRecord {
  const record: SessionRecord = {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.title) record.title = row.title;
  if (row.queue_paused_at) record.queuePausedAt = row.queue_paused_at;
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
  if (row.source) record.source = row.source;
  if (row.context) record.context = row.context;
  return record;
}

function toEvent(row: EventRow): NormalizedEvent & { sequence: number } {
  const event: NormalizedEvent & { sequence: number } = {
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  };
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
