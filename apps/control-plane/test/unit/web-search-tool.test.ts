import { executeWebSearchTool, type WebSearchToolServices } from '../../src/web-search/tool.js';

describe('web search tool', () => {
  it('uses DuckDuckGo HTML search without an API key', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      htmlResponse(`
        <html><body>
          <div class="result">
            <a class="result__a" href="/l/?uddg=${encodeURIComponent('https://example.com/docs')}">Example &amp; Docs</a>
            <a class="result__snippet">Useful &amp; current docs</a>
          </div>
        </body></html>
      `),
    );

    const result = await executeWebSearchTool(services({ fetch: fetchImpl }), {
      action: 'search',
      query: 'example docs',
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('https://html.duckduckgo.com/html/');
    expect(result.text).toContain('Provider: duckduckgo');
    expect(result.text).toContain('Title: Example & Docs');
    expect(result.text).toContain('Link: https://example.com/docs');
    expect(result.text).toContain('Snippet: Useful & current docs');
    expect(result.details).toMatchObject({ provider: 'duckduckgo', resultCount: 1 });
  });

  it('uses Brave Search when auto provider has a Brave API key', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        web: {
          results: [
            {
              title: 'Brave Result',
              url: 'https://example.com/brave',
              description: 'From Brave Search',
              age: '2 days ago',
            },
          ],
        },
      }),
    );

    const result = await executeWebSearchTool(services({ fetch: fetchImpl, braveApiKey: 'brave-key' }), {
      action: 'search',
      query: 'brave docs',
      count: 3,
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain('https://api.search.brave.com/res/v1/web/search?');
    expect(String(url)).toContain('q=brave+docs');
    expect((init?.headers as Record<string, string>)['x-subscription-token']).toBe('brave-key');
    expect(result.text).toContain('Provider: brave');
    expect(result.text).toContain('Title: Brave Result');
    expect(result.text).toContain('Age: 2 days ago');
    expect(result.details).toMatchObject({ provider: 'brave', resultCount: 1 });
  });

  it('fetches readable public page content', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      htmlResponse(`
        <html>
          <head><title>Example Article</title></head>
          <body><nav>menu</nav><main><h1>Article</h1><p>Hello <strong>world</strong>.</p></main></body>
        </html>
      `),
    );

    const result = await executeWebSearchTool(
      services({
        fetch: fetchImpl,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      }),
      { action: 'fetch', url: 'https://example.com/article' },
    );

    expect(result.text).toContain('URL: https://example.com/article');
    expect(result.text).toContain('Title: Example Article');
    expect(result.text).toContain('Article\nHello world.');
  });

  it('blocks private and local URLs when fetching page content', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      htmlResponse('<html></html>'),
    );

    await expect(
      executeWebSearchTool(
        services({
          fetch: fetchImpl,
          lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        }),
        { action: 'fetch', url: 'https://internal.example/page' },
      ),
    ).rejects.toThrow('Refusing to fetch private or local URL');
    await expect(
      executeWebSearchTool(services({ fetch: fetchImpl }), { action: 'fetch', url: 'http://localhost:5173' }),
    ).rejects.toThrow('Refusing to fetch private or local URL');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a Brave key when Brave is explicitly selected', async () => {
    await expect(
      executeWebSearchTool(services({ provider: 'brave' }), { action: 'search', query: 'docs' }),
    ).rejects.toThrow('WEB_SEARCH_BRAVE_API_KEY or BRAVE_API_KEY is required');
  });
});

function services(overrides: Partial<WebSearchToolServices> = {}): WebSearchToolServices {
  return {
    provider: 'auto',
    maxResults: 10,
    contentMaxChars: 5_000,
    timeoutMs: 10_000,
    ...overrides,
  };
}

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
