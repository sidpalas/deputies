import type { Runner, RunnerInput, RunnerResult } from './types.js';

export class FakeRunner implements Runner {
  async run(input: RunnerInput): Promise<RunnerResult> {
    await input.emit({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      type: 'run_started',
      payload: { runner: 'fake' },
      createdAt: new Date(),
    });

    await input.emit({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      type: 'agent_text_delta',
      payload: { text: `Fake response for: ${input.prompt}` },
      createdAt: new Date(),
    });

    await input.emit({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      type: 'run_completed',
      payload: { runner: 'fake' },
      createdAt: new Date(),
    });

    const result: RunnerResult = { text: `Fake response for: ${input.prompt}` };
    const artifact = input.context.fakeArtifact ?? getNestedFakeArtifact(input.context);
    if (artifact && typeof artifact === 'object' && !Array.isArray(artifact)) {
      const type = 'type' in artifact && typeof artifact.type === 'string' ? artifact.type : 'external_link';
      const url = 'url' in artifact && typeof artifact.url === 'string' ? artifact.url : undefined;
      const payload = 'payload' in artifact && isRecord(artifact.payload) ? artifact.payload : {};
      result.artifacts = [url ? { type, url, payload } : { type, payload }];
    }

    return result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getNestedFakeArtifact(context: Record<string, unknown>): unknown {
  const webhookContext = context.webhookContext;
  return isRecord(webhookContext) ? webhookContext.fakeArtifact : undefined;
}
