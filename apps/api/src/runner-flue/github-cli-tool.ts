import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDef } from '@flue/sdk';
import type { GitHubRepositoryAccess } from '../repositories/setup.js';
import { getPreparedRepository, resolveActiveRepositoryAccess, type RepositoryToolServices } from './repository-tool.js';

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
  repository: RepositoryToolServices,
  options: { runner?: GitHubCliRunner; fetchImpl?: typeof fetch } = {},
): ToolDef {
  return {
    name: 'gh',
    description:
      'Run authenticated GitHub CLI/API operations for the active session repository. Use repository status/list/set first if no repository is active. The command is executed by trusted backend code with a short-lived GitHub App installation token. ' +
      'Pull request creation and updates are supported with gh pr create and gh pr edit using direct GitHub API calls. Pass only gh arguments, not the "gh" executable name.',
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
          description: 'Arguments to pass to gh, for example ["issue", "create", "--title", "Test", "--body", "..."], ["pr", "create", "--title", "Test", "--body", "...", "--head", "branch", "--base", "main"], or ["pr", "edit", "7", "--title", "Updated"]',
        },
      },
    },
    async execute(params, signal) {
      const args = validateArgs(params.args);
      const access = await resolveActiveRepositoryAccess(repository);
      if (isPullRequestCreateCommand(args)) {
        return createPullRequest(repository, access, args, options.fetchImpl ?? fetch, signal);
      }
      if (isPullRequestUpdateCommand(args)) {
        return updatePullRequest(repository, access, args, options.fetchImpl ?? fetch, signal);
      }
      const configDir = await mkdtemp(join(tmpdir(), 'deputies-gh-'));
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
  if (isDirectCommentCommand(args)) {
    throw new Error('Posting GitHub issue/PR comments directly through gh is not available. Return the final response normally; Deputies posts it back to GitHub through the callback layer.');
  }
  if (command === 'api' && isGitDatabaseApiRoute(args[1])) {
    throw new Error('GitHub Git Database API routes are not available through gh. Use sandbox git commands and the authenticated git tool for branch/object pushes.');
  }
  return args;
}

function isPullRequestCreateCommand(args: string[]): boolean {
  return args[0] === 'pr' && args[1] === 'create';
}

function isPullRequestUpdateCommand(args: string[]): boolean {
  return args[0] === 'pr' && args[1] === 'edit';
}

