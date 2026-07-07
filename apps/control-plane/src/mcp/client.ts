import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpConnection, McpServerConfig, McpToolSpec, McpTransport } from './types.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_TOOL_RESULT_MAX_CHARS = 100_000;
const DEFAULT_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const LIST_TOOLS_MAX_TOOLS = 1_000;
const LIST_TOOLS_MAX_BYTES = 1_000_000;

const textEncoder = new TextEncoder();

type ListToolsResult = Awaited<ReturnType<Client['listTools']>>;
type ListedTool = ListToolsResult['tools'][number];
type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

export type ConnectMcpServerOptions = {
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
  toolResultMaxChars?: number;
  responseMaxBytes?: number;
  signal?: AbortSignal;
  clientName?: string;
  clientVersion?: string;
  fetch?: typeof fetch;
};

export type McpErrorCategory =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'dns_error'
  | 'timeout'
  | 'connection_refused'
  | 'protocol_error'
  | 'response_too_large'
  | 'unknown';

export type McpFetchOptions = {
  responseMaxBytes?: number;
};

export async function connectMcpServer(
  config: McpServerConfig,
  options: ConnectMcpServerOptions = {},
): Promise<McpConnection> {
  const client = createMcpClient(options);
  const transport = await createTransport(
    config.url,
    config.transport,
    config.headers,
    options.fetch,
    options.responseMaxBytes ?? DEFAULT_RESPONSE_MAX_BYTES,
  );
  return connectMcpServerWithClient(config, client, transport, options);
}

export async function connectMcpServerWithTransport(
  config: McpServerConfig,
  transport: Transport,
  options: ConnectMcpServerOptions = {},
): Promise<McpConnection> {
  return connectMcpServerWithClient(config, createMcpClient(options), transport, options);
}

export async function connectMcpServerWithClient(
  config: McpServerConfig,
  client: Client,
  transport: Transport,
  options: ConnectMcpServerOptions = {},
): Promise<McpConnection> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const connectSignal = combineSignals(options.signal, AbortSignal.timeout(connectTimeoutMs));

  try {
    await client.connect(transport, { signal: connectSignal, timeout: connectTimeoutMs });
    const listedTools = await listToolsWithCaps(client, config.name, connectSignal, connectTimeoutMs);

    const tools = createMcpToolSpecs(config, listedTools);
    const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const toolResultMaxChars = options.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;

    return {
      name: config.name,
      tools,
      async callTool(originalName, args, signal) {
        try {
          const result = await client.callTool({ name: originalName, arguments: args }, undefined, {
            signal: combineSignals(signal, AbortSignal.timeout(toolTimeoutMs)),
            timeout: toolTimeoutMs,
          });
          const text = truncateMcpResult(formatMcpResult(result), toolResultMaxChars);
          if (result.isError) throw new McpToolResultError(text);
          return text;
        } catch (error) {
          if (error instanceof McpToolResultError) throw error;
          throw redactedToolError(config.name, originalName, error);
        }
      },
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof McpSafeError) throw error;
    throw redactedConnectError(config.name, error);
  }
}

