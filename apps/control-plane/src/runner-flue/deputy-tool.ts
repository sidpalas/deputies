import type { ToolDefinition } from '@flue/runtime';
import {
  deputyToolDescription,
  deputyToolParameters,
  executeDeputyTool,
  type DeputyToolServices,
} from '../sessions/deputy-tool.js';

export type { DeputyToolServices } from '../sessions/deputy-tool.js';

export function createDeputyTool(services: DeputyToolServices): ToolDefinition {
  return {
    name: 'deputies',
    description: deputyToolDescription,
    parameters: deputyToolParameters,
    async execute(params) {
      return JSON.stringify(await executeDeputyTool(services, params));
    },
  };
}
