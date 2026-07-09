import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  environmentToolDescription,
  environmentToolParameters,
  executeEnvironmentTool,
  type EnvironmentToolServices,
} from '../environments/tool.js';

const piEnvironmentToolParameters = environmentToolParameters as unknown as ToolDefinition['parameters'];

export function createPiEnvironmentToolDefinition(services: EnvironmentToolServices): ToolDefinition {
  return {
    name: 'environment',
    label: 'environment',
    description: environmentToolDescription,
    promptSnippet: 'Select, inspect, or automatically resolve the environment for this session',
    promptGuidelines: [
      'Before repository-specific work without an environment, use environment({ action: "auto" }) when direct repository context is available.',
      'Auto selects only one unambiguous accessible environment. If it reports multiple matches, use environment({ action: "list" }) and ask the user to choose.',
      'After selecting an environment, use repository({ action: "status" }) to inspect its primary active repository and repository({ action: "set" }) only to move within that environment.',
    ],
    parameters: piEnvironmentToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      const text = await executeEnvironmentTool(services, params as Record<string, unknown>, signal);
      return { content: [{ type: 'text', text }], details: { text } };
    },
  };
}
