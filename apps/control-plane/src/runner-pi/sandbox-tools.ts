import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type EditOperations,
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type { SandboxFileSystem, SandboxHandle } from '../sandbox/types.js';

type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase: boolean;
  literal: boolean;
  context: number;
  limit: number;
  requestedContext?: number;
  requestedLimit?: number;
};

const defaultGrepLimit = 100;
const maxGrepLimit = 200;
const maxGrepContext = 10;
const maxFindLimit = 5000;
const grepMaxLineLength = 2000;
const grepMaxOutputBytes = 100 * 1024;
const grepMaxContextFileBytes = 1024 * 1024;
const grepExecTimeoutMs = 30_000;
const findExecTimeoutMs = 30_000;

const imageMimeTypes = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

const grepToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern'],
  properties: {
    pattern: { type: 'string', description: 'Search pattern (regex or literal string)' },
    path: { type: 'string', description: 'Directory or file to search (default: current directory)' },
    glob: { type: 'string', description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
    ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
    literal: { type: 'boolean', description: 'Treat pattern as literal string instead of regex (default: false)' },
    context: { type: 'number', description: 'Number of lines to show before and after each match (default: 0)' },
    limit: { type: 'number', description: `Maximum number of matches to return (default: ${defaultGrepLimit})` },
  },
} as const;

const piGrepToolParameters = grepToolParameters as unknown as ToolDefinition['parameters'];
const findSignalStorage = new AsyncLocalStorage<AbortSignal | undefined>();

export function createSandboxPiToolDefinitions(sandbox: SandboxHandle, cwd: string): ToolDefinition[] {
  return [
    createReadToolDefinition(cwd, { operations: createReadOperations(sandbox) }),
    createBashToolDefinition(cwd, { operations: createBashOperations(sandbox) }),
    createEditToolDefinition(cwd, { operations: createEditOperations(sandbox) }),
    createWriteToolDefinition(cwd, { operations: createWriteOperations(sandbox) }),
    createSandboxGrepToolDefinition(sandbox, cwd),
    createSandboxFindToolDefinition(sandbox, cwd),
    createLsToolDefinition(cwd, { operations: createLsOperations(sandbox) }),
  ] as unknown as ToolDefinition[];
}

function createReadOperations(sandbox: SandboxHandle): ReadOperations {
  return {
    async readFile(absolutePath) {
      return Buffer.from(await requireFs(sandbox).readFileBuffer(absolutePath));
    },
    async access(absolutePath) {
      const stat = await requireFs(sandbox).stat(absolutePath);
      if (!stat.isFile) throw new Error(`Path is not a file: ${absolutePath}`);
    },
    async detectImageMimeType(absolutePath) {
      return imageMimeTypes.get(path.extname(absolutePath).toLowerCase()) ?? null;
    },
  };
}

function createWriteOperations(sandbox: SandboxHandle): WriteOperations {
  return {
    async writeFile(absolutePath, content) {
      await requireFs(sandbox).writeFile(absolutePath, content);
    },
    async mkdir(dir) {
      await requireFs(sandbox).mkdir(dir, { recursive: true });
    },
  };
}

function createEditOperations(sandbox: SandboxHandle): EditOperations {
  return {
    async readFile(absolutePath) {
      return Buffer.from(await requireFs(sandbox).readFileBuffer(absolutePath));
    },
    async writeFile(absolutePath, content) {
      await requireFs(sandbox).writeFile(absolutePath, content);
    },
    async access(absolutePath) {
      const stat = await requireFs(sandbox).stat(absolutePath);
      if (!stat.isFile) throw new Error(`Path is not a file: ${absolutePath}`);
    },
  };
}

