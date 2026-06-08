import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  executeWebSearchTool,
  webSearchToolDescription,
  webSearchToolParameters,
  type WebSearchToolServices,
} from '../web-search/tool.js';

const piWebSearchToolParameters = webSearchToolParameters as unknown as ToolDefinition['parameters'];

export function createPiWebSearchToolDefinition(services: WebSearchToolServices): ToolDefinition {
  return {
    name: 'web_search',
    label: 'web_search',
    description: webSearchToolDescription,
    promptSnippet: 'Search the public web or fetch readable content from public URLs',
    promptGuidelines: [
      'Use web_search({ action: "search", query }) for current documentation, facts, APIs, package versions, and other public web lookups.',
      'Use web_search({ action: "fetch", url }) to read a specific public page found in search results or provided by the user.',
      'Prefer authoritative sources and include source URLs in your reasoning or final answer when web results affect the answer.',
    ],
    parameters: piWebSearchToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      const result = await executeWebSearchTool(services, params as Record<string, unknown>, signal);
      return { content: [{ type: 'text', text: result.text }], details: result.details };
    },
  };
}
