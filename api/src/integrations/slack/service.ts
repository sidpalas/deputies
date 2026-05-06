import { randomUUID } from 'node:crypto';
import type { MessageService } from '../../messages/service.js';
import type { SessionService } from '../../sessions/service.js';
import type { AppStore, MessageRecord, SessionRecord } from '../../store/types.js';
import type { SlackReactionClient } from './client.js';
import { renderSlackPrompt, slackSessionTitle } from './prompts.js';
import type { SlackAcceptedEvent, SlackEventEnvelope } from './types.js';

export type SlackIntegrationOptions = {
  reactionClient?: SlackReactionClient;
  receivedReactionName?: string;
};

export type HandleSlackEventResult =
  | { ok: true; type: 'challenge'; challenge: string }
  | { ok: true; type: 'ignored'; reason: string }
  | { ok: true; type: 'duplicate' }
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

    const delivery = await this.store.createIntegrationDelivery({
      id: randomUUID(),
      source: 'slack',
      dedupeKey: accepted.eventId,
      receivedAt: new Date(),
      metadata: { teamId: accepted.teamId, channel: accepted.channel, threadTs: accepted.threadTs, eventType: accepted.type },
    });
    if (!delivery) return { ok: true, type: 'duplicate' };

    await this.addReceivedReaction(accepted);

    const threadId = slackExternalThreadId(accepted);
    const session = await this.getOrCreateSession(threadId, accepted);
    const message = await this.messages.enqueue({
      sessionId: session.id,
      prompt: renderSlackPrompt(accepted),
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
        },
        callback: { type: 'slack', channel: accepted.channel, threadTs: accepted.threadTs },
      },
    });

    await this.store.markIntegrationDeliveryProcessed({ source: 'slack', dedupeKey: accepted.eventId, processedAt: new Date() });
    return { ok: true, type: 'accepted', session, message };
  }

  private async addReceivedReaction(event: SlackAcceptedEvent): Promise<void> {
    if (!this.options.reactionClient) return;
    try {
      const response = await this.options.reactionClient.addReaction({
        channel: event.channel,
        timestamp: event.ts,
        name: this.options.receivedReactionName ?? 'eyes',
      });
      if (!response.ok && response.error !== 'already_reacted') {
        console.warn(`Slack reaction failed: ${response.error ?? 'unknown_error'}`);
      }
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
    }
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
    const existingThread = await this.store.getExternalThread('slack', threadId);
    if (existingThread) {
      const session = await this.sessions.get(existingThread.sessionId);
      if (session) return session;
    }

    const session = await this.sessions.create({ title: slackSessionTitle(event) });
    await this.store.createExternalThread({
      id: randomUUID(),
      source: 'slack',
      externalId: threadId,
      sessionId: session.id,
      metadata: { teamId: event.teamId, channel: event.channel, threadTs: event.threadTs },
      now: new Date(),
    });
    return session;
  }
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
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

function requiredString(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new SlackIntegrationError('invalid_request', 'Expected Slack event fields');
}
