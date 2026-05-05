import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import type { RunnerResult } from '../runner/types.js';
import type { AppStore, CallbackDeliveryRecord, ClaimedMessage } from '../store/types.js';

export class CallbackService {
  constructor(
    private readonly store: AppStore,
    private readonly events: EventService,
  ) {}

  async deliverCompletion(input: { claimed: ClaimedMessage; result: RunnerResult }): Promise<CallbackDeliveryRecord | null> {
    const callback = getHttpCallback(input.claimed.message.context);
    if (!callback) return null;

    const now = new Date();
    const payload = {
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
      targetType: 'http',
      target: { url: callback.url },
      eventType: 'message_completed',
      payload,
      createdAt: now,
      updatedAt: now,
    });

    try {
      const response = await fetch(callback.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP callback returned ${response.status}`);
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
}

function getHttpCallback(context: Record<string, unknown> | undefined): { url: string } | null {
  const callback = context?.callback;
  if (!callback || typeof callback !== 'object' || Array.isArray(callback)) return null;
  const type = 'type' in callback ? callback.type : undefined;
  const url = 'url' in callback ? callback.url : undefined;
  if (type === 'http' && typeof url === 'string' && url) return { url };
  return null;
}
