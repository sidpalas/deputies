import type { ToolDefinition } from '@flue/runtime';
import { executeGitTool, gitToolDescription, gitToolParameters } from '../repositories/git-tool.js';
import type { FlueAgentPort } from './types.js';
import { toSharedRepositoryToolServices, type RepositoryToolServices } from './repository-tool.js';

export type AgentRef = {
  current?: FlueAgentPort;
};

export function createGitTool(input: { agentRef: AgentRef; repository: RepositoryToolServices }): ToolDefinition {
  return {
    name: 'git',
    description: gitToolDescription,
    parameters: gitToolParameters,
    async execute(params) {
      return executeGitTool(toSharedRepositoryToolServices(input.repository), params);
    },
  };
}
