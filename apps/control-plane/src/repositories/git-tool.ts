import { getPreparedRepository, type RepositoryToolServices } from './tool.js';

const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4_096;

export const gitToolDescription =
  'Run authenticated git commands inside the prepared sandbox repository. Use repository status/set/prepare first if no repository is prepared. Use this for network git operations such as push, fetch, pull, and ls-remote. ' +
  'This tool runs in the remote sandbox worktree with command-scoped GitHub App authentication. ' +
  'Pass only git arguments, not the "git" executable name. For local read-only git commands or commits, bash is also acceptable; for GitHub issues, comments, and PRs, use the gh tool.';

export const gitToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['args'],
  properties: {
    args: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_ARGS,
      items: { type: 'string', maxLength: MAX_ARG_LENGTH },
      description: 'Arguments to pass to git, for example ["push", "origin", "sp/my-branch"]',
    },
  },
} as const;

export async function executeGitTool(
  repository: RepositoryToolServices,
  params: Record<string, unknown>,
): Promise<string> {
  const args = validateArgs(params.args);
  const prepared = getPreparedRepository(repository);
  const shell = repository.shell();
  if (!shell) throw new Error('Authenticated git is unavailable before the sandbox shell is ready');
  const result = await shell(gitCommand(args), {
    cwd: prepared.workspacePath,
    env: { GITHUB_AUTH_HEADER: gitAuthHeader(prepared.access.auth.token) },
    timeoutMs: 120_000,
  });
  const output = formatShellResult(result, prepared.access.auth.token);
  if (result.exitCode !== 0) throw new Error(output);
  return output;
}

function validateArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('git args must be a non-empty string array');
  if (value.length > MAX_ARGS) throw new Error(`git args cannot exceed ${MAX_ARGS} entries`);

  const args = value.map((arg) => {
    if (typeof arg !== 'string') throw new Error('git args must contain only strings');
    if (!arg) throw new Error('git args cannot contain empty strings');
    if (arg.includes('\0')) throw new Error('git args cannot contain NUL bytes');
    if (arg.length > MAX_ARG_LENGTH) throw new Error(`git args cannot exceed ${MAX_ARG_LENGTH} characters per entry`);
    return arg;
  });

  if (args[0] === 'git') throw new Error('Pass git arguments only; omit the git executable name');
  if (args[0]!.startsWith('-')) throw new Error('git command must be an explicit subcommand, not a top-level flag');
  if (args[0] === 'push') validatePushArgs(args);
  return args;
}

function validatePushArgs(args: string[]): void {
  for (const arg of args.slice(1)) {
    if (arg === '--force' || arg === '-f' || arg === '--force-with-lease' || arg === '--mirror' || arg === '--delete') {
      throw new Error(`git push option ${arg} is not available through this tool`);
    }
    if (arg.startsWith('+')) throw new Error('git push force refspecs are not available through this tool');
    if (/^:[^/]/.test(arg) || /^refs\/heads\/[^:]+:$/.test(arg)) {
      throw new Error('git push delete refspecs are not available through this tool');
    }
  }
}

function gitCommand(args: string[]): string {
  return `git -c http.extraHeader="$GITHUB_AUTH_HEADER" ${args.map(quoteShell).join(' ')}`;
}

function gitAuthHeader(token: string): string {
  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `Authorization: Basic ${credentials}`;
}

function formatShellResult(result: { exitCode: number; stdout: string; stderr: string }, token: string): string {
  const parts = [`exitCode: ${result.exitCode}`];
  if (result.stdout.trim()) parts.push(`stdout:\n${redactSecrets(result.stdout.trim(), token)}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${redactSecrets(result.stderr.trim(), token)}`);
  return parts.join('\n');
}

function redactSecrets(value: string, token: string): string {
  return value.replaceAll(token, '[redacted]').replace(/gh[ousr]_[A-Za-z0-9_]+/g, '[redacted]');
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}
