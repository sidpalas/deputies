#!/usr/bin/env node
import { get } from 'node:http';

export function checkSandboxBridgeHealth(url: string, token: string, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { authorization: `Bearer ${token}` } }, (response) => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(new Error(`Sandbox bridge health check returned ${response.statusCode ?? 'no status'}`));
    });
    request.once('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Sandbox bridge health check timed out')));
  });
}

async function main(): Promise<void> {
  const url = process.env.HEALTH_URL;
  const token = process.env.DEPUTIES_SANDBOX_TOKEN;
  if (!url || !token) throw new Error('HEALTH_URL and DEPUTIES_SANDBOX_TOKEN are required');
  await checkSandboxBridgeHealth(url, token);
}

if (process.argv[1]?.endsWith('/healthcheck.js')) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Sandbox bridge health check failed'}\n`);
    process.exitCode = 1;
  });
}
