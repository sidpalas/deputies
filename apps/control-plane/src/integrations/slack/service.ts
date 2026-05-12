import type { MessageService } from '../../messages/service.js';
import type { SessionService } from '../../sessions/service.js';
import type { AppStore, MessageRecord, SessionRecord } from '../../store/types.js';
import {
  archivedIgnoredTranscriptPrompt,
  archivedRecoveryTranscriptPrompt,
  archivedRecoveryWorkPrompt,
  archivedSessionNotice,
  archivedSessionRecoveredNotice,
  includesArchivedSessionRecoveryPhrase,
  isArchivedSessionRecoveryOnly,
  unprocessedArchivedTranscriptMessages,
} from '../archive.js';
import { boundPriorContext } from '../prompt-bounds.js';
import {
  getOrCreateExternalThreadSession,
  markIntegrationDeliveryFailed,
  markIntegrationDeliveryProcessed,
  receiveIntegrationDelivery,
} from '../shared-utils.js';
import { slackCallbackTarget } from './callback-target.js';
import type { SlackAssistantThreadClient, SlackInfoClient, SlackReplyClient, SlackThreadClient } from './client.js';
import { renderSlackPrompt, slackSessionTitle, type SlackThreadContext } from './prompts.js';
import type { SlackAcceptedEvent, SlackEventEnvelope, SlackPromptMetadata, SlackThreadMessage } from './types.js';

export type SlackIntegrationOptions = {
  assistantThreadClient?: SlackAssistantThreadClient;
  replyClient?: SlackReplyClient;
  threadClient?: SlackThreadClient;
  infoClient?: SlackInfoClient;
  allowedTeamIds?: string[];
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  webBaseUrl?: string;
};

export type HandleSlackEventResult =
  | { ok: true; type: 'challenge'; challenge: string }
  | { ok: true; type: 'ignored'; reason: string }
  | { ok: true; type: 'duplicate' }
  | { ok: true; type: 'recovered'; session: SessionRecord }
  | { ok: true; type: 'accepted'; session: SessionRecord; message: MessageRecord };

export class SlackIntegrationService {
  constructor(
    private readonly store: AppStore,
    private readonly sessions: SessionService,
    private readonly messages: MessageService,
    private readonly options: SlackIntegrationOptions = {},
  ) {}

  async handle(payload: SlackEventEnvelope): Promise<HandleSlackEventResult> {
    if (payload.type === 'url_verification') {
      if (!payload.challenge) throw new SlackIntegrationError('invalid_request', 'Expected Slack challenge');
      return { ok: true, type: 'challenge', challenge: payload.challenge };
    }

    if (payload.type !== 'event_callback') return { ok: true, type: 'ignored', reason: 'unsupported_payload_type' };

    const accepted = this.parseAcceptedEvent(payload);
    if (!accepted) return { ok: true, type: 'ignored', reason: 'unsupported_event' };

    const received = await receiveIntegrationDelivery(this.store, {
      source: 'slack',
      dedupeKey: accepted.eventId,
      metadata: {
        teamId: accepted.teamId,
        channel: accepted.channel,
        threadTs: accepted.threadTs,
        eventType: accepted.type,
      },
    });
    if (!received) return { ok: true, type: 'duplicate' };

    const authorizationFailure = this.authorizationFailure(accepted);
    if (authorizationFailure) {
      await markIntegrationDeliveryFailed(this.store, {
        source: 'slack',
        dedupeKey: accepted.eventId,
        error: authorizationFailure,
      });
      return { ok: true, type: 'ignored', reason: authorizationFailure };
    }

    const threadId = slackExternalThreadId(accepted);
    if (accepted.type === 'message' && !(await this.store.getExternalThread('slack', threadId))) {
      await markIntegrationDeliveryFailed(this.store, {
        source: 'slack',
        dedupeKey: accepted.eventId,
        error: 'unmapped_thread',
      });
      return { ok: true, type: 'ignored', reason: 'unmapped_thread' };
    }
    let session = await this.getOrCreateSession(threadId, accepted);
    if (session.status === 'archived') {
      if (includesArchivedSessionRecoveryPhrase(accepted.text)) {
        session = await this.sessions.unarchive(session.id);
        const archivedMessages = unprocessedArchivedTranscriptMessages(
          await this.store.getMessages(session.id),
          'slack',
        );
        if (archivedMessages.length) {
          const message = await this.enqueueArchivedRecoveryWork(session, accepted, archivedMessages);
          await markIntegrationDeliveryProcessed(this.store, { source: 'slack', dedupeKey: accepted.eventId });
          return { ok: true, type: 'accepted', session, message };
        }
        if (isArchivedSessionRecoveryOnly(accepted.text)) {
          await this.recordRecoveryTranscriptEntries(session.id, accepted);
          await markIntegrationDeliveryProcessed(this.store, { source: 'slack', dedupeKey: accepted.eventId });
          await this.postRecoveryAcknowledgement(accepted);
          return { ok: true, type: 'recovered', session };
        }
      } else {
        await this.recordArchivedTranscriptEntries(session.id, accepted);
        await markIntegrationDeliveryProcessed(this.store, { source: 'slack', dedupeKey: accepted.eventId });
        await this.postArchivedSessionNotice(accepted);
        return { ok: true, type: 'ignored', reason: 'session_archived' };
      }
    }

    const existingMessageCount = (await this.store.getMessages(session.id)).length;
    if (existingMessageCount === 0) await this.postSessionLink(accepted, session.id);

    await this.setThreadStatus(accepted, 'Queued your request...');
    const threadContext =
      accepted.type === 'app_mention' ? await this.fetchThreadContext(session, accepted) : { messages: [] };
    const promptThreadContext = { ...threadContext, messages: boundPriorContext(threadContext.messages) };
    const promptMetadata = await this.fetchPromptMetadata(accepted, promptThreadContext.messages);
    const includeChannelContext = existingMessageCount === 0;

    const message = await this.messages.enqueue({
      sessionId: session.id,
      prompt: renderSlackPrompt(accepted, promptThreadContext, promptMetadata, { includeChannelContext }),
      source: 'slack',
      context: {
        source: 'slack',
        slack: {
          teamId: accepted.teamId,
          channel: accepted.channel,
          user: accepted.user,
          ts: accepted.ts,
          threadTs: accepted.threadTs,
          eventId: accepted.eventId,
          type: accepted.type,
          includedThreadTs: promptThreadContext.messages.map((message) => message.ts),
        },
        callback: slackCallbackTarget({
          channel: accepted.channel,
          threadTs: accepted.threadTs,
          messageTs: accepted.ts,
          ...callbackSessionUrl(session.id, this.options.webBaseUrl),
        }),
      },
    });

    await markIntegrationDeliveryProcessed(this.store, { source: 'slack', dedupeKey: accepted.eventId });
    return { ok: true, type: 'accepted', session, message };
  }

