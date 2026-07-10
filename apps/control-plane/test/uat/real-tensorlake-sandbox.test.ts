import { TensorlakeSandboxProvider } from '../../src/sandbox/tensorlake.js';
import net from 'node:net';
import tls from 'node:tls';
import type { SandboxHandle } from '../../src/sandbox/types.js';

const enabled = process.env.RUN_REAL_TENSORLAKE_SANDBOX_UAT === 'true';
const image = process.env.TENSORLAKE_REGISTERED_IMAGE;
const hasRequiredEnv = Boolean(process.env.TENSORLAKE_API_KEY && image);
const sessionId = 'real-tensorlake-sandbox-uat';
const previewServerCommand =
  "node -e \"const http=require('http');const app=http.createServer((req,res)=>{if(req.url==='/login'&&req.method==='POST'){res.writeHead(302,{location:'/session','set-cookie':'app_session=authenticated; Path=/; HttpOnly; SameSite=Lax'});res.end();return}if(req.url==='/session'){res.end(req.headers.cookie?.includes('app_session=authenticated')?'authenticated':'missing');return}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({host:req.headers.host||null,forwardedHost:req.headers['x-forwarded-host']||null,originalHost:req.headers['x-original-host']||null,authorization:req.headers.authorization||null,bridgeToken:req.headers['x-deputies-bridge-token']||null,cookie:req.headers.cookie||null}))});app.on('upgrade',(req,socket)=>{socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nX-Upstream-Host: '+(req.headers.host||'')+'\\r\\nX-Upstream-Authorization: '+(req.headers.authorization||'')+'\\r\\nX-Upstream-Bridge-Token: '+(req.headers['x-deputies-bridge-token']||'')+'\\r\\n\\r\\n');socket.end()});app.listen(4534,'0.0.0.0')\"";

