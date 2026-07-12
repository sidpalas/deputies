import {
  connectMcpServer as connectFlueMcpServer,
  type FlueEvent,
  type McpServerConnection as FlueMcpServerConnection,
  type McpServerOptions as FlueMcpServerOptions,
  type ToolDefinition,
} from '@flue/runtime';
import type { NormalizedEvent } from '../events/types.js';
import type { ArtifactService } from '../artifacts/service.js';
import type { EnvironmentService } from '../environments/service.js';
import { validateEnvironmentContext } from '../environments/tool.js';
import type { ExternalResourceService } from '../external-resources/service.js';
import type { SandboxKeepaliveService } from '../sandbox/service.js';
import { startSandboxService } from '../sandbox/service-process.js';
import { type RepositoryAccessProvider } from '../repositories/setup.js';
import {
  executeRepositoryPreparations,
  planActiveFirstRepositoryPreparations,
  preparedRepositoryFromPlan,
  type RepositoryPreparationPlan,
  type RepositoryPreparationResult,
} from '../repositories/prepare.js';
import { sandboxRepositoryShell, type RepositoryShell } from '../repositories/shell.js';
import type { Runner, RunnerInput, RunnerResult } from '../runner/types.js';
import { createArtifactTool } from './artifact-tool.js';
import { createGitTool, type AgentRef } from './git-tool.js';
import { createGitHubCliTool } from './github-cli-tool.js';
import { createDeputyTool } from './deputy-tool.js';
import { createServiceTool } from './service-tool.js';
import {
  createRepositoryTool,
  toSharedRepositoryToolServices,
  type RepositoryToolServices,
  type RepositoryToolState,
} from './repository-tool.js';
import { createEnvironmentTool } from './environment-tool.js';
import type { FlueAgentFactory, FluePromptResponse, FlueSessionPort } from './types.js';
import { createWebSearchTool, type WebSearchToolServices } from './web-search-tool.js';
import type { DeputyToolBaseServices } from '../sessions/deputy-tool.js';
import { createMcpResponseLimitedFetch, createMcpToolName, createStreamableHttpMcpFetch } from '../mcp/client.js';
import { closeMcpConnections, logMcpUnavailable, mcpUnavailableNote } from '../mcp/runner.js';
import type { McpRuntimeOptions } from '../mcp/types.js';

export type FlueRunnerOptions = {
  repositoryAccess?: {
    github?: RepositoryAccessProvider;
  };
  environments?: EnvironmentService;
  artifacts?: ArtifactService;
  externalResources?: ExternalResourceService;
  artifactToolMaxBytes?: number;
  sandboxKeepalive?: SandboxKeepaliveService;
  sandboxKeepaliveMaxExtensionMs?: number;
  setupScript?: { enabled: boolean; timeoutMs: number };
  webSearch?: WebSearchToolServices;
  mcp?: McpRuntimeOptions & { connect?: typeof connectFlueMcpServer };
  deputy?: DeputyToolBaseServices;
  modelUnavailableReason?: (model: string | undefined) => string | undefined;
};

type FlueMcpSetup = {
  connections: FlueMcpServerConnection[];
  tools: ToolDefinition[];
  note: string | null;
};

export class FlueRunner implements Runner {
  constructor(
    private readonly agentFactory: FlueAgentFactory,
    private readonly options: FlueRunnerOptions = {},
  ) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    const unavailableReason = this.options.modelUnavailableReason?.(input.model);
    if (unavailableReason) throw new Error(unavailableReason);
    const environmentWarning = await validateEnvironmentContext(
      this.options.environments,
      input.ownerGroupId,
      input.context,
    );

