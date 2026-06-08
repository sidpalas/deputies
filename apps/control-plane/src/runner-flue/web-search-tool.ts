import type { ToolDefinition } from '@flue/runtime';
import {
  executeWebSearchTool,
  webSearchToolDescription,
  webSearchToolParameters,
  type WebSearchToolServices,
} from '../web-search/tool.js';

export type { WebSearchToolServices } from '../web-search/tool.js';

export function createWebSearchTool(services: WebSearchToolServices): ToolDefinition {
  return {
    name: 'web_search',
    description: webSearchToolDescription,
    parameters: webSearchToolParameters,
    async execute(params, signal) {
      return (await executeWebSearchTool(services, params, signal)).text;
    },
  };
}