async function createPullRequest(
  repository: RepositoryToolServices,
  access: GitHubRepositoryAccess,
  args: string[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const input = await parsePullRequestCreateInput(repository, access, args, fetchImpl, signal);
  const init = createGitHubApiRequestInit(access, { method: 'POST', body: input, signal });
  const response = await fetchImpl(`${githubApiBaseUrl(access)}/repos/${access.owner}/${access.repo}/pulls`, init);
  const body = await response.json().catch(() => ({})) as { html_url?: string; number?: number; message?: string };
  if (!response.ok) {
    throw new Error(redactSecrets(`GitHub API POST /repos/${access.owner}/${access.repo}/pulls failed with ${response.status}: ${body.message ?? 'unknown_error'}`, access.auth.token));
  }
  const url = typeof body.html_url === 'string' ? body.html_url : `https://github.com/${access.owner}/${access.repo}/pull/${body.number ?? ''}`;
  return formatResult({ exitCode: 0, stdout: url, stderr: '' }, access.auth.token);
}

type PullRequestCreateInput = {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
};

async function parsePullRequestCreateInput(
  repository: RepositoryToolServices,
  access: GitHubRepositoryAccess,
  args: string[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<PullRequestCreateInput> {
  let title = '';
  let body = '';
  let head = '';
  let base = '';
  let draft = false;
  let fill = false;

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!;
    switch (arg) {
      case '--title':
      case '-t':
        title = nextPullRequestArg(args, ++index, arg);
        break;
      case '--body':
      case '-b':
        body = nextPullRequestArg(args, ++index, arg);
        break;
      case '--head':
      case '-H':
        head = nextPullRequestArg(args, ++index, arg);
        break;
      case '--base':
      case '-B':
        base = nextPullRequestArg(args, ++index, arg);
        break;
      case '--repo':
      case '-R':
        // The active repository selected through the repository tool is authoritative.
        nextPullRequestArg(args, ++index, arg);
        break;
      case '--draft':
        draft = true;
        break;
      case '--fill':
      case '--fill-first':
      case '--fill-verbose':
        fill = true;
        break;
      default:
        throw new Error(`gh pr create option ${arg} is not supported by this tool. Supported options: --title, --body, --head, --base, --draft, --fill.`);
    }
  }

  if (fill && (!title || !body)) {
    const commit = await readPreparedRepositoryCommit(repository);
    if (!title) title = commit.title;
    if (!body) body = commit.body;
  }
  if (!head) head = await readPreparedRepositoryBranch(repository);
  if (!base) base = await fetchDefaultBranch(access, fetchImpl, signal);
  if (!title.trim()) throw new Error('gh pr create requires --title (or --fill from a prepared repository)');
  if (!head.trim()) throw new Error('gh pr create requires --head or a current branch in a prepared repository');
  if (!base.trim()) throw new Error('gh pr create requires --base or a repository default branch');

  return { title, body, head, base, ...(draft ? { draft } : {}) };
}

function nextPullRequestArg(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) throw new Error(`gh pr option ${flag} requires a value`);
  return value;
}

async function readPreparedRepositoryBranch(repository: RepositoryToolServices): Promise<string> {
  const prepared = getPreparedRepository(repository);
  const agent = repository.agentRef.current;
  if (!agent?.shell) throw new Error('gh pr create cannot infer --head before the sandbox agent is ready');
  const result = await agent.shell('git branch --show-current', { cwd: prepared.workspacePath, timeout: 30 });
  if (result.exitCode !== 0) throw new Error(`gh pr create could not infer --head: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function readPreparedRepositoryCommit(repository: RepositoryToolServices): Promise<{ title: string; body: string }> {
  const prepared = getPreparedRepository(repository);
  const agent = repository.agentRef.current;
  if (!agent?.shell) throw new Error('gh pr create cannot use --fill before the sandbox agent is ready');
  const result = await agent.shell('git log -1 --pretty=format:%s%n%n%b', { cwd: prepared.workspacePath, timeout: 30 });
  if (result.exitCode !== 0) throw new Error(`gh pr create --fill failed: ${result.stderr || result.stdout}`);
  const [title = '', ...body] = result.stdout.trim().split('\n');
  return { title: title.trim(), body: body.join('\n').trim() };
}

async function fetchDefaultBranch(access: GitHubRepositoryAccess, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  const init = createGitHubApiRequestInit(access, { method: 'GET', signal });
  const response = await fetchImpl(`${githubApiBaseUrl(access)}/repos/${access.owner}/${access.repo}`, init);
  const body = await response.json().catch(() => ({})) as { default_branch?: string; message?: string };
  if (!response.ok) throw new Error(redactSecrets(`GitHub API GET /repos/${access.owner}/${access.repo} failed with ${response.status}: ${body.message ?? 'unknown_error'}`, access.auth.token));
  return typeof body.default_branch === 'string' ? body.default_branch : '';
}

async function updatePullRequest(
  repository: RepositoryToolServices,
  access: GitHubRepositoryAccess,
  args: string[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = await parsePullRequestUpdateInput(repository, access, args, fetchImpl, signal);
  const init = createGitHubApiRequestInit(access, { method: 'PATCH', body: parsed.input, signal });
  const response = await fetchImpl(`${githubApiBaseUrl(access)}/repos/${access.owner}/${access.repo}/pulls/${parsed.number}`, init);
  const body = await response.json().catch(() => ({})) as { html_url?: string; number?: number; message?: string };
  if (!response.ok) {
    throw new Error(redactSecrets(`GitHub API PATCH /repos/${access.owner}/${access.repo}/pulls/${parsed.number} failed with ${response.status}: ${body.message ?? 'unknown_error'}`, access.auth.token));
  }
  const url = typeof body.html_url === 'string' ? body.html_url : `https://github.com/${access.owner}/${access.repo}/pull/${body.number ?? parsed.number}`;
  return formatResult({ exitCode: 0, stdout: url, stderr: '' }, access.auth.token);
}

type PullRequestUpdateInput = {
  title?: string;
  body?: string;
  base?: string;
  state?: 'open' | 'closed';
  maintainer_can_modify?: boolean;
};

async function parsePullRequestUpdateInput(
  repository: RepositoryToolServices,
  access: GitHubRepositoryAccess,
  args: string[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ number: number; input: PullRequestUpdateInput }> {
  let selector = '';
  const input: PullRequestUpdateInput = {};

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!;
    switch (arg) {
      case '--title':
      case '-t':
        input.title = nextPullRequestArg(args, ++index, arg);
        break;
      case '--body':
      case '-b':
        input.body = nextPullRequestArg(args, ++index, arg);
        break;
      case '--base':
      case '-B':
        input.base = nextPullRequestArg(args, ++index, arg);
        break;
      case '--state': {
        const state = nextPullRequestArg(args, ++index, arg);
        if (state !== 'open' && state !== 'closed') throw new Error('gh pr edit --state must be either open or closed');
        input.state = state;
        break;
      }
      case '--maintainer-edit':
        input.maintainer_can_modify = true;
        break;
      case '--no-maintainer-edit':
        input.maintainer_can_modify = false;
        break;
      case '--repo':
      case '-R':
        // The active repository selected through the repository tool is authoritative.
        nextPullRequestArg(args, ++index, arg);
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`gh pr ${args[1]} option ${arg} is not supported by this tool. Supported options: --title, --body, --base, --state, --maintainer-edit, --no-maintainer-edit.`);
        }
        if (selector) throw new Error(`gh pr ${args[1]} accepts at most one PR selector`);
        selector = arg;
    }
  }

  if (!Object.keys(input).length) throw new Error(`gh pr ${args[1]} requires at least one update option`);
  const number = await resolvePullRequestNumber(repository, access, selector, fetchImpl, signal);
  return { number, input };
}

