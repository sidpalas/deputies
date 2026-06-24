import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { AppLifecycle, installProcessShutdownHandlers, type CloseableResource } from './app/lifecycle.js';
import { configuredModels } from './app/model-availability.js';
import { createServer, createServices, createWorkerHealthServer } from './app/server.js';
import { createArtifactObjectStorage } from './artifacts/storage.js';
import { HttpCompletionCallbackSender, type CompletionCallbackSender } from './callbacks/service.js';
import {
  loadConfig,
  requireAgentSandboxOrchestratorToken,
  requireAgentSandboxOrchestratorUrl,
  requireCreateosApiKey,
  requireDatabaseUrl,
  requireDaytonaApiKey,
  requireDockerOrchestratorUrl,
  requireGitHubAppCredentials,
  requireRunnerModelDefault,
  requireTensorlakeApiKey,
  requireTensorlakeRegisteredImage,
} from './config/index.js';
import { startEventCompactor } from './events/compaction.js';
import { GitHubArchivedSessionNotifier } from './integrations/github/archived-session-notifier.js';
import { GitHubCompletionCallbackSender } from './integrations/github/callback-sender.js';
import { GitHubClient } from './integrations/github/client.js';
import { GitHubIssueContextFetcher } from './integrations/github/issue-context-fetcher.js';
import { GitHubReactionSender } from './integrations/github/reaction-sender.js';
import { GitHubRepositoryAccessService } from './integrations/github/repository-access.js';
import { SlackClient } from './integrations/slack/client.js';
import { SlackCompletionCallbackSender } from './integrations/slack/callback-sender.js';
import { SlackRunProgressNotifier } from './integrations/slack/progress-notifier.js';
import { FakeRunner } from './runner/fake.js';
import type { Runner } from './runner/types.js';
import { RealFlueAgentFactory, type RealFlueAgentFactoryOptions } from './runner-flue/agent-factory.js';
import { loadOpenAICodexApiKey } from './runner-flue/openai-codex-auth.js';
import { FlueRunner } from './runner-flue/runner.js';
import { PostgresFlueSessionStore } from './runner-flue/session-store.js';
import { PiRunner, type PiRunnerOptions } from './runner-pi/runner.js';
import { PostgresPiSessionStore } from './runner-pi/session-store.js';
import { sandboxBridgeSkippedCookieNames } from './sandbox/bridge-env.js';
import { CreateosSandboxProvider, type CreateosSandboxProviderOptions } from './sandbox/createos.js';
import { DaytonaSandboxProvider } from './sandbox/daytona.js';
import { DockerSandboxProvider, HttpDockerOrchestratorClient, InProcessDockerOrchestrator } from './sandbox/docker.js';
import { FakeSandboxProvider } from './sandbox/fake.js';
import {
  AgentSandboxProvider,
  HttpAgentSandboxOrchestratorClient,
  InProcessAgentSandboxOrchestrator,
} from './sandbox/k8s-agent-sandbox.js';
import { LocalSandboxProvider } from './sandbox/local.js';
import { startSandboxReaper } from './sandbox/reaper.js';
import { TensorlakeSandboxProvider } from './sandbox/tensorlake.js';
import type { SandboxProvider } from './sandbox/types.js';
import { MemoryStore } from './store/memory.js';
import { PostgresStore } from './store/postgres.js';
import { startTelemetry } from './telemetry/index.js';
import { instrumentStore } from './telemetry/store.js';
import type { WebSearchToolServices } from './web-search/tool.js';
import { startWorkerLoop, WorkerService, type WorkerLoopHandle } from './worker/service.js';

const config = loadConfig(process.env);
const telemetry = startTelemetry({ runMode: config.runMode });
const databaseUrl = config.appDataStore === 'postgres' ? requireDatabaseUrl(config) : '';
const baseStore =
  config.appDataStore === 'postgres' ? new PostgresStore(databaseUrl, postgresStoreOptions()) : new MemoryStore();
