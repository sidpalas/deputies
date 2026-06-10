import { randomUUID } from 'node:crypto';
import type { ArtifactService } from '../artifacts/service.js';
import { CallbackDispatcher, CallbackService, type CompletionCallbackSender } from '../callbacks/service.js';
import type { AppendEventInput, EventService } from '../events/service.js';
import type { Runner } from '../runner/types.js';
import { SandboxLifecycleService } from '../sandbox/service.js';
import type { SandboxProvider } from '../sandbox/types.js';
import type {
  CallbackStore,
  ClaimedMessageBatch,
  MessageRecord,
  RunRecord,
  RunStore,
  SandboxStore,
  SessionRecord,
  SessionStore,
} from '../store/types.js';
import { traceAsync } from '../telemetry/index.js';

type WorkerStore = RunStore & SessionStore & SandboxStore & CallbackStore;

export type RunProgressNotifier = {
  onRunStarted?(input: { message: MessageRecord; run: RunRecord }): Promise<void>;
  onRunCompleted?(input: { message: MessageRecord; run: RunRecord }): Promise<void>;
  onRunFailed?(input: { message: MessageRecord; run: RunRecord; error: string }): Promise<void>;
  onRunCancelled?(input: { message: MessageRecord; run: RunRecord }): Promise<void>;
};

