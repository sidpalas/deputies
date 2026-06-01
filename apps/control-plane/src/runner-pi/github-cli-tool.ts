import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  executeGitHubCliTool,
  githubCliToolDescription,
  githubCliToolParameters,
  type GitHubCliToolOptions,
} from '../repositories/github-cli-tool.js';
import type { RepositoryToolServices } from '../repositories/tool.js';

const piGitHubCliToolParameters = githubCliToolParameters as unknown as ToolDefinition['parameters'];

export function createPiGitHubCliToolDefinition(
  repository: RepositoryToolServices,
  options: GitHubCliToolOptions = {},
): ToolDefinition {
  return {
    name: 'gh',
    label: 'gh',
    description: githubCliToolDescription,
    promptSnippet: 'Run authenticated GitHub issue, PR, and API operations for the active repository',
    promptGuidelines: [
      'Use gh({ args }) for GitHub issues, pull requests, and repository API operations after repository({ action: "status" }) confirms an active repository.',
      'Pass only gh arguments, not the gh executable name.',
      'Do not post issue or pull request comments directly; return the final response normally so the callback layer posts once.',
    ],
    parameters: piGitHubCliToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      const text = await executeGitHubCliTool(repository, options, params as Record<string, unknown>, signal);
      return { content: [{ type: 'text', text }], details: { text } };
    },
  };
}
