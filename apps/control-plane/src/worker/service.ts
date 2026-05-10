import { randomUUID } from 'node:crypto';
import { ArtifactService } from '../artifacts/service.js';
import { CallbackDispatcher, CallbackService, type CompletionCallbackSender } from '../callbacks/service.js';
import type { EventService } from '../events/service.js';
import type { Runner } from '../runner/types.js';
import { SandboxLifecycleService } from '../sandbox/service.js';
import type { SandboxProvider } from '../sandbox/types.js';
import type { ArtifactRecord, CallbackStore, ClaimedMessageBatch, CreateArtifactRecord, MessageRecord, RunRecord, RunStore, SandboxStore, SessionStore } from '../store/types.js';

type WorkerStore = RunStore & SessionStore & SandboxStore & CallbackStore & {
  createArtifact(record: CreateArtifactRecord): Promise<ArtifactRecord>;
};

export type RunProgressNotifier = {
  onRunStarted?(input: { message: MessageRecord; run: RunRecord }): Promise<void>;
};

export type WorkerServiceOptions = {
  store: WorkerStore;
  events: EventService;
  runner: Runner;
  runnerType: string;
  sandboxProvider: SandboxProvider;
  leaseOwner: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  cancellationPollIntervalMs?: number;
  staleRecoveryLimit?: number;
  callbackSenders?: CompletionCallbackSender[];
  progressNotifiers?: RunProgressNotifier[];
};

export class WorkerService {
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly cancellationPollIntervalMs: number;
  private readonly staleRecoveryLimit: number;

