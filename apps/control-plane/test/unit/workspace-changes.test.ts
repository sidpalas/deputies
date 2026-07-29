import { exec as execCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HttpRequestError } from '../../src/app/request.js';
import {
  connectReadyWorkspace,
  decodeFileId,
  fileId,
  inspectWorkspaceChanges,
  inspectWorkspacePatch,
  parsePorcelain,
  repositoryId,
} from '../../src/app/workspace-changes.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';
import { LocalSandboxProvider } from '../../src/sandbox/local.js';
import { SandboxLifecycleService, SandboxLifecycleUnavailableError } from '../../src/sandbox/service.js';
import type { SandboxExecInput, SandboxHandle } from '../../src/sandbox/types.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { SessionRecord } from '../../src/store/types.js';

const exec = promisify(execCallback);

describe('workspace changes', () => {
  it('parses staged, unstaged, untracked, and rename entries without losing unusual names', () => {
    expect(
      parsePorcelain(
        [
          'MM staged and unstaged.txt',
          '?? untracked file.txt',
          'R  renamed new.txt',
          'renamed old.txt',
          ' R worktree new.txt',
          'worktree old.txt',
          'UU conflict.txt',
          '',
        ].join('\0'),
      ),
    ).toEqual([
      {
        id: fileId('staged and unstaged.txt'),
        path: 'staged and unstaged.txt',
        indexChange: 'modified',
        worktreeChange: 'modified',
      },
      { id: fileId('untracked file.txt'), path: 'untracked file.txt', worktreeChange: 'untracked' },
      {
        id: fileId('renamed new.txt'),
        path: 'renamed new.txt',
        oldPath: 'renamed old.txt',
        indexChange: 'renamed',
      },
      {
        id: fileId('worktree new.txt'),
        path: 'worktree new.txt',
        oldPath: 'worktree old.txt',
        worktreeChange: 'renamed',
      },
      {
        id: fileId('conflict.txt'),
        path: 'conflict.txt',
        indexChange: 'unmerged',
        worktreeChange: 'unmerged',
      },
    ]);
  });

  it('ignores an incomplete final porcelain record from a source-capped scan', () => {
    expect(parsePorcelain(' M complete.txt\0?? partial')).toEqual([
      { id: fileId('complete.txt'), path: 'complete.txt', worktreeChange: 'modified' },
    ]);
  });

  it('round trips safe opaque file IDs and rejects traversal, absolute, empty, and NUL paths', () => {
    expect(decodeFileId(fileId('directory/a strange name.txt'))).toBe('directory/a strange name.txt');
    for (const path of ['', '../secret', 'directory/../../secret', '/etc/passwd', 'bad\0name']) {
      expect(() => decodeFileId(fileId(path))).toThrow(HttpRequestError);
    }
    expect(() => decodeFileId('not+base64')).toThrow(HttpRequestError);
  });

  it('inspects and patches a real configured repository with staged, unstaged, and untracked changes', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'deputies-workspace-changes-'));
    const repositoryPath = join(workspacePath, 'acme', 'api');
    await mkdir(repositoryPath, { recursive: true });
    try {
      await exec('git init -q && git config user.email test@example.com && git config user.name Test', {
        cwd: repositoryPath,
      });
      await writeFile(join(repositoryPath, 'both.txt'), 'base\n');
      await writeFile(join(repositoryPath, 'literal*.txt'), 'literal base\n');
      await writeFile(join(repositoryPath, 'other.txt'), 'other base\n');
      await writeFile(join(repositoryPath, 'line\nbreak.txt'), 'newline base\n');
      await writeFile(join(repositoryPath, 'rename old.txt'), 'rename me\n');
      await exec('git add . && git commit -qm initial && git checkout --detach -q', { cwd: repositoryPath });
      await writeFile(join(repositoryPath, 'both.txt'), 'staged\n');
      await exec('git add both.txt', { cwd: repositoryPath });
      await writeFile(join(repositoryPath, 'both.txt'), 'worktree\n');
      await writeFile(join(repositoryPath, 'literal*.txt'), 'literal changed\n');
      await writeFile(join(repositoryPath, 'other.txt'), 'other changed\n');
      await writeFile(join(repositoryPath, 'line\nbreak.txt'), 'newline changed\n');
      await writeFile(join(repositoryPath, 'new file.txt'), 'new\n');
      await writeFile(join(repositoryPath, 'large untracked.txt'), `first\n${'large line\n'.repeat(60_000)}`);
      await exec("git mv 'rename old.txt' 'rename new.txt'", { cwd: repositoryPath });

      const sandbox = localSandbox(workspacePath);
      const session = sessionWithRepository();
      const changes = await inspectWorkspaceChanges(session, sandbox, 'runtime-1');
      expect(changes.repositories).toHaveLength(1);
      expect(changes.repositories[0]).toMatchObject({
        id: repositoryId('acme', 'api'),
        isPrimary: true,
        status: 'ready',
        branch: null,
      });
      expect(changes.repositories[0]?.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'both.txt', indexChange: 'modified', worktreeChange: 'modified' }),
          expect.objectContaining({ path: 'literal*.txt', worktreeChange: 'modified' }),
          expect.objectContaining({ path: 'line\nbreak.txt', worktreeChange: 'modified' }),
          expect.objectContaining({ path: 'new file.txt', worktreeChange: 'untracked' }),
          expect.objectContaining({ path: 'large untracked.txt', worktreeChange: 'untracked' }),
          expect.objectContaining({ path: 'rename new.txt', oldPath: 'rename old.txt', indexChange: 'renamed' }),
        ]),
      );

      const patch = await inspectWorkspacePatch({
        session,
        sandbox,
        repository: repositoryId('acme', 'api'),
        file: fileId('both.txt'),
        layer: 'combined',
      });
      expect(patch.patch).toContain('-base');
      expect(patch.patch).toContain('+worktree');
      expect(patch.truncated).toBe(false);

      const literalPatch = await inspectWorkspacePatch({
        session,
        sandbox,
        repository: repositoryId('acme', 'api'),
        file: fileId('literal*.txt'),
        layer: 'worktree',
      });
      expect(literalPatch.patch).toContain('+literal changed');
      expect(literalPatch.patch).not.toContain('other changed');

      const largePatch = await inspectWorkspacePatch({
        session,
        sandbox,
        repository: repositoryId('acme', 'api'),
        file: fileId('large untracked.txt'),
        layer: 'worktree',
      });
      expect(largePatch.patch).toContain('+first');
      expect(largePatch.truncated).toBe(true);

      const renamePatch = await inspectWorkspacePatch({
        session,
        sandbox,
        repository: repositoryId('acme', 'api'),
        file: fileId('rename new.txt'),
        layer: 'index',
      });
      expect(renamePatch.patch).toContain('rename from rename old.txt');
      expect(renamePatch.patch).toContain('rename to rename new.txt');
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('resumes a stopped sandbox while connecting for inspection', async () => {
    const store = new MemoryStore();
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create({ sessionId: 'session-1' });
    await provider.stop(sandbox);
    const now = new Date();
    await store.createSandbox({
      id: 'sandbox-record-1',
      sessionId: 'session-1',
      provider: provider.name,
      providerSandboxId: sandbox.providerSandboxId,
      status: 'stopped',
      workspacePath: sandbox.workspacePath,
      metadata: { runtimeId: 'runtime-1' },
      createdAt: now,
      updatedAt: now,
    });

    const connected = await connectReadyWorkspace({
      sessionId: 'session-1',
      lifecycle: new SandboxLifecycleService(store, provider),
    });
    expect(connected.record.status).toBe('ready');
    expect(provider.starts).toBe(1);
  });

  it('maps expected lifecycle availability failures but preserves invariant errors', async () => {
    const unavailableLifecycle = {
      ensure: vi.fn().mockRejectedValue(new SandboxLifecycleUnavailableError('resume failed')),
    } as unknown as SandboxLifecycleService;
    await expect(
      connectReadyWorkspace({ sessionId: 'session-1', lifecycle: unavailableLifecycle }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'sandbox_unavailable' });

    const invariantError = new Error('sandbox identity changed');
    const invalidLifecycle = {
      ensure: vi.fn().mockRejectedValue(invariantError),
    } as unknown as SandboxLifecycleService;
    await expect(connectReadyWorkspace({ sessionId: 'session-1', lifecycle: invalidLifecycle })).rejects.toBe(
      invariantError,
    );
  });

  it('recovers when the stored record is ready but the provider reports that the sandbox stopped', async () => {
    const store = new MemoryStore();
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create({ sessionId: 'session-1' });
    await provider.stop(sandbox);
    const now = new Date();
    await store.createSandbox({
      id: 'sandbox-record-2',
      sessionId: 'session-1',
      provider: provider.name,
      providerSandboxId: sandbox.providerSandboxId,
      status: 'ready',
      workspacePath: sandbox.workspacePath,
      metadata: { runtimeId: 'runtime-before-resume' },
      createdAt: now,
      updatedAt: now,
    });

    const connected = await connectReadyWorkspace({
      sessionId: 'session-1',
      lifecycle: new SandboxLifecycleService(store, provider),
    });
    expect(connected.record.status).toBe('ready');
    expect(connected.record.metadata.runtimeId).not.toBe('runtime-before-resume');
    expect(provider.starts).toBe(1);
  });

  it('health-checks and resumes a recoverable sandbox recorded as unhealthy', async () => {
    const store = new MemoryStore();
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create({ sessionId: 'session-1' });
    await provider.stop(sandbox);
    const now = new Date();
    await store.createSandbox({
      id: 'sandbox-record-3',
      sessionId: 'session-1',
      provider: provider.name,
      providerSandboxId: sandbox.providerSandboxId,
      status: 'unhealthy',
      workspacePath: sandbox.workspacePath,
      metadata: { runtimeId: 'runtime-before-unhealthy-recovery' },
      createdAt: now,
      updatedAt: now,
    });

    const connected = await connectReadyWorkspace({
      sessionId: 'session-1',
      lifecycle: new SandboxLifecycleService(store, provider),
    });
    expect(connected.record.status).toBe('ready');
    expect(connected.record.metadata.runtimeId).not.toBe('runtime-before-unhealthy-recovery');
    expect(provider.starts).toBe(1);
  });

  it('inspects through the default LocalSandboxProvider command allowlist', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'deputies-local-workspace-changes-'));
    const provider = new LocalSandboxProvider({ rootDir });
    const sandbox = await provider.create({ sessionId: 'session-1' });
    const repositoryPath = join(sandbox.workspacePath, 'acme', 'api');
    await mkdir(repositoryPath, { recursive: true });
    try {
      await exec('git init -q && git config user.email test@example.com && git config user.name Test', {
        cwd: repositoryPath,
      });
      await writeFile(join(repositoryPath, 'file.txt'), 'base\n');
      await exec('git add . && git commit -qm initial', { cwd: repositoryPath });
      await writeFile(join(repositoryPath, 'file.txt'), 'changed\n');

      const changes = await inspectWorkspaceChanges(sessionWithRepository(), sandbox);
      expect(changes.repositories[0]).toMatchObject({
        status: 'ready',
        files: [expect.objectContaining({ path: 'file.txt', worktreeChange: 'modified' })],
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('maps thrown patch command failures to an actionable workspace error', async () => {
    let commands = 0;
    const sandbox: SandboxHandle = {
      ...localSandbox('/workspace'),
      async exec() {
        commands += 1;
        if (commands === 1) {
          const now = new Date();
          return { exitCode: 0, stdout: ' M file.txt\0', stderr: '', startedAt: now, completedAt: now };
        }
        throw new Error('sandbox bridge disconnected');
      },
    };

    await expect(
      inspectWorkspacePatch({
        session: sessionWithRepository(),
        sandbox,
        repository: repositoryId('acme', 'api'),
        file: fileId('file.txt'),
        layer: 'worktree',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'patch_unavailable' });
  });

  it('reports thrown summary timeouts as a repository timeout', async () => {
    const sandbox: SandboxHandle = {
      ...localSandbox('/workspace'),
      async exec() {
        throw new Error('command timed out');
      },
    };

    const changes = await inspectWorkspaceChanges(sessionWithRepository(), sandbox);

    expect(changes.repositories[0]).toMatchObject({ status: 'timed_out', complete: false, files: [] });
  });

  it('rejects a configured repository root redirected through a workspace symlink', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'deputies-workspace-symlink-'));
    const redirectedOwner = join(workspacePath, 'redirected-owner');
    const repositoryPath = join(redirectedOwner, 'api');
    await mkdir(repositoryPath, { recursive: true });
    try {
      await exec('git init -q', { cwd: repositoryPath });
      await symlink(redirectedOwner, join(workspacePath, 'acme'));
      const changes = await inspectWorkspaceChanges(sessionWithRepository(), localSandbox(workspacePath));
      expect(changes.repositories[0]).toMatchObject({ status: 'not_repository', files: [] });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});

function sessionWithRepository(): SessionRecord {
  const now = new Date();
  return {
    id: 'session-1',
    status: 'idle',
    spawnDepth: 0,
    tags: [],
    context: { repository: { provider: 'github', owner: 'acme', repo: 'api' } },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  };
}

function localSandbox(workspacePath: string): SandboxHandle {
  return {
    provider: 'local-test',
    providerSandboxId: 'sandbox-1',
    sessionId: 'session-1',
    workspacePath,
    metadata: {},
    capabilities: {
      persistentFilesystem: true,
      snapshots: false,
      stopStart: false,
      exec: true,
      filesystem: true,
      streamingLogs: false,
      portForwarding: false,
      serviceEndpoints: false,
      objectStorageArtifacts: false,
    },
    async exec(input: SandboxExecInput) {
      const startedAt = new Date();
      try {
        const result = await exec(input.command, {
          cwd: input.cwd,
          timeout: input.timeoutMs,
          env: { ...process.env, ...input.env },
          maxBuffer: 2 * 1024 * 1024,
        });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, startedAt, completedAt: new Date() };
      } catch (error) {
        const result = error as Error & { code?: number; stdout?: string; stderr?: string };
        return {
          exitCode: typeof result.code === 'number' ? result.code : 1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? result.message,
          startedAt,
          completedAt: new Date(),
        };
      }
    },
  };
}
