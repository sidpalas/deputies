import type { ModelUsagePayload, NormalizedEvent } from '../events/types.js';
import type { SandboxHandle } from '../sandbox/types.js';
import type { ReasoningLevel } from './reasoning.js';

export type RunnerInput = {
  sessionId: string;
  runId: string;
  messageId: string;
  createdByUserId?: string;
  prompt: string;
  messages?: RunnerMessageInput[];
  skillInvocations?: RunnerSkillInvocation[];
  model?: string;
  reasoningLevel?: ReasoningLevel;
  context: Record<string, unknown>;
  sandbox: SandboxHandle;
  signal?: AbortSignal;
  emit: (event: NormalizedEvent) => Promise<void>;
  updateSessionContext?: (context: Record<string, unknown>) => Promise<Record<string, unknown>>;
  shouldPersist?: () => Promise<boolean>;
  activeMessageDelivery?: (handler: (message: RunnerMessageInput) => Promise<void>) => () => Promise<void>;
};

export type RunnerMessageInput = {
  messageId?: string;
  prompt: string;
  authorUserId?: string;
  context?: Record<string, unknown>;
  skillInvocations?: RunnerSkillInvocation[];
  sequence?: number;
};

export type RunnerSkillInvocation = {
  name: string;
  ref?: string;
  revisionId?: string;
};

export type RunnerResult = {
  text: string;
  model?: string;
  usage?: ModelUsagePayload;
  artifacts?: RunnerArtifact[];
};

export type GenerateTitleInput = {
  prompt: string;
  model?: string;
  signal?: AbortSignal;
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
  generateTitle?(input: GenerateTitleInput): Promise<string>;
}
