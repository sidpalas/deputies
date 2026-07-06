import type { RunnerInput } from '../runner/types.js';
import { repositorySetupRanMarkerPath } from './setup.js';
import { shellScript, type RepositoryShell } from './shell.js';

const setupScriptPath = '.agents/setup';
const setupStampPath = '.git/deputies-setup-hash';
const outputTailBytes = 8 * 1024;
const repositorySetupClonedPattern = /(?:^|\n)deputies-repo-setup:cloned=(0|1)(?:\n|$)/;

export type RepositorySetupScriptPolicy = { enabled: boolean; timeoutMs: number };

export type SetupScriptResult =
  | { status: 'absent' | 'skipped' | 'disabled' }
  | ProbeFailedSetupScriptResult
  | RanSetupScriptResult;

type FailedSetupScriptResultFields = {
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
};

type ProbeFailedSetupScriptResult = { status: 'probe_failed' } & FailedSetupScriptResultFields;

type RanSetupScriptResult = { status: 'ran' } & FailedSetupScriptResultFields;

export type SetupScriptOptions = {
  enabled: RepositorySetupScriptPolicy['enabled'];
  timeoutMs: RepositorySetupScriptPolicy['timeoutMs'];
  workspacePath: string;
  repositoryWasCloned: boolean;
  shell: RepositoryShell;
  emit: RunnerInput['emit'];
  eventBase: Pick<RunnerInput, 'sessionId' | 'runId' | 'messageId'>;
  signal?: AbortSignal;
};

type SetupScriptProbe =
  | { action: 'absent' }
  | { action: 'skip' }
  | { action: 'failed'; result: ProbeFailedSetupScriptResult }
  | { action: 'run'; reason: 'cloned' | 'no_stamp' | 'script_changed'; hash: string; executable: boolean };

export async function runRepositorySetupScript(options: SetupScriptOptions): Promise<SetupScriptResult> {
  if (!options.enabled) return { status: 'disabled' };

  const probe = await probeSetupScript(options);
  if (probe.action === 'absent') return { status: 'absent' };
  if (probe.action === 'skip') return { status: 'skipped' };
  if (probe.action === 'failed') {
    await emitSetupScriptFinished(options, probe.result);
    return probe.result;
  }

  await options.emit({
    ...options.eventBase,
    type: 'setup_script_started',
    payload: {
      path: setupScriptPath,
      workspacePath: options.workspacePath,
      reason: probe.reason,
    },
    createdAt: new Date(),
  });

  const startedAt = Date.now();
  const result = await executeSetupScript(options, probe, startedAt);
  await emitSetupScriptFinished(options, result);

  return result;
}

export function setupScriptFailureNote(result: SetupScriptResult): string | null {
  if (!isFailedSetupResult(result)) return null;
  const output = [result.stdoutTail, result.stderrTail].filter(Boolean).join('\n').trim();
  const timeout = result.timedOut ? ' after timing out' : '';
  const details = [`exit code ${result.exitCode}${timeout}`, formatDuration(result.durationMs)].join(', ');
  const subject =
    result.status === 'probe_failed'
      ? `the repository setup script probe for ${setupScriptPath}`
      : `the repository setup script ${setupScriptPath}`;
  return output
    ? `Note: ${subject} failed (${details}). Output tail:\n${output}`
    : `Note: ${subject} failed (${details}).`;
}

export function setupScriptResultLine(result: SetupScriptResult): string | null {
  if (result.status === 'probe_failed') {
    const timeout = result.timedOut ? ', timed out' : '';
    const output = [result.stdoutTail, result.stderrTail].filter(Boolean).join('\n').trim();
    return output
      ? `Setup script: probe FAILED (exit ${result.exitCode}${timeout}) in ${formatDuration(result.durationMs)}\n${output}`
      : `Setup script: probe FAILED (exit ${result.exitCode}${timeout}) in ${formatDuration(result.durationMs)}`;
  }
  if (result.status !== 'ran') return null;
  if (result.exitCode === 0) return `Setup script: ran successfully in ${formatDuration(result.durationMs)}`;
  const timeout = result.timedOut ? ', timed out' : '';
  const output = [result.stdoutTail, result.stderrTail].filter(Boolean).join('\n').trim();
  return output
    ? `Setup script: FAILED (exit ${result.exitCode}${timeout}) in ${formatDuration(result.durationMs)}\n${output}`
    : `Setup script: FAILED (exit ${result.exitCode}${timeout}) in ${formatDuration(result.durationMs)}`;
}

