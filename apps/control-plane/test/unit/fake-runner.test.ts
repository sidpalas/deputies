import type { NormalizedEvent } from '../../src/events/types.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { FakeSandboxProvider } from '../../src/sandbox/fake.js';

describe('FakeRunner', () => {
  it('emits a deterministic run event sequence', async () => {
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });
    const events: NormalizedEvent[] = [];

    const result = await new FakeRunner().run({
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

    expect(result.text).toBe(
      'Fake response for: hello\n\nThis is a fake runner response. Configure the RUNNER, SANDBOX_PROVIDER, and model credential environment variables to run real agent work.',
    );
    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'skills_loaded',
      'agent_text_delta',
      'run_completed',
    ]);
    expect(events[1]?.payload).toEqual({ skills: [], shadowed: [], diagnostics: [] });
  });

  it('can return scripted fake artifacts from context', async () => {
    const sandbox = await new FakeSandboxProvider().create({ sessionId: 'session-1' });

    const result = await new FakeRunner().run({
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      prompt: 'hello',
      context: { fakeArtifact: { type: 'external_link', url: 'https://example.com/result', payload: { ok: true } } },
      sandbox,
      emit: async () => {},
    });

    expect(result.artifacts).toEqual([
      { type: 'external_link', url: 'https://example.com/result', payload: { ok: true } },
    ]);
  });
});
