import { createServices } from '../../src/app/server.js';
import { enqueueIntegrationIngress, getOrCreateExternalThreadSession } from '../../src/integrations/shared-utils.js';
import { boundPromptText } from '../../src/integrations/prompt-bounds.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { AppStore, ExternalThreadRecord } from '../../src/store/types.js';
import { defaultGroupId } from '../../src/store/types.js';

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

    const first = await enqueueIntegrationIngress(store, services.skills, services.sessions, services.messages, {
      source: 'github',
      thread: { source: 'github', externalId: 'acme/widget#42', metadata: { owner: 'acme', repo: 'widget' } },
      title: 'GitHub Issue #42',
      prompt: 'please fix this',
      sessionTags: ['github'],
      dedupeKey: 'delivery-1',
      actor: { type: 'user', externalId: 'octocat', displayName: 'Octo Cat' },
      repository: { provider: 'github', owner: 'acme', repo: 'widget' },
      callback: { type: 'github', owner: 'acme', repo: 'widget', issueNumber: 42 },
      sourceContext: { github: { number: 42 } },
    });
    const followUp = await enqueueIntegrationIngress(store, services.skills, services.sessions, services.messages, {
      source: 'github',
      thread: { source: 'github', externalId: 'acme/widget#42', metadata: { owner: 'acme', repo: 'widget' } },
      title: 'ignored because the thread already exists',
      prompt: 'follow up',
    });

    expect(followUp.session.id).toBe(first.session.id);
    expect(first.session.tags).toEqual(['github']);
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
      enqueueIntegrationIngress(store, services.skills, services.sessions, services.messages, {
        source: 'github',
        thread: { source: 'slack', externalId: 'thread-1', metadata: {} },
        title: 'Mismatched source',
        prompt: 'do work',
      }),
    ).rejects.toThrow('Integration thread source must match message source');
  });

  it('converts an exact leading managed group skill token through the shared funnel', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    await services.skills.create({
      name: 'review-code',
      description: 'Review the code',
      body: 'Review carefully.',
      ownerGroupId: defaultGroupId,
    });

    const result = await enqueueIntegrationIngress(store, services.skills, services.sessions, services.messages, {
      source: 'generic',
      thread: { source: 'generic', externalId: 'thread-skill', metadata: {} },
      title: 'Skill invocation',
      prompt: 'Prefix\n/ review placeholder\nCurrent: /review-code inspect this',
      currentMessageText: '/review-code inspect this',
      renderPrompt: (currentMessageText) => `Prefix\n/ review placeholder\nCurrent: ${currentMessageText}`,
      context: {
        skills: ['spoofed-skill'],
        skillRefs: [{ id: 'spoofed-skill-id', name: 'review-code' }],
      },
    });

    expect(result.message.prompt).toBe('Prefix\n/ review placeholder\nCurrent: inspect this');
    expect(result.message.context?.skills).toEqual(['review-code']);
    expect(result.message.context?.skillRefs).toEqual([
      expect.objectContaining({ name: 'review-code', revisionId: expect.any(String) }),
    ]);
    expect(result.message.context?.skillProvenance).toEqual([{ name: 'review-code', source: 'group' }]);
  });

  it('strips a validated skill token without restoring text removed by prompt bounds', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    await services.skills.create({
      name: 'review-code',
      description: 'Review the code',
      body: 'Review carefully.',
      ownerGroupId: defaultGroupId,
    });
    const rawMessageText = `/review-code ${'x'.repeat(9_000)}`;
    const rendered = `Current tagged message:\n${boundPromptText(rawMessageText)}`;

    const result = await enqueueIntegrationIngress(store, services.skills, services.sessions, services.messages, {
      source: 'generic',
      thread: { source: 'generic', externalId: 'thread-bounded-skill', metadata: {} },
      title: 'Bounded skill invocation',
      prompt: rendered,
      currentMessageText: rawMessageText,
      renderPrompt: (currentMessageText) => `Current tagged message:\n${boundPromptText(currentMessageText)}`,
    });

    expect(result.message.prompt).toBe(`Current tagged message:\n${boundPromptText('x'.repeat(9_000))}`);
    expect(result.message.prompt.length).toBeLessThanOrEqual(rendered.length);
    expect(result.message.context?.skills).toEqual(['review-code']);
  });

  it.each([
    ['a typo', '/review-cod inspect this', undefined],
    ['a case mismatch', '/Review-code inspect this', undefined],
    ['skills disabled', '/review-code inspect this', false],
  ])('passes through %s', async (_label, rawMessageText, skillsEnabled) => {
    const store = new MemoryStore();
    const services = createServices(store);
    await services.skills.create({
      name: 'review-code',
      description: 'Review the code',
      body: 'Review carefully.',
      ownerGroupId: defaultGroupId,
    });

    const result = await enqueueIntegrationIngress(store, services.skills, services.sessions, services.messages, {
      source: 'generic',
      thread: { source: 'generic', externalId: `thread-${_label}`, metadata: {} },
      title: 'No invocation',
      prompt: rawMessageText,
      currentMessageText: rawMessageText,
      renderPrompt: (currentMessageText) => currentMessageText,
      ...(skillsEnabled !== undefined ? { skillsEnabled } : {}),
    });

    expect(result.message.prompt).toBe(rawMessageText);
    expect(result.message.context).not.toHaveProperty('skills');
  });

  it('does not invoke personal, archived, or disabled skills from integrations', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const now = new Date();
    await store.upsertAuthUserForAccount({
      userId: 'user-1',
      accountId: 'user-1-account',
      provider: 'test',
      providerAccountId: 'user-1',
      username: 'user-1',
      role: 'user',
      profile: {},
      now,
    });
    await services.skills.create({
      name: 'personal-only',
      description: 'Personal',
      body: 'Private.',
      ownerUserId: 'user-1',
    });
    const archived = await services.skills.create({
      name: 'archived-skill',
      description: 'Archived',
      body: 'Old.',
      ownerGroupId: defaultGroupId,
    });
    await services.skills.archive(archived.id);
    await services.skills.create({
      name: 'disabled-skill',
      description: 'Disabled',
      body: 'Off.',
      ownerGroupId: defaultGroupId,
      autoLoad: false,
    });
    const disabled = (await store.listSkillsForGroups([defaultGroupId])).find(
      (skill) => skill.name === 'disabled-skill',
    )!;
    await services.skills.update({ id: disabled.id, enabled: false });

    for (const name of ['personal-only', 'archived-skill', 'disabled-skill']) {
      const result = await enqueueIntegrationIngress(store, services.skills, services.sessions, services.messages, {
        source: 'generic',
        thread: { source: 'generic', externalId: `thread-${name}`, metadata: {} },
        title: 'No invocation',
        prompt: `/${name} keep this`,
        currentMessageText: `/${name} keep this`,
        renderPrompt: (currentMessageText) => currentMessageText,
      });
      expect(result.message.prompt).toBe(`/${name} keep this`);
      expect(result.message.context).not.toHaveProperty('skills');
    }
  });

  it('resolves repository skills from the latest session discovery event', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const first = await enqueueIntegrationIngress(store, services.skills, services.sessions, services.messages, {
      source: 'generic',
      thread: { source: 'generic', externalId: 'thread-repo-skill', metadata: {} },
      title: 'Repository skill invocation',
      prompt: 'initial message',
    });
    await services.events.append({
      sessionId: first.session.id,
      type: 'skills_loaded',
      payload: {
        skills: [{ name: 'repo-only', source: 'repo', repo: 'acme/widget', advertised: false }],
        shadowed: [],
        diagnostics: [],
      },
    });

    const followUp = await enqueueIntegrationIngress(store, services.skills, services.sessions, services.messages, {
      source: 'generic',
      thread: { source: 'generic', externalId: 'thread-repo-skill', metadata: {} },
      title: 'Ignored existing title',
      prompt: '/repo-only inspect this',
      currentMessageText: '/repo-only inspect this',
      renderPrompt: (currentMessageText) => currentMessageText,
    });

    expect(followUp.message.prompt).toBe('inspect this');
    expect(followUp.message.context).toMatchObject({
      skills: ['repo-only'],
      skillRefs: [{ id: 'repo:acme/widget:repo-only', name: 'repo-only' }],
      skillProvenance: [{ name: 'repo-only', source: 'repo' }],
    });
  });
});
