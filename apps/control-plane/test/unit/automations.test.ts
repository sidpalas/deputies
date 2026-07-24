import { createApp, createServices } from '../../src/app/server.js';
import { nextUtcCronInvocation } from '../../src/automations/cron.js';
import { AutomationServiceError } from '../../src/automations/service.js';
import { loadConfig } from '../../src/config/index.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { AutomationRecord } from '../../src/store/types.js';

describe('scheduled automations', () => {
  it('computes the next UTC cron invocation', () => {
    expect(nextUtcCronInvocation('0 9 * * 1-5', new Date('2026-06-08T08:59:30Z')).toISOString()).toBe(
      '2026-06-08T09:00:00.000Z',
    );
    expect(nextUtcCronInvocation('0 9 * * 1-5', new Date('2026-06-08T09:00:00Z')).toISOString()).toBe(
      '2026-06-09T09:00:00.000Z',
    );
  });

  it('requires explicit override before manually invoking a disabled automation', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const automation = await services.automations.createScheduled({
      name: 'Nightly check',
      prompt: 'Check the repository',
      scheduleCron: '0 9 * * *',
      enabled: false,
    });

    await expect(services.automations.invokeManual({ automationId: automation.id })).rejects.toMatchObject({
      code: 'disabled',
    } satisfies Partial<AutomationServiceError>);

    const result = await services.automations.invokeManual({ automationId: automation.id, allowDisabled: true });
    expect(result.invocation).toMatchObject({ trigger: 'manual', status: 'created' });
    expect(result.session).toMatchObject({
      title: expect.stringContaining('Nightly check'),
      status: 'queued',
      tags: ['automation'],
    });
    expect(result.message).toMatchObject({ prompt: 'Check the repository', source: 'automation' });
  });

  it('applies environment branch overrides when invoking automations', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Product surface',
      repositories: [
        { provider: 'github', owner: 'acme', repo: 'api', branch: 'main', primary: true },
        { provider: 'github', owner: 'acme', repo: 'web', primary: false },
      ],
    });
    const automation = await services.automations.createScheduled({
      name: 'Environment automation',
      prompt: 'Run against the environment',
      scheduleCron: '0 9 * * *',
      environmentId: environment.id,
      context: {
        model: 'anthropic/claude-sonnet',
        reasoningLevel: 'high',
        environmentBranchOverrides: [{ provider: 'github', owner: 'acme', repo: 'web', branch: 'release' }],
      },
    });

    const result = await services.automations.invokeManual({ automationId: automation.id });

    expect(result.message?.context).toEqual({
      model: 'anthropic/claude-sonnet',
      reasoningLevel: 'high',
      environment: {
        id: environment.id,
        revisionId: environment.currentRevisionId,
        revisionNumber: 1,
        name: 'Product surface',
        codebase: {
          repositories: [
            { provider: 'github', owner: 'acme', repo: 'api', branch: 'main', primary: true },
            { provider: 'github', owner: 'acme', repo: 'web', branch: 'release', primary: false },
          ],
        },
      },
    });
  });

  it('applies environment branch overrides that clear default branches when invoking automations', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Product surface',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', branch: 'main', primary: true }],
    });
    const automation = await services.automations.createScheduled({
      name: 'Environment automation',
      prompt: 'Run against the environment',
      scheduleCron: '0 9 * * *',
      environmentId: environment.id,
      context: {
        environmentBranchOverrides: [{ provider: 'github', owner: 'acme', repo: 'api' }],
      },
    });

    const result = await services.automations.invokeManual({ automationId: automation.id });

    expect(result.message?.context).toEqual({
      environment: {
        id: environment.id,
        revisionId: environment.currentRevisionId,
        revisionNumber: 1,
        name: 'Product surface',
        codebase: {
          repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
        },
      },
    });
  });

  it('pins automation invocations to an immutable environment revision', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Pinned codebase',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const automation = await services.automations.createScheduled({
      name: 'Pinned automation',
      prompt: 'Use the pinned revision',
      scheduleCron: '0 9 * * *',
      environmentId: environment.id,
      environmentRevisionPolicy: 'pinned',
      environmentRevisionId: environment.currentRevisionId,
    });
    await services.environments.update({
      id: environment.id,
      repositories: [{ provider: 'github', owner: 'acme', repo: 'web', primary: true }],
    });

    const result = await services.automations.invokeManual({ automationId: automation.id });

    expect(result.invocation).toMatchObject({
      environmentId: environment.id,
      environmentRevisionId: environment.currentRevisionId,
    });
    expect(
      (result.message?.context?.environment as { codebase: { repositories: Array<{ repo: string }> } }).codebase
        .repositories,
    ).toMatchObject([{ repo: 'api' }]);
  });

  it('can switch a pinned automation back to following the latest revision', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Policy transition codebase',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const pinned = await services.automations.createScheduled({
      name: 'Policy transition automation',
      prompt: 'Use the selected revision policy',
      scheduleCron: '0 9 * * *',
      environmentId: environment.id,
      environmentRevisionPolicy: 'pinned',
      environmentRevisionId: environment.currentRevisionId,
    });

    const following = await services.automations.updateScheduled({
      id: pinned.id,
      environmentRevisionPolicy: 'follow_latest',
    });

    expect(following.environmentRevisionPolicy).toBe('follow_latest');
    expect(following.environmentRevisionId).toBeUndefined();
  });

  it('resolves follow-latest automation revisions when each invocation is recorded', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const environment = await services.environments.create({
      name: 'Latest codebase',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });
    const automation = await services.automations.createScheduled({
      name: 'Latest automation',
      prompt: 'Use the latest revision',
      scheduleCron: '0 9 * * *',
      environmentId: environment.id,
    });
    const revised = await services.environments.update({
      id: environment.id,
      repositories: [
        { provider: 'github', owner: 'acme', repo: 'api', primary: false },
        { provider: 'github', owner: 'acme', repo: 'web', primary: true },
      ],
    });

    const result = await services.automations.invokeManual({ automationId: automation.id });

    expect(result.invocation).toMatchObject({
      environmentId: environment.id,
      environmentRevisionId: revised.currentRevisionId,
    });
  });

  it('creates a new session for a due scheduled invocation', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date('2026-06-08T09:00:30Z');
    const automation = await services.automations.createScheduled({
      name: 'Weekday check',
      prompt: 'Run the weekday check',
      scheduleCron: '* * * * *',
    });
    await setNextInvocationAt(store, automation, new Date('2026-06-08T09:00:00Z'), now);

    await expect(services.automations.processNextScheduled({ now, lockOwner: 'scheduler-1' })).resolves.toBe(true);

    const invocations = await services.automations.listInvocations(automation.id);
    expect(invocations[0]).toMatchObject({ trigger: 'scheduled', status: 'created' });
    expect(invocations[0]?.sessionId).toBeTruthy();
    await expect(services.sessions.list()).resolves.toMatchObject([
      { title: 'Weekday check - 2026-06-08 09:00 UTC', status: 'queued', tags: ['automation'] },
    ]);
  });

  it('records skipped scheduled invocations when a previous automation session is still queued', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date('2026-06-08T09:00:30Z');
    const automation = await services.automations.createScheduled({
      name: 'Overlap guard',
      prompt: 'Run without overlap',
      scheduleCron: '* * * * *',
    });
    await setNextInvocationAt(store, automation, new Date('2026-06-08T09:00:00Z'), now);
    await services.automations.processNextScheduled({ now, lockOwner: 'scheduler-1' });

    const secondNow = new Date('2026-06-08T09:01:30Z');
    const current = await services.automations.get(automation.id);
    await setNextInvocationAt(store, current!, new Date('2026-06-08T09:01:00Z'), secondNow);
    await services.automations.processNextScheduled({ now: secondNow, lockOwner: 'scheduler-1' });

    const invocations = await services.automations.listInvocations(automation.id);
    expect(invocations.map((invocation) => invocation.status).sort()).toEqual(['created', 'skipped']);
    expect(invocations.find((invocation) => invocation.status === 'skipped')).toMatchObject({
      reason: 'previous_session_active',
    });
  });

  it('records missed scheduled invocations without creating catch-up sessions', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date('2026-06-08T09:10:00Z');
    const automation = await services.automations.createScheduled({
      name: 'No catch-up',
      prompt: 'Do not run late',
      scheduleCron: '* * * * *',
    });
    await setNextInvocationAt(store, automation, new Date('2026-06-08T09:00:00Z'), now);

    await services.automations.processNextScheduled({ now, lockOwner: 'scheduler-1' });

    const invocations = await services.automations.listInvocations(automation.id);
    expect(invocations[0]).toMatchObject({ status: 'skipped', reason: 'missed_schedule' });
    await expect(services.sessions.list()).resolves.toHaveLength(0);
  });

  it('retries a stale creating scheduled invocation instead of skipping it', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const scheduledAt = new Date('2026-06-08T09:00:00Z');
    const now = new Date('2026-06-08T09:01:30Z');
    const automation = await services.automations.createScheduled({
      name: 'Retry stale creating',
      prompt: 'Recover this invocation',
      scheduleCron: '* * * * *',
    });
    await setNextInvocationAt(store, automation, scheduledAt, now);
    await store.createAutomationInvocation({
      id: '00000000-0000-4000-8000-000000000101',
      automationId: automation.id,
      trigger: 'scheduled',
      status: 'creating',
      scheduledAt,
      createdAt: scheduledAt,
      metadata: {},
    });

    await services.automations.processNextScheduled({ now, lockOwner: 'scheduler-1' });

    const invocations = await services.automations.listInvocations(automation.id);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ status: 'created', scheduledAt });
    await expect(services.sessions.list()).resolves.toHaveLength(1);
  });

  it('retries a stale creating scheduled invocation without duplicating reserved work', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const scheduledAt = new Date('2026-06-08T09:00:00Z');
    const now = new Date('2026-06-08T09:01:30Z');
    const sessionId = '00000000-0000-4000-8000-000000000201';
    const messageId = '00000000-0000-4000-8000-000000000202';
    const automation = await services.automations.createScheduled({
      name: 'Retry reserved creating',
      prompt: 'Recover reserved invocation',
      scheduleCron: '* * * * *',
    });
    await setNextInvocationAt(store, automation, scheduledAt, now);
    await services.sessions.create({
      id: sessionId,
      title: 'Retry reserved creating - 2026-06-08 09:00 UTC',
    });
    await services.messages.enqueue({
      id: messageId,
      sessionId,
      prompt: 'Recover reserved invocation',
      source: 'automation',
    });
    await store.createAutomationInvocation({
      id: '00000000-0000-4000-8000-000000000203',
      automationId: automation.id,
      trigger: 'scheduled',
      status: 'creating',
      scheduledAt,
      createdAt: scheduledAt,
      reservedSessionId: sessionId,
      reservedMessageId: messageId,
      metadata: {},
    });

    await services.automations.processNextScheduled({ now, lockOwner: 'scheduler-1' });

    const invocations = await services.automations.listInvocations(automation.id);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ status: 'created', sessionId, messageId });
    await expect(services.sessions.list()).resolves.toHaveLength(1);
    await expect(store.getMessages(sessionId)).resolves.toHaveLength(1);
  });

  it('does not manually invoke while another invocation owns the automation claim', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const automation = await services.automations.createScheduled({
      name: 'Manual lock guard',
      prompt: 'Do not overlap lock',
      scheduleCron: '* * * * *',
    });
    await store.claimAutomation({
      automationId: automation.id,
      now: new Date('2026-06-08T09:00:00Z'),
      lockOwner: 'other-invoker',
      lockedUntil: new Date('2999-01-01T00:00:00Z'),
    });

    await expect(services.automations.invokeManual({ automationId: automation.id })).rejects.toMatchObject({
      code: 'overlap',
    } satisfies Partial<AutomationServiceError>);
    await expect(services.sessions.list()).resolves.toHaveLength(0);
  });

  it('exposes create, list, update, and manual invoke API routes', async () => {
    const services = createServices(new MemoryStore());
    const app = createApp(loadConfig({ API_AUTH_MODE: 'none' }), services);

    const createResponse = await app.request(
      '/automations',
      jsonRequest({
        name: 'API automation',
        prompt: 'Run from API',
        scheduleCron: '0 9 * * 1-5',
        repository: 'acme/widget',
        branch: 'main',
        model: 'anthropic/claude-sonnet',
        reasoningLevel: 'max',
      }),
    );
    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as {
      automation: { id: string; context?: Record<string, unknown> };
    };
    expect(createBody.automation).toMatchObject({
      name: 'API automation',
      prompt: 'Run from API',
      scheduleCron: '0 9 * * 1-5',
      context: {
        repository: { provider: 'github', owner: 'acme', repo: 'widget' },
        branch: 'main',
        model: 'anthropic/claude-sonnet',
        reasoningLevel: 'max',
      },
    });

    const listResponse = await app.request('/automations');
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { automations: Array<{ id: string }> };
    expect(listBody.automations.map((automation) => automation.id)).toContain(createBody.automation.id);

    const getResponse = await app.request(`/automations/${createBody.automation.id}`);
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({ automation: { id: createBody.automation.id } });

    const updateResponse = await app.request(
      `/automations/${createBody.automation.id}`,
      jsonRequest(
        { name: 'Updated API automation', repository: '', branch: '', model: '', reasoningLevel: '' },
        'PATCH',
      ),
    );
    expect(updateResponse.status).toBe(200);
    const updateBody = (await updateResponse.json()) as { automation: { name: string; context?: unknown } };
    expect(updateBody.automation.name).toBe('Updated API automation');
    expect(updateBody.automation).not.toHaveProperty('context');

    const invokeResponse = await app.request(`/automations/${createBody.automation.id}/invoke`, jsonRequest({}));
    expect(invokeResponse.status).toBe(202);
    const invokeBody = (await invokeResponse.json()) as {
      invocation: { id: string; status: string; trigger: string; sessionId?: string };
      session?: { id: string; status: string };
    };
    expect(invokeBody.invocation).toMatchObject({ status: 'created', trigger: 'manual' });
    expect(invokeBody.invocation.sessionId).toBe(invokeBody.session?.id);
    expect(invokeBody.session).toMatchObject({ status: 'queued' });

    const invocationsResponse = await app.request(`/automations/${createBody.automation.id}/invocations`);
    expect(invocationsResponse.status).toBe(200);
    const invocationsBody = (await invocationsResponse.json()) as {
      invocations: Array<{ id: string; sessionStatus?: string; messageStatus?: string }>;
    };
    expect(invocationsBody.invocations.map((invocation) => invocation.id)).toContain(invokeBody.invocation.id);
    expect(invocationsBody.invocations[0]).toMatchObject({ sessionStatus: 'queued', messageStatus: 'pending' });
  });

  it('validates environment branch overrides on automation API routes', async () => {
    const services = createServices(new MemoryStore());
    const app = createApp(loadConfig({ API_AUTH_MODE: 'none' }), services);
    const environment = await services.environments.create({
      name: 'API environment',
      repositories: [{ provider: 'github', owner: 'acme', repo: 'api', primary: true }],
    });

    const createResponse = await app.request(
      '/automations',
      jsonRequest({
        name: 'Environment API automation',
        prompt: 'Run from API',
        scheduleCron: '0 9 * * 1-5',
        environmentId: environment.id,
        environmentBranchOverrides: [{ provider: 'github', owner: 'acme', repo: 'api', branch: 'release' }],
      }),
    );
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      automation: {
        environmentId: environment.id,
        context: {
          environmentBranchOverrides: [{ provider: 'github', owner: 'acme', repo: 'api', branch: 'release' }],
        },
      },
    });

    const pinnedResponse = await app.request(
      '/automations',
      jsonRequest({
        name: 'Pinned environment API automation',
        prompt: 'Keep using this revision',
        scheduleCron: '0 9 * * 1-5',
        environmentId: environment.id,
        environmentRevisionPolicy: 'pinned',
        environmentRevisionId: environment.currentRevisionId,
      }),
    );
    expect(pinnedResponse.status).toBe(201);
    const pinnedBody = (await pinnedResponse.json()) as { automation: { id: string } };
    const revised = await services.environments.update({
      id: environment.id,
      repositories: [
        { provider: 'github', owner: 'acme', repo: 'api', primary: false },
        { provider: 'github', owner: 'acme', repo: 'web', primary: true },
      ],
    });
    expect(revised.currentRevisionNumber).toBe(2);
    const pinnedGetResponse = await app.request(`/automations/${pinnedBody.automation.id}`);
    expect(pinnedGetResponse.status).toBe(200);
    await expect(pinnedGetResponse.json()).resolves.toMatchObject({
      automation: {
        environmentRevisionId: environment.currentRevisionId,
        environmentRevisionNumber: environment.currentRevisionNumber,
      },
    });

    const invalidResponse = await app.request(
      '/automations',
      jsonRequest({
        name: 'Invalid environment API automation',
        prompt: 'Run from API',
        scheduleCron: '0 9 * * 1-5',
        environmentId: environment.id,
        environmentBranchOverrides: [{ provider: 'github', owner: 'acme', repo: 'worker', branch: 'release' }],
      }),
    );
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      error: 'invalid_request',
      message: 'Branch override references a repository outside the environment',
    });
  });

  it('archives, restores, and blocks archived automation enablement and invocation', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const app = createApp(loadConfig({ API_AUTH_MODE: 'none' }), services);
    const automation = await services.automations.createScheduled({
      name: 'Archive me',
      prompt: 'Do not run archived',
      scheduleCron: '* * * * *',
    });

    const archiveResponse = await app.request(`/automations/${automation.id}/archive`, jsonRequest({}));
    expect(archiveResponse.status).toBe(200);
    const archiveBody = (await archiveResponse.json()) as { automation: { enabled: boolean; archivedAt?: string } };
    expect(archiveBody.automation.enabled).toBe(false);
    expect(archiveBody.automation.archivedAt).toBeTruthy();

    await expect(
      store.updateAutomation({
        id: automation.id,
        enabled: true,
        nextInvocationAt: new Date('2026-06-08T09:00:00Z'),
        updatedAt: new Date('2026-06-08T08:59:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'automation_archived' });
    await expect(
      services.automations.processNextScheduled({ now: new Date('2026-06-08T09:00:30Z'), lockOwner: 'scheduler-1' }),
    ).resolves.toBe(false);

    const enableResponse = await app.request(`/automations/${automation.id}`, jsonRequest({ enabled: true }, 'PATCH'));
    expect(enableResponse.status).toBe(409);
    await expect(enableResponse.json()).resolves.toMatchObject({ error: 'automation_archived' });

    const invokeResponse = await app.request(`/automations/${automation.id}/invoke`, jsonRequest({}));
    expect(invokeResponse.status).toBe(409);
    await expect(invokeResponse.json()).resolves.toMatchObject({ error: 'automation_archived' });

    const unarchiveResponse = await app.request(`/automations/${automation.id}/unarchive`, jsonRequest({}));
    expect(unarchiveResponse.status).toBe(200);
    const unarchiveBody = (await unarchiveResponse.json()) as { automation: { enabled: boolean; archivedAt?: string } };
    expect(unarchiveBody.automation.enabled).toBe(false);
    expect(unarchiveBody.automation.archivedAt).toBeUndefined();

    const restoredEnableResponse = await app.request(
      `/automations/${automation.id}`,
      jsonRequest({ enabled: true }, 'PATCH'),
    );
    expect(restoredEnableResponse.status).toBe(200);
    await expect(restoredEnableResponse.json()).resolves.toMatchObject({ automation: { enabled: true } });
  });

  it('paginates automation invocations with a default latest page of 20', async () => {
    const services = createServices(new MemoryStore());
    const app = createApp(loadConfig({ API_AUTH_MODE: 'none' }), services);
    const automation = await services.automations.createScheduled({
      name: 'Paged history',
      prompt: 'Create history',
      scheduleCron: '* * * * *',
    });

    for (let index = 0; index < 25; index += 1) {
      await services.automations.invokeManual({ automationId: automation.id, allowOverlap: true });
    }

    const firstResponse = await app.request(`/automations/${automation.id}/invocations`);
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as {
      invocations: Array<{ id: string; sessionStatus?: string; messageStatus?: string }>;
      nextCursor?: string;
    };
    expect(firstBody.invocations).toHaveLength(20);
    expect(firstBody.nextCursor).toBeTruthy();
    expect(firstBody.invocations[0]).toMatchObject({ sessionStatus: 'queued', messageStatus: 'pending' });

    const firstIds = new Set(firstBody.invocations.map((invocation) => invocation.id));
    const secondResponse = await app.request(
      `/automations/${automation.id}/invocations?cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
    );
    expect(secondResponse.status).toBe(200);
    const secondBody = (await secondResponse.json()) as {
      invocations: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(secondBody.invocations).toHaveLength(5);
    expect(secondBody.invocations.some((invocation) => firstIds.has(invocation.id))).toBe(false);
    expect(secondBody.nextCursor).toBeUndefined();
  });
});

async function setNextInvocationAt(
  store: MemoryStore,
  automation: AutomationRecord,
  nextInvocationAt: Date,
  updatedAt: Date,
): Promise<void> {
  await store.updateAutomation({
    id: automation.id,
    nextInvocationAt,
    updatedAt,
  });
}

function jsonRequest(body: Record<string, unknown>, method = 'POST', cookie?: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  };
}
