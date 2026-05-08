import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlueRunner } from '../../src/runner-flue/runner.js';
import type { FlueAgentFactory } from '../../src/runner-flue/types.js';
import { prepareRepositoryShellSetup, type RepositoryAccessProvider } from '../../src/repositories/setup.js';
import { LocalSandboxProvider } from '../../src/sandbox/local.js';
import type { SandboxExecInput, SandboxHandle } from '../../src/sandbox/types.js';
import type { NormalizedEvent } from '../../src/events/types.js';

describe('LocalSandboxProvider', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'deputies-local-sandbox-test-'));
  });

  afterEach(async () => {
    delete process.env.DEPUTIES_LOCAL_SANDBOX_TEST_SECRET;
    await rm(rootDir, { recursive: true, force: true });
  });

  it('creates a local workspace with real exec and filesystem operations', async () => {
    const provider = new LocalSandboxProvider({ rootDir });
    const sandbox = await provider.create({ sessionId: 'session-1', metadata: { owner: 'test' } });

    expect(sandbox).toMatchObject({
      provider: 'local',
      sessionId: 'session-1',
      metadata: { owner: 'test' },
      capabilities: { persistentFilesystem: true, exec: true, filesystem: true },
    });
    expect(sandbox.providerSandboxId).toBe(`local:${sandbox.workspacePath}`);
    await expect(provider.health(sandbox)).resolves.toMatchObject({ status: 'ready' });

    await sandbox.fs?.writeFile('file.txt', 'hello');
    await expect(sandbox.fs?.readFile('file.txt')).resolves.toBe('hello');
    await expect(sandbox.fs?.exists('file.txt')).resolves.toBe(true);
    await expect(sandbox.fs?.readdir('.')).resolves.toEqual(['.deputies-bin', 'file.txt']);

    await expect(sandbox.exec({ command: 'printf "$GREETING"', env: { GREETING: 'hello' } })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'hello',
      stderr: '',
    });
    const workspacePath = await realpath(sandbox.workspacePath);
    const pwd = await sandbox.exec({ command: 'pwd' });
    expect(pwd.stdout.trim()).toBe(workspacePath);
  });

  it('connects to and destroys an existing local workspace', async () => {
    const provider = new LocalSandboxProvider({ rootDir });
    const sandbox = await provider.create({ sessionId: 'session-1' });
    await sandbox.fs?.writeFile('file.txt', 'hello');

    const connected = await provider.connect({ providerSandboxId: sandbox.providerSandboxId, sessionId: 'session-1' });

    await expect(connected.fs?.readFile('file.txt')).resolves.toBe('hello');
    await provider.destroy(sandbox);
    await expect(provider.health(sandbox)).resolves.toMatchObject({ status: 'missing' });
  });

  it('rejects filesystem and cwd paths outside the workspace', async () => {
    const provider = new LocalSandboxProvider({ rootDir });
    const sandbox = await provider.create({ sessionId: 'session-1' });

    await expect(sandbox.fs?.readFile('/tmp/outside.txt')).rejects.toThrow('escapes workspace');
    await expect(sandbox.exec({ command: 'pwd', cwd: '/tmp' })).rejects.toThrow('escapes workspace');
  });

  it('does not inherit arbitrary parent environment variables', async () => {
    process.env.DEPUTIES_LOCAL_SANDBOX_TEST_SECRET = 'parent-secret';
    const provider = new LocalSandboxProvider({ rootDir });
    const sandbox = await provider.create({ sessionId: 'session-1' });

    await expect(sandbox.exec({ command: 'printf "${DEPUTIES_LOCAL_SANDBOX_TEST_SECRET:-missing}"' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'missing',
    });
    await expect(sandbox.exec({ command: 'printf "$EXPLICIT_VALUE"', env: { EXPLICIT_VALUE: 'visible' } })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'visible',
    });
  });

  it('exposes only allowlisted host commands through PATH', async () => {
    const provider = new LocalSandboxProvider({ rootDir, allowedCommands: ['git'] });
    const sandbox = await provider.create({ sessionId: 'session-1' });

    const git = await sandbox.exec({ command: 'command -v git' });
    expect(git.exitCode).toBe(0);
    expect(git.stdout.trim()).toBe(`${sandbox.workspacePath}/.deputies-bin/git`);

    const node = await sandbox.exec({ command: 'command -v node' });
    expect(node.exitCode).not.toBe(0);

    const pathOverride = await sandbox.exec({ command: 'command -v node', env: { PATH: process.env.PATH ?? '' } });
    expect(pathOverride.exitCode).not.toBe(0);
  });

  it('includes helper commands needed by package manager shims', async () => {
    const provider = new LocalSandboxProvider({ rootDir });
    const sandbox = await provider.create({ sessionId: 'session-1' });

    await expect(sandbox.exec({ command: 'dirname /tmp/example/file.txt' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: '/tmp/example\n',
    });
  });

  it('runs repository setup against a real local git remote', async () => {
    const provider = new LocalSandboxProvider({ rootDir });
    const sandbox = await provider.create({ sessionId: 'session-1' });
    const remotePath = await createLocalGitRemote(sandbox);
    const github = new LocalGitAccessProvider(remotePath);
    const setup = await prepareRepositoryShellSetup({
      context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } },
      sandbox,
      github,
    });

    expect(setup).not.toBeNull();
    const result = await sandbox.exec({ command: setup!.command, cwd: sandbox.workspacePath, env: setup!.env });

    expect(result.exitCode).toBe(0);
    await expect(sandbox.fs?.readFile('manaflow/README.md')).resolves.toBe('hello local git\n');
    await expect(sandbox.exec({ command: 'git config user.name', cwd: setup!.workspacePath })).resolves.toMatchObject({ stdout: 'Deputies\n' });
    await expect(sandbox.exec({ command: 'git remote get-url origin', cwd: setup!.workspacePath })).resolves.toMatchObject({ stdout: `${remotePath}\n` });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('ghs_secret_token');
  });

  it('runs FlueRunner startup repository setup through local sandbox shell', async () => {
    const provider = new LocalSandboxProvider({ rootDir });
    const sandbox = await provider.create({ sessionId: 'session-1' });
    const remotePath = await createLocalGitRemote(sandbox);
    const events: NormalizedEvent[] = [];
    const calls: Parameters<FlueAgentFactory['create']>[0][] = [];
    const factory: FlueAgentFactory = {
      async create(input) {
        calls.push(input);
        return {
          async shell(command, options) {
            return input.sandbox.exec(shellInput(command, options));
          },
          async session() {
            return {
              async shell(command, options) {
                return input.sandbox.exec(shellInput(command, options));
              },
              async prompt() {
                const readme = await input.sandbox.fs?.readFile('manaflow/README.md');
                return { text: `readme: ${readme?.trim()}` };
              },
              abort() {},
            };
          },
        };
      },
    };

    const result = await new FlueRunner(factory, { repositoryAccess: { github: new LocalGitAccessProvider(remotePath) } }).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'inspect repo',
      context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } },
      sandbox,
      emit: async (event) => { events.push(event); },
    });

    expect(calls[0]).toMatchObject({ cwd: `${sandbox.workspacePath}/manaflow` });
    expect(result.text).toBe('readme: hello local git');
    expect(events.map((event) => event.type)).toEqual(['run_started', 'repository_ready', 'agent_text_delta', 'run_completed']);
    expect(events[1]?.payload).toMatchObject({ owner: 'manaflow-ai', repo: 'manaflow', workspacePath: `${sandbox.workspacePath}/manaflow` });
    await expect(sandbox.fs?.readFile('manaflow/README.md')).resolves.toBe('hello local git\n');
  });
});

