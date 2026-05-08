export type SlackCallbackTargetInput = {
  channel: string;
  threadTs: string;
  messageTs: string;
  sessionUrl?: string;
  includeSessionLink?: boolean;
};

export function slackCallbackTarget(input: SlackCallbackTargetInput): Record<string, unknown> {
  return {
    type: 'slack',
    channel: input.channel,
    threadTs: input.threadTs,
    messageTs: input.messageTs,
    replyHint: 'Tag @deputies in replies to continue here.',
    ...(input.sessionUrl ? { sessionUrl: input.sessionUrl } : {}),
    ...(input.includeSessionLink ? { includeSessionLink: true } : {}),
  };
}
