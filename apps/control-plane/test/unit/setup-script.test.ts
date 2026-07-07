import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { NormalizedEvent } from '../../src/events/types.js';
import {
  parseRepositoryWasCloned,
  runRepositorySetupScript,
  setupScriptFailureNote,
  setupScriptResultLine,
} from '../../src/repositories/setup-script.js';
import type { RepositoryShell, RepositoryShellOptions, RepositoryShellResult } from '../../src/repositories/shell.js';

const execFileAsync = promisify(execFile);

describe('runRepositorySetupScript', () => {
  it('does not probe when disabled', async () => {
    const calls: ShellCall[] = [];

    const result = await runRepositorySetupScript(baseOptions({ enabled: false }, calls));

    expect(result).toEqual({ status: 'disabled' });
    expect(calls).toEqual([]);
  });

  it.each([
    ['deputies-setup:absent\n', 'absent'],
    ['deputies-setup:skip\n', 'skipped'],
  ] as const)('returns %s without emitting events', async (probeOutput, status) => {
    const calls: ShellCall[] = [];
    const events: NormalizedEvent[] = [];

    const result = await runRepositorySetupScript(
      baseOptions(
        {
          emit: async (event) => {
            events.push(event);
          },
          shell: scriptedShell(calls, [ok(probeOutput)]),
        },
        calls,
      ),
    );

    expect(result).toEqual({ status });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toContain("git ls-tree HEAD -- '.agents/setup'");
    expect(events).toEqual([]);
  });

  it('runs executable setup scripts with Deputies env and stamps only on success', async () => {
    const calls: ShellCall[] = [];
    const events: NormalizedEvent[] = [];

    const result = await runRepositorySetupScript(
      baseOptions(
        {
          repositoryWasCloned: true,
          emit: async (event) => {
            events.push(event);
          },
          shell: scriptedShell(calls, [ok('deputies-setup:run reason=cloned hash=abc123 exec=1\n'), ok('installed\n')]),
        },
        calls,
      ),
    );

    expect(result).toMatchObject({ status: 'ran', exitCode: 0, timedOut: false, stdoutTail: 'installed\n' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toContain('script_hash="$3"');
    expect(calls[0]!.command).toContain('reason=cloned');
    expect(calls[1]!.command).toContain('git show HEAD:.agents/setup >"$setup_file"');
    expect(calls[1]!.command).toContain('"$setup_file" >"$setup_stdout"');
    expect(calls[1]!.command).not.toContain('bash "$setup_file"');
    expect(calls[1]!.command).toContain('if [ "$setup_exit" -eq 0 ]; then');
    expect(calls[1]!.command).toContain("printf '%s\\n' 'abc123' > '.git/deputies-setup-hash'");
    expect(calls[1]!.options).toMatchObject({
      cwd: '/workspace/repo',
      env: { DEPUTIES: '1', DEPUTIES_SETUP: '1' },
      timeoutMs: 600_000,
    });
    expect(events.map((event) => event.type)).toEqual(['setup_script_started', 'setup_script_finished']);
    expect(events[0]?.payload).toMatchObject({ path: '.agents/setup', reason: 'cloned' });
    expect(events[1]?.payload).toMatchObject({ exitCode: 0, isError: false, stdoutTail: 'installed\n' });
  });

  it('runs non-executable setup scripts through bash when the stamp is missing', async () => {
    const calls: ShellCall[] = [];

    await runRepositorySetupScript(
      baseOptions(
        {
          shell: scriptedShell(calls, [ok('deputies-setup:run reason=no_stamp hash=def456 exec=0\n'), ok('')]),
        },
        calls,
      ),
    );

    expect(calls[1]?.command).toContain('bash "$setup_file"');
  });

  it('uses the committed setup blob instead of dirty worktree contents', async () => {
    await withTempGitRepository(async (repoPath) => {
      await mkdir(path.join(repoPath, '.agents'));
      await writeFile(path.join(repoPath, '.agents/setup'), '#!/usr/bin/env bash\nprintf "HEAD setup\\n"\n');
      await git(repoPath, ['add', '.agents/setup']);
      await git(repoPath, [
        '-c',
        'user.name=Deputies Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'setup',
      ]);
      await writeFile(path.join(repoPath, '.agents/setup'), '#!/usr/bin/env bash\nprintf "WORKTREE setup\\n"\n');

      const firstRun = await runRepositorySetupScript(
        baseOptions(
          {
            workspacePath: repoPath,
            shell: realRepositoryShell,
          },
          [],
        ),
      );
      expect(firstRun).toMatchObject({ status: 'ran', exitCode: 0, stdoutTail: 'HEAD setup\n' });

      const secondRun = await runRepositorySetupScript(
        baseOptions(
          {
            workspacePath: repoPath,
            shell: realRepositoryShell,
          },
          [],
        ),
      );
      expect(secondRun).toEqual({ status: 'skipped' });
    });
  });

  it('emits a failed finished event without throwing on script failure', async () => {
    const calls: ShellCall[] = [];
    const events: NormalizedEvent[] = [];

    const result = await runRepositorySetupScript(
      baseOptions(
        {
          emit: async (event) => {
            events.push(event);
          },
          shell: scriptedShell(calls, [
            ok('deputies-setup:run reason=script_changed hash=abc123 exec=1\n'),
            { exitCode: 1, stdout: 'out', stderr: 'err' },
          ]),
        },
        calls,
      ),
    );

    expect(result).toMatchObject({ status: 'ran', exitCode: 1, stdoutTail: 'out', stderrTail: 'err' });
    expect(events.map((event) => event.type)).toEqual(['setup_script_started', 'setup_script_finished']);
    expect(events[1]?.payload).toMatchObject({ isError: true, exitCode: 1, stdoutTail: 'out', stderrTail: 'err' });
  });

  it('does not infer timeouts from script output text', async () => {
    const successCalls: ShellCall[] = [];
    const successEvents: NormalizedEvent[] = [];

    const success = await runRepositorySetupScript(
      baseOptions(
        {
          emit: async (event) => {
            successEvents.push(event);
          },
          shell: scriptedShell(successCalls, [
            ok('deputies-setup:run reason=no_stamp hash=abc123 exec=1\n'),
            ok('pnpm fetch timeout config: 60000\n'),
          ]),
        },
        successCalls,
      ),
    );

    expect(success).toMatchObject({ status: 'ran', exitCode: 0, timedOut: false });
    expect(successEvents[1]?.payload).not.toHaveProperty('timedOut');

    const failureCalls: ShellCall[] = [];
    const failure = await runRepositorySetupScript(
      baseOptions(
        {
          shell: scriptedShell(failureCalls, [
            ok('deputies-setup:run reason=no_stamp hash=abc123 exec=1\n'),
            { exitCode: 1, stdout: '', stderr: 'dependency client timeout setting was invalid' },
          ]),
        },
        failureCalls,
      ),
    );

    expect(failure).toMatchObject({ status: 'ran', exitCode: 1, timedOut: false });
    expect(setupScriptFailureNote(failure)).not.toContain('timing out');
  });

  it('surfaces probe failures as failed setup events', async () => {
    const calls: ShellCall[] = [];
    const events: NormalizedEvent[] = [];

    const result = await runRepositorySetupScript(
      baseOptions(
        {
          emit: async (event) => {
            events.push(event);
          },
          shell: scriptedShell(calls, [{ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }]),
        },
        calls,
      ),
    );

    expect(result).toMatchObject({
      status: 'probe_failed',
      exitCode: 128,
      timedOut: false,
      stderrTail: 'fatal: not a git repository',
    });
    expect(calls).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(['setup_script_finished']);
    expect(events[0]?.payload).toMatchObject({ phase: 'probe', isError: true, exitCode: 128 });
  });

  it('truncates output tails and maps thrown exec errors to failed results', async () => {
    const calls: ShellCall[] = [];
    const events: NormalizedEvent[] = [];
    const longOutput = `${'a'.repeat(9000)}tail`;

    const result = await runRepositorySetupScript(
      baseOptions(
        {
          emit: async (event) => {
            events.push(event);
          },
          shell: scriptedShell(calls, [ok('deputies-setup:run reason=no_stamp hash=abc123 exec=1\n'), ok(longOutput)]),
        },
        calls,
      ),
    );

    expect(result.status).toBe('ran');
    if (result.status === 'ran') {
      expect(result.stdoutTail).toContain('[truncated to last 8192 bytes]');
      expect(result.stdoutTail.endsWith('tail')).toBe(true);
    }

    const thrownCalls: ShellCall[] = [];
    const thrownEvents: NormalizedEvent[] = [];
    const thrownResult = await runRepositorySetupScript(
      baseOptions(
        {
          emit: async (event) => {
            thrownEvents.push(event);
          },
          shell: scriptedShell(thrownCalls, [
            ok('deputies-setup:run reason=no_stamp hash=abc123 exec=1\n'),
            new Error('command timed out after 600000ms'),
          ]),
        },
        thrownCalls,
      ),
    );

    expect(thrownResult).toMatchObject({ status: 'ran', exitCode: 1, timedOut: true });
    expect(thrownEvents[1]?.payload).toMatchObject({ isError: true, timedOut: true });
  });

  it('rethrows aborts so run cancellation keeps working', async () => {
    const calls: ShellCall[] = [];
    const abort = new DOMException('Operation aborted', 'AbortError');

    await expect(
      runRepositorySetupScript(
        baseOptions(
          {
            shell: scriptedShell(calls, [ok('deputies-setup:run reason=no_stamp hash=abc123 exec=1\n'), abort]),
          },
          calls,
        ),
      ),
    ).rejects.toThrow('Operation aborted');
  });
});

describe('setup script helpers', () => {
  it('parses repository setup clone markers', () => {
    expect(parseRepositoryWasCloned('cloned\ndeputies-repo-setup:cloned=1\n')).toBe(true);
    expect(parseRepositoryWasCloned('deputies-repo-setup:cloned=0')).toBe(false);
    expect(parseRepositoryWasCloned('no marker')).toBe(false);
  });

  it('formats failure notes and repository tool summary lines', () => {
    const result = {
      status: 'ran',
      exitCode: 2,
      durationMs: 42_000,
      timedOut: false,
      stdoutTail: 'stdout tail',
      stderrTail: 'stderr tail',
    } as const;

    expect(setupScriptFailureNote(result)).toContain('.agents/setup failed (exit code 2, 42s)');
    expect(setupScriptFailureNote(result)).toContain('stdout tail\nstderr tail');
    expect(setupScriptResultLine(result)).toContain('Setup script: FAILED (exit 2) in 42s');
    expect(setupScriptFailureNote({ status: 'skipped' })).toBeNull();
    expect(setupScriptResultLine({ status: 'absent' })).toBeNull();
  });
});

type ShellCall = { command: string; options: RepositoryShellOptions };
type ShellResponse = Pick<RepositoryShellResult, 'exitCode' | 'stdout' | 'stderr'> | Error | DOMException;

function baseOptions(
  overrides: Partial<Parameters<typeof runRepositorySetupScript>[0]>,
  calls: ShellCall[],
): Parameters<typeof runRepositorySetupScript>[0] {
  return {
    enabled: true,
    timeoutMs: 600_000,
    workspacePath: '/workspace/repo',
    repositoryWasCloned: false,
    shell: scriptedShell(calls, [ok('deputies-setup:absent\n')]),
    emit: async () => {},
    eventBase: { sessionId: 'session-1', runId: 'run-1', messageId: 'message-1' },
    ...overrides,
  };
}

function scriptedShell(calls: ShellCall[], responses: ShellResponse[]): RepositoryShell {
  return async (command: string, options: RepositoryShellOptions = {}) => {
    calls.push({ command, options });
    const response = responses.shift() ?? ok('');
    if (response instanceof Error || response instanceof DOMException) throw response;
    const now = new Date();
    return { ...response, startedAt: now, completedAt: now };
  };
}

function ok(stdout: string): ShellResponse {
  return { exitCode: 0, stdout, stderr: '' };
}

async function withTempGitRepository(run: (repoPath: string) => Promise<void>): Promise<void> {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'deputies-setup-test-'));
  try {
    await git(repoPath, ['init', '-q']);
    await git(repoPath, ['config', 'commit.gpgsign', 'false']);
    await run(repoPath);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

const realRepositoryShell: RepositoryShell = async (command, options = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], {
      cwd: options.cwd,
      encoding: 'utf8',
      env: { ...process.env, ...options.env },
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const now = new Date();
    return { exitCode: 0, stdout, stderr, startedAt: now, completedAt: now };
  } catch (error) {
    const execError = error as Error & {
      code?: number | string | null;
      stdout?: string;
      stderr?: string;
    };
    const now = new Date();
    return {
      exitCode: typeof execError.code === 'number' ? execError.code : 1,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message,
      startedAt: now,
      completedAt: now,
    };
  }
};
