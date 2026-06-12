import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, createServices, type AppServices } from '../../src/app/server.js';
import type { ArtifactObjectStorage, StoredArtifactObject } from '../../src/artifacts/storage.js';
import { loadConfig } from '../../src/config/index.js';
import { MemoryStore } from '../../src/store/memory.js';
import type {
  AuthUserRecord,
  GroupRole,
  SessionRecord,
  SessionVisibility,
  SessionWritePolicy,
} from '../../src/store/types.js';

const sessionCookieName = 'dev_deputies_session';
const unauthorizedReadStatus = 403;
const groupAId = '00000000-0000-4000-8000-0000000000a1';
const groupBId = '00000000-0000-4000-8000-0000000000b1';

const personaNames = ['aAdmin', 'aCreator', 'aMember', 'aViewer', 'bMember', 'orgUser'] as const;
type PersonaName = (typeof personaNames)[number];

const userIds: Record<PersonaName, string> = {
  aAdmin: '00000000-0000-4000-8000-000000001001',
  aCreator: '00000000-0000-4000-8000-000000001002',
  aMember: '00000000-0000-4000-8000-000000001003',
  aViewer: '00000000-0000-4000-8000-000000001004',
  bMember: '00000000-0000-4000-8000-000000001005',
  orgUser: '00000000-0000-4000-8000-000000001006',
};

const accountIds: Record<PersonaName, string> = {
  aAdmin: '00000000-0000-4000-8000-000000002001',
  aCreator: '00000000-0000-4000-8000-000000002002',
  aMember: '00000000-0000-4000-8000-000000002003',
  aViewer: '00000000-0000-4000-8000-000000002004',
  bMember: '00000000-0000-4000-8000-000000002005',
  orgUser: '00000000-0000-4000-8000-000000002006',
};

const groupAPersonas = new Set<PersonaName>(['aAdmin', 'aCreator', 'aMember', 'aViewer']);

const sessionCases = [
  { key: 'group/group_members', visibility: 'group', writePolicy: 'group_members' },
  { key: 'group/creator_only', visibility: 'group', writePolicy: 'creator_only' },
  { key: 'organization/group_members', visibility: 'organization', writePolicy: 'group_members' },
  { key: 'organization/creator_only', visibility: 'organization', writePolicy: 'creator_only' },
] as const satisfies ReadonlyArray<{
  key: string;
  visibility: SessionVisibility;
  writePolicy: SessionWritePolicy;
}>;
type SessionKey = (typeof sessionCases)[number]['key'];
type SessionCase = (typeof sessionCases)[number];

type MatrixFixture = {
  artifactIds: Record<SessionKey, string>;
  cookies: Record<PersonaName, string>;
  sessions: Record<SessionKey, SessionRecord>;
  users: Record<PersonaName, AuthUserRecord>;
};

type ReadRoute = {
  name: string;
  path: (input: { artifactId: string; session: SessionRecord }) => string;
};

const readRoutes: ReadRoute[] = [
  { name: 'session detail', path: ({ session }) => `/sessions/${session.id}` },
  { name: 'messages list', path: ({ session }) => `/sessions/${session.id}/messages` },
  { name: 'events list', path: ({ session }) => `/sessions/${session.id}/events` },
  { name: 'artifacts list', path: ({ session }) => `/sessions/${session.id}/artifacts` },
  {
    name: 'artifact download',
    path: ({ artifactId, session }) => `/sessions/${session.id}/artifacts/${artifactId}/download`,
  },
  {
    name: 'artifact preview',
    path: ({ artifactId, session }) => `/sessions/${session.id}/artifacts/${artifactId}/preview`,
  },
  { name: 'external resources', path: ({ session }) => `/sessions/${session.id}/external-resources` },
  { name: 'callbacks list', path: ({ session }) => `/sessions/${session.id}/callbacks` },
  { name: 'services list', path: ({ session }) => `/sessions/${session.id}/services` },
];

