import type { SandboxHandle, SandboxServiceProcess, SandboxServiceProcessInput } from './types.js';

export async function startSandboxService(
  sandbox: SandboxHandle,
  input: SandboxServiceProcessInput,
): Promise<SandboxServiceProcess> {
  if (sandbox.startService) return sandbox.startService(input);
  const logPath = `/tmp/deputies-service-${input.port}.log`;
  const result = await sandbox.exec({
    command: `nohup bash -lc ${quoteShell(`exec ${input.command}`)} >${quoteShell(logPath)} 2>&1 </dev/null & printf '%s' $!`,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.env ? { env: input.env } : {}),
  });
  const pid = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !Number.isInteger(pid) || pid < 1)
    throw new Error(result.stderr || result.stdout || 'Failed to launch sandbox service');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const health = await sandbox.exec({ command: `bash -lc ${quoteShell(`kill -0 ${pid}`)}` });
  if (health.exitCode !== 0) throw new Error(`Sandbox service exited during launch; inspect ${logPath}`);
  return { pid, status: 'starting' };
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
