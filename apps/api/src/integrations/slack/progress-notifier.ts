import type { RunProgressNotifier } from '../../worker/service.js';
import type { SlackReactionClient } from './client.js';

export class SlackRunProgressNotifier implements RunProgressNotifier {
  constructor(private readonly client: SlackReactionClient) {}

  async onRunStarted(input: Parameters<NonNullable<RunProgressNotifier['onRunStarted']>>[0]): Promise<void> {
    const callback = input.message.context?.callback;
    if (!callback || typeof callback !== 'object' || Array.isArray(callback)) return;
    const type = 'type' in callback ? callback.type : undefined;
    const channel = 'channel' in callback ? callback.channel : undefined;
    const messageTs = 'messageTs' in callback ? callback.messageTs : undefined;
    if (type !== 'slack' || typeof channel !== 'string' || !channel || typeof messageTs !== 'string' || !messageTs) return;

    const response = await this.client.addReaction({ channel, timestamp: messageTs, name: 'hourglass_flowing_sand' });
    if (!response.ok && response.error !== 'already_reacted') throw new Error(`Slack progress reaction failed${response.error ? `: ${response.error}` : ''}`);
  }
}