async function createLocalGitRemote(sandbox: SandboxHandle): Promise<string> {
  const result = await sandbox.exec({
    cwd: sandbox.workspacePath,
    command: [
      'set -eu',
      'git init --bare remote.git',
      'git init seed',
      "git -C seed config user.name 'Test User'",
      "git -C seed config user.email 'test@example.com'",
      "printf 'hello local git\\n' > seed/README.md",
      'git -C seed add README.md',
      "git -C seed commit -m 'initial commit'",
      'git -C seed branch -M main',
      'git -C seed remote add origin ../remote.git',
      'git -C seed push origin main',
    ].join('\n'),
  });
  if (result.exitCode !== 0) throw new Error(`Failed to create local git remote:\n${result.stdout}\n${result.stderr}`);
  return `${sandbox.workspacePath}/remote.git`;
}

function shellInput(command: string, options: { cwd?: string; env?: Record<string, string>; timeout?: number } | undefined): SandboxExecInput {
  const input: SandboxExecInput = { command };
  if (options?.cwd) input.cwd = options.cwd;
  if (options?.env) input.env = options.env;
  if (options?.timeout !== undefined) input.timeoutMs = options.timeout;
  return input;
}

class LocalGitAccessProvider implements RepositoryAccessProvider {
  constructor(private readonly cloneUrl: string) {}

  async getRepositoryAccess() {
    return {
      provider: 'github' as const,
      owner: 'manaflow-ai',
      repo: 'manaflow',
      cloneUrl: this.cloneUrl,
      expiresAt: new Date('2026-05-06T01:00:00.000Z'),
      auth: { type: 'bearer' as const, token: 'ghs_secret_token' },
    };
  }
}
