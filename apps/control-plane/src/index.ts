import { AppLifecycle, installProcessShutdownHandlers, type CloseableResource } from './app/lifecycle.js';
import { createServer, createServices, createWorkerHealthServer } from './app/server.js';
import { createArtifactObjectStorage } from './artifacts/storage.js';
import { HttpCompletionCallbackSender, type CompletionCallbackSender } from './callbacks/service.js';
import {
  loadConfig,
  requireDatabaseUrl,
  requireDaytonaApiKey,
  requireDockerOrchestratorUrl,
  requireFlueModel,
  requireGitHubAppCredentials,
} from './config/index.js';
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
import { DaytonaSandboxProvider } from './sandbox/daytona.js';
import { DockerSandboxProvider, HttpDockerOrchestratorClient, InProcessDockerOrchestrator } from './sandbox/docker.js';
import { FakeSandboxProvider } from './sandbox/fake.js';
import { LocalSandboxProvider } from './sandbox/local.js';
import { startSandboxReaper } from './sandbox/reaper.js';
import type { SandboxProvider } from './sandbox/types.js';
import { MemoryStore } from './store/memory.js';
import { PostgresStore } from './store/postgres.js';
import { startWorkerLoop, WorkerService, type WorkerLoopHandle } from './worker/service.js';

const config = loadConfig(process.env);
const store = config.appStore === 'postgres' ? new PostgresStore(requireDatabaseUrl(config)) : new MemoryStore();
const sandboxProvider = createSandboxProvider();
const artifactObjectStorage = config.artifactStorage === 'disabled' ? undefined : createArtifactObjectStorage(config);
const services = createServices(store, {
  sandboxProvider,
  unsafeAllowLocalHttpCallbacks: config.unsafeAllowLocalHttpCallbacks,
  ...(artifactObjectStorage ? { artifactObjectStorage } : {}),
});
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
let sandboxReaper: ReturnType<typeof startSandboxReaper> | undefined;

if ('close' in store && typeof store.close === 'function') resources.push(store as CloseableResource);
if (
  store instanceof PostgresStore &&
  (config.runMode === 'all' || config.runMode === 'api' || config.runMode === 'worker')
) {
  resources.unshift(await store.listenEvents((event) => services.events.publishExternal(event)));
}

if (config.runMode === 'all' || config.runMode === 'api') {
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

if (config.runMode === 'all' || config.runMode === 'worker') {
  const runner = await createRunner();
  const callbackSenders = createCallbackSenders();
  const progressNotifiers = createProgressNotifiers();
  const workerLoops = Array.from({ length: config.workerConcurrency }, (_, index) => {
    const worker = new WorkerService({
      store,
      events: services.events,
      artifacts: services.artifacts,
      runner,
      runnerType: config.runner,
      sandboxProvider,
      leaseOwner: `worker-${process.pid}-${index + 1}`,
      cancellationPollIntervalMs: config.runCancellationPollIntervalMs,
      callbackSenders,
      progressNotifiers,
    });
    return startWorkerLoop(worker, config.workerPollIntervalMs);
  });
  workerLoop = {
    wake(): void {
      for (const loop of workerLoops) loop.wake();
    },
    async stop(): Promise<void> {
      await Promise.all(workerLoops.map((loop) => loop.stop()));
    },
  };
  const unsubscribeWorkerWake = services.events.subscribeAllEvents((event) => {
    if (event.type === 'message_created' || event.type === 'callback_retry_scheduled') workerLoop?.wake();
  });
  resources.unshift({ close: unsubscribeWorkerWake });
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
            }),
          );
    return new DockerSandboxProvider({ orchestrator });
  }
  if (config.sandboxProvider === 'daytona') {
    const options = {
      apiKey: requireDaytonaApiKey(config),
      idleTimeoutMs: config.sandboxIdleTimeoutMs,
    };
    if (config.daytonaApiUrl) Object.assign(options, { apiUrl: config.daytonaApiUrl });
    if (config.daytonaTarget) Object.assign(options, { target: config.daytonaTarget });
    if (config.daytonaImage) Object.assign(options, { image: config.daytonaImage });
    if (config.daytonaSnapshot) Object.assign(options, { snapshot: config.daytonaSnapshot });
    Object.assign(options, { workspacePath: config.sandboxWorkspacePath });
    return new DaytonaSandboxProvider(options);
  }

  throw new Error(`SANDBOX_PROVIDER=${config.sandboxProvider} is not wired yet`);
}

function optional<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

async function createRunner(): Promise<Runner> {
  if (config.runner === 'fake') {
    return new FakeRunner(config.fakeRunnerArtifact ? { artifact: config.fakeRunnerArtifact } : {});
  }

  const model = requireFlueModel(config);
  const options: RealFlueAgentFactoryOptions = {
    model,
  };
  if (model.startsWith('openai-codex/')) {
    const codexAuth = {};
    if (config.flueOpenaiCodexAuthFile) Object.assign(codexAuth, { authFile: config.flueOpenaiCodexAuthFile });
    if (config.flueOpenaiCodexAuthJson) Object.assign(codexAuth, { authJson: config.flueOpenaiCodexAuthJson });
    if (config.flueOpenaiCodexAuthBase64) Object.assign(codexAuth, { authBase64: config.flueOpenaiCodexAuthBase64 });
    const { apiKey } = await loadOpenAICodexApiKey(codexAuth);
    options.providers = { 'openai-codex': { apiKey } };
  }
  if (config.flueSessionStore === 'postgres') {
    const sessionStore = new PostgresFlueSessionStore(requireDatabaseUrl(config));
    resources.push(sessionStore);
    options.sessionStore = sessionStore;
  }

  return new FlueRunner(new RealFlueAgentFactory(options), {
    repositoryAccess: createRepositoryAccess(),
    ...(artifactObjectStorage ? { artifacts: services.artifacts } : {}),
    externalResources: services.externalResources,
    artifactToolMaxBytes: config.artifactToolMaxBytes,
    ...(services.sandboxKeepalive ? { sandboxKeepalive: services.sandboxKeepalive } : {}),
    sandboxKeepaliveMaxExtensionMs: config.sandboxKeepaliveMaxExtensionMs,
  });
}
