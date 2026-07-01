#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http, {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const defaultPort = 3584;
const defaultMaxBodyBytes = 16 * 1024 * 1024;
const defaultMaxOutputBytes = 1024 * 1024;
const defaultCommandPath = '/usr/lib/postgresql/16/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const commandEnvPrefix = 'DEPUTIES_SANDBOX_COMMAND_ENV_';
const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const previewBufferedBodyMaxBytes = 16 * 1024 * 1024;
const previewHostHeader = 'x-deputies-preview-host';
const skippedPreviewRequestHeaders = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  previewHostHeader,
  'x-daytona-preview-token',
  'x-daytona-skip-preview-warning',
]);
const skippedPreviewResponseHeaders = new Set(['connection', 'content-length', 'transfer-encoding']);
const skippedPreviewUpgradeHeaders = new Set([
  'authorization',
  'content-length',
  'cookie',
  'host',
  previewHostHeader,
  'x-daytona-preview-token',
  'x-daytona-skip-preview-warning',
]);
// Keep in sync with the control-plane defaults; override with
// DEPUTIES_SANDBOX_SKIP_COOKIE_NAMES when SESSION_COOKIE_NAME or
// PREVIEW_COOKIE_NAME is customized on the instance running this sandbox.
const defaultSkippedCookieNames = ['deputies_preview', 'dev_deputies_session'];

export type SandboxBridgeOptions = {
  workspacePath: string;
  token: string;
  maxBodyBytes?: number;
  maxOutputBytes?: number;
  skippedCookieNames?: string[];
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
  const skippedCookieNames = new Set(options.skippedCookieNames ?? defaultSkippedCookieNames);

  const server = createServer((request, response) => {
    void (async () => {
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
          const abort = new AbortController();
          response.on('close', () => {
            if (!response.writableEnded) abort.abort();
          });
          const result = await execCommand(workspacePath, body, maxOutputBytes, abort.signal);
          writeJson(response, 200, result);
          return;
        }

        if (request.method === 'GET' && url.pathname === '/fs/read') {
          const content = await readFile(resolveWorkspacePath(workspacePath, requirePathParam(url)));
          response.writeHead(200, {
            'cache-control': 'no-transform',
            'content-length': String(content.byteLength),
            'content-type': 'application/octet-stream',
            'x-content-type-options': 'nosniff',
            'x-deputies-sha256': checksumSha256(content),
          });
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
          await proxyPreviewRequest(request, response, previewMatch, url, maxBodyBytes, skippedCookieNames);
          return;
        }

        writeJson(response, 404, { error: 'not_found' });
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        writeJson(response, statusCodeForError(error), {
          error: error instanceof Error ? error.message : 'Unknown bridge error',
        });
      }
    })();
  });
  server.on('upgrade', (request, socket, head) => {
    handlePreviewUpgrade(request, socket, head, options.token, skippedCookieNames);
  });
  return server;
}

function handlePreviewUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  token: string,
  skippedCookieNames: Set<string>,
): void {
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
  proxyPreviewUpgrade(request, socket, head, target, skippedCookieNames);
}

function proxyPreviewUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: URL,
  skippedCookieNames: Set<string>,
): void {
  const upstream = net.connect({ host: target.hostname, port: Number(target.port) });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.once('connect', () => {
    upstream.write(upgradeRequestHead(request, target, skippedCookieNames));
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.once('error', close);
  socket.once('error', close);
}

function upgradeRequestHead(request: IncomingMessage, target: URL, skippedCookieNames: Set<string>): string {
  const forwardedHost = previewForwardedHost(request.headers);
  const headers: Array<[string, string]> = [['host', forwardedHost ?? target.host]];
  let hasOrigin = false;
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (skippedPreviewUpgradeHeaders.has(lower)) continue;
    if (lower === 'origin') hasOrigin = true;
    if (forwardedHost && (lower === 'x-forwarded-host' || lower === 'x-original-host')) continue;
    appendHeaderValues(headers, key, value);
  }
  if (forwardedHost) {
    headers.push(['x-forwarded-host', forwardedHost]);
    headers.push(['x-original-host', forwardedHost]);
  }
  const cookie = previewCookieHeader(headerValue(request.headers.cookie), skippedCookieNames);
  if (cookie) headers.push(['cookie', cookie]);
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
  maxBodyBytes: number,
  skippedCookieNames: Set<string>,
): Promise<void> {
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BridgeHttpError(400, 'Invalid preview port');
  const path = match[2] ? `/${match[2]}` : '/';
  const target = new URL(`http://127.0.0.1:${port}${path}`);
  target.search = requestUrl.search;
  const headers = previewHeaders(request.headers, skippedCookieNames);
  const body = await previewRequestBody(request, maxBodyBytes);
  const bodyLength = previewRequestBodyLength(body) ?? headerValue(request.headers['content-length']);
  if (bodyLength !== undefined) headers['content-length'] = String(bodyLength);
  await proxyPreviewHttpRequest(target, request.method, headers, body, response);
}

async function previewRequestBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer | IncomingMessage | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const contentLengthHeader = request.headers['content-length'];
  const contentLength = contentLengthHeader === undefined ? undefined : Number(contentLengthHeader);
  if (
    contentLength !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength >= 0 &&
    contentLength <= previewBufferedBodyMaxBytes
  ) {
    return readBody(request, Math.min(maxBodyBytes, previewBufferedBodyMaxBytes));
  }
  return request;
}

function previewRequestBodyLength(body: Buffer | IncomingMessage | undefined): number | undefined {
  return Buffer.isBuffer(body) ? body.byteLength : undefined;
}