const store = instrumentStore(baseStore, { kind: config.appDataStore });
const sandboxProvider = createSandboxProvider();
const artifactObjectStorage = config.artifactStorage === 'disabled' ? undefined : createArtifactObjectStorage(config);
const services = createServices(store, {
  sandboxProvider,
  unsafeAllowLocalHttpCallbacks: config.unsafeAllowLocalHttpCallbacks,
  ...(artifactObjectStorage ? { artifactObjectStorage } : {}),
});
const webSearch = createWebSearchServices();
const githubClient =
  config.githubAppId || config.githubAppPrivateKey ? new GitHubClient({ apiBaseUrl: config.githubApiBaseUrl }) : null;
const githubRepositoryAccess = githubClient ? createGitHubRepositoryAccess(githubClient) : null;
if (githubClient && githubRepositoryAccess) {
  services.githubReactionSender = new GitHubReactionSender(githubClient, githubRepositoryAccess);
  services.githubIssueContextFetcher = new GitHubIssueContextFetcher(githubClient, githubRepositoryAccess);
  services.githubArchivedSessionNotifier = new GitHubArchivedSessionNotifier(githubClient, githubRepositoryAccess);
  services.githubRepositoryAccess = githubRepositoryAccess;
}
const resources: CloseableResource[] = [];
let server: ReturnType<typeof createServer> | undefined;
let workerLoop: WorkerLoopHandle | undefined;
let eventCompactor: ReturnType<typeof startEventCompactor> | undefined;
let sandboxReaper: ReturnType<typeof startSandboxReaper> | undefined;
const processInstanceId = `${hostname()}-${process.pid}-${randomUUID()}`;
const automationSchedulerLockOwner = `automation-scheduler-${processInstanceId}`;

if (telemetry) resources.push(telemetry);
if ('close' in baseStore && typeof baseStore.close === 'function') resources.push(baseStore);
if (
  baseStore instanceof PostgresStore &&
  (config.runMode === 'combined' || config.runMode === 'all' || config.runMode === 'api' || config.runMode === 'worker')
) {
  resources.unshift(await baseStore.listenEvents((event) => services.events.publishExternal(event)));
}

if (config.runMode === 'combined' || config.runMode === 'all' || config.runMode === 'api') {
  server = createServer(config, services);
  server.listen(config.port, () => {
    console.log(`background-agent service listening on :${config.port} (${config.runMode})`);
  });
} else {
  server = createWorkerHealthServer(config);
  server.listen(config.port, () => {
    console.log(`background-agent worker health listening on :${config.port} (${config.runMode})`);
  });
}

if (config.runMode === 'combined' || config.runMode === 'all' || config.runMode === 'worker') {
  const runner = await createRunner();
  const callbackSenders = createCallbackSenders();
  const progressNotifiers = createProgressNotifiers();
  const automationSchedulerLoop = startWorkerLoop(
    {
      processNext: () => services.automations.processNextScheduled({ lockOwner: automationSchedulerLockOwner }),
    },
    config.workerPollIntervalMs,
  );
  const workerLoops = Array.from({ length: config.workerConcurrency }, (_, index) => {
    const worker = new WorkerService({
      store,
      events: services.events,
      artifacts: services.artifacts,
      runner,
      runnerType: config.runner,
      sandboxProvider,
      leaseOwner: `worker-${processInstanceId}-${index + 1}`,
      cancellationPollIntervalMs: config.runCancellationPollIntervalMs,
      callbackSenders,
      progressNotifiers,
    });
    return startWorkerLoop(worker, config.workerPollIntervalMs);
  });
  workerLoop = {
    wake(): void {
      automationSchedulerLoop.wake();
      for (const loop of workerLoops) loop.wake();
    },
    async stop(): Promise<void> {
      await Promise.all([automationSchedulerLoop.stop(), ...workerLoops.map((loop) => loop.stop())]);
    },
  };
  const unsubscribeWorkerWake = services.events.subscribeAllEvents((event) => {
    if (event.type === 'message_created' || event.type === 'callback_retry_scheduled') workerLoop?.wake();
  });
  resources.unshift({ close: unsubscribeWorkerWake });
  if (config.eventDeltaCompactionEnabled) {
    eventCompactor = startEventCompactor({
      store,
      retentionMs: config.eventDeltaCompactionRetentionMs,
      intervalMs: config.eventDeltaCompactionIntervalMs,
      batchSize: config.eventDeltaCompactionBatchSize,
      onError: (error: unknown) => console.error(error instanceof Error ? error.message : error),
    });
  }
  if (services.sandboxCleanup) {
    sandboxReaper = startSandboxReaper({
      cleanup: services.sandboxCleanup,
      store,
      stopDelayMs: config.sandboxStopDelayMs,
      retentionMs: config.sandboxRetentionMs,
      onError: (error: unknown) => console.error(error instanceof Error ? error.message : error),
    });
  }
  console.log(`background-agent worker started (${config.runMode}, concurrency=${config.workerConcurrency})`);
}

