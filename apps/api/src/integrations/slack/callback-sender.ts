import type { CompletionCallback, CompletionCallbackPayload, CompletionCallbackSender } from '../../callbacks/service.js';
import type { SlackBlock, SlackReactionClient, SlackReplyClient } from './client.js';

const maxSlackMrkdwnCharacters = 3000;

export class SlackCompletionCallbackSender implements CompletionCallbackSender {
  readonly type = 'slack';

  constructor(private readonly client: SlackReplyClient & Partial<SlackReactionClient>) {}

  async deliver(callback: CompletionCallback, payload: CompletionCallbackPayload): Promise<void> {
    const channel = callback.target.channel;
    const threadTs = callback.target.threadTs;
    if (typeof channel !== 'string' || !channel || typeof threadTs !== 'string' || !threadTs) {
      throw new Error('Slack callback target is missing channel or threadTs');
    }
    const text = payload.text.trim() || 'Completed.';
    const blocks = slackReplyBlocks(text, callback.target);
    const response = await this.client.postThreadReply({
      channel,
      threadTs,
      text: appendSlackFooter(text, callback.target),
      ...(blocks.length ? { blocks } : {}),
    });
    if (!response.ok) throw new Error(`Slack callback failed${response.error ? `: ${response.error}` : ''}`);
    const messageTs = callback.target.messageTs;
    if (typeof messageTs === 'string' && messageTs && this.client.addReaction) {
      const reaction = await this.client.addReaction({ channel, timestamp: messageTs, name: 'white_check_mark' });
      if (!reaction.ok && reaction.error !== 'already_reacted') throw new Error(`Slack completion reaction failed${reaction.error ? `: ${reaction.error}` : ''}`);
    }
  }
}

function slackReplyBlocks(text: string, target: Record<string, unknown>): SlackBlock[] {
  const footer = slackFooter(target);
  if (!footer.length) return [];

  const blocks: SlackBlock[] = splitMrkdwn(text).map((chunk) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: chunk },
  }));
  blocks.push({ type: 'divider' });
  if (target.includeSessionLink === true && typeof target.sessionUrl === 'string' && target.sessionUrl) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `Link to session: ${target.sessionUrl}` } });
  }
  const hint = typeof target.replyHint === 'string' && target.replyHint ? target.replyHint : undefined;
  if (hint) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:information_source: ${hint}` }] });
  }
  return blocks;
}

function appendSlackFooter(text: string, target: Record<string, unknown>): string {
  const footer = slackFooter(target);
  return footer.length ? `${text}\n\n${footer.join('\n')}` : text;
}

function slackFooter(target: Record<string, unknown>): string[] {
  const footer: string[] = [];
  if (target.includeSessionLink === true && typeof target.sessionUrl === 'string' && target.sessionUrl) {
    footer.push(`Link to session: ${target.sessionUrl}`);
  }
  if (typeof target.replyHint === 'string' && target.replyHint) {
    if (footer.length) footer.push('---');
    if (footer.length) footer.push('');
    footer.push(target.replyHint);
  }
  return footer;
}

function splitMrkdwn(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxSlackMrkdwnCharacters) {
    chunks.push(text.slice(index, index + maxSlackMrkdwnCharacters));
  }
  return chunks.length ? chunks : ['Completed.'];
}
