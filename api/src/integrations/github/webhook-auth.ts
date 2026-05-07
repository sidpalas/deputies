import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubWebhookSignature(input: {
  signature: string | undefined;
  body: string;
  secret: string;
}): boolean {
  if (!input.signature?.startsWith('sha256=')) return false;
  return safeEqual(input.signature, createGitHubWebhookSignature({ body: input.body, secret: input.secret }));
}

export function createGitHubWebhookSignature(input: { body: string; secret: string }): string {
  return `sha256=${createHmac('sha256', input.secret).update(input.body).digest('hex')}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
