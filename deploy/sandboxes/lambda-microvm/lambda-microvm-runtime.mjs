import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { parseRunConfig } from './runtime-config.mjs';

const hooksPort = Number(process.env.LAMBDA_MICROVM_HOOKS_PORT ?? 9000);
const defaultBridgePort = 3584;
const defaultWorkspacePath = '/workspace';

let bridge = null;
let lastRunConfig = null;

startHookServer('0.0.0.0');
startHookServer('::', { ipv6Only: true, optional: true });

function startHookServer(host, { ipv6Only = false, optional = false } = {}) {
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      console.error('lambda microvm runtime hook failed', error);
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : 'Unknown Lambda MicroVM runtime error');
    });
  });

  server.on('error', (error) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown';
    const log = optional ? console.warn : console.error;
    log(`lambda microvm runtime hook listener failed host=${host} port=${hooksPort} code=${code}`, error);
    if (!optional) process.exit(1);
  });

  server.listen({ port: hooksPort, host, ipv6Only }, () => {
    const address = server.address();
    const boundHost = typeof address === 'object' && address ? address.address : host;
    console.log(`lambda microvm runtime hooks listening on ${boundHost}:${hooksPort}`);
    void probeHookServer(host);
  });
}

async function probeHookServer(host) {
  const probeHost = host === '::' ? '[::1]' : '127.0.0.1';
  try {
    const response = await fetch(`http://${probeHost}:${hooksPort}/health`);
    console.log(`lambda microvm runtime hook self-probe host=${probeHost} status=${response.status}`);
  } catch (error) {
    console.warn(`lambda microvm runtime hook self-probe failed host=${probeHost}`, error);
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `127.0.0.1:${hooksPort}`}`);
  console.log(`lambda microvm hook request method=${request.method ?? ''} path=${url.pathname}`);
  if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { status: 'ok' });

  const hook = hookName(url.pathname);
  if (!hook) return json(response, 404, { error: 'not_found' });
  if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'HEAD') {
    return json(response, 405, { error: 'method_not_allowed' });
  }

  if (hook === 'ready' || hook === 'validate') return json(response, 200, { ok: true });
  if (hook === 'suspend') return json(response, 200, { ok: true });
  if (hook === 'terminate') {
    stopBridge();
    return json(response, 200, { ok: true });
  }
  if (hook === 'resume') {
    if (!bridge && lastRunConfig) await startBridge(lastRunConfig);
    return json(response, 200, { ok: true });
  }
  if (hook === 'run') {
    const body = await readJson(request);
    const runConfig = parseRunConfig(body);
    lastRunConfig = runConfig;
    await startBridge(runConfig);
    return json(response, 200, { ok: true });
  }

  return json(response, 404, { error: 'not_found' });
}

function hookName(pathname) {
  if (pathname.startsWith('/aws/lambda-microvms/runtime/v1/')) {
    return pathname.slice('/aws/lambda-microvms/runtime/v1/'.length);
  }
  const simpleHook = pathname.replace(/^\//, '');
  return ['ready', 'validate', 'run', 'resume', 'suspend', 'terminate'].includes(simpleHook) ? simpleHook : '';
}

async function startBridge(config) {
  if (bridge) return;
  const bridgeToken = requiredString(config.bridgeToken, 'bridgeToken');
  const workspacePath = stringOr(config.workspacePath, defaultWorkspacePath);
  const bridgePort = numberOr(config.bridgePort, defaultBridgePort);
  await mkdir(workspacePath, { recursive: true });

  bridge = spawn('/opt/deputies/start-bridge.sh', {
    stdio: 'inherit',
    env: {
      HOME: '/root',
      USER: 'root',
      LOGNAME: 'root',
      SHELL: '/bin/bash',
      PATH: '/usr/lib/postgresql/16/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      DEPUTIES_SANDBOX_TOKEN: bridgeToken,
      DEPUTIES_WORKSPACE: workspacePath,
      DEPUTIES_SANDBOX_BRIDGE_HOST: '0.0.0.0',
      DEPUTIES_SANDBOX_BRIDGE_PORT: String(bridgePort),
      DEBIAN_FRONTEND: 'noninteractive',
      PGDATA: '/root/.deputies/postgres',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
      ...(typeof config.bridgeSkippedCookieNames === 'string'
        ? { DEPUTIES_SANDBOX_SKIP_COOKIE_NAMES: config.bridgeSkippedCookieNames }
        : {}),
    },
  });
  bridge.once('exit', (code, signal) => {
    console.log(`deputies sandbox bridge exited code=${code ?? ''} signal=${signal ?? ''}`);
    bridge = null;
  });

  await waitForBridge(bridgeToken, bridgePort);
}

function stopBridge() {
  if (!bridge) return;
  bridge.kill('SIGTERM');
  bridge = null;
}

async function waitForBridge(token, port) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
      lastError = new Error(await response.text());
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError instanceof Error ? lastError : new Error('Deputies sandbox bridge did not become ready');
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) : {};
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`);
  return value;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}

function numberOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
