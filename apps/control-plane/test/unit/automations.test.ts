import { createApp, createServices } from '../../src/app/server.js';
import { nextUtcCronInvocation } from '../../src/automations/cron.js';
import { AutomationServiceError } from '../../src/automations/service.js';
import { loadConfig } from '../../src/config/index.js';
import { MemoryStore } from '../../src/store/memory.js';
import { defaultGroupId } from '../../src/store/types.js';

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
      ownerGroupId: defaultGroupId,
      visibility: 'organization',
      writePolicy: 'group_members',
      enabled: false,
    });

    await expect(services.automations.invokeManual({ automationId: automation.id })).rejects.toMatchObject({
      code: 'disabled',
    } satisfies Partial<AutomationServiceError>);

    const result = await services.automations.invokeManual({ automationId: automation.id, allowDisabled: true });
    expect(result.invocation).toMatchObject({ trigger: 'manual', status: 'created' });
    expect(result.session).toMatchObject({ title: expect.stringContaining('Nightly check'), status: 'queued' });
    expect(result.message).toMatchObject({ prompt: 'Check the repository', source: 'automation' });
  });

  it('creates a new session for a due scheduled invocation', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date('2026-06-08T09:00:30Z');
    const automation = await services.automations.createScheduled({
      name: 'Weekday check',
      prompt: 'Run the weekday check',
      scheduleCron: '* * * * *',
      ownerGroupId: defaultGroupId,
      visibility: 'organization',
      writePolicy: 'group_members',
    });
    await store.updateAutomation({
      ...automation,
      nextInvocationAt: new Date('2026-06-08T09:00:00Z'),
      updatedAt: now,
    });

    await expect(services.automations.processNextScheduled({ now, lockOwner: 'scheduler-1' })).resolves.toBe(true);

    const invocations = await services.automations.listInvocations(automation.id);
    expect(invocations[0]).toMatchObject({ trigger: 'scheduled', status: 'created' });
    expect(invocations[0]?.sessionId).toBeTruthy();
    await expect(services.sessions.list()).resolves.toMatchObject([
      { title: 'Weekday check - 2026-06-08 09:00 UTC', status: 'queued' },
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
      ownerGroupId: defaultGroupId,
      visibility: 'organization',
      writePolicy: 'group_members',
    });
    await store.updateAutomation({ ...automation, nextInvocationAt: new Date('2026-06-08T09:00:00Z'), updatedAt: now });
    await services.automations.processNextScheduled({ now, lockOwner: 'scheduler-1' });

    const secondNow = new Date('2026-06-08T09:01:30Z');
    const current = await services.automations.get(automation.id);
    await store.updateAutomation({
      ...current!,
      nextInvocationAt: new Date('2026-06-08T09:01:00Z'),
      updatedAt: secondNow,
    });
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
      ownerGroupId: defaultGroupId,
      visibility: 'organization',
      writePolicy: 'group_members',
    });
    await store.updateAutomation({
      ...automation,
      nextInvocationAt: new Date('2026-06-08T09:00:00Z'),
      updatedAt: now,
    });

    await services.automations.processNextScheduled({ now, lockOwner: 'scheduler-1' });

    const invocations = await services.automations.listInvocations(automation.id);
    expect(invocations[0]).toMatchObject({ status: 'skipped', reason: 'missed_schedule' });
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
        ownerGroupId: defaultGroupId,
        repository: 'acme/widget',
        branch: 'main',
        model: 'anthropic/claude-sonnet',
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
      },
    });

    const listResponse = await app.request('/automations');
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { automations: Array<{ id: string }> };
    expect(listBody.automations.map((automation) => automation.id)).toContain(createBody.automation.id);

    const updateResponse = await app.request(
      `/automations/${createBody.automation.id}`,
      jsonRequest({ name: 'Updated API automation', repository: '', branch: '', model: '' }, 'PATCH'),
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
    const invocationsBody = (await invocationsResponse.json()) as { invocations: Array<{ id: string }> };
    expect(invocationsBody.invocations.map((invocation) => invocation.id)).toContain(invokeBody.invocation.id);
  });
});

function jsonRequest(body: Record<string, unknown>, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
