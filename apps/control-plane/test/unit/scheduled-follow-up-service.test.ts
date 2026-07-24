import { randomUUID } from 'node:crypto';
import { createServices } from '../../src/app/server.js';
import { CallbackDispatcher, type CompletionCallbackPayload } from '../../src/callbacks/service.js';
import { MemoryStore } from '../../src/store/memory.js';
import { StoreConflictError, type ScheduledFollowUpRecord } from '../../src/store/types.js';

describe('scheduled follow-up lifecycle invariants', () => {
  const validContext = { status: 'valid' as const, overrides: {}, clear: [] };
  let store: MemoryStore;
  let sessionId: string;

  beforeEach(async () => {
    store = new MemoryStore();
    sessionId = randomUUID();
    await store.createSession(session(sessionId));
  });

  it('activates a one-off exactly once and keeps its occurrence immutable', async () => {
    const due = new Date('2026-07-24T12:00:00Z');
    const sourceSessionId = randomUUID();
    await store.createSession(session(sourceSessionId, { title: 'Source session' }));
    const followUp = await createFollowUp(store, sessionId, due, { createdBySessionId: sourceSessionId });
    const claimed = await claim(store, due);
    const first = await store.activateDueScheduledFollowUp({
      id: followUp.id,
      lockOwner: 'scheduler',
      claimedRevision: claimed.claimedRevision,
      now: due,
      resolvedContext: validContext,
    });

    expect(first).toMatchObject({
      followUp: { status: 'completed' },
      occurrences: [{ occurrenceNumber: 1, outcome: 'message_created', scheduledAt: due }],
      message: {
        status: 'pending',
        source: 'scheduled_follow_up',
        authorName: 'Deputy: Source session',
        context: { sourceSessionId },
        scheduledFollowUpId: followUp.id,
      },
    });
    expect(await store.claimDueScheduledFollowUp({ lockOwner: 'again', now: due, lockedUntil: later(due) })).toBeNull();
    expect(await store.listScheduledFollowUpOccurrences({ followUpId: followUp.id, limit: 10 })).toEqual(
      first!.occurrences,
    );
    await expect(store.getMessages(sessionId)).resolves.toHaveLength(1);
    await expect(store.getSession(sessionId)).resolves.toMatchObject({ status: 'queued' });
  });

  it('materializes downtime as bounded skips and only creates the latest message', async () => {
    const start = new Date('2026-07-20T09:00:00Z');
    const followUp = await createFollowUp(store, sessionId, start, {
      scheduleKind: 'recurring',
      dtstartLocal: '2026-07-20T09:00:00',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      maxOccurrences: 4,
    });
    const now = new Date('2026-07-23T09:00:00Z');
    const result = await store.activateDueScheduledFollowUp({
      id: followUp.id,
      lockOwner: 'scheduler',
      claimedRevision: (await claim(store, now)).claimedRevision,
      now,
      resolvedContext: validContext,
    });

    expect(result!.occurrences.map((x) => [x.occurrenceNumber, x.outcome, x.reason])).toEqual([
      [1, 'skipped', 'missed_during_downtime'],
      [2, 'skipped', 'missed_during_downtime'],
      [3, 'skipped', 'missed_during_downtime'],
      [4, 'message_created', undefined],
    ]);
    expect(result!.followUp.status).toBe('completed');
    await expect(store.getMessages(sessionId)).resolves.toHaveLength(1);
  });

  it('skips a due occurrence while this schedule has an unfinished message', async () => {
    const start = new Date('2026-07-24T09:00:00Z');
    const followUp = await createFollowUp(store, sessionId, start, {
      scheduleKind: 'recurring',
      dtstartLocal: '2026-07-24T09:00:00',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      maxOccurrences: 2,
    });
    let c = await claim(store, start);
    await store.activateDueScheduledFollowUp({
      id: followUp.id,
      lockOwner: 'scheduler',
      claimedRevision: c.claimedRevision,
      now: start,
      resolvedContext: validContext,
    });
    const next = new Date('2026-07-25T09:00:00Z');
    c = await claim(store, next);
    const result = await store.activateDueScheduledFollowUp({
      id: followUp.id,
      lockOwner: 'scheduler',
      claimedRevision: c.claimedRevision,
      now: next,
      resolvedContext: validContext,
    });
    expect(result!.occurrences).toMatchObject([
      { occurrenceNumber: 2, outcome: 'skipped', reason: 'previous_message_unfinished' },
    ]);
    await expect(store.getMessages(sessionId)).resolves.toHaveLength(1);
  });

  it('cancels pending generated messages, but leaves processing messages alone', async () => {
    const due = new Date('2026-07-24T12:00:00Z');
    const pending = await createAndActivate(store, sessionId, due);
    await store.cancelScheduledFollowUp({ id: pending.id, sessionId, expectedRevision: 1, now: later(due) });
    expect((await store.getMessages(sessionId))[0]!.status).toBe('cancelled');

    const second = await createAndActivate(store, sessionId, new Date('2026-07-24T13:00:00Z'));
    await store.claimNextPendingMessage({
      runId: randomUUID(),
      runnerType: 'test',
      leaseOwner: 'worker',
      leaseExpiresAt: later(due),
      now: due,
    });
    await store.cancelScheduledFollowUp({ id: second.id, sessionId, expectedRevision: 1, now: later(due) });
    expect((await store.getMessages(sessionId)).find((x) => x.scheduledFollowUpId === second.id)!.status).toBe(
      'processing',
    );
  });

  it('records context failure before message creation and recurring processing continues', async () => {
    const start = new Date('2026-07-24T09:00:00Z');
    const followUp = await createFollowUp(store, sessionId, start, {
      scheduleKind: 'recurring',
      dtstartLocal: '2026-07-24T09:00:00',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      maxOccurrences: 2,
    });
    const c = await claim(store, start);
    const result = await store.activateDueScheduledFollowUp({
      id: followUp.id,
      lockOwner: 'scheduler',
      claimedRevision: c.claimedRevision,
      now: start,
      resolvedContext: { status: 'invalid', reason: 'resource_unavailable', error: 'gone' },
    });
    expect(result).toMatchObject({
      occurrences: [{ outcome: 'pre_message_failed', reason: 'resource_unavailable', error: 'gone' }],
      followUp: { status: 'active', nextDueAt: new Date('2026-07-25T09:00:00Z') },
    });
    await expect(store.getMessages(sessionId)).resolves.toEqual([]);
  });

  it('dispatches typed pre-message failure callbacks', async () => {
    const due = new Date('2026-07-24T09:00:00Z');
    const followUp = await createFollowUp(store, sessionId, due);
    const c = await claim(store, due);
    await store.activateDueScheduledFollowUp({
      id: followUp.id,
      lockOwner: 'scheduler',
      claimedRevision: c.claimedRevision,
      now: due,
      resolvedContext: { status: 'invalid', reason: 'invalid_context', error: 'bad context' },
      externalCallback: { type: 'slack', target: { channelId: 'C1', threadTs: '1.0' } },
    });
    const payloads: CompletionCallbackPayload[] = [];
    const dispatcher = new CallbackDispatcher(
      store,
      createServices(store).events,
      [{ type: 'slack', deliver: async (_callback, payload) => void payloads.push(payload) }],
      { now: () => due },
    );
    await expect(dispatcher.dispatchDue()).resolves.toBe(1);
    expect(payloads).toMatchObject([
      {
        event: 'scheduled_follow_up_failed',
        sessionId,
        scheduledFollowUpId: followUp.id,
        occurrenceId: expect.any(String),
      },
    ]);
  });

  it('supports repository skills at activation and rejects personal managed skills', async () => {
    const services = createServices(store);
    await services.events.append({
      sessionId,
      type: 'skills_loaded',
      payload: {
        skills: [{ name: 'repo-review', source: 'repo', repo: 'acme/widget', advertised: false }],
        shadowed: [],
        diagnostics: [],
      },
    });
    const due = new Date(Date.now() + 60_000);
    await services.scheduledFollowUps.create({
      sessionId,
      prompt: 'use repository skill',
      schedule: { kind: 'once', runAt: due.toISOString() },
      contextOverrides: { skills: ['repo-review'] },
    });
    await expect(services.scheduledFollowUps.processNext({ lockOwner: 'scheduler', now: due })).resolves.toBe(true);
    await expect(store.getMessages(sessionId)).resolves.toMatchObject([
      {
        context: { skills: ['repo-review'], skillRefs: [{ id: 'repo:acme/widget:repo-review', name: 'repo-review' }] },
      },
    ]);

    const ownerId = randomUUID();
    await store.upsertAuthUserForAccount({
      userId: ownerId,
      accountId: randomUUID(),
      provider: 'test',
      providerAccountId: ownerId,
      username: ownerId,
      role: 'member',
      profile: {},
      now: new Date(),
    });
    const personal = await services.skills.create({
      scope: 'personal',
      name: 'personal-review',
      description: 'Private instructions',
      body: 'Review privately',
      createdByUserId: ownerId,
    });
    await expect(
      services.scheduledFollowUps.create({
        sessionId,
        prompt: 'personal create',
        schedule: { kind: 'once', runAt: new Date(Date.now() + 120_000).toISOString() },
        createdByUserId: ownerId,
        contextOverrides: {
          skills: [personal.name],
          skillRefs: [{ id: personal.id, name: personal.name, revisionId: personal.currentRevisionId }],
        },
      }),
    ).rejects.toThrow(/Unknown or inaccessible skill/);

    const existing = await services.scheduledFollowUps.create({
      sessionId,
      prompt: 'agent update',
      schedule: { kind: 'once', runAt: new Date(Date.now() + 180_000).toISOString() },
      createdByUserId: ownerId,
    });
    await expect(
      services.scheduledFollowUps.update({
        sessionId,
        id: existing.id,
        expectedRevision: existing.definitionRevision,
        contextOverrides: {
          skills: [personal.name],
          skillRefs: [{ id: personal.id, name: personal.name, revisionId: personal.currentRevisionId }],
        },
      }),
    ).rejects.toThrow(/Unknown or inaccessible skill/);
  });

  it('replays agent keys before validation and enforces run and session quotas', async () => {
    const service = createServices(store).scheduledFollowUps;
    const runId = randomUUID();
    const first = await service.create({
      sessionId,
      prompt: 'first',
      schedule: { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
      createdByRunId: runId,
      idempotencyKey: 'same',
      maxNewForRun: 10,
    });
    await expect(
      service.create({
        sessionId,
        prompt: '',
        schedule: { kind: 'once', runAt: '2000-01-01' },
        createdByRunId: runId,
        idempotencyKey: 'same',
        maxNewForRun: 10,
      }),
    ).resolves.toEqual(first);
    for (let i = 1; i < 10; i++)
      await service.create({
        sessionId,
        prompt: `${i}`,
        schedule: { kind: 'once', runAt: new Date(Date.now() + 60_000 + i).toISOString() },
        createdByRunId: runId,
        idempotencyKey: `${i}`,
        maxNewForRun: 10,
      });
    await expect(
      service.create({
        sessionId,
        prompt: 'overflow',
        schedule: { kind: 'once', runAt: new Date(Date.now() + 90_000).toISOString() },
        createdByRunId: runId,
        idempotencyKey: 'overflow',
        maxNewForRun: 10,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    await service.cancel(sessionId, first.id, first.definitionRevision);
    await expect(
      service.create({
        sessionId,
        prompt: 'replacement',
        schedule: { kind: 'once', runAt: new Date(Date.now() + 90_000).toISOString() },
        createdByRunId: runId,
        idempotencyKey: 'replacement',
        maxNewForRun: 10,
      }),
    ).resolves.toMatchObject({ status: 'active' });

    for (let i = 10; i < 25; i++) await createFollowUp(store, sessionId, new Date(Date.now() + 120_000 + i));
    await expect(createFollowUp(store, sessionId, new Date(Date.now() + 180_000))).rejects.toBeInstanceOf(
      StoreConflictError,
    );
  });
});

function session(id: string, extra = {}) {
  const now = new Date('2026-07-24T00:00:00Z');
  return {
    id,
    status: 'idle' as const,
    title: id,
    tags: [],
    spawnDepth: 0,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    ...extra,
  };
}
function later(d: Date) {
  return new Date(d.getTime() + 60_000);
}
async function claim(store: MemoryStore, now: Date) {
  return (await store.claimDueScheduledFollowUp({ lockOwner: 'scheduler', now, lockedUntil: later(now) }))!;
}
async function createFollowUp(
  store: MemoryStore,
  sessionId: string,
  due: Date,
  overrides: Partial<Parameters<MemoryStore['createScheduledFollowUp']>[0]> = {},
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
      ...overrides,
    })
  ).followUp;
}
async function createAndActivate(store: MemoryStore, sessionId: string, due: Date) {
  const f = await createFollowUp(store, sessionId, due, {
    scheduleKind: 'recurring',
    dtstartLocal: due.toISOString().slice(0, 19),
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    maxOccurrences: 2,
  });
  const c = await claim(store, due);
  await store.activateDueScheduledFollowUp({
    id: f.id,
    lockOwner: 'scheduler',
    claimedRevision: c.claimedRevision,
    now: due,
    resolvedContext: { status: 'valid', overrides: {}, clear: [] },
  });
  return f;
}
