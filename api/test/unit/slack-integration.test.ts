import type { Server } from 'node:http';
import { createServer, createServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { createSlackSignature, verifySlackSignature } from '../../src/integrations/slack/auth.js';
import { SlackIntegrationService } from '../../src/integrations/slack/service.js';
import { MemoryStore } from '../../src/store/memory.js';

const signingSecret = 'dev-slack-signing-secret';
const botUserId = 'UDEVDEPUTY';

describe('Slack integration', () => {
  it('verifies Slack request signatures', () => {
    const body = JSON.stringify({ type: 'event_callback' });
    const timestamp = '1800000000';
    const signature = createSlackSignature({ body, timestamp, signingSecret });

    expect(verifySlackSignature({ signature, timestamp, body, signingSecret, nowSeconds: 1800000000 })).toBe(true);
    expect(verifySlackSignature({ signature: `${signature}0`, timestamp, body, signingSecret, nowSeconds: 1800000000 })).toBe(false);
    expect(verifySlackSignature({ signature, timestamp, body, signingSecret, nowSeconds: 1800001000 })).toBe(false);
  });

  it('creates sessions from app mentions and reuses Slack threads for follow-ups', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const reactions: Array<{ channel: string; timestamp: string; name: string }> = [];
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      reactionClient: {
        async addReaction(input) {
          reactions.push(input);
          return { ok: true };
        },
      },
    });

    const first = await slack.handle(slackEvent({
      eventId: 'Ev1',
      type: 'app_mention',
      text: `<@${botUserId}> please investigate repo:acme/widget`,
      ts: '1710000000.000100',
    }));
    const followUp = await slack.handle(slackEvent({
      eventId: 'Ev2',
      type: 'message',
      text: 'also check the failing test',
      ts: '1710000001.000100',
      threadTs: '1710000000.000100',
    }));

    expect(first.type).toBe('accepted');
    expect(followUp.type).toBe('accepted');
    if (first.type !== 'accepted' || followUp.type !== 'accepted') throw new Error('Expected accepted Slack events');
    expect(first.session.id).toBe(followUp.session.id);

    const messages = await services.messages.list(first.session.id);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.source)).toEqual(['slack', 'slack']);
    expect(messages[0]!.prompt).toContain('please investigate repo:acme/widget');
    expect(messages[0]!.prompt).not.toContain(`<@${botUserId}>`);
    expect(messages[0]!.prompt).toContain('Prior unprocessed messages from the Slack thread:');
    expect(messages[0]!.prompt).toContain('Prior Slack thread messages were unavailable: Slack thread history client is not configured.');
    expect(messages[0]!.prompt).toContain('Current tagged Slack message:');
    expect(messages[0]!.context?.callback).toEqual({ type: 'slack', channel: 'C123', threadTs: '1710000000.000100', messageTs: '1710000000.000100' });
    expect(reactions).toEqual([
      { channel: 'C123', timestamp: '1710000000.000100', name: 'eyes' },
      { channel: 'C123', timestamp: '1710000001.000100', name: 'eyes' },
    ]);
  });

  it('does not fail accepted Slack events when adding the received reaction fails', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      reactionClient: {
        async addReaction() {
          return { ok: false, error: 'missing_scope' };
        },
      },
    });

    const accepted = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000000.000100' }));

    expect(accepted.type).toBe('accepted');
  });

  it('decodes Slack text entities before enqueueing prompts', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages);

    const accepted = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> is a &gt; b &amp; c &lt; d?`, ts: '1710000000.000100' }));

    expect(accepted.type).toBe('accepted');
    if (accepted.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const messages = await services.messages.list(accepted.session.id);
    expect(messages[0]!.prompt).toContain('is a > b & c < d?');
  });

  it('includes prior unprocessed Slack thread messages as context on later mentions', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      threadClient: {
        async getThreadReplies() {
          return {
            ok: true,
            messages: [
              { user: 'U111', text: 'The failing test is in auth', ts: '1710000000.000100' },
              { user: 'U222', text: 'It started after the cookie change', ts: '1710000001.000100' },
              { user: 'U123', text: `<@${botUserId}> please investigate`, ts: '1710000002.000100' },
            ],
          };
        },
      },
    });

    const accepted = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> please investigate`, ts: '1710000002.000100', threadTs: '1710000000.000100' }));

    expect(accepted.type).toBe('accepted');
    if (accepted.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const messages = await services.messages.list(accepted.session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.prompt).toContain('Prior unprocessed messages from the Slack thread:');
    expect(messages[0]!.prompt).toContain('The failing test is in auth');
    expect(messages[0]!.prompt).toContain('It started after the cookie change');
    expect(messages[0]!.prompt).toContain('Current tagged Slack message:\n---\n[user]: please investigate');
  });

  it('omits prior Slack thread section when no new prior messages are found', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      threadClient: {
        async getThreadReplies() {
          return { ok: true, messages: [{ user: 'U123', text: `<@${botUserId}> please investigate`, ts: '1710000002.000100' }] };
        },
      },
    });

    const accepted = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> please investigate`, ts: '1710000002.000100', threadTs: '1710000000.000100' }));

    expect(accepted.type).toBe('accepted');
    if (accepted.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const messages = await services.messages.list(accepted.session.id);
    expect(messages[0]!.prompt).not.toContain('Prior unprocessed messages from the Slack thread:');
    expect(messages[0]!.prompt).not.toContain('No new prior Slack thread messages');
    expect(messages[0]!.prompt).toContain('Current tagged Slack message:\n---\n[user]: please investigate');
  });

  it('renders Slack channel and user names when lookup succeeds', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const userInfoCalls: string[] = [];
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      threadClient: {
        async getThreadReplies() {
          return {
            ok: true,
            messages: [
              { user: 'U111', text: 'The failing test is in auth', ts: '1710000000.000100' },
              { user: 'U222', text: 'It started after the cookie change', ts: '1710000001.000100' },
              { user: 'U123', text: `<@${botUserId}> please investigate`, ts: '1710000002.000100' },
            ],
          };
        },
      },
      infoClient: {
        async getChannelInfo() {
          return { ok: true, channel: { id: 'C123', name: 'engineering' } };
        },
        async getUserInfo(input) {
          userInfoCalls.push(input.user);
          const users = {
            U111: { id: 'U111', profile: { display_name: 'Priya' } },
            U222: { id: 'U222', real_name: 'Marcus Chen' },
            U123: { id: 'U123', name: 'alex' },
          };
          return { ok: true, user: users[input.user as keyof typeof users] };
        },
      },
    });

    const accepted = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> please investigate`, ts: '1710000002.000100', threadTs: '1710000000.000100' }));

    expect(accepted.type).toBe('accepted');
    if (accepted.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const messages = await services.messages.list(accepted.session.id);
    expect(messages[0]!.prompt).toContain('Slack channel context:\n---\nChannel: #engineering\n---');
    expect(messages[0]!.prompt).toContain('[Priya]: The failing test is in auth');
    expect(messages[0]!.prompt).toContain('[Marcus Chen]: It started after the cookie change');
    expect(messages[0]!.prompt).toContain('Current tagged Slack message:\n---\n[alex]: please investigate');
    expect(messages[0]!.prompt).not.toContain('U111');
    expect(messages[0]!.prompt).not.toContain('U222');
    expect(userInfoCalls.sort()).toEqual(['U111', 'U123', 'U222']);
  });

  it('uses compact Slack channel context on follow-up messages', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      infoClient: {
        async getChannelInfo() {
          return { ok: true, channel: { id: 'C123', name: 'engineering' } };
        },
        async getUserInfo() {
          return { ok: true, user: { id: 'U123', name: 'alex' } };
        },
      },
    });

    const first = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> first task`, ts: '1710000000.000100' }));
    const second = await slack.handle(slackEvent({ eventId: 'Ev2', type: 'message', text: 'follow up', ts: '1710000001.000100', threadTs: '1710000000.000100' }));

    expect(first.type).toBe('accepted');
    expect(second.type).toBe('accepted');
    if (first.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const messages = await services.messages.list(first.session.id);
    expect(messages[0]!.prompt).toContain('Slack channel context:\n---\nChannel: #engineering\n---');
    expect(messages[1]!.prompt).toContain('Slack thread: #engineering');
    expect(messages[1]!.prompt).not.toContain('Slack channel context:');
  });

  it('omits Slack user names when lookup fails', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      threadClient: {
        async getThreadReplies() {
          return { ok: true, messages: [{ user: 'U111', text: 'background detail', ts: '1710000000.000100' }] };
        },
      },
      infoClient: {
        async getChannelInfo() {
          return { ok: true, channel: { id: 'C123', name: 'engineering' } };
        },
        async getUserInfo() {
          return { ok: false, error: 'missing_scope' };
        },
      },
    });

    const accepted = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> please investigate`, ts: '1710000002.000100', threadTs: '1710000000.000100' }));

    expect(accepted.type).toBe('accepted');
    if (accepted.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const messages = await services.messages.list(accepted.session.id);
    expect(messages[0]!.prompt).toContain('Channel: #engineering');
    expect(messages[0]!.prompt).not.toContain('Actor:');
    expect(messages[0]!.prompt).toContain('[user]: background detail');
    expect(messages[0]!.prompt).not.toContain('U111');
  });

  it('explains when Slack thread context cannot be fetched', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      threadClient: {
        async getThreadReplies() {
          return { ok: false, error: 'missing_scope' };
        },
      },
    });

    const accepted = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> can you summarize this thread?`, ts: '1710000002.000100', threadTs: '1710000000.000100' }));

    expect(accepted.type).toBe('accepted');
    if (accepted.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const messages = await services.messages.list(accepted.session.id);
    expect(messages[0]!.prompt).toContain('Prior Slack thread messages were unavailable: missing_scope.');
  });

  it('explains when Slack thread context is not configured', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages);

    const accepted = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> can you summarize this thread?`, ts: '1710000002.000100', threadTs: '1710000000.000100' }));

    expect(accepted.type).toBe('accepted');
    if (accepted.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const messages = await services.messages.list(accepted.session.id);
    expect(messages[0]!.prompt).toContain('Slack thread history client is not configured');
  });

  it('omits Slack thread messages already processed as product messages', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      threadClient: {
        async getThreadReplies() {
          return {
            ok: true,
            messages: [
              { user: 'U123', text: `<@${botUserId}> first request`, ts: '1710000000.000100' },
              { user: 'U222', text: 'new background detail', ts: '1710000001.000100' },
              { user: 'U123', text: `<@${botUserId}> second request`, ts: '1710000002.000100' },
            ],
          };
        },
      },
    });

    const first = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> first request`, ts: '1710000000.000100' }));
    if (first.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const second = await slack.handle(slackEvent({ eventId: 'Ev2', type: 'app_mention', text: `<@${botUserId}> second request`, ts: '1710000002.000100', threadTs: '1710000000.000100' }));

    expect(second.type).toBe('accepted');
    if (second.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const messages = await services.messages.list(second.session.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.prompt).not.toContain('first request');
    expect(messages[1]!.prompt).toContain('new background detail');
    expect(messages[1]!.prompt).toContain('second request');
  });

  it('omits Slack thread messages already included as fetched context', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      threadClient: {
        async getThreadReplies() {
          return {
            ok: true,
            messages: [
              { user: 'U123', text: 'the lazy brown cow', ts: '1710000000.000100' },
              { user: 'U123', text: 'jumped over the fox', ts: '1710000001.000100' },
              { user: 'U123', text: `<@${botUserId}> summarize this thread`, ts: '1710000002.000100' },
              { user: 'U123', text: `<@${botUserId}> what do you see now?`, ts: '1710000003.000100' },
            ],
          };
        },
      },
    });

    const first = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> summarize this thread`, ts: '1710000002.000100', threadTs: '1710000000.000100' }));
    if (first.type !== 'accepted') throw new Error('Expected accepted Slack event');
    const second = await slack.handle(slackEvent({ eventId: 'Ev2', type: 'app_mention', text: `<@${botUserId}> what do you see now?`, ts: '1710000003.000100', threadTs: '1710000000.000100' }));
    if (second.type !== 'accepted') throw new Error('Expected accepted Slack event');

    const messages = await services.messages.list(second.session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.context?.slack).toMatchObject({ includedThreadTs: ['1710000000.000100', '1710000001.000100'] });
    expect(messages[1]!.prompt).not.toContain('the lazy brown cow');
    expect(messages[1]!.prompt).not.toContain('jumped over the fox');
    expect(messages[1]!.prompt).not.toContain('summarize this thread');
    expect(messages[1]!.prompt).toContain('what do you see now?');
  });

  it('deduplicates Slack event deliveries and ignores bot messages', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages);
    const payload = slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000000.000100' });

    const first = await slack.handle(payload);
    const duplicate = await slack.handle(payload);
    const bot = await slack.handle(slackEvent({ eventId: 'Ev3', type: 'app_mention', text: 'bot loop', ts: '1710000002.000100', botId: 'B123' }));

    expect(first.type).toBe('accepted');
    expect(duplicate.type).toBe('duplicate');
    expect(bot).toMatchObject({ type: 'ignored' });
  });

  it('ignores Slack events outside configured allowlists', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      allowedTeamIds: ['TALLOWED'],
      allowedChannelIds: ['CALLOWED'],
      allowedUserIds: ['UALLOWED'],
    });

    const deniedTeam = await slack.handle(slackEvent({ eventId: 'EvTeam', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000000.000100', teamId: 'TDENIED', channel: 'CALLOWED', user: 'UALLOWED' }));
    const deniedChannel = await slack.handle(slackEvent({ eventId: 'EvChannel', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000001.000100', teamId: 'TALLOWED', channel: 'CDENIED', user: 'UALLOWED' }));
    const deniedUser = await slack.handle(slackEvent({ eventId: 'EvUser', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000002.000100', teamId: 'TALLOWED', channel: 'CALLOWED', user: 'UDENIED' }));
    const accepted = await slack.handle(slackEvent({ eventId: 'EvAllowed', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000003.000100', teamId: 'TALLOWED', channel: 'CALLOWED', user: 'UALLOWED' }));

    expect(deniedTeam).toMatchObject({ type: 'ignored', reason: 'unauthorized_team' });
    expect(deniedChannel).toMatchObject({ type: 'ignored', reason: 'unauthorized_channel' });
    expect(deniedUser).toMatchObject({ type: 'ignored', reason: 'unauthorized_user' });
    expect(accepted.type).toBe('accepted');
    expect(await store.listSessions()).toHaveLength(1);
  });

  it('ignores Slack thread replies mapped to archived sessions', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const reactions: Array<{ channel: string; timestamp: string; name: string }> = [];
    const replies: Array<{ channel: string; threadTs: string; text: string }> = [];
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      reactionClient: {
        async addReaction(input) {
          reactions.push(input);
          return { ok: true };
        },
      },
      replyClient: {
        async postThreadReply(input) {
          replies.push(input);
          return { ok: true, ts: '1710000002.000100' };
        },
      },
    });
    const first = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000000.000100' }));
    if (first.type !== 'accepted') throw new Error('Expected accepted Slack event');
    await services.sessions.archive(first.session.id);

    const reply = await slack.handle(slackEvent({ eventId: 'Ev2', type: 'message', text: 'follow up', ts: '1710000001.000100', threadTs: '1710000000.000100' }));

    expect(reply).toMatchObject({ type: 'ignored', reason: 'session_archived' });
    const messages = await services.messages.list(first.session.id);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ source: 'slack', status: 'cancelled', prompt: expect.stringContaining('Not queued') });
    expect(messages[2]).toMatchObject({ source: 'slack_notice', status: 'cancelled', prompt: expect.stringContaining('unarchive and proceed') });
    expect(reactions).toEqual([{ channel: 'C123', timestamp: '1710000000.000100', name: 'eyes' }]);
    expect(replies).toEqual([{ channel: 'C123', threadTs: '1710000000.000100', text: expect.stringContaining('unarchive and proceed') }]);
  });

  it('unarchives Slack thread sessions without starting a run for phrase-only recovery', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const replies: Array<{ channel: string; threadTs: string; text: string }> = [];
    const slack = new SlackIntegrationService(store, services.sessions, services.messages, {
      replyClient: {
        async postThreadReply(input) {
          replies.push(input);
          return { ok: true, ts: '1710000002.000100' };
        },
      },
    });
    const first = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000000.000100' }));
    if (first.type !== 'accepted') throw new Error('Expected accepted Slack event');
    await services.sessions.archive(first.session.id);

    const restored = await slack.handle(slackEvent({ eventId: 'Ev2', type: 'message', text: 'unarchive and proceed', ts: '1710000001.000100', threadTs: '1710000000.000100' }));

    expect(restored.type).toBe('recovered');
    await expect(services.sessions.get(first.session.id)).resolves.toMatchObject({ status: 'idle' });
    const messages = await services.messages.list(first.session.id);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ source: 'slack', status: 'cancelled', prompt: expect.stringContaining('No agent run was started') });
    expect(messages[2]).toMatchObject({ source: 'slack_notice', status: 'cancelled', prompt: expect.stringContaining('Unarchived and ready') });
    expect(replies).toEqual([{ channel: 'C123', threadTs: '1710000000.000100', text: expect.stringContaining('Unarchived and ready') }]);
  });

  it('queues Slack recovery messages that include additional instructions', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages);
    const first = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000000.000100' }));
    if (first.type !== 'accepted') throw new Error('Expected accepted Slack event');
    await services.sessions.archive(first.session.id);

    const restored = await slack.handle(slackEvent({ eventId: 'Ev2', type: 'message', text: 'unarchive and proceed then summarize the thread', ts: '1710000001.000100', threadTs: '1710000000.000100' }));

    expect(restored.type).toBe('accepted');
    const messages = await services.messages.list(first.session.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ source: 'slack', status: 'pending' });
  });

  it('queues archived Slack instructions when users recover with the phrase', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const slack = new SlackIntegrationService(store, services.sessions, services.messages);
    const first = await slack.handle(slackEvent({ eventId: 'Ev1', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000000.000100' }));
    if (first.type !== 'accepted') throw new Error('Expected accepted Slack event');
    await services.sessions.archive(first.session.id);

    await slack.handle(slackEvent({ eventId: 'Ev2', type: 'message', text: 'please summarize the thread', ts: '1710000001.000100', threadTs: '1710000000.000100' }));
    const recovered = await slack.handle(slackEvent({ eventId: 'Ev3', type: 'message', text: 'unarchive and proceed', ts: '1710000002.000100', threadTs: '1710000000.000100' }));

    expect(recovered.type).toBe('accepted');
    const messages = await services.messages.list(first.session.id);
    expect(messages).toHaveLength(4);
    expect(messages[3]).toMatchObject({ source: 'slack', status: 'pending' });
    expect(messages[3]!.prompt).toContain('please summarize the thread');
    expect(messages[3]!.prompt).toContain('Slack archived-session recovery');
    expect(messages[3]!.context?.includedArchivedMessageIds).toEqual([messages[1]!.id]);
  });

  it('handles signed Slack webhook challenges through the API route', async () => {
    const server = createServer(loadConfig({ SLACK_SIGNING_SECRET: signingSecret, UNSAFE_ALLOW_ALL_SLACK_IDS: 'true' }), createServices(new MemoryStore()));
    const baseUrl = await listen(server);
    try {
      const body = JSON.stringify({ type: 'url_verification', challenge: 'challenge-token' });
      const response = await postSignedSlack(`${baseUrl}/webhooks/slack/events`, body);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ challenge: 'challenge-token' });
    } finally {
      await close(server);
    }
  });

  it('rejects unsigned Slack webhook requests', async () => {
    const server = createServer(loadConfig({ SLACK_SIGNING_SECRET: signingSecret, UNSAFE_ALLOW_ALL_SLACK_IDS: 'true' }), createServices(new MemoryStore()));
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/webhooks/slack/events`, { method: 'POST', body: '{}' });
      expect(response.status).toBe(401);
    } finally {
      await close(server);
    }
  });

  it('returns ignored for signed Slack events outside API allowlists', async () => {
    const server = createServer(loadConfig({ SLACK_SIGNING_SECRET: signingSecret, SLACK_ALLOWED_CHANNEL_IDS: 'CALLOWED' }), createServices(new MemoryStore()));
    const baseUrl = await listen(server);
    try {
      const body = JSON.stringify(slackEvent({ eventId: 'EvDenied', type: 'app_mention', text: `<@${botUserId}> do work`, ts: '1710000000.000100', channel: 'CDENIED' }));
      const response = await postSignedSlack(`${baseUrl}/webhooks/slack/events`, body);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, type: 'ignored' });
    } finally {
      await close(server);
    }
  });
});

function slackEvent(input: { eventId: string; type: 'app_mention' | 'message'; text: string; ts: string; threadTs?: string; botId?: string; teamId?: string; channel?: string; user?: string }) {
  return {
    type: 'event_callback',
    team_id: input.teamId ?? 'T123',
    event_id: input.eventId,
    event_time: 1710000000,
    event: {
      type: input.type,
      text: input.text,
      user: input.user ?? 'U123',
      channel: input.channel ?? 'C123',
      ts: input.ts,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.botId ? { bot_id: input.botId } : {}),
    },
  };
}

function postSignedSlack(url: string, body: string): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': createSlackSignature({ body, timestamp, signingSecret }),
    },
    body,
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://${address.address}:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
