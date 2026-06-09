import type { Context } from 'hono';

export function writeError(
  c: Context,
  statusCode: number,
  error: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return c.json({ error, message, ...(details ? { details } : {}) }, statusCode as never);
}
