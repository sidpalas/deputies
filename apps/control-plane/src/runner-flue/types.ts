import type {
  FlueEvent,
  ModelConfig,
  PromptOptions,
  SandboxFactory,
  SessionData,
  ShellResult,
  ToolDefinition,
} from '@flue/runtime';
import type { RunnerInput, RunnerResult } from '../runner/types.js';
import type { SandboxHandle } from '../sandbox/types.js';

export type FlueRunnerOptions = {
  model: string;
  sandbox?: false | SandboxFactory;
  cwd?: string;
};

export interface FlueRunnerPort {
  run(input: RunnerInput): Promise<RunnerResult>;
}

export type FluePromptResponse = {
  text: string;
  model?: { id: string } | string;
  usage?: RunnerResult['usage'];
};

export type FlueShellOptions = {
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  /** Milliseconds. Supported by the app adapter; stripped before calling Flue. */
  timeout?: number;
};

export interface FlueSessionPort {
  prompt(text: string, options?: Pick<PromptOptions, 'signal'>): PromiseLike<FluePromptResponse>;
  shell?(command: string, options?: FlueShellOptions): PromiseLike<ShellResult>;
  abort?: (reason?: unknown) => void;
}

export interface FlueAgentPort {
  session(id?: string): Promise<FlueSessionPort>;
  shell?(command: string, options?: FlueShellOptions): PromiseLike<ShellResult>;
}

export interface FlueAgentFactory {
  create(input: {
    agentId: string;
    sessionId: string;
    sandbox: SandboxHandle;
    cwd?: string;
    model?: ModelConfig;
    tools?: ToolDefinition[];
    onEvent?: (event: FlueEvent) => void;
  }): Promise<FlueAgentPort>;
  loadSession?(id: string): Promise<SessionData | null>;
  saveSession?(id: string, data: SessionData): Promise<void>;
  deleteSession?(id: string): Promise<void>;
}