async function resolvePullRequestNumber(
  repository: RepositoryToolServices,
  access: GitHubRepositoryAccess,
  selector: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<number> {
  const parsed = parsePullRequestNumber(selector);
  if (parsed) return parsed;
  const branch = selector || await readPreparedRepositoryBranch(repository);
  if (!branch) throw new Error('gh pr edit requires a PR number, URL, branch, or a current branch in a prepared repository');
  return fetchPullRequestNumberForBranch(access, branch, fetchImpl, signal);
}

function parsePullRequestNumber(selector: string): number | null {
  if (!selector) return null;
  if (/^\d+$/.test(selector)) return Number(selector);
  const match = /\/pull\/(\d+)(?:\b|$)/.exec(selector);
  return match ? Number(match[1]) : null;
}

async function fetchPullRequestNumberForBranch(access: GitHubRepositoryAccess, branch: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<number> {
  const query = new URLSearchParams({ head: `${access.owner}:${branch}`, state: 'all', per_page: '1' });
  const init = createGitHubApiRequestInit(access, { method: 'GET', signal });
  const response = await fetchImpl(`${githubApiBaseUrl(access)}/repos/${access.owner}/${access.repo}/pulls?${query.toString()}`, init);
  const body = await response.json().catch(() => ([])) as Array<{ number?: number }> | { message?: string };
  if (!response.ok) {
    const message = Array.isArray(body) ? 'unknown_error' : body.message ?? 'unknown_error';
    throw new Error(redactSecrets(`GitHub API GET /repos/${access.owner}/${access.repo}/pulls failed with ${response.status}: ${message}`, access.auth.token));
  }
  if (!Array.isArray(body) || typeof body[0]?.number !== 'number') throw new Error(`No pull request found for branch ${branch}`);
  return body[0].number;
}

function createGitHubApiRequestInit(
  access: GitHubRepositoryAccess,
  options: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown; signal?: AbortSignal | undefined },
): RequestInit {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${access.auth.token}`,
    'x-github-api-version': '2022-11-28',
  };
  const init: RequestInit = { method: options.method, headers };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) init.signal = options.signal;

  return init;
}

function githubApiBaseUrl(access: GitHubRepositoryAccess): string {
  const host = parseCloneHost(access.cloneUrl);
  if (host && host !== 'github.com') return `https://${host}/api/v3`;
  return 'https://api.github.com';
}

function isDirectCommentCommand(args: string[]): boolean {
  // Final GitHub replies are owned by the callback layer so each webhook turn
  // posts at most one response. Blocking direct comments prevents duplicates.
  const command = args[0];
  const subcommand = args[1];
  if ((command === 'issue' || command === 'pr') && subcommand === 'comment') return true;
  if (command === 'api') return isCommentApiRoute(args[1], args);
  return false;
}

function isCommentApiRoute(route: string | undefined, args: string[]): boolean {
  if (!route || !args.includes('--method') || !args.includes('POST')) return false;
  const normalized = route.replace(/^\/+/, '');
  return /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(normalized) ||
    /^repos\/[^/]+\/[^/]+\/pulls\/comments(?:\/\d+\/replies)?$/.test(normalized) ||
    /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(normalized);
}

function isGitDatabaseApiRoute(route: string | undefined): boolean {
  if (!route) return false;
  return /^repos\/[^/]+\/[^/]+\/git(?:\/|$)/.test(route.replace(/^\/+/, ''));
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