export function parseRepositoryWasCloned(stdout: string): boolean {
  return repositorySetupClonedPattern.exec(stdout)?.[1] === '1';
}

async function probeSetupScript(options: SetupScriptOptions): Promise<SetupScriptProbe> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(options.timeoutMs, 30_000);
  let result: Awaited<ReturnType<RepositoryShell>>;
  try {
    result = await options.shell(probeCommand(options.repositoryWasCloned), {
      cwd: options.workspacePath,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) throw error;
    const durationMs = Math.max(0, Date.now() - startedAt);
    return {
      action: 'failed',
      result: {
        status: 'probe_failed',
        exitCode: 1,
        durationMs,
        timedOut: isTimeoutError(error, durationMs, timeoutMs),
        stdoutTail: '',
        stderrTail: tailOutput(error instanceof Error ? error.message : String(error)),
      },
    };
  }
  const durationMs = Math.max(0, Date.now() - startedAt);
  if (result.exitCode !== 0) {
    return {
      action: 'failed',
      result: {
        status: 'probe_failed',
        exitCode: result.exitCode,
        durationMs,
        timedOut: isLikelyTimeout(result.exitCode, durationMs, timeoutMs),
        stdoutTail: tailOutput(result.stdout),
        stderrTail: tailOutput(result.stderr || 'Repository setup script probe failed before execution.'),
      },
    };
  }
  const parsed = parseProbeOutput(result.stdout);
  if (parsed) return parsed;
  return {
    action: 'failed',
    result: {
      status: 'probe_failed',
      exitCode: 1,
      durationMs,
      timedOut: false,
      stdoutTail: tailOutput(result.stdout),
      stderrTail: tailOutput(result.stderr || 'Repository setup script probe returned unrecognized output.'),
    },
  };
}

function parseProbeOutput(stdout: string): SetupScriptProbe | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'deputies-setup:absent') return { action: 'absent' };
    if (trimmed === 'deputies-setup:skip') return { action: 'skip' };
    const run = /^deputies-setup:run reason=(cloned|no_stamp|script_changed) hash=([^ ]+) exec=([01])$/.exec(trimmed);
    if (run) {
      return {
        action: 'run',
        reason: run[1] as 'cloned' | 'no_stamp' | 'script_changed',
        hash: run[2]!,
        executable: run[3] === '1',
      };
    }
  }
  return null;
}

