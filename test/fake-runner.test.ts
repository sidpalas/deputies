import type { NormalizedEvent } from '../src/events/types.js';
import { FakeRunner } from '../src/runner/fake.js';
import { FakeSandboxProvider } from '../src/sandbox/fake.js';

describe('FakeRunner', () => {
  it('emits a deterministic run event sequence', async () => {
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });
    const events: NormalizedEvent[] = [];

    const result = await new FakeRunner().run({
      sessionId: 'session-1',
      messageId: 'message-1',
      prompt: 'hello',
      context: {},
      sandbox,
      emit: async (event) => {
        events.push(event);
      },
    });

    expect(result.text).toBe('Fake response for: hello');
    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'agent_text_delta',
      'run_completed',
    ]);
  });
});
