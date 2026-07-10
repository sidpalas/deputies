import { SuperserveSandboxProvider } from '../../src/sandbox/superserve.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';

const enabled = process.env.RUN_REAL_SUPERSERVE_SANDBOX_UAT === 'true';
const template = process.env.SUPERSERVE_TEMPLATE;
const hasRequiredEnv = Boolean(process.env.SUPERSERVE_API_KEY && template);
const sessionId = 'real-superserve-sandbox-uat';
const previewServerCommand =
  "node -e \"require('http').createServer((req,res)=>res.end(req.url==='/authorization'?(req.headers.authorization||''):'preview ok')).listen(4534,'0.0.0.0')\" >/tmp/deputies-preview-uat.log 2>&1 &";

describe.skipIf(!enabled)('real Superserve sandbox UAT', () => {
  let provider: SuperserveSandboxProvider;
  let sandbox: SandboxHandle | undefined;

  beforeAll(() => {
    if (!hasRequiredEnv) {
      throw new Error('SUPERSERVE_API_KEY and SUPERSERVE_TEMPLATE are required for the live Superserve UAT');
    }
  });

  beforeEach(() => {
    provider = new SuperserveSandboxProvider({
      apiKey: process.env.SUPERSERVE_API_KEY!,
      ...(process.env.SUPERSERVE_BASE_URL ? { baseUrl: process.env.SUPERSERVE_BASE_URL } : {}),
      template: template!,
      workspacePath: '/workspace',
    });
  });

  afterEach(async () => {
    if (sandbox) {
      await provider.destroy(sandbox);
      await expect(provider.health(sandbox)).resolves.toMatchObject({ status: 'missing' });
    }
    sandbox = undefined;
  });

  it('executes commands, persists files across pause/resume, and serves a bridge preview URL', async () => {
    sandbox = await provider.create({ sessionId });

    await expect(
      sandbox.exec({ command: 'printf superserve-ok', cwd: sandbox.workspacePath, timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'superserve-ok' });

    await sandbox.fs?.writeFile('smoke.txt', 'hello');
    await expect(sandbox.fs?.readFile('/workspace/smoke.txt')).resolves.toBe('hello');

    await provider.stop(sandbox);
    await expect(provider.health(sandbox)).resolves.toMatchObject({ status: 'stopped' });
    await provider.start(sandbox);
    const connectInput = {
      providerSandboxId: sandbox.providerSandboxId,
      sessionId,
    };
    if (sandbox.secrets) Object.assign(connectInput, { secrets: sandbox.secrets });
    sandbox = await provider.connect(connectInput);
    await expect(sandbox.fs?.readFile('smoke.txt')).resolves.toBe('hello');

    await expect(
      sandbox.exec({ command: previewServerCommand, cwd: sandbox.workspacePath, timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const endpointInput = {
      providerSandboxId: sandbox.providerSandboxId,
      sessionId,
      port: 4534,
    };
    if (sandbox.secrets) Object.assign(endpointInput, { secrets: sandbox.secrets });
    const preview = await provider.getServiceEndpoint?.(endpointInput);
    if (!preview) throw new Error('Expected Superserve preview URL');
    await waitForPreview(preview.targetUrl, preview.targetHeaders, 'preview ok');
    await expect(fetchPreview(`${preview.targetUrl}/authorization`, preview.targetHeaders)).resolves.toBe('');
    await expect(fetch(preview.targetUrl)).resolves.toMatchObject({ status: 401 });
  }, 240_000);
});

async function waitForPreview(
  url: string,
  headers: Record<string, string> | undefined,
  expected: string,
): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(url, headers ? { headers } : undefined).catch(() => null);
    return Boolean(response?.ok && (await response.text()) === expected);
  }, 60_000);
}

async function fetchPreview(url: string, headers: Record<string, string> | undefined): Promise<string> {
  const response = await fetch(url, headers ? { headers } : undefined);
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
