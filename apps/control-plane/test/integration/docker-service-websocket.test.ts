import { once } from 'node:events';
import { createServer as createHttpServer, type Server } from 'node:http';
import net from 'node:net';
import { createSandboxBridgeServer } from '../../../../packages/sandbox-bridge/src/server.js';
import { createServer, createServices } from '../../src/app/server.js';
import { createPreviewAuthToken } from '../../src/app/service-proxy.js';
import { loadConfig } from '../../src/config/index.js';
import {
  DockerSandboxProvider,
  type DockerOrchestrator,
  type DockerSandboxDescriptor,
} from '../../src/sandbox/docker.js';
import type { FileStat, SandboxExecResult, SandboxHealth } from '../../src/sandbox/types.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('Docker service WebSocket proxy integration', () => {
  const bridgeToken = 'bridge-token';
  let bridge: Server;
  let controlPlane: Server;
  let upstream: Server;
  let bridgeUrl: string;
  let controlPlaneUrl: string;

  afterEach(async () => {
    await Promise.all([closeServer(controlPlane), closeServer(bridge), closeServer(upstream)]);
  });

  it('proxies absolute WebSocket paths under wildcard service hosts through the Docker bridge', async () => {
    upstream = createHttpServer();
    upstream.on('upgrade', (request, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          `X-Upstream-Origin: ${request.headers.origin}\r\n` +
          `X-Upstream-Path: ${request.url}\r\n` +
          `X-Upstream-Host: ${request.headers.host}\r\n` +
          '\r\n',
      );
      socket.end();
    });
    const upstreamUrl = await listen(upstream);
    const upstreamPort = Number(new URL(upstreamUrl).port);

    bridge = createSandboxBridgeServer({ workspacePath: process.cwd(), token: bridgeToken });
    bridgeUrl = await listen(bridge);

    const store = new MemoryStore();
    const provider = new DockerSandboxProvider({
      orchestrator: new BridgeDockerOrchestrator({ bridgeUrl, bridgeToken }),
    });
    const config = loadConfig({
      API_AUTH_MODE: 'session',
      AUTH_STATIC_USERNAME: 'dev',
      AUTH_STATIC_PASSWORD: 'password',
      AUTH_SESSION_SECRET: 'test-secret',
      SERVICE_BASE_DOMAIN: 'deputies.localhost',
      SERVICE_TRUST_FORWARDED_HOSTS: 'true',
      WEB_BASE_URL: 'https://deputies.localhost',
    });
    controlPlane = createServer(config, createServices(store, { sandboxProvider: provider }));
    controlPlaneUrl = await listen(controlPlane);

    const login = await fetch(`${controlPlaneUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dev', password: 'password' }),
    });
    const loginBody = (await login.json()) as { user: { id: string } };
    const authCookie = cookiePair(login.headers.get('set-cookie'));

    const createSession = await fetch(`${controlPlaneUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authCookie },
      body: JSON.stringify({ title: 'Docker WebSocket service' }),
    });
    const { session } = (await createSession.json()) as { session: { id: string } };
    const sandbox = await provider.create({ sessionId: session.id });
    const now = new Date();
    await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000701',
      sessionId: session.id,
      provider: provider.name,
      providerSandboxId: sandbox.providerSandboxId,
      status: 'ready',
      workspacePath: '/workspace',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });

    const serviceHost = `s-${upstreamPort}-${session.id}.deputies.localhost`;
    const previewToken = createPreviewAuthToken(config, {
      authSessionId: cookieValue(authCookie),
      previewSessionId: session.id,
      port: upstreamPort,
      userId: loginBody.user.id,
    });
    const previewAuth = await fetch(
      `${controlPlaneUrl}/__preview_auth?token=${encodeURIComponent(previewToken)}&redirect=/`,
      {
        headers: { cookie: authCookie, 'x-forwarded-host': serviceHost, 'x-forwarded-proto': 'https' },
        redirect: 'manual',
      },
    );
    const previewCookie = cookiePair(previewAuth.headers.get('set-cookie'));
    const cookie = `${authCookie}; ${previewCookie}`;
    const directResponse = await rawUpgrade(controlPlaneUrl, {
      host: serviceHost,
      cookie,
      origin: `https://${serviceHost}`,
      path: '/stable-code-server?reconnection=false',
    });
    const forwardedResponse = await rawUpgrade(controlPlaneUrl, {
      forwardedHost: serviceHost,
      cookie,
      origin: `https://${serviceHost}`,
      path: '/stable-code-server?reconnection=false',
    });

    for (const response of [directResponse, forwardedResponse]) {
      expect(response).toContain('HTTP/1.1 101 Switching Protocols');
      expect(response).toContain(`X-Upstream-Origin: https://${serviceHost}`);
      expect(response).toContain('X-Upstream-Path: /stable-code-server?reconnection=false');
      expect(response).toContain(`X-Upstream-Host: 127.0.0.1:${upstreamPort}`);
    }
  });
});