function createCallbackSenders(): CompletionCallbackSender[] {
  const senders: CompletionCallbackSender[] = [
    new HttpCompletionCallbackSender({ unsafeAllowLocalNetwork: config.unsafeAllowLocalHttpCallbacks }),
  ];
  if (config.slackBotToken) {
    senders.push(
      new SlackCompletionCallbackSender(
        new SlackClient({ apiBaseUrl: config.slackApiBaseUrl, botToken: config.slackBotToken }),
      ),
    );
  }
  if (config.githubAppId || config.githubAppPrivateKey) {
    if (!githubClient || !githubRepositoryAccess)
      throw new Error('GitHub callback sender requires GitHub App credentials');
    senders.push(new GitHubCompletionCallbackSender(githubClient, githubRepositoryAccess));
  }
  return senders;
}

function createProgressNotifiers() {
  if (!config.slackBotToken) return [];
  return [
    new SlackRunProgressNotifier(
      new SlackClient({ apiBaseUrl: config.slackApiBaseUrl, botToken: config.slackBotToken }),
    ),
  ];
}

function createRepositoryAccess() {
  if (!config.githubAppId && !config.githubAppPrivateKey) return {};
  if (!githubRepositoryAccess) throw new Error('GitHub repository access requires GitHub App credentials');
  return { github: githubRepositoryAccess };
}

function createGitHubRepositoryAccess(client: GitHubClient): GitHubRepositoryAccessService {
  const credentials = requireGitHubAppCredentials(config);
  return new GitHubRepositoryAccessService({
    ...credentials,
    client,
    cloneBaseUrl: config.githubCloneBaseUrl,
    allowedRepositories: config.githubAllowedRepositories,
  });
}

const lifecycleOptions = {
  resources,
  onError: (error: unknown) => console.error(error instanceof Error ? error.message : error),
};
if (server) Object.assign(lifecycleOptions, { server });
if (workerLoop) Object.assign(lifecycleOptions, { workerLoop });
if (eventCompactor) resources.unshift(eventCompactor);
if (sandboxReaper) resources.unshift(sandboxReaper);
installProcessShutdownHandlers(new AppLifecycle(lifecycleOptions));