type WriteRoute = {
  body?: (input: WriteRouteInput) => Record<string, unknown>;
  expectedStatus?: (persona: PersonaName, sessionCase: SessionCase) => number;
  method: 'DELETE' | 'PATCH' | 'POST';
  name: string;
  path: (input: WriteRouteInput) => string;
  prepare?: (input: WriteRoutePrepareInput) => Promise<WriteRouteFixture>;
  successStatus: number;
};

type WriteRouteFixture = {
  deliveryId?: string;
  messageId?: string;
};

type WriteRouteInput = WriteRouteFixture & {
  session: SessionRecord;
};

type WriteRoutePrepareInput = {
  services: AppServices;
  session: SessionRecord;
  store: MemoryStore;
};

const writeRoutes: WriteRoute[] = [
  {
    name: 'update title',
    method: 'PATCH',
    path: ({ session }) => `/sessions/${session.id}`,
    body: () => ({ title: 'Updated by matrix' }),
    successStatus: 200,
  },
  {
    name: 'update access',
    method: 'PATCH',
    path: ({ session }) => `/sessions/${session.id}/access`,
    body: ({ session }) => ({ visibility: session.visibility === 'group' ? 'organization' : 'group' }),
    expectedStatus: (persona) => (persona === 'aAdmin' ? 200 : 403),
    successStatus: 200,
  },
  {
    name: 'archive session',
    method: 'POST',
    path: ({ session }) => `/sessions/${session.id}/archive`,
    successStatus: 200,
  },
  {
    name: 'unarchive session',
    method: 'POST',
    path: ({ session }) => `/sessions/${session.id}/unarchive`,
    prepare: async ({ services, session }) => {
      await services.sessions.archive(session.id);
      return {};
    },
    successStatus: 200,
  },
  {
    name: 'pause queue',
    method: 'POST',
    path: ({ session }) => `/sessions/${session.id}/queue/pause`,
    successStatus: 200,
  },
  {
    name: 'resume queue',
    method: 'POST',
    path: ({ session }) => `/sessions/${session.id}/queue/resume`,
    prepare: async ({ services, session }) => {
      await services.sessions.pauseQueue(session.id);
      return {};
    },
    successStatus: 200,
  },
  {
    name: 'cancel current run',
    method: 'POST',
    path: ({ session }) => `/sessions/${session.id}/runs/current/cancel`,
    prepare: async ({ services, session, store }) => {
      await services.messages.enqueue({ sessionId: session.id, prompt: 'cancel active run' });
      const now = new Date();
      const claimed = await store.claimNextPendingMessageBatch({
        runId: `matrix-run-${session.id}`,
        runnerType: 'matrix',
        leaseOwner: 'matrix-worker',
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        now,
      });
      if (!claimed || claimed.run.sessionId !== session.id) throw new Error(`Expected active run for ${session.id}`);
      return {};
    },
    successStatus: 200,
  },
  {
    name: 'enqueue message',
    method: 'POST',
    path: ({ session }) => `/sessions/${session.id}/messages`,
    body: () => ({ prompt: 'hello from the access matrix' }),
    successStatus: 202,
  },
  {
    name: 'edit message',
    method: 'PATCH',
    path: ({ messageId, session }) => `/sessions/${session.id}/messages/${requiredId(messageId, 'messageId')}`,
    body: () => ({ prompt: 'edited by matrix' }),
    prepare: async ({ services, session }) => ({
      messageId: (await services.messages.enqueue({ sessionId: session.id, prompt: 'pending edit' })).id,
    }),
    successStatus: 200,
  },
  {
    name: 'cancel message',
    method: 'POST',
    path: ({ messageId, session }) => `/sessions/${session.id}/messages/${requiredId(messageId, 'messageId')}/cancel`,
    prepare: async ({ services, session }) => ({
      messageId: (await services.messages.enqueue({ sessionId: session.id, prompt: 'pending cancel' })).id,
    }),
    successStatus: 200,
  },
  {
    name: 'retry message',
    method: 'POST',
    path: ({ messageId, session }) => `/sessions/${session.id}/messages/${requiredId(messageId, 'messageId')}/retry`,
    prepare: async ({ session, store }) => ({ messageId: await createFailedMessage(store, session) }),
    successStatus: 202,
  },
  {
    name: 'replay callback',
    method: 'POST',
    path: ({ deliveryId, session }) =>
      `/sessions/${session.id}/callbacks/${requiredId(deliveryId, 'deliveryId')}/replay`,
    prepare: async ({ session, store }) => ({ deliveryId: await createFailedCallback(store, session) }),
    successStatus: 200,
  },
];

