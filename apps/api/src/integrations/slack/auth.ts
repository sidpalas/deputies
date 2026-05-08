import { createHmac, timingSafeEqual } from 'node:crypto';

const maxTimestampSkewSeconds = 300;

export function verifySlackSignature(input: {
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  signingSecret: string;
  nowSeconds?: number;
}): boolean {
  if (!input.signature || !input.timestamp) return false;
  const timestamp = Number(input.timestamp);
  if (!Number.isInteger(timestamp)) return false;

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > maxTimestampSkewSeconds) return false;

  const expected = createSlackSignature({ body: input.body, timestamp: input.timestamp, signingSecret: input.signingSecret });
  return safeEqual(input.signature, expected);
}

export function createSlackSignature(input: { body: string; timestamp: string; signingSecret: string }): string {
  const base = `v0:${input.timestamp}:${input.body}`;
  return `v0=${createHmac('sha256', input.signingSecret).update(base).digest('hex')}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
