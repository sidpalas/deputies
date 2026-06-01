import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type SessionEntry,
  type SessionHeader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { ArtifactService } from '../artifacts/service.js';
import type { NormalizedEvent } from '../events/types.js';
import type { ExternalResourceService } from '../external-resources/service.js';
import { prepareRepositoryShellSetup, type RepositoryAccessProvider } from '../repositories/setup.js';
import type { RepositoryShell, RepositoryToolServices, RepositoryToolState } from '../repositories/tool.js';
import type { Runner, RunnerInput, RunnerResult } from '../runner/types.js';
import type { SandboxKeepaliveService } from '../sandbox/service.js';
import type { SandboxHandle } from '../sandbox/types.js';
import { PI_SESSION_DATA_VERSION, type PiSessionData, type PiSessionStore } from './session-store.js';
import { createPiArtifactToolDefinition } from './artifact-tool.js';
import { createPiGitToolDefinition } from './git-tool.js';
import { createPiGitHubCliToolDefinition } from './github-cli-tool.js';
import { createPiRepositoryToolDefinition } from './repository-tool.js';
import { createSandboxPiToolDefinitions } from './sandbox-tools.js';
import { createPiServiceToolDefinition } from './service-tool.js';
import {
  createPiSubagentToolDefinition,
  piSubagentSystemPrompt,
  resolvePiSubagentProfile,
  type PiSubagentRunInput,
  type PiSubagentRunResult,
} from './subagent-tool.js';

const DEPUTIES_SYSTEM_PROMPT = [
  'You are a software engineering agent running in a sandbox for the Deputies product.',
  'When generating files for users, prefer broadly compatible formats that can be opened in modern browsers and common desktop tools.',
  'Before telling the user work is complete, verify important files exist and commands have succeeded.',
].join('\n');

// Pi's built-ins execute in the SDK process by default. Suppress them and register
// Deputies' same-name custom tools so filesystem and shell access goes through SandboxHandle.
const PI_NO_TOOLS: NonNullable<CreateAgentSessionOptions['noTools']> = 'builtin';
const PI_SUBAGENT_MAX_DEPTH = 4;

export type PiRunnerOptions = {
  model: string;
  authFile?: string;
  authBase64?: string;
  sessionStore?: PiSessionStore;
  repositoryAccess?: {
    github?: RepositoryAccessProvider;
  };
  artifacts?: ArtifactService;
  externalResources?: ExternalResourceService;
  artifactToolMaxBytes?: number;
  sandboxKeepalive?: SandboxKeepaliveService;
  sandboxKeepaliveMaxExtensionMs?: number;
  modelUnavailableReason?: (model: string | undefined) => string | undefined;
};

type PiSessionLease = {
  manager: SessionManager;
  cleanup: () => Promise<void>;
};

type PiToolSet = {
  customTools: ToolDefinition[];
};

type PiToolSetContext = {
  subagentDepth: number;
  runSubagent?: (input: PiSubagentRunInput) => Promise<PiSubagentRunResult>;
};

type PiModelSelection = {
  provider: string;
  modelId: string;
  thinkingLevel?: CreateAgentSessionOptions['thinkingLevel'];
};

export class PiRunner implements Runner {
  private readonly sessions = new Map<string, SessionManager>();
  private readonly authStorage: AuthStorage;
  private readonly agentDir: string;

  constructor(private readonly options: PiRunnerOptions) {
    this.authStorage = createAuthStorage(options);
    this.agentDir = options.authFile ? path.dirname(options.authFile) : getAgentDir();
  }

  async run(input: RunnerInput): Promise<RunnerResult> {
    const store = this.options.sessionStore;
    if (store?.withLock) return store.withLock(input.sessionId, () => this.runUnlocked(input));
    return this.runUnlocked(input);
  }

