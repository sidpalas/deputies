import { completeSimple, type Context, type Model } from '@earendil-works/pi-ai/compat';

describe('Pi title payload compatibility', () => {
  it('disables DeepSeek thinking before sending the title request', async () => {
    const model: Model<'openai-completions'> = {
      id: 'reasoning-content-model',
      name: 'Reasoning content model',
      api: 'openai-completions',
      provider: 'opencode',
      baseUrl: 'https://example.test/v1',
      reasoning: true,
      thinkingLevelMap: { high: 'high', max: 'max' },
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 16_000,
      compat: {
        maxTokensField: 'max_tokens',
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek',
      },
    };
    const context: Context = {
      systemPrompt: 'Return only a brief title.',
      messages: [{ role: 'user', content: 'Fix automatic titles', timestamp: Date.now() }],
    };
    let payload: unknown;

    const response = await completeSimple(model, context, {
      apiKey: 'test-key',
      maxTokens: 512,
      onPayload(value) {
        payload = value;
        throw new Error('stop before network request');
      },
    });

    expect(response).toMatchObject({ stopReason: 'error' });
    expect(payload).toMatchObject({
      max_tokens: 512,
      thinking: { type: 'disabled' },
    });
    expect(payload).not.toHaveProperty('reasoning_effort');
  });
});
