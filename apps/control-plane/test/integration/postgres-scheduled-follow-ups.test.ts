import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from '../../src/store/postgres.js';
import type { ScheduledFollowUpRecord } from '../../src/store/types.js';
import { setupPostgresStoreSuite, testDatabaseUrl } from '../support/postgres-store-suite.js';

const due = new Date('2026-07-24T12:00:00.000Z');

describe.skipIf(!testDatabaseUrl)('PostgresStore scheduled follow-ups', () => {
  const validContext = { status: 'valid' as const, overrides: {}, clear: [] };
  let pool: Pool;
  let store: PostgresStore;

  setupPostgresStoreSuite('postgres_scheduled_follow_ups', (context) => {
    pool = context.pool;
    store = context.store;
  });

  it('activates a one-off exactly once and advances the shared message sequence allocator', async () => {
    const sessionId = await createSession(store, 'one-off');
    const sourceSessionId = await createSession(store, 'source');
    const followUp = await createFollowUp(store, sessionId, { createdBySessionId: sourceSessionId });
    const claim = await store.claimDueScheduledFollowUp({
      lockOwner: 'worker-a',
      now: due,
      lockedUntil: minuteAfter(due),
    });

    const activated = await store.activateDueScheduledFollowUp({
      id: followUp.id,
      lockOwner: 'worker-a',
      claimedRevision: claim!.claimedRevision,
      now: due,
      resolvedContext: validContext,
    });

    expect(activated).toMatchObject({
      followUp: { status: 'completed' },
      occurrences: [{ occurrenceNumber: 1, outcome: 'message_created', scheduledAt: due }],
      message: {
        sequence: 1,
        prompt: 'follow up',
        source: 'scheduled_follow_up',
        status: 'pending',
        authorName: 'Deputy: source',
        context: { sourceSessionId },
      },
    });
    await expect(
      store.activateDueScheduledFollowUp({
        id: followUp.id,
        lockOwner: 'worker-b',
        claimedRevision: claim!.claimedRevision,
        now: due,
        resolvedContext: validContext,
      }),
    ).resolves.toBeNull();
    await expect(
      store.claimDueScheduledFollowUp({ lockOwner: 'worker-b', now: due, lockedUntil: minuteAfter(due) }),
    ).resolves.toBeNull();
    await expect(store.listScheduledFollowUpOccurrences({ followUpId: followUp.id, limit: 10 })).resolves.toEqual(
      activated!.occurrences,
    );

    const sequence = await store.nextMessageSequence(sessionId);
    const ordinary = await store.createMessage({
      id: randomUUID(),
      sessionId,
      sequence,
      status: 'pending',
      prompt: 'ordinary message',
      createdAt: minuteAfter(due),
    });
    expect(ordinary.sequence).toBe(2);
    await expect(store.getMessages(sessionId)).resolves.toMatchObject([{ sequence: 1 }, { sequence: 2 }]);
  });

  it('reclaims an expired lease and fences the stale owner from activation', async () => {
    const sessionId = await createSession(store, 'lease-reclaim');
    const followUp = await createFollowUp(store, sessionId);
    const expiry = minuteAfter(due);
    const ownerA = await store.claimDueScheduledFollowUp({ lockOwner: 'owner-a', now: due, lockedUntil: expiry });

    const ownerB = await store.claimDueScheduledFollowUp({
      lockOwner: 'owner-b',
      now: expiry,
      lockedUntil: minuteAfter(expiry),
    });
    expect(ownerB?.followUp.id).toBe(followUp.id);
    await expect(
      store.activateDueScheduledFollowUp({
        id: followUp.id,
        lockOwner: 'owner-a',
        claimedRevision: ownerA!.claimedRevision,
        now: expiry,
        resolvedContext: validContext,
      }),
    ).resolves.toBeNull();
    await expect(
      store.activateDueScheduledFollowUp({
        id: followUp.id,
        lockOwner: 'owner-b',
        claimedRevision: ownerB!.claimedRevision,
        now: expiry,
        resolvedContext: validContext,
      }),
    ).resolves.toMatchObject({ occurrences: [{ occurrenceNumber: 1, outcome: 'message_created' }] });
    await expect(store.listScheduledFollowUpOccurrences({ followUpId: followUp.id, limit: 10 })).resolves.toHaveLength(
      1,
    );
    await expect(store.getMessages(sessionId)).resolves.toHaveLength(1);
  });

  it('uses cancellation revision changes to fence a previously claimed activation', async () => {
    const sessionId = await createSession(store, 'cancel-fence');
    const followUp = await createFollowUp(store, sessionId);
    const claim = await store.claimDueScheduledFollowUp({
      lockOwner: 'scheduler',
      now: due,
      lockedUntil: minuteAfter(due),
    });

    const cancelled = await store.cancelScheduledFollowUp({
      id: followUp.id,
      sessionId,
      expectedRevision: claim!.claimedRevision,
      now: new Date(due.getTime() + 1_000),
    });
    expect(cancelled.followUp).toMatchObject({ status: 'cancelled', definitionRevision: 2 });
    expect(cancelled.followUp.nextDueAt).toBeUndefined();
    await expect(
      store.activateDueScheduledFollowUp({
        id: followUp.id,
        lockOwner: 'scheduler',
        claimedRevision: claim!.claimedRevision,
        now: new Date(due.getTime() + 2_000),
        resolvedContext: validContext,
      }),
    ).resolves.toBeNull();
    await expect(store.listScheduledFollowUpOccurrences({ followUpId: followUp.id, limit: 10 })).resolves.toEqual([]);
    await expect(store.getMessages(sessionId)).resolves.toEqual([]);
  });

  it('does not retry a failed scheduled message after its session is archived', async () => {
    const sessionId = await createSession(store, 'archived-retry');
    const followUp = await createFollowUp(store, sessionId);
    const claim = await store.claimDueScheduledFollowUp({
      lockOwner: 'scheduler',
      now: due,
      lockedUntil: minuteAfter(due),
    });
    const activated = await store.activateDueScheduledFollowUp({
      id: followUp.id,
      lockOwner: 'scheduler',
      claimedRevision: claim!.claimedRevision,
      now: due,
      resolvedContext: validContext,
    });
    await pool.query("UPDATE messages SET status='failed' WHERE id=$1", [activated!.message!.id]);
    await pool.query("UPDATE sessions SET status='archived' WHERE id=$1", [sessionId]);

    await expect(
      store.retryScheduledMessage({ sessionId, messageId: activated!.message!.id, retriedAt: minuteAfter(due) }),
    ).resolves.toBeNull();
    await expect(store.getMessages(sessionId)).resolves.toMatchObject([{ status: 'failed' }]);
    await expect(store.getSession(sessionId)).resolves.toMatchObject({ status: 'archived' });
  });

  it('returns a queued session to idle when cancelling its generated pending message', async () => {
    const sessionId = await createSession(store, 'cancel-generated');
    const followUp = await createFollowUp(store, sessionId, {
      scheduleKind: 'recurring',
      dtstartLocal: '2026-07-24T12:00:00',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      maxOccurrences: 2,
    });
    const claim = await store.claimDueScheduledFollowUp({
      lockOwner: 'scheduler',
      now: due,
      lockedUntil: minuteAfter(due),
    });
    await store.activateDueScheduledFollowUp({
      id: followUp.id,
      lockOwner: 'scheduler',
      claimedRevision: claim!.claimedRevision,
      now: due,
      resolvedContext: validContext,
    });
    await expect(store.getSession(sessionId)).resolves.toMatchObject({ status: 'queued' });

    await store.cancelScheduledFollowUp({
      id: followUp.id,
      sessionId,
      expectedRevision: 1,
      now: minuteAfter(due),
    });
    await expect(store.getSession(sessionId)).resolves.toMatchObject({ status: 'idle' });
  });

  it('serializes the cross-session agent run quota and converges concurrent idempotency retries', async () => {
    const runId = randomUUID();
    const sessionIds = await Promise.all(
      Array.from({ length: 12 }, (_, index) => createSession(store, `agent-${index}`)),
    );
    const creatorMessageId = randomUUID();
    await store.createMessage({
      id: creatorMessageId,
      sessionId: sessionIds[0]!,
      sequence: await store.nextMessageSequence(sessionIds[0]!),
      status: 'completed',
      prompt: 'creator message',
      createdAt: due,
    });
    await pool.query(
      `INSERT INTO runs (id,session_id,message_id,status,runner_type,started_at)
       VALUES ($1,$2,$3,'completed','test',$4)`,
      [runId, sessionIds[0], creatorMessageId, due],
    );
    const duplicateId = randomUUID();
    const attempts = [
      createFollowUp(store, sessionIds[0]!, { id: duplicateId, createdByRunId: runId, idempotencyKey: 'same' }),
      createFollowUp(store, sessionIds[0]!, { createdByRunId: runId, idempotencyKey: 'same' }),
      ...sessionIds.slice(1).map((sessionId, index) =>
        createFollowUp(store, sessionId, {
          createdByRunId: runId,
          idempotencyKey: `distinct-${index}`,
        }),
      ),
    ];

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(11);
    expect(rejected).toHaveLength(2);
    expect(rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: expect.objectContaining({ code: 'scheduled_follow_up_run_limit' }) }),
      ]),
    );
    const sameKey = fulfilled.map((result) => result.value).filter((followUp) => followUp.idempotencyKey === 'same');
    expect(sameKey).toHaveLength(2);
    // Concurrent first attempts have no ordering guarantee; whichever transaction
    // acquires the per-Run advisory lock first owns the key, and every replay must
    // converge to that same definition.
    expect(new Set(sameKey.map((followUp) => followUp.id))).toHaveLength(1);

    const persisted = await pool.query<{ count: string; distinct_sessions: string }>(
      'SELECT count(*) count, count(DISTINCT session_id) distinct_sessions FROM scheduled_follow_ups WHERE created_by_run_id=$1',
      [runId],
    );
    expect(persisted.rows[0]).toEqual({ count: '10', distinct_sessions: '10' });

    await pool.query(`UPDATE scheduled_follow_ups SET status='completed',next_due_at=NULL WHERE id=$1`, [
      sameKey[0]!.id,
    ]);
    const replacementSessionId = await createSession(store, 'agent-replacement');
    await expect(
      createFollowUp(store, replacementSessionId, {
        createdByRunId: runId,
        idempotencyKey: 'replacement',
      }),
    ).resolves.toMatchObject({ status: 'active' });
  });
});

async function createSession(store: PostgresStore, label: string): Promise<string> {
  const id = randomUUID();
  await store.createSession({
    id,
    status: 'idle',
    title: label,
    tags: [],
    spawnDepth: 0,
    createdAt: due,
    updatedAt: due,
    lastActivityAt: due,
  });
  return id;
}

async function createFollowUp(
  store: PostgresStore,
  sessionId: string,
  overrides: Partial<Parameters<PostgresStore['createScheduledFollowUp']>[0]> = {},
): Promise<ScheduledFollowUpRecord> {
  return (
    await store.createScheduledFollowUp({
      id: randomUUID(),
      sessionId,
      scheduleKind: 'once',
      prompt: 'follow up',
      ...(overrides.scheduleKind === 'recurring' ? {} : { runAt: due }),
      nextDueAt: due,
      createdAt: due,
      updatedAt: due,
      maxNewForRun: 10,
      ...overrides,
    })
  ).followUp;
}

function minuteAfter(value: Date): Date {
  return new Date(value.getTime() + 60_000);
}
