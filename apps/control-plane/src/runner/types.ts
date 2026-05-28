import type { ModelUsagePayload, NormalizedEvent } from '../events/types.js';
import type { SandboxHandle } from '../sandbox/types.js';

export type RunnerInput = {
  sessionId: string;
  runId: string;
  messageId: string;
  prompt: string;
  model?: string;
  context: Record<string, unknown>;
  sandbox: SandboxHandle;
  signal?: AbortSignal;
  emit: (event: NormalizedEvent) => Promise<void>;
  updateSessionContext?: (context: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export type RunnerResult = {
  text: string;
  model?: string;
  usage?: ModelUsagePayload;
  artifacts?: RunnerArtifact[];
};

export type RunnerArtifact = {
  type: string;
  title?: string;
  url?: string;
  payload?: Record<string, unknown>;
  content?: string | Uint8Array;
  contentBase64?: string;
  contentType?: string;
  fileName?: string;
};

export interface Runner {
  run(input: RunnerInput): Promise<RunnerResult>;
}
