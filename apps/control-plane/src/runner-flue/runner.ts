import type { FlueEvent } from '@flue/sdk';
import type { NormalizedEvent } from '../events/types.js';
import type { ArtifactService } from '../artifacts/service.js';
import type { ExternalResourceService } from '../external-resources/service.js';
import type { SandboxKeepaliveService } from '../sandbox/service.js';
import {
  prepareRepositoryShellSetup,
  type RepositoryAccessProvider,
  type RepositoryShellSetup,
} from '../repositories/setup.js';
import type { Runner, RunnerInput, RunnerResult } from '../runner/types.js';
import { createArtifactTool } from './artifact-tool.js';
import { createGitTool, type AgentRef } from './git-tool.js';
import { createGitHubCliTool } from './github-cli-tool.js';
import { createPreviewTool } from './preview-tool.js';
import { createRepositoryTool, type RepositoryToolServices, type RepositoryToolState } from './repository-tool.js';
import type { FlueAgentFactory, FlueSessionPort } from './types.js';

export type FlueRunnerOptions = {
  repositoryAccess?: {
    github?: RepositoryAccessProvider;
  };
  artifacts?: ArtifactService;
  externalResources?: ExternalResourceService;
  artifactToolMaxBytes?: number;
  sandboxKeepalive?: SandboxKeepaliveService;
  sandboxKeepaliveMaxExtensionMs?: number;
};

export class FlueRunner implements Runner {
  constructor(
    private readonly agentFactory: FlueAgentFactory,
    private readonly options: FlueRunnerOptions = {},
  ) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    const pendingEvents: Array<Promise<void>> = [];
    let sawTextDelta = false;
    const repositorySetupInput: Parameters<typeof prepareRepositoryShellSetup>[0] = {
      context: input.context,
      sandbox: input.sandbox,
    };
    if (this.options.repositoryAccess?.github) repositorySetupInput.github = this.options.repositoryAccess.github;
    const repositorySetup = await prepareRepositoryShellSetup(repositorySetupInput);
    const agentRef: AgentRef = {};
    const repositoryState: RepositoryToolState = { context: structuredClone(input.context) };
    if (repositorySetup) {
      repositoryState.prepared = {
        repository: { provider: 'github', owner: repositorySetup.access.owner, repo: repositorySetup.access.repo },
        access: repositorySetup.access,
        workspacePath: repositorySetup.workspacePath,
      };
    }
    const repositoryServices = this.options.repositoryAccess?.github
      ? ({
          github: this.options.repositoryAccess.github,
          sandbox: input.sandbox,
          agentRef,
          state: repositoryState,
          emit: input.emit,
          eventBase: { sessionId: input.sessionId, runId: input.runId, messageId: input.messageId },
          ...(input.updateSessionContext ? { updateSessionContext: input.updateSessionContext } : {}),
        } satisfies RepositoryToolServices)
      : null;
    const tools = [];
    if (this.options.artifacts) {
      tools.push(
        createArtifactTool({
          artifacts: this.options.artifacts,
          sandbox: input.sandbox,
          sessionId: input.sessionId,
          runId: input.runId,
          messageId: input.messageId,
          maxBytes: this.options.artifactToolMaxBytes ?? 25 * 1024 * 1024,
        }),
      );
    }
    if (repositoryServices) {
      tools.push(
        createRepositoryTool(repositoryServices),
        createGitHubCliTool(repositoryServices, {
          ...(this.options.externalResources ? { externalResources: this.options.externalResources } : {}),
          sessionId: input.sessionId,
          runId: input.runId,
          messageId: input.messageId,
        }),
        createGitTool({ agentRef, repository: repositoryServices }),
      );
    }
    if (input.updateSessionContext) {
      tools.push(
        createPreviewTool({
          sessionId: input.sessionId,
          providerSandboxId: input.sandbox.providerSandboxId,
          sandboxMetadata: input.sandbox.metadata,
          updateSessionContext: input.updateSessionContext,
          getContext: () => repositoryState.context,
          setContext: (context) => {
            repositoryState.context = context;
          },
          ...(this.options.sandboxKeepalive ? { keepalive: this.options.sandboxKeepalive } : {}),
          ...(this.options.sandboxKeepaliveMaxExtensionMs
            ? { keepaliveMaxExtensionMs: this.options.sandboxKeepaliveMaxExtensionMs }
            : {}),
        }),
      );
    }