  private async runUnlocked(input: RunnerInput): Promise<RunnerResult> {
    const modelName = input.model ?? this.options.model;
    const unavailableReason = this.options.modelUnavailableReason?.(modelName);
    if (unavailableReason) throw new Error(unavailableReason);

    const repositorySetup = await preparePiRepositorySetup(input, this.options);
    const cwd = repositorySetup?.workspacePath ?? input.sandbox.workspacePath;
    const lease = await this.getSessionLease(input.sessionId, cwd);
    const modelRegistry = ModelRegistry.create(this.authStorage, path.join(this.agentDir, 'models.json'));
    const modelSelection = parseModelSelection(modelName);
    const model = modelRegistry.find(modelSelection.provider, modelSelection.modelId);
    if (!model) throw new Error(`Pi model is not available: ${modelName}`);

    const resourceLoader = createPiResourceLoader(cwd, this.agentDir, DEPUTIES_SYSTEM_PROMPT);
    await resourceLoader.reload();

    const repositoryState = createRepositoryState(input.context, repositorySetup);
    const runSubagent = (subagentInput: PiSubagentRunInput) =>
      runPiSubagent({
        input,
        options: this.options,
        authStorage: this.authStorage,
        agentDir: this.agentDir,
        modelRegistry,
        modelName,
        modelSelection,
        repositoryState,
        parentCwd: cwd,
        subagentDepth: 0,
        subagentInput,
      });
    const { customTools } = createPiToolSet(input, this.options, repositoryState, cwd, {
      subagentDepth: 0,
      runSubagent,
    });

    const pendingEvents: Array<Promise<void>> = [];
    let sawTextDelta = false;
    let responseText = '';
    let responseMetadata: Pick<RunnerResult, 'model' | 'usage'> = {};
    let session!: AgentSession;
    let completed = false;

    const emitEvent = (event: AgentSessionEvent) => {
      if (input.signal?.aborted) return;
      const normalized = normalizePiEvent(event, input);
      if (!normalized) return;
      if (normalized.type === 'agent_text_delta') {
        sawTextDelta = true;
        responseText += String(normalized.payload.text ?? '');
      }
      pendingEvents.push(input.emit(normalized));
    };

    const created = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry,
      model,
      ...(modelSelection.thinkingLevel ? { thinkingLevel: modelSelection.thinkingLevel } : {}),
      sessionManager: lease.manager,
      resourceLoader,
      noTools: PI_NO_TOOLS,
      customTools,
    });
    session = created.session;

    const unsubscribe = session.subscribe(emitEvent);
    const abortSession = () => {
      void session.abort();
    };
    input.signal?.addEventListener('abort', abortSession, { once: true });

    try {
      await input.emit({
        sessionId: input.sessionId,
        runId: input.runId,
        messageId: input.messageId,
        type: 'run_started',
        payload: { runner: 'pi' },
        createdAt: new Date(),
      });

      if (repositorySetup) {
        await input.emit({
          sessionId: input.sessionId,
          runId: input.runId,
          messageId: input.messageId,
          type: 'repository_ready',
          payload: {
            provider: repositorySetup.access.provider,
            owner: repositorySetup.access.owner,
            repo: repositorySetup.access.repo,
            ...(repositorySetup.branch ? { branch: repositorySetup.branch } : {}),
            workspacePath: repositorySetup.workspacePath,
            expiresAt: repositorySetup.access.expiresAt.toISOString(),
          },
          createdAt: new Date(),
        });
      }

      if (input.signal?.aborted) throw new Error('Operation aborted');
      await session.prompt(input.prompt, { expandPromptTemplates: false });
      await Promise.all(pendingEvents);
      if (input.signal?.aborted) throw new Error('Operation aborted');

      const assistantMessage = lastAssistantMessage(session.messages);
      if (assistantMessage?.stopReason === 'error') {
        throw new Error(assistantMessage.errorMessage ?? 'Pi agent failed');
      }
      if (!sawTextDelta) responseText = assistantMessageText(assistantMessage);
      responseMetadata = assistantMessageMetadata(assistantMessage);

      await input.emit({
        sessionId: input.sessionId,
        runId: input.runId,
        messageId: input.messageId,
        type: 'run_completed',
        payload: { runner: 'pi', ...responseMetadata },
        createdAt: new Date(),
      });

      completed = true;
      return { text: responseText, ...responseMetadata };
    } finally {
      input.signal?.removeEventListener('abort', abortSession);
      unsubscribe();
      session.dispose();
      await this.persistAndCleanup(input, lease, completed);
    }
  }

  private async getSessionLease(sessionId: string, cwd: string): Promise<PiSessionLease> {
    if (this.options.sessionStore) return this.createStoredSessionLease(sessionId, cwd);
    return { manager: this.getMemorySessionManager(sessionId, cwd), cleanup: async () => {} };
  }

  private getMemorySessionManager(sessionId: string, cwd: string): SessionManager {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const manager = SessionManager.inMemory(cwd);
    manager.newSession({ id: sessionId });
    this.sessions.set(sessionId, manager);
    return manager;
  }

  private async createStoredSessionLease(sessionId: string, cwd: string): Promise<PiSessionLease> {
    const store = this.options.sessionStore;
    if (!store) return { manager: createNewSessionManager(sessionId, cwd), cleanup: async () => {} };

    const stored = await store.load(sessionId);
    if (!stored) return { manager: createNewSessionManager(sessionId, cwd), cleanup: async () => {} };

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-pi-session-'));
    try {
      const sessionFile = path.join(tempDir, `${safeFileName(sessionId)}.jsonl`);
      await writeFile(sessionFile, serializePiSessionData(stored), 'utf8');
      return {
        manager: SessionManager.open(sessionFile, tempDir, cwd),
        cleanup: async () => {
          await rm(tempDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async persistAndCleanup(input: RunnerInput, lease: PiSessionLease, completed: boolean): Promise<void> {
    try {
      if (completed && (!input.shouldPersist || (await input.shouldPersist()))) {
        const store = this.options.sessionStore;
        if (store) await store.save(input.sessionId, sessionManagerData(lease.manager));
      }
    } finally {
      await lease.cleanup();
    }
  }
}

type PiRepositorySetup = Awaited<ReturnType<typeof preparePiRepositorySetup>>;

function createPiToolSet(
  input: RunnerInput,
  options: PiRunnerOptions,
  repositoryState: RepositoryToolState,
  cwd: string,
  context: PiToolSetContext,
): PiToolSet {
  const customTools = createSandboxPiToolDefinitions(input.sandbox, cwd);

  const repositoryServices = options.repositoryAccess?.github
    ? createPiRepositoryServices(input, options.repositoryAccess.github, repositoryState)
    : null;

  if (options.artifacts) {
    customTools.push(
      createPiArtifactToolDefinition({
        artifacts: options.artifacts,
        sandbox: input.sandbox,
        sessionId: input.sessionId,
        runId: input.runId,
        messageId: input.messageId,
        maxBytes: options.artifactToolMaxBytes ?? 25 * 1024 * 1024,
      }),
    );
  }

  if (repositoryServices) {
    customTools.push(
      createPiRepositoryToolDefinition(repositoryServices),
      createPiGitHubCliToolDefinition(repositoryServices, {
        ...(options.externalResources ? { externalResources: options.externalResources } : {}),
        sessionId: input.sessionId,
        runId: input.runId,
        messageId: input.messageId,
      }),
      createPiGitToolDefinition(repositoryServices),
    );
  }

  if (input.updateSessionContext) {
    customTools.push(
      createPiServiceToolDefinition({
        sessionId: input.sessionId,
        providerSandboxId: input.sandbox.providerSandboxId,
        sandboxMetadata: input.sandbox.metadata,
        updateSessionContext: input.updateSessionContext,
        getContext: () => repositoryState.context,
        setContext: (context) => {
          repositoryState.context = context;
        },
        ...(options.sandboxKeepalive ? { keepalive: options.sandboxKeepalive } : {}),
        ...(options.sandboxKeepaliveMaxExtensionMs
          ? { keepaliveMaxExtensionMs: options.sandboxKeepaliveMaxExtensionMs }
          : {}),
      }),
    );
  }

  if (context.subagentDepth < PI_SUBAGENT_MAX_DEPTH) {
    if (!context.runSubagent) throw new Error('Pi subagent runner is not configured');
    customTools.push(createPiSubagentToolDefinition({ run: context.runSubagent }));
  }

  return { customTools };
}

type RunPiSubagentInput = {
  input: RunnerInput;
  options: PiRunnerOptions;
  authStorage: AuthStorage;
  agentDir: string;
  modelRegistry: ModelRegistry;
  modelName: string;
  modelSelection: PiModelSelection;
  repositoryState: RepositoryToolState;
  parentCwd: string;
  subagentDepth: number;
  subagentInput: PiSubagentRunInput;
};

async function runPiSubagent(params: RunPiSubagentInput): Promise<PiSubagentRunResult> {
  if (params.subagentDepth >= PI_SUBAGENT_MAX_DEPTH) {
    throw new Error(`Maximum Pi subagent depth (${PI_SUBAGENT_MAX_DEPTH}) exceeded.`);
  }
  const childDepth = params.subagentDepth + 1;
  const profile = resolvePiSubagentProfile(params.subagentInput.agent);
  const cwd = resolveSubagentCwd(params.parentCwd, params.subagentInput.cwd);
  const model = params.modelRegistry.find(params.modelSelection.provider, params.modelSelection.modelId);
  if (!model) throw new Error(`Pi model is not available: ${params.modelName}`);

  const resourceLoader = createPiResourceLoader(
    cwd,
    params.agentDir,
    piSubagentSystemPrompt(DEPUTIES_SYSTEM_PROMPT, profile),
  );
  await resourceLoader.reload();

  const sessionManager = createNewSessionManager(`subagent-${randomUUID()}`, cwd);
  const runSubagent = (subagentInput: PiSubagentRunInput) =>
    runPiSubagent({
      ...params,
      parentCwd: cwd,
      subagentDepth: childDepth,
      subagentInput,
    });
  const { customTools } = createPiToolSet(params.input, params.options, params.repositoryState, cwd, {
    subagentDepth: childDepth,
    runSubagent,
  });
  const created = await createAgentSession({
    cwd,
    agentDir: params.agentDir,
    authStorage: params.authStorage,
    modelRegistry: params.modelRegistry,
    model,
    ...(params.modelSelection.thinkingLevel ? { thinkingLevel: params.modelSelection.thinkingLevel } : {}),
    sessionManager,
    resourceLoader,
    noTools: PI_NO_TOOLS,
    customTools,
  });
  const session = created.session;
  const abortSession = () => {
    void session.abort();
  };
  params.subagentInput.signal?.addEventListener('abort', abortSession, { once: true });

  try {
    if (params.subagentInput.signal?.aborted) throw new Error('Operation aborted');
    await session.prompt(params.subagentInput.task, { expandPromptTemplates: false });
    if (params.subagentInput.signal?.aborted) throw new Error('Operation aborted');
    const assistantMessage = lastAssistantMessage(session.messages);
    if (assistantMessage?.stopReason === 'error') {
      throw new Error(assistantMessage.errorMessage ?? 'Pi subagent failed');
    }
    return {
      agent: profile.name,
      task: params.subagentInput.task,
      cwd,
      depth: childDepth,
      text: assistantMessageText(assistantMessage),
      ...assistantMessageMetadata(assistantMessage),
    };
  } finally {
    params.subagentInput.signal?.removeEventListener('abort', abortSession);
    session.dispose();
  }
}

function createPiResourceLoader(cwd: string, agentDir: string, systemPrompt: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
}

function resolveSubagentCwd(parentCwd: string, cwd: string | undefined): string {
  if (!cwd) return parentCwd;
  return path.posix.isAbsolute(cwd) ? cwd : path.posix.resolve(parentCwd, cwd);
}

function createRepositoryState(context: Record<string, unknown>, setup: PiRepositorySetup): RepositoryToolState {
  const state: RepositoryToolState = { context: structuredClone(context) };
  if (setup) {
    state.prepared = {
      repository: { provider: 'github', owner: setup.access.owner, repo: setup.access.repo },
      access: setup.access,
      workspacePath: setup.workspacePath,
    };
  }
  return state;
}

function createPiRepositoryServices(
  input: RunnerInput,
  github: RepositoryAccessProvider,
  state: RepositoryToolState,
): RepositoryToolServices {
  return {
    github,
    sandbox: input.sandbox,
    shell: () => sandboxRepositoryShell(input.sandbox),
    state,
    emit: input.emit,
    eventBase: { sessionId: input.sessionId, runId: input.runId, messageId: input.messageId },
    ...(input.updateSessionContext ? { updateSessionContext: input.updateSessionContext } : {}),
  };
}

function sandboxRepositoryShell(sandbox: SandboxHandle): RepositoryShell {
  return async (command, options = {}) => {
    const result = await sandbox.exec({
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
}

async function preparePiRepositorySetup(input: RunnerInput, options: PiRunnerOptions) {
  const repositorySetupInput: Parameters<typeof prepareRepositoryShellSetup>[0] = {
    context: input.context,
    sandbox: input.sandbox,
  };
  if (options.repositoryAccess?.github) repositorySetupInput.github = options.repositoryAccess.github;
  const setup = await prepareRepositoryShellSetup(repositorySetupInput);
  if (!setup) return null;
  const result = await input.sandbox.exec({
    command: setup.command,
    cwd: input.sandbox.workspacePath,
    env: setup.env,
    timeoutMs: 120_000,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (input.signal?.aborted) throw new Error('Operation aborted');
  if (result.exitCode !== 0) {
    throw new Error(`Repository setup failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
  return setup;
}

function createNewSessionManager(sessionId: string, cwd: string): SessionManager {
  const manager = SessionManager.inMemory(cwd);
  manager.newSession({ id: sessionId });
  return manager;
}

function sessionManagerData(manager: SessionManager): PiSessionData {
  const header = manager.getHeader();
  if (!header) throw new Error('Pi session manager has no session header');
  return { version: PI_SESSION_DATA_VERSION, header, entries: manager.getEntries() };
}

function serializePiSessionData(data: { header: SessionHeader; entries: SessionEntry[] }): string {
  return `${[data.header, ...data.entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || 'session';
}

function createAuthStorage(options: Pick<PiRunnerOptions, 'authFile' | 'authBase64'>): AuthStorage {
  if (options.authFile) return AuthStorage.create(options.authFile);
  if (options.authBase64) {
    const parsed = JSON.parse(Buffer.from(options.authBase64, 'base64').toString('utf8')) as Parameters<
      typeof AuthStorage.inMemory
    >[0];
    return AuthStorage.inMemory(parsed);
  }
  return AuthStorage.create();
}

function parseModelSelection(model: string): PiModelSelection {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`Pi model must use provider/model format, received: ${model}`);
  }

  const provider = model.slice(0, slash);
  const modelAndThinking = model.slice(slash + 1);
  const colon = modelAndThinking.lastIndexOf(':');
  if (colon <= 0) return { provider, modelId: modelAndThinking };

  return {
    provider,
    modelId: modelAndThinking.slice(0, colon),
    thinkingLevel: modelAndThinking.slice(colon + 1) as PiModelSelection['thinkingLevel'],
  };
}

function normalizePiEvent(event: AgentSessionEvent, input: RunnerInput): NormalizedEvent | null {
  const base = {
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: input.messageId,
    createdAt: new Date(),
  };

  switch (event.type) {
    case 'message_update':
      if (event.assistantMessageEvent.type !== 'text_delta') return null;
      return {
        ...base,
        type: 'agent_text_delta',
        payload: { text: event.assistantMessageEvent.delta },
      };
    case 'tool_execution_start':
      return {
        ...base,
        type: 'tool_started',
        payload: { toolName: event.toolName, toolCallId: event.toolCallId, args: event.args },
      };
    case 'tool_execution_end':
      return {
        ...base,
        type: 'tool_finished',
        payload: {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: event.result,
        },
      };
    default:
      return null;
  }
}

function lastAssistantMessage(messages: AgentSession['messages']): AssistantMessageLike | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as AssistantMessageLike | undefined;
    if (message?.role === 'assistant') return message;
  }
  return undefined;
}

type AssistantMessageLike = {
  role: 'assistant';
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
  responseModel?: string;
  usage?: RunnerResult['usage'];
  stopReason?: string;
  errorMessage?: string;
};

function assistantMessageText(message: AssistantMessageLike | undefined): string {
  return (
    message?.content
      ?.filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('') ?? ''
  );
}

function assistantMessageMetadata(message: AssistantMessageLike | undefined): Pick<RunnerResult, 'model' | 'usage'> {
  const metadata: Pick<RunnerResult, 'model' | 'usage'> = {};
  const model = message?.responseModel ?? message?.model;
  if (model) metadata.model = model;
  if (message?.usage) metadata.usage = message.usage;
  return metadata;
}
