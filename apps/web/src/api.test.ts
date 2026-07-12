import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutomation, updateAutomation } from './api.js';

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