    const agent = await this.agentFactory.create({
      agentId: input.sessionId,
      sessionId: input.sessionId,
      sandbox: input.sandbox,
      cwd: repositorySetup?.workspacePath ?? input.sandbox.workspacePath,
      tools,
      onEvent: (event) => {
        if (input.signal?.aborted) return;
        const normalized = normalizeFlueEvent(event, input);
        if (!normalized) return;
        if (normalized.type === 'agent_text_delta') sawTextDelta = true;
        pendingEvents.push(input.emit(normalized));
      },
    });
    agentRef.current = agent;
    const session = await agent.session(input.sessionId);
    const abortSession = () => session.abort?.();
    input.signal?.addEventListener('abort', abortSession, { once: true });

    try {
      await input.emit({
        sessionId: input.sessionId,
        runId: input.runId,
        messageId: input.messageId,
        type: 'run_started',
        payload: { runner: 'flue' },
        createdAt: new Date(),
      });

      if (repositorySetup) await this.runRepositorySetup(input, repositorySetup, session);

      // Cancellation must not leave partial Flue turn state in durable history.
      // A prompt-only warning is cheaper but advisory, and models can still continue
      // cancelled work from persisted context.
      const sessionSnapshot = await this.loadSessionSnapshot(input.sessionId);
      if (input.signal?.aborted) throw new Error('Operation aborted');
      let response;
      try {
        response = await session.prompt(
          withToolGuidance(input.prompt, Boolean(this.options.artifacts), Boolean(repositoryServices)),
        );
      } finally {
        if (input.signal?.aborted) await this.restoreSessionSnapshot(input.sessionId, sessionSnapshot);
      }
      await Promise.all(pendingEvents);
      if (input.signal?.aborted) throw new Error('Operation aborted');

      if (!sawTextDelta && response.text) {
        await input.emit({
          sessionId: input.sessionId,
          runId: input.runId,
          messageId: input.messageId,
          type: 'agent_text_delta',
          payload: { text: response.text },
          createdAt: new Date(),
        });
      }
      await input.emit({
        sessionId: input.sessionId,
        runId: input.runId,
        messageId: input.messageId,
        type: 'run_completed',
        payload: { runner: 'flue' },
        createdAt: new Date(),
      });

      return { text: response.text };
    } finally {
      input.signal?.removeEventListener('abort', abortSession);
    }
  }

  private async runRepositorySetup(
    input: RunnerInput,
    setup: RepositoryShellSetup,
    session: FlueSessionPort,
  ): Promise<void> {
    if (!session.shell) throw new Error('Flue session does not support shell commands for repository setup');
    const result = await session.shell(setup.command, {
      cwd: input.sandbox.workspacePath,
      env: setup.env,
      timeout: 120_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Repository setup failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`);
    }
    await input.emit({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      type: 'repository_ready',
      payload: {
        provider: setup.access.provider,
        owner: setup.access.owner,
        repo: setup.access.repo,
        workspacePath: setup.workspacePath,
        expiresAt: setup.access.expiresAt.toISOString(),
      },
      createdAt: new Date(),
    });
  }

  private async loadSessionSnapshot(sessionId: string) {
    const data = await this.agentFactory.loadSession?.(sessionId);
    return data ? structuredClone(data) : null;
  }

  private async restoreSessionSnapshot(
    sessionId: string,
    snapshot: Awaited<ReturnType<FlueRunner['loadSessionSnapshot']>>,
  ): Promise<void> {
    if (snapshot) {
      await this.agentFactory.saveSession?.(sessionId, snapshot);
    } else {
      await this.agentFactory.deleteSession?.(sessionId);
    }
  }
}

function withToolGuidance(prompt: string, includeArtifacts: boolean, includeRepository: boolean): string {
  const lines = [
    'Preview tool guidance:',
    '- If you start or identify a web server the user should open, call preview({ action: "publish", port, label, path, ttlSeconds }) after confirming the server is running. Use ttlSeconds of at least 300 for interactive previews so the sandbox stays alive long enough for the user to open it. Multiple previews may be visible at the same time.',
    '- Use preview({ action: "extend", port, ttlSeconds }) to keep an existing preview sandbox alive longer, preview({ action: "list" }) to inspect published previews, and preview({ action: "unpublish", port }) to remove stale links.',
    '- Do not publish ports that are not serving an app or useful HTTP endpoint.',
    '- For Vite dev servers published as previews, do not hard-code server.hmr.host, server.hmr.clientPort, or server.hmr.protocol to localhost; let Vite infer the browser preview URL unless the user specifically asks otherwise.',
    '',
  ];
  if (includeArtifacts) {
    lines.push(
      'Artifact tool guidance:',
      '- Use artifact({ action: "create", ... }) for files the user should view or download, including screenshots, images, reports, logs, and videos.',
      '- If you mention a created artifact in your final response, use the markdownLink returned by the artifact tool as-is, or use its downloadUrl as the markdown href. Do not wrap artifact download URLs in the session URL.',
      '- Use artifact type=video only for browser-playable MP4 files. If you create AVI, MOV, MKV, or another video format, publish it as type=file so it is download-only.',
      '',
    );
  }
  if (includeRepository) {
    lines.push(
      'Repository tool guidance:',
      '- Before doing repository-specific work, use repository({ action: "status" }) to inspect the active repo.',
      '- If a repository is already active and the user did not ask to switch, use it.',
      '- If the user clearly names or chooses a repo for ongoing work, use repository({ action: "set", owner, repo, reason }) and then repository({ action: "prepare" }) in the same turn.',
      '- Do not stop after setting the repo when the next useful step is obviously preparation; prepare immediately unless the user only asked to inspect or select repos.',
      '- If the repo is unclear, use repository({ action: "list" }) and ask the user to choose instead of guessing.',
      '- Use repository({ action: "prepare" }) before reading or editing files in the repo.',
      '- Use normal file and shell tools for local code changes and commits, git for authenticated remote git operations, and gh for GitHub issues, comments, and pull requests.',
      '',
    );
  }
  lines.push('User request:', prompt);
  return lines.join('\n');
}

function normalizeFlueEvent(event: FlueEvent, input: RunnerInput): NormalizedEvent | null {
  const base = {
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: input.messageId,
    createdAt: new Date(),
  };
  const flueSessionId = event.session;

  switch (event.type) {
    case 'text_delta':
      return {
        ...base,
        type: 'agent_text_delta',
        payload: { text: event.text, flueSessionId },
      };
    case 'tool_start':
      return {
        ...base,
        type: 'tool_started',
        payload: {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
          flueSessionId,
        },
      };
    case 'tool_call':
      return {
        ...base,
        type: 'tool_finished',
        payload: {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: event.result,
          flueSessionId,
        },
      };
    case 'task_start':
      return {
        ...base,
        type: 'tool_started',
        payload: {
          toolName: 'task',
          taskId: event.taskId,
          prompt: event.prompt,
          role: event.role,
          cwd: event.cwd,
          parentSessionId: event.parentSession,
          flueSessionId,
        },
      };
    case 'task':
      return {
        ...base,
        type: 'tool_finished',
        payload: {
          toolName: 'task',
          taskId: event.taskId,
          isError: event.isError,
          result: event.result,
          parentSessionId: event.parentSession,
          flueSessionId,
        },
      };
    case 'operation_start':
      if (event.operationKind !== 'shell') return null;
      return {
        ...base,
        type: 'tool_started',
        payload: { toolName: 'command', args: { operationId: event.operationId }, flueSessionId },
      };
    case 'operation':
      if (event.operationKind !== 'shell') return null;
      return {
        ...base,
        type: 'tool_finished',
        payload: {
          toolName: 'command',
          isError: event.isError,
          result: event.result,
          flueSessionId,
        },
      };
    case 'run_end':
      if (!event.isError) return null;
      return {
        ...base,
        type: 'tool_finished',
        payload: { toolName: 'flue', isError: true, error: event.error, flueSessionId },
      };
    case 'log':
      if (event.level !== 'error') return null;
      return {
        ...base,
        type: 'tool_finished',
        payload: { toolName: 'flue', isError: true, error: event.message, flueSessionId },
      };
    case 'run_start':
    case 'thinking_start':
    case 'thinking_delta':
    case 'thinking_end':
    case 'turn':
    case 'compaction_start':
    case 'compaction':
    case 'idle':
      return null;
  }
}
