import type { ToolDefinition } from '@flue/runtime';
import {
  environmentToolDescription,
  environmentToolParameters,
  executeEnvironmentTool,
  type EnvironmentToolServices,
} from '../environments/tool.js';

export function createEnvironmentTool(services: EnvironmentToolServices): ToolDefinition {
  return {
    name: 'environment',
    description: environmentToolDescription,
    parameters: environmentToolParameters,
    async execute(params) {
      return executeEnvironmentTool(services, params);
    },
  };
}
