import type { NormalizedEvent } from '../events/types.js';
import type { SandboxHandle } from '../sandbox/types.js';

export type RunnerInput = {
  sessionId: string;
  runId: string;
  messageId: string;
  prompt: string;
  context: Record<string, unknown>;
  sandbox: SandboxHandle;
  signal?: AbortSignal;
  emit: (event: NormalizedEvent) => Promise<void>;
  updateSessionContext?: (context: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export type RunnerResult = {
  text: string;
  artifacts?: Array<{ type: string; url?: string; payload?: Record<string, unknown> }>;
};

export interface Runner {
  run(input: RunnerInput): Promise<RunnerResult>;
}
