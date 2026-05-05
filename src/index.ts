import { createServer, createServices } from './app/server.js';
import { loadConfig, requireDatabaseUrl, requireFlueModel } from './config/index.js';
import { FakeRunner } from './runner/fake.js';
import { FakeSandboxProvider } from './sandbox/fake.js';
import { MemoryStore } from './store/memory.js';
import { PostgresStore } from './store/postgres.js';
import { startWorkerLoop, WorkerService } from './worker/service.js';

const config = loadConfig(process.env);
const store = config.appStore === 'postgres' ? new PostgresStore(requireDatabaseUrl(config)) : new MemoryStore();
const services = createServices(store);

if (config.runMode === 'all' || config.runMode === 'api') {
  const server = createServer(config, services);
  server.listen(config.port, () => {
    console.log(`background-agent service listening on :${config.port} (${config.runMode})`);
  });
}

if (config.runMode === 'all' || config.runMode === 'worker') {
  if (config.runner !== 'fake') {
    requireDatabaseUrl(config);
    requireFlueModel(config);
    throw new Error('RUNNER=flue is configured but the Flue agent factory is not wired yet');
  }

  const worker = new WorkerService({
    store,
    events: services.events,
    runner: new FakeRunner(),
    runnerType: config.runner,
    sandboxProvider: new FakeSandboxProvider(),
    leaseOwner: `worker-${process.pid}`,
  });
  startWorkerLoop(worker);
  console.log(`background-agent worker started (${config.runMode})`);
}
