import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { AppConfig } from '../config/index.js';

export const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;
export const previewBootstrapMaxAgeSeconds = 2 * 60;
export const previewCookieMaxAgeSeconds = 30 * 60;
export const previewGrantMaxAgeSeconds = 2 * 60 * 60;

export type PreviewAuthToken = {
  kind: 'bootstrap' | 'cookie';
  authSessionId: string;
  previewSessionId: string;
  port: number;
  userId: string;
  exp: number;
  grantExp: number;
};

export function createSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function createSessionCookie(config: AppConfig, sessionId: string): string {
  return `${config.sessionCookieName}=${sessionId}; Path=/; Max-Age=${sessionMaxAgeSeconds}; HttpOnly; SameSite=${formatSameSite(config)}${config.authCookieSecure ? '; Secure' : ''}`;
}

export function clearSessionCookie(config: AppConfig): string {
  return `${config.sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=${formatSameSite(config)}${config.authCookieSecure ? '; Secure' : ''}`;
}

export function readSessionId(config: AppConfig, c: Context): string | null {
  return parseCookies(c.req.header('cookie') ?? '')[config.sessionCookieName] ?? null;
}

export function readPreviewCookie(config: AppConfig, c: Context): string | null {
  return parseCookies(c.req.header('cookie') ?? '')[config.previewCookieName] ?? null;
}

export function createPreviewCookie(
  config: AppConfig,
  token: string,
  maxAgeSeconds = previewCookieMaxAgeSeconds,
  domain?: string,
): string {
  return `${config.previewCookieName}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=${formatSameSite(config)}${config.authCookieSecure ? '; Secure' : ''}${domain ? `; Domain=${domain}` : ''}`;
}

export type OAuthState = {
  provider: 'github';
  exp: number;
};

export function signOAuthState(state: OAuthState, secret: string): string {
  return signJsonToken(state, secret);
}

export function verifyOAuthState(token: string, secret: string, now: Date = new Date()): OAuthState | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return null;

  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<OAuthState>;
    if (value.provider !== 'github' || typeof value.exp !== 'number') return null;
    if (value.exp <= Math.floor(now.getTime() / 1000)) return null;
    return { provider: value.provider, exp: value.exp };
  } catch {
    return null;
  }
}

export function signPreviewAuthToken(token: PreviewAuthToken, secret: string): string {
  return signJsonToken(token, secret);
}

export function verifyPreviewAuthToken(token: string, secret: string, now: Date = new Date()): PreviewAuthToken | null {
  const value = verifyJsonToken<Partial<PreviewAuthToken>>(token, secret);
  if (!value) return null;
  if (value.kind !== 'bootstrap' && value.kind !== 'cookie') return null;
  if (typeof value.authSessionId !== 'string' || !value.authSessionId) return null;
  if (typeof value.previewSessionId !== 'string' || !value.previewSessionId) return null;
  if (typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port <= 0 || value.port > 65535) {
    return null;
  }
  if (typeof value.userId !== 'string' || !value.userId) return null;
  if (typeof value.exp !== 'number' || value.exp <= Math.floor(now.getTime() / 1000)) return null;
  if (typeof value.grantExp !== 'number' || value.grantExp <= Math.floor(now.getTime() / 1000)) return null;
  return {
    kind: value.kind,
    authSessionId: value.authSessionId,
    previewSessionId: value.previewSessionId,
    port: value.port,
    userId: value.userId,
    exp: value.exp,
    grantExp: value.grantExp,
  };
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name || !rest.length) continue;
    cookies[name] = rest.join('=');
  }
  return cookies;
}

function signJsonToken(value: unknown, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyJsonToken<T>(token: string, secret: string): T | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return null;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function formatSameSite(config: AppConfig): 'Lax' | 'None' {
  return config.authCookieSameSite === 'none' ? 'None' : 'Lax';
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
