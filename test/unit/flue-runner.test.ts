import { FlueRunner } from '../../src/runner-flue/runner.js';
import type { FlueAgentFactory } from '../../src/runner-flue/types.js';
import type { NormalizedEvent } from '../../src/events/types.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';

describe('FlueRunner', () => {
  it('uses stable product session IDs for Flue agent and session identity', async () => {
    const calls: Array<{ agentId: string; sessionId: string; cwd?: string }> = [];
    const factory: FlueAgentFactory = {
      async create(input) {
        calls.push(input);
        return {
          async session(id) {
            expect(id).toBe('session-1');
            return {
              async prompt(text) {
                return { text: `flue: ${text}` };
              },
            };
          },
        };
      },
    };
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });
    const events: NormalizedEvent[] = [];

    const result = await new FlueRunner(factory).run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'hello',
      context: {},
      sandbox,
      emit: async (event) => {
        events.push(event);
      },
    });

    expect(calls).toEqual([{ agentId: 'session-1', sessionId: 'session-1', cwd: '/workspace' }]);
    expect(result.text).toBe('flue: hello');
    expect(events.map((event) => event.type)).toEqual(['run_started', 'agent_text_delta', 'run_completed']);
  });
});