describe.skipIf(!enabled || !hasRequiredEnv)('real Tensorlake sandbox UAT', () => {
  let provider: TensorlakeSandboxProvider;
  let sandbox: SandboxHandle | undefined;

  beforeEach(() => {
    const options = {
      apiKey: process.env.TENSORLAKE_API_KEY!,
      image: image!,
      workspacePath: '/workspace',
      idleTimeoutMs: 600_000,
      bridgeSkippedCookieNames: 'inner_deputies_preview,inner_deputies_session',
    };
    provider = new TensorlakeSandboxProvider(options);
  });

  afterEach(async () => {
    if (sandbox) await provider.destroy(sandbox).catch(() => undefined);
    sandbox = undefined;
  });

  it('executes commands, persists files, and serves isolated bridge previews', async () => {
    sandbox = await provider.create({ sessionId });

    await expect(
      sandbox.exec({ command: 'printf tensorlake-ok', cwd: sandbox.workspacePath, timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'tensorlake-ok' });

    await sandbox.fs?.writeFile('/workspace/smoke.txt', 'hello');
    await expect(sandbox.fs?.readFile('/workspace/smoke.txt')).resolves.toBe('hello');
    await sandbox.fs?.writeFile('relative-smoke.txt', 'relative hello');
    await expect(sandbox.fs?.readFile('/workspace/relative-smoke.txt')).resolves.toBe('relative hello');

    await provider.stop(sandbox);
    await expect(provider.health(sandbox)).resolves.toMatchObject({ status: 'stopped' });
    await provider.start(sandbox);
    sandbox = await provider.connect({ providerSandboxId: sandbox.providerSandboxId, sessionId });
    await expect(sandbox.fs?.readFile('relative-smoke.txt')).resolves.toBe('relative hello');

    if (!sandbox.startService) throw new Error('Expected Tensorlake managed process support');
    await expect(
      sandbox.startService({ command: previewServerCommand, cwd: sandbox.workspacePath, port: 4534 }),
    ).resolves.toMatchObject({ pid: expect.any(Number) });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(
      sandbox.exec({
        command:
          "node -e \"require('net').connect(4534,'127.0.0.1').once('connect',function(){this.end()}).once('error',()=>process.exit(1))\"",
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const endpointInput = {
      providerSandboxId: sandbox.providerSandboxId,
      sessionId,
      port: 4534,
    };
    if (sandbox.secrets) Object.assign(endpointInput, { secrets: sandbox.secrets });
    const preview = await provider.getServiceEndpoint?.(endpointInput);
    expect(preview).toMatchObject({ port: 4534 });
    if (!preview) throw new Error('Expected preview URL');

    await waitForPreview(preview.targetUrl, preview.targetHeaders);

    const previewHost = `s-4534-${sessionId}.deputies.example.test`;
    const previewHeaders = {
      ...preview.targetHeaders,
      'x-deputies-preview-host': previewHost,
      cookie: 'inner_deputies_preview=outer; inner_deputies_session=outer; app_session=ok',
    };
    const headers = await fetchPreviewJson(`${preview.targetUrl}/headers`, previewHeaders);
    expect(headers).toEqual({
      host: previewHost,
      forwardedHost: previewHost,
      originalHost: previewHost,
      authorization: null,
      bridgeToken: null,
      cookie: 'app_session=ok',
    });

    const login = await fetch(`${preview.targetUrl}/login`, {
      method: 'POST',
      headers: previewHeaders,
      redirect: 'manual',
    });
    expect(login.status).toBe(302);
    const sessionCookie = cookiePair(login.headers.get('set-cookie'));
    await expect(
      fetchPreview(`${preview.targetUrl}/session`, {
        ...previewHeaders,
        cookie: `inner_deputies_preview=outer; inner_deputies_session=outer; ${sessionCookie}`,
      }),
    ).resolves.toBe('authenticated');

    const upgrade = await rawUpgrade(preview.targetUrl, {
      headers: previewHeaders,
      host: previewHost,
      path: '/socket',
    });
    expect(upgrade).toContain('HTTP/1.1 101 Switching Protocols');
    expect(upgrade.toLowerCase()).toContain(`x-upstream-host: ${previewHost}`);
    expect(upgrade.toLowerCase()).toContain('x-upstream-authorization: \r\n');
    expect(upgrade.toLowerCase()).toContain('x-upstream-bridge-token: \r\n');
  }, 180_000);
});

async function waitForPreview(url: string, headers: Record<string, string> | undefined): Promise<void> {
  await waitFor(async () => {
    const request = headers ? { headers } : undefined;
    const response = await fetch(url, request).catch(() => null);
    return Boolean(response?.ok);
  }, 30_000);
}

async function fetchPreview(url: string, headers: Record<string, string>): Promise<string> {
  const request = headers ? { headers } : undefined;
  const response = await fetch(url, request);
  if (!response.ok) throw new Error(`Preview request failed with HTTP ${response.status}`);
  return response.text();
}

async function fetchPreviewJson(url: string, headers: Record<string, string>): Promise<Record<string, string | null>> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Preview request failed with HTTP ${response.status}`);
  return response.json() as Promise<Record<string, string | null>>;
}

function rawUpgrade(
  targetUrl: string,
  input: { headers: Record<string, string>; host: string; path: string },
): Promise<string> {
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const socket =
      target.protocol === 'https:'
        ? tls.connect({ host: target.hostname, port: Number(target.port) || 443, servername: target.hostname })
        : net.connect({ host: target.hostname, port: Number(target.port) || 80 });
    let response = '';
    socket.setEncoding('utf-8');
    socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      socket.write(
        `GET ${target.pathname}${input.path} HTTP/1.1\r\n` +
          `Host: ${target.host}\r\n` +
          `X-Deputies-Preview-Host: ${input.host}\r\n` +
          `Authorization: ${input.headers.authorization}\r\n` +
          `X-Deputies-Bridge-Token: ${input.headers['x-deputies-bridge-token']}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
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

function cookiePair(value: string | null): string {
  const pair = value?.split(';')[0];
  if (!pair) throw new Error('Expected preview application session cookie');
  return pair;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
