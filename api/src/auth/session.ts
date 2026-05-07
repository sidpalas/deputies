import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { AppConfig } from '../config/index.js';

export const sessionCookieName = 'dev_deputies_session';
export const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;

export function createSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function createSessionCookie(input: { sessionId: string; secure: boolean }): string {
  return `${sessionCookieName}=${input.sessionId}; Path=/; Max-Age=${sessionMaxAgeSeconds}; HttpOnly; SameSite=Lax${input.secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(config: AppConfig): string {
  return `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${config.authCookieSecure ? '; Secure' : ''}`;
}

export function readSessionId(c: Context): string | null {
  return parseCookies(c.req.header('cookie') ?? '')[sessionCookieName] ?? null;
}

export type OAuthState = {
  provider: 'github';
  exp: number;
};

export function signOAuthState(state: OAuthState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
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

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name || !rest.length) continue;
    cookies[name] = rest.join('=');
  }
  return cookies;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
