import type { FlueEvent } from '@flue/sdk';
import type { NormalizedEvent } from '../events/types.js';
import { prepareRepositoryShellSetup, type RepositoryAccessProvider, type RepositoryShellSetup } from '../repositories/setup.js';
import type { Runner, RunnerInput, RunnerResult } from '../runner/types.js';
import type { FlueAgentFactory, FlueSessionPort } from './types.js';

export type FlueRunnerOptions = {
  repositoryAccess?: {
    github?: RepositoryAccessProvider;
  };
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
    const agent = await this.agentFactory.create({
      agentId: input.sessionId,
      sessionId: input.sessionId,
      sandbox: input.sandbox,
      cwd: repositorySetup?.workspacePath ?? input.sandbox.workspacePath,
      onEvent: (event) => {
        if (input.signal?.aborted) return;
        const normalized = normalizeFlueEvent(event, input);
        if (!normalized) return;
        if (normalized.type === 'agent_text_delta') sawTextDelta = true;
        pendingEvents.push(input.emit(normalized));
      },
    });
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
        response = await session.prompt(input.prompt);
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
      timeout: 120,
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

  private async restoreSessionSnapshot(sessionId: string, snapshot: Awaited<ReturnType<FlueRunner['loadSessionSnapshot']>>): Promise<void> {
    if (snapshot) {
      await this.agentFactory.saveSession?.(sessionId, snapshot);
    } else {
      await this.agentFactory.deleteSession?.(sessionId);
    }
  }
}

function normalizeFlueEvent(event: FlueEvent, input: RunnerInput): NormalizedEvent | null {
  const base = {
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: input.messageId,
    createdAt: new Date(),
  };

  switch (event.type) {
    case 'text_delta':
      return {
        ...base,
        type: 'agent_text_delta',
        payload: { text: event.text, flueSessionId: event.sessionId },
      };
    case 'tool_start':
      return {
        ...base,
        type: 'tool_started',
        payload: {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
          flueSessionId: event.sessionId,
        },
      };
    case 'tool_end':
      return {
        ...base,
        type: 'tool_finished',
        payload: {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: event.result,
          flueSessionId: event.sessionId,
        },
      };
    case 'command_start':
      return {
        ...base,
        type: 'tool_started',
        payload: {
          toolName: 'command',
          command: event.command,
          args: event.args,
          flueSessionId: event.sessionId,
        },
      };
    case 'command_end':
      return {
        ...base,
        type: 'tool_finished',
        payload: {
          toolName: 'command',
          command: event.command,
          exitCode: event.exitCode,
          flueSessionId: event.sessionId,
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
          parentSessionId: event.parentSessionId,
          flueSessionId: event.sessionId,
        },
      };
    case 'task_end':
      return {
        ...base,
        type: 'tool_finished',
        payload: {
          toolName: 'task',
          taskId: event.taskId,
          isError: event.isError,
          result: event.result,
          parentSessionId: event.parentSessionId,
          flueSessionId: event.sessionId,
        },
      };
    case 'error':
      return {
        ...base,
        type: 'tool_finished',
        payload: { toolName: 'flue', isError: true, error: event.error, flueSessionId: event.sessionId },
      };
    case 'agent_start':
    case 'turn_end':
    case 'compaction_start':
    case 'compaction_end':
    case 'idle':
      return null;
  }
}
