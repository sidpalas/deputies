import type { Runner, RunnerInput, RunnerResult } from './types.js';

export class FakeRunner implements Runner {
  constructor(private readonly options: { artifact?: Record<string, unknown> } = {}) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    const text = `Fake response for: ${input.prompt}\n\nThis is a fake runner response. Configure the RUNNER, SANDBOX_PROVIDER, and model credential environment variables to run real agent work.`;

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
      type: 'skills_loaded',
      payload: { skills: [], shadowed: [], diagnostics: [] },
      createdAt: new Date(),
    });

    await input.emit({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      type: 'agent_text_delta',
      payload: { text },
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

    const result: RunnerResult = { text };
    const artifact = input.context.fakeArtifact ?? getNestedFakeArtifact(input.context) ?? this.options.artifact;
    if (artifact && typeof artifact === 'object' && !Array.isArray(artifact)) {
      const type = 'type' in artifact && typeof artifact.type === 'string' ? artifact.type : 'external_link';
      const url = 'url' in artifact && typeof artifact.url === 'string' ? artifact.url : undefined;
      const payload = 'payload' in artifact && isRecord(artifact.payload) ? artifact.payload : {};
      const runnerArtifact = { type, payload };
      if (url) Object.assign(runnerArtifact, { url });
      if ('title' in artifact && typeof artifact.title === 'string')
        Object.assign(runnerArtifact, { title: artifact.title });
      if ('content' in artifact && typeof artifact.content === 'string')
        Object.assign(runnerArtifact, { content: artifact.content });
      if ('contentBase64' in artifact && typeof artifact.contentBase64 === 'string')
        Object.assign(runnerArtifact, { contentBase64: artifact.contentBase64 });
      if ('contentType' in artifact && typeof artifact.contentType === 'string')
        Object.assign(runnerArtifact, { contentType: artifact.contentType });
      if ('fileName' in artifact && typeof artifact.fileName === 'string')
        Object.assign(runnerArtifact, { fileName: artifact.fileName });
      result.artifacts = [runnerArtifact];
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
