import { createServices } from '../../src/app/server.js';
import { enqueueIntegrationIngress, getOrCreateExternalThreadSession } from '../../src/integrations/shared-utils.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { AppStore, ExternalThreadRecord } from '../../src/store/types.js';

describe('integration shared utils', () => {
  it('uses the session from the winning external-thread row after a concurrent create', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const winningSession = await services.sessions.create({ title: 'winner' });
    const now = new Date('2026-05-07T00:00:00.000Z');
    const winningThread: ExternalThreadRecord = {
      id: 'thread-1',
      source: 'github',
      externalId: 'acme/widget#42',
      sessionId: winningSession.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    const racingStore = {
      ...store,
      getExternalThread: async () => null,
      createExternalThread: async () => winningThread,
    } as unknown as AppStore;

    const session = await getOrCreateExternalThreadSession(racingStore, services.sessions, {
      source: 'github',
      externalId: 'acme/widget#42',
      metadata: {},
      title: 'loser',
    });

    expect(session.id).toBe(winningSession.id);
    expect(await store.listSessions()).toHaveLength(2);
  });

  it('enqueues first-party integration ingress through one product handoff shape', async () => {
    const store = new MemoryStore();
    const services = createServices(store);

    const first = await enqueueIntegrationIngress(store, services.sessions, services.messages, {
      source: 'github',
      thread: { source: 'github', externalId: 'acme/widget#42', metadata: { owner: 'acme', repo: 'widget' } },
      title: 'GitHub Issue #42',
      prompt: 'please fix this',
      dedupeKey: 'delivery-1',
      actor: { type: 'user', externalId: 'octocat', displayName: 'Octo Cat' },
      repository: { provider: 'github', owner: 'acme', repo: 'widget' },
      callback: { type: 'github', owner: 'acme', repo: 'widget', issueNumber: 42 },
      sourceContext: { github: { number: 42 } },
    });
    const followUp = await enqueueIntegrationIngress(store, services.sessions, services.messages, {
      source: 'github',
      thread: { source: 'github', externalId: 'acme/widget#42', metadata: { owner: 'acme', repo: 'widget' } },
      title: 'ignored because the thread already exists',
      prompt: 'follow up',
    });

    expect(followUp.session.id).toBe(first.session.id);
    expect(first.message.context).toMatchObject({
      source: 'github',
      integration: {
        source: 'github',
        thread: { source: 'github', externalId: 'acme/widget#42' },
        dedupeKey: 'delivery-1',
        actor: { type: 'user', externalId: 'octocat', displayName: 'Octo Cat' },
      },
      repository: { provider: 'github', owner: 'acme', repo: 'widget' },
      callback: { type: 'github', owner: 'acme', repo: 'widget', issueNumber: 42 },
      github: { number: 42 },
    });
  });

  it('rejects integration ingress with mismatched message and thread sources', async () => {
    const store = new MemoryStore();
    const services = createServices(store);

    await expect(
      enqueueIntegrationIngress(store, services.sessions, services.messages, {
        source: 'github',
        thread: { source: 'slack', externalId: 'thread-1', metadata: {} },
        title: 'Mismatched source',
        prompt: 'do work',
      }),
    ).rejects.toThrow('Integration thread source must match message source');
  });
});
