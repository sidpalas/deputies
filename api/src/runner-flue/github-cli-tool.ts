import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDef } from '@flue/sdk';
import type { GitHubRepositoryAccess } from '../integrations/github/types.js';

const BLOCKED_COMMANDS = new Set(['alias', 'auth', 'config', 'extension']);
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4_096;
const MAX_OUTPUT_BYTES = 50_000;

export type GitHubCliRunner = (input: {
  args: string[];
  env: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<GitHubCliResult>;

export type GitHubCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function createGitHubCliTool(
  access: GitHubRepositoryAccess,
  options: { runner?: GitHubCliRunner } = {},
): ToolDef {
  return {
    name: 'gh',
    description:
      `Run authenticated GitHub CLI operations for ${access.owner}/${access.repo}. ` +
      'The command is executed by trusted backend code with a short-lived GitHub App installation token. ' +
      'Pass only gh arguments, not the "gh" executable name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['args'],
      properties: {
        args: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ARGS,
          items: { type: 'string', maxLength: MAX_ARG_LENGTH },
          description: 'Arguments to pass to gh, for example ["issue", "create", "--title", "Test", "--body", "..."]',
        },
      },
    },
    async execute(params, signal) {
      const args = validateArgs(params.args);
      const configDir = await mkdtemp(join(tmpdir(), 'dev-deputies-gh-'));
      try {
        const runner = options.runner ?? runGitHubCli;
        const runnerInput: Parameters<GitHubCliRunner>[0] = { args, env: createGitHubCliEnv(access, configDir) };
        if (signal) runnerInput.signal = signal;
        const result = await runner(runnerInput);
        const output = formatResult(result, access.auth.token);
        if (result.exitCode !== 0) throw new Error(output);
        return output;
      } finally {
        await rm(configDir, { recursive: true, force: true });
      }
    },
  };
}

function validateArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('gh args must be a non-empty string array');
  if (value.length > MAX_ARGS) throw new Error(`gh args cannot exceed ${MAX_ARGS} entries`);

  const args = value.map((arg) => {
    if (typeof arg !== 'string') throw new Error('gh args must contain only strings');
    if (!arg) throw new Error('gh args cannot contain empty strings');
    if (arg.includes('\0')) throw new Error('gh args cannot contain NUL bytes');
    if (arg.length > MAX_ARG_LENGTH) throw new Error(`gh args cannot exceed ${MAX_ARG_LENGTH} characters per entry`);
    return arg;
  });

  const command = args[0]!;
  if (command === 'gh') throw new Error('Pass gh arguments only; omit the gh executable name');
  if (command.startsWith('-')) throw new Error('gh command must be an explicit subcommand, not a top-level flag');
  if (BLOCKED_COMMANDS.has(command)) throw new Error(`gh ${command} is not available through this tool`);
  if ((command === 'repo' || command === 'gist') && args[1] === 'clone') {
    throw new Error(`gh ${command} clone is not available through this tool`);
  }
  return args;
}

function createGitHubCliEnv(access: GitHubRepositoryAccess, configDir: string): Record<string, string> {
  const env = copyStringEnv(process.env);
  const host = parseCloneHost(access.cloneUrl);
  env.GH_CONFIG_DIR = configDir;
  env.GH_PROMPT_DISABLED = '1';
  env.GH_REPO = `${access.owner}/${access.repo}`;
  env.NO_COLOR = '1';
  if (host && host !== 'github.com') {
    env.GH_HOST = host;
    env.GH_ENTERPRISE_TOKEN = access.auth.token;
  } else {
    env.GH_TOKEN = access.auth.token;
  }
  return env;
}

function copyStringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

function parseCloneHost(cloneUrl: string): string | null {
  try {
    return new URL(cloneUrl).host || null;
  } catch {
    const match = /^git@([^:]+):/.exec(cloneUrl);
    return match?.[1] ?? null;
  }
}

async function runGitHubCli(input: {
  args: string[];
  env: Record<string, string>;
  signal?: AbortSignal;
}): Promise<GitHubCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', input.args, {
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: input.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendOutput(stderr, chunk); });
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('GitHub CLI executable "gh" is not installed in the worker environment'));
        return;
      }
      reject(error);
    });
    child.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function appendOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') <= MAX_OUTPUT_BYTES) return next;
  return next.slice(0, MAX_OUTPUT_BYTES) + '\n[output truncated]';
}

function formatResult(result: GitHubCliResult, token: string): string {
  const parts = [`exitCode: ${result.exitCode}`];
  if (result.stdout.trim()) parts.push(`stdout:\n${redactSecrets(result.stdout.trim(), token)}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${redactSecrets(result.stderr.trim(), token)}`);
  return parts.join('\n');
}

function redactSecrets(value: string, token: string): string {
  return value
    .replaceAll(token, '[redacted]')
    .replace(/gh[ousr]_[A-Za-z0-9_]+/g, '[redacted]');
}
