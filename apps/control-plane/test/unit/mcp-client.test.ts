import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  connectMcpServerWithClient,
  connectMcpServerWithTransport,
  createMcpResponseLimitedFetch,
  createMcpToolName,
  createStreamableHttpMcpFetch,
} from '../../src/mcp/client.js';
import type { McpServerConfig } from '../../src/mcp/types.js';

describe('connectMcpServer', () => {
  it('lists paginated tools over an in-memory MCP connection and calls them', async () => {
    const { server, clientTransport } = await createInMemoryMcpServer();
    const connection = await connectMcpServerWithTransport(
      { name: 'executor prod', url: 'https://executor.example/mcp', transport: 'streamable-http' },
      clientTransport,
      { connectTimeoutMs: 100, toolTimeoutMs: 100, toolResultMaxChars: 10_000 },
    );

    try {
      expect(connection.tools).toMatchObject([
        {
          name: 'mcp__executor_prod__first_tool',
          originalName: 'first.tool',
          description: 'MCP tool "first.tool" from server "executor prod". Title: First Tool. First description',
          parameters: { type: 'object', properties: {}, required: ['query'] },
        },
        {
          name: 'mcp__executor_prod__second-tool',
          originalName: 'second-tool',
          parameters: { type: 'object', properties: {} },
        },
      ]);

      await expect(connection.callTool('first.tool', { query: 'hello' })).resolves.toBe('first: hello');
    } finally {
      await connection.close();
      await server.close();
    }
  });

  it('filters allowed tools by original MCP tool name', async () => {
    const client = fakeClient({
      tools: [
        { name: 'execute', inputSchema: { type: 'object' } },
        { name: 'blocked', inputSchema: { type: 'object' } },
      ],
    });

    const connection = await connectMcpServerWithClient(
      {
        name: 'executor',
        url: 'https://executor.example/mcp',
        transport: 'streamable-http',
        allowedTools: ['execute'],
      },
      client,
      {} as Transport,
    );

    expect(connection.tools.map((tool) => tool.name)).toEqual(['mcp__executor__execute']);
  });

  it('suffixes duplicate adapted tool names instead of dropping the server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = fakeClient({
      tools: [
        { name: 'a/b', inputSchema: { type: 'object' } },
        { name: 'a b', inputSchema: { type: 'object' } },
        { name: 'a_b_2', inputSchema: { type: 'object' } },
      ],
    });

    const connection = await connectMcpServerWithClient(
      { name: 's', url: 'https://executor.example/mcp', transport: 'streamable-http' },
      client,
      {} as Transport,
    );

    expect(connection.tools.map((tool) => tool.name)).toEqual(['mcp__s__a_b', 'mcp__s__a_b_2', 'mcp__s__a_b_2_2']);
    expect(warn).toHaveBeenCalledWith(
      'MCP server "s" renamed duplicate adapted tool "mcp__s__a_b" to "mcp__s__a_b_2".',
    );
    warn.mockRestore();
  });

  it('formats structured content and all MCP content block types', async () => {
    const client = fakeClient({
      tools: [{ name: 'format', inputSchema: { type: 'object' } }],
      result: {
        structuredContent: { ok: true },
        content: [
          { type: 'text', text: 'text content' },
          { type: 'image', mimeType: 'image/png', data: 'abcd' },
          { type: 'audio', mimeType: 'audio/wav', data: 'abcde' },
          { type: 'resource', resource: { uri: 'file:///text.txt', text: 'resource text' } },
          { type: 'resource', resource: { uri: 'file:///blob.bin', blob: 'abcdef' } },
          { type: 'resource_link', name: 'docs', uri: 'https://example.test/docs', description: 'Docs' },
        ],
      },
    });
    const connection = await connectMcpServerWithClient(testConfig(), client, {} as Transport);

    await expect(connection.callTool('format', {})).resolves.toContain('Structured content:\n{\n  "ok": true\n}');
    const result = await connection.callTool('format', {});
    expect(result).toContain('text content');
    expect(result).toContain('[Image: image/png, 4 base64 chars]');
    expect(result).toContain('[Audio: audio/wav, 5 base64 chars]');
    expect(result).toContain('[Resource: file:///text.txt]\nresource text');
    expect(result).toContain('[Resource: file:///blob.bin, 6 base64 chars]');
    expect(result).toContain('[Resource link: docs (https://example.test/docs) - Docs]');
  });

  it('throws MCP isError results and truncates oversized output', async () => {
    const client = fakeClient({
      tools: [{ name: 'bad', inputSchema: { type: 'object' } }],
      result: { isError: true, content: [{ type: 'text', text: '0123456789abcdef' }] },
    });
    const connection = await connectMcpServerWithClient(testConfig(), client, {} as Transport, {
      toolResultMaxChars: 5,
    });

    await expect(connection.callTool('bad', {})).rejects.toThrow(
      '01234\n\n[truncated: MCP tool result exceeded 5 characters]',
    );
  });

  it('applies per-call timeout signals', async () => {
    const client = fakeClient({
      tools: [{ name: 'slow', inputSchema: { type: 'object' } }],
      callTool: async (_params, _schema, options) => {
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true });
        });
        return { content: [{ type: 'text', text: 'late' }] };
      },
    });
    const connection = await connectMcpServerWithClient(testConfig(), client, {} as Transport, { toolTimeoutMs: 1 });

    await expect(connection.callTool('slow', {})).rejects.toThrow('MCP tool "slow" from server "executor" failed');
  });

  it('surfaces oversized transport responses as redacted tool errors', async () => {
    const limitedFetch = createMcpResponseLimitedFetch(async () => new Response('0123456789'), { responseMaxBytes: 5 });
    const client = fakeClient({
      tools: [{ name: 'huge', inputSchema: { type: 'object' } }],
      callTool: async () => {
        const response = await limitedFetch('https://executor.example/mcp');
        await response.text();
        return { content: [{ type: 'text', text: 'unreachable' }] };
      },
    });
    const connection = await connectMcpServerWithClient(testConfig(), client, {} as Transport);

    await expect(connection.callTool('huge', {})).rejects.toThrow(
      'MCP tool "huge" from server "executor" failed (response_too_large).',
    );
  });

  it('redacts formatter failures from pathological structured content', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const client = fakeClient({
      tools: [{ name: 'format-bomb', inputSchema: { type: 'object' } }],
      result: { structuredContent: circular, content: [] },
    });
    const connection = await connectMcpServerWithClient(testConfig(), client, {} as Transport);

    await expect(connection.callTool('format-bomb', {})).rejects.toThrow(
      'MCP tool "format-bomb" from server "executor" failed (unknown).',
    );
    await expect(connection.callTool('format-bomb', {})).rejects.not.toThrow('circular');
  });

  it('redacts connection failures and closes the client', async () => {
    const close = vi.fn(async () => {});
    const client = fakeClient({ connectError: new Error('secret-token leaked by transport'), close });

    await expect(connectMcpServerWithClient(testConfig(), client, {} as Transport)).rejects.toThrow(
      'MCP server "executor" connection failed (unknown).',
    );
    await expect(connectMcpServerWithClient(testConfig(), client, {} as Transport)).rejects.not.toThrow('secret-token');
    expect(close).toHaveBeenCalled();
  });

  it('classifies safe HTTP connection failures without leaking response bodies', async () => {
    const client = fakeClient({ connectError: new Error('HTTP 401 body includes secret-token') });

    await expect(connectMcpServerWithClient(testConfig(), client, {} as Transport)).rejects.toThrow(
      'MCP server "executor" connection failed (unauthorized).',
    );
    await expect(connectMcpServerWithClient(testConfig(), client, {} as Transport)).rejects.not.toThrow('secret-token');
  });

  it('rejects unbounded listTools pagination by count', async () => {
    const close = vi.fn(async () => {});
    const client = fakeClient({
      tools: Array.from({ length: 1_001 }, (_, index) => ({ name: `tool-${index}`, inputSchema: { type: 'object' } })),
      close,
    });

    await expect(connectMcpServerWithClient(testConfig(), client, {} as Transport)).rejects.toThrow(
      'MCP server "executor" listed more than 1000 tools.',
    );
    expect(close).toHaveBeenCalled();
  });

  it('creates stable adapted names with sanitization', () => {
    expect(createMcpToolName('executor prod', 'tools.search')).toBe('mcp__executor_prod__tools_search');
  });

  it('disables standalone streamable-HTTP GET without blocking POST or stream resumption GET requests', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const wrapped = createStreamableHttpMcpFetch(fetchImpl);

    await expect(wrapped('https://executor.example/mcp', { method: 'GET' })).resolves.toMatchObject({ status: 405 });
    await expect(wrapped('https://executor.example/mcp', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
    await expect(
      wrapped('https://executor.example/mcp', { method: 'GET', headers: { 'last-event-id': 'event-1' } }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('enforces the response byte cap while reading response bodies', async () => {
    const wrapped = createMcpResponseLimitedFetch(async () => new Response('0123456789'), { responseMaxBytes: 5 });
    const response = await wrapped('https://executor.example/mcp');

    await expect(response.text()).rejects.toThrow('MCP response exceeded 5 bytes.');
  });
});

async function createInMemoryMcpServer() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (request.params?.cursor === 'page-2') {
      return {
        tools: [
          {
            name: 'second-tool',
            inputSchema: { type: 'object' },
          },
        ],
      };
    }
    return {
      tools: [
        {
          name: 'first.tool',
          title: 'First Tool',
          description: 'First description',
          inputSchema: { type: 'object', required: ['query'] },
        },
      ],
      nextCursor: 'page-2',
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return { content: [{ type: 'text', text: `first: ${String(request.params.arguments?.query ?? '')}` }] };
  });
  await server.connect(serverTransport);
  return { server, clientTransport };
}

function testConfig(): McpServerConfig {
  return { name: 'executor', url: 'https://executor.example/mcp', transport: 'streamable-http' };
}

function fakeClient(options: {
  tools?: Array<{ name: string; title?: string; description?: string; inputSchema: Record<string, unknown> }>;
  result?: unknown;
  connectError?: Error;
  close?: () => Promise<void>;
  callTool?: Client['callTool'];
}): Client {
  return {
    async connect() {
      if (options.connectError) throw options.connectError;
    },
    async listTools() {
      return { tools: options.tools ?? [] };
    },
    callTool:
      options.callTool ??
      (async () => {
        return options.result ?? { content: [{ type: 'text', text: 'ok' }] };
      }),
    close: options.close ?? vi.fn(async () => {}),
  } as unknown as Client;
}
