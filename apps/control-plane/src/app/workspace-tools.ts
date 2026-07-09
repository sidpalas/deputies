import { HttpRequestError } from './request.js';
import { parseRepositoryContext, RepositorySetupError } from '../repositories/setup.js';
import type { SandboxHandle } from '../sandbox/types.js';
import { readServices, type PublishedService } from '../sessions/services.js';
import type { AppStore, SessionRecord } from '../store/types.js';

export type WorkspaceTool = {
  id: 'ide' | 'diff';
  label: string;
  port: number;
  path?: string;
  command: (input: WorkspaceToolCommandInput) => string;
};

type WorkspaceToolCommandInput = {
  cwd: string;
  workspacePath: string;
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
    command: ({ workspacePath }) => shell`
      if ! command -v code-server >/dev/null 2>&1; then
        echo "code-server is not installed in this sandbox image" >&2
        exit 127
      fi

      if curl -fsS --max-time 2 http://127.0.0.1:8080/ >/dev/null 2>&1; then
        exit 0
      fi

      mkdir -p ${quoteShell(workspacePath)}
      nohup code-server --bind-addr 0.0.0.0:8080 --auth none ${quoteShell(workspacePath)} >/tmp/deputies-code-server.log 2>&1 &
      ${waitForLocalServiceCommand(8080, 'cat /tmp/deputies-code-server.log >&2 || true')}
    `,
  },
  {
    id: 'diff',
    label: 'Hunk Diff',
    port: 7681,
    command: ({ cwd }) => shell`
      if ! command -v ttyd >/dev/null 2>&1; then
        echo "ttyd is not installed in this sandbox image" >&2
        exit 127
      fi

      if ! command -v hunk >/dev/null 2>&1; then
        echo "hunk is not installed in this sandbox image" >&2
        exit 127
      fi

      if curl -fsS --max-time 2 http://127.0.0.1:7681/ >/dev/null 2>&1; then
        exit 0
      fi

      mkdir -p ${quoteShell(cwd)}
      cat > /tmp/deputies-hunk-viewer.sh <<'DEPUTIES_HUNK_VIEWER'
      ${diffViewerShellCommand(cwd)}
      DEPUTIES_HUNK_VIEWER
      chmod +x /tmp/deputies-hunk-viewer.sh
      nohup ttyd -i 0.0.0.0 -p 7681 -W /tmp/deputies-hunk-viewer.sh >/tmp/deputies-hunk.log 2>&1 &
      ${waitForLocalServiceCommand(7681)}
    `,
  },
];

export function workspaceTool(id: string): WorkspaceTool | null {
  return workspaceTools.find((tool) => tool.id === id) ?? null;
}

export async function startWorkspaceTool(sandbox: SandboxHandle, tool: WorkspaceTool, cwd: string): Promise<void> {
  const command = tool.command({ cwd, workspacePath: sandbox.workspacePath });
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
  return input.store.updateSessionContext({
    id: session.id,
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
  try {
    const repository = parseRepositoryContext(context);
    if (!repository) return workspacePath;
    return `${workspacePath.replace(/\/$/, '')}/${repository.owner}/${repository.repo}`;
  } catch (error) {
    if (error instanceof RepositorySetupError) return workspacePath;
    throw error;
  }
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

function diffViewerShellCommand(cwd: string): string {
  return shell`
    #!/usr/bin/env bash
    set -u

    cat > /tmp/deputies-hunk-lib <<'DEPUTIES_HUNK_LIB'
    restore_terminal() {
      stty sane 2>/dev/null || true
      printf "\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[?1015l\\033[?2004l"
      sleep 0.1
      while IFS= read -r -s -n 1 -t 0.01 _; do :; done
    }
    hunk() {
      command hunk "$@"
      local status=$?
      restore_terminal
      return "$status"
    }
    DEPUTIES_HUNK_LIB

    cat > /tmp/deputies-hunk-rc <<'DEPUTIES_HUNK_RC'
    [ -f ~/.bashrc ] && . ~/.bashrc
    . /tmp/deputies-hunk-lib
    restore_terminal
    DEPUTIES_HUNK_RC

    . /tmp/deputies-hunk-lib

    start_shell() {
      exec bash --rcfile /tmp/deputies-hunk-rc -i
    }

    cd ${quoteShell(cwd)} || exit 1

    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      shopt -s nullglob
      repos=(*/.git)
      if [ "\${#repos[@]}" -eq 1 ]; then
        cd "\${repos[0]%/.git}" || exit 1
      fi
    fi

    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      if [ -z "$(git status --porcelain --untracked-files=normal)" ]; then
        printf "No staged, unstaged, or untracked changes yet.\n\n"
        printf "Make a change in this repository, then run: hunk diff\n\n"
        git status --short --branch
        start_shell
      fi

      command hunk diff
      restore_terminal
      printf "\nHunk Diff closed. Run hunk diff again after making more changes.\n"
      start_shell
    fi

    printf "Diff Viewer needs a Git repository.\n\n"
    printf "This workspace tool opened, but the current workspace directory is not inside a Git repo.\n"
    printf "Start a run that checks out a repository, or cd into the repository here and run: hunk diff\n\n"
    start_shell
  `;
}

function shell(strings: TemplateStringsArray, ...values: string[]): string {
  const tokens = values.map((_, index) => `\0${index}\0`);
  const text = String.raw({ raw: strings.raw }, ...tokens)
    .replace(/^\n/, '')
    .replace(/\n[ \t]*$/, '');
  const lines = text.split('\n');
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  const dedented = lines.map((line) => line.slice(indent)).join('\n');
  return tokens.reduce((command, token, index) => command.replaceAll(token, values[index] ?? ''), dedented);
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