function createSandboxProvider(): SandboxProvider {
  if (config.sandboxProvider === 'fake') return new FakeSandboxProvider();
  if (config.sandboxProvider === 'unsafe-local') {
    console.warn(
      'WARNING: SANDBOX_PROVIDER=unsafe-local is not a security boundary. Agent commands run on the API/worker host runtime; use only for trusted local development.',
    );
    return new LocalSandboxProvider(
      config.localSandboxAllowedCommands.length ? { allowedCommands: config.localSandboxAllowedCommands } : {},
    );
  }
  if (config.sandboxProvider === 'docker') {
    const orchestrator =
      config.dockerOrchestratorMode === 'http'
        ? new HttpDockerOrchestratorClient(
            optional({ baseUrl: requireDockerOrchestratorUrl(config), token: config.dockerOrchestratorToken }),
          )
        : new InProcessDockerOrchestrator(
            optional({
              image: config.dockerSandboxImage,
              workspacePath: config.sandboxWorkspacePath,
              bridgeHost: config.dockerSandboxBridgeHost,
              network: config.dockerSandboxNetwork,
              memory: config.dockerSandboxMemory,
              cpus: config.dockerSandboxCpus,
              dockerCliTimeoutMs: config.dockerCliTimeoutMs,
              bridgeSkippedCookieNames: sandboxBridgeSkippedCookieNames(config),
            }),
          );
    return new DockerSandboxProvider({ orchestrator });
  }
  if (config.sandboxProvider === 'daytona') {
    const resources = daytonaSandboxResources();
    const options = {
      apiKey: requireDaytonaApiKey(config),
      idleTimeoutMs: config.sandboxIdleTimeoutMs,
    };
    if (config.daytonaApiUrl) Object.assign(options, { apiUrl: config.daytonaApiUrl });
    if (config.daytonaTarget) Object.assign(options, { target: config.daytonaTarget });
    if (config.daytonaImage) Object.assign(options, { image: config.daytonaImage });
    if (config.daytonaSnapshot) Object.assign(options, { snapshot: config.daytonaSnapshot });
    if (resources) Object.assign(options, { resources });
    Object.assign(options, {
      workspacePath: config.sandboxWorkspacePath,
      bridgeSkippedCookieNames: sandboxBridgeSkippedCookieNames(config),
    });
    return new DaytonaSandboxProvider(options);
  }
  if (config.sandboxProvider === 'tensorlake') {
    const options = {
      apiKey: requireTensorlakeApiKey(config),
      image: requireTensorlakeRegisteredImage(config),
      idleTimeoutMs: Math.max(config.sandboxIdleTimeoutMs, config.sandboxKeepaliveMaxExtensionMs),
      workspacePath: config.sandboxWorkspacePath,
    };
    if (config.tensorlakeSandboxCpu !== undefined) Object.assign(options, { cpus: config.tensorlakeSandboxCpu });
    if (config.tensorlakeSandboxMemoryMb !== undefined)
      Object.assign(options, { memoryMb: config.tensorlakeSandboxMemoryMb });
    if (config.tensorlakeSandboxDiskMb !== undefined)
      Object.assign(options, { diskMb: config.tensorlakeSandboxDiskMb });
    if (config.tensorlakeAllowInternetAccess !== undefined)
      Object.assign(options, { allowInternetAccess: config.tensorlakeAllowInternetAccess });
    return new TensorlakeSandboxProvider(options);
  }
  if (config.sandboxProvider === 'createos') {
    const options: CreateosSandboxProviderOptions = {
      apiKey: requireCreateosApiKey(config),
      workspacePath: config.sandboxWorkspacePath,
    };
    if (config.createosShape !== undefined) options.shape = config.createosShape;
    if (config.createosBaseUrl !== undefined) options.baseUrl = config.createosBaseUrl;
    if (config.createosRootfs !== undefined) options.rootfs = config.createosRootfs;
    return new CreateosSandboxProvider(options);
  }
  if (config.sandboxProvider === 'k8s-agent-sandbox') {
    const orchestrator =
      config.agentSandboxOrchestratorMode === 'http'
        ? new HttpAgentSandboxOrchestratorClient(
            optional({
              baseUrl: requireAgentSandboxOrchestratorUrl(config),
              token: requireAgentSandboxOrchestratorToken(config),
            }),
          )
        : new InProcessAgentSandboxOrchestrator(
            optional({
              namespace: config.agentSandboxNamespace,
              image: config.agentSandboxImage,
              workspacePath: config.sandboxWorkspacePath,
              storageSize: config.agentSandboxStorageSize,
              storageClassName: config.agentSandboxStorageClassName,
              bridgeSkippedCookieNames: sandboxBridgeSkippedCookieNames(config),
            }),
          );
    return new AgentSandboxProvider({ orchestrator });
  }

  throw new Error(`SANDBOX_PROVIDER=${config.sandboxProvider} is not wired yet`);
}

function optional<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function daytonaSandboxResources(): { cpu?: number; gpu?: number; memory?: number; disk?: number } | undefined {
  const resources: { cpu?: number; gpu?: number; memory?: number; disk?: number } = {};
  if (config.daytonaSandboxCpu !== undefined) resources.cpu = config.daytonaSandboxCpu;
  if (config.daytonaSandboxGpu !== undefined) resources.gpu = config.daytonaSandboxGpu;
  if (config.daytonaSandboxMemoryGiB !== undefined) resources.memory = config.daytonaSandboxMemoryGiB;
  if (config.daytonaSandboxDiskGiB !== undefined) resources.disk = config.daytonaSandboxDiskGiB;
  return Object.keys(resources).length ? resources : undefined;
}

