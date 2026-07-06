import type { SandboxHandle } from '../sandbox/types.js';

export type RepositoryShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type RepositoryShellOptions = {
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type RepositoryShell = (command: string, options?: RepositoryShellOptions) => PromiseLike<RepositoryShellResult>;

export function sandboxRepositoryShell(sandbox: SandboxHandle): RepositoryShell {
  return async (command, options = {}) => {
    const result = await sandbox.exec({
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
}

export function shellScript(script: string): string {
  const lines = script
    .replace(/^\n/, '')
    .replace(/\n[ \t]*$/, '')
    .split('\n');
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0);
  const indent = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(indent)).join('\n');
}
