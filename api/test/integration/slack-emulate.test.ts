import { createEmulator } from 'emulate';
import { SlackClient } from '../../src/integrations/slack/client.js';
import { SlackCompletionCallbackSender } from '../../src/integrations/slack/callback-sender.js';

const token = 'xoxb-test-token';

describe.skipIf(process.env.RUN_SLACK_EMULATE_TEST !== 'true')('Slack emulate', () => {
  it('posts completion callbacks into an emulated Slack thread', async () => {
    const slack = await createEmulator({
      service: 'slack',
      port: 4103,
      seed: {
        tokens: { [token]: { login: 'developer', scopes: ['chat:write', 'channels:history'] } },
        slack: {
          team: { name: 'Test Workspace', domain: 'test-workspace' },
          users: [{ name: 'developer', real_name: 'Developer', email: 'dev@example.com' }],
          channels: [{ name: 'general' }],
          bots: [{ name: 'dev-deputies' }],
        },
      },
    });
    try {
      const channel = await getFirstChannelId(slack.url);
      const thread = await postMessage(slack.url, { channel, text: 'initial thread message' });
      const sender = new SlackCompletionCallbackSender(new SlackClient({ apiBaseUrl: `${slack.url}/api`, botToken: token }));

      await sender.deliver(
        { type: 'slack', target: { channel, threadTs: thread.ts } },
        {
          event: 'message_completed',
          sessionId: '00000000-0000-4000-8000-000000000001',
          runId: '00000000-0000-4000-8000-000000000002',
          messageId: '00000000-0000-4000-8000-000000000003',
          text: 'final deputy reply from test',
          artifacts: [],
        },
      );

      const replies = await getReplies(slack.url, channel, thread.ts);
      expect(replies.map((message) => message.text)).toContain('final deputy reply from test');
    } finally {
      await slack.close();
    }
  });
});

async function getFirstChannelId(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/conversations.list`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const body = (await response.json()) as { ok: boolean; channels?: Array<{ id: string; name: string }>; error?: string };
  if (!body.ok || !body.channels?.[0]) throw new Error(`Unable to list emulated Slack channels: ${body.error ?? 'missing channel'}`);
  return body.channels[0].id;
}

async function postMessage(baseUrl: string, input: { channel: string; text: string; threadTs?: string }): Promise<{ ts: string }> {
  const response = await fetch(`${baseUrl}/api/chat.postMessage`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: input.channel, text: input.text, thread_ts: input.threadTs }),
  });
  const body = (await response.json()) as { ok: boolean; ts?: string; error?: string };
  if (!body.ok || !body.ts) throw new Error(`Unable to post emulated Slack message: ${body.error ?? 'missing ts'}`);
  return { ts: body.ts };
}

async function getReplies(baseUrl: string, channel: string, threadTs: string): Promise<Array<{ text: string }>> {
  const response = await fetch(`${baseUrl}/api/conversations.replies`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, ts: threadTs }),
  });
  const body = (await response.json()) as { ok: boolean; messages?: Array<{ text: string }>; error?: string };
  if (!body.ok || !body.messages) throw new Error(`Unable to fetch emulated Slack replies: ${body.error ?? 'missing messages'}`);
  return body.messages;
}
