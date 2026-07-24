import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServices } from '../../src/app/server.js';
import { normalizeAppendInput } from '../../src/events/service.js';
import {
  PI_SESSION_DATA_VERSION,
  PostgresPiSessionStore,
  type PiSessionData,
} from '../../src/runner-pi/session-store.js';
import { runSessionSearchIndexerOnce } from '../../src/search/indexer.js';
import type { SessionListOptions } from '../../src/store/types.js';
import { PostgresStore } from '../../src/store/postgres.js';
import { waitFor } from '../support/http.js';
import { setupPostgresStoreSuite, testDatabaseUrl } from '../support/postgres-store-suite.js';
import { defineSessionTagsStoreContract } from '../support/session-tags-store-contract.js';
import { defineSnippetsStoreContract } from '../support/snippets-store-contract.js';
import { defineSkillsStoreContract } from '../support/skills-store-contract.js';

describe.skipIf(!testDatabaseUrl)('PostgresStore', () => {
  let pool: Pool;
  let store: PostgresStore;
  let databaseUrl: string;

  setupPostgresStoreSuite('postgres_store', (context) => {
    pool = context.pool;
    store = context.store;
    databaseUrl = context.databaseUrl;
  });

  defineSessionTagsStoreContract(() => store);
  defineSnippetsStoreContract(() => store);
  defineSkillsStoreContract(() => store);

  const authUser = (suffix: string, providerAccountId: string, role: 'admin' | 'member' = 'member') => ({
    userId: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    accountId: `10000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    provider: 'test',
    providerAccountId,
    username: `user-${suffix}`,
    role,
    profile: { login: suffix },
    now: new Date('2026-07-24T12:00:00.000Z'),
  });

  it('serializes concurrent first logins for the same provider account', async () => {
    const first = authUser('1', 'same-first-login');
    const second = { ...authUser('2', 'same-first-login'), username: 'updated-name', profile: { login: 'updated' } };

    const [firstResult, secondResult] = await Promise.all([
      store.upsertAuthUserForAccount(first),
      store.upsertAuthUserForAccount(second),
    ]);

    expect(secondResult.id).toBe(firstResult.id);
    const persisted = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM auth_accounts WHERE provider = $1 AND provider_account_id = $2`,
      [first.provider, first.providerAccountId],
    );
    expect(persisted.rows).toEqual([{ user_id: firstResult.id }]);
    await expect(pool.query('SELECT id FROM auth_users ORDER BY id')).resolves.toMatchObject({ rowCount: 1 });

    const session = await store.createAuthSession({
      id: 'concurrent-login-session',
      userId: secondResult.id,
      createdAt: first.now,
      expiresAt: new Date('2026-07-25T12:00:00.000Z'),
    });
    await expect(store.getAuthUserBySession({ sessionId: session.id, now: first.now })).resolves.toMatchObject({
      id: firstResult.id,
    });
  });

  it('preserves a role update racing an existing-account login', async () => {
    const original = await store.upsertAuthUserForAccount(authUser('3', 'role-race', 'admin'));
    await store.upsertAuthUserForAccount(authUser('30', 'role-race-remaining-admin', 'admin'));
    const lockClient = await pool.connect();
    await lockClient.query('BEGIN');
    await lockClient.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['test', 'role-race']);
    try {
      const login = store.upsertAuthUserForAccount({
        ...authUser('4', 'role-race', 'admin'),
        username: 'fresh-profile',
        displayName: 'Fresh Profile',
      });
      await store.updateAuthUserRole({
        userId: original.id,
        role: 'member',
        updatedAt: new Date('2026-07-24T12:01:00Z'),
      });
      await lockClient.query('COMMIT');

      await expect(login).resolves.toMatchObject({ id: original.id, role: 'member', username: 'fresh-profile' });
      await expect(store.getAuthUser(original.id)).resolves.toMatchObject({
        role: 'member',
        displayName: 'Fresh Profile',
      });
    } finally {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      lockClient.release();
    }
  });

  it('maps sole-admin demotion to last_admin', async () => {
    const admin = await store.upsertAuthUserForAccount(authUser('5', 'sole-admin', 'admin'));

    await expect(
      store.updateAuthUserRole({ userId: admin.id, role: 'member', updatedAt: new Date() }),
    ).rejects.toMatchObject({ code: 'last_admin' });
  });

  it('allows self or other demotion while another admin remains', async () => {
    const first = await store.upsertAuthUserForAccount(authUser('6', 'first-admin', 'admin'));
    const second = await store.upsertAuthUserForAccount(authUser('7', 'second-admin', 'admin'));

    await expect(
      store.updateAuthUserRole({ userId: first.id, role: 'member', updatedAt: new Date() }),
    ).resolves.toMatchObject({ id: first.id, role: 'member' });
    await store.updateAuthUserRole({ userId: first.id, role: 'admin', updatedAt: new Date() });
    await expect(
      store.updateAuthUserRole({ userId: second.id, role: 'member', updatedAt: new Date() }),
    ).resolves.toMatchObject({ id: second.id, role: 'member' });
  });

  it('allows exactly one of two concurrent admin demotions', async () => {
    const first = await store.upsertAuthUserForAccount(authUser('8', 'concurrent-admin-1', 'admin'));
    const second = await store.upsertAuthUserForAccount(authUser('9', 'concurrent-admin-2', 'admin'));

    const results = await Promise.allSettled([
      store.updateAuthUserRole({ userId: first.id, role: 'member', updatedAt: new Date() }),
      store.updateAuthUserRole({ userId: second.id, role: 'member', updatedAt: new Date() }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'last_admin' } });
    await expect(store.listAuthUsers()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'admin' }), expect.objectContaining({ role: 'member' })]),
    );
  });

  it('preserves session, message, and event behavior', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres test' });
    const message = await services.messages.enqueue({
      sessionId: session.id,
      prompt: 'Persist this message',
      source: 'test',
      context: { issue: 123 },
    });

    expect(await services.sessions.get(session.id)).toMatchObject({
      id: session.id,
      title: 'Postgres test',
      status: 'queued',
    });
    expect(await services.messages.list(session.id)).toMatchObject([
      {
        id: message.id,
        sessionId: session.id,
        sequence: 1,
        status: 'pending',
        prompt: 'Persist this message',
        source: 'test',
        context: { issue: 123 },
      },
    ]);

    const events = await services.events.list(session.id);
    expect(events.map((event) => event.type)).toEqual(['session_created', 'message_created']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);

    const restartedStore = new PostgresStore(databaseUrl);
    try {
      const restartedServices = createServices(restartedStore);
      const replayed = await restartedServices.events.list(session.id, 1);
      expect(replayed.map((event) => event.type)).toEqual(['message_created']);
    } finally {
      await restartedStore.close();
    }
  });

  it('persists immutable environment revisions, activity, and invocation references', async () => {
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Postgres environment',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
      actor: { type: 'system' },
    });
    const automation = await services.automations.createScheduled({
      name: 'Pinned Postgres automation',
      prompt: 'Use the original revision',
      scheduleCron: '0 9 * * *',
      environmentId: environment.id,
      environmentRevisionPolicy: 'pinned',
      environmentRevisionId: environment.currentRevisionId,
    });
    const revised = await services.environments.update({
      id: environment.id,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'web', primary: true }],
      actor: { type: 'system' },
    });

    const result = await services.automations.invokeManual({ automationId: automation.id });

    expect(revised.currentRevisionNumber).toBe(2);
    await expect(store.listEnvironmentRevisions(environment.id)).resolves.toMatchObject([
      { revisionNumber: 2, repositories: [{ repo: 'web' }] },
      { revisionNumber: 1, repositories: [{ repo: 'api' }] },
    ]);
    await expect(store.listEnvironmentActivity(environment.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'environment_created' }),
        expect.objectContaining({ type: 'revision_published', revisionId: revised.currentRevisionId }),
      ]),
    );
    expect(result.invocation).toMatchObject({
      environmentId: environment.id,
      environmentRevisionId: environment.currentRevisionId,
    });
  });

  it('batch-lists environments with isolated repositories in stable order', async () => {
    const emptyPool = new Pool({ connectionString: databaseUrl });
    const emptyStore = new PostgresStore(emptyPool);
    const emptyQueries = vi.spyOn(emptyPool, 'query');
    try {
      await expect(emptyStore.listEnvironments()).resolves.toEqual([]);
      expect(emptyQueries).toHaveBeenCalledTimes(1);
    } finally {
      await emptyStore.close();
    }

    const services = createServices(store);
    const first = await services.environments.create({
      name: 'First batched environment',
      repositories: [
        { provider: 'github', owner: 'acme', repo: 'first-api', primary: true },
        { provider: 'github', owner: 'acme', repo: 'first-web', branch: 'release', primary: false },
      ],
      actor: { type: 'system' },
    });
    const second = await services.environments.create({
      name: 'Second batched environment',
      repositories: [{ provider: 'github', owner: 'other', repo: 'second', primary: true }],
      actor: { type: 'system' },
    });
    await pool.query('UPDATE environments SET created_at = $2, updated_at = $2 WHERE id = $1', [
      first.id,
      new Date('2026-07-20T12:00:01.000Z'),
    ]);
    await pool.query('UPDATE environments SET created_at = $2, updated_at = $2 WHERE id = $1', [
      second.id,
      new Date('2026-07-20T12:00:02.000Z'),
    ]);

    const countedPool = new Pool({ connectionString: databaseUrl });
    const countedStore = new PostgresStore(countedPool);
    const queries = vi.spyOn(countedPool, 'query');
    try {
      const environments = await countedStore.listEnvironments();

      expect(queries).toHaveBeenCalledTimes(2);
      expect(environments.map((environment) => environment.id)).toEqual([second.id, first.id]);
      expect(environments).toMatchObject([
        {
          id: second.id,
          repositories: [{ owner: 'other', repo: 'second', isPrimary: true, position: 0 }],
        },
        {
          id: first.id,
          repositories: [
            { owner: 'acme', repo: 'first-api', isPrimary: true, position: 0 },
            { owner: 'acme', repo: 'first-web', branch: 'release', isPrimary: false, position: 1 },
          ],
        },
      ]);
    } finally {
      await countedStore.close();
    }
  });

  it('batch-groups repositories onto ordered environment revisions', async () => {
    const emptyPool = new Pool({ connectionString: databaseUrl });
    const emptyStore = new PostgresStore(emptyPool);
    const emptyQueries = vi.spyOn(emptyPool, 'query');
    try {
      await expect(emptyStore.listEnvironmentRevisions(randomUUID())).resolves.toEqual([]);
      expect(emptyQueries).toHaveBeenCalledTimes(1);
    } finally {
      await emptyStore.close();
    }

    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Batched revisions',
      repositories: [
        { provider: 'github', owner: 'acme', repo: 'original-primary', primary: true },
        { provider: 'github', owner: 'acme', repo: 'original-secondary', branch: 'v1', primary: false },
      ],
      actor: { type: 'system' },
    });
    await services.environments.update({
      id: environment.id,
      repositories: [{ provider: 'github', owner: 'beta', repo: 'middle', primary: true }],
      actor: { type: 'system' },
    });
    const latest = await services.environments.update({
      id: environment.id,
      repositories: [
        { provider: 'github', owner: 'gamma', repo: 'latest-worker', primary: false },
        { provider: 'github', owner: 'gamma', repo: 'latest-primary', branch: 'main', primary: true },
      ],
      actor: { type: 'system' },
    });

    const countedPool = new Pool({ connectionString: databaseUrl });
    const countedStore = new PostgresStore(countedPool);
    const queries = vi.spyOn(countedPool, 'query');
    try {
      const revisions = await countedStore.listEnvironmentRevisions(environment.id);

      expect(queries).toHaveBeenCalledTimes(2);
      expect(revisions.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
      expect(revisions).toMatchObject([
        {
          id: latest.currentRevisionId,
          repositories: [
            { owner: 'gamma', repo: 'latest-worker', primary: false, position: 0 },
            { owner: 'gamma', repo: 'latest-primary', branch: 'main', primary: true, position: 1 },
          ],
        },
        {
          repositories: [{ owner: 'beta', repo: 'middle', primary: true, position: 0 }],
        },
        {
          id: environment.currentRevisionId,
          repositories: [
            { owner: 'acme', repo: 'original-primary', primary: true, position: 0 },
            { owner: 'acme', repo: 'original-secondary', branch: 'v1', primary: false, position: 1 },
          ],
        },
      ]);
    } finally {
      await countedStore.close();
    }
  });

  it('persists Pi session data opaquely', async () => {
    const piStore = new PostgresPiSessionStore(databaseUrl);
    try {
      const session = await createServices(store).sessions.create({ title: 'Pi session data' });
      const data: PiSessionData = {
        version: PI_SESSION_DATA_VERSION,
        header: { id: session.id } as never,
        entries: [{ type: 'message', role: 'member', content: 'Persist this prompt' } as never],
      };

      await piStore.save(session.id, data);
      await expect(piStore.load(session.id)).resolves.toEqual(data);
      await piStore.delete(session.id);
      await expect(piStore.load(session.id)).resolves.toBeNull();
    } finally {
      await piStore.close();
    }
  });

  it('persists active sandbox lifecycle state', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Sandbox state' });
    const now = new Date();

    const created = await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000701',
      sessionId: session.id,
      provider: 'fake',
      providerSandboxId: 'fake-sandbox-1',
      status: 'ready',
      workspacePath: '/workspace',
      metadata: { target: 'test' },
      createdAt: now,
      updatedAt: now,
    });

    await expect(store.getActiveSandbox(session.id, 'fake')).resolves.toMatchObject({
      id: created.id,
      providerSandboxId: 'fake-sandbox-1',
      status: 'ready',
      metadata: { target: 'test' },
    });
    await expect(store.listActiveSandboxes(session.id, 'fake')).resolves.toMatchObject([{ id: created.id }]);
    await expect(
      store.listIdleSandboxes({ provider: 'fake', idleBefore: new Date(now.getTime() + 1_000), limit: 10 }),
    ).resolves.toMatchObject([{ id: created.id }]);
    await expect(
      store.listStoppableSandboxes({ provider: 'fake', idleBefore: new Date(now.getTime() + 1_000), limit: 10 }),
    ).resolves.toMatchObject([{ id: created.id }]);

    const checkedAt = new Date(now.getTime() + 1_000);
    await store.updateSandbox({
      ...created,
      status: 'unhealthy',
      lastHealthCheckAt: checkedAt,
      updatedAt: checkedAt,
    });
    await expect(store.getActiveSandbox(session.id, 'fake')).resolves.toMatchObject({
      status: 'unhealthy',
      lastHealthCheckAt: checkedAt,
    });

    await store.updateSandbox({
      ...created,
      status: 'stopped',
      lastHealthCheckAt: checkedAt,
      updatedAt: new Date(now.getTime() + 2_000),
    });
    await expect(store.getActiveSandbox(session.id, 'fake')).resolves.toMatchObject({
      status: 'stopped',
    });

    await store.updateSandbox({
      ...created,
      status: 'destroyed',
      destroyedAt: checkedAt,
      updatedAt: checkedAt,
    });
    await expect(store.getActiveSandbox(session.id, 'fake')).resolves.toBeNull();
    await expect(
      store.listIdleSandboxes({ provider: 'fake', idleBefore: new Date(now.getTime() + 3_000), limit: 10 }),
    ).resolves.toEqual([]);
  });

  it('lists sessions with their latest sandbox for one provider in a single batch', async () => {
    const services = createServices(store);
    const withSandboxes = await services.sessions.create({ title: 'Has sandboxes' });
    const otherProvider = await services.sessions.create({ title: 'Other provider only' });
    const withoutSandbox = await services.sessions.create({ title: 'No sandbox' });
    const now = new Date();

    await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000711',
      sessionId: withSandboxes.id,
      provider: 'fake',
      providerSandboxId: 'fake-sandbox-old',
      status: 'destroyed',
      workspacePath: '/workspace',
      metadata: {},
      createdAt: new Date(now.getTime() - 2_000),
      updatedAt: new Date(now.getTime() - 2_000),
    });
    await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000712',
      sessionId: withSandboxes.id,
      provider: 'fake',
      providerSandboxId: 'fake-sandbox-new',
      status: 'ready',
      workspacePath: '/workspace',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000713',
      sessionId: otherProvider.id,
      provider: 'docker',
      providerSandboxId: 'docker-sandbox-1',
      status: 'ready',
      workspacePath: '/workspace',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });

    const listed = await store.listSessionsWithLatestSandbox('fake', { archived: false, limit: 50 });
    const bySessionId = new Map(listed.items.map((item) => [item.session.id, item]));

    expect(listed.items.map((item) => item.session)).toEqual(
      (await store.listSessions()).filter((session) => session.status !== 'archived'),
    );
    expect(bySessionId.get(withSandboxes.id)?.sandbox).toMatchObject({
      providerSandboxId: 'fake-sandbox-new',
      status: 'ready',
    });
    expect(bySessionId.get(otherProvider.id)?.sandbox).toMatchObject({
      provider: 'docker',
      providerSandboxId: 'docker-sandbox-1',
      status: 'ready',
    });
    expect(bySessionId.get(withoutSandbox.id)?.sandbox).toBeNull();
  });

  it('includes tenant-wide sessions inside the batched session list query', async () => {
    const services = createServices(store);
    const first = await services.sessions.create({ title: 'Tenant session one' });
    const second = await services.sessions.create({ title: 'Tenant session two' });
    const third = await services.sessions.create({ title: 'Tenant session three' });

    const listed = await store.listSessionsWithLatestSandbox('fake', {
      archived: false,
      limit: 50,
    });
    const listedIds = listed.items.map((item) => item.session.id);

    expect(listedIds).toEqual(expect.arrayContaining([first.id, second.id, third.id]));
  });

  it('persists private ownership, filters discovery, and enforces irreversible promotion', async () => {
    const owner = await store.upsertAuthUserForAccount(authUser('701', 'private-session-owner'));
    const other = await store.upsertAuthUserForAccount(authUser('702', 'private-session-other'));
    const services = createServices(store);
    const tenant = await services.sessions.create({ title: 'Visible tenant session' });
    const privateSession = await services.sessions.create({
      title: 'Hidden private session',
      tags: ['owner-only'],
      visibility: 'private',
      ownerUserId: owner.id,
      createdByUserId: owner.id,
    });
    const privateChild = await store.createSession({
      id: '00000000-0000-4000-8000-000000000703',
      visibility: 'private',
      ownerUserId: owner.id,
      status: 'idle',
      parentSessionId: privateSession.id,
      spawnDepth: 1,
      createdByUserId: owner.id,
      createdAt: new Date('2026-07-24T12:01:00.000Z'),
      updatedAt: new Date('2026-07-24T12:01:00.000Z'),
      tags: [],
    });
    await store.upsertSessionSearchDocs([
      {
        sessionId: privateSession.id,
        kind: 'prompt',
        sourceId: 'private-search-doc',
        content: 'confidentialftsneedle',
        createdAt: new Date('2026-07-24T12:02:00.000Z'),
      },
    ]);

    const unauthenticated = await store.listSessionsWithLatestSandbox('fake', { archived: false, limit: 50 });
    expect(unauthenticated.items.map((item) => item.session.id)).toContain(tenant.id);
    expect(unauthenticated.items.map((item) => item.session.id)).not.toContain(privateSession.id);

    const ownerList = await store.listSessionsWithLatestSandbox('fake', {
      archived: false,
      visibleToUserId: owner.id,
      limit: 50,
    });
    expect(ownerList.items.map((item) => item.session.id)).toEqual(
      expect.arrayContaining([tenant.id, privateSession.id]),
    );
    const otherList = await store.listSessionsWithLatestSandbox('fake', {
      archived: false,
      visibleToUserId: other.id,
      limit: 50,
    });
    expect(otherList.items.map((item) => item.session.id)).not.toContain(privateSession.id);
    await expect(store.searchSessions('fake', { query: 'confidentialftsneedle', limit: 50 })).resolves.toMatchObject({
      items: [],
    });
    await expect(
      store.searchSessions('fake', { query: 'confidentialftsneedle', visibleToUserId: other.id, limit: 50 }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      store.searchSessions('fake', { query: 'confidentialftsneedle', visibleToUserId: owner.id, limit: 50 }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          item: expect.objectContaining({ session: expect.objectContaining({ id: privateSession.id }) }),
        }),
      ],
    });
    await expect(store.listSessionTags({ limit: 50, visibleToUserId: owner.id })).resolves.toContainEqual({
      tag: 'owner-only',
      sessionCount: 1,
    });
    await expect(store.listSessionTags({ limit: 50, visibleToUserId: other.id })).resolves.not.toContainEqual(
      expect.objectContaining({ tag: 'owner-only' }),
    );

    const parsedDatabaseUrl = new URL(databaseUrl);
    const singleConnectionPool = new Pool({
      host: parsedDatabaseUrl.hostname,
      port: Number(parsedDatabaseUrl.port || 5432),
      user: decodeURIComponent(parsedDatabaseUrl.username),
      password: decodeURIComponent(parsedDatabaseUrl.password),
      database: parsedDatabaseUrl.pathname.slice(1),
      max: 1,
    });
    const singleConnectionStore = new PostgresStore(singleConnectionPool);
    const promotionResult = await singleConnectionStore.withPrivateSessionWriteLease(owner.id, privateChild.id, () =>
      singleConnectionStore.updateSessionMetadataWithEvent({
        id: privateChild.id,
        promoteToTenant: true,
        updatedAt: new Date(),
      }),
    );
    await singleConnectionStore.close();
    const promotedChild = promotionResult.session;
    expect(promotedChild).toMatchObject({ visibility: 'tenant', ownerUserId: owner.id });
    await expect(store.getSession(privateSession.id)).resolves.toMatchObject({ visibility: 'private' });

    const promoted = await services.sessions.update({ id: privateSession.id, promoteToTenant: true });
    expect(promoted).toMatchObject({ visibility: 'tenant', ownerUserId: owner.id });
    await expect(store.getSession(privateChild.id)).resolves.toMatchObject({
      visibility: 'tenant',
      ownerUserId: owner.id,
    });
    await expect(store.getEvents(privateSession.id)).resolves.toContainEqual(
      expect.objectContaining({ type: 'session_visibility_changed', payload: { visibility: 'tenant' } }),
    );
    await expect(
      pool.query(`UPDATE sessions SET visibility = 'private' WHERE id = $1`, [privateSession.id]),
    ).rejects.toThrow('tenant sessions cannot become private');
    await expect(
      pool.query(`UPDATE sessions SET owner_user_id = $2 WHERE id = $1`, [privateSession.id, other.id]),
    ).rejects.toThrow('session owner is immutable');
    await expect(
      store.createSession({
        ...privateChild,
        id: '00000000-0000-4000-8000-000000000704',
        visibility: 'private',
      }),
    ).resolves.toMatchObject({ visibility: 'private', parentSessionId: privateSession.id });
  });

  it('counts and paginates all tenant direct child sessions', async () => {
    const services = createServices(store);
    const now = new Date('2026-07-19T00:00:00.000Z');
    const parent = await services.sessions.create({ title: 'Child-count parent' });
    const firstChild = await store.createSession({
      id: '00000000-0000-4000-8000-000000000724',
      status: 'created',
      title: 'First direct child',
      parentSessionId: parent.id,
      spawnDepth: 1,
      createdAt: now,
      updatedAt: now,
    });
    const secondChild = await store.createSession({
      id: '00000000-0000-4000-8000-000000000725',
      status: 'created',
      title: 'Second direct child',
      parentSessionId: parent.id,
      spawnDepth: 1,
      createdAt: now,
      updatedAt: now,
    });

    const options: SessionListOptions = {
      archived: false,
      limit: 50,
    };
    const parentPage = await store.listSessionsWithLatestSandbox('fake', options);
    expect(parentPage.items.find(({ session }) => session.id === parent.id)?.directChildCount).toBe(2);

    const childPage = await store.listSessionsWithLatestSandbox('fake', {
      ...options,
      parentSessionId: parent.id,
    });
    expect(childPage.items.map(({ session }) => session.id)).toEqual([secondChild.id, firstChild.id]);
  });

  it('paginates session lists with archived filtering', async () => {
    const services = createServices(store);
    const first = await services.sessions.create({ title: 'First page' });
    const second = await services.sessions.create({ title: 'Second page' });
    const archived = await services.sessions.create({ title: 'Archived page' });
    await services.sessions.archive(archived.id);

    const firstPage = await store.listSessionsWithLatestSandbox('fake', { archived: false, limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await store.listSessionsWithLatestSandbox('fake', {
      archived: false,
      limit: 5,
      cursor: firstPage.nextCursor!,
    });
    const activeIds = [...firstPage.items, ...secondPage.items].map((item) => item.session.id);
    expect(activeIds).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(activeIds).not.toContain(archived.id);

    const archivedPage = await store.listSessionsWithLatestSandbox('fake', { archived: true, limit: 5 });
    expect(archivedPage.items.map((item) => item.session.id)).toContain(archived.id);
  });

  it('paginates sessions with identical timestamps using id tie-breaking', async () => {
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const ids = [
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000103',
    ];
    for (const id of ids) {
      await store.createSession({
        id,
        status: 'created',
        spawnDepth: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        title: `Tie ${id}`,
      });
    }

    const firstPage = await store.listSessionsWithLatestSandbox('fake', { archived: false, limit: 2 });
    expect(firstPage.items.map((item) => item.session.id)).toEqual([ids[2], ids[1]]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await store.listSessionsWithLatestSandbox('fake', {
      archived: false,
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items.map((item) => item.session.id)).toEqual([ids[0]]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('paginates tenant-wide session lists', async () => {
    const services = createServices(store);
    const tenantSessions = [
      await services.sessions.create({ title: 'Tenant page one' }),
      await services.sessions.create({ title: 'Tenant page two' }),
      await services.sessions.create({ title: 'Tenant page three' }),
    ];

    let cursor = undefined as
      | Awaited<ReturnType<PostgresStore['listSessionsWithLatestSandbox']>>['nextCursor']
      | undefined;
    const seen: string[] = [];
    for (;;) {
      const page = await store.listSessionsWithLatestSandbox('fake', {
        archived: false,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((item) => item.session.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(tenantSessions.length);
    expect(new Set(seen)).toEqual(new Set(tenantSessions.map((session) => session.id)));
  });

  it('searches session docs tenant-wide', async () => {
    const services = createServices(store);
    const now = new Date();
    const first = await services.sessions.create({ title: 'First search target' });
    const second = await services.sessions.create({ title: 'Second search target' });
    await store.upsertSessionSearchDocs([
      { sessionId: first.id, kind: 'prompt', sourceId: 'first', content: 'needle prompt content', createdAt: now },
      { sessionId: second.id, kind: 'prompt', sourceId: 'second', content: 'needle tenant content', createdAt: now },
    ]);

    const results = await store.searchSessions('fake', {
      query: 'needle',
      limit: 10,
    });
    const ids = results.items.map((item) => item.item.session.id);
    expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(results.items[0]?.matchKind).toBe('prompt');
  });

  it('deduplicates repeated search docs in one upsert batch', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Duplicate search docs' });
    await store.upsertSessionSearchDocs([
      {
        sessionId: session.id,
        kind: 'title',
        sourceId: session.id,
        content: 'old duplicate content',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        sessionId: session.id,
        kind: 'title',
        sourceId: session.id,
        content: 'new duplicate content',
        createdAt: new Date('2026-01-01T00:00:01Z'),
      },
    ]);

    const results = await store.searchSessions('fake', { query: 'new', limit: 10 });
    expect(results.items.map((item) => item.item.session.id)).toContain(session.id);
  });

  it('deduplicates repeated title docs from one indexer batch', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'initial duplicate title' });
    await services.sessions.update({ id: session.id, title: 'olderduplicate title' });
    await services.sessions.update({ id: session.id, title: 'newerduplicate title' });

    await runSessionSearchIndexerOnce({ store, events: services.events });

    expect(
      (await store.searchSessions('fake', { query: 'newerduplicate', limit: 10 })).items.map(
        (item) => item.item.session.id,
      ),
    ).toContain(session.id);
    expect(
      (await store.searchSessions('fake', { query: 'olderduplicate', limit: 10 })).items.map(
        (item) => item.item.session.id,
      ),
    ).not.toContain(session.id);
  });

  it('batch-loads affected messages while preserving search doc behavior and ordering', async () => {
    const services = createServices(store);
    const firstSession = await services.sessions.create({ title: 'First batch session' });
    const firstMessage = await services.messages.enqueue({
      sessionId: firstSession.id,
      prompt: 'oldbatched prompt',
      source: 'test',
    });
    const secondSession = await services.sessions.create({ title: 'Second batch session' });
    const secondMessage = await services.messages.enqueue({
      sessionId: secondSession.id,
      prompt: 'secondbatched prompt',
      source: 'test',
    });
    await services.messages.updatePending({
      sessionId: firstSession.id,
      messageId: firstMessage.id,
      prompt: 'firstbatched updated prompt',
    });

    const getMessages = vi.spyOn(store, 'getMessages');
    const getMessagesByIds = vi.spyOn(store, 'getMessagesByIds');
    const upsertSearchDocs = vi.spyOn(store, 'upsertSessionSearchDocs');

    await runSessionSearchIndexerOnce({ store, events: services.events });

    expect(getMessages).not.toHaveBeenCalled();
    expect(getMessagesByIds).toHaveBeenCalledOnce();
    expect(getMessagesByIds).toHaveBeenCalledWith([firstMessage.id, secondMessage.id]);
    expect(upsertSearchDocs).toHaveBeenCalledWith([
      expect.objectContaining({ sessionId: firstSession.id, kind: 'title', sourceId: firstSession.id }),
      expect.objectContaining({
        sessionId: firstSession.id,
        kind: 'prompt',
        sourceId: firstMessage.id,
        content: 'firstbatched updated prompt',
      }),
      expect.objectContaining({ sessionId: secondSession.id, kind: 'title', sourceId: secondSession.id }),
      expect.objectContaining({
        sessionId: secondSession.id,
        kind: 'prompt',
        sourceId: secondMessage.id,
        content: 'secondbatched prompt',
      }),
    ]);
    expect(
      (await store.searchSessions('fake', { query: 'firstbatched', limit: 10 })).items.map(
        (item) => item.item.session.id,
      ),
    ).toEqual([firstSession.id]);
    expect(
      (await store.searchSessions('fake', { query: 'oldbatched', limit: 10 })).items.map(
        (item) => item.item.session.id,
      ),
    ).not.toContain(firstSession.id);
  });

  it('loads multiple message IDs with one Postgres query and skips empty batches', async () => {
    const services = createServices(store);
    const firstSession = await services.sessions.create({ title: 'First query batch session' });
    const firstMessage = await services.messages.enqueue({
      sessionId: firstSession.id,
      prompt: 'first query batch prompt',
    });
    const secondSession = await services.sessions.create({ title: 'Second query batch session' });
    const secondMessage = await services.messages.enqueue({
      sessionId: secondSession.id,
      prompt: 'second query batch prompt',
    });
    const batchPool = new Pool({ connectionString: databaseUrl });
    const batchStore = new PostgresStore(batchPool);
    const query = vi.spyOn(batchPool, 'query');

    try {
      await expect(batchStore.getMessagesByIds([firstMessage.id, secondMessage.id])).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: firstMessage.id, sessionId: firstSession.id }),
          expect.objectContaining({ id: secondMessage.id, sessionId: secondSession.id }),
        ]),
      );
      expect(query).toHaveBeenCalledOnce();
      expect(query.mock.calls[0]?.[0]).toContain('WHERE id = ANY($1::uuid[])');

      query.mockClear();
      await expect(batchStore.getMessagesByIds([])).resolves.toEqual([]);
      expect(query).not.toHaveBeenCalled();
    } finally {
      await batchStore.close();
    }
  });

  it('reindexes edited prompts from message update events', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Prompt edit search' });
    const message = await services.messages.enqueue({
      sessionId: session.id,
      prompt: 'oldneedle prompt content',
      source: 'test',
    });

    await runSessionSearchIndexerOnce({ store, events: services.events });
    const oldNeedleIds = (await store.searchSessions('fake', { query: 'oldneedle', limit: 10 })).items.map(
      (item) => item.item.session.id,
    );
    expect(oldNeedleIds).toContain(session.id);

    await services.messages.updatePending({
      sessionId: session.id,
      messageId: message.id,
      prompt: 'newneedle prompt content',
      context: { skills: ['review-code'] },
    });
    await expect(store.getMessage({ sessionId: session.id, messageId: message.id })).resolves.toMatchObject({
      context: { skills: ['review-code'] },
    });
    await runSessionSearchIndexerOnce({ store, events: services.events });

    const newNeedleIds = (await store.searchSessions('fake', { query: 'newneedle', limit: 10 })).items.map(
      (item) => item.item.session.id,
    );
    const staleNeedleIds = (await store.searchSessions('fake', { query: 'oldneedle', limit: 10 })).items.map(
      (item) => item.item.session.id,
    );
    expect(newNeedleIds).toContain(session.id);
    expect(staleNeedleIds).not.toContain(session.id);
  });

  it('indexes final agent responses for search', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Response search' });
    await services.events.append({
      sessionId: session.id,
      type: 'agent_response_final',
      payload: { text: 'The connected Notion integration works end-to-end.' },
    });

    await runSessionSearchIndexerOnce({ store, events: services.events });

    const results = await store.searchSessions('fake', { query: 'notion', limit: 10 });
    expect(results.items.map((item) => item.item.session.id)).toContain(session.id);
    expect(results.items.find((item) => item.item.session.id === session.id)?.matchKind).toBe('response');
  });

  it('limits event reads when a batch size is requested', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Event limits' });
    for (let index = 0; index < 5; index += 1) {
      await services.events.append({ sessionId: session.id, type: 'session_queue_paused', payload: {} });
    }

    const firstTwo = await store.getEvents(session.id, 0, 2);
    expect(firstTwo.map((event) => event.sequence)).toEqual([1, 2]);

    const nextTwo = await store.getEvents(session.id, firstTwo[1]!.sequence, 2);
    expect(nextTwo.map((event) => event.sequence)).toEqual([3, 4]);

    const unbounded = await store.getEvents(session.id);
    expect(unbounded).toHaveLength(6);

    const globalFirst = await store.listEvents(0, 3);
    expect(globalFirst).toHaveLength(3);
    const globalRest = await store.listEvents(globalFirst[2]!.id, 100);
    expect(globalRest).toHaveLength(3);
    expect([...globalFirst, ...globalRest].map((event) => event.id)).toEqual(
      (await store.listEvents()).map((event) => event.id),
    );
  });

  it('commits session updates atomically with their session_updated event', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Atomic update' });

    const updated = await services.sessions.update({ id: session.id, title: 'Atomic update' });
    expect(updated.title).toBe('Atomic update');

    const events = await store.getEvents(session.id);
    expect(events.map((event) => event.type)).toEqual(['session_created', 'session_updated']);
    expect(events[1]).toMatchObject({
      sequence: 2,
      payload: { title: 'Atomic update' },
    });
    await expect(store.getSession(session.id)).resolves.toMatchObject({ title: 'Atomic update' });
  });

  it('atomically replaces only the current title fallback', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Fallback title' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'Fallback title' });
    const runId = randomUUID();
    const leaseOwner = 'title-test-worker';
    const now = new Date();
    await store.claimNextPendingMessage({
      runId,
      runnerType: 'test',
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      now,
    });

    const generated = await store.updateSessionTitleIfCurrent({
      id: session.id,
      expectedTitle: 'Fallback title',
      title: 'Generated title',
      updatedAt: now,
      runId,
      leaseOwner,
      now,
    });
    expect(generated?.session.title).toBe('Generated title');
    await expect(
      store.updateSessionTitleIfCurrent({
        id: session.id,
        expectedTitle: 'Fallback title',
        title: 'Stale generated title',
        updatedAt: new Date(),
        runId,
        leaseOwner,
        now: new Date(),
      }),
    ).resolves.toBeNull();
    expect((await store.getEvents(session.id)).map((event) => event.type)).toEqual([
      'session_created',
      'message_created',
      'session_updated',
    ]);
  });

  it('commits idempotent archive and targeted restore transitions with their events', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Lifecycle transition' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'pending work' });

    await services.sessions.archive(session.id);
    await services.sessions.archive(session.id);
    await services.sessions.update({ id: session.id, title: 'Changed while archived' });
    const restored = await services.sessions.unarchive(session.id);
    await services.sessions.unarchive(session.id);

    expect(restored).toMatchObject({
      status: 'idle',
      title: 'Changed while archived',
    });
    expect((await store.getEvents(session.id)).map((event) => event.type)).toEqual([
      'session_created',
      'message_created',
      'message_cancelled',
      'session_archived',
      'session_updated',
      'session_unarchived',
    ]);
    await expect(store.getMessages(session.id)).resolves.toMatchObject([{ status: 'cancelled' }]);
  });

  it('rejects archived queue pause and resume without changing activity or events', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Archived queue transitions' });
    await services.sessions.archive(session.id);
    const before = await store.getSession(session.id);
    const eventsBefore = await store.getEvents(session.id);

    await expect(store.pauseSessionQueue({ sessionId: session.id, pausedAt: new Date() })).rejects.toMatchObject({
      code: 'session_archived',
    });
    await expect(store.resumeSessionQueue({ sessionId: session.id })).rejects.toMatchObject({
      code: 'session_archived',
    });

    await expect(store.getSession(session.id)).resolves.toEqual(before);
    await expect(store.getEvents(session.id)).resolves.toEqual(eventsBefore);
  });

  it('creates a child session with its first message atomically and enforces child caps', async () => {
    const services = createServices(store);
    const parent = await services.sessions.create({ title: 'Parent session' });
    const now = new Date('2026-05-06T00:00:00.000Z');
    const childSession = {
      id: '00000000-0000-4000-8000-000000000931',
      status: 'queued' as const,
      title: 'Child session',
      parentSessionId: parent.id,
      spawnDepth: 1,
      createdAt: now,
      updatedAt: now,
    };
    const input = {
      session: childSession,
      message: {
        id: '00000000-0000-4000-8000-000000000932',
        prompt: 'start child work',
        source: 'deputy',
        authorName: 'Deputy: Parent session',
        createdAt: now,
      },
      sessionCreatedEvent: normalizeAppendInput({
        sessionId: childSession.id,
        type: 'session_created',
        payload: { title: childSession.title, parentSessionId: parent.id, spawnDepth: 1 },
      }),
      messageCreatedEvent: normalizeAppendInput({
        sessionId: childSession.id,
        messageId: '00000000-0000-4000-8000-000000000932',
        type: 'message_created',
        payload: { sequence: 1, source: 'deputy' },
      }),
      parentSpawnedEvent: normalizeAppendInput({
        sessionId: parent.id,
        type: 'session_spawned',
        payload: {
          childSessionId: childSession.id,
          title: childSession.title,
          spawnDepth: childSession.spawnDepth,
        },
      }),
      parentChildLimit: { parentSessionId: parent.id, maxNonArchivedChildren: 1 },
    };

    const created = await store.createSessionWithFirstMessage(input);
    expect(created.created).toBe(true);
    expect(created.session).toMatchObject({ id: childSession.id, parentSessionId: parent.id, spawnDepth: 1 });
    expect(created.message).toMatchObject({ sequence: 1, status: 'pending', source: 'deputy' });
    await expect(
      store.getMessage({ sessionId: childSession.id, messageId: '00000000-0000-4000-8000-000000000932' }),
    ).resolves.toMatchObject({ sequence: 1, status: 'pending', source: 'deputy' });
    await store.appendEventWithNextSequence({
      sessionId: childSession.id,
      messageId: '00000000-0000-4000-8000-000000000932',
      type: 'agent_response_final',
      payload: { text: 'child final response' },
      createdAt: now,
    });
    await expect(store.getSessionTranscript({ sessionId: childSession.id, limit: 1 })).resolves.toMatchObject({
      entries: [
        {
          message: expect.objectContaining({ sequence: 1, prompt: 'start child work' }),
          finalResponse: expect.objectContaining({ payload: { text: 'child final response' } }),
        },
      ],
      hasMore: false,
    });
    await expect(store.getEvents(childSession.id)).resolves.toMatchObject([
      { sequence: 1, type: 'session_created' },
      { sequence: 2, type: 'message_created' },
      { sequence: 3, type: 'agent_response_final' },
    ]);
    await expect(store.getEvents(parent.id)).resolves.toMatchObject([
      { sequence: 1, type: 'session_created' },
      { sequence: 2, type: 'session_spawned' },
    ]);

    const replay = await store.createSessionWithFirstMessage(input);
    expect(replay.created).toBe(false);
    expect(replay.session.id).toBe(childSession.id);
    await expect(
      store.createSessionWithFirstMessage({
        ...input,
        session: {
          ...childSession,
          id: '00000000-0000-4000-8000-000000000938',
          visibility: 'private',
          ownerUserId: '00000000-0000-4000-8000-000000000939',
        },
        message: { ...input.message, id: '00000000-0000-4000-8000-000000000940' },
      }),
    ).rejects.toThrow('Parent session access changed while spawning child');
    await expect(services.messages.enqueue({ sessionId: childSession.id, prompt: 'follow-up' })).resolves.toMatchObject(
      {
        sequence: 2,
      },
    );
    await expect(store.getSessionMessageSummary(childSession.id)).resolves.toMatchObject({
      count: 2,
      lastMessage: expect.objectContaining({ sequence: 2, prompt: 'follow-up' }),
    });
    await expect(
      store.listSessionsForAgent({
        actingSessionId: parent.id,
        scope: 'children',
        limit: 1,
      }),
    ).resolves.toMatchObject([expect.objectContaining({ id: childSession.id })]);
    await expect(store.listChildSessions({ parentSessionId: parent.id, limit: 1 })).resolves.toMatchObject([
      expect.objectContaining({ id: childSession.id }),
    ]);

    await expect(
      store.createSessionWithFirstMessage({
        ...input,
        session: { ...childSession, id: '00000000-0000-4000-8000-000000000933' },
        message: { ...input.message, id: '00000000-0000-4000-8000-000000000934' },
      }),
    ).rejects.toThrow('Cannot spawn more than 1 non-archived child sessions');
    await expect(
      store.createSessionWithFirstMessage({
        ...input,
        session: {
          ...childSession,
          id: '00000000-0000-4000-8000-000000000935',
          parentSessionId: parent.id,
        },
        message: { ...input.message, id: '00000000-0000-4000-8000-000000000936' },
        parentChildLimit: {
          parentSessionId: '00000000-0000-4000-8000-000000000937',
          maxNonArchivedChildren: 5,
        },
      }),
    ).rejects.toThrow('Parent child limit must match the session parent');
  });

  it('claims pending messages as a queue batch and respects queue pause', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres queue' });
    const first = await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });
    const second = await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });

    await services.sessions.pauseQueue(session.id);
    await expect(
      store.claimNextPendingMessageBatch({
        runId: '00000000-0000-4000-8000-000000000901',
        runnerType: 'fake',
        leaseOwner: 'worker-1',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        now: new Date(),
      }),
    ).resolves.toBeNull();

    await expect(
      services.messages.updatePending({ sessionId: session.id, messageId: second.id, prompt: 'edited second' }),
    ).resolves.toMatchObject({ prompt: 'edited second' });
    await services.sessions.resumeQueue(session.id);

    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000902',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });

    expect(claimed?.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(claimed?.messages.map((message) => message.prompt)).toEqual(['first', 'edited second']);
    expect(claimed?.run.metadata).toMatchObject({ messageIds: [first.id, second.id], sequences: [1, 2] });

    await store.beginRunCompletion({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      now: new Date(),
      result: { text: 'done' },
    });
    const completed = await store.completeRunBatch({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      completedAt: new Date(),
    });
    expect(completed?.messages.map((message) => message.status)).toEqual(['completed', 'completed']);
  });

  it('attaches steering messages to the owned active run in sequence order', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres steering queue' });
    const primary = await services.messages.enqueue({ sessionId: session.id, prompt: 'primary' });
    const now = new Date();
    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000903',
      runnerType: 'pi',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    await store.persistActiveRunExecutionSignature({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      now: new Date(),
      signature: { repository: { owner: 'acme', repo: 'app' }, model: 'model-1' },
    });
    const ordinary = await services.messages.enqueue({ sessionId: session.id, prompt: 'ordinary' });
    const first = await services.messages.enqueue({
      sessionId: session.id,
      prompt: 'first steer',
      context: { model: 'model-1', repository: { repo: 'app', owner: 'acme' } },
    });
    const second = await services.messages.enqueue({
      sessionId: session.id,
      prompt: 'second steer',
      context: { repository: { owner: 'acme', repo: 'app' }, model: 'model-1' },
    });
    const incompatible = await services.messages.enqueue({
      sessionId: session.id,
      prompt: 'wrong model',
      context: { repository: { owner: 'acme', repo: 'app' }, model: 'model-2' },
    });
    await services.messages.updatePending({ sessionId: session.id, messageId: first.id, steering: true });
    await services.messages.updatePending({ sessionId: session.id, messageId: second.id, steering: true });
    await services.messages.updatePending({ sessionId: session.id, messageId: incompatible.id, steering: true });

    const steering = await store.claimPendingSteeringMessages({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      now: new Date(),
    });

    expect(steering.map((message) => message.id)).toEqual([first.id, second.id]);
    await expect(store.getMessage({ sessionId: session.id, messageId: incompatible.id })).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(store.getMessage({ sessionId: session.id, messageId: ordinary.id })).resolves.toMatchObject({
      status: 'pending',
      steering: false,
    });
    await expect(store.getRun(claimed!.run.id)).resolves.toMatchObject({
      metadata: {
        messageIds: [primary.id, first.id, second.id],
        sequences: [primary.sequence, first.sequence, second.sequence],
      },
    });

    await store.beginRunCompletion({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      now: new Date(),
      result: { text: 'done' },
    });
    const completed = await store.completeRunBatch({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      completedAt: new Date(),
    });
    expect(completed?.messages.map((message) => message.id)).toEqual([primary.id, first.id, second.id]);
    expect(completed?.messages.every((message) => message.status === 'completed')).toBe(true);

    const next = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000904',
      runnerType: 'pi',
      leaseOwner: 'worker-2',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    expect(next?.messages.map((message) => message.id)).toEqual([ordinary.id, incompatible.id]);
  });

  it('canonicalizes execution signatures when claiming steering in Postgres', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres execution signature' });
    const primary = await services.messages.enqueue({ sessionId: session.id, prompt: 'primary' });
    const now = new Date();
    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000905',
      runnerType: 'pi',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    const beforeSignature = await services.messages.enqueue({ sessionId: session.id, prompt: 'before signature' });
    await services.messages.updatePending({ sessionId: session.id, messageId: beforeSignature.id, steering: true });
    await expect(
      store.claimPendingSteeringMessages({ runId: claimed!.run.id, leaseOwner: 'worker-1', now }),
    ).resolves.toEqual([]);

    await store.persistActiveRunExecutionSignature({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      now,
      signature: { repository: null, environment: undefined, ignored: 'value' },
    });
    const emptyContexts: Record<string, unknown>[] = [
      { callback: { type: 'http' } },
      { repository: null, environment: null, model: undefined },
    ];
    const emptyCandidates = await Promise.all(
      emptyContexts.map(async (context, index) => {
        const message = await services.messages.enqueue({
          sessionId: session.id,
          prompt: `empty signature ${index}`,
          context,
        });
        await services.messages.updatePending({ sessionId: session.id, messageId: message.id, steering: true });
        return message;
      }),
    );
    await expect(
      store.claimPendingSteeringMessages({ runId: claimed!.run.id, leaseOwner: 'worker-1', now }),
    ).resolves.toMatchObject([beforeSignature, ...emptyCandidates].map(({ id }) => ({ id, status: 'processing' })));

    const signature = {
      repository: { owner: 'acme', options: { mirror: null, depth: 1 } },
      environment: { region: 'us', variables: { OPTIONAL: null } },
      branch: 'main',
      model: 'provider/model-a',
      reasoningLevel: 'high',
    };
    await store.persistActiveRunExecutionSignature({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      now,
      signature,
    });
    const candidates = [
      ['reordered keys', { ...signature, repository: { options: { depth: 1, mirror: null }, owner: 'acme' } }],
      ['nested null changed', { ...signature, repository: { owner: 'acme', options: { depth: 1 } } }],
      ['repository changed', { ...signature, repository: { owner: 'other' } }],
      ['environment changed', { ...signature, environment: { region: 'eu' } }],
      ['revision changed', { ...signature, environment: { ...signature.environment, revision: 'two' } }],
      ['branch changed', { ...signature, branch: 'other' }],
      ['model changed', { ...signature, model: 'provider/model-b' }],
      ['reasoning changed', { ...signature, reasoningLevel: 'low' }],
    ] as const;
    const messages = await Promise.all(
      candidates.map(async ([prompt, context]) => {
        const message = await services.messages.enqueue({ sessionId: session.id, prompt, context });
        await services.messages.updatePending({
          sessionId: session.id,
          messageId: message.id,
          steering: true,
          context,
        });
        return message;
      }),
    );
    await expect(
      store.claimPendingSteeringMessages({ runId: claimed!.run.id, leaseOwner: 'worker-1', now }),
    ).resolves.toMatchObject([{ id: messages[0]!.id, status: 'processing' }]);
    await expect(store.getRun(claimed!.run.id)).resolves.toMatchObject({
      metadata: {
        messageIds: [primary.id, beforeSignature.id, ...emptyCandidates.map(({ id }) => id), messages[0]!.id],
      },
    });
    const run = await store.getRun(claimed!.run.id);
    expect(messages.slice(1).every((message) => !(run?.metadata.messageIds as string[]).includes(message.id))).toBe(
      true,
    );
    await Promise.all(
      messages.slice(1).map((message) =>
        expect(store.getMessage({ sessionId: session.id, messageId: message.id })).resolves.toMatchObject({
          status: 'pending',
        }),
      ),
    );
  });

  it('does not double-claim one session under concurrent workers', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres concurrent queue' });
    const first = await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });
    const second = await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });
    const now = new Date();

    const claims = await Promise.all(
      [1, 2].map((worker) =>
        store.claimNextPendingMessageBatch({
          runId: `00000000-0000-4000-8000-00000000091${worker}`,
          runnerType: 'fake',
          leaseOwner: `worker-${worker}`,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
          now,
        }),
      ),
    );

    const claimed = claims.filter((claim) => claim !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  it('waits for recovery before reclaiming a session with an expired active run', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres expired active run' });
    const first = await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });
    const claimedAt = new Date('2026-05-06T00:00:00.000Z');

    const staleClaim = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000925',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(claimedAt.getTime() - 1_000),
      now: claimedAt,
    });
    expect(staleClaim?.messages.map((message) => message.id)).toEqual([first.id]);

    const second = await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });
    const afterExpiry = new Date(claimedAt.getTime() + 1_000);
    await expect(
      store.claimNextPendingMessageBatch({
        runId: '00000000-0000-4000-8000-000000000926',
        runnerType: 'fake',
        leaseOwner: 'worker-2',
        leaseExpiresAt: new Date(afterExpiry.getTime() + 60_000),
        now: afterExpiry,
      }),
    ).resolves.toBeNull();

    await store.recoverStaleRuns({ now: afterExpiry, limit: 10 });
    const reclaimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000927',
      runnerType: 'fake',
      leaseOwner: 'worker-2',
      leaseExpiresAt: new Date(afterExpiry.getTime() + 60_000),
      now: afterExpiry,
    });

    expect(reclaimed?.messages.map((message) => message.id)).toEqual([first.id, second.id]);
  });

  it('skips locked sessions while preserving pending message order', async () => {
    const services = createServices(store);
    const oldestSession = await services.sessions.create({ title: 'Postgres oldest locked queue' });
    const newestSession = await services.sessions.create({ title: 'Postgres newest queue' });
    const oldestMessage = await store.createMessage({
      id: '00000000-0000-4000-8000-000000000923',
      sessionId: oldestSession.id,
      sequence: 1,
      status: 'pending',
      prompt: 'oldest',
      createdAt: new Date('2026-05-06T00:00:00.000Z'),
    });
    const newestMessage = await store.createMessage({
      id: '00000000-0000-4000-8000-000000000924',
      sessionId: newestSession.id,
      sequence: 1,
      status: 'pending',
      prompt: 'newest',
      createdAt: new Date('2026-05-06T00:00:01.000Z'),
    });
    const now = new Date();
    const locker = await pool.connect();

    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [oldestSession.id]);

      const skippedLocked = await store.claimNextPendingMessageBatch({
        runId: '00000000-0000-4000-8000-000000000921',
        runnerType: 'fake',
        leaseOwner: 'worker-1',
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        now,
      });

      expect(skippedLocked?.messages.map((message) => message.id)).toEqual([newestMessage.id]);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }

    const claimedOldest = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000922',
      runnerType: 'fake',
      leaseOwner: 'worker-2',
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      now,
    });

    expect(claimedOldest?.messages.map((message) => message.id)).toEqual([oldestMessage.id]);
  });

  it('does not lock messages before sessions when cancelling pending messages', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres cancel lock order' });
    const message = await services.messages.enqueue({ sessionId: session.id, prompt: 'cancel me' });
    const sessionLocker = await pool.connect();
    const messageLocker = await pool.connect();
    let cancel: Promise<unknown> | undefined;

    try {
      await sessionLocker.query('BEGIN');
      await sessionLocker.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [session.id]);

      cancel = store.cancelPendingMessage({
        sessionId: session.id,
        messageId: message.id,
        cancelledAt: new Date(),
      });

      await waitFor(async () => {
        const result = await pool.query<{ count: string }>(
          `SELECT count(*)
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query LIKE 'SELECT id FROM sessions WHERE id = $1 FOR UPDATE%'`,
        );
        return Number(result.rows[0]?.count ?? 0) > 0;
      });

      await messageLocker.query('BEGIN');
      await expect(
        messageLocker.query('SELECT id FROM messages WHERE id = $1 FOR UPDATE NOWAIT', [message.id]),
      ).resolves.toBeDefined();
    } finally {
      await messageLocker.query('ROLLBACK').catch(() => undefined);
      messageLocker.release();
      await sessionLocker.query('ROLLBACK').catch(() => undefined);
      sessionLocker.release();
    }

    await expect(cancel).resolves.toMatchObject({ id: message.id, status: 'cancelled' });
  });

  it('does not claim pending messages for archived sessions', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres archived queue' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'do not run' });
    await services.sessions.archive(session.id);

    await expect(
      store.claimNextPendingMessageBatch({
        runId: '00000000-0000-4000-8000-0000000009a1',
        runnerType: 'fake',
        leaseOwner: 'worker-1',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        now: new Date(),
      }),
    ).resolves.toBeNull();
  });

  it('keeps cancelling postgres run batches active until finalized', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres cancel' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });

    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000903',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    expect(claimed?.messages).toHaveLength(2);
    if (!claimed) throw new Error('Expected batch to be claimed');

    const cancelling = await store.requestRunCancellation({
      sessionId: session.id,
      requestedAt: new Date(),
      error: 'cancelled by test',
    });

    expect(cancelling?.run.status).toBe('cancelling');
    expect(cancelling?.messages.map((message) => message.status)).toEqual(['cancelling', 'cancelling']);
    await expect(
      store.completeRunBatch({ runId: claimed.run.id, leaseOwner: 'worker-1', completedAt: new Date() }),
    ).resolves.toBeNull();
    await expect(
      store.failRunBatch({
        runId: claimed.run.id,
        leaseOwner: 'worker-1',
        failedAt: new Date(),
        error: 'must not win cancellation',
      }),
    ).resolves.toBeNull();
    await services.messages.enqueue({ sessionId: session.id, prompt: 'third' });
    await expect(
      store.claimNextPendingMessageBatch({
        runId: '00000000-0000-4000-8000-000000000904',
        runnerType: 'fake',
        leaseOwner: 'worker-2',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        now: new Date(),
      }),
    ).resolves.toBeNull();

    const cancelled = await store.finalizeRunCancellation({
      runId: claimed.run.id,
      leaseOwner: 'worker-1',
      cancelledAt: new Date(),
      error: 'cancelled by test',
    });
    expect(cancelled?.messages.map((message) => message.status)).toEqual(['cancelled', 'cancelled']);
    await expect(store.getRun(claimed.run.id)).resolves.toMatchObject({
      status: 'cancelled',
      error: 'cancelled by test',
    });
    await expect(services.sessions.get(session.id)).resolves.toMatchObject({ status: 'queued' });
  });

  it('rejects stale postgres run completion after recovery', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres stale completion' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });

    const claimedAt = new Date('2026-05-06T00:00:00.000Z');
    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000905',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(claimedAt.getTime() - 1_000),
      now: claimedAt,
    });
    expect(claimed).not.toBeNull();

    await store.recoverStaleRuns({ now: new Date(claimedAt.getTime() + 1_000), limit: 10 });

    await expect(
      store.completeRunBatch({
        runId: claimed!.run.id,
        leaseOwner: 'worker-1',
        completedAt: new Date(claimedAt.getTime() + 2_000),
      }),
    ).resolves.toBeNull();
    await expect(store.getRun(claimed!.run.id)).resolves.toMatchObject({ status: 'stale' });
    await expect(services.messages.list(session.id)).resolves.toMatchObject([{ status: 'pending' }]);
  });

  it('rejects postgres run completion after lease expiration', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres expired completion' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });

    const claimedAt = new Date('2026-05-06T00:00:00.000Z');
    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000906',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(claimedAt.getTime() + 1_000),
      now: claimedAt,
    });
    expect(claimed).not.toBeNull();

    await expect(
      store.completeRunBatch({
        runId: claimed!.run.id,
        leaseOwner: 'worker-1',
        completedAt: new Date(claimedAt.getTime() + 2_000),
      }),
    ).resolves.toBeNull();
    await expect(store.getRun(claimed!.run.id)).resolves.toMatchObject({ status: 'running' });
    await expect(services.messages.list(session.id)).resolves.toMatchObject([{ status: 'processing' }]);
  });

  it('runs postgres advisory locks on only one holder', async () => {
    const locked = await store.withAdvisoryLock(12345, async () => {
      const competing = new PostgresStore(databaseUrl);
      try {
        return competing.withAdvisoryLock(12345, async () => 'competing');
      } finally {
        await competing.close();
      }
    });

    expect(locked).toBeNull();
    await expect(store.withAdvisoryLock(12345, async () => 'released')).resolves.toBe('released');
  });

  it('persists artifacts and callback deliveries', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Outputs' });
    const message = await services.messages.enqueue({ sessionId: session.id, prompt: 'produce output' });
    const now = new Date();

    const artifact = await store.createArtifact({
      id: '00000000-0000-4000-8000-000000000801',
      sessionId: session.id,
      messageId: message.id,
      type: 'external_link',
      url: 'https://example.com/result',
      payload: { ok: true },
      createdAt: now,
    });
    await expect(store.getArtifacts(session.id)).resolves.toMatchObject([
      { id: artifact.id, url: 'https://example.com/result' },
    ]);

    const delivery = await store.createCallbackDelivery({
      id: '00000000-0000-4000-8000-000000000802',
      sessionId: session.id,
      messageId: message.id,
      targetType: 'http',
      target: { url: 'https://example.com/callback' },
      eventType: 'message_completed',
      payload: { text: 'done' },
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
    expect(delivery.status).toBe('pending');

    await store.claimDueCallbackDeliveries({ now, limit: 1 });
    const sent = await store.markCallbackDeliverySent({
      id: delivery.id,
      deliveredAt: new Date(now.getTime() + 1_000),
    });
    expect(sent).toMatchObject({ status: 'sent', attempts: 1 });

    await expect(store.listCallbackDeliveries({ sessionId: session.id })).resolves.toMatchObject([
      { id: delivery.id, status: 'sent' },
    ]);
  });

  it('requeues failed callback deliveries for replay', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Callback replay' });
    const now = new Date();
    const delivery = await store.createCallbackDelivery({
      id: '00000000-0000-4000-8000-000000000803',
      sessionId: session.id,
      targetType: 'http',
      target: { url: 'https://example.com/callback' },
      eventType: 'message_completed',
      payload: { text: 'done' },
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      maxAttempts: 1,
    });
    await store.claimDueCallbackDeliveries({ now, limit: 1 });
    await store.markCallbackDeliveryFailed({ id: delivery.id, failedAt: now, error: 'down', terminal: true });

    const replay = await store.requestCallbackReplay({
      sessionId: session.id,
      deliveryId: delivery.id,
      requestedAt: new Date(now.getTime() + 1_000),
    });

    expect(replay).toMatchObject({ id: delivery.id, status: 'pending', attempts: 1 });
    await expect(
      store.claimDueCallbackDeliveries({ now: new Date(now.getTime() + 1_000), limit: 1 }),
    ).resolves.toMatchObject([{ id: delivery.id, status: 'sending' }]);
  });

  it('claims each pending message once under concurrent workers', async () => {
    const services = createServices(store);
    const firstSession = await services.sessions.create({ title: 'First' });
    const secondSession = await services.sessions.create({ title: 'Second' });
    await services.messages.enqueue({ sessionId: firstSession.id, prompt: 'first' });
    await services.messages.enqueue({ sessionId: secondSession.id, prompt: 'second' });

    const now = new Date();
    const claims = await Promise.all([
      store.claimNextPendingMessage({
        runId: '00000000-0000-4000-8000-000000000001',
        runnerType: 'fake',
        leaseOwner: 'worker-1',
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        now,
      }),
      store.claimNextPendingMessage({
        runId: '00000000-0000-4000-8000-000000000002',
        runnerType: 'fake',
        leaseOwner: 'worker-2',
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        now,
      }),
    ]);

    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((claim) => claim!.message.id)).size).toBe(2);
    await expect(
      store.claimNextPendingMessage({
        runId: '00000000-0000-4000-8000-000000000003',
        runnerType: 'fake',
        leaseOwner: 'worker-3',
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        now,
      }),
    ).resolves.toBeNull();
  });

  it('recovers stale processing messages for retry', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Stale run' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'retry me' });

    const claimed = await store.claimNextPendingMessage({
      runId: '00000000-0000-4000-8000-000000000011',
      runnerType: 'fake',
      leaseOwner: 'crashed-worker',
      leaseExpiresAt: new Date(Date.now() - 1_000),
      now: new Date(Date.now() - 2_000),
    });
    expect(claimed).toBeTruthy();

    const recovered = await store.recoverStaleRuns({ now: new Date(), limit: 10 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.run.status).toBe('stale');
    expect(recovered[0]!.message.status).toBe('pending');

    const retried = await store.claimNextPendingMessage({
      runId: '00000000-0000-4000-8000-000000000012',
      runnerType: 'fake',
      leaseOwner: 'new-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    expect(retried?.message.id).toBe(claimed!.message.id);
  });

  it('recovers all messages in a stale processing batch for retry', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Stale batch' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });

    const claimedAt = new Date('2026-05-06T00:00:00.000Z');
    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000013',
      runnerType: 'fake',
      leaseOwner: 'crashed-worker',
      leaseExpiresAt: new Date(claimedAt.getTime() - 1_000),
      now: claimedAt,
    });
    expect(claimed?.messages).toHaveLength(2);

    const recovered = await store.recoverStaleRuns({ now: new Date(claimedAt.getTime() + 1_000), limit: 10 });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.messages.map((message) => message.status)).toEqual(['pending', 'pending']);
    await expect(services.messages.list(session.id)).resolves.toMatchObject([
      { status: 'pending' },
      { status: 'pending' },
    ]);
    await expect(services.sessions.get(session.id)).resolves.toMatchObject({ status: 'queued' });
  });

  it('finalizes a stale run whose messages were already finalized', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Postgres stale finalized message' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'already done' });

    const claimedAt = new Date('2026-05-06T00:00:00.000Z');
    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000014',
      runnerType: 'fake',
      leaseOwner: 'crashed-worker',
      leaseExpiresAt: new Date(claimedAt.getTime() - 1_000),
      now: claimedAt,
    });
    expect(claimed?.messages).toHaveLength(1);

    await pool.query(`UPDATE messages SET status = 'cancelled' WHERE id = $1`, [claimed!.messages[0]!.id]);

    const recovered = await store.recoverStaleRuns({ now: new Date(claimedAt.getTime() + 1_000), limit: 10 });

    expect(recovered).toEqual([]);
    const runAfterFirst = await pool.query<{
      status: string;
      lease_owner: string | null;
      lease_expires_at: Date | null;
      error: string | null;
    }>(`SELECT status, lease_owner, lease_expires_at, error FROM runs WHERE id = $1`, [claimed!.run.id]);
    expect(runAfterFirst.rows[0]).toEqual({
      status: 'stale',
      lease_owner: null,
      lease_expires_at: null,
      error: 'Run lease expired',
    });
    await expect(services.messages.list(session.id)).resolves.toMatchObject([{ status: 'cancelled' }]);
    await expect(services.sessions.get(session.id)).resolves.toMatchObject({ status: 'idle' });

    await expect(store.recoverStaleRuns({ now: new Date(claimedAt.getTime() + 2_000), limit: 10 })).resolves.toEqual(
      [],
    );
    const runAfterSecond = await pool.query(
      `SELECT status, lease_owner, lease_expires_at, error FROM runs WHERE id = $1`,
      [claimed!.run.id],
    );
    expect(runAfterSecond.rows[0]).toEqual(runAfterFirst.rows[0]);
    await expect(services.sessions.get(session.id)).resolves.toMatchObject({ status: 'idle' });
  });

  it('applies the stale run limit before skipping zero-message recoveries', async () => {
    const services = createServices(store);
    const finalizedSession = await services.sessions.create({ title: 'Postgres limit finalized first' });
    await services.messages.enqueue({ sessionId: finalizedSession.id, prompt: 'already done' });
    const recoverableSession = await services.sessions.create({ title: 'Postgres limit recoverable second' });
    await services.messages.enqueue({ sessionId: recoverableSession.id, prompt: 'retry later' });

    const claimedAt = new Date('2026-05-06T00:00:00.000Z');
    const finalizedClaim = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000015',
      runnerType: 'fake',
      leaseOwner: 'crashed-worker-1',
      leaseExpiresAt: new Date(claimedAt.getTime() - 2_000),
      now: claimedAt,
    });
    const recoverableClaim = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000016',
      runnerType: 'fake',
      leaseOwner: 'crashed-worker-2',
      leaseExpiresAt: new Date(claimedAt.getTime() - 1_000),
      now: claimedAt,
    });
    expect(finalizedClaim?.messages).toHaveLength(1);
    expect(recoverableClaim?.messages).toHaveLength(1);

    await pool.query(`UPDATE messages SET status = 'cancelled' WHERE id = $1`, [finalizedClaim!.messages[0]!.id]);

    const recoveredFirst = await store.recoverStaleRuns({ now: new Date(claimedAt.getTime() + 1_000), limit: 1 });

    expect(recoveredFirst).toEqual([]);
    await expect(store.getRun(finalizedClaim!.run.id)).resolves.toMatchObject({ status: 'stale' });
    await expect(store.getRun(recoverableClaim!.run.id)).resolves.toMatchObject({ status: 'running' });
    await expect(services.messages.list(recoverableSession.id)).resolves.toMatchObject([{ status: 'processing' }]);

    const recoveredSecond = await store.recoverStaleRuns({ now: new Date(claimedAt.getTime() + 2_000), limit: 1 });

    expect(recoveredSecond).toHaveLength(1);
    expect(recoveredSecond[0]!.run.id).toBe(recoverableClaim!.run.id);
    expect(recoveredSecond[0]!.message.id).toBe(recoverableClaim!.messages[0]!.id);
    await expect(services.messages.list(recoverableSession.id)).resolves.toMatchObject([{ status: 'pending' }]);
  });

  it('renews run leases so active work is not recovered as stale', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Heartbeat' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'keep alive' });

    const claimedAt = new Date();
    const claimed = await store.claimNextPendingMessage({
      runId: '00000000-0000-4000-8000-000000000021',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(claimedAt.getTime() + 1_000),
      now: claimedAt,
    });
    expect(claimed).toBeTruthy();

    const renewed = await store.renewRunLease({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(claimedAt.getTime() + 60_000),
      heartbeatAt: new Date(claimedAt.getTime() + 500),
    });
    expect(renewed?.leaseOwner).toBe('worker-1');

    await expect(store.recoverStaleRuns({ now: new Date(claimedAt.getTime() + 2_000), limit: 10 })).resolves.toEqual(
      [],
    );
  });

  it('does not renew expired run leases', async () => {
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Expired heartbeat' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'too late' });

    const claimedAt = new Date();
    const claimed = await store.claimNextPendingMessage({
      runId: '00000000-0000-4000-8000-000000000022',
      runnerType: 'fake',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(claimedAt.getTime() + 1_000),
      now: claimedAt,
    });
    expect(claimed).toBeTruthy();

    const renewed = await store.renewRunLease({
      runId: claimed!.run.id,
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(claimedAt.getTime() + 60_000),
      heartbeatAt: new Date(claimedAt.getTime() + 2_000),
    });
    expect(renewed).toBeNull();

    await expect(store.getRun(claimed!.run.id)).resolves.toMatchObject({
      leaseExpiresAt: new Date(claimedAt.getTime() + 1_000),
    });
  });
});
