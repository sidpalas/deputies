import { TensorlakeSandboxProvider } from '../../src/sandbox/tensorlake.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';

const enabled = process.env.RUN_REAL_TENSORLAKE_SANDBOX_UAT === 'true';
const image = process.env.TENSORLAKE_REGISTERED_IMAGE;
const hasRequiredEnv = Boolean(process.env.TENSORLAKE_API_KEY && image);
const sessionId = 'real-tensorlake-sandbox-uat';
const previewServerCommand =
  "node -e \"require('http').createServer((req,res)=>res.end(req.url==='/authorization'?(req.headers.authorization||''):'preview ok')).listen(4534,'0.0.0.0')\" >/tmp/deputies-preview-uat.log 2>&1 &";

describe.skipIf(!enabled || !hasRequiredEnv)('real Tensorlake sandbox UAT', () => {
  let provider: TensorlakeSandboxProvider;
  let sandbox: SandboxHandle | undefined;

  beforeEach(() => {
    const options = {
      apiKey: process.env.TENSORLAKE_API_KEY!,
      image: image!,
      workspacePath: '/workspace',
      idleTimeoutMs: 600_000,
    };
    provider = new TensorlakeSandboxProvider(options);
  });

  afterEach(async () => {
    if (sandbox) await provider.destroy(sandbox).catch(() => undefined);
    sandbox = undefined;
  });

  it('executes commands, persists files, and serves a preview URL', async () => {
    sandbox = await provider.create({ sessionId });

    await expect(
      sandbox.exec({ command: 'printf tensorlake-ok', cwd: sandbox.workspacePath, timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'tensorlake-ok' });

    await sandbox.fs?.writeFile('/workspace/smoke.txt', 'hello');
    await expect(sandbox.fs?.readFile('/workspace/smoke.txt')).resolves.toBe('hello');
    await sandbox.fs?.writeFile('relative-smoke.txt', 'relative hello');
    await expect(sandbox.fs?.readFile('/workspace/relative-smoke.txt')).resolves.toBe('relative hello');

    await provider.stop(sandbox);
    await expect(provider.health(sandbox)).resolves.toMatchObject({ status: 'stopped' });
    await provider.start(sandbox);
    sandbox = await provider.connect({ providerSandboxId: sandbox.providerSandboxId, sessionId });
    await expect(sandbox.fs?.readFile('relative-smoke.txt')).resolves.toBe('relative hello');

    await expect(
      sandbox.exec({ command: previewServerCommand, cwd: sandbox.workspacePath, timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const preview = await provider.getServiceEndpoint?.({
      providerSandboxId: sandbox.providerSandboxId,
      sessionId,
      port: 4534,
    });
    expect(preview).toMatchObject({ port: 4534 });
    if (!preview) throw new Error('Expected preview URL');

    await waitForPreview(preview.targetUrl, preview.targetHeaders, 'preview ok');
    await expect(fetchPreview(`${preview.targetUrl}/authorization`, preview.targetHeaders)).resolves.toBe('');
  }, 180_000);
});

async function waitForPreview(
  url: string,
  headers: Record<string, string> | undefined,
  expected: string,
): Promise<void> {
  await waitFor(async () => {
    const request = headers ? { headers } : undefined;
    const response = await fetch(url, request).catch(() => null);
    if (!response?.ok) return false;
    return (await response.text()) === expected;
  }, 30_000);
}

async function fetchPreview(url: string, headers: Record<string, string> | undefined): Promise<string> {
  const request = headers ? { headers } : undefined;
  const response = await fetch(url, request);
  if (!response.ok) throw new Error(`Preview request failed with HTTP ${response.status}`);
  return response.text();
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
