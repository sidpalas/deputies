import type { Server } from 'node:http';
import { createEmulator } from 'emulate';
import { createServer, createServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';

const githubEmulatorPort = 4114;
const githubEmulatorUrl = `http://127.0.0.1:${githubEmulatorPort}`;

describe('GitHub OAuth emulate UAT', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer(loadConfig({
      API_AUTH_MODE: 'session',
      AUTH_PROVIDER: 'github',
      AUTH_SESSION_SECRET: 'test-session-secret',
      GITHUB_APP_CLIENT_ID: 'deputies-github-app-client',
      GITHUB_APP_CLIENT_SECRET: 'deputies-github-app-secret',
      GITHUB_OAUTH_BASE_URL: githubEmulatorUrl,
      AUTH_GITHUB_ALLOWED_USERS: 'octocat',
      GITHUB_API_BASE_URL: githubEmulatorUrl,
    }), createServices());
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('signs in through the emulated GitHub OAuth flow', async () => {
    const github = await createEmulator({
      service: 'github',
      port: githubEmulatorPort,
      seed: {
        github: {
          users: [{ login: 'octocat', name: 'The Octocat', email: 'octocat@example.test' }],
          oauth_apps: [
            {
              client_id: 'deputies-github-app-client',
              client_secret: 'deputies-github-app-secret',
              name: 'Deputies',
              redirect_uris: [`${baseUrl}/auth/oauth/github/callback`],
            },
          ],
        },
      },
    });

    try {
      const start = await fetch(`${baseUrl}/auth/oauth/github/start`, { redirect: 'manual' });
      expect(start.status).toBe(302);

      const authorizeLocation = start.headers.get('location');
      expect(authorizeLocation).toBeTruthy();
      const authorizeUrl = new URL(authorizeLocation!);
      expect(authorizeUrl.origin).toBe(githubEmulatorUrl);
      expect(authorizeUrl.pathname).toBe('/login/oauth/authorize');

      const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
      expect(authorize.status).toBe(200);
      await expect(authorize.text()).resolves.toContain('The Octocat');

      const githubCallback = await fetch(`${github.url}/login/oauth/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body: new URLSearchParams({
          login: 'octocat',
          client_id: authorizeUrl.searchParams.get('client_id') ?? '',
          redirect_uri: authorizeUrl.searchParams.get('redirect_uri') ?? '',
          scope: authorizeUrl.searchParams.get('scope') ?? '',
          state: authorizeUrl.searchParams.get('state') ?? '',
        }),
      });
      expect(githubCallback.status).toBe(302);

      const appCallbackLocation = githubCallback.headers.get('location');
      expect(appCallbackLocation).toContain(`${baseUrl}/auth/oauth/github/callback`);

      const appCallback = await fetch(appCallbackLocation!, { redirect: 'manual' });
      expect(appCallback.status).toBe(302);
      const sessionCookie = appCallback.headers.get('set-cookie');
      expect(sessionCookie).toContain('dev_deputies_session=');

      const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie: sessionCookie! } });
      expect(me.status).toBe(200);
      await expect(me.json()).resolves.toMatchObject({
        user: { username: 'octocat', displayName: 'The Octocat' },
      });

      const createSession = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookie! },
        body: JSON.stringify({ title: 'OAuth UAT' }),
      });
      expect(createSession.status).toBe(201);
      await expect(createSession.json()).resolves.toMatchObject({ session: { title: 'OAuth UAT' } });
    } finally {
      await github.close();
    }
  });
});

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
