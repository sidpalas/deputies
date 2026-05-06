export type SlackEventEnvelope = {
  type: string;
  token?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackInnerEvent;
};

export type SlackInnerEvent = {
  type: string;
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  channel_type?: string;
};

export type SlackAcceptedEvent = {
  teamId: string;
  eventId: string;
  type: 'app_mention' | 'message';
  text: string;
  user: string;
  channel: string;
  ts: string;
  threadTs: string;
  raw: SlackInnerEvent;
};

export type SlackThreadMessage = {
  user?: string;
  username?: string;
  text: string;
  ts: string;
  botId?: string;
};

export type SlackPromptMetadata = {
  channelName?: string;
  actorName?: string;
};
