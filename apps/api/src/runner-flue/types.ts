import type { FlueEvent, PromptResponse, SandboxFactory, SessionData, ShellOptions, ShellResult, ToolDef } from '@flue/sdk';
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
  shell?(command: string, options?: ShellOptions): Promise<ShellResult>;
  abort?: () => void;
}

export interface FlueAgentPort {
  session(id?: string): Promise<FlueSessionPort>;
  shell?(command: string, options?: ShellOptions): Promise<ShellResult>;
}

export interface FlueAgentFactory {
  create(input: {
    agentId: string;
    sessionId: string;
    sandbox: SandboxHandle;
    cwd?: string;
    tools?: ToolDef[];
    onEvent?: (event: FlueEvent) => void;
  }): Promise<FlueAgentPort>;
  loadSession?(id: string): Promise<SessionData | null>;
  saveSession?(id: string, data: SessionData): Promise<void>;
  deleteSession?(id: string): Promise<void>;
}
