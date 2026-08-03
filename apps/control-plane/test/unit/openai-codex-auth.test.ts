import { promptForOpenAICodexAuth } from '../../src/runner/openai-codex-auth.js';

describe('promptForOpenAICodexAuth', () => {
  it('renders selections and returns the selected option ID', async () => {
    const question = vi.fn().mockResolvedValueOnce('invalid').mockResolvedValueOnce('2');
    await expect(
      promptForOpenAICodexAuth(
        {
          type: 'select',
          message: 'Choose a login method',
          options: [
            { id: 'browser', label: 'Browser' },
            { id: 'device_code', label: 'Device code', description: 'For remote terminals' },
          ],
        },
        question,
      ),
    ).resolves.toBe('device_code');
    expect(question).toHaveBeenCalledTimes(2);
    expect(question.mock.calls[0]?.[0]).toContain('2. Device code — For remote terminals');
  });

  it('passes prompt cancellation through to the active question', async () => {
    const controller = new AbortController();
    const question = vi.fn(async (_message: string, options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(
      promptForOpenAICodexAuth({ type: 'manual_code', message: 'Paste callback', signal: controller.signal }, question),
    ).rejects.toThrow('aborted');
  });
});
