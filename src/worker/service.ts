import { randomUUID } from 'node:crypto';
import { ArtifactService } from '../artifacts/service.js';
import { CallbackService } from '../callbacks/service.js';
import type { EventService } from '../events/service.js';
import type { Runner } from '../runner/types.js';
import { SandboxLifecycleService } from '../sandbox/service.js';
import type { SandboxProvider } from '../sandbox/types.js';
import type { AppStore, ClaimedMessage } from '../store/types.js';

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
    const claimed = await this.options.store.claimNextPendingMessage({
      runId: randomUUID(),
      runnerType: this.options.runnerType,
      leaseOwner: this.options.leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
      now,
    });

    if (!claimed) return false;

    await this.options.events.append({
      sessionId: claimed.message.sessionId,
      runId: claimed.run.id,
      messageId: claimed.message.id,
      type: 'message_started',
      payload: { sequence: claimed.message.sequence },
    });

    try {
      await this.runWithHeartbeat(claimed);
      const completed = await this.options.store.completeRun({ runId: claimed.run.id, completedAt: new Date() });
      await this.options.events.append({
        sessionId: completed.message.sessionId,
        runId: completed.run.id,
        messageId: completed.message.id,
        type: 'message_completed',
        payload: { sequence: completed.message.sequence },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown worker error';
      const failed = await this.options.store.failRun({ runId: claimed.run.id, failedAt: new Date(), error: message });
      await this.options.events.append({
        sessionId: failed.message.sessionId,
        runId: failed.run.id,
        messageId: failed.message.id,
        type: 'run_failed',
        payload: { error: message },
      });
      await this.options.events.append({
        sessionId: failed.message.sessionId,
        runId: failed.run.id,
        messageId: failed.message.id,
        type: 'message_failed',
        payload: { error: message },
      });
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

  private async runWithHeartbeat(claimed: ClaimedMessage): Promise<void> {
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

  private async runClaimedMessage(claimed: ClaimedMessage): Promise<void> {
    await this.options.events.append({
      sessionId: claimed.message.sessionId,
      runId: claimed.run.id,
      messageId: claimed.message.id,
      type: 'sandbox_starting',
      payload: { provider: this.options.sandboxProvider.name },
    });
    const lifecycle = new SandboxLifecycleService(this.options.store, this.options.sandboxProvider);
    const { sandbox, created } = await lifecycle.ensure(claimed.message.sessionId);
    await this.options.events.append({
      sessionId: claimed.message.sessionId,
      runId: claimed.run.id,
      messageId: claimed.message.id,
      type: 'sandbox_ready',
      payload: {
        provider: sandbox.provider,
        providerSandboxId: sandbox.providerSandboxId,
        created,
        workspacePath: sandbox.workspacePath,
      },
    });
    const result = await this.options.runner.run({
      sessionId: claimed.message.sessionId,
      runId: claimed.run.id,
      messageId: claimed.message.id,
      prompt: claimed.message.prompt,
      context: claimed.message.context ?? {},
      sandbox,
      emit: async (event) => {
        await this.options.events.append({
          sessionId: event.sessionId,
          runId: event.runId ?? claimed.run.id,
          messageId: event.messageId ?? claimed.message.id,
          type: event.type,
          payload: event.payload,
        });
      },
    });
    await new ArtifactService(this.options.store, this.options.events).recordRunArtifacts({
      sessionId: claimed.message.sessionId,
      runId: claimed.run.id,
      messageId: claimed.message.id,
      result,
    });
    await new CallbackService(this.options.store, this.options.events).deliverCompletion({ claimed, result });
  }
}

export function startWorkerLoop(worker: WorkerService, pollIntervalMs = 1_000): () => void {
  const timer = setInterval(() => {
    worker.processNext().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
    });
  }, pollIntervalMs);

  return () => clearInterval(timer);
}
