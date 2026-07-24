import net, { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { Readable, type Duplex } from 'node:stream';
import type { Context } from 'hono';
import { canReadSession, canWriteSession, type RequestAuthorization } from '../auth/authorization.js';
import {
  createPreviewCookie,
  previewBootstrapMaxAgeSeconds,
  previewCookieMaxAgeSeconds,
  previewGrantMaxAgeSeconds,
  readPreviewCookie,
  signPreviewAuthToken,
  type PreviewAuthToken,
  verifyPreviewAuthToken,
} from '../auth/session.js';
import { requireApiBearerToken, requireAuthSessionSecret, type AppConfig } from '../config/index.js';
import type { SandboxProvider, SandboxServiceEndpoint } from '../sandbox/types.js';
import type { AppStore, AuthUserRecord, SessionRecord } from '../store/types.js';

type ServiceProxyServices = {
  store: AppStore;
  sessions: { get(sessionId: string): Promise<SessionRecord | null> };
  sandboxProvider?: SandboxProvider;
};

type PreviewAuthorization = {
  user: AuthUserRecord;
  canWrite: boolean;
  cookie?: string;
};

const previewBufferedBodyMaxBytes = 16 * 1024 * 1024;
const previewHostHeader = 'x-deputies-preview-host';
const bridgeTokenHeader = 'x-deputies-bridge-token';
const noBodyResponseStatuses = new Set([101, 204, 205, 304]);
const skippedPreviewProxyRequestHeaders = new Set([
  'accept-encoding',
  'authorization',
  bridgeTokenHeader,
  'connection',
  'content-length',
  'cookie',
  'host',
  previewHostHeader,
  'referer',
]);
const skippedPreviewUpgradeRequestHeaders = new Set([
  'authorization',
  bridgeTokenHeader,
  'content-length',
  'cookie',
  'host',
  previewHostHeader,
  'referer',
]);

export async function getSessionService(
  config: AppConfig,
  services: ServiceProxyServices,
  sessionId: string,
  port: number,
): Promise<SandboxServiceEndpoint | null> {
  const provider = services.sandboxProvider;
  if (!provider?.getServiceEndpoint || !provider.capabilities.serviceEndpoints) return null;
  const sandbox = await services.store.getActiveSandbox(sessionId, provider.name);
  if (!sandbox) return null;
  const health = await provider.health(sandbox);
  if (health.status !== 'ready') return null;
  const secrets = await services.store.getSandboxSecrets(sandbox.id);
  const preview = await provider.getServiceEndpoint({
    providerSandboxId: sandbox.providerSandboxId,
    sessionId,
    port,
    secrets,
  });
  if (!preview || !(await isAllowedPreviewTarget(config, provider.name, preview.targetUrl))) return null;
  if (preview.secrets) await services.store.setSandboxSecrets(sandbox.id, preview.secrets);
  return preview;
}

export function serializeService(
  c: Context,
  config: AppConfig,
  sessionId: string,
  preview: SandboxServiceEndpoint,
  metadata: { label?: string; path?: string } = {},
  sandboxTiming: { shutdownAt?: Date; keepaliveUntil?: Date; maxKeepaliveUntil?: Date } = {},
  previewAuthToken?: string,
) {
  const url = previewUrl(c, config, sessionId, preview.port, metadata.path, previewAuthToken);
  return {
    port: preview.port,
    url,
    status: 'available',
    ...(sandboxTiming.shutdownAt ? { shutdownAt: sandboxTiming.shutdownAt.toISOString() } : {}),
    ...(sandboxTiming.keepaliveUntil ? { keepaliveUntil: sandboxTiming.keepaliveUntil.toISOString() } : {}),
    ...(sandboxTiming.maxKeepaliveUntil ? { maxKeepaliveUntil: sandboxTiming.maxKeepaliveUntil.toISOString() } : {}),
    ...(metadata.label ? { label: metadata.label } : {}),
    ...(metadata.path ? { path: metadata.path } : {}),
  };
}

export async function proxyService(c: Context, config: AppConfig, preview: SandboxServiceEndpoint): Promise<Response> {
  const target = previewTargetUrl(c, preview.targetUrl);
  const request = c.req.raw;
  const body = await previewRequestBody(request);
  const headers = previewRequestHeaders(
    config,
    request.headers,
    previewTargetHeaders(preview, previewRequestHost(config, c)),
  );
  const bodyLength = previewRequestBodyLength(body);
  if (bodyLength !== undefined) headers.set('content-length', String(bodyLength));
  return proxyServiceRequest(config, target, request.method, headers, body);
}

function previewRequestBodyLength(body: RequestInit['body']): number | undefined {
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

function proxyServiceRequest(
  config: AppConfig,
  target: string,
  requestMethod: string | undefined,
  requestHeaders: Headers,
  requestBody: RequestInit['body'],
): Promise<Response> {
  const targetUrl = new URL(target);
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error(`Unsupported preview protocol: ${targetUrl.protocol}`);
  }

  const protocolClient = targetUrl.protocol === 'https:' ? https : http;

  return new Promise<Response>((resolve, reject) => {
    const requestOptions: http.RequestOptions & https.RequestOptions = {
      method: requestMethod,
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: Number(targetUrl.port) || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: requestHeadersToNodeHeaders(requestHeaders),
    };
    if (targetUrl.protocol === 'https:') requestOptions.servername = targetUrl.hostname;

    const upstream = protocolClient.request(requestOptions, (upstreamResponse) => {
      const responseHeaders = previewResponseHeadersFromNodeHeaders(config, upstreamResponse.headers);
      const responseBody = Readable.toWeb(upstreamResponse);
      const status = upstreamResponse.statusCode ?? 502;
      const hasResponseBody = !noBodyResponseStatuses.has(status);
      resolve(
        new Response(hasResponseBody ? responseBody : null, {
          status,
          statusText: upstreamResponse.statusMessage ?? '',
          headers: responseHeaders,
        }),
      );
    });

    upstream.once('error', reject);

    if (requestBody === undefined || requestBody === null) {
      upstream.end();
      return;
    }

    if (ArrayBuffer.isView(requestBody)) {
      upstream.end(Buffer.from(requestBody.buffer, requestBody.byteOffset, requestBody.byteLength));
      return;
    }

    if (requestBody instanceof ArrayBuffer) {
      upstream.end(Buffer.from(requestBody));
      return;
    }

    if (typeof requestBody === 'string') {
      upstream.end(requestBody);
      return;
    }

    if (typeof requestBody === 'object' && requestBody !== null && 'getReader' in requestBody) {
      const upstreamBody = Readable.fromWeb(requestBody as ReadableStream<Uint8Array>);
      upstreamBody.once('error', (error) => {
        upstream.destroy(error instanceof Error ? error : new Error(String(error)));
      });
      upstreamBody.pipe(upstream);
      return;
    }

    if (requestBody instanceof URLSearchParams) {
      upstream.end(requestBody.toString());
      return;
    }

    upstream.destroy();
    reject(new Error('Unsupported service proxy request body type'));
  });
}

async function previewRequestBody(request: Request): Promise<RequestInit['body'] | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const contentLengthHeader = request.headers.get('content-length');
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (
    contentLength !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength >= 0 &&
    contentLength <= previewBufferedBodyMaxBytes
  ) {
    return request.arrayBuffer();
  }
  return request.body ?? undefined;
}