describe('session object-level authorization matrix', () => {
  let baseUrl: string;
  let fixture: MatrixFixture;
  let server: Server;
  let services: AppServices;
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    services = createServices(store, { artifactObjectStorage: new InMemoryArtifactObjectStorage() });
    server = createServer(
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_SESSION_SECRET: 'test-secret',
        AUTH_STATIC_USERNAME: 'admin',
        AUTH_STATIC_PASSWORD: 'password',
      }),
      services,
    );
    baseUrl = await listen(server);
    fixture = await seedFixture(store, services);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('enforces cross-group read access for session-scoped read routes', async () => {
    for (const route of readRoutes) {
      for (const sessionCase of sessionCases) {
        const session = fixture.sessions[sessionCase.key];
        const artifactId = fixture.artifactIds[sessionCase.key];

        for (const persona of personaNames) {
          const response = await fetch(`${baseUrl}${route.path({ artifactId, session })}`, {
            headers: { cookie: fixture.cookies[persona] },
          });
          const expectedStatus = expectedReadStatus(persona, sessionCase.visibility);

          expect(response.status, matrixLabel('read', route.name, persona, sessionCase)).toBe(expectedStatus);
          await response.arrayBuffer();
        }
      }
    }
  });

  it('rejects cross-group users before opening session event streams', async () => {
    for (const sessionCase of sessionCases.filter((candidate) => candidate.visibility === 'group')) {
      const session = fixture.sessions[sessionCase.key];

      for (const persona of ['bMember', 'orgUser'] as const) {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 1_000);
        const response = await fetch(`${baseUrl}/sessions/${session.id}/events/stream`, {
          headers: { cookie: fixture.cookies[persona] },
          signal: abort.signal,
        });
        clearTimeout(timeout);

        await response.body?.cancel().catch(() => undefined);
        expect(response.status, matrixLabel('read', 'events stream', persona, sessionCase)).toBe(403);
      }
    }
  });

  it('enforces cross-group write access for unsafe session-scoped routes', async () => {
    for (const route of writeRoutes) {
      for (const sessionCase of sessionCases) {
        for (const persona of personaNames) {
          const { session } = await createMatrixSession(services, sessionCase, fixture.users.aCreator.id, {
            seedReadResources: false,
          });
          const prepared = (await route.prepare?.({ services, session, store })) ?? {};
          const routeInput = { session, ...prepared };
          const expectedStatus =
            route.expectedStatus?.(persona, sessionCase) ??
            (canPersonaWrite(persona, sessionCase.writePolicy) ? route.successStatus : 403);
          const headers: Record<string, string> = { cookie: fixture.cookies[persona] };
          const body = route.body?.(routeInput);
          if (body) headers['content-type'] = 'application/json';

          const response = await fetch(`${baseUrl}${route.path(routeInput)}`, {
            method: route.method,
            headers,
            ...(body ? { body: JSON.stringify(body) } : {}),
          });

          expect(response.status, matrixLabel('write', route.name, persona, sessionCase)).toBe(expectedStatus);
          await response.arrayBuffer();
        }
      }
    }
  });

  it('rejects cross-group users before sandbox-dependent session handlers', async () => {
    const session = fixture.sessions['group/group_members'];
    const sandboxRoutes: WriteRoute[] = [
      {
        name: 'extend sandbox',
        method: 'POST',
        path: ({ session: current }) => `/sessions/${current.id}/sandbox/extend`,
        body: () => ({ seconds: 60 }),
        successStatus: 200,
      },
      {
        name: 'open workspace tool',
        method: 'POST',
        path: ({ session: current }) => `/sessions/${current.id}/workspace-tools/ide/open`,
        successStatus: 200,
      },
    ];

    for (const route of sandboxRoutes) {
      for (const persona of ['bMember', 'orgUser'] as const) {
        const headers: Record<string, string> = { cookie: fixture.cookies[persona] };
        const body = route.body?.({ session });
        if (body) headers['content-type'] = 'application/json';

        const response = await fetch(`${baseUrl}${route.path({ session })}`, {
          method: route.method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });

        expect(response.status, matrixLabel('write', route.name, persona, sessionCases[0])).toBe(403);
        await response.arrayBuffer();
      }
    }
  });

  it('hides cross-group group listings', async () => {
    const expectedGroupIds: Record<PersonaName, string[]> = {
      aAdmin: [groupAId],
      aCreator: [groupAId],
      aMember: [groupAId],
      aViewer: [groupAId],
      bMember: [groupBId],
      orgUser: [],
    };

    for (const persona of personaNames) {
      const response = await fetch(`${baseUrl}/groups`, { headers: { cookie: fixture.cookies[persona] } });
      expect(response.status, `group list ${persona}`).toBe(200);
      const body = (await response.json()) as { groups: Array<{ id: string }> };
      expect(
        body.groups.map((group) => group.id),
        `group list ${persona}`,
      ).toEqual(expectedGroupIds[persona]);
    }
  });

  it('requires group admin access for group management routes', async () => {
    const groupManagementRoutes: WriteRoute[] = [
      {
        name: 'update group',
        method: 'PATCH',
        path: () => `/groups/${groupAId}`,
        body: () => ({ name: 'Group A updated' }),
        successStatus: 200,
      },
      {
        name: 'add group member',
        method: 'POST',
        path: () => `/groups/${groupAId}/members`,
        body: () => ({ userId: fixture.users.orgUser.id, role: 'viewer' }),
        successStatus: 200,
      },
      {
        name: 'update group member',
        method: 'PATCH',
        path: () => `/groups/${groupAId}/members/${fixture.users.aViewer.id}`,
        body: () => ({ role: 'member' }),
        successStatus: 200,
      },
      {
        name: 'delete group member',
        method: 'DELETE',
        path: () => `/groups/${groupAId}/members/${fixture.users.aViewer.id}`,
        successStatus: 200,
      },
    ];

    const readMembers = await fetch(`${baseUrl}/groups/${groupAId}/members`, {
      headers: { cookie: fixture.cookies.aAdmin },
    });
    expect(readMembers.status, 'read group members aAdmin').toBe(200);
    await readMembers.arrayBuffer();

    for (const route of groupManagementRoutes) {
      for (const persona of ['aCreator', 'aMember', 'aViewer', 'bMember', 'orgUser'] as const) {
        const headers: Record<string, string> = { cookie: fixture.cookies[persona] };
        const body = route.body?.({ session: fixture.sessions['group/group_members'] });
        if (body) headers['content-type'] = 'application/json';
        const response = await fetch(`${baseUrl}${route.path({ session: fixture.sessions['group/group_members'] })}`, {
          method: route.method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });

        expect(response.status, `group management ${route.name} ${persona}`).toBe(403);
        await response.arrayBuffer();
      }
    }

    const updateGroup = await patchJson(`/groups/${groupAId}`, fixture.cookies.aAdmin, {
      name: 'Group A admin updated',
    });
    expect(updateGroup.status, 'update group aAdmin').toBe(200);
    await updateGroup.arrayBuffer();

    const addMember = await postJson(`/groups/${groupAId}/members`, fixture.cookies.aAdmin, {
      userId: fixture.users.orgUser.id,
      role: 'viewer',
    });
    expect(addMember.status, 'add group member aAdmin').toBe(200);
    await addMember.arrayBuffer();

    const updateMember = await patchJson(
      `/groups/${groupAId}/members/${fixture.users.orgUser.id}`,
      fixture.cookies.aAdmin,
      {
        role: 'member',
      },
    );
    expect(updateMember.status, 'update group member aAdmin').toBe(200);
    await updateMember.arrayBuffer();

    const deleteMember = await fetch(`${baseUrl}/groups/${groupAId}/members/${fixture.users.orgUser.id}`, {
      method: 'DELETE',
      headers: { cookie: fixture.cookies.aAdmin },
    });
    expect(deleteMember.status, 'delete group member aAdmin').toBe(200);
    await deleteMember.arrayBuffer();
  });

  function postJson(path: string, cookie: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  }

  function patchJson(path: string, cookie: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  }
});