async function executeSetupScript(
  options: SetupScriptOptions,
  probe: Extract<SetupScriptProbe, { action: 'run' }>,
  startedAt: number,
): Promise<Extract<SetupScriptResult, { status: 'ran' }>> {
  try {
    const result = await options.shell(runCommand(probe), {
      cwd: options.workspacePath,
      env: { DEPUTIES: '1', DEPUTIES_SETUP: '1' },
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    return {
      status: 'ran',
      exitCode: result.exitCode,
      durationMs,
      timedOut: isLikelyTimeout(result.exitCode, durationMs, options.timeoutMs),
      stdoutTail: tailOutput(result.stdout),
      stderrTail: tailOutput(result.stderr),
    };
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) throw error;
    const durationMs = Math.max(0, Date.now() - startedAt);
    return {
      status: 'ran',
      exitCode: 1,
      durationMs,
      timedOut: isTimeoutError(error, durationMs, options.timeoutMs),
      stdoutTail: '',
      stderrTail: tailOutput(error instanceof Error ? error.message : String(error)),
    };
  }
}

function probeCommand(repositoryWasCloned: boolean): string {
  const reasonLine = repositoryWasCloned ? 'reason=cloned' : 'reason=';
  return shellScript(`
    set -eu

    tracked_setup="$(git ls-tree HEAD -- ${quoteShell(setupScriptPath)} 2>/dev/null || true)"
    case "$tracked_setup" in
      "100644 blob "*|"100755 blob "*) ;;
      *)
        printf '%s\\n' ${quoteShell('deputies-setup:absent')}
        exit 0
        ;;
    esac

    set -- $tracked_setup
    script_mode="$1"
    script_hash="$3"
    stamp_hash=""
    if [ -f ${quoteShell(setupStampPath)} ]; then
      stamp_hash="$(cat ${quoteShell(setupStampPath)} || true)"
    fi

    exec_flag=0
    if [ "$script_mode" = "100755" ]; then exec_flag=1; fi
    ${reasonLine}
    if [ -z "$reason" ] && [ -z "$stamp_hash" ]; then reason=no_stamp; fi
    if [ -z "$reason" ] && [ "$stamp_hash" != "$script_hash" ]; then reason=script_changed; fi

    if [ -z "$reason" ]; then
      printf '%s\\n' ${quoteShell('deputies-setup:skip')}
    else
      printf 'deputies-setup:run reason=%s hash=%s exec=%s\\n' "$reason" "$script_hash" "$exec_flag"
    fi
  `);
}

function runCommand(probe: Extract<SetupScriptProbe, { action: 'run' }>): string {
  const invocation = probe.executable ? '"$setup_file"' : 'bash "$setup_file"';
  return shellScript(`
    set -u

    setup_file="$(mktemp)"
    setup_stdout="$(mktemp)"
    setup_stderr="$(mktemp)"
    cleanup_setup_output() { rm -f "$setup_file" "$setup_stdout" "$setup_stderr"; }
    trap cleanup_setup_output EXIT

    git show HEAD:${setupScriptPath} >"$setup_file"
    if [ ${probe.executable ? '1' : '0'} -eq 1 ]; then chmod +x "$setup_file"; fi
    printf '%s\\n' '1' > ${quoteShell(repositorySetupRanMarkerPath)}

    set +e
    ${invocation} >"$setup_stdout" 2>"$setup_stderr"
    setup_exit=$?
    set -e

    if [ -s "$setup_stdout" ]; then tail -c ${outputTailBytes} "$setup_stdout"; fi
    if [ -s "$setup_stderr" ]; then tail -c ${outputTailBytes} "$setup_stderr" >&2; fi

    if [ "$setup_exit" -eq 0 ]; then
      printf '%s\\n' ${quoteShell(probe.hash)} > ${quoteShell(setupStampPath)}
      setup_exit=$?
    fi

    exit "$setup_exit"
  `);
}

function tailOutput(output: string): string {
  const buffer = Buffer.from(output, 'utf8');
  if (buffer.byteLength <= outputTailBytes) return output;
  return `[truncated to last ${outputTailBytes} bytes]\n${buffer.subarray(buffer.byteLength - outputTailBytes).toString('utf8')}`;
}

async function emitSetupScriptFinished(
  options: SetupScriptOptions,
  result: ProbeFailedSetupScriptResult | RanSetupScriptResult,
): Promise<void> {
  await options.emit({
    ...options.eventBase,
    type: 'setup_script_finished',
    payload: {
      path: setupScriptPath,
      phase: result.status === 'probe_failed' ? 'probe' : 'script',
      workspacePath: options.workspacePath,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      isError: result.exitCode !== 0,
      ...(result.timedOut ? { timedOut: true } : {}),
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
    },
    createdAt: new Date(),
  });
}

function isFailedSetupResult(result: SetupScriptResult): result is ProbeFailedSetupScriptResult | RanSetupScriptResult {
  return result.status === 'probe_failed' || (result.status === 'ran' && result.exitCode !== 0);
}

function isLikelyTimeout(exitCode: number, durationMs: number, timeoutMs: number): boolean {
  return exitCode !== 0 && (durationMs >= timeoutMs - 1000 || [124, 137, 143].includes(exitCode));
}

function isTimeoutError(error: unknown, durationMs: number, timeoutMs: number): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout/i.test(message) || durationMs >= timeoutMs - 1000;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${Math.round(durationMs / 1000)}s`;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