export function appendPreviewCookie(response: Response, cookie: string | undefined): Response {
  if (cookie) response.headers.append('set-cookie', cookie);
  return response;
}

export function parseServiceHostFromRequest(config: AppConfig, c: Context): { sessionId: string; port: number } | null {
  return parsePreviewHostFromHosts(previewRequestHosts(config, c), previewAllowedDomains(config, c));
}

export async function authorizePreviewRequest(
  config: AppConfig,
  store: AppStore,
  c: Context,
): Promise<PreviewAuthorization | null> {
  if (config.apiAuthMode === 'none') return null;
  if (config.apiAuthMode === 'bearer') return null;
  if (!isTrustedPreviewRequest(config, c)) return null;
  const authorization = await readPreviewAuthUser(
    config,
    store,
    readPreviewCookie(config, c),
    previewRequestHost(config, c),
    { kind: 'cookie', renew: true },
  );
  if (!authorization || (requiresPreviewWriteAccess(c.req.method) && !authorization.canWrite)) return null;
  return authorization;
}

export async function authorizePreviewToken(
  config: AppConfig,
  store: AppStore,
  c: Context,
  previewSessionId: string,
  port: number,
): Promise<Response> {
  const token = c.req.query('token');
  const redirect = previewAuthRedirect(c.req.query('redirect'));
  const authToken = token ?? null;
  const payload = authToken ? verifyPreviewAuthToken(authToken, requireAuthSessionSecret(config)) : null;
  if (
    !authToken ||
    !payload ||
    payload.kind !== 'bootstrap' ||
    payload.previewSessionId !== previewSessionId ||
    payload.port !== port
  ) {
    return new Response('Forbidden', { status: 403 });
  }

  const authorization = await readPreviewAuthUser(config, store, authToken, previewRequestHost(config, c), {
    kind: 'bootstrap',
  });
  if (!authorization) return new Response('Forbidden', { status: 403 });

  const cookieToken = createPreviewCookieToken(config, payload);

  return new Response(null, {
    status: 302,
    headers: {
      location: redirect,
      'referrer-policy': 'no-referrer',
      'set-cookie': createPreviewCookie(config, cookieToken, previewCookieMaxAgeSeconds),
    },
  });
}

