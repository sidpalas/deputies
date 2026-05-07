import { CallbackDispatcher } from '../../src/callbacks/service.js';
import { createServices } from '../../src/app/server.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';
import type { Runner, RunnerInput, RunnerResult } from '../../src/runner/types.js';
import { runSandboxReaperOnce } from '../../src/sandbox/reaper.js';
import { SandboxCleanupService } from '../../src/sandbox/service.js';
import { MemoryStore } from '../../src/store/memory.js';
import { startWorkerLoop, WorkerService } from '../../src/worker/service.js';

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
      'agent_response_final',
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

  it('claims queued messages for a session as one ordered batch', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Queued batch' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'third' });

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

    await expect(services.messages.list(session.id)).resolves.toMatchObject([
      { sequence: 1, status: 'completed' },
      { sequence: 2, status: 'completed' },
      { sequence: 3, status: 'completed' },
    ]);
    const sandboxReadyEvents = (await services.events.list(session.id)).filter((event) => event.type === 'sandbox_ready');
    expect(sandboxReadyEvents).toHaveLength(1);
    const text = (await services.events.list(session.id)).find((event) => event.type === 'agent_text_delta')?.payload.text;
    expect(text).toContain('Message 2:');
    expect(text).toContain('third');
  });

  it('runs a queued batch with the latest message context', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Queued context' });
    await services.messages.enqueue({
      sessionId: session.id,
      prompt: 'first',
      context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'old-repo' } },
    });
    await services.messages.enqueue({
      sessionId: session.id,
      prompt: 'second',
      context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'new-repo' } },
    });
    const runner = new CaptureRunner();

    const worker = new WorkerService({
      store,
      events: services.events,
      runner,
      runnerType: 'capture',
      sandboxProvider: new FakeSandboxProvider(),
      leaseOwner: 'test-worker',
    });

    await expect(worker.processNext()).resolves.toBe(true);

    expect(runner.inputs[0]?.context).toEqual({
      repository: { provider: 'github', owner: 'manaflow-ai', repo: 'new-repo' },
    });
  });

  it('lets runners update durable session context during a run', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Dynamic context' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'choose repo' });

    const worker = new WorkerService({
      store,
      events: services.events,
      runner: new ContextUpdatingRunner(),
      runnerType: 'context-updating',
      sandboxProvider: new FakeSandboxProvider(),
      leaseOwner: 'test-worker',
    });

    await expect(worker.processNext()).resolves.toBe(true);

    await expect(services.sessions.get(session.id)).resolves.toMatchObject({
      context: { repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } },
    });
    const events = await services.events.list(session.id);
    expect(events.map((event) => event.type)).toContain('session_updated');
  });

  it('posts final deputy text to Slack thread callbacks', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Slack callback' });
    const replies: Array<{ channel: string; threadTs: string; text: string }> = [];
    const progress: Array<{ channel: string; timestamp: string; name: string }> = [];
    await services.messages.enqueue({
      sessionId: session.id,
      prompt: 'from slack',
      source: 'slack',
      context: { callback: { type: 'slack', channel: 'C123', threadTs: '1710000000.000100', messageTs: '1710000001.000100' } },
    });

    const worker = new WorkerService({
      store,
      events: services.events,
      runner: new TextRunner('final deputy reply'),
      runnerType: 'fake',
      sandboxProvider: new FakeSandboxProvider(),
      leaseOwner: 'test-worker',
      callbackSenders: [{
        type: 'slack',
        async deliver(callback, payload) {
          replies.push({
            channel: String(callback.target.channel),
            threadTs: String(callback.target.threadTs),
            text: payload.text,
          });
        },
      }],
      progressNotifiers: [{
        async onRunStarted({ message }) {
          const callback = message.context?.callback as { channel: string; messageTs: string };
          progress.push({ channel: callback.channel, timestamp: callback.messageTs, name: 'hourglass_flowing_sand' });
        },
      }],
    });

    await expect(worker.processNext()).resolves.toBe(true);
    await expect(worker.processNext()).resolves.toBe(true);

    expect(replies).toEqual([{ channel: 'C123', threadTs: '1710000000.000100', text: 'final deputy reply' }]);
    expect(progress).toEqual([{ channel: 'C123', timestamp: '1710000001.000100', name: 'hourglass_flowing_sand' }]);
    const events = await services.events.list(session.id);
    expect(events.map((event) => event.type)).toContain('callback_sent');
    expect(events.find((event) => event.type === 'callback_sent')?.payload).toMatchObject({ targetType: 'slack' });
  });

  it('retries failed callbacks with backoff before terminal failure', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Callback retry' });
    const now = new Date('2026-05-06T00:00:00.000Z');
    await store.createCallbackDelivery({
      id: '00000000-0000-4000-8000-000000000901',
      sessionId: session.id,
      targetType: 'http',
      target: { url: 'https://example.com/callback' },
      eventType: 'message_completed',
      payload: {
        event: 'message_completed',
        sessionId: session.id,
        runId: '00000000-0000-4000-8000-000000000902',
        messageId: '00000000-0000-4000-8000-000000000903',
        text: 'done',
        artifacts: [],
      },
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      maxAttempts: 2,
    });

    let currentTime = now;
    const dispatcher = new CallbackDispatcher(store, services.events, [{
      type: 'http',
      async deliver() {
        throw new Error('temporary outage');
      },
    }], { now: () => currentTime, baseDelayMs: 1_000, jitterRatio: 0 });

    await expect(dispatcher.dispatchDue()).resolves.toBe(1);
    await expect(dispatcher.dispatchDue()).resolves.toBe(0);
    currentTime = new Date(now.getTime() + 1_000);
    await expect(dispatcher.dispatchDue()).resolves.toBe(1);

    const eventTypes = (await services.events.list(session.id)).map((event) => event.type);
    expect(eventTypes).toContain('callback_retry_scheduled');
    expect(eventTypes).toContain('callback_failed');
  });

  it('does not claim queued messages while the session queue is paused', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Paused queue' });
    const message = await services.messages.enqueue({ sessionId: session.id, prompt: 'original' });
    await services.sessions.pauseQueue(session.id);

    const worker = new WorkerService({
      store,
      events: services.events,
      runner: new FakeRunner(),
      runnerType: 'fake',
      sandboxProvider: new FakeSandboxProvider(),
      leaseOwner: 'test-worker',
    });

    await expect(worker.processNext()).resolves.toBe(false);
    await expect(services.messages.updatePending({ sessionId: session.id, messageId: message.id, prompt: 'edited' })).resolves.toMatchObject({ prompt: 'edited' });
    await services.sessions.resumeQueue(session.id);
    await expect(worker.processNext()).resolves.toBe(true);
    await expect(services.messages.list(session.id)).resolves.toMatchObject([{ prompt: 'edited', status: 'completed' }]);
  });

  it('does not complete a run that was cancelled while the runner was active', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const session = await services.sessions.create({ title: 'Cancel running batch' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'first' });
    await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });
    const runner = new BlockingRunner();

    const worker = new WorkerService({
      store,
      events: services.events,
      runner,
      runnerType: 'blocking',
      sandboxProvider: new FakeSandboxProvider(),
      leaseOwner: 'test-worker',
      heartbeatIntervalMs: 60_000,
      cancellationPollIntervalMs: 5,
    });

    const processing = worker.processNext();
    await runner.waitForStart();
    await expect(services.messages.cancelActiveRun({ sessionId: session.id })).resolves.toMatchObject([{ status: 'cancelling' }, { status: 'cancelling' }]);
    await runner.waitForAbort();

    await expect(processing).resolves.toBe(true);
    await expect(services.messages.list(session.id)).resolves.toMatchObject([
      { sequence: 1, status: 'cancelled' },
      { sequence: 2, status: 'cancelled' },
    ]);
    expect(await store.getArtifacts(session.id)).toEqual([]);
    expect((await services.events.list(session.id)).map((event) => event.type)).toEqual([
      'session_created',
      'message_created',
      'message_created',
      'message_started',
      'sandbox_starting',
      'sandbox_ready',
      'run_started',
      'run_cancel_requested',
      'run_cancelled',
      'message_cancelled',
      'message_cancelled',
    ]);
  });

  it('restarts a stopped persisted sandbox for follow-up messages', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const provider = new FakeSandboxProvider();
    const session = await services.sessions.create({ title: 'Stopped sandbox reuse' });
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
    const active = await store.getActiveSandbox(session.id, provider.name);
    expect(active).not.toBeNull();
    await store.updateSandbox({ ...active!, status: 'stopped' });
    provider.markStopped(active!.providerSandboxId);

    await services.messages.enqueue({ sessionId: session.id, prompt: 'second' });
    await expect(worker.processNext()).resolves.toBe(true);

    const sandboxReadyEvents = (await services.events.list(session.id)).filter(
      (event) => event.type === 'sandbox_ready',
    );
    expect(sandboxReadyEvents.map((event) => event.payload.created)).toEqual([true, false]);
    expect(provider.starts).toBe(1);
  });

  it('stops the worker loop after in-flight processing completes', async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const loop = startWorkerLoop(
      {
        async processNext() {
          calls += 1;
          await inFlight;
          return false;
        },
      },
      5,
    );

    await waitFor(() => calls === 1);
    const stopped = loop.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    release();
    await stopped;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
  });

  it('reaps idle sandboxes without archiving sessions', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const provider = new FakeSandboxProvider();
    const session = await services.sessions.create({ title: 'Idle sandbox' });
    const old = new Date(Date.now() - 120_000);
    await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000601',
      sessionId: session.id,
      provider: provider.name,
      providerSandboxId: `fake-${session.id}`,
      status: 'stopped',
      workspacePath: '/workspace',
      metadata: {},
      createdAt: old,
      updatedAt: old,
    });

    const destroyed = await runSandboxReaperOnce({
      cleanup: new SandboxCleanupService(store, services.events, provider),
      store,
      stopDelayMs: 60_000,
      retentionMs: 60_000,
    });

    expect(destroyed).toBe(1);
    expect(provider.destroys).toBe(1);
    await expect(store.getActiveSandbox(session.id, provider.name)).resolves.toBeNull();
    await expect(services.sessions.get(session.id)).resolves.toMatchObject({ status: 'created' });
    const events = await services.events.list(session.id);
    expect(events.map((event) => event.type)).toEqual(['session_created', 'sandbox_destroyed']);
  });

  it('stops ready sandboxes after the stop delay when no messages are queued', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const provider = new FakeSandboxProvider();
    const session = await services.sessions.create({ title: 'Stop sandbox' });
    const old = new Date(Date.now() - 120_000);
    await store.createSandbox({
      id: '00000000-0000-4000-8000-000000000602',
      sessionId: session.id,
      provider: provider.name,
      providerSandboxId: `fake-${session.id}`,
      status: 'ready',
      workspacePath: '/workspace',
      metadata: {},
      createdAt: old,
      updatedAt: old,
    });

    const stopped = await runSandboxReaperOnce({
      cleanup: new SandboxCleanupService(store, services.events, provider),
      store,
      stopDelayMs: 60_000,
      retentionMs: 3_600_000,
    });

    expect(stopped).toBe(1);
    expect(provider.stops).toBe(1);
    await expect(store.getActiveSandbox(session.id, provider.name)).resolves.toMatchObject({ status: 'stopped' });
    const events = await services.events.list(session.id);
    expect(events.map((event) => event.type)).toEqual(['session_created', 'sandbox_stopped']);
  });

  it('skips the sandbox reaper when another postgres advisory lock holder is active', async () => {
    let cleanupCalled = false;

    const destroyed = await runSandboxReaperOnce({
      cleanup: {
        async stopIdleSandboxes() {
          cleanupCalled = true;
          return { destroyed: 0, stopped: 1, failed: 0 };
        },
        async destroyIdleSandboxes() {
          cleanupCalled = true;
          return { destroyed: 1, stopped: 0, failed: 0 };
        },
      } as unknown as SandboxCleanupService,
      store: {
        async withAdvisoryLock() {
          return null;
        },
      },
      stopDelayMs: 60_000,
      retentionMs: 60_000,
    });

    expect(destroyed).toBe(0);
    expect(cleanupCalled).toBe(false);
  });
});