export function createMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeMcpNamePart(serverName)}__${sanitizeMcpNamePart(toolName)}`;
}

export function createStreamableHttpMcpFetch(fetchImpl?: typeof fetch, options: McpFetchOptions = {}): typeof fetch {
  return createLimitedFetch(fetchImpl ?? fetch, { ...options, blockStandaloneGet: true });
}

export function createMcpResponseLimitedFetch(fetchImpl?: typeof fetch, options: McpFetchOptions = {}): typeof fetch {
  return createLimitedFetch(fetchImpl ?? fetch, options);
}

export function classifyMcpError(error: unknown): McpErrorCategory {
  if (containsResponseTooLarge(error)) return 'response_too_large';

  const status = findHttpStatus(error);
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';

  const errorCode = findErrorCode(error);
  if (errorCode && ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA'].includes(errorCode)) return 'dns_error';
  if (errorCode === 'ECONNREFUSED') return 'connection_refused';
  if (errorCode && ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(errorCode)) {
    return 'timeout';
  }

  const name = error instanceof Error ? error.name : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (name === 'McpError' || name === 'SyntaxError' || error instanceof McpSafeError) return 'protocol_error';

  return 'unknown';
}

function createLimitedFetch(
  fetchImpl: typeof fetch,
  options: McpFetchOptions & { blockStandaloneGet?: boolean },
): typeof fetch {
  const responseMaxBytes = options.responseMaxBytes ?? DEFAULT_RESPONSE_MAX_BYTES;
  return async (input, init) => {
    const method = requestMethod(input, init);
    if (
      options.blockStandaloneGet &&
      method.toUpperCase() === 'GET' &&
      !requestHasHeader(input, init, 'last-event-id')
    ) {
      return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
    }
    const response = await fetchImpl(input, init);
    return limitResponseBody(response, responseMaxBytes);
  };
}

export function sanitizeMcpNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function createMcpClient(options: ConnectMcpServerOptions): Client {
  return new Client({
    name: options.clientName ?? 'deputies-control-plane',
    version: options.clientVersion ?? '0.0.0',
  });
}

async function createTransport(
  url: string,
  transport: McpTransport,
  headers: Record<string, string> | undefined,
  fetchImpl: typeof fetch | undefined,
  responseMaxBytes: number,
): Promise<Transport> {
  const options: { requestInit?: RequestInit; fetch?: typeof fetch } = {};
  if (headers) options.requestInit = { headers };
  const endpoint = new URL(url);
  if (transport === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    options.fetch = createMcpResponseLimitedFetch(fetchImpl, { responseMaxBytes });
    return new SSEClientTransport(endpoint, options);
  }
  options.fetch = createStreamableHttpMcpFetch(fetchImpl, { responseMaxBytes });
  return new StreamableHTTPClientTransport(endpoint, options) as unknown as Transport;
}

async function listToolsWithCaps(
  client: Client,
  serverName: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ListedTool[]> {
  let page = await client.listTools(undefined, { signal, timeout: timeoutMs });
  const listedTools: ListedTool[] = [];
  let listedBytes = 0;

  while (true) {
    for (const tool of page.tools) {
      listedTools.push(tool);
      if (listedTools.length > LIST_TOOLS_MAX_TOOLS) {
        throw new McpSafeError(`MCP server "${serverName}" listed more than ${LIST_TOOLS_MAX_TOOLS} tools.`);
      }

      listedBytes += jsonByteLength(tool);
      if (listedBytes > LIST_TOOLS_MAX_BYTES) {
        throw new McpSafeError(`MCP server "${serverName}" listed tools exceeding ${LIST_TOOLS_MAX_BYTES} bytes.`);
      }
    }

    if (page.nextCursor === undefined) return listedTools;
    page = await client.listTools({ cursor: page.nextCursor }, { signal, timeout: timeoutMs });
  }
}

function createMcpToolSpecs(config: McpServerConfig, tools: ListedTool[]): McpToolSpec[] {
  const allowed = config.allowedTools ? new Set(config.allowedTools) : null;
  const names = new Set<string>();
  const baseNameCounts = new Map<string, number>();
  return tools
    .filter((tool) => !allowed || allowed.has(tool.name))
    .map((tool) => {
      const baseName = createMcpToolName(config.name, tool.name);
      const name = uniqueMcpToolName(config.name, baseName, names, baseNameCounts);
      names.add(name);
      return {
        name,
        originalName: tool.name,
        description: createMcpToolDescription(config.name, tool),
        parameters: normalizeMcpInputSchema(tool.inputSchema),
      };
    });
}

function uniqueMcpToolName(
  serverName: string,
  baseName: string,
  names: Set<string>,
  baseNameCounts: Map<string, number>,
): string {
  if (!names.has(baseName)) return baseName;

  let suffix = (baseNameCounts.get(baseName) ?? 1) + 1;
  let candidate = `${baseName}_${suffix}`;
  while (names.has(candidate)) {
    suffix += 1;
    candidate = `${baseName}_${suffix}`;
  }
  baseNameCounts.set(baseName, suffix);
  console.warn(`MCP server "${serverName}" renamed duplicate adapted tool "${baseName}" to "${candidate}".`);
  return candidate;
}

function createMcpToolDescription(serverName: string, tool: ListedTool): string {
  const title = tool.title ?? tool.annotations?.title;
  const parts = [`MCP tool "${tool.name}" from server "${serverName}".`];
  if (title && title !== tool.name) parts.push(`Title: ${title}.`);
  if (tool.description) parts.push(tool.description);
  return parts.join(' ');
}

function normalizeMcpInputSchema(schema: ListedTool['inputSchema']): Record<string, unknown> {
  return {
    ...schema,
    type: schema.type ?? 'object',
    properties: schema.properties ?? {},
  };
}

function formatMcpResult(result: CallToolResult): string {
  const parts: string[] = [];
  if (result.structuredContent !== undefined) {
    parts.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
  }

  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (item.type === 'text') {
      parts.push(item.text);
      continue;
    }
    if (item.type === 'image') {
      parts.push(`[Image: ${item.mimeType}, ${item.data.length} base64 chars]`);
      continue;
    }
    if (item.type === 'audio') {
      parts.push(`[Audio: ${item.mimeType}, ${item.data.length} base64 chars]`);
      continue;
    }
    if (item.type === 'resource') {
      if ('text' in item.resource) parts.push(`[Resource: ${item.resource.uri}]\n${item.resource.text}`);
      else parts.push(`[Resource: ${item.resource.uri}, ${item.resource.blob.length} base64 chars]`);
      continue;
    }
    if (item.type === 'resource_link') {
      const description = item.description ? ` - ${item.description}` : '';
      parts.push(`[Resource link: ${item.name} (${item.uri})${description}]`);
      continue;
    }
    parts.push(JSON.stringify(item));
  }

  if (parts.length === 0 && 'toolResult' in result) parts.push(JSON.stringify(result.toolResult, null, 2));
  return parts.filter(Boolean).join('\n\n') || '(MCP tool returned no content)';
}

function truncateMcpResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated: MCP tool result exceeded ${maxChars} characters]`;
}

