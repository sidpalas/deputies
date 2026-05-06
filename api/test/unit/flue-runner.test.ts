import { FlueRunner } from '../../src/runner-flue/runner.js';
import type { FlueAgentFactory } from '../../src/runner-flue/types.js';
import type { NormalizedEvent } from '../../src/events/types.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';

describe('FlueRunner', () => {
  it('uses stable product session IDs for Flue agent and session identity', async () => {
    const calls: Parameters<FlueAgentFactory['create']>[0][] = [];
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
              abort() {},
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

    expect(calls).toMatchObject([{ agentId: 'session-1', sessionId: 'session-1', sandbox, cwd: '/workspace' }]);
    expect(calls[0]?.onEvent).toEqual(expect.any(Function));
    expect(result.text).toBe('flue: hello');
    expect(events.map((event) => event.type)).toEqual(['run_started', 'agent_text_delta', 'run_completed']);
  });

  it('normalizes Flue live events into product events', async () => {
    const factory: FlueAgentFactory = {
      async create(input) {
        return {
          async session() {
            return {
              async prompt() {
                input.onEvent?.({ type: 'text_delta', text: 'hello', sessionId: 'flue-session' });
                input.onEvent?.({
                  type: 'tool_start',
                  toolName: 'shell',
                  toolCallId: 'tool-1',
                  args: { command: 'pwd' },
                  sessionId: 'flue-session',
                });
                input.onEvent?.({
                  type: 'tool_end',
                  toolName: 'shell',
                  toolCallId: 'tool-1',
                  isError: false,
                  result: 'ok',
                  sessionId: 'flue-session',
                });
                input.onEvent?.({ type: 'command_start', command: 'gh', args: ['issue', 'list'] });
                input.onEvent?.({ type: 'command_end', command: 'gh', exitCode: 0 });
                input.onEvent?.({ type: 'task_start', taskId: 'task-1', prompt: 'research', cwd: '/workspace' });
                input.onEvent?.({ type: 'task_end', taskId: 'task-1', isError: false, result: 'done' });
                return { text: 'hello' };
              },
              abort() {},
            };
          },
        };
      },
    };
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });
    const events: NormalizedEvent[] = [];

    await new FlueRunner(factory).run({
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

    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'agent_text_delta',
      'tool_started',
      'tool_finished',
      'tool_started',
      'tool_finished',
      'tool_started',
      'tool_finished',
      'run_completed',
    ]);
    expect(events.filter((event) => event.type === 'agent_text_delta')).toHaveLength(1);
    expect(events[1]?.payload).toMatchObject({ text: 'hello', flueSessionId: 'flue-session' });
    expect(events[2]?.payload).toMatchObject({ toolName: 'shell', toolCallId: 'tool-1' });
    expect(events[4]?.payload).toMatchObject({ toolName: 'command', command: 'gh' });
    expect(events[6]?.payload).toMatchObject({ toolName: 'task', taskId: 'task-1' });
  });
});
