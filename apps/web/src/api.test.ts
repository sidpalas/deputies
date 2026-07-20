import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAutomation,
  enqueueMessage,
  listEnvironmentRevisions,
  listSkillInvocationCandidates,
  listSkillRevisions,
  setSkillShares,
  updateAutomation,
  createSnippet,
  archiveSnippet,
  listSnippets,
  restoreSnippet,
  updateSnippet,
} from './api.js';

describe('automation API requests', () => {
  afterEach(() => vi.restoreAllMocks());

  it('omits direct-repository fields for an environment-backed automation', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ automation: { id: 'automation-1' } }), { status: 201 }));

    await createAutomation({
      token: 'test-token',
      name: 'Environment automation',
      prompt: 'Check the codebase',
      scheduleCron: '0 9 * * *',
      environmentId: 'environment-1',
      repository: 'acme/api',
      branch: 'main',
      reasoningLevel: 'max',
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      name: 'Environment automation',
      prompt: 'Check the codebase',
      scheduleCron: '0 9 * * *',
      environmentId: 'environment-1',
      reasoningLevel: 'max',
    });
  });

  it('can clear a saved automation reasoning level', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ automation: { id: 'automation-1' } }), { status: 200 }));

    await updateAutomation({ automationId: 'automation-1', token: 'test-token', reasoningLevel: '' });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({ reasoningLevel: '' });
  });

  it('keeps repository fields for a direct-repository automation', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ automation: { id: 'automation-1' } }), { status: 201 }));

    await createAutomation({
      token: 'test-token',
      name: 'Repository automation',
      prompt: 'Check the repository',
      scheduleCron: '0 9 * * *',
      repository: 'acme/api',
      branch: 'main',
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      name: 'Repository automation',
      prompt: 'Check the repository',
      scheduleCron: '0 9 * * *',
      repository: 'acme/api',
      branch: 'main',
    });
  });
});

describe('snippet API requests', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists personal snippets and creates name/body only', async () => {
    const snippet = { id: 'snippet-1', name: 'review', body: 'Review it' };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ snippets: [snippet] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ snippet }), { status: 201 }));
    await expect(listSnippets({ token: 'token' })).resolves.toEqual([snippet]);
    await createSnippet({ token: 'token', name: 'review', body: 'Review it' });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0]), window.location.href).pathname).toBe('/snippets');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({ name: 'review', body: 'Review it' });
  });

  it('updates, archives, and restores snippets with the expected paths and methods', async () => {
    const snippet = { id: 'snippet-1', name: 'review', body: 'Review it' };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ snippet }), { status: 200 }));
    await updateSnippet({ token: 'token', snippetId: snippet.id, body: 'Updated' });
    await archiveSnippet({ token: 'token', snippetId: snippet.id });
    await restoreSnippet({ token: 'token', snippetId: snippet.id });
    expect(
      fetchMock.mock.calls.map(([url, init]) => [
        new URL(String(url), window.location.href).pathname,
        init?.method,
        JSON.parse(init?.body as string),
      ]),
    ).toEqual([
      ['/snippets/snippet-1', 'PATCH', { body: 'Updated' }],
      ['/snippets/snippet-1/archive', 'POST', {}],
      ['/snippets/snippet-1/restore', 'POST', {}],
    ]);
  });
});

describe('environment API requests', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists immutable environment revisions', async () => {
    const revisions = [{ id: 'revision-2', environmentId: 'environment-1', revisionNumber: 2, repositories: [] }];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ revisions }), { status: 200 }));

    await expect(listEnvironmentRevisions({ environmentId: 'environment-1', token: 'test-token' })).resolves.toEqual(
      revisions,
    );
    expect(new URL(String(fetchMock.mock.calls[0]?.[0]), window.location.href).pathname).toBe(
      '/environments/environment-1/revisions',
    );
  });
});

describe('skill API requests', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends selected skills in per-message context', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ message: { id: 'message-1' } }), { status: 202 }));

    await enqueueMessage({
      sessionId: 'session-1',
      prompt: 'Review this change',
      skills: ['review-change', 'write-tests'],
      skillRefs: [
        { id: 'skill-review', name: 'review-change', revisionId: 'revision-review' },
        { id: 'repo:acme/widgets:write-tests', name: 'write-tests' },
      ],
      token: 'test-token',
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      prompt: 'Review this change',
      context: {
        skills: ['review-change', 'write-tests'],
        skillRefs: [
          { id: 'skill-review', name: 'review-change', revisionId: 'revision-review' },
          { id: 'repo:acme/widgets:write-tests', name: 'write-tests' },
        ],
      },
    });
  });

  it('lists revisions for a managed skill', async () => {
    const revisions = [{ id: 'revision-2', skillId: 'skill-1', revisionNumber: 2 }];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ revisions }), { status: 200 }));

    await expect(listSkillRevisions({ skillId: 'skill-1', token: 'test-token' })).resolves.toEqual(revisions);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0]), window.location.href).pathname).toBe(
      '/skills/skill-1/revisions',
    );
  });

  it('lists server-authorized invocation candidates for a session owner group', async () => {
    const skills = [{ id: 'skill-1', name: 'review-change' }];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ skills }), { status: 200 }));

    await expect(listSkillInvocationCandidates({ ownerGroupId: 'group-1', token: 'test-token' })).resolves.toEqual(
      skills,
    );
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), window.location.href);
    expect(url.pathname).toBe('/skills/invocation-candidates');
    expect(url.searchParams.get('ownerGroupId')).toBe('group-1');
  });

  it('only sends group ids for specific sharing', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ skill: { id: 'skill-1' } }), { status: 200 }));

    await setSkillShares({
      skillId: 'skill-1',
      shareMode: 'all_groups',
      groupIds: ['ignored'],
      token: 'test-token',
    });
    await setSkillShares({
      skillId: 'skill-1',
      shareMode: 'specific',
      groupIds: ['group-1'],
      token: 'test-token',
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ shareMode: 'all_groups' });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      shareMode: 'specific',
      groupIds: ['group-1'],
    });
  });
});
