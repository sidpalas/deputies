import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createSandboxBridgeServer } from '../src/server.js';

describe('sandbox bridge server', () => {
  let workspacePath: string;
  let server: Server;
  let baseUrl: string;
  const token = 'test-token';

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'deputies-sandbox-bridge-test-'));
    server = createSandboxBridgeServer({ workspacePath, token, maxOutputBytes: 128 * 1024 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('Expected server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        error ? reject(error) : resolve();
      });
    });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('requires bearer auth', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(401);
  });

  it('reports health', async () => {
    const response = await bridgeFetch('/health');

    await expect(response.json()).resolves.toMatchObject({ status: 'ready', workspacePath });
  });

  it('round trips filesystem operations and rejects path escapes', async () => {
    await expect(
      bridgeFetch('/fs/mkdir', { method: 'POST', body: JSON.stringify({ path: 'nested', recursive: true }) }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      bridgeFetch('/fs/write?path=nested/file.txt', { method: 'PUT', body: 'hello' }),
    ).resolves.toMatchObject({ status: 200 });

    const read = await bridgeFetch('/fs/read?path=nested/file.txt');
    await expect(read.text()).resolves.toBe('hello');
    await expect((await bridgeFetch('/fs/readdir?path=nested')).json()).resolves.toEqual({ entries: ['file.txt'] });
    await expect((await bridgeFetch('/fs/exists?path=nested/file.txt')).json()).resolves.toEqual({ exists: true });

    const escaped = await bridgeFetch('/fs/read?path=/tmp/outside.txt');
    expect(escaped.status).toBe(400);

    await expect(
      bridgeFetch('/fs/rm', { method: 'POST', body: JSON.stringify({ path: 'nested', recursive: true, force: true }) }),
    ).resolves.toMatchObject({ status: 200 });
    await expect((await bridgeFetch('/fs/exists?path=nested/file.txt')).json()).resolves.toEqual({ exists: false });
  });

  it('executes commands with cwd, env, stdin, and non-zero exit codes', async () => {
    await bridgeFetch('/fs/write?path=input.txt', { method: 'PUT', body: 'from-file' });

    const response = await bridgeFetch('/exec', {
      method: 'POST',
      body: JSON.stringify({
        command: 'read value && printf "$GREETING:$value:$(cat input.txt)" && exit 7',
        cwd: workspacePath,
        env: { GREETING: 'hello' },
        stdin: 'from-stdin\n',
      }),
    });

    await expect(response.json()).resolves.toMatchObject({
      exitCode: 7,
      stdout: 'hello:from-stdin:from-file',
      stderr: '',
    });
  });

  it('does not expose the bridge token to commands', async () => {
    process.env.DEPUTIES_SANDBOX_TOKEN = 'parent-token';

    const response = await bridgeFetch('/exec', {
      method: 'POST',
      body: JSON.stringify({ command: 'printf "${DEPUTIES_SANDBOX_TOKEN:-missing}"' }),
    });

    await expect(response.json()).resolves.toMatchObject({ stdout: 'missing' });
    delete process.env.DEPUTIES_SANDBOX_TOKEN;
  });

  it('times out commands using milliseconds', async () => {
    const response = await bridgeFetch('/exec', {
      method: 'POST',
      body: JSON.stringify({ command: 'sleep 5', timeoutMs: 50 }),
    });

    await expect(response.json()).resolves.toMatchObject({
      exitCode: 143,
      stderr: '[sandbox bridge] Command timed out after 50ms.',
    });
  });

  it('returns after a shell starts a background process', async () => {
    const response = await bridgeFetch('/exec', {
      method: 'POST',
      body: JSON.stringify({
        command: 'node -e "setInterval(() => {}, 1000)" & echo $! > background.pid && printf started',
        timeoutMs: 1000,
      }),
    });

    await expect(response.json()).resolves.toMatchObject({ exitCode: 0, stdout: 'started' });

    const pidResponse = await bridgeFetch('/fs/read?path=background.pid');
    const pid = Number((await pidResponse.text()).trim());
    if (Number.isInteger(pid)) process.kill(pid, 'SIGTERM');
  });

  it('drains command output after process exit', async () => {
    const output = 'x'.repeat(16 * 1024);
    const response = await bridgeFetch('/exec', {
      method: 'POST',
      body: JSON.stringify({ command: `node -e "process.stdout.write('${output}')"` }),
    });

    await expect(response.json()).resolves.toMatchObject({ exitCode: 0, stdout: output });
  });

  it('proxies preview traffic to localhost and strips platform auth cookies', async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          url: request.url,
          host: request.headers.host ?? null,
          forwardedHost: request.headers['x-forwarded-host'] ?? null,
          originalHost: request.headers['x-original-host'] ?? null,
          deputiesPreviewHost: request.headers['x-deputies-preview-host'] ?? null,
          authorization: request.headers.authorization ?? null,
          daytonaToken: request.headers['x-daytona-preview-token'] ?? null,
          cookie: request.headers.cookie ?? null,
        }),
      );
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (typeof address !== 'object' || !address) throw new Error('Expected upstream address');

    try {
      const response = await bridgeFetch(`/preview/${address.port}/nested/path?x=1`, {
        headers: {
          cookie: 'deputies_preview=platform; dev_deputies_session=session; app_session=ok',
          'x-daytona-preview-token': 'daytona-token',
          'x-forwarded-host': '3584-sandbox.daytonaproxy01.net',
          'x-original-host': '3584-sandbox.daytonaproxy01.net',
          'x-deputies-preview-host': 's-3000-session-1.deputies.localhost',
        },
      });

      await expect(response.json()).resolves.toEqual({
        url: '/nested/path?x=1',
        host: 's-3000-session-1.deputies.localhost',
        forwardedHost: 's-3000-session-1.deputies.localhost',
        originalHost: 's-3000-session-1.deputies.localhost',
        deputiesPreviewHost: null,
        authorization: null,
        daytonaToken: null,
        cookie: 'app_session=ok',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('does not trust forwarded hosts without a private Deputies preview host', async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ host: request.headers.host ?? null }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (typeof address !== 'object' || !address) throw new Error('Expected upstream address');

    try {
      const response = await bridgeFetch(`/preview/${address.port}/`, {
        headers: { 'x-forwarded-host': 's-3000-session-1.deputies.localhost' },
      });

      await expect(response.json()).resolves.toEqual({ host: `127.0.0.1:${address.port}` });
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('proxies preview POST bodies to localhost with content length', async () => {
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          method: request.method,
          url: request.url,
          contentLength: request.headers['content-length'] ?? null,
          contentType: request.headers['content-type'] ?? null,
          transferEncoding: request.headers['transfer-encoding'] ?? null,
          body: Buffer.concat(chunks).toString('utf-8'),
        }),
      );
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (typeof address !== 'object' || !address) throw new Error('Expected upstream address');

    try {
      const response = await bridgeFetch(`/preview/${address.port}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=dev&password=password',
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        method: 'POST',
        url: '/login',
        contentLength: '30',
        contentType: 'application/x-www-form-urlencoded',
        transferEncoding: null,
        body: 'username=dev&password=password',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('passes preview redirects back to the browser', async () => {
    const upstream = createServer((request, response) => {
      if (request.url === '/login') {
        response.writeHead(302, { location: '/', 'set-cookie': 'app_session=ok; Path=/; HttpOnly; SameSite=Lax' });
        response.end();
        return;
      }

      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('home');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (typeof address !== 'object' || !address) throw new Error('Expected upstream address');

    try {
      const response = await bridgeFetch(`/preview/${address.port}/login`, {
        method: 'POST',
        redirect: 'manual',
      });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/');
      expect(response.headers.get('set-cookie')).toContain('app_session=ok');
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('does not forward platform-only preview cookies', async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? null }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (typeof address !== 'object' || !address) throw new Error('Expected upstream address');

    try {
      const response = await bridgeFetch(`/preview/${address.port}/`, {
        headers: { cookie: 'deputies_preview=platform; dev_deputies_session=session' },
      });

      await expect(response.json()).resolves.toEqual({ cookie: null });
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('preserves response encoding metadata when upstream ignores identity requests', async () => {
    const body = gzipSync('compressed ok');
    const upstream = createServer((request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': String(body.byteLength),
        'content-type': 'text/plain',
        'x-accept-encoding': request.headers['accept-encoding'] ?? 'missing',
      });
      response.end(body);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (typeof address !== 'object' || !address) throw new Error('Expected upstream address');

    try {
      const response = await bridgeFetch(`/preview/${address.port}/asset.js`, {
        headers: { 'accept-encoding': 'gzip, br' },
      });

      expect(response.headers.get('content-encoding')).toBe('gzip');
      expect(response.headers.get('content-length')).toBeNull();
      expect(response.headers.get('x-accept-encoding')).toBe('identity');
      await expect(response.text()).resolves.toBe('compressed ok');
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('proxies preview websocket upgrades to localhost', async () => {
    const upstream = createServer();
    upstream.on('upgrade', (request, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Upstream-Path: ' +
          request.url +
          '\r\n\r\n',
      );
      socket.end();
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (typeof address !== 'object' || !address) throw new Error('Expected upstream address');

    try {
      await expect(rawUpgrade(`/preview/${address.port}/socket?x=1`)).resolves.toContain(
        'X-Upstream-Path: /socket?x=1',
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('preserves preview websocket origins for forwarded service hosts', async () => {
    const upstream = createServer();
    upstream.on('upgrade', (request, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          `X-Upstream-Host: ${request.headers.host}\r\n` +
          `X-Upstream-Origin: ${request.headers.origin}\r\n` +
          `X-Upstream-Forwarded-Host: ${request.headers['x-forwarded-host']}\r\n` +
          '\r\n',
      );
      socket.end();
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (typeof address !== 'object' || !address) throw new Error('Expected upstream address');

    try {
      await expect(
        rawUpgrade(`/preview/${address.port}/stable-abc?reconnection=false`, {
          origin: 'https://s-8080-session-1.deputies.localhost',
          forwardedHost: '3584-sandbox.daytonaproxy01.net',
          deputiesPreviewHost: 's-8080-session-1.deputies.localhost',
        }),
      ).resolves.toContain('X-Upstream-Origin: https://s-8080-session-1.deputies.localhost');
      await expect(
        rawUpgrade(`/preview/${address.port}/stable-abc?reconnection=false`, {
          origin: 'https://s-8080-session-1.deputies.localhost',
          forwardedHost: '3584-sandbox.daytonaproxy01.net',
          deputiesPreviewHost: 's-8080-session-1.deputies.localhost',
        }),
      ).resolves.toContain('X-Upstream-Host: s-8080-session-1.deputies.localhost');
      await expect(
        rawUpgrade(`/preview/${address.port}/stable-abc?reconnection=false`, {
          origin: 'https://s-8080-session-1.deputies.localhost',
          forwardedHost: '3584-sandbox.daytonaproxy01.net',
          deputiesPreviewHost: 's-8080-session-1.deputies.localhost',
        }),
      ).resolves.toContain('X-Upstream-Forwarded-Host: s-8080-session-1.deputies.localhost');
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  function bridgeFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
  }

  function rawUpgrade(
    path: string,
    headers: { origin?: string; forwardedHost?: string; deputiesPreviewHost?: string } = {},
  ): Promise<string> {
    const url = new URL(baseUrl);
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: url.hostname, port: Number(url.port) });
      let response = '';
      socket.setEncoding('utf-8');
      socket.once('connect', () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\n` +
            `Host: ${url.host}\r\n` +
            `Authorization: Bearer ${token}\r\n` +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            (headers.origin ? `Origin: ${headers.origin}\r\n` : '') +
            (headers.forwardedHost ? `X-Forwarded-Host: ${headers.forwardedHost}\r\n` : '') +
            (headers.forwardedHost ? `X-Original-Host: ${headers.forwardedHost}\r\n` : '') +
            (headers.deputiesPreviewHost ? `X-Deputies-Preview-Host: ${headers.deputiesPreviewHost}\r\n` : '') +
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
});
