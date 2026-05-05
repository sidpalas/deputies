import type { Runner, RunnerInput, RunnerResult } from './types.js';

export class FakeRunner implements Runner {
  async run(input: RunnerInput): Promise<RunnerResult> {
    await input.emit({
      sessionId: input.sessionId,
      messageId: input.messageId,
      type: 'run_started',
      payload: { runner: 'fake' },
      createdAt: new Date(),
    });

    await input.emit({
      sessionId: input.sessionId,
      messageId: input.messageId,
      type: 'agent_text_delta',
      payload: { text: `Fake response for: ${input.prompt}` },
      createdAt: new Date(),
    });

    await input.emit({
      sessionId: input.sessionId,
      messageId: input.messageId,
      type: 'run_completed',
      payload: { runner: 'fake' },
      createdAt: new Date(),
    });

    return { text: `Fake response for: ${input.prompt}` };
  }
}