export function createPreviewAuthToken(
  config: AppConfig,
  input: { authSessionId: string; previewSessionId: string; port: number; userId: string },
): string {
  const now = Math.floor(Date.now() / 1000);
  return signPreviewAuthToken(
    {
      kind: 'bootstrap',
      ...input,
      exp: now + previewBootstrapMaxAgeSeconds,
      grantExp: now + previewGrantMaxAgeSeconds,
    },
    requireAuthSessionSecret(config),
  );
}

export async function handleServiceUpgrade(
  config: AppConfig,
  services: ServiceProxyServices,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const incoming = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const hostPreview = parsePreviewHostFromNodeRequest(config, request);
  if (!hostPreview) {
    rejectUpgrade(socket, 404, 'Service preview not found');
    return;
  }

  const { sessionId, port } = hostPreview;
  if (!isTrustedPreviewUpgrade(config, request)) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }
  const session = await services.sessions.get(sessionId);
  if (!session) {
    rejectUpgrade(socket, 404, 'Session not found');
    return;
  }
  if (session.visibility === 'private' && config.apiAuthMode !== 'session') {
    rejectUpgrade(socket, 404, 'Session not found');
    return;
  }
  if (!(await isAuthorizedUpgrade(config, services, request))) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }
  const preview = await getSessionService(config, services, sessionId, port);
  if (!preview) {
    rejectUpgrade(socket, 404, 'Service preview not found');
    return;
  }

  const upgradeInput: {
    request: IncomingMessage;
    socket: Duplex;
    head: Buffer;
    targetUrl: string;
    targetHeaders?: Record<string, string>;
    preserveOrigin: boolean;
  } = {
    request,
    socket,
    head,
    targetUrl: previewTargetUrlFromUrl(incoming, preview.targetUrl),
    preserveOrigin: true,
  };
  const targetHeaders = previewTargetHeaders(preview, previewNodeRequestHosts(config, request)[0]);
  if (Object.keys(targetHeaders).length) upgradeInput.targetHeaders = targetHeaders;
  proxyPreviewUpgrade(config, upgradeInput);
}

function previewTargetHeaders(preview: SandboxServiceEndpoint, host: string | undefined): Record<string, string> {
  const headers = { ...(preview.targetHeaders ?? {}) };
  if (!host) return headers;
  headers['x-forwarded-host'] = host;
  headers['x-original-host'] = host;
  if (preview.forwardPreviewHost) headers[previewHostHeader] = host;
  if (!preview.preserveTargetHost) headers.host = stripPort(host);
  return headers;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      '\r\n' +
      message,
  );
}

