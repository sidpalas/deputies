import type { FlueEvent, PromptResponse, SandboxFactory } from '@flue/sdk';
import type { RunnerInput, RunnerResult } from '../runner/types.js';
import type { SandboxHandle } from '../sandbox/types.js';

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
  abort?: () => void;
}

export interface FlueAgentPort {
  session(id?: string): Promise<FlueSessionPort>;
}

export interface FlueAgentFactory {
  create(input: {
    agentId: string;
    sessionId: string;
    sandbox: SandboxHandle;
    cwd?: string;
    onEvent?: (event: FlueEvent) => void;
  }): Promise<FlueAgentPort>;
}
