import type { SlackAcceptedEvent, SlackPromptMetadata, SlackThreadMessage } from './types.js';

export type SlackThreadContext = {
  messages: SlackThreadMessage[];
  unavailableReason?: string;
};

export type SlackPromptOptions = {
  includeChannelContext?: boolean;
};

export function renderSlackPrompt(event: SlackAcceptedEvent, threadContext: SlackThreadContext = { messages: [] }, metadata: SlackPromptMetadata = {}, options: SlackPromptOptions = {}): string {
  const parts: string[] = [];
  if (options.includeChannelContext && metadata.channelName) {
    parts.push('Slack channel context:', '---');
    if (metadata.channelName) parts.push(`Channel: #${metadata.channelName}`);
    parts.push('---', '');
  } else if (metadata.channelName) {
    parts.push(`Slack thread: #${metadata.channelName}`, '');
  }

  if (threadContext.messages.length) {
    parts.push('Prior unprocessed messages from the Slack thread:', '---');
    parts.push(...threadContext.messages.map((message) => `[${message.username ?? 'user'}]: ${message.text}`));
    parts.push('---', '');
  } else if (threadContext.unavailableReason) {
    parts.push('Prior unprocessed messages from the Slack thread:', '---');
    parts.push(`Prior Slack thread messages were unavailable: ${threadContext.unavailableReason}.`);
    parts.push('---', '');
  }

  parts.push('Current tagged Slack message:', '---');
  parts.push(`[${metadata.actorName ?? 'user'}]: ${event.text}`);

  return parts.join('\n');
}

export function slackSessionTitle(event: SlackAcceptedEvent): string {
  const normalized = event.text.replace(/\s+/g, ' ').trim();
  const suffix = normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
  return suffix ? `Slack: ${suffix}` : `Slack: ${event.channel}`;
}
