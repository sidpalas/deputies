export type SlackReplyClient = {
  postThreadReply(input: { channel: string; threadTs: string; text: string }): Promise<{ ok: boolean; ts?: string; error?: string }>;
};

export type SlackReactionClient = {
  addReaction(input: { channel: string; timestamp: string; name: string }): Promise<{ ok: boolean; error?: string }>;
};

export class SlackClient implements SlackReplyClient, SlackReactionClient {
  constructor(
    private readonly options: { apiBaseUrl: string; botToken?: string },
  ) {}

  async postThreadReply(input: { channel: string; threadTs: string; text: string }): Promise<{ ok: boolean; ts?: string; error?: string }> {
    if (!this.options.botToken) throw new Error('SLACK_BOT_TOKEN is required to post Slack replies');
    const response = await fetch(`${this.options.apiBaseUrl.replace(/\/$/, '')}/chat.postMessage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.botToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ channel: input.channel, thread_ts: input.threadTs, text: input.text }),
    });
    return (await response.json()) as { ok: boolean; ts?: string; error?: string };
  }

  async addReaction(input: { channel: string; timestamp: string; name: string }): Promise<{ ok: boolean; error?: string }> {
    if (!this.options.botToken) throw new Error('SLACK_BOT_TOKEN is required to add Slack reactions');
    const response = await fetch(`${this.options.apiBaseUrl.replace(/\/$/, '')}/reactions.add`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.botToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ channel: input.channel, timestamp: input.timestamp, name: input.name }),
    });
    return (await response.json()) as { ok: boolean; error?: string };
  }
}
