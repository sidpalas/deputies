import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import type { RunnerResult } from '../runner/types.js';
import type { AppStore, CallbackDeliveryRecord, ClaimedMessage } from '../store/types.js';

export type CompletionCallbackType = 'http' | 'slack' | 'github';

export type CompletionCallback = {
  type: CompletionCallbackType;
  target: Record<string, unknown>;
};

export type CompletionCallbackPayload = {
  event: 'message_completed';
  sessionId: string;
  runId: string;
  messageId: string;
  text: string;
  artifacts: Array<{ type: string; url?: string; payload?: Record<string, unknown> }>;
};

export type CompletionCallbackSender = {
  readonly type: CompletionCallbackType;
  deliver(callback: CompletionCallback, payload: CompletionCallbackPayload): Promise<void>;
};

export type CallbackDispatcherOptions = {
  now?: () => Date;
  batchSize?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
};

export class CallbackService {
  constructor(
    private readonly store: AppStore,
    private readonly events?: EventService,
  ) {}

  async enqueueCompletion(input: { claimed: ClaimedMessage; result: RunnerResult }): Promise<CallbackDeliveryRecord | null> {
    const callback = getCompletionCallback(input.claimed.message.context);
    if (!callback) return null;

    const now = new Date();
    const payload: CompletionCallbackPayload = {
      event: 'message_completed',
      sessionId: input.claimed.message.sessionId,
      runId: input.claimed.run.id,
      messageId: input.claimed.message.id,
      text: input.result.text,
      artifacts: input.result.artifacts ?? [],
    };
    const delivery = await this.store.createCallbackDelivery({
      id: randomUUID(),
      sessionId: input.claimed.message.sessionId,
      runId: input.claimed.run.id,
      messageId: input.claimed.message.id,
      targetType: callback.type,
      target: callback.target,
      eventType: 'message_completed',
      payload,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
    return delivery;
  }

  async list(input: { sessionId: string; messageId?: string }): Promise<CallbackDeliveryRecord[]> {
    return this.store.listCallbackDeliveries(input);
  }

  async requestReplay(input: { sessionId: string; deliveryId: string }): Promise<CallbackDeliveryRecord> {
    const requestedAt = new Date();
    const delivery = await this.store.requestCallbackReplay({ sessionId: input.sessionId, deliveryId: input.deliveryId, requestedAt });
    if (!delivery) throw new CallbackServiceError('conflict', 'Callback delivery is not failed or does not exist for this session');
    await this.events?.append({
      sessionId: delivery.sessionId,
      ...(delivery.runId ? { runId: delivery.runId } : {}),
      ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
      type: 'callback_replay_requested',
      payload: { deliveryId: delivery.id, targetType: delivery.targetType, attempts: delivery.attempts },
    });
    return delivery;
  }
}

export class CallbackServiceError extends Error {
  constructor(
    readonly code: 'conflict',
    message: string,
  ) {
    super(message);
  }
}

export class CallbackDispatcher {
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;

  constructor(
    private readonly store: AppStore,
    private readonly events: EventService,
    private readonly senders: CompletionCallbackSender[] = [new HttpCompletionCallbackSender()],
    options: CallbackDispatcherOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? 10;
    this.baseDelayMs = options.baseDelayMs ?? 30_000;
    this.maxDelayMs = options.maxDelayMs ?? 30 * 60_000;
    this.jitterRatio = options.jitterRatio ?? 0.2;
  }

  async dispatchDue(): Promise<number> {
    const deliveries = await this.store.claimDueCallbackDeliveries({ now: this.now(), limit: this.batchSize });
    for (const delivery of deliveries) await this.dispatch(delivery);
    return deliveries.length;
  }

  private async dispatch(delivery: CallbackDeliveryRecord): Promise<void> {
    const callback = { type: delivery.targetType, target: delivery.target } satisfies CompletionCallback;
    const sender = this.senders.find((candidate) => candidate.type === callback.type);
    try {
      if (!sender) throw new Error(`No callback sender configured for target type: ${callback.type}`);
      await sender.deliver(callback, delivery.payload as CompletionCallbackPayload);
      const sent = await this.store.markCallbackDeliverySent({ id: delivery.id, deliveredAt: this.now() });
      await this.events.append({
        sessionId: sent.sessionId,
        ...(sent.runId ? { runId: sent.runId } : {}),
        ...(sent.messageId ? { messageId: sent.messageId } : {}),
        type: 'callback_sent',
        payload: { deliveryId: sent.id, targetType: sent.targetType, attempts: sent.attempts },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown callback error';
      const terminal = delivery.attempts >= delivery.maxAttempts;
      const failed = await this.store.markCallbackDeliveryFailed({
        id: delivery.id,
        failedAt: this.now(),
        error: message,
        terminal,
        ...(terminal ? {} : { nextAttemptAt: this.nextAttemptAt(delivery.attempts) }),
      });
      await this.events.append({
        sessionId: failed.sessionId,
        ...(failed.runId ? { runId: failed.runId } : {}),
        ...(failed.messageId ? { messageId: failed.messageId } : {}),
        type: terminal ? 'callback_failed' : 'callback_retry_scheduled',
        payload: {
          deliveryId: failed.id,
          error: message,
          targetType: failed.targetType,
          attempts: failed.attempts,
          ...(failed.nextAttemptAt ? { nextAttemptAt: failed.nextAttemptAt.toISOString() } : {}),
        },
      });
    }
  }

  private nextAttemptAt(attempts: number): Date {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempts - 1));
    const jitter = this.jitterRatio > 0 ? exponential * this.jitterRatio * Math.random() : 0;
    return new Date(this.now().getTime() + exponential + jitter);
  }
}

export class HttpCompletionCallbackSender implements CompletionCallbackSender {
  readonly type = 'http';

  async deliver(callback: CompletionCallback, payload: CompletionCallbackPayload): Promise<void> {
    const url = callback.target.url;
    if (typeof url !== 'string' || !url) throw new Error('HTTP callback target is missing url');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP callback returned ${response.status}`);
  }
}

function getCompletionCallback(context: Record<string, unknown> | undefined): CompletionCallback | null {
  const callback = context?.callback;
  if (!callback || typeof callback !== 'object' || Array.isArray(callback)) return null;
  const type = 'type' in callback ? callback.type : undefined;
  const url = 'url' in callback ? callback.url : undefined;
  if (type === 'http' && typeof url === 'string' && url) return { type: 'http', target: { url } };
  const channel = 'channel' in callback ? callback.channel : undefined;
  const threadTs = 'threadTs' in callback ? callback.threadTs : undefined;
  if (type === 'slack' && typeof channel === 'string' && channel && typeof threadTs === 'string' && threadTs) {
    const target: Record<string, unknown> = { channel, threadTs };
    const messageTs = 'messageTs' in callback ? callback.messageTs : undefined;
    if (typeof messageTs === 'string' && messageTs) target.messageTs = messageTs;
    return { type: 'slack', target };
  }
  const owner = 'owner' in callback ? callback.owner : undefined;
  const repo = 'repo' in callback ? callback.repo : undefined;
  const issueNumber = 'issueNumber' in callback ? callback.issueNumber : undefined;
  if (type === 'github' && typeof owner === 'string' && owner && typeof repo === 'string' && repo && typeof issueNumber === 'number' && Number.isInteger(issueNumber) && issueNumber > 0) {
    return { type: 'github', target: { owner, repo, issueNumber } };
  }
  return null;
}
