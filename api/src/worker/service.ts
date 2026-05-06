import { randomUUID } from 'node:crypto';
import { ArtifactService } from '../artifacts/service.js';
import { CallbackService } from '../callbacks/service.js';
import type { EventService } from '../events/service.js';
import type { Runner } from '../runner/types.js';
import { SandboxLifecycleService } from '../sandbox/service.js';
import type { SandboxProvider } from '../sandbox/types.js';
import type { AppStore, ClaimedMessageBatch } from '../store/types.js';

export type WorkerServiceOptions = {
  store: AppStore;
  events: EventService;
  runner: Runner;
  runnerType: string;
  sandboxProvider: SandboxProvider;
  leaseOwner: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  staleRecoveryLimit?: number;
};

export class WorkerService {
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly staleRecoveryLimit: number;

  constructor(private readonly options: WorkerServiceOptions) {
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.leaseDurationMs / 2));
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

    if (!claimed) return false;

    await this.options.events.append({
      sessionId: claimed.messages[0]!.sessionId,
      runId: claimed.run.id,
      messageId: claimed.messages[0]!.id,
      type: 'message_started',
      payload: { sequences: claimed.messages.map((message) => message.sequence), batchSize: claimed.messages.length },
    });

    try {
      await this.runWithHeartbeat(claimed);
      const completed = await this.options.store.completeRunBatch({ runId: claimed.run.id, completedAt: new Date() });
      for (const message of completed.messages) {
        await this.options.events.append({ sessionId: message.sessionId, runId: completed.run.id, messageId: message.id, type: 'message_completed', payload: { sequence: message.sequence } });
      }
    } catch (error) {
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
    const heartbeat = setInterval(() => {
      const heartbeatAt = new Date();
      this.options.store
        .renewRunLease({
          runId: claimed.run.id,
          leaseOwner: this.options.leaseOwner,
          leaseExpiresAt: new Date(heartbeatAt.getTime() + this.leaseDurationMs),
          heartbeatAt,
        })
        .catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : error);
        });
    }, this.heartbeatIntervalMs);

    try {
      await this.runClaimedMessage(claimed);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async runClaimedMessage(claimed: ClaimedMessageBatch): Promise<void> {
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
      const result = await this.options.runner.run({
        sessionId: primary.sessionId,
        runId: claimed.run.id,
        messageId: primary.id,
        prompt: buildBatchPrompt(claimed.messages),
        context: primary.context ?? {},
        sandbox,
        emit: async (event) => {
          await this.options.events.append({
            sessionId: event.sessionId,
            runId: event.runId ?? claimed.run.id,
            messageId: event.messageId ?? primary.id,
            type: event.type,
            payload: event.payload,
          });
        },
      });
      await new ArtifactService(this.options.store, this.options.events).recordRunArtifacts({
        sessionId: primary.sessionId,
        runId: claimed.run.id,
        messageId: primary.id,
        result,
      });
      await new CallbackService(this.options.store, this.options.events).deliverCompletion({ claimed: { message: primary, run: claimed.run }, result });
    } finally {
      await this.options.store.updateSandbox({ ...record, updatedAt: new Date() });
    }
  }
}

function buildBatchPrompt(messages: ClaimedMessageBatch['messages']): string {
  if (messages.length === 1) return messages[0]!.prompt;
  return `The user sent these queued follow-up messages. Address them in order.\n\n${messages.map((message) => `Message ${message.sequence}:\n${message.prompt}`).join('\n\n')}`;
}

export type WorkerLoopHandle = {
  stop(): Promise<void>;
};

export function startWorkerLoop(worker: Pick<WorkerService, 'processNext'>, pollIntervalMs = 1_000): WorkerLoopHandle {
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const poll = () => {
    if (stopped || inFlight) return;
    inFlight = worker.processNext()
      .then(() => {})
      .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(poll, pollIntervalMs);
  poll();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