function createBashOperations(sandbox: SandboxHandle): BashOperations {
  return {
    async exec(command, cwd, options) {
      // Deliberately do not forward options.env. The Pi process environment may
      // contain credentials; sandbox commands should receive only the provider's
      // controlled base environment.
      const result = await sandbox.exec({
        command,
        cwd,
        ...(options.timeout ? { timeoutMs: options.timeout * 1000 } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (result.stdout) options.onData(Buffer.from(result.stdout));
      if (result.stderr) options.onData(Buffer.from(result.stderr));
      return { exitCode: result.exitCode };
    },
  };
}

function createLsOperations(sandbox: SandboxHandle): LsOperations {
  return {
    async exists(absolutePath) {
      return requireFs(sandbox).exists(absolutePath);
    },
    async stat(absolutePath) {
      const stat = await requireFs(sandbox).stat(absolutePath);
      return { isDirectory: () => stat.isDirectory };
    },
    async readdir(absolutePath) {
      return requireFs(sandbox).readdir(absolutePath);
    },
  };
}

function createFindOperations(sandbox: SandboxHandle): FindOperations {
  return {
    async exists(absolutePath) {
      return requireFs(sandbox).exists(absolutePath);
    },
    async glob(pattern, cwd, options) {
      const command = sandboxFindCommandFromPiOptions(pattern, cwd, options);
      const signal = findSignalStorage.getStore();
      const result = await sandbox.exec({ command, cwd, timeoutMs: findExecTimeoutMs, ...(signal ? { signal } : {}) });
      if (result.exitCode !== 0) throw new Error(findErrorMessage(result));
      return result.stdout
        .split('\n')
        .map((line) => line.replace(/\r$/, '').trim())
        .filter(Boolean);
    },
  };
}

function createSandboxFindToolDefinition(sandbox: SandboxHandle, cwd: string): ToolDefinition {
  const tool = createFindToolDefinition(cwd, { operations: createFindOperations(sandbox) }) as ToolDefinition;
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return findSignalStorage.run(signal, () => tool.execute(toolCallId, params, signal, onUpdate, ctx));
    },
  };
}

function createSandboxGrepToolDefinition(sandbox: SandboxHandle, cwd: string): ToolDefinition {
  return {
    name: 'grep',
    label: 'grep',
    description: `Search sandbox file contents for a pattern. Returns matching lines with file paths and line numbers. Output is capped to ${defaultGrepLimit} matches by default.`,
    promptSnippet: 'Search sandbox file contents for patterns',
    parameters: piGrepToolParameters,
    async execute(_toolCallId, params, signal) {
      const input = readGrepInput(params as Record<string, unknown>);
      const searchPath = resolveSandboxPath(cwd, input.path ?? '.');
      const fs = requireFs(sandbox);
      const stat = await statExistingPath(fs, searchPath);
      const command = sandboxGrepCommand(input, searchPath);
      const result = await sandbox.exec({ command, cwd, timeoutMs: grepExecTimeoutMs, ...(signal ? { signal } : {}) });
      if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(grepErrorMessage(result));
      const outputLines: string[] = [];
      let matchCount = 0;
      let matchLimitReached = false;
      let linesTruncated = false;
      let outputTruncated = false;

      events: for (const event of parseRipgrepEvents(result.stdout)) {
        assertNotAborted(signal);
        if (event.type !== 'match') continue;
        const filePath = typeof event.data?.path?.text === 'string' ? event.data.path.text : '';
        const lineNumber = typeof event.data?.line_number === 'number' ? event.data.line_number : 0;
        if (!filePath || !lineNumber) continue;
        matchCount++;
        if (input.context > 0) {
          const block = await formatGrepContextBlock(
            fs,
            searchPath,
            stat.isDirectory,
            filePath,
            lineNumber,
            input.context,
          );
          for (const line of block.lines) {
            if (!appendOutputLine(outputLines, line)) {
              outputTruncated = true;
              break events;
            }
          }
          if (block.truncated) linesTruncated = true;
        } else {
          const lineText = typeof event.data?.lines?.text === 'string' ? event.data.lines.text : '';
          const formatted = truncateGrepLine(lineText.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n$/, ''));
          if (formatted.truncated) linesTruncated = true;
          if (
            !appendOutputLine(
              outputLines,
              `${formatGrepPath(searchPath, stat.isDirectory, filePath)}:${lineNumber}: ${formatted.text}`,
            )
          ) {
            outputTruncated = true;
            break;
          }
        }
        if (matchCount >= input.limit) {
          matchLimitReached = true;
          break;
        }
      }

      if (matchCount === 0) return { content: [{ type: 'text', text: 'No matches found' }], details: undefined };

      const notices: string[] = [];
      const details: Record<string, unknown> = {};
      if (input.requestedLimit !== undefined && input.requestedLimit > input.limit) {
        notices.push(`Requested limit capped to ${input.limit} matches`);
        details.limitCapped = input.limit;
      }
      if (input.requestedContext !== undefined && input.requestedContext > input.context) {
        notices.push(`Requested context capped to ${input.context} lines`);
        details.contextCapped = input.context;
      }
      if (matchLimitReached) {
        notices.push(`${input.limit} matches limit reached. Increase limit or refine pattern`);
        details.matchLimitReached = input.limit;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${grepMaxLineLength} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      if (outputTruncated) {
        notices.push(`Output truncated to ${grepMaxOutputBytes} bytes. Refine pattern or lower context`);
        details.outputTruncated = true;
      }
      if (notices.length > 0) outputLines.push('', `[${notices.join('. ')}]`);
      return {
        content: [{ type: 'text', text: outputLines.join('\n') }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}

async function statExistingPath(fs: SandboxFileSystem, absolutePath: string) {
  try {
    return await fs.stat(absolutePath);
  } catch {
    throw new Error(`Path not found: ${absolutePath}`);
  }
}

function readGrepInput(params: Record<string, unknown>): GrepInput {
  const pattern = typeof params.pattern === 'string' ? params.pattern : '';
  if (!pattern) throw new Error('grep pattern must be a non-empty string');
  const input: GrepInput = {
    pattern,
    ignoreCase: params.ignoreCase === true,
    literal: params.literal === true,
    context: readBoundedNonNegativeInteger(params.context, 0, maxGrepContext),
    limit: readBoundedPositiveInteger(params.limit, defaultGrepLimit, maxGrepLimit),
  };
  if (typeof params.context === 'number' && Number.isFinite(params.context))
    input.requestedContext = Math.floor(params.context);
  if (typeof params.limit === 'number' && Number.isFinite(params.limit))
    input.requestedLimit = Math.floor(params.limit);
  if (typeof params.path === 'string' && params.path.trim()) input.path = params.path;
  if (typeof params.glob === 'string' && params.glob.trim()) input.glob = params.glob;
  return input;
}

async function formatGrepContextBlock(
  fs: SandboxFileSystem,
  searchPath: string,
  isDirectory: boolean,
  filePath: string,
  lineNumber: number,
  context: number,
): Promise<{ lines: string[]; truncated: boolean }> {
  let content: string;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > grepMaxContextFileBytes) {
      return {
        lines: [
          `${formatGrepPath(searchPath, isDirectory, filePath)}:${lineNumber}: (context skipped; file exceeds ${grepMaxContextFileBytes} bytes)`,
        ],
        truncated: true,
      };
    }
    content = await fs.readFile(filePath);
  } catch {
    return {
      lines: [`${formatGrepPath(searchPath, isDirectory, filePath)}:${lineNumber}: (unable to read file)`],
      truncated: false,
    };
  }
  return formatGrepBlock(formatGrepPath(searchPath, isDirectory, filePath), content, lineNumber, context);
}

function formatGrepBlock(
  relativePath: string,
  content: string,
  lineNumber: number,
  context: number,
): { lines: string[]; truncated: boolean } {
  const output: string[] = [];
  let truncated = false;
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const matchIndex = lineNumber - 1;
  const start = Math.max(0, matchIndex - context);
  const end = Math.min(lines.length - 1, matchIndex + context);
  for (let index = start; index <= end; index++) {
    const formatted = truncateGrepLine(lines[index] ?? '');
    if (formatted.truncated) truncated = true;
    const lineNumber = index + 1;
    const separator = index === matchIndex ? ':' : '-';
    output.push(`${relativePath}${separator}${lineNumber}${separator} ${formatted.text}`);
  }
  return { lines: output, truncated };
}

function truncateGrepLine(line: string): { text: string; truncated: boolean } {
  if (line.length <= grepMaxLineLength) return { text: line, truncated: false };
  return { text: `${line.slice(0, grepMaxLineLength)}...`, truncated: true };
}

function readBoundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function readBoundedNonNegativeInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

function resolveSandboxPath(cwd: string, requestedPath: string): string {
  if (path.posix.isAbsolute(requestedPath)) return path.posix.normalize(requestedPath);
  return path.posix.resolve(cwd, requestedPath);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}

function appendOutputLine(lines: string[], line: string): boolean {
  const next = lines.length ? `${lines.join('\n')}\n${line}` : line;
  if (Buffer.byteLength(next, 'utf8') > grepMaxOutputBytes) return false;
  lines.push(line);
  return true;
}

function sandboxGrepCommand(input: GrepInput, searchPath: string): string {
  const args = ['rg', '--json', '--line-number', '--color=never', '--hidden', '--max-count', String(input.limit)];
  if (input.ignoreCase) args.push('--ignore-case');
  if (input.literal) args.push('--fixed-strings');
  if (input.glob) args.push('--glob', input.glob);
  args.push('--', input.pattern, searchPath);
  return joinShellArgs(args);
}

function sandboxFindCommandFromPiOptions(
  pattern: string,
  cwd: string,
  options: { ignore: string[]; limit: number },
): string {
  const requestedLimit = Number.isFinite(options.limit) ? Math.floor(options.limit) : maxFindLimit;
  const limit = Math.min(maxFindLimit, Math.max(1, requestedLimit));
  const args = ['--glob', '--color=never', '--hidden', '--no-require-git', '--max-results', String(limit)];
  for (const ignored of options.ignore) args.push('--exclude', ignored);

  let effectivePattern = pattern;
  if (pattern.includes('/')) {
    args.push('--full-path');
    if (!pattern.startsWith('/') && !pattern.startsWith('**/') && pattern !== '**') {
      effectivePattern = `**/${pattern}`;
    }
  }
  args.push('--', effectivePattern, cwd);
  const quotedArgs = joinShellArgs(args);
  return `(command -v fd >/dev/null 2>&1 && exec fd ${quotedArgs}; command -v fdfind >/dev/null 2>&1 && exec fdfind ${quotedArgs}; echo 'fd is not available in the sandbox' >&2; exit 127)`;
}

type RipgrepEvent = {
  data?: {
    line_number?: unknown;
    lines?: { text?: unknown };
    path?: { text?: unknown };
  };
  type?: unknown;
};

function parseRipgrepEvents(stdout: string): RipgrepEvent[] {
  const events: RipgrepEvent[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null) events.push(parsed);
    } catch {
      // Sandbox output may be truncated; ignore incomplete JSON lines.
    }
  }
  return events;
}

function formatGrepPath(searchPath: string, isDirectory: boolean, filePath: string): string {
  if (!isDirectory) return path.posix.basename(filePath);
  return relativeSandboxPath(searchPath, filePath);
}

function relativeSandboxPath(searchPath: string, filePath: string): string {
  const normalizedSearch = path.posix.normalize(searchPath);
  const normalizedFile = path.posix.normalize(filePath);
  const relative = path.posix.relative(normalizedSearch, normalizedFile);
  if (relative && !relative.startsWith('..') && !path.posix.isAbsolute(relative)) return relative;
  return normalizedFile;
}

function grepErrorMessage(result: { exitCode: number; stderr: string; stdout: string }): string {
  const message = (result.stderr || result.stdout).trim();
  if (result.exitCode === 127 || /rg: not found|rg: command not found|command not found: rg/.test(message)) {
    return 'ripgrep (rg) is not available in the sandbox';
  }
  return message || `ripgrep exited with code ${result.exitCode}`;
}

function findErrorMessage(result: { exitCode: number; stderr: string; stdout: string }): string {
  const message = (result.stderr || result.stdout).trim();
  if (result.exitCode === 127) return 'fd is not available in the sandbox';
  return message || `fd exited with code ${result.exitCode}`;
}

function joinShellArgs(args: string[]): string {
  return args.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function requireFs(sandbox: SandboxHandle): SandboxFileSystem {
  if (!sandbox.fs) {
    throw new Error(`Sandbox provider "${sandbox.provider}" does not expose filesystem operations`);
  }
  return sandbox.fs;
}
