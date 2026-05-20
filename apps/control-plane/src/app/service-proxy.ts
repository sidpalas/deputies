import net, { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Context } from 'hono';
import { isTrustedCookieAuthRequest } from '../auth/middleware.js';
import { readSessionId, sessionCookieName } from '../auth/session.js';
import { requireApiBearerToken, type AppConfig } from '../config/index.js';
import type { SandboxPreviewUrl, SandboxProvider } from '../sandbox/types.js';
import type { AppStore } from '../store/types.js';

type ServiceProxyServices = {
  store: AppStore;
  sessions: { get(sessionId: string): Promise<unknown | null> };
  sandboxProvider?: SandboxProvider;
};

export async function getSessionService(
  config: AppConfig,
  services: ServiceProxyServices,
  sessionId: string,
  port: number,
): Promise<SandboxPreviewUrl | null> {
  const provider = services.sandboxProvider;
  if (!provider?.getPreviewUrl || !provider.capabilities.previewUrls) return null;
  const sandbox = await services.store.getActiveSandbox(sessionId, provider.name);
  if (!sandbox) return null;
  const health = await provider.health(sandbox);
  if (health.status !== 'ready') return null;
  const secrets = await services.store.getSandboxSecrets(sandbox.id);
  const preview = await provider.getPreviewUrl({
    providerSandboxId: sandbox.providerSandboxId,
    sessionId,
    port,
    secrets,
  });
  return preview && (await isAllowedPreviewTarget(config, provider.name, preview.targetUrl)) ? preview : null;
}

export async function isActiveServiceSandbox(
  services: ServiceProxyServices,
  sessionId: string,
  providerSandboxId: string,
): Promise<boolean> {
  const provider = services.sandboxProvider;
  if (!provider) return false;
  const sandbox = await services.store.getActiveSandbox(sessionId, provider.name);
  return sandbox?.providerSandboxId === providerSandboxId;
}

