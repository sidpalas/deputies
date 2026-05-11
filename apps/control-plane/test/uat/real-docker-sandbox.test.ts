import { spawn } from 'node:child_process';
import { DockerSandboxProvider, InProcessDockerOrchestrator } from '../../src/sandbox/docker.js';
import { SandboxLifecycleService } from '../../src/sandbox/service.js';
import type { CreateSandboxRecord, SandboxRecord, SandboxStore } from '../../src/store/types.js';

const enabled = process.env.RUN_REAL_DOCKER_SANDBOX_UAT === 'true';
const image = process.env.DOCKER_SANDBOX_IMAGE ?? 'deputies-sandbox:local';
const sessionId = 'real-docker-sandbox-uat';

describe.skipIf(!enabled)('real Docker sandbox UAT', () => {
  let provider: DockerSandboxProvider;
  let store: MemorySandboxStore;
  let sandboxRecord: SandboxRecord | undefined;

  beforeEach(() => {
    provider = new DockerSandboxProvider({ orchestrator: new InProcessDockerOrchestrator({ image }) });
    store = new MemorySandboxStore();
  });

  afterEach(async () => {
    if (sandboxRecord) await provider.destroy(sandboxRecord).catch(() => undefined);
    await cleanupDockerSandboxes();
    sandboxRecord = undefined;
  });

  it('reconnects after stop/start with refreshed bridge metadata', async () => {
    await requireDockerImage(image);
    const lifecycle = new SandboxLifecycleService(store, provider);

    const first = await lifecycle.ensure(sessionId);
    sandboxRecord = first.record;
    expect(first.created).toBe(true);
    await first.sandbox.fs?.writeFile('resume.txt', 'kept');
    await expect(first.sandbox.fs?.readFile('resume.txt')).resolves.toBe('kept');
    await expect(first.sandbox.exec({ command: 'printf first', cwd: first.sandbox.workspacePath, timeoutMs: 5_000 })).resolves.toMatchObject({ exitCode: 0, stdout: 'first' });

    await provider.stop(first.record);
    await store.updateSandbox({ ...first.record, status: 'stopped', updatedAt: new Date() });

    const second = await lifecycle.ensure(sessionId);
    sandboxRecord = second.record;
    expect(second.created).toBe(false);
    expect(second.sandbox.providerSandboxId).toBe(first.sandbox.providerSandboxId);
    await expect(second.sandbox.fs?.readFile('resume.txt')).resolves.toBe('kept');
    await expect(second.sandbox.exec({ command: 'printf resumed', cwd: second.sandbox.workspacePath, timeoutMs: 5_000 })).resolves.toMatchObject({ exitCode: 0, stdout: 'resumed' });
  }, 60_000);
});

class MemorySandboxStore implements SandboxStore {
  private record: SandboxRecord | undefined;

  async createSandbox(input: CreateSandboxRecord): Promise<SandboxRecord> {
    this.record = { ...input };
    return this.record;
  }

  async getActiveSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null> {
    const record = await this.listActiveSandboxes(sessionId, provider);
    return record[0] ?? null;
  }

  async listActiveSandboxes(sessionId: string, provider: string): Promise<SandboxRecord[]> {
    if (!this.record || this.record.sessionId !== sessionId || this.record.provider !== provider || this.record.destroyedAt) return [];
    if (!['ready', 'stopped', 'unhealthy'].includes(this.record.status)) return [];
    return [this.record];
  }

  async updateSandbox(record: SandboxRecord): Promise<SandboxRecord> {
    this.record = record;
    return record;
  }

  async listIdleSandboxes(): Promise<SandboxRecord[]> {
    return [];
  }

  async listStoppableSandboxes(): Promise<SandboxRecord[]> {
    return [];
  }
}

async function requireDockerImage(name: string): Promise<void> {
  const result = await docker(['image', 'inspect', name], { allowFailure: true });
  if (result.exitCode !== 0) throw new Error(`Docker image ${name} is required. Build it with: docker build -f deploy/docker/Dockerfile -t ${name} .`);
}

async function cleanupDockerSandboxes(): Promise<void> {
  const result = await docker([
    'ps',
    '-aq',
    '--filter',
    'label=deputies.sandbox-provider=docker',
    '--filter',
    `label=deputies.session-id=${sessionId}`,
  ], { allowFailure: true });
  const ids = result.stdout.trim().split('\n').filter(Boolean);
  if (!ids.length) return;
  await docker(['rm', '-f', ...ids], { allowFailure: true });
}

type DockerResult = { exitCode: number; stdout: string; stderr: string };

function docker(args: string[], options: { allowFailure?: boolean } = {}): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) reject(new Error(stderr || stdout || `docker ${args[0] ?? ''} failed`));
      else resolve({ exitCode, stdout, stderr });
    });
  });
}
