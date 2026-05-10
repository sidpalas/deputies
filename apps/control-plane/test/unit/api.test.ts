import type { Server } from 'node:http';
import { createServer, createServices, type AppServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';
import { MemoryStore } from '../../src/store/memory.js';
import {
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

  beforeEach(async () => {
    store = new MemoryStore();
    services = createServices(store);
    server = createServer(loadConfig({ API_AUTH_MODE: 'none' }), services);
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('reports health', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', runMode: 'all' });
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
  });

  it('supports static login with session cookies', async () => {
    await closeServer(server);
    server = createServer(loadConfig({
      API_AUTH_MODE: 'session',
      AUTH_STATIC_USERNAME: 'dev',
      AUTH_STATIC_PASSWORD: 'password',
      AUTH_SESSION_SECRET: 'test-secret',
    }));
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

    const createSession = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ title: 'Cookie session' }),
    });
    expect(createSession.status).toBe(201);
    expectSessionResponse(await createSession.json());

    const logout = await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers: { cookie: cookie! } });
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('supports GitHub OAuth login with allowed users', async () => {
    await closeServer(server);
    store = new MemoryStore();
    server = createServer(loadConfig({
      API_AUTH_MODE: 'session',
      AUTH_PROVIDER: 'github',
      AUTH_SESSION_SECRET: 'test-secret',
      GITHUB_APP_CLIENT_ID: 'client-id',
      GITHUB_APP_CLIENT_SECRET: 'client-secret',
      GITHUB_OAUTH_BASE_URL: 'https://github.example',
      AUTH_GITHUB_ALLOWED_USERS: 'octocat',
    }), {
      ...createServices(store),
      githubOAuthClient: {
        async exchangeCode(input) {
          expect(input.code).toBe('oauth-code');
          return 'github-access-token';
        },
        async getUser(accessToken) {
          expect(accessToken).toBe('github-access-token');
          return { id: 583231, login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars.example/octocat.png' };
        },
        async listOrganizations() {
          return [];
        },
      },
    });
    baseUrl = await listen(server);

    const start = await fetch(`${baseUrl}/auth/oauth/github/start`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const location = start.headers.get('location');
    expect(location).toContain('https://github.example/login/oauth/authorize');
    const state = new URL(location!).searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = await fetch(`${baseUrl}/auth/oauth/github/callback?code=oauth-code&state=${encodeURIComponent(state!)}`, { redirect: 'manual' });
    expect(callback.status).toBe(302);
    const cookie = callback.headers.get('set-cookie');
    expect(cookie).toContain('dev_deputies_session=');

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
    await store.markCallbackDeliveryFailed({ id: delivery.id, failedAt: now, error: 'HTTP callback returned 500', terminal: true });

    const list = await fetch(`${baseUrl}/sessions/${session.id}/callbacks`);
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expectCallbacksResponse(listBody);
    expect(listBody.callbacks).toMatchObject([{ id: delivery.id, status: 'failed', lastError: 'HTTP callback returned 500' }]);

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
    expect((await pause.json()) as { session: { queuePausedAt?: string } }).toMatchObject({ session: { queuePausedAt: expect.any(String) } });

    const update = await patchJson(`${baseUrl}/sessions/${session.id}/messages/${message.id}`, { prompt: 'final' });
    expect(update.status).toBe(200);
    expect((await update.json()) as { message: { prompt: string } }).toMatchObject({ message: { prompt: 'final' } });

    const cancel = await postJson(`${baseUrl}/sessions/${session.id}/messages/${message.id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect((await cancel.json()) as { message: { status: string } }).toMatchObject({ message: { status: 'cancelled' } });

    const resume = await postJson(`${baseUrl}/sessions/${session.id}/queue/resume`, {});
    expect(resume.status).toBe(200);
    expect((await resume.json()) as { session: { queuePausedAt?: string } }).toMatchObject({ session: {} });
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
    expect(eventsBody.events.map((event) => event.type)).toEqual(['session_created', 'message_created', 'run_cancel_requested']);
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
    await expect(createMessage.json()).resolves.toMatchObject({ error: 'conflict', message: 'Cannot enqueue messages to an archived session' });
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
    });

    const archiveSession = await postJson(`${baseUrl}/sessions/${session.id}/archive`, {});

    expect(archiveSession.status).toBe(200);
    expect(provider.destroys).toBe(1);
    await expect(store.getActiveSandbox(session.id, provider.name)).resolves.toBeNull();

    const eventsResponse = await fetch(`${baseUrl}/sessions/${session.id}/events`);
    const eventsBody = (await eventsResponse.json()) as { events: Array<{ type: string }> };
    expect(eventsBody.events.map((event: { type: string }) => event.type)).toEqual(['session_created', 'session_archived', 'sandbox_destroyed']);
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
    expect(eventsBody.events.map((event) => event.type)).toEqual(['session_created', 'session_archived', 'session_unarchived']);
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
    const createMessage = await postJson(`${baseUrl}/sessions/${session.id}/messages`, { prompt: 'global stream this' });
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

async function readNextSseEvent(response: Response, abort: AbortController): Promise<{ id: number; type: string; sequence: number }> {
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