class TextRunner implements Runner {
  constructor(private readonly text: string) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    await input.emit({ sessionId: input.sessionId, runId: input.runId, messageId: input.messageId, type: 'run_started', payload: {}, createdAt: new Date() });
    await input.emit({ sessionId: input.sessionId, runId: input.runId, messageId: input.messageId, type: 'agent_text_delta', payload: { text: this.text }, createdAt: new Date() });
    await input.emit({ sessionId: input.sessionId, runId: input.runId, messageId: input.messageId, type: 'run_completed', payload: {}, createdAt: new Date() });
    return { text: this.text };
  }
}

class CaptureRunner implements Runner {
  readonly inputs: RunnerInput[] = [];

  async run(input: RunnerInput): Promise<RunnerResult> {
    this.inputs.push(input);
    await input.emit({ sessionId: input.sessionId, runId: input.runId, messageId: input.messageId, type: 'run_started', payload: {}, createdAt: new Date() });
    await input.emit({ sessionId: input.sessionId, runId: input.runId, messageId: input.messageId, type: 'run_completed', payload: {}, createdAt: new Date() });
    return { text: 'captured' };
  }
}

class ContextUpdatingRunner implements Runner {
  async run(input: RunnerInput): Promise<RunnerResult> {
    await input.updateSessionContext?.({ repository: { provider: 'github', owner: 'manaflow-ai', repo: 'manaflow' } });
    return { text: 'updated' };
  }
}

class BlockingRunner implements Runner {
  private started = false;
  private aborted = false;
  private abortRun!: () => void;
  private readonly abortReceived = new Promise<void>((resolve) => {
    this.abortRun = resolve;
  });

  async run(input: RunnerInput): Promise<RunnerResult> {
    this.started = true;
    await input.emit({ sessionId: input.sessionId, runId: input.runId, messageId: input.messageId, type: 'run_started', payload: {}, createdAt: new Date() });
    input.signal?.addEventListener('abort', () => {
      this.aborted = true;
      this.abortRun();
    }, { once: true });
    if (input.signal?.aborted) {
      this.aborted = true;
      this.abortRun();
    }
    await this.abortReceived;
    throw new Error('Operation aborted');
  }

  async waitForAbort(): Promise<void> {
    await waitFor(() => this.aborted);
  }

  release(): void {
    this.abortRun();
  }

  async waitForStart(): Promise<void> {
    await waitFor(() => this.started);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}