function previewHeaders(
  input: IncomingMessage['headers'],
  skippedCookieNames: Set<string>,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (skippedPreviewRequestHeaders.has(lower)) continue;
    if (Array.isArray(value)) headers[key] = value;
    else if (value !== undefined) headers[key] = value;
  }
  const forwardedHost = previewForwardedHost(input);
  if (forwardedHost) {
    headers.host = forwardedHost;
    headers['x-forwarded-host'] = forwardedHost;
    headers['x-original-host'] = forwardedHost;
  }
  const cookie = previewCookieHeader(headerValue(input.cookie), skippedCookieNames);
  if (cookie) headers.cookie = cookie;
  headers['accept-encoding'] = 'identity';
  return headers;
}

function previewForwardedHost(input: IncomingMessage['headers']): string | undefined {
  return lastForwardedValue(input[previewHostHeader]);
}

function lastForwardedValue(value: string | string[] | undefined): string | undefined {
  const header = headerValue(value);
  return header
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
}

function proxyPreviewHttpRequest(
  target: URL,
  method: string | undefined,
  headers: Record<string, string | string[]>,
  body: Buffer | IncomingMessage | undefined,
  response: ServerResponse,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const upstream = http.request(
      {
        method,
        hostname: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          previewResponseHeadersFromNodeHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
        upstreamResponse.once('end', resolve);
        upstreamResponse.once('error', reject);
      },
    );
    upstream.once('error', reject);
    if (!body) {
      upstream.end();
      return;
    }
    if (Buffer.isBuffer(body)) {
      upstream.end(body);
      return;
    }
    body.pipe(upstream);
  });
}

function previewResponseHeadersFromNodeHeaders(input: IncomingHttpHeaders): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || skippedPreviewResponseHeaders.has(key.toLowerCase())) continue;
    headers[key] = value;
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

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join('; ') : value;
}

function previewCookieHeader(header: string | undefined, skippedCookieNames: Set<string>): string | undefined {
  if (!header) return undefined;
  const cookies = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split('=')[0]?.trim();
      return name && !skippedCookieNames.has(name);
    });
  return cookies.length ? cookies.join('; ') : undefined;
}

function checksumSha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

async function execCommand(
  workspacePath: string,
  input: ParsedExecRequest,
  maxOutputBytes: number,
  signal?: AbortSignal,
) {
  const startedAt = new Date();
  const cwd = input.cwd ? resolveWorkspacePath(workspacePath, input.cwd) : workspacePath;
  const env = createCommandEnv(workspacePath, input.env);
  const timeoutMs = input.timeoutMs;

  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Operation aborted', 'AbortError'));
      return;
    }

    const child = spawn(input.command, {
      cwd,
      env,
      shell: true,
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let resolved = false;
    let exited = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let exitDrainTimer: NodeJS.Timeout | undefined;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killProcessGroup(child.pid);
        }, timeoutMs)
      : undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      aborted = true;
      killProcessGroup(child.pid);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const finish = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (aborted || signal?.aborted) {
        reject(new DOMException('Operation aborted', 'AbortError'));
        return;
      }
      if (timedOut && !stderr.trim()) stderr = `[sandbox bridge] Command timed out after ${timeoutMs}ms.`;
      resolveResult({
        exitCode: exitCode ?? signalExitCode(exitSignal),
        stdout,
        stderr,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
      });
    };
    const finishIfStreamsDrained = () => {
      if (exited && stdoutClosed && stderrClosed) finish();
    };

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes);
    });
    child.stdout.on('close', () => {
      stdoutClosed = true;
      finishIfStreamsDrained();
    });
    child.stderr.on('close', () => {
      stderrClosed = true;
      finishIfStreamsDrained();
    });
    child.on('error', (error) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(error);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      finishIfStreamsDrained();
      exitDrainTimer = setTimeout(finish, 100);
    });
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

function createCommandEnv(workspacePath: string, inputEnv: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    DEPUTIES_WORKSPACE: process.env.DEPUTIES_WORKSPACE ?? workspacePath,
    HOME: process.env.HOME ?? workspacePath,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'sandbox',
    PATH: process.env.PATH ?? defaultCommandPath,
    SHELL: process.env.SHELL ?? '/bin/sh',
    TERM: process.env.TERM ?? 'xterm',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    USER: process.env.USER ?? 'sandbox',
    ...prefixedCommandEnv(process.env),
  };
  if (inputEnv) {
    for (const [key, value] of Object.entries(inputEnv as Record<string, string>)) env[key] = value;
  }
  delete env.DEPUTIES_SANDBOX_TOKEN;
  return env;
}

function prefixedCommandEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(commandEnvPrefix) || value === undefined) continue;
    const commandEnvKey = key.slice(commandEnvPrefix.length);
    if (!envKeyPattern.test(commandEnvKey)) throw new Error(`Invalid command env key: ${commandEnvKey}`);
    env[commandEnvKey] = value;
  }
  return env;
}

function validateEnv(value: unknown): void {
  const env = readObject(value);
  for (const [key, envValue] of Object.entries(env)) {
    if (!envKeyPattern.test(key)) throw new BridgeHttpError(400, `Invalid env key: ${key}`);
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
  const authorization = request.headers.authorization;
  return authorization !== undefined && safeEqual(authorization, `Bearer ${token}`);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
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

function parseSkippedCookieNames(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length ? names : undefined;
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
  const skippedCookieNames = parseSkippedCookieNames(process.env.DEPUTIES_SANDBOX_SKIP_COOKIE_NAMES);
  const server = createSandboxBridgeServer({
    workspacePath,
    token,
    ...(skippedCookieNames ? { skippedCookieNames } : {}),
  });
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