  constructor(private readonly options: WorkerServiceOptions) {
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.leaseDurationMs / 2));
    this.cancellationPollIntervalMs = options.cancellationPollIntervalMs ?? 1_000;
    this.staleRecoveryLimit = options.staleRecoveryLimit ?? 10;
  }

  async processNext(): Promise<boolean> {
    await this.recoverStaleRuns();

    const now = new Date();
    const claimed = await this.options.store.claimNextPendingMessageBatch({
      runId: randomUUID(),
      runnerType: this.options.runnerType,
      leaseOwner: this.options.leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
      now,
    });

    if (!claimed) return (await this.dispatchDueCallbacks()) > 0;

    await this.options.events.append({
      sessionId: claimed.messages[0]!.sessionId,
      runId: claimed.run.id,
      messageId: claimed.messages[0]!.id,
      type: 'message_started',
      payload: { sequences: claimed.messages.map((message) => message.sequence), batchSize: claimed.messages.length },
    });
    await this.notifyRunStarted(claimed.messages[0]!, claimed.run);

    try {
      await this.runWithHeartbeat(claimed);
      if (await this.finalizeCancellationIfRequested(claimed.run.id)) return true;
      const completed = await this.options.store.completeRunBatch({ runId: claimed.run.id, completedAt: new Date() });
      for (const message of completed.messages) {
        await this.options.events.append({ sessionId: message.sessionId, runId: completed.run.id, messageId: message.id, type: 'message_completed', payload: { sequence: message.sequence } });
      }
    } catch (error) {
      if (await this.finalizeCancellationIfRequested(claimed.run.id)) return true;
      const message = error instanceof Error ? error.message : 'Unknown worker error';
      const failed = await this.options.store.failRunBatch({ runId: claimed.run.id, failedAt: new Date(), error: message });
      await this.options.events.append({
        sessionId: failed.messages[0]!.sessionId,
        runId: failed.run.id,
        messageId: failed.messages[0]!.id,
        type: 'run_failed',
        payload: { error: message },
      });
      for (const failedMessage of failed.messages) {
        await this.options.events.append({ sessionId: failedMessage.sessionId, runId: failed.run.id, messageId: failedMessage.id, type: 'message_failed', payload: { error: message } });
      }
    }

    return true;
  }

  async recoverStaleRuns(): Promise<number> {
    const recovered = await this.options.store.recoverStaleRuns({
      now: new Date(),
      limit: this.staleRecoveryLimit,
    });

    for (const item of recovered) {
      await this.options.events.append({
        sessionId: item.message.sessionId,
        runId: item.run.id,
        messageId: item.message.id,
        type: 'run_failed',
        payload: { error: item.run.error ?? 'Run lease expired', recovered: true },
      });
    }

    return recovered.length;
  }

  private async runWithHeartbeat(claimed: ClaimedMessageBatch): Promise<void> {
    const abort = new AbortController();
    const pollCancellation = () => {
      this.options.store
        .getRun(claimed.run.id)
        .then((run) => {
          if (run?.status === 'cancelling') abort.abort();
        })
        .catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : error);
        });
    };
    const heartbeat = setInterval(() => {
      const heartbeatAt = new Date();
      this.options.store
        .renewRunLease({
          runId: claimed.run.id,
          leaseOwner: this.options.leaseOwner,
          leaseExpiresAt: new Date(heartbeatAt.getTime() + this.leaseDurationMs),
          heartbeatAt,
        })
        .then((run) => {
          if (run?.status === 'cancelling') abort.abort();
        })
        .catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : error);
        });
    }, this.heartbeatIntervalMs);
    const cancellationPoll = setInterval(pollCancellation, this.cancellationPollIntervalMs);
    pollCancellation();

    try {
      await this.runClaimedMessage(claimed, abort.signal);
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancellationPoll);
    }
  }

  private async runClaimedMessage(claimed: ClaimedMessageBatch, signal: AbortSignal): Promise<void> {
    const primary = claimed.messages[0]!;
    await this.options.events.append({
      sessionId: primary.sessionId,
      runId: claimed.run.id,
      messageId: primary.id,
      type: 'sandbox_starting',
      payload: { provider: this.options.sandboxProvider.name },
    });
    const lifecycle = new SandboxLifecycleService(this.options.store, this.options.sandboxProvider);
    const { sandbox, record, created } = await lifecycle.ensure(primary.sessionId);
    await this.options.store.updateSandbox({ ...record, updatedAt: new Date() });
    await this.options.events.append({
      sessionId: primary.sessionId,
      runId: claimed.run.id,
      messageId: primary.id,
      type: 'sandbox_ready',
      payload: {
        provider: sandbox.provider,
        providerSandboxId: sandbox.providerSandboxId,
        created,
        workspacePath: sandbox.workspacePath,
      },
    });
    try {
      let runContext = buildBatchContext(claimed.messages);
      const result = await this.options.runner.run({
        sessionId: primary.sessionId,
        runId: claimed.run.id,
        messageId: primary.id,
        prompt: buildBatchPrompt(claimed.messages),
        context: runContext,
        sandbox,
        signal,
        updateSessionContext: async (context) => {
          const session = await this.options.store.getSession(primary.sessionId);
          if (!session) throw new Error(`Session not found: ${primary.sessionId}`);
          const updated = await this.options.store.updateSession({ ...session, context, updatedAt: new Date() });
          runContext = updated.context ?? {};
          await this.options.events.append({
            sessionId: primary.sessionId,
            runId: claimed.run.id,
            messageId: primary.id,
            type: 'session_updated',
            payload: { title: updated.title ?? null, context: updated.context ?? null },
          });
          return updated.context ?? {};
        },
        emit: async (event) => {
          if (signal.aborted) return;
          await this.options.events.append({
            sessionId: event.sessionId,
            runId: event.runId ?? claimed.run.id,
            messageId: event.messageId ?? primary.id,
            type: event.type,
            payload: event.payload,
          });
        },
      });
      if (await this.isRunCancellationRequested(claimed.run.id)) return;
      await this.options.events.append({
        sessionId: primary.sessionId,
        runId: claimed.run.id,
        messageId: primary.id,
        type: 'agent_response_final',
        payload: { text: result.text },
      });
      await new ArtifactService(this.options.store, this.options.events).recordRunArtifacts({
        sessionId: primary.sessionId,
        runId: claimed.run.id,
        messageId: primary.id,
        result,
      });
      await new CallbackService(this.options.store).enqueueCompletion({ claimed: { message: primary, run: claimed.run }, result });
    } finally {
      await this.options.store.updateSandbox({ ...record, updatedAt: new Date() });
    }
  }

  private async isRunCancellationRequested(runId: string): Promise<boolean> {
    const status = (await this.options.store.getRun(runId))?.status;
    return status === 'cancelling' || status === 'cancelled';
  }

  private async finalizeCancellationIfRequested(runId: string): Promise<boolean> {
    if (!(await this.isRunCancellationRequested(runId))) return false;
    const cancelled = await this.options.store.finalizeRunCancellation({ runId, cancelledAt: new Date(), error: 'Run cancelled by user' });
    const primary = cancelled.messages[0]!;
    await this.options.events.append({
      sessionId: primary.sessionId,
      runId: cancelled.run.id,
      messageId: primary.id,
      type: 'run_cancelled',
      payload: { sequences: cancelled.messages.map((message) => message.sequence), batchSize: cancelled.messages.length },
    });
    for (const message of cancelled.messages) {
      await this.options.events.append({ sessionId: message.sessionId, runId: cancelled.run.id, messageId: message.id, type: 'message_cancelled', payload: { sequence: message.sequence } });
    }
    return true;
  }

  async dispatchDueCallbacks(): Promise<number> {
    return new CallbackDispatcher(this.options.store, this.options.events, this.options.callbackSenders).dispatchDue();
  }

  private async notifyRunStarted(message: MessageRecord, run: RunRecord): Promise<void> {
    for (const notifier of this.options.progressNotifiers ?? []) {
      try {
        await notifier.onRunStarted?.({ message, run });
      } catch (error) {
        console.warn(error instanceof Error ? error.message : error);
      }
    }
  }
}

function buildBatchPrompt(messages: ClaimedMessageBatch['messages']): string {
  if (messages.length === 1) return messages[0]!.prompt;
  return `The user sent these queued follow-up messages. Address them in order.\n\n${messages.map((message) => `Message ${message.sequence}:\n${message.prompt}`).join('\n\n')}`;
}

function buildBatchContext(messages: ClaimedMessageBatch['messages']): Record<string, unknown> {
  const context = messages.reduce<Record<string, unknown>>((merged, message) => ({ ...merged, ...(message.context ?? {}) }), {});
  return context;
}

export type WorkerLoopHandle = {
  wake(): void;
  stop(): Promise<void>;
};

export function startWorkerLoop(worker: Pick<WorkerService, 'processNext'>, pollIntervalMs = 1_000): WorkerLoopHandle {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let pendingWake = false;

  const poll = () => {
    if (stopped) return;
    if (inFlight) {
      pendingWake = true;
      return;
    }
    pendingWake = false;
    inFlight = (async () => {
      let processed = false;
      do {
        processed = await worker.processNext();
      } while (!stopped && processed);
    })()
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
      })
      .finally(() => {
        inFlight = null;
        if (pendingWake) poll();
      });
  };

  const timer = setInterval(poll, pollIntervalMs);
  poll();

  return {
    wake(): void {
      poll();
    },
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