function requestMethod(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): string {
  return init?.method ?? (input instanceof Request ? input.method : 'GET');
}

function requestHasHeader(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  headerName: string,
): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return headers.has(headerName);
}

function limitResponseBody(response: Response, maxBytes: number): Response {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new McpResponseTooLargeError(maxBytes);
  if (!response.body) return response;

  const reader = response.body.getReader();
  let bytesRead = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined);
        controller.error(new McpResponseTooLargeError(maxBytes));
        return;
      }

      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function jsonByteLength(value: unknown): number {
  try {
    return textEncoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return LIST_TOOLS_MAX_BYTES + 1;
  }
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first ? AbortSignal.any([first, second]) : second;
}

class McpSafeError extends Error {}
class McpToolResultError extends Error {}
class McpResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`MCP response exceeded ${maxBytes} bytes.`);
    this.name = 'McpResponseTooLargeError';
  }
}

function redactedConnectError(serverName: string, error: unknown): Error {
  return new Error(`MCP server "${serverName}" connection failed (${classifyMcpError(error)}).`);
}

function redactedToolError(serverName: string, toolName: string, error: unknown): Error {
  return new Error(`MCP tool "${toolName}" from server "${serverName}" failed (${classifyMcpError(error)}).`);
}

function containsResponseTooLarge(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => candidate instanceof McpResponseTooLargeError);
}

function findHttpStatus(error: unknown): number | undefined {
  let status: number | undefined;
  findInErrorChain(error, (candidate) => {
    if (candidate instanceof Response) {
      status = candidate.status;
      return true;
    }
    if (isRecord(candidate)) {
      const directStatus = numericProperty(candidate, 'status') ?? numericProperty(candidate, 'statusCode');
      if (directStatus !== undefined) {
        status = directStatus;
        return true;
      }
      const response = candidate.response;
      if (isRecord(response)) {
        const responseStatus = numericProperty(response, 'status') ?? numericProperty(response, 'statusCode');
        if (responseStatus !== undefined) {
          status = responseStatus;
          return true;
        }
      }
    }
    if (candidate instanceof Error) {
      const match = candidate.message.match(/\b(401|403|404)\b/);
      if (match?.[1]) {
        status = Number(match[1]);
        return true;
      }
    }
    return false;
  });
  return status;
}

function findErrorCode(error: unknown): string | undefined {
  let code: string | undefined;
  findInErrorChain(error, (candidate) => {
    if (isRecord(candidate) && typeof candidate.code === 'string') {
      code = candidate.code;
      return true;
    }
    return false;
  });
  return code;
}

function findInErrorChain(error: unknown, predicate: (candidate: unknown) => boolean): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 6 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (predicate(current)) return true;
    current = isRecord(current) ? current.cause : undefined;
  }
  return false;
}

function numericProperty(value: Record<string, unknown>, key: string): number | undefined {
  const property = value[key];
  return typeof property === 'number' && Number.isFinite(property) ? property : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