async function seedFixture(store: MemoryStore, services: AppServices): Promise<MatrixFixture> {
  const now = new Date();
  await store.createGroup(groupRecord(groupAId, 'Group A', now));
  await store.createGroup(groupRecord(groupBId, 'Group B', now));

  const users = {} as Record<PersonaName, AuthUserRecord>;
  const cookies = {} as Record<PersonaName, string>;
  for (const persona of personaNames) {
    const { cookie, user } = await createAuthUser(store, persona, now);
    users[persona] = user;
    cookies[persona] = cookie;
  }

  await addGroupMember(store, groupAId, users.aAdmin.id, 'admin', now);
  await addGroupMember(store, groupAId, users.aCreator.id, 'member', now);
  await addGroupMember(store, groupAId, users.aMember.id, 'member', now);
  await addGroupMember(store, groupAId, users.aViewer.id, 'viewer', now);
  await addGroupMember(store, groupBId, users.bMember.id, 'member', now);

  const sessions = {} as Record<SessionKey, SessionRecord>;
  const artifactIds = {} as Record<SessionKey, string>;
  for (const sessionCase of sessionCases) {
    const { artifactId, session } = await createMatrixSession(services, sessionCase, users.aCreator.id, {
      seedReadResources: true,
    });
    sessions[sessionCase.key] = session;
    artifactIds[sessionCase.key] = artifactId;
  }

  return { artifactIds, cookies, sessions, users };
}