export function parseServicePort(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

async function isAllowedPreviewTarget(config: AppConfig, provider: string, value: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (provider === 'fake') return target.protocol === 'http:';
  if (provider === 'docker') return isAllowedDockerPreviewTarget(config, target);
  if (provider === 'k8s-agent-sandbox') return isAllowedKubernetesServicePreviewTarget(target);
  if (provider === 'daytona') return target.protocol === 'https:' && (await isAllowedPublicHostname(target.hostname));
  return isAllowedPublicHostname(target.hostname);
}

function isAllowedDockerPreviewTarget(config: AppConfig, target: URL): boolean {
  const allowedHosts = new Set(['localhost', '127.0.0.1', config.dockerSandboxBridgeHost]);
  return target.protocol === 'http:' && allowedHosts.has(target.hostname.toLowerCase());
}

function isAllowedKubernetesServicePreviewTarget(target: URL): boolean {
  const hostname = target.hostname.toLowerCase();
  return target.protocol === 'http:' && (hostname.endsWith('.svc') || hostname.endsWith('.svc.cluster.local'));
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const ipVersion = isIP(host);
  if (ipVersion === 4) return isLocalOrPrivateIpv4(host);
  if (ipVersion === 6) return isLocalOrPrivateIpv6(host);

  return false;
}

async function isAllowedPublicHostname(hostname: string): Promise<boolean> {
  const host = normalizeHostname(hostname);
  if (isLocalOrPrivateHostname(host)) return false;
  if (isIP(host)) return true;

  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((address) => !isLocalOrPrivateHostname(address.address));
  } catch {
    return false;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)]$/, '$1');
}

function isLocalOrPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return true;
  }
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isLocalOrPrivateIpv6(host: string): boolean {
  return (
    host === '::' ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.toLowerCase().startsWith('fe80:')
  );
}

function previewTargetUrl(c: Context, targetUrl: string): string {
  return previewTargetUrlFromUrl(new URL(c.req.url), targetUrl);
}

function previewTargetUrlFromUrl(incoming: URL, targetUrl: string): string {
  const suffix = incoming.pathname || '/';
  const target = new URL(targetUrl);
  target.pathname = joinUrlPath(target.pathname, suffix);
  for (const [key, value] of incoming.searchParams.entries()) {
    if (!target.searchParams.has(key)) target.searchParams.append(key, value);
  }
  return target.toString();
}

function previewUrl(
  c: Context,
  config: AppConfig,
  sessionId: string,
  port: number,
  path = '/',
  previewAuthToken?: string,
): string {
  const baseUrl = config.webBaseUrl ? new URL(config.webBaseUrl) : null;
  const requestUrl = new URL(c.req.url);
  const requestHost = baseUrl?.host ?? previewRequestHost(config, c) ?? requestUrl.host;
  const protocol =
    baseUrl?.protocol.replace(/:$/, '') ?? c.req.header('x-forwarded-proto') ?? requestUrl.protocol.replace(/:$/, '');
  const domain = config.serviceBaseDomain ?? previewDomainFromHost(requestHost);
  const suffix = path.startsWith('/') ? path.slice(1) : path;
  if (!domain) throw new Error('SERVICE_BASE_DOMAIN is required for service previews');
  const url = new URL(`${protocol}://${previewHostLabel(sessionId, port)}.${domain}/${suffix}`);
  if (previewAuthToken) {
    const redirect = `${url.pathname}${url.search}`;
    url.pathname = '/__preview_auth';
    url.search = '';
    url.searchParams.set('token', previewAuthToken);
    url.searchParams.set('redirect', redirect);
  }
  return url.toString();
}

function previewDomainFromHost(host: string): string | null {
  const hostname = host.split(':')[0] ?? '';
  const port = host.includes(':') ? `:${host.split(':').pop()}` : '';
  if (hostname === 'deputies.localhost' || hostname.endsWith('.deputies.localhost')) return `${hostname}${port}`;
  return null;
}

function previewHostLabel(sessionId: string, port: number): string {
  return `s-${port}-${sessionId}`;
}

function parsePreviewHost(
  host: string | undefined,
  allowedDomains?: string[],
): { sessionId: string; port: number } | null {
  const hostname = host?.split(':')[0]?.toLowerCase();
  if (!hostname) return null;
  if (allowedDomains?.length && !allowedDomains.some((domain) => hostname.endsWith(`.${domain}`))) return null;
  const label = hostname.split('.')[0];
  const match = label?.match(/^s-(\d+)-(.+)$/);
  if (!match) return null;
  const port = parseServicePort(match[1]);
  if (!port) return null;
  return { port, sessionId: match[2]! };
}

function parsePreviewHostFromNodeRequest(
  config: AppConfig,
  request: IncomingMessage,
): { sessionId: string; port: number } | null {
  return parsePreviewHostFromHosts(previewNodeRequestHosts(config, request), previewAllowedDomains(config, request));
}