  private async setThreadStatus(event: SlackAcceptedEvent, status: string): Promise<void> {
    if (!this.options.assistantThreadClient) return;
    try {
      const response = await this.options.assistantThreadClient.setThreadStatus({
        channel: event.channel,
        threadTs: event.threadTs,
        status,
      });
      if (!response.ok) {
        console.warn(`Slack assistant thread status failed: ${response.error ?? 'unknown_error'}`);
      }
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
    }
  }

  private async postArchivedSessionNotice(event: SlackAcceptedEvent): Promise<void> {
    if (!this.options.replyClient) return;
    try {
      const response = await this.options.replyClient.postThreadReply({
        channel: event.channel,
        threadTs: event.threadTs,
        text: archivedSessionNotice(),
      });
      if (!response.ok) console.warn(`Slack archived-session notice failed: ${response.error ?? 'unknown_error'}`);
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
    }
  }

  private async postRecoveryAcknowledgement(event: SlackAcceptedEvent): Promise<void> {
    if (!this.options.replyClient) return;
    try {
      const response = await this.options.replyClient.postThreadReply({
        channel: event.channel,
        threadTs: event.threadTs,
        text: archivedSessionRecoveredNotice(),
      });
      if (!response.ok) console.warn(`Slack recovery acknowledgement failed: ${response.error ?? 'unknown_error'}`);
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
    }
  }

  private async postSessionLink(event: SlackAcceptedEvent, sessionId: string): Promise<void> {
    if (!this.options.replyClient) return;
    const sessionUrl = callbackSessionUrl(sessionId, this.options.webBaseUrl).sessionUrl;
    if (!sessionUrl) return;
    const text = `:incoming_envelope: Your Deputy will reply when it has finished processing.

:link: You can follow along on the web here: ${sessionUrl}

:speech_balloon: You can also continue the session here with follow-up messages. Make sure to tag @deputies in your messages.`;
    try {
      const response = await this.options.replyClient.postThreadReply({
        channel: event.channel,
        threadTs: event.threadTs,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      });
      if (!response.ok) console.warn(`Slack session-link reply failed: ${response.error ?? 'unknown_error'}`);
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
    }
  }

