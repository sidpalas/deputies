import { randomUUID } from 'node:crypto';
import { validateToolArguments } from '@earendil-works/pi-ai/compat';
import { createServices } from '../../src/app/server.js';
import { createPiScheduledFollowUpsToolDefinition } from '../../src/runner-pi/scheduled-follow-ups-tool.js';
import { executeScheduledFollowUpsTool } from '../../src/scheduled-follow-ups/tool.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('scheduled follow-ups tool authorization', () => {
  let store: MemoryStore;
  let acting: string;
  let child: string;
  let services: ReturnType<typeof createServices>;

  beforeEach(async () => {
    store = new MemoryStore();
    services = createServices(store);
    acting = randomUUID();
    child = randomUUID();
    await store.createSession(record(acting));
    await store.createSession(record(child, { parentSessionId: acting, spawnDepth: 1 }));
  });

  it('allows tenant sessions regardless of lineage but rejects archived targets', async () => {
    await expect(run({ action: 'list' })).resolves.toMatchObject({ ok: true });
    await expect(run({ action: 'list', sessionId: child })).resolves.toMatchObject({ ok: true });
    const unrelated = randomUUID();
    await store.createSession(record(unrelated));
    await expect(run({ action: 'list', sessionId: unrelated })).resolves.toMatchObject({ ok: true });
    await store.archiveSession({ sessionId: child, archivedAt: new Date() });
    await expect(run({ action: 'list', sessionId: child })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('target_forbidden'),
    });
  });

  it('allows a private acting session to target only same-owner private sessions', async () => {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    await createUser(owner, 'owner');
    await createUser(otherOwner, 'other');
    acting = randomUUID();
    await store.createSession(record(acting, { visibility: 'private', ownerUserId: owner }));
    const sameOwner = randomUUID();
    const otherPrivate = randomUUID();
    await store.createSession(record(sameOwner, { visibility: 'private', ownerUserId: owner }));
    await store.createSession(record(otherPrivate, { visibility: 'private', ownerUserId: otherOwner }));

    await expect(run({ action: 'list' })).resolves.toMatchObject({ ok: true });
    await expect(run({ action: 'list', sessionId: sameOwner })).resolves.toMatchObject({ ok: true });
    await expect(run({ action: 'list', sessionId: otherPrivate })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('target_forbidden'),
    });

    await store.updateSessionMetadataWithEvent({
      id: acting,
      promoteToTenant: true,
      updatedAt: new Date('2026-07-24T00:02:00Z'),
    });
    await expect(run({ action: 'list', sessionId: sameOwner })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('target_forbidden'),
    });
  });

  it('requires an idempotency key and blocks mutations after persistence lease loss', async () => {
    await expect(run({ action: 'create', prompt: 'later', schedule: future() })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('idempotencyKey'),
    });
    await expect(
      run({ action: 'create', prompt: 'later', schedule: future(), idempotencyKey: 'key' }, async () => false),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('run_inactive') });
    await expect(services.scheduledFollowUps.list(acting, 10)).resolves.toEqual([]);
  });

  it('normalizes JSON-encoded schedule arguments before Pi validates them', () => {
    const tool = createPiScheduledFollowUpsToolDefinition({
      store,
      scheduledFollowUps: services.scheduledFollowUps,
      sessionId: acting,
      runId: randomUUID(),
      messageId: randomUUID(),
    });
    const schedule = future();
    const input = { action: 'create', prompt: 'later', schedule: JSON.stringify(schedule), idempotencyKey: 'key' };
    const validate = (args: Record<string, unknown>) =>
      validateToolArguments(tool, {
        type: 'toolCall',
        id: 'tool-call',
        name: tool.name,
        arguments: tool.prepareArguments?.(args) ?? args,
      });

    expect(validate(input)).toEqual({ ...input, schedule });
    expect(validate({ ...input, schedule })).toEqual({ ...input, schedule });
    for (const invalid of ['{invalid', 'null', '[]', '42', '"text"', '{}', '{"kind":"once"}']) {
      expect(() => validate({ ...input, schedule: invalid })).toThrow();
    }
    expect(() => validate({ ...input, schedule: JSON.stringify({ ...schedule, extra: true }) })).toThrow();
  });

  function run(value: unknown, shouldPersist?: () => Promise<boolean>) {
    return executeScheduledFollowUpsTool(
      {
        store,
        scheduledFollowUps: services.scheduledFollowUps,
        sessionId: acting,
        runId: randomUUID(),
        messageId: randomUUID(),
        ...(shouldPersist ? { shouldPersist } : {}),
      },
      value,
    );
  }

  async function createUser(userId: string, name: string) {
    await store.upsertAuthUserForAccount({
      userId,
      accountId: randomUUID(),
      provider: 'test',
      providerAccountId: name,
      username: name,
      role: 'member',
      profile: {},
      now: new Date('2026-07-24T00:00:00Z'),
    });
  }
});

function record(id: string, extra = {}) {
  const now = new Date('2026-07-24T00:00:00Z');
  return { id, status: 'idle' as const, title: id, tags: [], spawnDepth: 0, createdAt: now, updatedAt: now, ...extra };
}
function future() {
  return { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString() };
}
