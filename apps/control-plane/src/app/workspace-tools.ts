import { HttpRequestError } from './request.js';
import type { SandboxHandle } from '../sandbox/types.js';
import { readServices, type PublishedService } from '../sessions/services.js';
import type { AppStore, SessionRecord } from '../store/types.js';

export type WorkspaceTool = {
  id: 'ide' | 'diff';
  label: string;
  port: number;
  path?: string;
  command: string;
};

export type WorkspaceToolPublishInput = {
  session: SessionRecord;
  store: AppStore;
  tool: WorkspaceTool;
  providerSandboxId: string;
  path?: string;
  runtimeId?: string;
};

export const workspaceToolKeepaliveMs = 10 * 60 * 1000;
export const destroyedSandboxWorkspaceMessage =
  'This sandbox was destroyed. Filesystem state is not persisted across sandbox destruction; start a fresh run to create a new workspace.';

const workspaceTools: WorkspaceTool[] = [
  {
    id: 'ide',
    label: 'VS Code',
    port: 8080,
    command: [
      'if ! command -v code-server >/dev/null 2>&1; then echo "code-server is not installed in this sandbox image" >&2; exit 127; fi',
      'if curl -fsS --max-time 2 http://127.0.0.1:8080/ >/dev/null 2>&1; then exit 0; fi',
      'mkdir -p __DEPUTIES_WORKSPACE__',
      'nohup code-server --bind-addr 0.0.0.0:8080 --auth none __DEPUTIES_WORKSPACE__ >/tmp/deputies-code-server.log 2>&1 &',
      waitForLocalServiceCommand(8080, 'cat /tmp/deputies-code-server.log >&2 || true'),
    ].join('\n'),
  },
  {
    id: 'diff',
    label: 'Hunk Diff',
    port: 7681,
    command: [
      'if ! command -v ttyd >/dev/null 2>&1; then echo "ttyd is not installed in this sandbox image" >&2; exit 127; fi',
      'if ! command -v hunk >/dev/null 2>&1; then echo "hunk is not installed in this sandbox image" >&2; exit 127; fi',
      'if curl -fsS --max-time 2 http://127.0.0.1:7681/ >/dev/null 2>&1; then exit 0; fi',
      'mkdir -p __DEPUTIES_TOOL_CWD__',
      `cat > /tmp/deputies-hunk-viewer.sh <<'DEPUTIES_HUNK_VIEWER'\n${diffViewerShellCommand()}\nDEPUTIES_HUNK_VIEWER`,
      'chmod +x /tmp/deputies-hunk-viewer.sh',
      'nohup ttyd -i 0.0.0.0 -p 7681 -W /tmp/deputies-hunk-viewer.sh >/tmp/deputies-hunk.log 2>&1 &',
      waitForLocalServiceCommand(7681),
    ].join('\n'),
  },
];

export function workspaceTool(id: string): WorkspaceTool | null {
  return workspaceTools.find((tool) => tool.id === id) ?? null;
}

export async function startWorkspaceTool(sandbox: SandboxHandle, tool: WorkspaceTool, cwd: string): Promise<void> {
  const command = tool.command
    .replaceAll('__DEPUTIES_WORKSPACE__', quoteShell(sandbox.workspacePath))
    .replaceAll('__DEPUTIES_TOOL_CWD__', quoteShell(cwd));
  const result = await sandbox.exec({
    command,
    cwd,
    timeoutMs: 20_000,
  });
  if (result.exitCode === 0) return;
  const message = (result.stderr || result.stdout).trim() || `${tool.label} failed to start`;
  throw new HttpRequestError(result.exitCode === 127 ? 409 : 503, 'workspace_tool_start_failed', message);
}

export async function publishWorkspaceToolService(input: WorkspaceToolPublishInput): Promise<SessionRecord> {
  const session = (await input.store.getSession(input.session.id)) ?? input.session;
  const current = readServices(session.context ?? {}).filter((service) => service.port !== input.tool.port);
  const service: PublishedService = {
    port: input.tool.port,
    label: input.tool.label,
    providerSandboxId: input.providerSandboxId,
  };
  if (input.path) service.path = input.path;
  if (input.runtimeId) service.runtimeId = input.runtimeId;
  return input.store.updateSession({
    ...session,
    context: { ...(session.context ?? {}), services: [...current, service].sort((a, b) => a.port - b.port) },
    updatedAt: new Date(),
  });
}

export function workspaceToolServiceMetadata(tool: WorkspaceTool, path?: string): { label: string; path?: string } {
  return path ? { label: tool.label, path } : { label: tool.label };
}

export function workspaceToolServicePath(tool: WorkspaceTool, workspacePath: string): string | undefined {
  if (tool.id !== 'ide') return tool.path;
  return `/?folder=${encodeURIComponent(workspacePath)}`;
}

export function workspaceToolWorkingDirectory(
  tool: WorkspaceTool,
  context: Record<string, unknown>,
  workspacePath: string,
): string {
  if (tool.id !== 'diff') return workspacePath;
  const repository = context.repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) return workspacePath;
  const repo = (repository as Record<string, unknown>).repo;
  if (typeof repo !== 'string' || !repo.trim() || repo.includes('/')) return workspacePath;
  return `${workspacePath.replace(/\/$/, '')}/${repo}`;
}

function waitForLocalServiceCommand(port: number, onFailure?: string): string {
  return [
    'for i in $(seq 1 20); do',
    `  if curl -fsS --max-time 2 http://127.0.0.1:${port}/ >/dev/null 2>&1; then exit 0; fi`,
    '  sleep 0.5',
    'done',
    ...(onFailure ? [onFailure] : []),
    'echo "service unreachable: the process may still be starting, exited, or listening on another port" >&2',
    'exit 70',
  ].join('\n');
}

function diffViewerShellCommand(): string {
  return [
    'cd __DEPUTIES_TOOL_CWD__ || exit 1',
    'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
    '  exec hunk diff --watch',
    'fi',
    'printf "Diff Viewer needs a Git repository.\\n\\n"',
    'printf "This workspace tool opened, but the current workspace directory is not inside a Git repo.\\n"',
    'printf "Start a run that checks out a repository, or cd into the repository here and run: hunk diff --watch\\n\\n"',
    'exec bash -l',
  ].join('\n');
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}
