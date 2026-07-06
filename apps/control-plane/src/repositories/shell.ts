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
