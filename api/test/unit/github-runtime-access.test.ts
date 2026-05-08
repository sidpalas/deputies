import { generateKeyPairSync, verify } from 'node:crypto';
import { createGitHubAppJwt } from '../../src/integrations/github/auth.js';
import type { GitHubClient } from '../../src/integrations/github/client.js';
import { GitHubRepositoryAccessError, GitHubRepositoryAccessService } from '../../src/integrations/github/repository-access.js';

describe('GitHub App runtime access', () => {
  it('creates a signed GitHub App JWT', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const token = createGitHubAppJwt({ appId: '12345', privateKey: privatePem, now: new Date('2026-05-06T12:00:00.000Z') });
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) throw new Error('Expected JWT parts');

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ iss: '12345', iat: 1778068740, exp: 1778069340 });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('resolves and caches installation tokens for allowed repositories', async () => {
    const privateKey = testPrivateKey();
    const client = new FakeGitHubClient();
    const service = new GitHubRepositoryAccessService({
      appId: '12345',
      privateKey,
      client: client as unknown as GitHubClient,
      allowedRepositories: ['acme/*'],
      now: () => new Date('2026-05-06T12:00:00.000Z'),
    });

    const first = await service.getRepositoryAccess({ owner: 'acme', repo: 'widget' });
    const second = await service.getRepositoryAccess({ owner: 'acme', repo: 'widget' });

    expect(first).toMatchObject({ provider: 'github', owner: 'acme', repo: 'widget', cloneUrl: 'https://github.com/acme/widget.git', auth: { type: 'bearer', token: 'installation-token-1' } });
    expect(second.auth.token).toBe('installation-token-1');
    expect(client.installationLookups).toEqual(['acme/widget']);
    expect(client.tokenRequests).toEqual([{ installationId: 9001, repositories: ['widget'] }]);
  });

  it('scopes cached installation tokens to the selected repository', async () => {
    const client = new FakeGitHubClient();
    const service = new GitHubRepositoryAccessService({
      appId: '12345',
      privateKey: testPrivateKey(),
      client: client as unknown as GitHubClient,
      allowedRepositories: ['acme/*'],
      now: () => new Date('2026-05-06T12:00:00.000Z'),
    });

    const first = await service.getRepositoryAccess({ owner: 'acme', repo: 'widget' });
    const second = await service.getRepositoryAccess({ owner: 'acme', repo: 'api' });
    const third = await service.getRepositoryAccess({ owner: 'acme', repo: 'widget' });

    expect(first.auth.token).toBe('installation-token-1');
    expect(second.auth.token).toBe('installation-token-2');
    expect(third.auth.token).toBe('installation-token-1');
    expect(client.tokenRequests).toEqual([
      { installationId: 9001, repositories: ['widget'] },
      { installationId: 9001, repositories: ['api'] },
    ]);
  });

  it('uses a custom clone base URL when configured', async () => {
    const service = new GitHubRepositoryAccessService({
      appId: '12345',
      privateKey: testPrivateKey(),
      client: new FakeGitHubClient() as unknown as GitHubClient,
      cloneBaseUrl: 'https://github.example.test/',
    });

    await expect(service.getRepositoryAccess({ owner: 'acme', repo: 'widget' })).resolves.toMatchObject({
      cloneUrl: 'https://github.example.test/acme/widget.git',
    });
  });

  it('refreshes installation tokens near expiry', async () => {
    const client = new FakeGitHubClient();
    let now = new Date('2026-05-06T12:00:00.000Z');
    const service = new GitHubRepositoryAccessService({
      appId: '12345',
      privateKey: testPrivateKey(),
      client: client as unknown as GitHubClient,
      now: () => now,
    });

    await service.getRepositoryAccess({ owner: 'acme', repo: 'widget' });
    now = new Date('2026-05-06T12:59:30.000Z');
    const refreshed = await service.getRepositoryAccess({ owner: 'acme', repo: 'widget' });

    expect(refreshed.auth.token).toBe('installation-token-2');
    expect(client.installationLookups).toEqual(['acme/widget']);
    expect(client.tokenRequests).toEqual([
      { installationId: 9001, repositories: ['widget'] },
      { installationId: 9001, repositories: ['widget'] },
    ]);
  });

  it('rejects repositories outside the allowlist', async () => {
    const service = new GitHubRepositoryAccessService({
      appId: '12345',
      privateKey: testPrivateKey(),
      client: new FakeGitHubClient() as unknown as GitHubClient,
      allowedRepositories: ['acme/widget'],
    });

    await expect(service.getRepositoryAccess({ owner: 'other', repo: 'repo' })).rejects.toBeInstanceOf(GitHubRepositoryAccessError);
  });
});

class FakeGitHubClient {
  readonly installationLookups: string[] = [];
  readonly tokenRequests: Array<{ installationId: number; repositories?: string[] }> = [];

  async getRepositoryInstallation(input: { owner: string; repo: string; appJwt: string }): Promise<{ id: number }> {
    expect(input.appJwt.split('.')).toHaveLength(3);
    this.installationLookups.push(`${input.owner}/${input.repo}`);
    return { id: 9001 };
  }

  async createInstallationAccessToken(input: { installationId: number; appJwt: string; repositories?: string[] }): Promise<{ token: string; expiresAt: Date }> {
    expect(input.appJwt.split('.')).toHaveLength(3);
    this.tokenRequests.push({ installationId: input.installationId, ...(input.repositories ? { repositories: input.repositories } : {}) });
    return { token: `installation-token-${this.tokenRequests.length}`, expiresAt: new Date('2026-05-06T13:00:00.000Z') };
  }
}

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}
