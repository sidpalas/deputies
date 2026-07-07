import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { McpConnection } from '../mcp/types.js';

export function createPiMcpToolDefinitions(connection: McpConnection): ToolDefinition[] {
  return connection.tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      const text = await connection.callTool(tool.originalName, params as Record<string, unknown>, signal);
      return { content: [{ type: 'text', text }], details: { server: connection.name, tool: tool.originalName } };
    },
  }));
}
