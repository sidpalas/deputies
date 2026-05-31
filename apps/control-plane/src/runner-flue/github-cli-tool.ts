import type { ToolDefinition } from '@flue/runtime';
import {
  executeGitHubCliTool,
  githubCliToolDescription,
  githubCliToolParameters,
  type GitHubCliRunner,
  type GitHubCliToolOptions,
} from '../repositories/github-cli-tool.js';
import { toSharedRepositoryToolServices, type RepositoryToolServices } from './repository-tool.js';

export type { GitHubCliRunner };

export function createGitHubCliTool(
  repository: RepositoryToolServices,
  options: GitHubCliToolOptions = {},
): ToolDefinition {
  return {
    name: 'gh',
    description: githubCliToolDescription,
    parameters: githubCliToolParameters,
    async execute(params, signal) {
      return executeGitHubCliTool(toSharedRepositoryToolServices(repository), options, params, signal);
    },
  };
}