export function serializeService(
  c: Context,
  config: AppConfig,
  sessionId: string,
  preview: SandboxPreviewUrl,
  metadata: { label?: string; path?: string } = {},
  sandboxTiming: { shutdownAt?: Date; keepaliveUntil?: Date; maxKeepaliveUntil?: Date } = {},
) {
  const url = previewUrl(c, config, sessionId, preview.port, metadata.path);
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

export async function proxyService(
  c: Context,
  config: AppConfig,
  sessionId: string,
  port: number,
  preview: SandboxPreviewUrl,
): Promise<Response> {
  const target = previewTargetUrl(c, preview.targetUrl);
  const request = c.req.raw;
  const response = await fetch(target, {
    method: request.method,
    headers: previewRequestHeaders(request.headers, preview.targetHeaders),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const headers = previewResponseHeaders(response.headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function parseServiceHostFromRequest(config: AppConfig, c: Context): { sessionId: string; port: number } | null {
  return parsePreviewHostFromHosts(previewRequestHosts(config, c), previewAllowedDomains(config, c));
}

export async function isAuthorizedRequest(
  config: AppConfig,
  store: AppStore,
  c: Context,
  options: { role?: 'admin' } = {},
): Promise<boolean> {
  if (config.apiAuthMode === 'none') return true;
  if (config.apiAuthMode === 'bearer')
    return c.req.header('authorization') === `Bearer ${requireApiBearerToken(config)}`;
  if (!isTrustedCookieAuthRequest(c, config)) return false;
  const authSessionId = readSessionId(c);
  const user = authSessionId ? await store.getAuthUserBySession({ sessionId: authSessionId, now: new Date() }) : null;
  return Boolean(user && (!options.role || user.role === options.role));
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
    socket.destroy();
    return;
  }

  const { sessionId, port } = hostPreview;
  if (
    !isTrustedUpgradeRequest(config, request) ||
    !(await isAuthorizedUpgrade(config, services, request, { role: 'admin' }))
  ) {
    socket.destroy();
    return;
  }
  const session = await services.sessions.get(sessionId);
  if (!session) {
    socket.destroy();
    return;
  }
  const preview = await getSessionService(config, services, sessionId, port);
  if (!preview) {
    socket.destroy();
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
  if (preview.targetHeaders) upgradeInput.targetHeaders = preview.targetHeaders;
  proxyPreviewUpgrade(upgradeInput);
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
  if (provider === 'daytona') return target.protocol === 'https:' && (await isAllowedPublicHostname(target.hostname));
  return isAllowedPublicHostname(target.hostname);
}

function isAllowedDockerPreviewTarget(config: AppConfig, target: URL): boolean {
  const allowedHosts = new Set(['localhost', '127.0.0.1', config.dockerSandboxBridgeHost]);
  return target.protocol === 'http:' && allowedHosts.has(target.hostname.toLowerCase());
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
  target.search = incoming.search;
  return target.toString();
}

function previewUrl(c: Context, config: AppConfig, sessionId: string, port: number, path = '/'): string {
  const baseUrl = config.webBaseUrl ? new URL(config.webBaseUrl) : null;
  const requestUrl = new URL(c.req.url);
  const requestHost = baseUrl?.host ?? previewRequestHost(config, c) ?? requestUrl.host;
  const protocol =
    baseUrl?.protocol.replace(/:$/, '') ?? c.req.header('x-forwarded-proto') ?? requestUrl.protocol.replace(/:$/, '');
  const domain = config.serviceBaseDomain ?? previewDomainFromHost(requestHost);
  const suffix = path.startsWith('/') ? path.slice(1) : path;
  if (!domain) throw new Error('SERVICE_BASE_DOMAIN is required for service previews');
  return `${protocol}://${previewHostLabel(sessionId, port)}.${domain}/${suffix}`;
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
  options: { role?: 'admin' } = {},
): Promise<boolean> {
  if (config.apiAuthMode === 'none') return true;
  if (config.apiAuthMode === 'bearer')
    return request.headers.authorization === `Bearer ${requireApiBearerToken(config)}`;
  const authSessionId = parseCookieHeader(request.headers.cookie ?? '')[sessionCookieName];
  const user = authSessionId
    ? await services.store.getAuthUserBySession({ sessionId: authSessionId, now: new Date() })
    : null;
  return Boolean(user && (!options.role || user.role === options.role));
}

function isTrustedUpgradeRequest(config: AppConfig, request: IncomingMessage): boolean {
  if (config.apiAuthMode !== 'session') return true;
  const secFetchSite = stringHeader(request.headers['sec-fetch-site'])?.toLowerCase();
  if (secFetchSite === 'cross-site') return false;

  const origin = stringHeader(request.headers.origin);
  if (!origin) return true;
  return trustedUpgradeOrigins(config, request).has(origin);
}

function trustedUpgradeOrigins(config: AppConfig, request: IncomingMessage): Set<string> {
  const origins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
  for (const host of previewNodeRequestHosts(config, request)) {
    origins.add(new URL(request.url ?? '/', `http://${host}`).origin);
    origins.add(new URL(request.url ?? '/', `https://${host}`).origin);
  }
  if (config.webBaseUrl) origins.add(new URL(config.webBaseUrl).origin);
  return origins;
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function proxyPreviewUpgrade(input: {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  targetUrl: string;
  targetHeaders?: Record<string, string>;
  preserveOrigin: boolean;
}): void {
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
    upstream.write(upgradeRequestHead(input.request, target, input.targetHeaders, input.preserveOrigin));
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
  request: IncomingMessage,
  target: URL,
  injected: Record<string, string> = {},
  preserveOrigin = false,
): string {
  const headers = previewUpgradeHeaders(request, target, injected, preserveOrigin);
  const path = `${target.pathname || '/'}${target.search}`;
  return [
    `${request.method ?? 'GET'} ${path} HTTP/1.1`,
    ...headers.map(([key, value]) => `${key}: ${value}`),
    '',
    '',
  ].join('\r\n');
}

function previewUpgradeHeaders(
  request: IncomingMessage,
  target: URL,
  injected: Record<string, string>,
  preserveOrigin: boolean,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [['host', target.host]];
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (['authorization', 'cookie', 'host', 'content-length'].includes(lower)) continue;
    if (lower === 'origin' && !preserveOrigin) continue;
    if (Array.isArray(value)) for (const item of value) headers.push([key, item]);
    else if (value !== undefined) headers.push([key, value]);
  }
  const origin = previewUpstreamOrigin(target);
  if (!preserveOrigin && origin) headers.push(['origin', origin]);
  for (const [key, value] of Object.entries(injected)) headers.push([key, value]);
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

function joinUrlPath(basePath: string, suffix: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const rest = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${base}${rest}` || '/';
}

function previewRequestHeaders(input: Headers, injected: Record<string, string> = {}): Headers {
  const headers = new Headers();
  for (const [key, value] of input.entries()) {
    const lower = key.toLowerCase();
    if (['authorization', 'cookie', 'host', 'connection', 'content-length'].includes(lower)) continue;
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(injected)) headers.set(key, value);
  return headers;
}

function previewResponseHeaders(input: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of input.entries()) {
    const lower = key.toLowerCase();
    if (['connection', 'content-encoding', 'content-length', 'set-cookie', 'transfer-encoding'].includes(lower))
      continue;
    headers.set(key, value);
  }
  return headers;
}
