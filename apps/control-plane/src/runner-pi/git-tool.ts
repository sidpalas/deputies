import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { executeGitTool, gitToolDescription, gitToolParameters } from '../repositories/git-tool.js';
import type { RepositoryToolServices } from '../repositories/tool.js';

const piGitToolParameters = gitToolParameters as unknown as ToolDefinition['parameters'];

export function createPiGitToolDefinition(repository: RepositoryToolServices): ToolDefinition {
  return {
    name: 'git',
    label: 'git',
    description: gitToolDescription,
    promptSnippet: 'Run authenticated remote git commands in the prepared repository',
    promptGuidelines: [
      'Use git({ args }) for authenticated remote git operations such as push, fetch, pull, and ls-remote after repository({ action: "prepare" }).',
      'Pass only git arguments, not the git executable name.',
      'Do not use this tool for force pushes or branch deletion.',
    ],
    parameters: piGitToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const text = await executeGitTool(repository, params as Record<string, unknown>);
      return { content: [{ type: 'text', text }], details: { text } };
    },
  };
}
