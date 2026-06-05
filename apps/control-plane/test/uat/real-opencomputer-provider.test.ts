import {
  OpenComputerSandboxProvider,
  type OpenComputerSandboxProviderOptions,
} from '../../src/sandbox/opencomputer.js';
import type { SandboxHandle, SandboxHealth } from '../../src/sandbox/types.js';

const enabled = process.env.RUN_REAL_OPENCOMPUTER_SANDBOX_UAT === 'true';
const hasRequiredEnv = Boolean(process.env.OPENCOMPUTER_API_KEY && process.env.OPENCOMPUTER_SNAPSHOT);

describe.skipIf(!enabled || !hasRequiredEnv)('real OpenComputer provider UAT', () => {
  let provider: OpenComputerSandboxProvider;
  let sandbox: SandboxHandle | undefined;

  beforeEach(() => {
    provider = new OpenComputerSandboxProvider(openComputerOptions());
  });

  afterEach(async () => {
    if (!sandbox) return;
    await provider.destroy(sandbox).catch(() => undefined);
    sandbox = undefined;
  });

  it('runs provider lifecycle, exec, filesystem, and native previews', async () => {
    await expect(provider.check()).resolves.toMatchObject({ status: 'ready' });

    sandbox = await provider.create({ sessionId: `real-opencomputer-provider-uat-${Date.now()}` });
    await expect(provider.health(sandbox)).resolves.toMatchObject({ status: 'ready' });

    const exec = await sandbox.exec({
      command: 'printf opencomputer-exec',
      cwd: sandbox.workspacePath,
      timeoutMs: 30_000,
    });
    expect(exec).toMatchObject({ exitCode: 0, stdout: 'opencomputer-exec', stderr: '' });

    const gitEgress = await sandbox.exec({
      command: 'git ls-remote --heads https://github.com/sidpalas/deputies-dev-repo.git | head -n 1',
      cwd: sandbox.workspacePath,
      timeoutMs: 60_000,
    });
    expect(gitEgress.exitCode).toBe(0);
    expect(gitEgress.stdout).toContain('refs/heads/');
    expect(gitEgress.stderr).toBe('');

    const filePath = `${sandbox.workspacePath}/uat.txt`;
    await expect(sandbox.fs?.exists(`${sandbox.workspacePath}/AGENTS.md`)).resolves.toBe(false);
    await expect(sandbox.fs?.exists(`${sandbox.workspacePath}/.agents/skills`)).resolves.toBe(false);
    await sandbox.fs?.writeFile(filePath, 'opencomputer-file');
    await expect(sandbox.fs?.readFile(filePath)).resolves.toBe('opencomputer-file');
    await expect(sandbox.fs?.stat(filePath)).resolves.toMatchObject({ isFile: true, size: 17 });

    await sandbox.fs?.mkdir(`${sandbox.workspacePath}/nested`, { recursive: true });
    await expect(sandbox.fs?.readdir(sandbox.workspacePath)).resolves.toEqual(
      expect.arrayContaining(['nested', 'uat.txt']),
    );

    const previewDir = `${sandbox.workspacePath}/preview`;
    await sandbox.fs?.mkdir(previewDir, { recursive: true });
    await sandbox.fs?.writeFile(`${previewDir}/index.html`, 'opencomputer-preview');
    const startServer = await sandbox.exec({
      command: `nohup python3 -m http.server 8123 --bind 0.0.0.0 --directory ${quoteShell(
        previewDir,
      )} >/tmp/deputies-opencomputer-uat-preview.log 2>&1 &`,
      timeoutMs: 30_000,
    });
    expect(startServer.exitCode).toBe(0);

    const preview = await provider.getServiceEndpoint({
      providerSandboxId: sandbox.providerSandboxId,
      sessionId: sandbox.sessionId,
      port: 8123,
    });
    expect(preview?.targetUrl).toMatch(/^https:\/\//);
    if (!preview) throw new Error('OpenComputer preview URL was not returned');
    await waitForPreviewText(preview.targetUrl, preview.targetHeaders, 'opencomputer-preview');

    await provider.refreshKeepalive({
      providerSandboxId: sandbox.providerSandboxId,
      sessionId: sandbox.sessionId,
      durationMs: 120_000,
    });

    await provider.stop(sandbox);
    await waitForHealth(provider, sandbox, 'stopped');
    await provider.start(sandbox);
    await waitForHealth(provider, sandbox, 'ready');

    const reconnected = await provider.connect(sandbox);
    await expect(reconnected.fs?.readFile(filePath)).resolves.toBe('opencomputer-file');
  }, 300_000);
});

function openComputerOptions(): OpenComputerSandboxProviderOptions {
  const options: OpenComputerSandboxProviderOptions = {
    idleTimeoutMs: 60_000,
    workspacePath: process.env.SANDBOX_WORKSPACE_PATH ?? '/workspace',
  };
  if (process.env.OPENCOMPUTER_API_KEY) options.apiKey = process.env.OPENCOMPUTER_API_KEY;
  if (process.env.OPENCOMPUTER_API_URL) options.apiUrl = process.env.OPENCOMPUTER_API_URL;
  if (process.env.OPENCOMPUTER_SNAPSHOT) options.snapshot = process.env.OPENCOMPUTER_SNAPSHOT;
  if (process.env.OPENCOMPUTER_SECRET_STORE) options.secretStore = process.env.OPENCOMPUTER_SECRET_STORE;
  if (process.env.OPENCOMPUTER_CPU_COUNT) options.cpuCount = Number(process.env.OPENCOMPUTER_CPU_COUNT);
  if (process.env.OPENCOMPUTER_MEMORY_MB) options.memoryMB = Number(process.env.OPENCOMPUTER_MEMORY_MB);
  if (process.env.OPENCOMPUTER_DISK_MB) options.diskMB = Number(process.env.OPENCOMPUTER_DISK_MB);
  return options;
}

async function waitForHealth(
  provider: OpenComputerSandboxProvider,
  sandbox: SandboxHandle,
  status: SandboxHealth['status'],
): Promise<void> {
  await waitFor(async () => {
    const health = await provider.health(sandbox);
    return health.status === status;
  }, `OpenComputer sandbox did not become ${status}`);
}

async function waitForPreviewText(
  url: string,
  headers: Record<string, string> | undefined,
  text: string,
): Promise<void> {
  await waitFor(async () => {
    const init: RequestInit = {};
    if (headers) init.headers = headers;
    const response = await fetch(url, init).catch(() => null);
    if (!response?.ok) return false;
    return (await response.text()).includes(text);
  }, `OpenComputer preview did not serve ${text}`);
}

async function waitFor(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(lastError instanceof Error ? `${message}: ${lastError.message}` : message);
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