  private async recordArchivedTranscriptEntries(sessionId: string, event: SlackAcceptedEvent): Promise<void> {
    await this.messages.recordTranscriptEntry({
      sessionId,
      prompt: archivedIgnoredTranscriptPrompt(event.text),
      source: 'slack',
      context: {
        source: 'slack',
        transcriptOnly: true,
        slack: {
          teamId: event.teamId,
          channel: event.channel,
          user: event.user,
          ts: event.ts,
          threadTs: event.threadTs,
          eventId: event.eventId,
          type: event.type,
        },
      },
    });
    await this.messages.recordTranscriptEntry({
      sessionId,
      prompt: archivedSessionNotice(),
      source: 'slack_notice',
      context: { source: 'slack', transcriptOnly: true, notice: { type: 'archived_session' } },
    });
  }

  private async recordRecoveryTranscriptEntries(sessionId: string, event: SlackAcceptedEvent): Promise<void> {
    await this.messages.recordTranscriptEntry({
      sessionId,
      prompt: archivedRecoveryTranscriptPrompt(event.text),
      source: 'slack',
      context: {
        source: 'slack',
        transcriptOnly: true,
        slack: {
          teamId: event.teamId,
          channel: event.channel,
          user: event.user,
          ts: event.ts,
          threadTs: event.threadTs,
          eventId: event.eventId,
          type: event.type,
        },
      },
    });
    await this.messages.recordTranscriptEntry({
      sessionId,
      prompt: archivedSessionRecoveredNotice(),
      source: 'slack_notice',
      context: { source: 'slack', transcriptOnly: true, notice: { type: 'session_recovered' } },
    });
  }

  private async enqueueArchivedRecoveryWork(
    session: SessionRecord,
    event: SlackAcceptedEvent,
    archivedMessages: MessageRecord[],
  ): Promise<MessageRecord> {
    return this.messages.enqueue({
      sessionId: session.id,
      prompt: archivedRecoveryWorkPrompt({ sourceLabel: 'Slack', archivedMessages, recoveryText: event.text }),
      source: 'slack',
      context: {
        source: 'slack',
        includedArchivedMessageIds: archivedMessages.map((message) => message.id),
        slack: {
          teamId: event.teamId,
          channel: event.channel,
          user: event.user,
          ts: event.ts,
          threadTs: event.threadTs,
          eventId: event.eventId,
          type: event.type,
          includedThreadTs: [],
        },
        callback: slackCallbackTarget({
          channel: event.channel,
          threadTs: event.threadTs,
          messageTs: event.ts,
          ...callbackSessionUrl(session.id, this.options.webBaseUrl),
        }),
      },
    });
  }

  private async fetchThreadContext(session: SessionRecord, event: SlackAcceptedEvent): Promise<SlackThreadContext> {
    if (!this.options.threadClient)
      return { messages: [], unavailableReason: 'Slack thread history client is not configured' };
    try {
      const response = await this.options.threadClient.getThreadReplies({
        channel: event.channel,
        threadTs: event.threadTs,
      });
      if (!response.ok) {
        console.warn(`Slack thread context fetch failed: ${response.error ?? 'unknown_error'}`);
        return { messages: [], unavailableReason: response.error ?? 'unknown_error' };
      }

      const processedSlackTimestamps = await this.processedSlackTimestamps(session.id);
      const messages = (response.messages ?? [])
        .map(toThreadMessage)
        .filter((message): message is SlackThreadMessage => Boolean(message))
        .filter((message) => message.ts !== event.ts)
        .filter((message) => !processedSlackTimestamps.has(message.ts))
        .filter((message) => slackTimestampLessThanOrEqual(message.ts, event.ts));
      return { messages };
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
      return { messages: [], unavailableReason: error instanceof Error ? error.message : 'unknown_error' };
    }
  }

  private async fetchPromptMetadata(
    event: SlackAcceptedEvent,
    threadMessages: SlackThreadMessage[],
  ): Promise<SlackPromptMetadata> {
    if (!this.options.infoClient) return {};
    const metadata: SlackPromptMetadata = {};

    try {
      const channel = await this.options.infoClient.getChannelInfo({ channel: event.channel });
      if (channel.ok && channel.channel?.name) metadata.channelName = channel.channel.name;
      else if (!channel.ok) console.warn(`Slack channel info fetch failed: ${channel.error ?? 'unknown_error'}`);
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
    }

    const userIds = new Set([
      event.user,
      ...threadMessages.map((message) => message.user).filter((user): user is string => Boolean(user)),
    ]);
    const userNames = new Map<string, string>();
    for (const userId of userIds) {
      try {
        const user = await this.options.infoClient.getUserInfo({ user: userId });
        const name = user.ok && user.user ? displayNameForUser(user.user) : '';
        if (name) userNames.set(userId, name);
        else if (!user.ok) console.warn(`Slack user info fetch failed: ${user.error ?? 'unknown_error'}`);
      } catch (error) {
        console.warn(error instanceof Error ? error.message : error);
      }
    }

    const actorName = userNames.get(event.user);
    if (actorName) metadata.actorName = actorName;
    for (const message of threadMessages) {
      const username = message.user ? userNames.get(message.user) : undefined;
      if (username) message.username = username;
    }
    return metadata;
  }