export type WorkerServiceOptions = {
  store: WorkerStore;
  events: EventService;
  artifacts: Pick<ArtifactService, 'recordRunArtifacts'>;
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
  private readonly artifacts: Pick<ArtifactService, 'recordRunArtifacts'>;

  constructor(private readonly options: WorkerServiceOptions) {
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.leaseDurationMs / 2));
    this.cancellationPollIntervalMs = options.cancellationPollIntervalMs ?? 1_000;
    this.staleRecoveryLimit = options.staleRecoveryLimit ?? 10;
    this.artifacts = options.artifacts;
  }

  async processNext(): Promise<boolean> {
    return this.processNextInternal();
  }

  private async processNextInternal(): Promise<boolean> {
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
      const completed = await traceAsync('worker.finalize_run', { 'deputies.result': 'completed' }, () =>
        this.options.store.completeRunBatch({
          runId: claimed.run.id,
          leaseOwner: this.options.leaseOwner,
          completedAt: new Date(),
        }),
      );
      if (!completed) return true;
      for (const message of completed.messages) {
        await this.options.events.append({
          sessionId: message.sessionId,
          runId: completed.run.id,
          messageId: message.id,
          type: 'message_completed',
          payload: { sequence: message.sequence },
        });
      }
      await this.notifyRunCompleted(completed.messages[0]!, completed.run);
    } catch (error) {
      if (await this.finalizeCancellationIfRequested(claimed.run.id)) return true;
      const message = error instanceof Error ? error.message : 'Unknown worker error';
      const failed = await traceAsync('worker.finalize_run', { 'deputies.result': 'failed' }, () =>
        this.options.store.failRunBatch({
          runId: claimed.run.id,
          leaseOwner: this.options.leaseOwner,
          failedAt: new Date(),
          error: message,
        }),
      );
      if (!failed) return true;
      await this.options.events.append({
        sessionId: failed.messages[0]!.sessionId,
        runId: failed.run.id,
        messageId: failed.messages[0]!.id,
        type: 'run_failed',
        payload: { error: message },
      });
      for (const failedMessage of failed.messages) {
        await this.options.events.append({
          sessionId: failedMessage.sessionId,
          runId: failed.run.id,
          messageId: failedMessage.id,
          type: 'message_failed',
          payload: { error: message },
        });
      }
      await this.notifyRunFailed(failed.messages[0]!, failed.run, message);
    }

    return true;
  }

  async recoverStaleRuns(): Promise<number> {
    const recovered = await this.options.store.recoverStaleRuns({
      now: new Date(),
      limit: this.staleRecoveryLimit,
    });

    for (const item of recovered) {
      for (const message of item.messages) {
        await this.options.events.append({
          sessionId: message.sessionId,
          runId: item.run.id,
          messageId: message.id,
          type: 'run_failed',
          payload: { error: item.run.error ?? 'Run lease expired', recovered: true },
        });
      }
    }

    return recovered.length;
  }

  private async runWithHeartbeat(claimed: ClaimedMessageBatch): Promise<void> {
    const abort = new AbortController();
    const pollCancellation = () => {
      this.options.store
        .getRun(claimed.run.id)
        .then((run) => {
          if (!run || run.status === 'cancelling') abort.abort();
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
          if (!run || run.status === 'cancelling') abort.abort();
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
    await this.appendOwnedRunEvent({
      sessionId: primary.sessionId,
      runId: claimed.run.id,
      messageId: primary.id,
      type: 'sandbox_starting',
      payload: { provider: this.options.sandboxProvider.name },
    });
    const lifecycle = new SandboxLifecycleService(this.options.store, this.options.sandboxProvider);
    const { sandbox, record, created, restarted } = await traceAsync(
      'worker.ensure_sandbox',
      { 'deputies.sandbox_provider': this.options.sandboxProvider.name },
      () => lifecycle.ensure(primary.sessionId),
    );
    await this.options.store.updateSandbox({ ...record, updatedAt: new Date() });
    await this.appendOwnedRunEvent({
      sessionId: primary.sessionId,
      runId: claimed.run.id,
      messageId: primary.id,
      type: 'sandbox_ready',
      payload: {
        provider: sandbox.provider,
        providerSandboxId: sandbox.providerSandboxId,
        created,
        ...(restarted ? { restarted } : {}),
        workspacePath: sandbox.workspacePath,
      },
    });
    try {
      const session = await this.options.store.getSession(primary.sessionId);
      if (!session) throw new Error(`Session not found: ${primary.sessionId}`);
      const sessionContext =
        created || restarted ? await this.clearSessionServicesForRun(session, claimed) : (session.context ?? {});
      let runContext = { ...sessionContext, ...buildBatchContext(claimed.messages) };
      const result = await traceAsync(
        'worker.runner_run',
        { 'deputies.runner_type': this.options.runnerType, 'deputies.message_count': claimed.messages.length },
        () =>
          this.options.runner.run({
            sessionId: primary.sessionId,
            runId: claimed.run.id,
            messageId: primary.id,
            prompt: buildBatchPrompt(claimed.messages),
            ...(typeof runContext.model === 'string' ? { model: runContext.model } : {}),
            context: runContext,
            sandbox,
            signal,
            updateSessionContext: async (context) => {
              if (signal.aborted || !(await this.isRunOwnedByThisWorker(claimed.run.id))) return runContext;
              const session = await this.options.store.getSession(primary.sessionId);
              if (!session) throw new Error(`Session not found: ${primary.sessionId}`);
              if (signal.aborted || !(await this.isRunOwnedByThisWorker(claimed.run.id))) return runContext;
              const updated = await this.options.store.updateSessionForRun({
                record: {
                  ...session,
                  context: { ...(session.context ?? {}), ...context },
                  updatedAt: new Date(),
                },
                runId: claimed.run.id,
                leaseOwner: this.options.leaseOwner,
                now: new Date(),
              });
              if (!updated) return runContext;
              runContext = updated.context ?? {};
              await this.appendOwnedRunEvent({
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
              const runId = event.runId ?? claimed.run.id;
              await this.appendOwnedRunEvent({
                sessionId: event.sessionId,
                runId,
                messageId: event.messageId ?? primary.id,
                type: event.type,
                payload: event.payload,
              });
            },
            shouldPersist: async () =>
              !signal.aborted &&
              !(await this.isRunCancellationRequested(claimed.run.id)) &&
              (await this.isRunOwnedByThisWorker(claimed.run.id)),
          }),
      );
      if (await this.isRunCancellationRequested(claimed.run.id)) return;
      if (!(await this.isRunOwnedByThisWorker(claimed.run.id))) return;
      await this.appendOwnedRunEvent({
        sessionId: primary.sessionId,
        runId: claimed.run.id,
        messageId: primary.id,
        type: 'agent_response_final',
        payload: {
          text: result.text,
          ...(result.model ? { model: result.model } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
        },
      });
      const artifacts = await traceAsync('worker.persist_artifacts', {}, (span) =>
        this.artifacts
          .recordRunArtifacts({
            sessionId: primary.sessionId,
            runId: claimed.run.id,
            messageId: primary.id,
            result,
          })
          .then((records) => {
            span.setAttribute('deputies.artifact_count', records.length);
            return records;
          }),
      );
      await new CallbackService(this.options.store).enqueueCompletion({
        claimed: { message: primary, run: claimed.run },
        result,
        artifactRecords: artifacts,
      });
    } finally {
      const current = await this.options.store.getActiveSandbox(primary.sessionId, record.provider);
      if (current?.id === record.id) await this.options.store.updateSandbox({ ...current, updatedAt: new Date() });
    }
  }

  private async clearSessionServicesForRun(
    session: SessionRecord,
    claimed: ClaimedMessageBatch,
  ): Promise<Record<string, unknown>> {
    const context = session.context ?? {};
    if (!Array.isArray(context.services) || context.services.length === 0) return context;
    if (!(await this.isRunOwnedByThisWorker(claimed.run.id))) return context;
    const updated = await this.options.store.updateSessionForRun({
      record: {
        ...session,
        context: { ...context, services: [] },
        updatedAt: new Date(),
      },
      runId: claimed.run.id,
      leaseOwner: this.options.leaseOwner,
      now: new Date(),
    });
    if (!updated) return context;
    await this.appendOwnedRunEvent({
      sessionId: claimed.messages[0]!.sessionId,
      runId: claimed.run.id,
      messageId: claimed.messages[0]!.id,
      type: 'session_updated',
      payload: { title: updated.title ?? null, context: updated.context ?? null },
    });
    return updated.context ?? {};
  }

  private async isRunCancellationRequested(runId: string): Promise<boolean> {
    const status = (await this.options.store.getRun(runId))?.status;
    return status === 'cancelling' || status === 'cancelled';
  }

  private async isRunOwnedByThisWorker(runId: string): Promise<boolean> {
    const run = await this.options.store.getRun(runId);
    return (
      !!run &&
      (run.status === 'running' || run.status === 'cancelling') &&
      run.leaseOwner === this.options.leaseOwner &&
      !!run.leaseExpiresAt &&
      run.leaseExpiresAt > new Date()
    );
  }

  private async appendOwnedRunEvent(input: AppendEventInput & { runId: string }): Promise<void> {
    await this.options.events.appendForRun(input, {
      runId: input.runId,
      leaseOwner: this.options.leaseOwner,
      now: new Date(),
    });
  }

  private async finalizeCancellationIfRequested(runId: string): Promise<boolean> {
    if (!(await this.isRunCancellationRequested(runId))) return false;
    const cancelled = await traceAsync('worker.finalize_run', { 'deputies.result': 'cancelled' }, () =>
      this.options.store.finalizeRunCancellation({
        runId,
        leaseOwner: this.options.leaseOwner,
        cancelledAt: new Date(),
        error: 'Run cancelled by user',
      }),
    );
    if (!cancelled) return false;
    const primary = cancelled.messages[0]!;
    await this.options.events.append({
      sessionId: primary.sessionId,
      runId: cancelled.run.id,
      messageId: primary.id,
      type: 'run_cancelled',
      payload: {
        sequences: cancelled.messages.map((message) => message.sequence),
        batchSize: cancelled.messages.length,
      },
    });
    await this.notifyRunCancelled(primary, cancelled.run);
    for (const message of cancelled.messages) {
      await this.options.events.append({
        sessionId: message.sessionId,
        runId: cancelled.run.id,
        messageId: message.id,
        type: 'message_cancelled',
        payload: { sequence: message.sequence },
      });
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

  private async notifyRunCompleted(message: MessageRecord, run: RunRecord): Promise<void> {
    for (const notifier of this.options.progressNotifiers ?? []) {
      try {
        await notifier.onRunCompleted?.({ message, run });
      } catch (error) {
        console.warn(error instanceof Error ? error.message : error);
      }
    }
  }

  private async notifyRunFailed(message: MessageRecord, run: RunRecord, error: string): Promise<void> {
    for (const notifier of this.options.progressNotifiers ?? []) {
      try {
        await notifier.onRunFailed?.({ message, run, error });
      } catch (notifyError) {
        console.warn(notifyError instanceof Error ? notifyError.message : notifyError);
      }
    }
  }

  private async notifyRunCancelled(message: MessageRecord, run: RunRecord): Promise<void> {
    for (const notifier of this.options.progressNotifiers ?? []) {
      try {
        await notifier.onRunCancelled?.({ message, run });
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
  const context = messages.reduce<Record<string, unknown>>(
    (merged, message) => ({ ...merged, ...(message.context ?? {}) }),
    {},
  );
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
