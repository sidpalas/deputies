import type { CompletionCallback, CompletionCallbackPayload, CompletionCallbackSender } from '../../callbacks/service.js';
import type { SlackReplyClient } from './client.js';

export class SlackCompletionCallbackSender implements CompletionCallbackSender {
  readonly type = 'slack';

  constructor(private readonly client: SlackReplyClient) {}

  async deliver(callback: CompletionCallback, payload: CompletionCallbackPayload): Promise<void> {
    const channel = callback.target.channel;
    const threadTs = callback.target.threadTs;
    if (typeof channel !== 'string' || !channel || typeof threadTs !== 'string' || !threadTs) {
      throw new Error('Slack callback target is missing channel or threadTs');
    }
    const response = await this.client.postThreadReply({
      channel,
      threadTs,
      text: payload.text.trim() || 'Completed.',
    });
    if (!response.ok) throw new Error(`Slack callback failed${response.error ? `: ${response.error}` : ''}`);
  }
}
