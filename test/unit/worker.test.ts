import { createServices } from '../../src/app/server.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';
import { MemoryStore } from '../../src/store/memory.js';
import { WorkerService } from '../../src/worker/service.js';

describe('WorkerService', () => {
  it('processes one pending message with the fake runner', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Worker test' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'do the thing' });

    const worker = new WorkerService({
      store,
      events: services.events,
      runner: new FakeRunner(),
      runnerType: 'fake',
      sandboxProvider: new FakeSandboxProvider(),
      leaseOwner: 'test-worker',
    });

    await expect(worker.processNext()).resolves.toBe(true);
    await expect(worker.processNext()).resolves.toBe(false);

    await expect(services.messages.list(session.id)).resolves.toMatchObject([{ status: 'completed' }]);

    const events = await services.events.list(session.id);
    expect(events.map((event) => event.type)).toEqual([
      'session_created',
      'message_created',
      'message_started',
      'sandbox_starting',
      'sandbox_ready',
      'run_started',
      'agent_text_delta',
      'run_completed',
      'message_completed',
    ]);
  });

  it('reuses the persisted sandbox for follow-up messages', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const provider = new FakeSandboxProvider();
    const session = await services.sessions.create({ title: 'Sandbox reuse' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });

    const worker = new WorkerService({
      store,
      events: services.events,
      runner: new FakeRunner(),
      runnerType: 'fake',
      sandboxProvider: provider,
      leaseOwner: 'test-worker',
    });

    await expect(worker.processNext()).resolves.toBe(true);
    await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });
    await expect(worker.processNext()).resolves.toBe(true);

    const sandboxReadyEvents = (await services.events.list(session.id)).filter(
      (event) => event.type === 'sandbox_ready',
    );
    expect(sandboxReadyEvents.map((event) => event.payload.created)).toEqual([true, false]);
    expect(sandboxReadyEvents.map((event) => event.payload.providerSandboxId)).toEqual([
      `fake-${session.id}`,
      `fake-${session.id}`,
    ]);
  });
});
