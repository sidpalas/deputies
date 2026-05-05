import type { Runner, RunnerInput, RunnerResult } from '../runner/types.js';
import type { FlueAgentFactory } from './types.js';

export class FlueRunner implements Runner {
  constructor(private readonly agentFactory: FlueAgentFactory) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    const agent = await this.agentFactory.create({
      agentId: input.sessionId,
      sessionId: input.sessionId,
      cwd: input.sandbox.workspacePath,
    });
    const session = await agent.session(input.sessionId);

    await input.emit({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      type: 'run_started',
      payload: { runner: 'flue' },
      createdAt: new Date(),
    });

    const response = await session.prompt(input.prompt);

    await input.emit({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      type: 'agent_text_delta',
      payload: { text: response.text },
      createdAt: new Date(),
    });
    await input.emit({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      type: 'run_completed',
      payload: { runner: 'flue' },
      createdAt: new Date(),
    });

    return { text: response.text };
  }
}
