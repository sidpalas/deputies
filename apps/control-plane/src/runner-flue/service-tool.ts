import type { ToolDefinition } from '@flue/runtime';
import {
  executeServiceTool,
  serviceToolDescription,
  serviceToolParameters,
  type ServiceToolServices,
} from '../sessions/service-tool.js';

export type { ServiceToolServices } from '../sessions/service-tool.js';

export function createServiceTool(services: ServiceToolServices): ToolDefinition {
  return {
    name: 'service',
    description: serviceToolDescription,
    parameters: serviceToolParameters,
    async execute(params) {
      return JSON.stringify(await executeServiceTool(services, params));
    },
  };
}