function postgresStoreOptions(): { sandboxSecretEncryptionKey?: string } {
  const options: { sandboxSecretEncryptionKey?: string } = {};
  if (config.sandboxSecretEncryptionKey) options.sandboxSecretEncryptionKey = config.sandboxSecretEncryptionKey;
  return options;
}

async function createRunner(): Promise<Runner> {
  if (config.runner === 'fake') {
    return new FakeRunner(config.fakeRunnerArtifact ? { artifact: config.fakeRunnerArtifact } : {});
  }

  const model = requireRunnerModelDefault(config);
  if (config.runner === 'pi') {
    const piOptions: PiRunnerOptions = {
      model,
      ...(config.openaiCodexAuthFile ? { authFile: config.openaiCodexAuthFile } : {}),
      ...(config.openaiCodexAuthBase64 ? { authBase64: config.openaiCodexAuthBase64 } : {}),
      modelUnavailableReason: (inputModel: string | undefined) =>
        services.modelAvailability.unavailableFor(inputModel || model)?.reason,
    };
    if (artifactObjectStorage) {
      piOptions.artifacts = services.artifacts;
      piOptions.artifactToolMaxBytes = config.artifactCreateMaxBytes;
    }
    if (webSearch) piOptions.webSearch = webSearch;
    piOptions.repositoryAccess = createRepositoryAccess();
    piOptions.externalResources = services.externalResources;
    if (services.sandboxKeepalive) piOptions.sandboxKeepalive = services.sandboxKeepalive;
    piOptions.sandboxKeepaliveMaxExtensionMs = config.sandboxKeepaliveMaxExtensionMs;
    if (config.runnerStateStore === 'postgres') {
      const sessionStore = new PostgresPiSessionStore(requireDatabaseUrl(config));
      resources.push(sessionStore);
      piOptions.sessionStore = sessionStore;
    }
    return new PiRunner(piOptions);
  }

  const options: RealFlueAgentFactoryOptions = {
    model,
  };
  if (configuredModels(config).some((configuredModel) => configuredModel.startsWith('openai-codex/'))) {
    const codexAuth = {};
    if (config.openaiCodexAuthFile) Object.assign(codexAuth, { authFile: config.openaiCodexAuthFile });
    if (config.openaiCodexAuthBase64) Object.assign(codexAuth, { authBase64: config.openaiCodexAuthBase64 });
    try {
      const { apiKey } = await loadOpenAICodexApiKey(codexAuth);
      options.providers = { 'openai-codex': { apiKey } };
      services.modelAvailability.clearPrefix('openai-codex/');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Codex authentication could not be loaded.';
      services.modelAvailability.setPrefixUnavailable('openai-codex/', {
        code: 'openai_codex_auth_unavailable',
        reason: message,
        action: 'Re-authenticate Codex, then refresh this page.',
      });
      console.error(`OpenAI Codex models unavailable: ${message}`);
    }
  }
  if (config.runnerStateStore === 'postgres') {
    const sessionStore = new PostgresFlueSessionStore(requireDatabaseUrl(config));
    resources.push(sessionStore);
    options.sessionStore = sessionStore;
  }

  return new FlueRunner(new RealFlueAgentFactory(options), {
    repositoryAccess: createRepositoryAccess(),
    ...(artifactObjectStorage ? { artifacts: services.artifacts } : {}),
    ...(webSearch ? { webSearch } : {}),
    externalResources: services.externalResources,
    artifactToolMaxBytes: config.artifactCreateMaxBytes,
    ...(services.sandboxKeepalive ? { sandboxKeepalive: services.sandboxKeepalive } : {}),
    sandboxKeepaliveMaxExtensionMs: config.sandboxKeepaliveMaxExtensionMs,
    modelUnavailableReason: (inputModel) =>
      services.modelAvailability.unavailableFor(inputModel || config.runnerModelDefault)?.reason,
  });
}

function createWebSearchServices(): WebSearchToolServices | undefined {
  if (config.webSearchProvider === 'disabled') return undefined;

  const services: WebSearchToolServices = {
    provider: config.webSearchProvider,
    maxResults: config.webSearchMaxResults,
    contentMaxChars: config.webSearchContentMaxChars,
    timeoutMs: config.webSearchTimeoutMs,
  };
  if (config.webSearchBraveApiKey) services.braveApiKey = config.webSearchBraveApiKey;
  return services;
}
