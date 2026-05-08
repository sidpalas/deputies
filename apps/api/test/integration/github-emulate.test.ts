import { generateKeyPairSync } from 'node:crypto';
import { createEmulator } from 'emulate';
import { GitHubClient } from '../../src/integrations/github/client.js';
import { GitHubRepositoryAccessService } from '../../src/integrations/github/repository-access.js';

// Disabled while published emulate@0.5.0 rejects valid GitHub App JWTs when
// minting installation tokens. See https://github.com/vercel-labs/emulate/issues/96
describe.skip('GitHub emulate', () => {
  it('mints GitHub App installation access for an emulated repository', async () => {
    const privateKey = testPrivateKey();
    const github = await createEmulator({
      service: 'github',
      port: 4104,
      seed: {
        github: {
          orgs: [{ login: 'manaflow-ai' }],
          repos: [{ owner: 'manaflow-ai', name: 'manaflow', private: true }],
          apps: [
            {
              app_id: 12345,
              slug: 'deputies',
              name: 'Deputies',
              private_key: privateKey,
              permissions: { contents: 'read', issues: 'write', pull_requests: 'write' },
              events: ['issues', 'issue_comment', 'pull_request'],
              installations: [
                {
                  installation_id: 9001,
                  account: 'manaflow-ai',
                  repository_selection: 'selected',
                  repositories: ['manaflow-ai/manaflow'],
                },
              ],
            },
          ],
        },
      },
    });

    try {
      const service = new GitHubRepositoryAccessService({
        appId: '12345',
        privateKey,
        client: new GitHubClient({ apiBaseUrl: github.url }),
        cloneBaseUrl: `${github.url}/git`,
        allowedRepositories: ['manaflow-ai/*'],
      });

      const access = await service.getRepositoryAccess({ owner: 'manaflow-ai', repo: 'manaflow' });

      expect(access).toMatchObject({
        provider: 'github',
        owner: 'manaflow-ai',
        repo: 'manaflow',
        cloneUrl: `${github.url}/git/manaflow-ai/manaflow.git`,
        auth: { type: 'bearer' },
      });
      expect(access.auth.token).toMatch(/^ghs_/);
      expect(access.expiresAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await github.close();
    }
  });
});

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}
