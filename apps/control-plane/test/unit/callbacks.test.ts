import { HttpCompletionCallbackSender, type CompletionCallbackPayload } from '../../src/callbacks/service.js';

const payload: CompletionCallbackPayload = {
  event: 'message_completed',
  sessionId: 'session-1',
  runId: 'run-1',
  messageId: 'message-1',
  text: 'done',
  artifacts: [],
};

describe('HttpCompletionCallbackSender', () => {
  it.each([
    'http://localhost/callback',
    'http://foo.localhost/callback',
    'http://127.0.0.1/callback',
    'http://10.0.0.1/callback',
    'http://172.16.0.1/callback',
    'http://192.168.0.1/callback',
    'http://100.64.0.1/callback',
    'http://169.254.169.254/latest/meta-data',
    'http://100.100.100.200/latest/meta-data',
    'http://192.0.0.1/callback',
    'http://192.0.2.1/callback',
    'http://198.18.0.1/callback',
    'http://198.51.100.1/callback',
    'http://203.0.113.1/callback',
    'http://224.0.0.1/callback',
    'http://240.0.0.1/callback',
    'http://255.255.255.255/callback',
    'http://0.0.0.0/callback',
    'http://[::1]/callback',
    'http://[::ffff:127.0.0.1]/callback',
    'http://[::ffff:7f00:1]/callback',
    'http://[::ffff:192.168.0.1]/callback',
    'http://[::ffff:c0a8:1]/callback',
    'http://[fe80::1]/callback',
    'http://[fc00::1]/callback',
    'http://[ff02::1]/callback',
    'http://[2001:db8::1]/callback',
    'file:///tmp/callback',
  ])('blocks unsafe callback URL %s', async (url) => {
    const sender = new HttpCompletionCallbackSender({
      request: async () => {
        throw new Error('request should not be sent');
      },
    });

    await expect(sender.deliver({ type: 'http', target: { url } }, payload)).rejects.toThrow(/HTTP callback URL/);
  });

  it('blocks hostnames that resolve to unsafe addresses', async () => {
    const sender = new HttpCompletionCallbackSender({
      resolveHostname: async () => [{ address: '10.0.0.5', family: 4 }],
      request: async () => {
        throw new Error('request should not be sent');
      },
    });

    await expect(
      sender.deliver({ type: 'http', target: { url: 'https://example.com/callback' } }, payload),
    ).rejects.toThrow('resolved to a blocked IP range');
  });

  it('blocks hostnames if any resolved address is unsafe', async () => {
    const sender = new HttpCompletionCallbackSender({
      resolveHostname: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '::ffff:10.0.0.5', family: 6 },
      ],
      request: async () => {
        throw new Error('request should not be sent');
      },
    });

    await expect(
      sender.deliver({ type: 'http', target: { url: 'https://example.com/callback' } }, payload),
    ).rejects.toThrow('resolved to a blocked IP range');
  });

  it('sends to public resolved addresses with a timeout', async () => {
    const requests: Array<{ timeoutMs: number; body: string }> = [];
    const sender = new HttpCompletionCallbackSender({
      timeoutMs: 1234,
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (input) => {
        requests.push({ timeoutMs: input.timeoutMs, body: input.body });
        return { statusCode: 204 };
      },
    });

    await expect(
      sender.deliver({ type: 'http', target: { url: 'https://example.com/callback' } }, payload),
    ).resolves.toBeUndefined();
    expect(requests).toEqual([{ timeoutMs: 1234, body: JSON.stringify(payload) }]);
  });

  it('allows local callback targets only when explicitly enabled', async () => {
    const requests: Array<{ url: string; addresses: unknown[] }> = [];
    const sender = new HttpCompletionCallbackSender({
      unsafeAllowLocalNetwork: true,
      request: async (input) => {
        requests.push({ url: input.url.toString(), addresses: input.addresses });
        return { statusCode: 204 };
      },
    });

    await expect(
      sender.deliver({ type: 'http', target: { url: 'http://127.0.0.1:1234/callback' } }, payload),
    ).resolves.toBeUndefined();
    expect(requests).toEqual([
      { url: 'http://127.0.0.1:1234/callback', addresses: [{ address: '127.0.0.1', family: 4 }] },
    ]);
  });

  it('surfaces timeout failures as retryable delivery errors', async () => {
    const sender = new HttpCompletionCallbackSender({
      timeoutMs: 1,
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (input) =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('HTTP callback timed out')), input.timeoutMs);
        }),
    });

    await expect(
      sender.deliver({ type: 'http', target: { url: 'https://example.com/callback' } }, payload),
    ).rejects.toThrow('HTTP callback timed out');
  });

  it('does not follow redirects', async () => {
    const sender = new HttpCompletionCallbackSender({
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async () => ({ statusCode: 302 }),
    });

    await expect(
      sender.deliver({ type: 'http', target: { url: 'https://example.com/callback' } }, payload),
    ).rejects.toThrow('HTTP callback returned 302');
  });
});
