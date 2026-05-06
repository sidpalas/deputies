export type SlackReplyClient = {
  postThreadReply(input: { channel: string; threadTs: string; text: string }): Promise<{ ok: boolean; ts?: string; error?: string }>;
};

export type SlackReactionClient = {
  addReaction(input: { channel: string; timestamp: string; name: string }): Promise<{ ok: boolean; error?: string }>;
};

export type SlackThreadClient = {
  getThreadReplies(input: { channel: string; threadTs: string }): Promise<{ ok: boolean; messages?: Array<{ user?: string; text?: string; ts?: string; bot_id?: string }>; error?: string }>;
};

export type SlackInfoClient = {
  getChannelInfo(input: { channel: string }): Promise<{ ok: boolean; channel?: { id: string; name?: string; is_channel?: boolean; is_group?: boolean }; error?: string }>;
  getUserInfo(input: { user: string }): Promise<{ ok: boolean; user?: { id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }; error?: string }>;
};

export class SlackClient implements SlackReplyClient, SlackReactionClient, SlackThreadClient, SlackInfoClient {
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

  async getThreadReplies(input: { channel: string; threadTs: string }): Promise<{ ok: boolean; messages?: Array<{ user?: string; text?: string; ts?: string; bot_id?: string }>; error?: string }> {
    if (!this.options.botToken) throw new Error('SLACK_BOT_TOKEN is required to fetch Slack thread replies');
    const url = new URL(`${this.options.apiBaseUrl.replace(/\/$/, '')}/conversations.replies`);
    url.searchParams.set('channel', input.channel);
    url.searchParams.set('ts', input.threadTs);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.options.botToken}`,
      },
    });
    return (await response.json()) as { ok: boolean; messages?: Array<{ user?: string; text?: string; ts?: string; bot_id?: string }>; error?: string };
  }

  async getChannelInfo(input: { channel: string }): Promise<{ ok: boolean; channel?: { id: string; name?: string; is_channel?: boolean; is_group?: boolean }; error?: string }> {
    if (!this.options.botToken) throw new Error('SLACK_BOT_TOKEN is required to fetch Slack channel info');
    const url = new URL(`${this.options.apiBaseUrl.replace(/\/$/, '')}/conversations.info`);
    url.searchParams.set('channel', input.channel);
    const response = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${this.options.botToken}` } });
    return (await response.json()) as { ok: boolean; channel?: { id: string; name?: string; is_channel?: boolean; is_group?: boolean }; error?: string };
  }

  async getUserInfo(input: { user: string }): Promise<{ ok: boolean; user?: { id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }; error?: string }> {
    if (!this.options.botToken) throw new Error('SLACK_BOT_TOKEN is required to fetch Slack user info');
    const url = new URL(`${this.options.apiBaseUrl.replace(/\/$/, '')}/users.info`);
    url.searchParams.set('user', input.user);
    const response = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${this.options.botToken}` } });
    return (await response.json()) as { ok: boolean; user?: { id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }; error?: string };
  }
}
