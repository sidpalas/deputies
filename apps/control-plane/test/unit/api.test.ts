import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactService } from '../../src/artifacts/service.js';
import { FilesystemArtifactObjectStorage, type ArtifactObjectStorage } from '../../src/artifacts/storage.js';
import { createServer, createServices, createWorkerHealthServer, type AppServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { GitHubApiError } from '../../src/integrations/github/client.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';
import type { CreateSandboxInput, SandboxHealth, SandboxPreviewUrlInput, SandboxRef } from '../../src/sandbox/types.js';
import { MemoryStore } from '../../src/store/memory.js';
import {
  expectArtifactPreviewResponse,
  expectArtifactsResponse,
  expectCallbackResponse,
  expectCallbacksResponse,
  expectErrorResponse,
  expectEventsResponse,
  expectMessageResponse,
  expectMessagesResponse,
  expectSessionResponse,
  expectSessionsResponse,
} from '../support/contracts.js';

describe('core API', () => {
  let server: Server;
  let baseUrl: string;
  let store: MemoryStore;
  let services: AppServices;
  let artifactTempDir: string | undefined;

  beforeEach(async () => {
    store = new MemoryStore();
    services = createServices(store);
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), services);
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await closeServer(server);
    if (artifactTempDir) await rm(artifactTempDir, { recursive: true, force: true });
    artifactTempDir = undefined;
  });

  async function restartWithFilesystemArtifacts(): Promise<void> {
    await closeServer(server);
    artifactTempDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-artifacts-'));
    store = new MemoryStore();
    services = createServices(store, { artifactObjectStorage: new FilesystemArtifactObjectStorage(artifactTempDir) });
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), services);
    baseUrl = await listen(server);
  }

  it('reports health', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', runMode: 'all' });
  });

  it('maps GitHub branch authorization failures to stable API errors', async () => {
    services.githubRepositoryAccess = {
      async listRepositories() {
        return [];
      },
      async listBranches() {
        throw new GitHubApiError('GET', '/repos/acme/widget/branches', 403, 'Resource not accessible by integration');
      },
    };

    const response = await fetch(`${baseUrl}/repositories/acme/widget/branches`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'github_authorization_failed' });
  });

  it('ignores branch message context without repository context', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Branch only' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    const response = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'use a branch',
      branch: 'feature/demo',
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { message: Record<string, unknown> };
    expect(body.message).not.toHaveProperty('context');
  });

  it('exposes only worker health routes for worker mode', async () => {
    await closeServer(server);
    server = createWorkerHealthServer(loadConfig({ API_AUTH_MODE: 'none', RUN_MODE: 'worker' }));
    baseUrl = await listen(server);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: 'ok', runMode: 'worker' });

    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Worker should not serve API' });
    expect(createSession.status).toBe(404);
    await expect(createSession.json()).resolves.toMatchObject({ error: 'not_found' });
  });

  it('protects product session routes when bearer auth is enabled', async () => {
    await closeServer(server);
    server = createServer(loadConfig({ API_AUTH_MODE: 'bearer', API_BEARER_TOKEN: 'secret' }));
    baseUrl = await listen(server);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    const missingAuth = await postJson(`${baseUrl}/sessions`, { title: 'Private' });
    expect(missingAuth.status).toBe(401);
    await expect(missingAuth.json()).resolves.toMatchObject({ error: 'unauthorized' });

    const invalidAuth = await postJson(`${baseUrl}/sessions`, { title: 'Private' }, 'wrong');
    expect(invalidAuth.status).toBe(401);

    const validAuth = await postJson(`${baseUrl}/sessions`, { title: 'Private' }, 'secret');
    expect(validAuth.status).toBe(201);
    expectSessionResponse(await validAuth.json());

    const validAuthWithUntrustedBrowserHeaders = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ title: 'Bearer remains token authenticated' }),
    });
    expect(validAuthWithUntrustedBrowserHeaders.status).toBe(201);
  });

  it('supports static login with session cookies', async () => {
    await closeServer(server);
    server = createServer(
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_STATIC_USERNAME: 'dev',
        AUTH_STATIC_PASSWORD: 'password',
        AUTH_SESSION_SECRET: 'test-secret',
        AUTH_COOKIE_DOMAIN: '.deputies.localhost',
        AUTH_SUCCESS_REDIRECT_URL: 'https://deputies.localhost',
      }),
    );
    baseUrl = await listen(server);

    const unauthenticated = await fetch(`${baseUrl}/sessions`);
    expect(unauthenticated.status).toBe(401);

    const badLogin = await postJson(`${baseUrl}/auth/login`, { username: 'dev', password: 'wrong' });
    expect(badLogin.status).toBe(401);

    const login = await postJson(`${baseUrl}/auth/login`, { username: 'dev', password: 'password' });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toContain('dev_deputies_session=');
    await expect(login.json()).resolves.toMatchObject({ user: { username: 'dev' } });

    const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie: cookie! } });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({ user: { username: 'dev' } });

    const crossSiteCreate = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookie!,
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ title: 'Cross-site cookie session' }),
    });
    expect(crossSiteCreate.status).toBe(403);
    await expect(crossSiteCreate.json()).resolves.toMatchObject({ error: 'forbidden' });

    const crossSiteFetchMetadataCreate = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookie!,
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ title: 'Cross-site fetch metadata cookie session' }),
    });
    expect(crossSiteFetchMetadataCreate.status).toBe(403);

    const createSession = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie!, origin: baseUrl },
      body: JSON.stringify({ title: 'Cookie session' }),
    });
    expect(createSession.status).toBe(201);
    const createSessionBody = await createSession.json();
    expectSessionResponse(createSessionBody);

    const createMessage = await fetch(`${baseUrl}/sessions/${createSessionBody.session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie!, origin: baseUrl },
      body: JSON.stringify({ prompt: 'Authored by static user' }),
    });
    expect(createMessage.status).toBe(202);
    await expect(createMessage.json()).resolves.toMatchObject({
      message: { authorUserId: expect.any(String), authorName: 'dev' },
    });

    const crossSiteLogout = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookie!, origin: 'https://evil.example' },
    });
    expect(crossSiteLogout.status).toBe(403);

    const browserLogout = await fetch(`${baseUrl}/auth/logout`, { headers: { cookie: cookie! }, redirect: 'manual' });
    expect(browserLogout.status).toBe(302);
    expect(browserLogout.headers.get('location')).toBe('https://deputies.localhost');
    const browserLogoutCookie = browserLogout.headers.get('set-cookie');
    expect(browserLogoutCookie).toContain('Max-Age=0');
    expect(browserLogoutCookie).toContain('Domain=.deputies.localhost');

    const logout = await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers: { cookie: cookie! } });
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('supports GitHub OAuth login with allowed users', async () => {
    await closeServer(server);
    store = new MemoryStore();
    server = createServer(
      loadConfig({
        API_AUTH_MODE: 'session',
        AUTH_PROVIDER: 'github',
        AUTH_SESSION_SECRET: 'test-secret',
        GITHUB_APP_CLIENT_ID: 'client-id',
        GITHUB_APP_CLIENT_SECRET: 'client-secret',
        GITHUB_OAUTH_BASE_URL: 'https://github.example',
        AUTH_GITHUB_ALLOWED_USERS: 'octocat',
      }),
      {
        ...createServices(store),
        githubOAuthClient: {
          async exchangeCode(input) {
            expect(input.code).toBe('oauth-code');
            return 'github-access-token';
          },
          async getUser(accessToken) {
            expect(accessToken).toBe('github-access-token');
            return {
              id: 583231,
              login: 'octocat',
              name: 'The Octocat',
              avatar_url: 'https://avatars.example/octocat.png',
            };
          },
          async listOrganizations() {
            return [];
          },
        },
      },
    );
    baseUrl = await listen(server);

    const start = await fetch(`${baseUrl}/auth/oauth/github/start`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const location = start.headers.get('location');
    expect(location).toContain('https://github.example/login/oauth/authorize');
    const state = new URL(location!).searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = await fetch(
      `${baseUrl}/auth/oauth/github/callback?code=oauth-code&state=${encodeURIComponent(state!)}`,
      { redirect: 'manual' },
    );
    expect(callback.status).toBe(200);
    const cookie = callback.headers.get('set-cookie');
    expect(cookie).toContain('dev_deputies_session=');
    await expect(callback.text()).resolves.toContain('Sign in complete');

    const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie: cookie! } });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({ user: { username: 'octocat', displayName: 'The Octocat' } });
  });

  it('allows PATCH session title updates through CORS preflight', async () => {
    const response = await fetch(`${baseUrl}/sessions/00000000-0000-4000-8000-000000000001`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PATCH',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('does not grant credentialed CORS access to untrusted origins', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'GET',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('creates a session, enqueues a message, and replays events', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Test session' });
    expect(createSession.status).toBe(201);

    const createSessionBody = await createSession.json();
    expectSessionResponse(createSessionBody);
    const { session } = createSessionBody;
    expect(session.title).toBe('Test session');

    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'Investigate the failing test',
    });
    expect(createMessage.status).toBe(202);

    const createMessageBody = await createMessage.json();
    expectMessageResponse(createMessageBody);
    const { message } = createMessageBody;
    expect(message).toMatchObject({
      sessionId: session.id,
      sequence: 1,
      status: 'pending',
      prompt: 'Investigate the failing test',
    });

    const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
    expect(eventsResponse.status).toBe(200);

    const eventsBody = await eventsResponse.json();
    expectEventsResponse(eventsBody);
    const { events } = eventsBody;
    expect(events.map((event) => event.type)).toEqual(['session_created', 'message_created']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);

    const replayResponse = await fetch(`${baseUrl}/sessions/${session.id}/events?after=1`);
    const replayBody = await replayResponse.json();
    expectEventsResponse(replayBody);
    const { events: replayed } = replayBody;
    expect(replayed.map((event) => event.type)).toEqual(['message_created']);
  });

  it('enqueues messages with validated repository context', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Repository session' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'Investigate the failing test',
      repository: 'manaflow-ai/manaflow',
    });
    expect(createMessage.status).toBe(202);

    const body = await createMessage.json();
    expectMessageResponse(body);
    expect((body.message as { context?: unknown }).context).toEqual({
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
    });

    const sessionResponse = await fetch(`${baseUrl}/sessions/${session.id}`);
    expect(sessionResponse.status).toBe(200);
    const sessionBody = await sessionResponse.json();
    expectSessionResponse(sessionBody);
    expect((sessionBody.session as { context?: unknown }).context).toEqual({
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
    });
  });

  it('inherits and overrides session repository context on follow-up messages', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Repository session' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'Use the app repo',
      repository: 'manaflow-ai/manaflow',
    });

    const inherited = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'Create a test issue',
    });
    expect(inherited.status).toBe(202);
    const inheritedBody = await inherited.json();
    expectMessageResponse(inheritedBody);
    expect((inheritedBody.message as { context?: unknown }).context).toEqual({
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' },
    });

    const overridden = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'Switch repos',
      repository: 'manaflow-ai/agent-runtime',
    });
    expect(overridden.status).toBe(202);
    const overriddenBody = await overridden.json();
    expectMessageResponse(overriddenBody);
    expect((overriddenBody.message as { context?: unknown }).context).toEqual({
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'agent-runtime' },
    });

    const inheritedOverride = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'Use the new repo',
    });
    const inheritedOverrideBody = await inheritedOverride.json();
    expectMessageResponse(inheritedOverrideBody);
    expect((inheritedOverrideBody.message as { context?: unknown }).context).toEqual({
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'agent-runtime' },
    });
  });

  it('rejects invalid repository context', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Repository session' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'Investigate the failing test',
      repository: 'manaflow',
    });

    expect(createMessage.status).toBe(400);
    expectErrorResponse(await createMessage.json());
  });

  it('lists sessions and messages', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Listed session' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    await postJson(`${baseUrl}/sessions/${session.id}/messages`, { prompt: 'show this message' });

    const sessionsResponse = await fetch(`${baseUrl}/sessions`);
    expect(sessionsResponse.status).toBe(200);
    const sessionsBody = await sessionsResponse.json();
    expectSessionsResponse(sessionsBody);
    expect(sessionsBody.sessions).toMatchObject([{ id: session.id, title: 'Listed session' }]);

    const messagesResponse = await fetch(`${baseUrl}/sessions/${session.id}/messages`);
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json();
    expectMessagesResponse(messagesBody);
    expect(messagesBody.messages).toMatchObject([{ sessionId: session.id, prompt: 'show this message' }]);
  });

  it('lists callback deliveries and requeues failed callbacks for replay', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Callback replay' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    const now = new Date('2026-05-06T00:00:00.000Z');
    const delivery = await store.createCallbackDelivery({
      id: '00000000-0000-4000-8000-000000000901',
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
    await store.markCallbackDeliveryFailed({
      id: delivery.id,
      failedAt: now,
      error: 'HTTP callback returned 500',
      terminal: true,
    });

    const list = await fetch(`${baseUrl}/sessions/${session.id}/callbacks`);
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expectCallbacksResponse(listBody);
    expect(listBody.callbacks).toMatchObject([
      { id: delivery.id, status: 'failed', lastError: 'HTTP callback returned 500' },
    ]);

    const replay = await postJson(`${baseUrl}/sessions/${session.id}/callbacks/${delivery.id}/replay`, {});
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expectCallbackResponse(replayBody);
    expect(replayBody.callback).toMatchObject({ id: delivery.id, status: 'pending' });

    const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
    const eventsBody = await eventsResponse.json();
    expectEventsResponse(eventsBody);
    expect(eventsBody.events.map((event) => event.type)).toContain('callback_replay_requested');
  });

  it('updates a session title', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Draft title' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    const updateSession = await patchJson(`${baseUrl}/sessions/${session.id}`, { title: 'Final title' });

    expect(updateSession.status).toBe(200);
    const updateBody = await updateSession.json();
    expectSessionResponse(updateBody);
    expect(updateBody.session.title).toBe('Final title');

    const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
    const eventsBody = await eventsResponse.json();
    expectEventsResponse(eventsBody);
    expect(eventsBody.events.map((event) => event.type)).toEqual(['session_created', 'session_updated']);
  });

  it('edits and cancels pending messages while queue is paused', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Queue edits' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, { prompt: 'draft' });
    const { message } = (await createMessage.json()) as { message: { id: string } };

    const pause = await postJson(`${baseUrl}/sessions/${session.id}/queue/pause`, {});
    expect(pause.status).toBe(200);
    expect((await pause.json()) as { session: { queuePausedAt?: string } }).toMatchObject({
      session: { queuePausedAt: expect.any(String) },
    });

    const update = await patchJson(`${baseUrl}/sessions/${session.id}/messages/${message.id}`, { prompt: 'final' });
    expect(update.status).toBe(200);
    expect((await update.json()) as { message: { prompt: string } }).toMatchObject({ message: { prompt: 'final' } });

    const cancel = await postJson(`${baseUrl}/sessions/${session.id}/messages/${message.id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect((await cancel.json()) as { message: { status: string } }).toMatchObject({
      message: { status: 'cancelled' },
    });

    const resume = await postJson(`${baseUrl}/sessions/${session.id}/queue/resume`, {});
    expect(resume.status).toBe(200);
    expect((await resume.json()) as { session: { queuePausedAt?: string } }).toMatchObject({ session: {} });
  });

  it('retries a failed message by enqueueing a new copy', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Retry failed message' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'try again',
      repository: 'acme/widgets',
    });
    const { message } = (await createMessage.json()) as { message: { id: string } };
    const claimed = await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000303',
      runnerType: 'fake',
      leaseOwner: 'test-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    expect(claimed).not.toBeNull();
    await store.failRunBatch({
      runId: '00000000-0000-4000-8000-000000000303',
      leaseOwner: 'test-worker',
      failedAt: new Date(),
      error: 'boom',
    });

    const retry = await postJson(`${baseUrl}/sessions/${session.id}/messages/${message.id}/retry`, {});

    expect(retry.status).toBe(202);
    const retryBody = (await retry.json()) as {
      message: { id: string; prompt: string; sequence: number; status: string; context?: unknown };
    };
    expect(retryBody.message).toMatchObject({ prompt: 'try again', sequence: 2, status: 'pending' });
    expect(retryBody.message.id).not.toBe(message.id);
    expect(retryBody.message.context).toMatchObject({ repository: { owner: 'acme', repo: 'widgets' } });

    const messagesResponse = await fetch(`${baseUrl}/sessions/${session.id}/messages`);
    const messagesBody = (await messagesResponse.json()) as { messages: Array<{ status: string }> };
    expect(messagesBody.messages.map((item) => item.status)).toEqual(['failed', 'pending']);

    const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
    const eventsBody = await eventsResponse.json();
    expectEventsResponse(eventsBody);
    expect(eventsBody.events.map((event) => event.type)).toEqual([
      'session_created',
      'session_updated',
      'message_created',
      'session_updated',
      'message_created',
    ]);
  });

  it('rejects retrying a message that has not failed', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Retry pending message' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, { prompt: 'not failed' });
    const { message } = (await createMessage.json()) as { message: { id: string } };

    const retry = await postJson(`${baseUrl}/sessions/${session.id}/messages/${message.id}/retry`, {});

    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toMatchObject({
      error: 'conflict',
      message: 'Only failed messages can be retried',
    });
  });

  it('cancels the active run for a session', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Cancel active run' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    await postJson(`${baseUrl}/sessions/${session.id}/messages`, { prompt: 'stop this' });
    await store.claimNextPendingMessageBatch({
      runId: '00000000-0000-4000-8000-000000000301',
      runnerType: 'fake',
      leaseOwner: 'test-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });

    const cancel = await postJson(`${baseUrl}/sessions/${session.id}/runs/current/cancel`, {});

    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as { messages: Array<{ status: string }> };
    expect(body.messages).toMatchObject([{ status: 'cancelling' }]);

    const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
    const eventsBody = await eventsResponse.json();
    expectEventsResponse(eventsBody);
    expect(eventsBody.events.map((event) => event.type)).toEqual([
      'session_created',
      'message_created',
      'run_cancel_requested',
    ]);
  });

  it('archives a session', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Archive me' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    const archiveSession = await postJson(`${baseUrl}/sessions/${session.id}/archive`, {});

    expect(archiveSession.status).toBe(200);
    const archiveBody = await archiveSession.json();
    expectSessionResponse(archiveBody);
    expect(archiveBody.session.status).toBe('archived');

    const sessionsResponse = await fetch(`${baseUrl}/sessions`);
    const sessionsBody = await sessionsResponse.json();
    expectSessionsResponse(sessionsBody);
    expect(sessionsBody.sessions).toMatchObject([{ id: session.id, status: 'archived' }]);

    const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
    const eventsBody = await eventsResponse.json();
    expectEventsResponse(eventsBody);
    expect(eventsBody.events.map((event) => event.type)).toEqual(['session_created', 'session_archived']);
  });

  it('rejects messages for archived sessions', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Archived messages' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    await postJson(`${baseUrl}/sessions/${session.id}/archive`, {});

    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, { prompt: 'do not enqueue' });

    expect(createMessage.status).toBe(409);
    await expect(createMessage.json()).resolves.toMatchObject({
      error: 'conflict',
      message: 'Cannot enqueue messages to an archived session',
    });
  });

  it('destroys active session sandboxes when archiving', async () => {
    await closeServer(server);
    const provider = new FakeSandboxProvider();
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), createServices(store, { sandboxProvider: provider }));
    baseUrl = await listen(server);

    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Archive sandbox' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    const now = new Date();
    await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000501',
      sessionId: session.id,
      provider: provider.name,
      providerSandboxId: `fake-${session.id}`,
      status: 'ready',
      workspacePath: '/workspace',
      metadata: {},
      createdAt: now,
      updatedAt: now,
      keepaliveUntil: new Date(now.getTime() + 600_000),
    });

    const archiveSession = await postJson(`${baseUrl}/sessions/${session.id}/archive`, {});

    expect(archiveSession.status).toBe(200);
    await expect(archiveSession.json()).resolves.toMatchObject({
      session: { sandbox: { status: 'destroyed', destroyedAt: expect.any(String) } },
    });
    expect(provider.destroys).toBe(1);
    await expect(store.getActiveSandbox(session.id, provider.name)).resolves.toBeNull();

    const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
    const eventsBody = (await eventsResponse.json()) as { events: Array<{ type: string }> };
    expect(eventsBody.events.map((event: { type: string }) => event.type)).toEqual([
      'session_created',
      'session_archived',
      'sandbox_destroyed',
    ]);
  });

  it('proxies service HTML and rewrites root-relative Vite asset paths', async () => {
    const upstream = createPreviewUpstream();
    const upstreamBaseUrl = await listen(upstream);
    await closeServer(server);
    const provider = new ServiceSandboxProvider(upstreamBaseUrl);
    server = createServer(
      loadConfig({
        API_AUTH_MODE: 'none',
        WEB_BASE_URL: 'https://deputies.localhost',
        SERVICE_TRUST_FORWARDED_HOSTS: 'true',
      }),
      createServices(store, { sandboxProvider: provider }),
    );
    baseUrl = await listen(server);

    try {
      const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Service rewrite' });
      const { session } = (await createSession.json()) as { session: { id: string } };
      const sandbox = await provider.create({ sessionId: session.id });
      const storedSession = await store.getSession(session.id);
      if (!storedSession) throw new Error('Expected session');
      await store.updateSession({
        ...storedSession,
        context: {
          services: [
            {
              port: 3000,
              label: 'Vite app',
              path: '/',
              providerSandboxId: sandbox.providerSandboxId,
              runtimeId: 'runtime-1',
            },
          ],
        },
      });
      const now = new Date();
      await store.createSandbox({
        id: '00000000-0000-4000-8000-000000000502',
        sessionId: session.id,
        provider: provider.name,
        providerSandboxId: sandbox.providerSandboxId,
        status: 'ready',
        workspacePath: '/workspace',
        metadata: { runtimeId: 'runtime-1' },
        createdAt: now,
        updatedAt: now,
      });

      const serviceRoot = `${baseUrl}/sessions/${session.id}/services/3000/`;
      await expect((await fetch(`${baseUrl}/sessions/${session.id}/services`)).json()).resolves.toMatchObject({
        services: [
          {
            port: 3000,
            label: 'Vite app',
            path: '/',
            url: `https://s-3000-${session.id}.deputies.localhost/`,
          },
        ],
      });
      const html = await (await fetch(serviceRoot)).text();

      expect(html).toContain(`/sessions/${session.id}/services/3000/@vite/client`);
      expect(html).toContain(`/sessions/${session.id}/services/3000/src/main.tsx`);
      await expect((await fetch(`${serviceRoot}@vite/client`)).text()).resolves.toBe('vite client');
      await expect((await fetch(`${serviceRoot}src/main.tsx`)).text()).resolves.toBe('main');
      await expect(
        (
          await fetch(`${serviceRoot}@vite/client`, {
            headers: { host: `s-3000-${session.id}.evil.localhost` },
          })
        ).text(),
      ).resolves.toBe('vite client');

      const pathRedirect = await fetch(`${serviceRoot}redirect`, { redirect: 'manual' });
      expect(pathRedirect.headers.get('location')).toBe(`/sessions/${session.id}/services/3000/dashboard`);

      const hostRedirect = await fetch(`${baseUrl}/redirect`, {
        redirect: 'manual',
        headers: { 'x-forwarded-host': `s-3000-${session.id}.deputies.localhost` },
      });
      expect(hostRedirect.headers.get('location')).toBe('/dashboard');
    } finally {
      await closeServer(upstream);
    }
  });

  it('does not list a default service when none has been published', async () => {
    const upstream = createPreviewUpstream();
    const upstreamBaseUrl = await listen(upstream);
    await closeServer(server);
    const provider = new ServiceSandboxProvider(upstreamBaseUrl);
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), createServices(store, { sandboxProvider: provider }));
    baseUrl = await listen(server);

    try {
      const createSession = await postJson(`${baseUrl}/sessions`, { title: 'No service' });
      const { session } = (await createSession.json()) as { session: { id: string } };
      const sandbox = await provider.create({ sessionId: session.id });
      const now = new Date();
      await store.createSandbox({
        id: '00000000-0000-4000-8000-000000000503',
        sessionId: session.id,
        provider: provider.name,
        providerSandboxId: sandbox.providerSandboxId,
        status: 'ready',
        workspacePath: '/workspace',
        metadata: { runtimeId: 'runtime-1' },
        createdAt: now,
        updatedAt: now,
      });

      await expect((await fetch(`${baseUrl}/sessions/${session.id}/services`)).json()).resolves.toEqual({
        services: [],
      });
      await expect((await fetch(`${baseUrl}/sessions/${session.id}/services?port=3000`)).json()).resolves.toMatchObject(
        {
          services: [{ port: 3000 }],
        },
      );
    } finally {
      await closeServer(upstream);
    }
  });

  it('extends an active sandbox and returns service shutdown timing', async () => {
    const upstream = createPreviewUpstream();
    const upstreamBaseUrl = await listen(upstream);
    await closeServer(server);
    const provider = new ServiceSandboxProvider(upstreamBaseUrl);
    server = createServer(
      loadConfig({
        API_AUTH_MODE: 'none',
        SANDBOX_STOP_DELAY_SECONDS: '60',
        SANDBOX_KEEPALIVE_MAX_EXTENSION_SECONDS: '600',
      }),
      createServices(store, { sandboxProvider: provider }),
    );
    baseUrl = await listen(server);

    try {
      const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Extend service' });
      const { session } = (await createSession.json()) as { session: { id: string } };
      const sandbox = await provider.create({ sessionId: session.id });
      const now = new Date();
      await store.createSandbox({
        id: '00000000-0000-4000-8000-000000000504',
        sessionId: session.id,
        provider: provider.name,
        providerSandboxId: sandbox.providerSandboxId,
        status: 'ready',
        workspacePath: '/workspace',
        metadata: { runtimeId: 'runtime-1' },
        createdAt: now,
        updatedAt: now,
      });

      const extend = await postJson(`${baseUrl}/sessions/${session.id}/sandbox/extend`, { seconds: 300, port: 3000 });
      expect(extend.status).toBe(200);
      const extendBody = (await extend.json()) as { sandbox: { keepaliveUntil: string; providerSync: string } };
      expect(extendBody.sandbox.providerSync).toBe('ok');
      expect(new Date(extendBody.sandbox.keepaliveUntil).getTime()).toBeGreaterThan(Date.now() + 250_000);
      const secondExtend = await postJson(`${baseUrl}/sessions/${session.id}/sandbox/extend`, {
        seconds: 300,
        port: 3000,
      });
      expect(secondExtend.status).toBe(200);
      const secondExtendBody = (await secondExtend.json()) as {
        sandbox: { keepaliveUntil: string; providerSync: string };
      };
      expect(new Date(secondExtendBody.sandbox.keepaliveUntil).getTime()).toBeGreaterThan(
        new Date(extendBody.sandbox.keepaliveUntil).getTime() + 250_000,
      );
      expect(new Date(secondExtendBody.sandbox.keepaliveUntil).getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
      const cappedExtend = await postJson(`${baseUrl}/sessions/${session.id}/sandbox/extend`, {
        seconds: 300,
        port: 3000,
      });
      expect(cappedExtend.status).toBe(200);
      const cappedExtendBody = (await cappedExtend.json()) as { sandbox: { keepaliveUntil: string } };
      expect(provider.keepaliveRefreshes).toEqual([
        { providerSandboxId: sandbox.providerSandboxId, durationMs: 300_000 },
        { providerSandboxId: sandbox.providerSandboxId, durationMs: 300_000 },
        { providerSandboxId: sandbox.providerSandboxId, durationMs: 300_000 },
      ]);

      const services = (await (await fetch(`${baseUrl}/sessions/${session.id}/services?port=3000`)).json()) as {
        services: Array<{ shutdownAt: string; keepaliveUntil: string }>;
      };
      expect(services.services[0]?.keepaliveUntil).toBe(cappedExtendBody.sandbox.keepaliveUntil);
      expect(services.services[0]?.shutdownAt).toBe(cappedExtendBody.sandbox.keepaliveUntil);
    } finally {
      await closeServer(upstream);
    }
  });

  it('opens workspace tools through published sandbox services', async () => {
    const upstream = createPreviewUpstream();
    const upstreamBaseUrl = await listen(upstream);
    await closeServer(server);
    const provider = new ServiceSandboxProvider(upstreamBaseUrl);
    server = createServer(
      loadConfig({ API_AUTH_MODE: 'none', SANDBOX_KEEPALIVE_MAX_EXTENSION_SECONDS: '600' }),
      createServices(store, { sandboxProvider: provider }),
    );
    baseUrl = await listen(server);

    try {
      const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Workspace tool' });
      const { session } = (await createSession.json()) as { session: { id: string } };
      const sandbox = await provider.create({ sessionId: session.id });
      const now = new Date();
      await store.createSandbox({
        id: '00000000-0000-4000-8000-000000000508',
        sessionId: session.id,
        provider: provider.name,
        providerSandboxId: sandbox.providerSandboxId,
        status: 'ready',
        workspacePath: '/workspace',
        metadata: { runtimeId: 'runtime-1' },
        createdAt: now,
        updatedAt: now,
      });

      const response = await postJson(`${baseUrl}/sessions/${session.id}/workspace-tools/ide/open`, {});
      expect(response.status).toBe(200);
      const body = (await response.json()) as { tool: { id: string }; service: { port: number; label: string } };
      expect(body.tool.id).toBe('ide');
      expect(body.service).toMatchObject({ port: 8080, label: 'VS Code' });
      expect(provider.keepaliveRefreshes).toEqual([
        { providerSandboxId: sandbox.providerSandboxId, durationMs: 600_000 },
      ]);

      const services = (await (await fetch(`${baseUrl}/sessions/${session.id}/services`)).json()) as {
        services: Array<{ port: number; label: string }>;
      };
      expect(services.services).toMatchObject([{ port: 8080, label: 'VS Code' }]);
    } finally {
      await closeServer(upstream);
    }
  });

  it('does not create a fresh workspace when the previous sandbox is missing', async () => {
    const upstream = createPreviewUpstream();
    const upstreamBaseUrl = await listen(upstream);
    await closeServer(server);
    const provider = new ServiceSandboxProvider(upstreamBaseUrl);
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), createServices(store, { sandboxProvider: provider }));
    baseUrl = await listen(server);

    try {
      const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Destroyed workspace' });
      const { session } = (await createSession.json()) as { session: { id: string } };
      const sandbox = await provider.create({ sessionId: session.id });
      const now = new Date();
      await store.createSandbox({
        id: '00000000-0000-4000-8000-000000000509',
        sessionId: session.id,
        provider: provider.name,
        providerSandboxId: sandbox.providerSandboxId,
        status: 'ready',
        workspacePath: '/workspace',
        metadata: { runtimeId: 'runtime-1' },
        createdAt: now,
        updatedAt: now,
      });
      await provider.destroy(sandbox);

      const response = await postJson(`${baseUrl}/sessions/${session.id}/workspace-tools/ide/open`, {});
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: 'sandbox_destroyed',
        message: expect.stringContaining('Filesystem state is not persisted'),
      });
    } finally {
      await closeServer(upstream);
    }
  });

  it('does not create a fresh workspace when a sandbox disappears during tool startup', async () => {
    const upstream = createPreviewUpstream();
    const upstreamBaseUrl = await listen(upstream);
    await closeServer(server);
    const provider = new DisappearingServiceSandboxProvider(upstreamBaseUrl);
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), createServices(store, { sandboxProvider: provider }));
    baseUrl = await listen(server);

    try {
      const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Destroyed during open' });
      const { session } = (await createSession.json()) as { session: { id: string } };
      const sandbox = await provider.create({ sessionId: session.id });
      const now = new Date();
      await store.createSandbox({
        id: '00000000-0000-4000-8000-000000000510',
        sessionId: session.id,
        provider: provider.name,
        providerSandboxId: sandbox.providerSandboxId,
        status: 'ready',
        workspacePath: '/workspace',
        metadata: { runtimeId: 'runtime-1' },
        createdAt: now,
        updatedAt: now,
      });

      const response = await postJson(`${baseUrl}/sessions/${session.id}/workspace-tools/ide/open`, {});
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: 'sandbox_destroyed' });
      expect(provider.creates).toBe(1);
    } finally {
      await closeServer(upstream);
    }
  });

  it('does not list published services from an old sandbox', async () => {
    const upstream = createPreviewUpstream();
    const upstreamBaseUrl = await listen(upstream);
    await closeServer(server);
    const provider = new ServiceSandboxProvider(upstreamBaseUrl);
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), createServices(store, { sandboxProvider: provider }));
    baseUrl = await listen(server);

    try {
      const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Stale service' });
      const { session } = (await createSession.json()) as {
        session: { id: string; createdAt: string; updatedAt: string };
      };
      await store.updateSession({
        ...session,
        status: 'idle',
        createdAt: new Date(session.createdAt),
        updatedAt: new Date(session.updatedAt),
        context: { services: [{ port: 3000, providerSandboxId: 'old-sandbox' }] },
      });
      const sandbox = await provider.create({ sessionId: session.id });
      const now = new Date();
      await store.createSandbox({
        id: '00000000-0000-4000-8000-000000000505',
        sessionId: session.id,
        provider: provider.name,
        providerSandboxId: sandbox.providerSandboxId,
        status: 'ready',
        workspacePath: '/workspace',
        metadata: {},
        createdAt: now,
        updatedAt: now,
      });

      await expect((await fetch(`${baseUrl}/sessions/${session.id}/services`)).json()).resolves.toEqual({
        services: [],
      });
    } finally {
      await closeServer(upstream);
    }
  });

  it('does not list published services from an old sandbox runtime', async () => {
    const upstream = createPreviewUpstream();
    const upstreamBaseUrl = await listen(upstream);
    await closeServer(server);
    const provider = new ServiceSandboxProvider(upstreamBaseUrl);
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), createServices(store, { sandboxProvider: provider }));
    baseUrl = await listen(server);

    try {
      const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Stale runtime service' });
      const { session } = (await createSession.json()) as {
        session: { id: string; createdAt: string; updatedAt: string };
      };
      const sandbox = await provider.create({ sessionId: session.id });
      await store.updateSession({
        ...session,
        status: 'idle',
        createdAt: new Date(session.createdAt),
        updatedAt: new Date(session.updatedAt),
        context: { services: [{ port: 3000, providerSandboxId: sandbox.providerSandboxId, runtimeId: 'old-runtime' }] },
      });
      const now = new Date();
      await store.createSandbox({
        id: '00000000-0000-4000-8000-000000000506',
        sessionId: session.id,
        provider: provider.name,
        providerSandboxId: sandbox.providerSandboxId,
        status: 'ready',
        workspacePath: '/workspace',
        metadata: { runtimeId: 'new-runtime' },
        createdAt: now,
        updatedAt: now,
      });

      await expect((await fetch(`${baseUrl}/sessions/${session.id}/services`)).json()).resolves.toEqual({
        services: [],
      });
    } finally {
      await closeServer(upstream);
    }
  });

  it('does not trust forwarded service hosts unless explicitly configured', async () => {
    const upstream = createPreviewUpstream();
    const upstreamBaseUrl = await listen(upstream);
    await closeServer(server);
    const provider = new ServiceSandboxProvider(upstreamBaseUrl);
    server = createServer(
      loadConfig({ API_AUTH_MODE: 'none', WEB_BASE_URL: 'https://deputies.localhost' }),
      createServices(store, { sandboxProvider: provider }),
    );
    baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/`, {
        headers: { 'x-forwarded-host': 's-3000-session-1.deputies.localhost' },
      });

      expect(response.status).toBe(404);
    } finally {
      await closeServer(upstream);
    }
  });

  it('rejects service hosts outside the configured preview domain', async () => {
    await closeServer(server);
    server = createServer(loadConfig({ API_AUTH_MODE: 'none', SERVICE_BASE_DOMAIN: 'deputies.localhost' }));
    baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/`, {
      headers: { host: 's-3000-session-1.evil.localhost' },
    });

    expect(response.status).toBe(404);
  });

  it('unarchives a session', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Restore me' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    await postJson(`${baseUrl}/sessions/${session.id}/archive`, {});

    const unarchiveSession = await postJson(`${baseUrl}/sessions/${session.id}/unarchive`, {});

    expect(unarchiveSession.status).toBe(200);
    const unarchiveBody = await unarchiveSession.json();
    expectSessionResponse(unarchiveBody);
    expect(unarchiveBody.session.status).toBe('idle');

    const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
    const eventsBody = await eventsResponse.json();
    expectEventsResponse(eventsBody);
    expect(eventsBody.events.map((event) => event.type)).toEqual([
      'session_created',
      'session_archived',
      'session_unarchived',
    ]);
  });

  it('streams replayed and live events with SSE', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Stream session' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    const abort = new AbortController();
    const streamResponse = await fetch(`${baseUrl}/sessions/${session.id}/events/stream?after=1`, {
      signal: abort.signal,
    });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');

    const nextEvent = readNextSseEvent(streamResponse, abort);
    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'stream this',
    });
    expect(createMessage.status).toBe(202);

    await expect(nextEvent).resolves.toMatchObject({ type: 'message_created', sequence: 2 });
  });

  it('lists and streams global events for cross-session discovery', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Global stream session' });
    expect(createSession.status).toBe(201);
    const { session } = (await createSession.json()) as { session: { id: string } };

    const globalEventsResponse = await fetch(`${baseUrl}/events`);
    expect(globalEventsResponse.status).toBe(200);
    const globalEventsBody = await globalEventsResponse.json();
    expectEventsResponse(globalEventsBody);
    expect(globalEventsBody.events).toMatchObject([{ type: 'session_created', sessionId: session.id, id: 1 }]);

    const abort = new AbortController();
    const streamResponse = await fetch(`${baseUrl}/events/stream?after=1`, { signal: abort.signal });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');

    const nextEvent = readNextSseEvent(streamResponse, abort);
    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, {
      prompt: 'global stream this',
    });
    expect(createMessage.status).toBe(202);

    await expect(nextEvent).resolves.toMatchObject({ type: 'message_created', sessionId: session.id, id: 2 });
  });

  it('cleans up SSE subscribers when clients disconnect', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Cleanup stream session' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    const abort = new AbortController();

    const streamResponse = await fetch(`${baseUrl}/sessions/${session.id}/events/stream`, { signal: abort.signal });
    expect(streamResponse.status).toBe(200);
    expect(services.events.subscriberCount()).toBe(1);

    abort.abort();
    void streamResponse.body?.cancel().catch(() => undefined);

    await waitForZero(() => services.events.subscriberCount());
    expect(services.events.subscriberCount()).toBe(0);
  });

  it('returns 404 when enqueueing a message for a missing session', async () => {
    const response = await postJson(`${baseUrl}/sessions/missing/messages`, { prompt: 'hello' });

    expect(response.status).toBe(404);
    const body = await response.json();
    expectErrorResponse(body);
    expect(body).toMatchObject({ error: 'not_found' });
  });

  it('validates message prompts', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, {});
    const { session } = (await createSession.json()) as { session: { id: string } };

    const response = await postJson(`${baseUrl}/sessions/${session.id}/messages`, { prompt: '' });

    expect(response.status).toBe(400);
    const body = await response.json();
    expectErrorResponse(body);
    expect(body).toMatchObject({ error: 'invalid_request' });
  });

  it('lists artifacts for a session', async () => {
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Artifacts' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    await store.createArtifact({
      id: '00000000-0000-4000-8000-000000000901',
      sessionId: session.id,
      type: 'external_link',
      url: 'https://example.com/result',
      payload: { ok: true },
      createdAt: new Date(),
    });

    const response = await fetch(`${baseUrl}/sessions/${session.id}/artifacts`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expectArtifactsResponse(body);
    expect(body.artifacts).toMatchObject([{ type: 'external_link', url: 'https://example.com/result' }]);
  });

  it('protects artifact reads when bearer auth is enabled', async () => {
    await closeServer(server);
    server = createServer(loadConfig({ API_AUTH_MODE: 'bearer', API_BEARER_TOKEN: 'secret' }));
    baseUrl = await listen(server);
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Private artifacts' }, 'secret');
    const { session } = (await createSession.json()) as { session: { id: string } };

    const missingAuth = await fetch(`${baseUrl}/sessions/${session.id}/artifacts`);
    expect(missingAuth.status).toBe(401);

    const validAuth = await fetch(`${baseUrl}/sessions/${session.id}/artifacts`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(validAuth.status).toBe(200);
    expectArtifactsResponse(await validAuth.json());
  });

  it('downloads stored blob artifacts through the product API', async () => {
    await restartWithFilesystemArtifacts();
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Stored artifact' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    const [artifact] = await services.artifacts.recordRunArtifacts({
      sessionId: session.id,
      runId: '00000000-0000-4000-8000-000000000911',
      messageId: '00000000-0000-4000-8000-000000000912',
      result: {
        text: 'created artifact',
        artifacts: [
          {
            type: 'log',
            title: 'Debug log',
            content: 'hello artifact storage',
            contentType: 'text/plain',
            fileName: 'debug.log',
          },
        ],
      },
    });

    const listResponse = await fetch(`${baseUrl}/sessions/${session.id}/artifacts`);
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { artifacts: unknown[] };
    expect(listBody.artifacts).toMatchObject([
      {
        id: artifact!.id,
        type: 'log',
        title: 'Debug log',
        storageKey: expect.stringMatching(
          /^artifacts\/\d{8}T\d{9}Z\/sessions\/.*\/runs\/00000000-0000-4000-8000-000000000911\/.*-debug\.log$/,
        ),
        payload: {
          storage: 'internal',
          contentType: 'text/plain',
          fileName: 'debug.log',
          sizeBytes: 22,
          checksumSha256: expect.any(String),
        },
      },
    ]);

    const download = await fetch(`${baseUrl}/sessions/${session.id}/artifacts/${artifact!.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('text/plain');
    expect(download.headers.get('content-disposition')).toContain('debug.log');
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-security-policy')).toBeNull();
    await expect(download.text()).resolves.toBe('hello artifact storage');

    const preview = await fetch(`${baseUrl}/sessions/${session.id}/artifacts/${artifact!.id}/preview`);
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expectArtifactPreviewResponse(previewBody);
    expect(previewBody).toMatchObject({
      preview: { text: 'hello artifact storage', contentType: 'text/plain', truncated: false, sizeBytes: 22 },
    });
  });

  it('only serves strict safe artifact content types inline', async () => {
    await restartWithFilesystemArtifacts();
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Inline artifact safety' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    const [textArtifact, htmlArtifact] = await services.artifacts.recordRunArtifacts({
      sessionId: session.id,
      runId: '00000000-0000-4000-8000-000000000919',
      messageId: '00000000-0000-4000-8000-000000000920',
      result: {
        text: 'created artifacts',
        artifacts: [
          { type: 'file', content: 'plain text', contentType: 'text/plain; charset=utf-8', fileName: 'safe.txt' },
          { type: 'file', content: '<script>alert(1)</script>', contentType: 'text/html', fileName: 'unsafe.html' },
        ],
      },
    });

    const safeInline = await fetch(
      `${baseUrl}/sessions/${session.id}/artifacts/${textArtifact!.id}/download?disposition=inline`,
    );
    expect(safeInline.status).toBe(200);
    expect(safeInline.headers.get('content-disposition')).toContain('inline');
    expect(safeInline.headers.get('x-content-type-options')).toBe('nosniff');
    expect(safeInline.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(safeInline.headers.get('content-security-policy')).toContain('sandbox');

    const unsafeInline = await fetch(
      `${baseUrl}/sessions/${session.id}/artifacts/${htmlArtifact!.id}/download?disposition=inline`,
    );
    expect(unsafeInline.status).toBe(200);
    expect(unsafeInline.headers.get('content-type')).toContain('text/html');
    expect(unsafeInline.headers.get('content-disposition')).toContain('attachment');
    expect(unsafeInline.headers.get('content-disposition')).toContain('unsafe.html');
    expect(unsafeInline.headers.get('x-content-type-options')).toBe('nosniff');
    expect(unsafeInline.headers.get('content-security-policy')).toBeNull();
  });

  it('derives artifact titles from filenames when no title is provided', async () => {
    await restartWithFilesystemArtifacts();
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Stored artifact' });
    const { session } = (await createSession.json()) as { session: { id: string } };

    const [artifact] = await services.artifacts.recordRunArtifacts({
      sessionId: session.id,
      runId: '00000000-0000-4000-8000-000000000913',
      messageId: '00000000-0000-4000-8000-000000000914',
      result: {
        text: 'created artifact',
        artifacts: [
          { type: 'file', content: 'sample', contentType: 'text/plain', fileName: 'another-artifact-sample.txt' },
        ],
      },
    });

    expect(artifact).toMatchObject({ title: 'Another Artifact Sample' });
  });

  it('caps long artifact filenames in storage keys', async () => {
    await restartWithFilesystemArtifacts();
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Long artifact filename' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    const longFileName = `${'a'.repeat(180)}.txt`;

    const [artifact] = await services.artifacts.recordRunArtifacts({
      sessionId: session.id,
      runId: '00000000-0000-4000-8000-000000000917',
      messageId: '00000000-0000-4000-8000-000000000918',
      result: {
        text: 'created artifact',
        artifacts: [{ type: 'file', content: 'sample', contentType: 'text/plain', fileName: longFileName }],
      },
    });

    const suffix = artifact!.storageKey!.split('/').at(-1)!;
    expect(suffix).toHaveLength(`${artifact!.id}-`.length + 120);
    expect(suffix).toBe(`${artifact!.id}-${'a'.repeat(120)}`);
  });

  it('uses ranged object reads for text artifact previews', async () => {
    await closeServer(server);
    const ranges: Array<{ key: string; start: number; endInclusive: number }> = [];
    const storage: ArtifactObjectStorage = {
      async put() {},
      async get() {
        throw new Error('Expected preview to use getRange');
      },
      async getRange(key, start, endInclusive) {
        ranges.push({ key, start, endInclusive });
        return { body: new TextEncoder().encode('preview'), contentType: 'text/plain', contentLength: 7 };
      },
    };
    store = new MemoryStore();
    services = createServices(store, { artifactObjectStorage: storage });
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), services);
    baseUrl = await listen(server);
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Preview session' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    await store.createArtifact({
      id: '00000000-0000-4000-8000-000000000951',
      sessionId: session.id,
      type: 'log',
      storageKey: 'logs/run.log',
      payload: { contentType: 'text/plain', fileName: 'run.log', sizeBytes: 40_000 },
      createdAt: new Date(),
    });

    const response = await fetch(
      `${baseUrl}/sessions/${session.id}/artifacts/00000000-0000-4000-8000-000000000951/preview`,
    );

    expect(response.status).toBe(200);
    expect(ranges).toEqual([{ key: 'logs/run.log', start: 0, endInclusive: 32 * 1024 - 1 }]);
    const body = await response.json();
    expectArtifactPreviewResponse(body);
    expect(body).toMatchObject({
      preview: { text: 'preview', contentType: 'text/plain', truncated: true, sizeBytes: 40_000 },
    });
  });

  it('rejects text previews when content type and filename extension disagree', async () => {
    await restartWithFilesystemArtifacts();
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Preview session' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    const [artifact] = await services.artifacts.recordRunArtifacts({
      sessionId: session.id,
      runId: '00000000-0000-4000-8000-000000000915',
      messageId: '00000000-0000-4000-8000-000000000916',
      result: {
        text: 'created artifact',
        artifacts: [{ type: 'file', content: 'not really png', contentType: 'text/plain', fileName: 'not-text.png' }],
      },
    });

    const response = await fetch(`${baseUrl}/sessions/${session.id}/artifacts/${artifact!.id}/preview`);

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({ error: 'unsupported_preview' });
  });

  it('best-effort deletes stored objects when artifact metadata creation fails', async () => {
    const deletedKeys: string[] = [];
    const storage: ArtifactObjectStorage = {
      async put() {},
      async get() {
        return null;
      },
      async delete(key) {
        deletedKeys.push(key);
      },
    };
    const events = services.events;
    const failingStore = {
      async createArtifact() {
        throw new Error('metadata insert failed');
      },
    };
    const artifactService = new ArtifactService(failingStore, events, storage);

    await expect(
      artifactService.createStoredArtifact({
        sessionId: '00000000-0000-4000-8000-000000000001',
        runId: '00000000-0000-4000-8000-000000000002',
        messageId: '00000000-0000-4000-8000-000000000003',
        type: 'file',
        body: new TextEncoder().encode('orphan'),
        fileName: 'orphan.txt',
      }),
    ).rejects.toThrow('metadata insert failed');
    expect(deletedKeys).toHaveLength(1);
    expect(deletedKeys[0]).toMatch(
      /^artifacts\/\d{8}T\d{9}Z\/sessions\/00000000-0000-4000-8000-000000000001\/runs\/00000000-0000-4000-8000-000000000002\/.*-orphan\.txt$/,
    );
  });

  it('protects stored artifact downloads with product auth', async () => {
    await closeServer(server);
    artifactTempDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-artifacts-'));
    store = new MemoryStore();
    services = createServices(store, { artifactObjectStorage: new FilesystemArtifactObjectStorage(artifactTempDir) });
    server = createServer(loadConfig({ API_AUTH_MODE: 'bearer', API_BEARER_TOKEN: 'secret' }), services);
    baseUrl = await listen(server);

    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Private artifact' }, 'secret');
    const { session } = (await createSession.json()) as { session: { id: string } };
    const [artifact] = await services.artifacts.recordRunArtifacts({
      sessionId: session.id,
      runId: '00000000-0000-4000-8000-000000000921',
      messageId: '00000000-0000-4000-8000-000000000922',
      result: { text: 'private', artifacts: [{ type: 'file', content: 'secret file', fileName: 'secret.txt' }] },
    });

    const missingAuth = await fetch(`${baseUrl}/sessions/${session.id}/artifacts/${artifact!.id}/download`);
    expect(missingAuth.status).toBe(401);

    const validAuth = await fetch(`${baseUrl}/sessions/${session.id}/artifacts/${artifact!.id}/download`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(validAuth.status).toBe(200);
    await expect(validAuth.text()).resolves.toBe('secret file');
  });

  it('does not download artifacts through the wrong session', async () => {
    await restartWithFilesystemArtifacts();
    const firstSessionResponse = await postJson(`${baseUrl}/sessions`, { title: 'First' });
    const secondSessionResponse = await postJson(`${baseUrl}/sessions`, { title: 'Second' });
    const { session: firstSession } = (await firstSessionResponse.json()) as { session: { id: string } };
    const { session: secondSession } = (await secondSessionResponse.json()) as { session: { id: string } };
    const [artifact] = await services.artifacts.recordRunArtifacts({
      sessionId: firstSession.id,
      runId: '00000000-0000-4000-8000-000000000931',
      messageId: '00000000-0000-4000-8000-000000000932',
      result: { text: 'file', artifacts: [{ type: 'file', content: 'first session' }] },
    });

    const response = await fetch(`${baseUrl}/sessions/${secondSession.id}/artifacts/${artifact!.id}/download`);
    expect(response.status).toBe(404);
  });

  it('returns a stable 404 when artifact metadata points to a missing object', async () => {
    await restartWithFilesystemArtifacts();
    const createSession = await postJson(`${baseUrl}/sessions`, { title: 'Missing object' });
    const { session } = (await createSession.json()) as { session: { id: string } };
    await store.createArtifact({
      id: '00000000-0000-4000-8000-000000000941',
      sessionId: session.id,
      type: 'file',
      storageKey: 'missing/object.txt',
      payload: { storage: 'internal', fileName: 'object.txt' },
      createdAt: new Date(),
    });

    const listResponse = await fetch(`${baseUrl}/sessions/${session.id}/artifacts`);
    expect(listResponse.status).toBe(200);

    const download = await fetch(
      `${baseUrl}/sessions/${session.id}/artifacts/00000000-0000-4000-8000-000000000941/download`,
    );
    expect(download.status).toBe(404);
    await expect(download.json()).resolves.toMatchObject({ error: 'not_found' });
  });

  it('returns stable errors for invalid JSON bodies', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expectErrorResponse(body);
    expect(body).toMatchObject({ error: 'invalid_json' });
  });

  it('rejects oversized JSON bodies', async () => {
    await closeServer(server);
    server = createServer(loadConfig({ API_AUTH_MODE: 'none', MAX_JSON_BODY_BYTES: '16' }));
    baseUrl = await listen(server);

    const response = await postJson(`${baseUrl}/sessions`, { title: 'this is too large' });

    expect(response.status).toBe(413);
    const body = await response.json();
    expectErrorResponse(body);
    expect(body).toMatchObject({ error: 'payload_too_large' });
  });
});

function postJson(url: string, body: unknown, bearerToken?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function patchJson(url: string, body: unknown, bearerToken?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  return fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }
  return `http://${address.address}:${address.port}`;
}

class ServiceSandboxProvider extends FakeSandboxProvider {
  keepaliveRefreshes: Array<{ providerSandboxId: string; durationMs: number }> = [];

  override readonly capabilities = {
    persistentFilesystem: true,
    snapshots: false,
    stopStart: false,
    exec: true,
    filesystem: false,
    streamingLogs: false,
    portForwarding: false,
    previewUrls: true,
    objectStorageArtifacts: false,
  };

  constructor(private readonly upstreamBaseUrl: string) {
    super();
  }

  async getPreviewUrl(input: SandboxPreviewUrlInput) {
    return { port: input.port, targetUrl: this.upstreamBaseUrl };
  }

  async refreshKeepalive(input: { providerSandboxId: string; durationMs: number }) {
    this.keepaliveRefreshes.push({ providerSandboxId: input.providerSandboxId, durationMs: input.durationMs });
  }
}

class DisappearingServiceSandboxProvider extends ServiceSandboxProvider {
  creates = 0;
  private healthChecks = 0;

  override async create(input: CreateSandboxInput) {
    this.creates += 1;
    return super.create(input);
  }

  override async health(input: SandboxRef): Promise<SandboxHealth> {
    this.healthChecks += 1;
    if (this.healthChecks > 1) return { status: 'missing', checkedAt: new Date() };
    return super.health(input);
  }
}

function createPreviewUpstream(): Server {
  return createHttpServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><script type="module" src="/@vite/client"></script></head>
          <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
        </html>`);
      return;
    }
    if (request.url === '/@vite/client') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('vite client');
      return;
    }
    if (request.url === '/src/main.tsx') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('main');
      return;
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/dashboard' });
      response.end();
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForZero(readValue: () => number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (readValue() !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readNextSseEvent(
  response: Response,
  abort: AbortController,
): Promise<{ id: number; type: string; sequence: number }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected response body');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream ended before event');
      buffer += decoder.decode(value, { stream: true });

      const eventEnd = buffer.indexOf('\n\n');
      if (eventEnd === -1) continue;

      const frame = buffer.slice(0, eventEnd);
      buffer = buffer.slice(eventEnd + 2);
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length);
      if (!data) continue;

      return JSON.parse(data) as { id: number; type: string; sequence: number };
    }
  } finally {
    abort.abort();
    reader.releaseLock();
  }
}
