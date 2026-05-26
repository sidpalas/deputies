#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const defaultPort = 3584;
const defaultMaxBodyBytes = 16 * 1024 * 1024;
const defaultMaxOutputBytes = 1024 * 1024;
const skippedPreviewRequestHeaders = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
]);
const skippedPreviewResponseHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'transfer-encoding',
]);
const skippedPreviewUpgradeHeaders = new Set(['authorization', 'content-length', 'cookie', 'host']);

export type SandboxBridgeOptions = {
  workspacePath: string;
  token: string;
  maxBodyBytes?: number;
  maxOutputBytes?: number;
};

type ExecRequest = {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  timeoutMs?: unknown;
  stdin?: unknown;
};

type ParsedExecRequest = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
};

export function createSandboxBridgeServer(options: SandboxBridgeOptions): Server {
  const workspacePath = resolve(options.workspacePath);
  const maxBodyBytes = options.maxBodyBytes ?? defaultMaxBodyBytes;
  const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;

  const server = createServer(async (request, response) => {
    try {
      if (!isAuthorized(request, options.token)) {
        writeJson(response, 401, { error: 'unauthorized' });
        return;
      }

      const url = new URL(request.url ?? '/', 'http://sandbox-bridge.local');
      if (request.method === 'GET' && url.pathname === '/health') {
        writeJson(response, 200, { status: 'ready', workspacePath });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/exec') {
        const body = parseExecRequest(await readJson(request, maxBodyBytes));
        const result = await execCommand(workspacePath, body, maxOutputBytes);
        writeJson(response, 200, result);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/fs/read') {
        const content = await readFile(resolveWorkspacePath(workspacePath, requirePathParam(url)));
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(content);
        return;
      }

      if (request.method === 'PUT' && url.pathname === '/fs/write') {
        const path = resolveWorkspacePath(workspacePath, requirePathParam(url));
        const content = await readBody(request, maxBodyBytes);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/fs/stat') {
        const info = await stat(resolveWorkspacePath(workspacePath, requirePathParam(url)));
        writeJson(response, 200, {
          isFile: info.isFile(),
          isDirectory: info.isDirectory(),
          isSymbolicLink: info.isSymbolicLink(),
          size: info.size,
          mtime: info.mtime.toISOString(),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/fs/readdir') {
        writeJson(response, 200, {
          entries: await readdir(resolveWorkspacePath(workspacePath, requirePathParam(url))),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/fs/exists') {
        writeJson(response, 200, {
          exists: await pathExists(resolveWorkspacePath(workspacePath, requirePathParam(url))),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/fs/mkdir') {
        const body = await readJson(request, maxBodyBytes);
        await mkdir(resolveWorkspacePath(workspacePath, requireJsonPath(body)), {
          recursive: Boolean(readObject(body).recursive),
        });
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/fs/rm') {
        const body = readObject(await readJson(request, maxBodyBytes));
        await rm(resolveWorkspacePath(workspacePath, requireJsonPath(body)), {
          recursive: Boolean(body.recursive),
          force: Boolean(body.force),
        });
        writeJson(response, 200, { ok: true });
        return;
      }

      const previewMatch = url.pathname.match(/^\/preview\/(\d+)(?:\/(.*))?$/);
      if (previewMatch) {
        await proxyPreviewRequest(request, response, previewMatch, url);
        return;
      }

      writeJson(response, 404, { error: 'not_found' });
    } catch (error) {
      writeJson(response, statusCodeForError(error), {
        error: error instanceof Error ? error.message : 'Unknown bridge error',
      });
    }
  });
  server.on('upgrade', (request, socket, head) => {
    handlePreviewUpgrade(request, socket, head, options.token);
  });
  return server;
}

function handlePreviewUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, token: string): void {
  if (!isAuthorized(request, token)) {
    socket.destroy();
    return;
  }
  const url = new URL(request.url ?? '/', 'http://sandbox-bridge.local');
  const match = url.pathname.match(/^\/preview\/(\d+)(?:\/(.*))?$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    socket.destroy();
    return;
  }
  const path = match[2] ? `/${match[2]}` : '/';
  const target = new URL(`http://127.0.0.1:${port}${path}`);
  target.search = url.search;
  proxyPreviewUpgrade(request, socket, head, target);
}

function proxyPreviewUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, target: URL): void {
  const upstream = net.connect({ host: target.hostname, port: Number(target.port) });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.once('connect', () => {
    upstream.write(upgradeRequestHead(request, target));
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.once('error', close);
  socket.once('error', close);
}

function upgradeRequestHead(request: IncomingMessage, target: URL): string {
  const headers: Array<[string, string]> = [['host', target.host]];
  let hasOrigin = false;
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (skippedPreviewUpgradeHeaders.has(lower)) continue;
    if (lower === 'origin') hasOrigin = true;
    appendHeaderValues(headers, key, value);
  }
  if (!hasOrigin) headers.push(['origin', target.origin]);
  return [
    `${request.method ?? 'GET'} ${target.pathname || '/'}${target.search} HTTP/1.1`,
    ...headers.map(([key, value]) => `${key}: ${value}`),
    '',
    '',
  ].join('\r\n');
}

async function proxyPreviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  match: RegExpMatchArray,
  requestUrl: URL,
): Promise<void> {
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BridgeHttpError(400, 'Invalid preview port');
  const path = match[2] ? `/${match[2]}` : '/';
  const target = new URL(`http://127.0.0.1:${port}${path}`);
  target.search = requestUrl.search;
  const headers = previewHeaders(request.headers);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request;
  const upstream = await fetch(target, { method: request.method, headers, body, duplex: 'half' } as RequestInit & {
    duplex: 'half';
  });
  response.writeHead(upstream.status, Object.fromEntries(previewResponseHeaders(upstream.headers).entries()));
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}

function previewHeaders(input: IncomingMessage['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (skippedPreviewRequestHeaders.has(lower)) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  headers.set('accept-encoding', 'identity');
  return headers;
}

function previewResponseHeaders(input: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of input.entries()) {
    if (skippedPreviewResponseHeaders.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  return headers;
}

function appendHeaderValues(headers: Array<[string, string]>, key: string, value: string | string[] | undefined): void {
  if (Array.isArray(value)) {
    for (const item of value) headers.push([key, item]);
    return;
  }
  if (value !== undefined) headers.push([key, value]);
}

async function execCommand(workspacePath: string, input: ParsedExecRequest, maxOutputBytes: number) {
  const startedAt = new Date();
  const cwd = input.cwd ? resolveWorkspacePath(workspacePath, input.cwd) : workspacePath;
  const env = createCommandEnv(input.env);
  const timeoutMs = input.timeoutMs;

  return new Promise((resolveResult, reject) => {
    const child = spawn(input.command, {
      cwd,
      env,
      shell: true,
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killProcessGroup(child.pid);
        }, timeoutMs)
      : undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      if (timedOut && !stderr.trim()) stderr = `[sandbox bridge] Command timed out after ${timeoutMs}ms.`;
      resolveResult({
        exitCode: code ?? signalExitCode(signal),
        stdout,
        stderr,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
      });
    };

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes);
    });
    child.on('error', reject);
    child.on('exit', finish);
    if (input.stdin !== undefined) child.stdin.end(input.stdin);
    else child.stdin.end();
  });
}

function parseExecRequest(value: unknown): ParsedExecRequest {
  const input = readObject(value);
  if (typeof input.command !== 'string' || !input.command.trim()) throw new BridgeHttpError(400, 'command is required');
  if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new BridgeHttpError(400, 'cwd must be a string');
  if (input.stdin !== undefined && typeof input.stdin !== 'string')
    throw new BridgeHttpError(400, 'stdin must be a string');
  if (
    input.timeoutMs !== undefined &&
    (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1)
  ) {
    throw new BridgeHttpError(400, 'timeoutMs must be a positive integer');
  }
  if (input.env !== undefined) validateEnv(input.env);

  const parsed: ParsedExecRequest = { command: input.command };
  if (input.cwd !== undefined) parsed.cwd = input.cwd;
  if (input.env !== undefined) parsed.env = input.env as Record<string, string>;
  if (input.timeoutMs !== undefined) parsed.timeoutMs = input.timeoutMs;
  if (input.stdin !== undefined) parsed.stdin = input.stdin;
  return parsed;
}

function createCommandEnv(inputEnv: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEPUTIES_SANDBOX_TOKEN;
  if (!inputEnv) return env;
  for (const [key, value] of Object.entries(inputEnv as Record<string, string>)) env[key] = value;
  delete env.DEPUTIES_SANDBOX_TOKEN;
  return env;
}

function validateEnv(value: unknown): void {
  const env = readObject(value);
  for (const [key, envValue] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new BridgeHttpError(400, `Invalid env key: ${key}`);
    if (typeof envValue !== 'string') throw new BridgeHttpError(400, `Env value must be a string: ${key}`);
  }
}

function resolveWorkspacePath(workspacePath: string, path: string): string {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(workspacePath, path);
  if (resolved !== workspacePath && !resolved.startsWith(`${workspacePath}${sep}`)) {
    throw new BridgeHttpError(400, `Path escapes workspace: ${path}`);
  }
  return resolved;
}

function requirePathParam(url: URL): string {
  const path = url.searchParams.get('path');
  if (!path) throw new BridgeHttpError(400, 'path is required');
  return path;
}

function requireJsonPath(value: unknown): string {
  const path = readObject(value).path;
  if (typeof path !== 'string' || !path) throw new BridgeHttpError(400, 'path is required');
  return path;
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new BridgeHttpError(400, 'Expected JSON object');
  return value as Record<string, unknown>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const body = await readBody(request, maxBytes);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf-8')) as unknown;
  } catch {
    throw new BridgeHttpError(400, 'Invalid JSON body');
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new BridgeHttpError(413, 'Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf-8') <= maxBytes) return next;
  return next.slice(0, maxBytes) + '\n[sandbox bridge] Output truncated.';
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // The process may have already exited.
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  return signal === 'SIGTERM' ? 143 : 1;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function statusCodeForError(error: unknown): number {
  if (error instanceof BridgeHttpError) return error.statusCode;
  if (isMissingPathError(error)) return 404;
  return 500;
}

class BridgeHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

async function main(): Promise<void> {
  const token = process.env.DEPUTIES_SANDBOX_TOKEN;
  if (!token) throw new Error('DEPUTIES_SANDBOX_TOKEN is required');
  const workspacePath = process.env.DEPUTIES_WORKSPACE ?? '/workspace';
  await mkdir(workspacePath, { recursive: true });
  const server = createSandboxBridgeServer({ workspacePath, token });
  const host = process.env.DEPUTIES_SANDBOX_BRIDGE_HOST ?? '0.0.0.0';
  const port = Number(process.env.DEPUTIES_SANDBOX_BRIDGE_PORT ?? defaultPort);
  server.listen(port, host);
  await once(server, 'listening');
  console.log(`deputies sandbox bridge listening on ${host}:${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
