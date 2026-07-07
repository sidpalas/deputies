export type McpTransport = 'streamable-http' | 'sse';

export type McpServerConfig = {
  name: string;
  url: string;
  transport: McpTransport;
  headers?: Record<string, string>;
  allowedTools?: string[];
};

export type McpToolSpec = {
  name: string;
  originalName: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type McpConnection = {
  name: string;
  tools: McpToolSpec[];
  callTool(originalName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
};

export type McpRuntimeOptions = {
  servers: McpServerConfig[];
  connectTimeoutMs: number;
  toolTimeoutMs: number;
  toolResultMaxChars: number;
  responseMaxBytes: number;
};
