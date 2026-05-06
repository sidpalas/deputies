import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import type { RunnerResult } from '../runner/types.js';
import type { AppStore, CallbackDeliveryRecord, ClaimedMessage } from '../store/types.js';

export type CompletionCallbackType = 'http' | 'slack';

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

export class CallbackService {
  constructor(
    private readonly store: AppStore,
    private readonly events: EventService,
    private readonly senders: CompletionCallbackSender[] = [new HttpCompletionCallbackSender()],
  ) {}

  async deliverCompletion(input: { claimed: ClaimedMessage; result: RunnerResult }): Promise<CallbackDeliveryRecord | null> {
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
    });

    try {
      await this.deliver(callback, payload);
      const sent = await this.store.markCallbackDeliverySent({ id: delivery.id, deliveredAt: new Date() });
      await this.events.append({
        sessionId: input.claimed.message.sessionId,
        runId: input.claimed.run.id,
        messageId: input.claimed.message.id,
        type: 'callback_sent',
        payload: { deliveryId: sent.id, targetType: sent.targetType },
      });
      return sent;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown callback error';
      const failed = await this.store.markCallbackDeliveryFailed({ id: delivery.id, failedAt: new Date(), error: message });
      await this.events.append({
        sessionId: input.claimed.message.sessionId,
        runId: input.claimed.run.id,
        messageId: input.claimed.message.id,
        type: 'callback_failed',
        payload: { deliveryId: failed.id, error: message, targetType: failed.targetType },
      });
      return failed;
    }
  }

  private async deliver(callback: CompletionCallback, payload: CompletionCallbackPayload): Promise<void> {
    const sender = this.senders.find((candidate) => candidate.type === callback.type);
    if (!sender) throw new Error(`No callback sender configured for target type: ${callback.type}`);
    await sender.deliver(callback, payload);
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
    return { type: 'slack', target: { channel, threadTs } };
  }
  return null;
}