function parsePreviewHostFromHosts(
  hosts: string[],
  allowedDomains: string[],
): { sessionId: string; port: number } | null {
  for (const host of hosts) {
    const parsed = parsePreviewHost(host, allowedDomains);
    if (parsed) return parsed;
  }
  return null;
}

function previewRequestHost(config: AppConfig, c: Context): string | undefined {
  return previewRequestHosts(config, c)[0];
}

function previewRequestHosts(config: AppConfig, c: Context): string[] {
  return previewHeaderHosts(
    previewHostHeaderValues(
      config,
      c.req.header('host'),
      c.req.header('x-forwarded-host'),
      c.req.header('x-original-host'),
    ),
  );
}

function previewNodeRequestHosts(config: AppConfig, request: IncomingMessage): string[] {
  return previewHeaderHosts(
    previewHostHeaderValues(
      config,
      request.headers.host,
      request.headers['x-forwarded-host'],
      request.headers['x-original-host'],
    ),
  );
}

function previewHostHeaderValues(
  config: AppConfig,
  host: string | string[] | undefined,
  forwardedHost: string | string[] | undefined,
  originalHost: string | string[] | undefined,
): Array<string | string[] | undefined> {
  return config.serviceTrustForwardedHosts ? [forwardedHost, originalHost, host] : [host];
}

function previewHeaderHosts(values: Array<string | string[] | undefined>): string[] {
  return values.flatMap((value) => {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items.flatMap((item) =>
      item
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean),
    );
  });
}

function previewAllowedDomains(config: AppConfig, request?: Context | IncomingMessage): string[] {
  const domains = new Set<string>();
  if (config.serviceBaseDomain) domains.add(stripPort(config.serviceBaseDomain));
  if (config.webBaseUrl) {
    const derived = previewDomainFromHost(new URL(config.webBaseUrl).host);
    if (derived) domains.add(stripPort(derived));
  }
  const host = previewAllowedDomainRequestHost(request);
  const firstHost = Array.isArray(host) ? host[0] : host;
  if (firstHost) {
    const derived = previewDomainFromHost(firstHost);
    if (derived) domains.add(stripPort(derived));
  }
  return Array.from(domains);
}

function previewAllowedDomainRequestHost(request?: Context | IncomingMessage): string | string[] | undefined {
  if (!request) return undefined;
  if ('req' in request) return request.req.header('host');
  return request.headers.host;
}

function stripPort(host: string): string {
  return host.split(':')[0]?.toLowerCase() ?? host.toLowerCase();
}

async function isAuthorizedUpgrade(
  config: AppConfig,
  services: ServiceProxyServices,
  request: IncomingMessage,
): Promise<boolean> {
  if (config.apiAuthMode === 'none') return true;
  if (config.apiAuthMode === 'bearer')
    return request.headers.authorization === `Bearer ${requireApiBearerToken(config)}`;
  const authorization = await readPreviewAuthUser(
    config,
    services.store,
    parseCookieHeader(request.headers.cookie ?? '')[config.previewCookieName] ?? null,
    previewNodeRequestHosts(config, request)[0],
    { kind: 'cookie' },
  );
  return Boolean(authorization?.canWrite);
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function proxyPreviewUpgrade(
  config: AppConfig,
  input: {
    request: IncomingMessage;
    socket: Duplex;
    head: Buffer;
    targetUrl: string;
    targetHeaders?: Record<string, string>;
    preserveOrigin: boolean;
  },
): void {
  const target = new URL(input.targetUrl);
  const secure = target.protocol === 'https:' || target.protocol === 'wss:';
  const port = Number(target.port || (secure ? 443 : 80));
  const upstream = secure
    ? tls.connect({ host: target.hostname, port, servername: target.hostname })
    : net.connect({ host: target.hostname, port });
  let connected = false;
  const start = () => {
    if (connected) return;
    connected = true;
    upstream.write(upgradeRequestHead(config, input.request, target, input.targetHeaders, input.preserveOrigin));
    if (input.head.length) upstream.write(input.head);
    upstream.pipe(input.socket);
    input.socket.pipe(upstream);
  };
  const close = () => {
    upstream.destroy();
    input.socket.destroy();
  };
  if (secure) upstream.once('secureConnect', start);
  else upstream.once('connect', start);
  upstream.once('error', close);
  input.socket.once('error', close);
}

function upgradeRequestHead(
  config: AppConfig,
  request: IncomingMessage,
  target: URL,
  injected: Record<string, string> = {},
  preserveOrigin = false,
): string {
  const headers = previewUpgradeHeaders(config, request, target, injected, preserveOrigin);
  const path = `${target.pathname || '/'}${target.search}`;
  return [
    `${request.method ?? 'GET'} ${path} HTTP/1.1`,
    ...headers.map(([key, value]) => `${key}: ${value}`),
    '',
    '',
  ].join('\r\n');
}

function previewUpgradeHeaders(
  config: AppConfig,
  request: IncomingMessage,
  target: URL,
  injected: Record<string, string>,
  preserveOrigin: boolean,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [['host', target.host]];
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (skippedPreviewUpgradeRequestHeaders.has(lower)) continue;
    if (lower === 'origin' && !preserveOrigin) continue;
    if (Array.isArray(value)) for (const item of value) headers.push([key, item]);
    else if (value !== undefined) headers.push([key, value]);
  }
  const cookie = previewCookieHeader(config, stringHeader(request.headers.cookie) ?? null);
  if (cookie) headers.push(['cookie', cookie]);
  const origin = previewUpstreamOrigin(target);
  if (!preserveOrigin && origin) headers.push(['origin', origin]);
  for (const [key, value] of Object.entries(injected)) {
    const lower = key.toLowerCase();
    if (lower === 'host') {
      const hostIndex = headers.findIndex(([headerName]) => headerName.toLowerCase() === 'host');
      if (hostIndex >= 0) headers[hostIndex] = ['host', value];
      else headers.push(['host', value]);
      continue;
    }
    headers.push([key, value]);
  }
  return headers;
}

