import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  executeRepositoryTool,
  repositoryToolDescription,
  repositoryToolParameters,
  type RepositoryToolServices,
} from '../repositories/tool.js';

const piRepositoryToolParameters = repositoryToolParameters as unknown as ToolDefinition['parameters'];

export function createPiRepositoryToolDefinition(services: RepositoryToolServices): ToolDefinition {
  return {
    name: 'repository',
    label: 'repository',
    description: repositoryToolDescription,
    promptSnippet: 'Select, inspect, and prepare the active GitHub repository for this session',
    promptGuidelines: [
      'Before doing repository-specific work, use repository({ action: "status" }) to inspect the active repo.',
      'If a repository is already active and the user did not ask to switch, use it.',
      'If the user clearly names or chooses a repo for ongoing work, use repository({ action: "set", owner, repo, reason }) and then repository({ action: "prepare" }) in the same turn.',
      'If the repo is unclear, use repository({ action: "list" }) and ask the user to choose instead of guessing.',
      'Use repository({ action: "prepare" }) before reading or editing files in the repo.',
    ],
    parameters: piRepositoryToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const text = await executeRepositoryTool(services, params as Record<string, unknown>);
      return { content: [{ type: 'text', text }], details: { text } };
    },
  };
}