  private async processedSlackTimestamps(sessionId: string): Promise<Set<string>> {
    const messages = await this.store.getMessages(sessionId);
    return new Set(messages.flatMap(slackTimestampsFromMessage));
  }

  private authorizationFailure(event: SlackAcceptedEvent): string | null {
    if (!isAllowed(event.teamId, this.options.allowedTeamIds)) return 'unauthorized_team';
    if (!isAllowed(event.channel, this.options.allowedChannelIds)) return 'unauthorized_channel';
    if (!isAllowed(event.user, this.options.allowedUserIds)) return 'unauthorized_user';
    return null;
  }

  private parseAcceptedEvent(payload: SlackEventEnvelope): SlackAcceptedEvent | null {
    const event = payload.event;
    if (!event || event.bot_id || event.subtype === 'bot_message') return null;
    if (event.type !== 'app_mention' && event.type !== 'message') return null;
    const teamId = requiredString(payload.team_id);
    const eventId = requiredString(payload.event_id);
    const text = cleanSlackText(requiredString(event.text));
    const user = requiredString(event.user);
    const channel = requiredString(event.channel);
    const ts = requiredString(event.ts);
    const threadTs = event.thread_ts && event.thread_ts.trim() ? event.thread_ts : ts;
    if (event.type === 'message' && threadTs === ts) return null;
    return { teamId, eventId, type: event.type, text, user, channel, ts, threadTs, raw: event };
  }

  private async getOrCreateSession(threadId: string, event: SlackAcceptedEvent): Promise<SessionRecord> {
    return getOrCreateExternalThreadSession(this.store, this.sessions, {
      source: 'slack',
      externalId: threadId,
      metadata: { teamId: event.teamId, channel: event.channel, threadTs: event.threadTs },
      title: slackSessionTitle(event),
    });
  }
}

function callbackSessionUrl(sessionId: string, webBaseUrl: string | undefined): { sessionUrl?: string } {
  if (!webBaseUrl) return {};
  const url = new URL(webBaseUrl);
  url.searchParams.set('session', sessionId);
  return { sessionUrl: url.toString() };
}

export class SlackIntegrationError extends Error {
  constructor(
    readonly code: 'invalid_request',
    message: string,
  ) {
    super(message);
  }
}

export function slackExternalThreadId(event: Pick<SlackAcceptedEvent, 'teamId' | 'channel' | 'threadTs'>): string {
  return `${event.teamId}:${event.channel}:${event.threadTs}`;
}

function cleanSlackText(text: string): string {
  return decodeSlackText(text.replace(/<@[A-Z0-9]+>/g, '')).trim();
}

function decodeSlackText(text: string): string {
  return text.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function requiredString(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new SlackIntegrationError('invalid_request', 'Expected Slack event fields');
}

function isAllowed(value: string, allowedValues: string[] | undefined): boolean {
  return !allowedValues?.length || allowedValues.includes(value);
}

function toThreadMessage(message: {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
}): SlackThreadMessage | null {
  if (message.bot_id || !message.text || !message.ts) return null;
  const text = cleanSlackText(message.text);
  if (!text) return null;
  return { text, ts: message.ts, ...(message.user ? { user: message.user } : {}) };
}

function slackTimestampsFromMessage(message: MessageRecord): string[] {
  const slack = message.context?.slack;
  if (!slack || typeof slack !== 'object' || Array.isArray(slack)) return [];
  const timestamps: string[] = [];
  const ts = 'ts' in slack ? slack.ts : undefined;
  if (typeof ts === 'string' && ts) timestamps.push(ts);
  const includedThreadTs = 'includedThreadTs' in slack ? slack.includedThreadTs : undefined;
  if (Array.isArray(includedThreadTs)) {
    timestamps.push(
      ...includedThreadTs.filter(
        (timestamp): timestamp is string => typeof timestamp === 'string' && Boolean(timestamp),
      ),
    );
  }
  return timestamps;
}

function slackTimestampLessThanOrEqual(left: string, right: string): boolean {
  return Number(left) <= Number(right);
}

function displayNameForUser(user: {
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}): string {
  return user.profile?.display_name || user.profile?.real_name || user.real_name || user.name || '';
}