function previewUpstreamOrigin(target: URL): string | null {
  if (target.protocol === 'http:' || target.protocol === 'https:') return target.origin;
  if (target.protocol === 'ws:') return `http://${target.host}`;
  if (target.protocol === 'wss:') return `https://${target.host}`;
  return null;
}

function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name || !rest.length) continue;
    cookies[name] = rest.join('=');
  }
  return cookies;
}

function previewCookieHeader(config: AppConfig, header: string | null): string | undefined {
  if (!header) return undefined;
  const cookies = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split('=')[0]?.trim();
      return name && !isPlatformCookieName(config, name);
    });
  return cookies.length ? cookies.join('; ') : undefined;
}

function isPlatformCookieName(config: AppConfig, name: string): boolean {
  return name === config.previewCookieName || name === config.sessionCookieName;
}

function previewSetCookieHeaders(input: Headers): string[] {
  const getSetCookie = (input as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') return getSetCookie.call(input);
  const header = input.get('set-cookie');
  return header ? splitSetCookieHeader(header) : [];
}

function splitSetCookieHeader(header: string): string[] {
  return header
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function sanitizePreviewSetCookie(config: AppConfig, header: string): string | undefined {
  const [nameValue, ...attributes] = header.split(';');
  const name = nameValue?.split('=')[0]?.trim();
  if (!nameValue || !name || isPlatformCookieName(config, name)) return undefined;
  const sanitized = [nameValue.trim()];
  for (const attribute of attributes) {
    const value = attribute.trim();
    if (!value || value.toLowerCase().startsWith('domain=')) continue;
    sanitized.push(value);
  }
  return sanitized.join('; ');
}

async function readPreviewAuthUser(
  config: AppConfig,
  store: AppStore,
  token: string | null,
  host: string | undefined,
  options: { kind: PreviewAuthToken['kind']; renew?: boolean },
): Promise<PreviewAuthorization | null> {
  if (!token) return null;
  const payload = verifyPreviewAuthToken(token, requireAuthSessionSecret(config));
  if (!payload) return null;
  if (payload.kind !== options.kind) return null;
  const hostPreview = parsePreviewHost(host, previewAllowedDomains(config));
  if (!hostPreview || hostPreview.sessionId !== payload.previewSessionId || hostPreview.port !== payload.port)
    return null;
  const user = await store.getAuthUserBySession({ sessionId: payload.authSessionId, now: new Date() });
  if (user?.id !== payload.userId) return null;
  const session = await store.getSession(payload.previewSessionId);
  if (!session) return null;
  const auth: RequestAuthorization = { bypass: false, user };
  if (!canReadSession(auth, session)) return null;
  const cookie = options.renew ? renewedPreviewCookie(config, payload) : undefined;
  return { user, canWrite: canWriteSession(auth, session), ...(cookie ? { cookie } : {}) };
}

function createPreviewCookieToken(config: AppConfig, payload: PreviewAuthToken): string {
  const now = Math.floor(Date.now() / 1000);
  return signPreviewAuthToken(
    {
      kind: 'cookie',
      authSessionId: payload.authSessionId,
      previewSessionId: payload.previewSessionId,
      port: payload.port,
      userId: payload.userId,
      exp: Math.min(now + previewCookieMaxAgeSeconds, payload.grantExp),
      grantExp: payload.grantExp,
    },
    requireAuthSessionSecret(config),
  );
}

function renewedPreviewCookie(config: AppConfig, payload: PreviewAuthToken): string | undefined {
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp - now > previewCookieMaxAgeSeconds / 2) return undefined;
  const exp = Math.min(now + previewCookieMaxAgeSeconds, payload.grantExp);
  if (exp <= now) return undefined;
  const token = signPreviewAuthToken({ ...payload, exp }, requireAuthSessionSecret(config));
  return createPreviewCookie(config, token, exp - now);
}

function isTrustedPreviewRequest(config: AppConfig, c: Context): boolean {
  if (!requiresPreviewWriteAccess(c.req.method)) return true;
  const secFetchSite = c.req.header('sec-fetch-site')?.toLowerCase();
  if (secFetchSite === 'cross-site') return false;
  const origin = c.req.header('origin');
  if (!origin) return true;
  return trustedPreviewOrigins(previewRequestHosts(config, c)).has(origin);
}

function isTrustedPreviewUpgrade(config: AppConfig, request: IncomingMessage): boolean {
  if (config.apiAuthMode !== 'session') return true;
  const secFetchSite = stringHeader(request.headers['sec-fetch-site'])?.toLowerCase();
  if (secFetchSite === 'cross-site') return false;
  const origin = stringHeader(request.headers.origin);
  if (!origin) return true;
  return trustedPreviewOrigins(previewNodeRequestHosts(config, request)).has(origin);
}

function requiresPreviewWriteAccess(method: string | undefined): boolean {
  return !new Set(['GET', 'HEAD', 'OPTIONS']).has((method ?? '').toUpperCase());
}

function trustedPreviewOrigins(hosts: string[]): Set<string> {
  const origins = new Set<string>();
  for (const host of hosts) {
    origins.add(new URL(`http://${host}`).origin);
    origins.add(new URL(`https://${host}`).origin);
  }
  return origins;
}

function previewAuthRedirect(value: string | undefined): string {
  if (!value || !value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  return value;
}

function joinUrlPath(basePath: string, suffix: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const rest = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${base}${rest}` || '/';
}

function previewRequestHeaders(config: AppConfig, input: Headers, injected: Record<string, string> = {}): Headers {
  const headers = new Headers();
  for (const [key, value] of input.entries()) {
    const lower = key.toLowerCase();
    if (skippedPreviewProxyRequestHeaders.has(lower)) continue;
    headers.set(key, value);
  }
  const cookie = previewCookieHeader(config, input.get('cookie'));
  if (cookie) headers.set('cookie', cookie);
  headers.set('accept-encoding', 'identity');
  for (const [key, value] of Object.entries(injected)) headers.set(key, value);
  return headers;
}

function previewResponseHeaders(config: AppConfig, input: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of input.entries()) {
    const lower = key.toLowerCase();
    if (['connection', 'content-length', 'set-cookie', 'transfer-encoding'].includes(lower)) continue;
    headers.set(key, value);
  }
  for (const cookie of previewSetCookieHeaders(input)) {
    const sanitized = sanitizePreviewSetCookie(config, cookie);
    if (sanitized) headers.append('set-cookie', sanitized);
  }
  return headers;
}

function requestHeadersToNodeHeaders(input: Headers): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of input.entries()) {
    headers[name] = value;
  }
  return headers;
}

function previewResponseHeadersFromNodeHeaders(config: AppConfig, input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const header of value) {
        headers.append(name, header);
      }
      continue;
    }
    headers.append(name, value);
  }
  return previewResponseHeaders(config, headers);
}
