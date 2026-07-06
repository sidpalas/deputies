import { describe, expect, it } from 'vitest';
import { EventService } from '../../src/events/service.js';
import { MessageService } from '../../src/messages/service.js';
import { executeDeputyTool, type DeputyToolServices } from '../../src/sessions/deputy-tool.js';
import { MemoryStore } from '../../src/store/memory.js';
import { defaultGroupId, type SessionRecord } from '../../src/store/types.js';

const parentId = '00000000-0000-4000-8000-000000000101';
const runId = '00000000-0000-4000-8000-000000000102';
const messageId = '00000000-0000-4000-8000-000000000103';
const otherGroupId = '00000000-0000-4000-8000-000000000104';
const now = new Date('2026-05-01T00:00:00.000Z');

describe('deputies tool', () => {
  it('spawns child sessions with inherited access, first message, lineage events, and stable retry ids', async () => {
    const { services, store } = await createDeputyServices();

    const first = await executeDeputyTool(services, {
      action: 'spawn',
      title: 'Child work',
      prompt: 'Investigate the cache miss.',
      idempotencyKey: 'cache-miss',
      notifyOnComplete: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);

    const session = first.session as { id: string; parentSessionId: string; spawnDepth: number };
    expect(session.parentSessionId).toBe(parentId);
    expect(session.spawnDepth).toBe(1);
    expect(first.url).toBe(`https://deputies.test/?session=${session.id}`);
    expect(first.idempotentReplay).toBe(false);

    const child = await store.getSession(session.id);
    expect(child).toMatchObject({
      id: session.id,
      status: 'queued',
      parentSessionId: parentId,
      spawnDepth: 1,
      ownerGroupId: defaultGroupId,
      visibility: 'group',
      writePolicy: 'group_members',
      context: { deputy: expect.objectContaining({ notifyParentOnComplete: true, parentSessionId: parentId }) },
    });
    await expect(store.getMessages(session.id)).resolves.toMatchObject([
      { sequence: 1, status: 'pending', source: 'deputy', prompt: 'Investigate the cache miss.' },
    ]);
    await expect(store.getEvents(parentId)).resolves.toMatchObject([
      expect.objectContaining({ type: 'session_created' }),
      expect.objectContaining({
        type: 'session_spawned',
        payload: expect.objectContaining({ childSessionId: session.id }),
      }),
    ]);

    const replay = await executeDeputyTool(services, {
      action: 'spawn',
      title: 'Child work',
      prompt: 'Investigate the cache miss.',
      idempotencyKey: 'cache-miss',
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error);
    expect((replay.session as { id: string }).id).toBe(session.id);
    expect(replay.idempotentReplay).toBe(true);
    await expect(store.listSessions()).resolves.toHaveLength(2);
    expect(services.runState.spawns).toBe(1);
  });

  it('refuses depth, child-count, and per-run spawn guardrail violations as tool results', async () => {
    const deep = await createDeputyServices({ parent: { spawnDepth: 2 }, maxSpawnDepth: 2 });
    await expect(executeDeputyTool(deep.services, { action: 'spawn', prompt: 'too deep' })).resolves.toMatchObject({
      ok: false,
      error: 'Cannot spawn child sessions beyond depth 2',
    });

    const children = await createDeputyServices({ maxChildrenPerSession: 1 });
    await expect(executeDeputyTool(children.services, { action: 'spawn', prompt: 'one' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(executeDeputyTool(children.services, { action: 'spawn', prompt: 'two' })).resolves.toMatchObject({
      ok: false,
      error: 'Cannot spawn more than 1 non-archived child sessions',
    });

    const perRun = await createDeputyServices({ maxSpawnsPerRun: 1 });
    await expect(executeDeputyTool(perRun.services, { action: 'spawn', prompt: 'one' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(executeDeputyTool(perRun.services, { action: 'spawn', prompt: 'two' })).resolves.toMatchObject({
      ok: false,
      error: 'Cannot spawn more than 1 child sessions in one run',
    });
  });

  it('returns structured errors for malformed input and disabled persistence', async () => {
    const { services, store } = await createDeputyServices();

    await expect(executeDeputyTool(services, null)).resolves.toEqual({
      ok: false,
      error: 'deputies params must be an object',
    });
    await expect(executeDeputyTool(services, { action: 'wat' })).resolves.toEqual({
      ok: false,
      error: 'deputies action must be one of: spawn, list_sessions, get_session, send_message, cancel',
    });

    services.shouldPersist = async () => false;
    await expect(executeDeputyTool(services, { action: 'spawn', prompt: 'blocked' })).resolves.toMatchObject({
      ok: false,
      action: 'spawn',
      error: 'Cannot mutate Deputies sessions because the parent run is no longer active',
    });
    await expect(store.listSessions()).resolves.toHaveLength(1);

    await expect(executeDeputyTool(services, { action: 'list_sessions' })).resolves.toMatchObject({
      ok: true,
      action: 'list_sessions',
    });
  });

  it('sends follow-ups only to non-archived direct children', async () => {
    const { services, store } = await createDeputyServices();
    const spawned = await executeDeputyTool(services, { action: 'spawn', prompt: 'child' });
    if (!spawned.ok) throw new Error(spawned.error);
    const childId = (spawned.session as { id: string }).id;

    await expect(
      executeDeputyTool(services, { action: 'send_message', sessionId: childId, prompt: 'follow up' }),
    ).resolves.toMatchObject({ ok: true, message: expect.objectContaining({ sequence: 2, source: 'deputy' }) });

    await store.updateSession({ ...(await store.getSession(childId))!, status: 'archived' });
    await expect(
      executeDeputyTool(services, { action: 'send_message', sessionId: childId, prompt: 'blocked' }),
    ).resolves.toMatchObject({
      ok: false,
      error: `Can only send messages to non-archived direct child sessions: ${childId}`,
    });
  });

  it('lists sessions by child, group, and organization-readable scopes', async () => {
    const { services, store } = await createDeputyServices();
    const spawned = await executeDeputyTool(services, { action: 'spawn', prompt: 'child' });
    if (!spawned.ok) throw new Error(spawned.error);
    const childId = (spawned.session as { id: string }).id;
    const sameGroupId = '00000000-0000-4000-8000-000000000201';
    const orgVisibleId = '00000000-0000-4000-8000-000000000202';
    const hiddenId = '00000000-0000-4000-8000-000000000203';
    await store.createSession(sessionRecord({ id: sameGroupId, title: 'Same group' }));
    await store.createSession(
      sessionRecord({ id: orgVisibleId, title: 'Org visible', ownerGroupId: otherGroupId, visibility: 'organization' }),
    );
    await store.createSession(
      sessionRecord({ id: hiddenId, title: 'Hidden', ownerGroupId: otherGroupId, visibility: 'group' }),
    );

    const children = await executeDeputyTool(services, { action: 'list_sessions', scope: 'children' });
    expect(children).toMatchObject({ ok: true, scope: 'children' });
    expect(sessionIds(children)).toEqual([childId]);

    const group = await executeDeputyTool(services, { action: 'list_sessions', scope: 'group' });
    expect(group).toMatchObject({ ok: true, scope: 'group' });
    expect(sessionIds(group).sort()).toEqual([parentId, childId, sameGroupId].sort());

    const organization = await executeDeputyTool(services, { action: 'list_sessions', scope: 'organization' });
    expect(organization).toMatchObject({ ok: true, scope: 'organization' });
    expect(sessionIds(organization).sort()).toEqual([parentId, childId, sameGroupId, orgVisibleId].sort());
  });

  it('cancels active direct child runs only', async () => {
    const { services, store } = await createDeputyServices();
    const spawned = await executeDeputyTool(services, { action: 'spawn', prompt: 'child' });
    if (!spawned.ok) throw new Error(spawned.error);
    const childId = (spawned.session as { id: string }).id;
    const [childMessage] = await store.getMessages(childId);
    await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000204',
      runnerType: 'test',
      leaseOwner: 'worker',
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      now,
    });

    await expect(executeDeputyTool(services, { action: 'cancel', sessionId: childId })).resolves.toMatchObject({
      ok: true,
      cancelledMessageIds: [childMessage!.id],
    });
    await expect(store.getMessages(childId)).resolves.toMatchObject([{ status: 'cancelling' }]);
    await expect(executeDeputyTool(services, { action: 'cancel', sessionId: parentId })).resolves.toMatchObject({
      ok: false,
      error: `Can only cancel non-archived direct child sessions: ${parentId}`,
    });
  });
});

function sessionIds(result: Awaited<ReturnType<typeof executeDeputyTool>>): string[] {
  if (!result.ok) throw new Error(result.error);
  return (result.sessions as Array<{ id: string }>).map((session) => session.id);
}

function sessionRecord(input: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    status: 'idle',
    spawnDepth: 0,
    ownerGroupId: defaultGroupId,
    visibility: 'group',
    writePolicy: 'group_members',
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

async function createDeputyServices(
  options: {
    parent?: Partial<SessionRecord>;
    maxSpawnDepth?: number;
    maxChildrenPerSession?: number;
    maxSpawnsPerRun?: number;
  } = {},
) {
  const store = new MemoryStore();
  const events = new EventService(store);
  const messages = new MessageService(store, events);
  const parent: SessionRecord = {
    id: parentId,
    status: 'idle',
    spawnDepth: 0,
    ownerGroupId: defaultGroupId,
    visibility: 'group',
    writePolicy: 'group_members',
    title: 'Parent',
    createdAt: now,
    updatedAt: now,
    ...options.parent,
  };
  await store.createSession(parent);
  await events.append({ sessionId: parent.id, type: 'session_created', payload: { title: parent.title ?? null } });

  const services: DeputyToolServices = {
    sessionId: parent.id,
    runId,
    messageId,
    store,
    events,
    messages,
    webBaseUrl: 'https://deputies.test',
    maxSpawnDepth: options.maxSpawnDepth ?? 2,
    maxChildrenPerSession: options.maxChildrenPerSession ?? 5,
    maxSpawnsPerRun: options.maxSpawnsPerRun ?? 3,
    runState: { spawns: 0 },
  };
  return { services, store };
}
