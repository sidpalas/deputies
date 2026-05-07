import { AppLifecycle, installProcessShutdownHandlers, type CloseableResource } from './app/lifecycle.js';
import { createServer, createServices } from './app/server.js';
import { HttpCompletionCallbackSender, type CompletionCallbackSender } from './callbacks/service.js';
import { loadConfig, requireDatabaseUrl, requireDaytonaApiKey, requireFlueModel, requireGitHubAppCredentials } from './config/index.js';
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
import { RealFlueAgentFactory } from './runner-flue/agent-factory.js';
import { FlueRunner } from './runner-flue/runner.js';
import { PostgresFlueSessionStore } from './runner-flue/session-store.js';
import { DaytonaSandboxProvider } from './sandbox/daytona.js';
import { FakeSandboxProvider } from './sandbox/fake.js';
import { startSandboxReaper } from './sandbox/reaper.js';
import type { SandboxProvider } from './sandbox/types.js';
import { MemoryStore } from './store/memory.js';
import { PostgresStore } from './store/postgres.js';
import { startWorkerLoop, WorkerService } from './worker/service.js';

const config = loadConfig(process.env);
const store = config.appStore === 'postgres' ? new PostgresStore(requireDatabaseUrl(config)) : new MemoryStore();
const sandboxProvider = createSandboxProvider();
const services = createServices(store, { sandboxProvider });
const githubClient = config.githubAppId || config.githubAppPrivateKey ? new GitHubClient({ apiBaseUrl: config.githubApiBaseUrl }) : null;
const githubRepositoryAccess = githubClient ? createGitHubRepositoryAccess(githubClient) : null;
if (githubClient && githubRepositoryAccess) {
  services.githubReactionSender = new GitHubReactionSender(githubClient, githubRepositoryAccess);
  services.githubIssueContextFetcher = new GitHubIssueContextFetcher(githubClient, githubRepositoryAccess);
}
const resources: CloseableResource[] = [];
let server: ReturnType<typeof createServer> | undefined;
let workerLoop: ReturnType<typeof startWorkerLoop> | undefined;
let sandboxReaper: ReturnType<typeof startSandboxReaper> | undefined;

if ('close' in store && typeof store.close === 'function') resources.push(store as CloseableResource);

if (config.runMode === 'all' || config.runMode === 'api') {
  server = createServer(config, services);
  server.listen(config.port, () => {
    console.log(`background-agent service listening on :${config.port} (${config.runMode})`);
  });
}

if (config.runMode === 'all' || config.runMode === 'worker') {
  const worker = new WorkerService({
    store,
    events: services.events,
    runner: createRunner(),
    runnerType: config.runner,
    sandboxProvider,
    leaseOwner: `worker-${process.pid}`,
    cancellationPollIntervalMs: config.runCancellationPollIntervalMs,
    callbackSenders: createCallbackSenders(),
    progressNotifiers: createProgressNotifiers(),
  });
  workerLoop = startWorkerLoop(worker);
  if (services.sandboxCleanup) {
    sandboxReaper = startSandboxReaper({
      cleanup: services.sandboxCleanup,
      store,
      stopDelayMs: config.sandboxStopDelaySeconds * 1000,
      retentionMs: config.sandboxRetentionSeconds * 1000,
      onError: (error: unknown) => console.error(error instanceof Error ? error.message : error),
    });
  }
  console.log(`background-agent worker started (${config.runMode})`);
}

function createCallbackSenders(): CompletionCallbackSender[] {
  const senders: CompletionCallbackSender[] = [new HttpCompletionCallbackSender()];
  if (config.slackBotToken) {
    senders.push(new SlackCompletionCallbackSender(new SlackClient({ apiBaseUrl: config.slackApiBaseUrl, botToken: config.slackBotToken })));
  }
  if (config.githubAppId || config.githubAppPrivateKey) {
    if (!githubClient || !githubRepositoryAccess) throw new Error('GitHub callback sender requires GitHub App credentials');
    senders.push(new GitHubCompletionCallbackSender(githubClient, githubRepositoryAccess));
  }
  return senders;
}

function createProgressNotifiers() {
  if (!config.slackBotToken) return [];
  return [new SlackRunProgressNotifier(new SlackClient({ apiBaseUrl: config.slackApiBaseUrl, botToken: config.slackBotToken }))];
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
  if (config.sandboxProvider === 'daytona') {
    const options = {
      apiKey: requireDaytonaApiKey(config),
      idleTimeoutSeconds: config.sandboxIdleTimeoutSeconds,
    };
    if (config.daytonaApiUrl) Object.assign(options, { apiUrl: config.daytonaApiUrl });
    if (config.daytonaTarget) Object.assign(options, { target: config.daytonaTarget });
    if (config.daytonaImage) Object.assign(options, { image: config.daytonaImage });
    if (config.daytonaSnapshot) Object.assign(options, { snapshot: config.daytonaSnapshot });
    return new DaytonaSandboxProvider(options);
  }

  throw new Error(`SANDBOX_PROVIDER=${config.sandboxProvider} is not wired yet`);
}

function createRunner(): Runner {
  if (config.runner === 'fake') return new FakeRunner();

  const options = {
    model: requireFlueModel(config),
  };
  if (config.flueSessionStore === 'postgres') {
    const sessionStore = new PostgresFlueSessionStore(requireDatabaseUrl(config));
    resources.push(sessionStore);
    Object.assign(options, { sessionStore });
  }

  return new FlueRunner(new RealFlueAgentFactory(options), { repositoryAccess: createRepositoryAccess() });
}
