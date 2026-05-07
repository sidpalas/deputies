export type SlackCallbackTargetInput = {
  channel: string;
  threadTs: string;
  messageTs: string;
};

export function slackCallbackTarget(input: SlackCallbackTargetInput): Record<string, unknown> {
  return { type: 'slack', channel: input.channel, threadTs: input.threadTs, messageTs: input.messageTs };
}