class BridgeDockerOrchestrator implements DockerOrchestrator {
  private readonly sandboxes = new Map<string, DockerSandboxDescriptor>();

  constructor(private readonly options: { bridgeUrl: string; bridgeToken: string }) {}

  async create(input: { sessionId: string; metadata?: Record<string, unknown> }): Promise<DockerSandboxDescriptor> {
    const descriptor: DockerSandboxDescriptor = {
      providerSandboxId: `docker-${input.sessionId}`,
      sessionId: input.sessionId,
      workspacePath: '/workspace',
      bridgeUrl: this.options.bridgeUrl,
      bridgeToken: this.options.bridgeToken,
      metadata: input.metadata ?? {},
    };
    this.sandboxes.set(descriptor.providerSandboxId, descriptor);
    return descriptor;
  }

  async connect(input: { providerSandboxId: string }): Promise<DockerSandboxDescriptor> {
    const descriptor = this.sandboxes.get(input.providerSandboxId);
    if (!descriptor) throw new Error('missing sandbox');
    return descriptor;
  }

  async health(input: { providerSandboxId: string }): Promise<SandboxHealth> {
    return {
      status: this.sandboxes.has(input.providerSandboxId) ? 'ready' : 'missing',
      checkedAt: new Date(),
    };
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async destroy(input: { providerSandboxId: string }): Promise<void> {
    this.sandboxes.delete(input.providerSandboxId);
  }

  async exec(): Promise<SandboxExecResult> {
    const now = new Date();
    return { exitCode: 0, stdout: '', stderr: '', startedAt: now, completedAt: now };
  }

  async readFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async writeFile(): Promise<void> {}

  async stat(): Promise<FileStat> {
    return { isFile: true, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date(0) };
  }

  async readdir(): Promise<string[]> {
    return [];
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async mkdir(): Promise<void> {}

  async rm(): Promise<void> {}

  async getPreviewUrl(input: { port: number }) {
    return {
      port: input.port,
      targetUrl: `${this.options.bridgeUrl}/preview/${input.port}`,
      targetHeaders: { authorization: `Bearer ${this.options.bridgeToken}` },
      forwardPreviewHost: true,
    };
  }
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://${address.address}:${address.port}`;
}

function rawUpgrade(
  baseUrl: string,
  input: { host?: string; forwardedHost?: string; cookie?: string; origin: string; path: string },
): Promise<string> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    let response = '';
    socket.setEncoding('utf-8');
    socket.once('connect', () => {
      socket.write(
        `GET ${input.path} HTTP/1.1\r\n` +
          `Host: ${input.host ?? url.host}\r\n` +
          (input.forwardedHost ? `X-Forwarded-Host: ${input.forwardedHost}\r\n` : '') +
          (input.forwardedHost ? 'X-Forwarded-Proto: https\r\n' : '') +
          (input.cookie ? `Cookie: ${input.cookie}\r\n` : '') +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          `Origin: ${input.origin}\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('end', () => resolve(response));
    socket.once('error', reject);
  });
}

function cookiePair(setCookie: string | null): string {
  const pair = setCookie?.split(';')[0];
  if (!pair) throw new Error('Expected set-cookie header');
  return pair;
}

function cookieValue(cookie: string): string {
  const value = cookie.split('=')[1];
  if (!value) throw new Error('Expected cookie value');
  return value;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
