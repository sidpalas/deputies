import { classifyMcpError } from './client.js';

export function mcpUnavailableNote(serverName: string): string {
  return `Note: MCP tools from server "${serverName}" are unavailable this run.`;
}

export function logMcpUnavailable(serverName: string, error: unknown): void {
  console.warn(`MCP server "${serverName}" is unavailable this run (${classifyMcpError(error)}).`);
}

export async function closeMcpConnections(connections: Array<{ name: string; close(): Promise<void> }>): Promise<void> {
  const results = await Promise.allSettled(connections.map((connection) => connection.close()));
  for (let index = 0; index < results.length; index += 1) {
    if (results[index]?.status === 'rejected') console.warn(`MCP server "${connections[index]?.name}" close failed.`);
  }
}
