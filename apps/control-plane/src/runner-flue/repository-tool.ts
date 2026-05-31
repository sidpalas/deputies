import type { ToolDefinition } from '@flue/runtime';
import {
  executeRepositoryTool,
  repositoryToolDescription,
  repositoryToolParameters,
  type PreparedRepository,
  type RepositoryShell,
  type RepositoryToolServices as SharedRepositoryToolServices,
  type RepositoryToolState,
} from '../repositories/tool.js';
import type { AgentRef } from './git-tool.js';

export type { PreparedRepository, RepositoryToolState };

export type RepositoryToolServices = Omit<SharedRepositoryToolServices, 'shell'> & {
  agentRef: AgentRef;
};

export function createRepositoryTool(services: RepositoryToolServices): ToolDefinition {
  return {
    name: 'repository',
    description: repositoryToolDescription,
    parameters: repositoryToolParameters,
    async execute(params) {
      return executeRepositoryTool(toSharedRepositoryToolServices(services), params);
    },
  };
}

export function toSharedRepositoryToolServices(services: RepositoryToolServices): SharedRepositoryToolServices {
  const { agentRef, ...shared } = services;
  return {
    ...shared,
    shell: () => flueShell(agentRef),
  };
}

function flueShell(agentRef: AgentRef): RepositoryShell | undefined {
  const agent = agentRef.current;
  if (!agent?.shell) return undefined;
  return (command, options = {}) => {
    const flueOptions = {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    };
    return agent.shell!(command, flueOptions);
  };
}