    const pendingEvents: Array<Promise<void>> = [];
    let sawTextDelta = false;
    const repositorySetupInput: Parameters<typeof planActiveFirstRepositoryPreparations>[0] = {
      context: input.context,
      sandbox: input.sandbox,
    };
    if (this.options.repositoryAccess?.github) repositorySetupInput.github = this.options.repositoryAccess.github;
    const mcpSetupPromise = connectFlueMcpServers(this.options.mcp, input.signal);
    let setup: {
      repositorySetups: Awaited<ReturnType<typeof planActiveFirstRepositoryPreparations>>;
      mcpSetup: FlueMcpSetup;
    };
    try {
      const [repositorySetups, mcpSetup] = await Promise.all([
        planActiveFirstRepositoryPreparations(repositorySetupInput),
        mcpSetupPromise,
      ]);
      setup = { repositorySetups, mcpSetup };
    } catch (error) {
      const connected = await mcpSetupPromise.catch(() => null);
      if (connected) await closeMcpConnections(connected.connections);
      throw error;
    }
    const { repositorySetups, mcpSetup } = setup;
    const activeRepositorySetup = repositorySetups[0] ?? null;
    const agentRef: AgentRef = {};
    const repositoryState: RepositoryToolState = { context: structuredClone(input.context) };
    if (repositorySetups.length) {
      repositoryState.preparedRepositories = repositorySetups.map(preparedRepositoryFromPlan);
      repositoryState.prepared = repositoryState.preparedRepositories[0]!;
    }
    const repositoryServices = this.options.repositoryAccess?.github
      ? ({
          github: this.options.repositoryAccess.github,
          sandbox: input.sandbox,
          agentRef,
          state: repositoryState,
          emit: input.emit,
          eventBase: { sessionId: input.sessionId, runId: input.runId, messageId: input.messageId },
          ...(this.options.setupScript ? { setupScript: this.options.setupScript } : {}),
          ...(input.updateSessionContext ? { updateSessionContext: input.updateSessionContext } : {}),
        } satisfies RepositoryToolServices)
      : null;
    const tools = [];
    const deputyRunState = { spawns: 0 };
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
        ...(this.options.environments && input.ownerGroupId
          ? [
              createEnvironmentTool({
                environments: this.options.environments,
                ownerGroupId: input.ownerGroupId,
                repository: toSharedRepositoryToolServices(repositoryServices),
              }),
            ]
          : []),
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
        createServiceTool({
          sessionId: input.sessionId,
          providerSandboxId: input.sandbox.providerSandboxId,
          sandboxMetadata: input.sandbox.metadata,
          launchService: (service) => startSandboxService(input.sandbox, service),
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
    if (this.options.webSearch) tools.push(createWebSearchTool(this.options.webSearch));
    if (mcpSetup.tools.length) tools.push(...mcpSetup.tools);
    if (this.options.deputy) {
      tools.push(
        createDeputyTool({
          ...this.options.deputy,
          sessionId: input.sessionId,
          runId: input.runId,
          messageId: input.messageId,
          runState: deputyRunState,
          ...(input.shouldPersist ? { shouldPersist: input.shouldPersist } : {}),
        }),
      );
    }

    let abortSession: (() => void) | undefined;
    try {
      const agent = await this.agentFactory.create({
        agentId: input.sessionId,
        sessionId: input.sessionId,
        sandbox: input.sandbox,
        cwd: activeRepositorySetup?.workspacePath ?? input.sandbox.workspacePath,
        ...(input.model ? { model: input.model } : {}),
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
      abortSession = () => session.abort?.();
      input.signal?.addEventListener('abort', abortSession, { once: true });

      await input.emit({
        sessionId: input.sessionId,
        runId: input.runId,
        messageId: input.messageId,
        type: 'run_started',
        payload: { runner: 'flue' },
        createdAt: new Date(),
      });

      const setupResults = repositorySetups.length
        ? await this.runRepositorySetup(input, repositorySetups, session)
        : [];
      repositoryState.preparedRepositories = setupResults;
      if (setupResults[0]) repositoryState.prepared = setupResults[0];
      const setupNote = combineSetupNotes(
        environmentWarning,
        mcpSetup.note,
        ...setupResults.map((result) => result.setupFailureNote),
      );

      // Cancellation must not leave partial Flue turn state in durable history.
      // A prompt-only warning is cheaper but advisory, and models can still continue
      // cancelled work from persisted context.
      const sessionSnapshot = await this.loadSessionSnapshot(input.sessionId);
      let restoreOnAbort = true;
      let response;
      try {
        if (input.signal?.aborted) throw new Error('Operation aborted');
        response = await session.prompt(
          withToolGuidance(
            input.prompt,
            Boolean(this.options.artifacts),
            Boolean(repositoryServices),
            Boolean(this.options.environments && input.ownerGroupId && repositoryServices),
            Boolean(this.options.webSearch),
            Boolean(this.options.deputy),
            setupNote,
          ),
          input.signal ? { signal: input.signal } : undefined,
        );
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
        const responseMetadata = promptResponseMetadata(response);
        await input.emit({
          sessionId: input.sessionId,
          runId: input.runId,
          messageId: input.messageId,
          type: 'run_completed',
          payload: { runner: 'flue', ...responseMetadata },
          createdAt: new Date(),
        });

        restoreOnAbort = false;
        return { text: response.text, ...responseMetadata };
      } finally {
        if (restoreOnAbort && input.signal?.aborted)
          await this.restoreSessionSnapshot(input.sessionId, sessionSnapshot);
      }
    } finally {
      if (abortSession) input.signal?.removeEventListener('abort', abortSession);
      await closeMcpConnections(mcpSetup.connections);
    }
  }

  private async runRepositorySetup(
    input: RunnerInput,
    setups: RepositoryPreparationPlan[],
    session: FlueSessionPort,
  ): Promise<RepositoryPreparationResult[]> {
    return executeRepositoryPreparations({
      plans: setups,
      workspaceRoot: input.sandbox.workspacePath,
      shell: flueSessionShell(session),
      setupShell: sandboxRepositoryShell(input.sandbox),
      emit: input.emit,
      eventBase: { sessionId: input.sessionId, runId: input.runId, messageId: input.messageId },
      ...(this.options.setupScript ? { setupScript: this.options.setupScript } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
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

function flueSessionShell(session: FlueSessionPort): RepositoryShell {
  if (!session.shell) throw new Error('Flue session does not support shell commands for repository setup');
  return (command, options = {}) =>
    session.shell!(command, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
}

function promptResponseMetadata(response: FluePromptResponse) {
  const metadata: Pick<RunnerResult, 'model' | 'usage'> = {};
  if (response.model) metadata.model = typeof response.model === 'string' ? response.model : response.model.id;
  if (response.usage) metadata.usage = response.usage;
  return metadata;
}

async function connectFlueMcpServers(
  mcp: FlueRunnerOptions['mcp'],
  signal: AbortSignal | undefined,
): Promise<FlueMcpSetup> {
  if (!mcp?.servers.length) return { connections: [], tools: [], note: null };
  const connect = mcp.connect ?? connectFlueMcpServer;
  const results = await Promise.all(
    mcp.servers.map(async (server) => {
      try {
        const options: FlueMcpServerOptions = { url: server.url, transport: server.transport };
        if (server.headers) options.headers = server.headers;
        options.fetch =
          server.transport === 'streamable-http'
            ? createStreamableHttpMcpFetch(undefined, { responseMaxBytes: mcp.responseMaxBytes })
            : createMcpResponseLimitedFetch(undefined, { responseMaxBytes: mcp.responseMaxBytes });
        const connection = await withMcpConnectBudget(connect(server.name, options), mcp.connectTimeoutMs, signal);
        const allowedTools = server.allowedTools?.length
          ? new Set(server.allowedTools.map((tool) => createMcpToolName(server.name, tool)))
          : null;
        const tools = allowedTools ? connection.tools.filter((tool) => allowedTools.has(tool.name)) : connection.tools;
        return { serverName: server.name, connection, tools };
      } catch (error) {
        logMcpUnavailable(server.name, error);
        return { serverName: server.name, error };
      }
    }),
  );
  const connections = results.flatMap((result) => ('connection' in result ? [result.connection] : []));
  const tools = results.flatMap((result) => ('tools' in result ? result.tools : []));
  const note = results
    .filter((result) => !('connection' in result))
    .map((result) => mcpUnavailableNote(result.serverName))
    .join('\n');
  return { connections, tools, note: note || null };
}

async function withMcpConnectBudget<T extends { close(): Promise<void> }>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const budgetSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let completedInBudget = false;
  const budget = new Promise<never>((_, reject) => {
    if (budgetSignal.aborted) {
      reject(new Error('MCP connection budget exceeded'));
      return;
    }
    budgetSignal.addEventListener('abort', () => reject(new Error('MCP connection budget exceeded')), { once: true });
  });

  try {
    const connection = await Promise.race([promise, budget]);
    completedInBudget = true;
    return connection;
  } finally {
    if (!completedInBudget)
      void promise.then(
        (connection) => connection.close().catch(() => undefined),
        () => undefined,
      );
  }
}

function combineSetupNotes(...notes: Array<string | null>): string | null {
  const present = notes.filter((note): note is string => Boolean(note));
  return present.length ? present.join('\n\n') : null;
}

function withToolGuidance(
  prompt: string,
  includeArtifacts: boolean,
  includeRepository: boolean,
  includeEnvironment: boolean,
  includeWebSearch: boolean,
  includeDeputy: boolean,
  setupNote: string | null = null,
): string {
  const lines = [
    'Service tool guidance:',
    '- To start a persistent web server, app preview, code-server instance, API docs, notebook, dashboard, or other HTTP service, prefer service({ action: "launch", command, port, label, path, ttlSeconds }). Deputies will launch and publish it with provider-managed process semantics. Use action=publish only for services that are already managed and confirmed running. Use ttlSeconds of at least 300 for interactive services.',
    '- Use service({ action: "extend", port, ttlSeconds }) to keep an existing service sandbox alive longer, service({ action: "list" }) to inspect published services, and service({ action: "unpublish", port }) to remove stale links.',
    '- Do not publish ports that are not serving an app, browser-accessible tool, or useful HTTP endpoint.',
    '- For Vite dev servers published as services/previews, do not hard-code server.hmr.host, server.hmr.clientPort, or server.hmr.protocol to localhost; let Vite infer the browser URL unless the user specifically asks otherwise.',
    '',
  ];
  if (includeArtifacts) {
    lines.push(
      'Artifact tool guidance:',
      '- Use artifact({ action: "create", ... }) for files the user should view or download, including screenshots, images, reports, logs, and videos.',
      '- If you mention a created artifact in your final response, use the markdownLink returned by the artifact tool as-is, or use its downloadUrl as the markdown href. Do not wrap artifact download URLs in the session URL.',
      '- After user-visible UI changes, use Playwright when available to screenshot changed screens and read each PNG before claiming success; record short multi-step flows when practical.',
      '- Prefer MP4 (H.264/yuv420p) for artifact type=video; WebM is accepted. Publish AVI, MOV, MKV, and other video formats as type=file.',
      '',
    );
  }
  if (includeRepository) {
    lines.push(
      'Repository tool guidance:',
      '- When the environment tool is available, a direct repository is already active, and no environment is selected, prefer environment({ action: "auto" }) before repository-specific work.',
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
  if (includeEnvironment) {
    lines.push(
      'Environment tool guidance:',
      '- Before repository-specific work without an environment, use environment({ action: "auto" }) when direct repository context is available.',
      '- Auto selects only one unambiguous accessible environment. If multiple environments match, use environment({ action: "list" }) and ask the user to choose.',
      '- Selecting an environment prepares its primary repository. Use repository({ action: "set" }) only to move the active repository within that environment.',
      '',
    );
  }
  if (includeWebSearch) {
    lines.push(
      'Web search tool guidance:',
      '- Use web_search({ action: "search", query }) for current documentation, facts, APIs, package versions, and other public web lookups.',
      '- Use web_search({ action: "fetch", url }) to read a specific public page found in search results or provided by the user.',
      '- Prefer authoritative sources and include source URLs in your reasoning or final answer when web results affect the answer.',
      '',
    );
  }
  if (includeDeputy) {
    lines.push(
      'Deputies tool guidance:',
      '- Use deputies({ action: "spawn", prompt, title, repository, model, idempotencyKey, notifyOnComplete }) only when work should become a separate durable Deputies product session visible to the user.',
      '- For quick in-run delegation, use Flue task/session.task instead of spawning a Deputies session.',
      '- Do not busy-wait after spawning. Use deputies({ action: "get_session", sessionId }) for explicit polling, end the turn when appropriate, or set notifyOnComplete=true so the child enqueues a parent follow-up when it completes.',
      '- deputies send_message and cancel are intentionally limited to direct child sessions spawned by this session.',
      '- Child sessions inherit this session group, visibility, and write policy. Parent run cancellation and parent archival do not cancel or archive children; explicitly use deputies({ action: "cancel", sessionId }) for direct children you no longer need.',
      '',
    );
  }
  if (setupNote) lines.push(`${setupNote}\n`);
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
          agent: event.agent,
          role: event.agent,
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
          agent: event.agent,
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
    case 'run_resume':
    case 'agent_start':
    case 'agent_end':
    case 'turn_start':
    case 'turn_request':
    case 'turn_end':
    case 'message_start':
    case 'message_update':
    case 'message_end':
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