async function createAuthUser(
  store: MemoryStore,
  persona: PersonaName,
  now: Date,
): Promise<{ cookie: string; user: AuthUserRecord }> {
  const user = await store.upsertAuthUserForAccount({
    userId: userIds[persona],
    accountId: accountIds[persona],
    provider: 'test',
    providerAccountId: persona,
    username: persona,
    role: 'user',
    profile: {},
    now,
  });
  const authSessionId = `${persona}-session`;
  await store.createAuthSession({
    id: authSessionId,
    userId: user.id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  return { cookie: `${sessionCookieName}=${authSessionId}`, user };
}

async function createMatrixSession(
  services: AppServices,
  sessionCase: SessionCase,
  creatorUserId: string,
  options: { seedReadResources: boolean },
): Promise<{ artifactId: string; session: SessionRecord }> {
  const session = await services.sessions.create({
    title: `Matrix ${sessionCase.key}`,
    ownerGroupId: groupAId,
    visibility: sessionCase.visibility,
    writePolicy: sessionCase.writePolicy,
    createdByUserId: creatorUserId,
  });

  if (!options.seedReadResources) return { artifactId: '', session };

  const [artifact] = await services.artifacts.recordRunArtifacts({
    sessionId: session.id,
    runId: `run-${session.id}`,
    messageId: `message-${session.id}`,
    result: {
      text: 'created artifact',
      artifacts: [
        {
          type: 'log',
          title: 'Matrix log',
          content: `artifact for ${sessionCase.key}`,
          contentType: 'text/plain',
          fileName: 'matrix.log',
        },
      ],
    },
  });
  if (!artifact) throw new Error(`Expected artifact for ${sessionCase.key}`);

  await services.externalResources.create({
    sessionId: session.id,
    type: 'url',
    title: 'Matrix resource',
    url: 'https://example.com/matrix-resource',
  });
  const now = new Date();
  await services.store.createCallbackDelivery({
    id: `callback-${session.id}`,
    sessionId: session.id,
    targetType: 'http',
    target: { url: 'https://example.com/callback' },
    eventType: 'message_completed',
    payload: { ok: true },
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
  });

  return { artifactId: artifact.id, session };
}

async function createFailedMessage(store: MemoryStore, session: SessionRecord): Promise<string> {
  const now = new Date();
  const message = await store.createMessage({
    id: `failed-message-${session.id}`,
    sessionId: session.id,
    sequence: await store.nextMessageSequence(session.id),
    status: 'failed',
    prompt: 'failed retry',
    createdAt: now,
  });
  return message.id;
}

async function createFailedCallback(store: MemoryStore, session: SessionRecord): Promise<string> {
  const now = new Date();
  const delivery = await store.createCallbackDelivery({
    id: `callback-replay-${session.id}`,
    sessionId: session.id,
    targetType: 'http',
    target: { url: 'https://example.com/callback' },
    eventType: 'message_completed',
    payload: { ok: true },
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    maxAttempts: 1,
  });
  await store.markCallbackDeliveryFailed({
    id: delivery.id,
    failedAt: now,
    error: 'matrix callback failure',
    terminal: true,
  });
  return delivery.id;
}

function groupRecord(id: string, name: string, now: Date) {
  return {
    id,
    name,
    defaultVisibility: 'group' as const,
    defaultWritePolicy: 'group_members' as const,
    automationCreateRequiredRole: 'member' as const,
    createdAt: now,
    updatedAt: now,
  };
}

function addGroupMember(
  store: MemoryStore,
  groupId: string,
  userId: string,
  role: GroupRole,
  now: Date,
): Promise<unknown> {
  return store.upsertGroupMember({ groupId, userId, role, createdAt: now, updatedAt: now });
}

function expectedReadStatus(persona: PersonaName, visibility: SessionVisibility): number {
  if (groupAPersonas.has(persona) || visibility === 'organization') return 200;
  return unauthorizedReadStatus;
}

function canPersonaWrite(persona: PersonaName, writePolicy: SessionWritePolicy): boolean {
  if (persona === 'aAdmin') return true;
  if (writePolicy === 'creator_only') return persona === 'aCreator';
  return persona === 'aCreator' || persona === 'aMember';
}

function matrixLabel(kind: 'read' | 'write', route: string, persona: PersonaName, sessionCase: SessionCase): string {
  return `${kind} route=${route} persona=${persona} session=${sessionCase.key}`;
}

function requiredId(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Expected ${label}`);
  return value;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('Expected server address');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

class InMemoryArtifactObjectStorage implements ArtifactObjectStorage {
  private readonly objects = new Map<string, StoredArtifactObject>();

  async put(input: Parameters<ArtifactObjectStorage['put']>[0]): Promise<void> {
    this.objects.set(input.key, {
      body: input.body,
      contentLength: input.body.byteLength,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    });
  }

  async get(key: string): Promise<StoredArtifactObject | null> {
    return this.objects.get(key) ?? null;
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<StoredArtifactObject | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: object.body.slice(start, endInclusive + 1),
      contentLength: object.contentLength ?? object.body.byteLength,
      ...(object.contentType ? { contentType: object.contentType } : {}),
    };
  }
}
