import type { PromptResponse, SandboxFactory } from '@flue/sdk';
import type { RunnerInput, RunnerResult } from '../runner/types.js';

export type FlueRunnerOptions = {
  model: string;
  sandbox?: 'empty' | 'local' | SandboxFactory;
  cwd?: string;
};

export interface FlueRunnerPort {
  run(input: RunnerInput): Promise<RunnerResult>;
}

export interface FlueSessionPort {
  prompt(text: string): Promise<PromptResponse>;
}

export interface FlueAgentPort {
  session(id?: string): Promise<FlueSessionPort>;
}

export interface FlueAgentFactory {
  create(input: { agentId: string; sessionId: string; cwd?: string }): Promise<FlueAgentPort>;
}
