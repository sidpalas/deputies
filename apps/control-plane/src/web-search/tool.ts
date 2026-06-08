import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

export type WebSearchProviderKind = 'auto' | 'brave' | 'duckduckgo';

export type WebSearchToolServices = {
  provider: WebSearchProviderKind;
  braveApiKey?: string;
  maxResults: number;
  contentMaxChars: number;
  timeoutMs: number;
  fetch?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
};

export type WebSearchToolResult = {
  text: string;
  details?: Record<string, unknown>;
};

type ResolvedWebSearchProviderKind = 'brave' | 'duckduckgo';

type WebSearchInput =
  | {
      action: 'search';
      query: string;
      count: number;
      requestedCount?: number;
      fetchContent: boolean;
      country: string;
      freshness?: string;
    }
  | {
      action: 'fetch';
      url: string;
    };

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  age?: string;
  content?: string;
  contentTruncated?: boolean;
};

type PageContent = {
  url: string;
  title?: string;
  content: string;
  status?: number;
  contentType?: string;
  truncated: boolean;
};

const defaultSearchResultCount = 5;
const hardSearchResultLimit = 20;
const defaultUserAgent = 'Deputies Web Search/1.0';

export const webSearchToolDescription = [
  'Search the public web or fetch readable content from a public URL.',
  'Uses Brave Search when configured with an API key, otherwise DuckDuckGo HTML search can run without a key.',
  'Private, loopback, and local-network URLs are blocked when fetching page content.',
].join(' ');

export const webSearchToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['search', 'fetch'],
      description: 'Use search for a web query, or fetch to extract readable text from a known public URL.',
    },
    query: { type: 'string', description: 'Search query. Required when action is search.' },
    url: { type: 'string', description: 'Public HTTP(S) URL to fetch. Required when action is fetch.' },
    count: {
      type: 'number',
      description: `Number of search results to return. Default ${defaultSearchResultCount}, maximum ${hardSearchResultLimit}.`,
    },
    fetchContent: {
      type: 'boolean',
      description: 'When true, fetch readable content for each returned search result.',
    },
    country: { type: 'string', description: 'Two-letter country code for search localization. Default US.' },
    freshness: {
      type: 'string',
      description: 'Freshness filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD. Custom ranges require Brave.',
    },
  },
} as const;

export async function executeWebSearchTool(
  services: WebSearchToolServices,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WebSearchToolResult> {
  const input = readWebSearchInput(params, services.maxResults);

  if (input.action === 'fetch') {
    const page = await fetchReadableContent(services, input.url, signal);
    return {
      text: formatPageContent(page),
      details: compactDetails({
        action: 'fetch',
        url: page.url,
        status: page.status,
        contentType: page.contentType,
        truncated: page.truncated || undefined,
      }),
    };
  }

  const provider = resolveProvider(services);
  const results =
    provider === 'brave'
      ? await fetchBraveResults(services, input, signal)
      : await fetchDuckDuckGoResults(services, input, signal);

  if (input.fetchContent) {
    for (const result of results) {
      assertNotAborted(signal);
      const page = await fetchReadableContentResult(services, result.url, signal);
      result.content = page.content;
      if (page.truncated) result.contentTruncated = true;
    }
  }

  return {
    text: formatSearchResults(provider, input.query, results),
    details: compactDetails({
      action: 'search',
      provider,
      query: input.query,
      resultCount: results.length,
      countCapped: input.requestedCount && input.requestedCount > input.count ? input.count : undefined,
      contentFetched: input.fetchContent || undefined,
    }),
  };
}

function readWebSearchInput(params: Record<string, unknown>, serviceMaxResults: number): WebSearchInput {
  const action = typeof params.action === 'string' ? params.action : 'search';
  if (action !== 'search' && action !== 'fetch') throw new Error('web_search action must be search or fetch');

  if (action === 'fetch') {
    const url = typeof params.url === 'string' ? params.url.trim() : '';
    if (!url) throw new Error('web_search url must be a non-empty string when action=fetch');
    return { action, url };
  }

  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) throw new Error('web_search query must be a non-empty string when action=search');

  const requestedCount = readOptionalPositiveInteger(params.count, 'web_search count');
  const countLimit = Math.min(Math.max(serviceMaxResults, 1), hardSearchResultLimit);
  const count = Math.min(requestedCount ?? defaultSearchResultCount, countLimit);
  const country = readCountry(params.country);
  const freshness = readFreshness(params.freshness);

  return {
    action,
    query,
    count,
    ...(requestedCount !== undefined ? { requestedCount } : {}),
    fetchContent: params.fetchContent === true,
    country,
    ...(freshness ? { freshness } : {}),
  };
}

function readOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function readCountry(value: unknown): string {
  if (value === undefined) return 'US';
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) {
    throw new Error('web_search country must be a two-letter country code');
  }
  return value.trim().toUpperCase();
}

function readFreshness(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('web_search freshness must be a string');
  const freshness = value.trim();
  if (/^p[dwmy]$/.test(freshness) || /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(freshness)) {
    return freshness;
  }
  throw new Error('web_search freshness must be pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD');
}

function resolveProvider(services: WebSearchToolServices): ResolvedWebSearchProviderKind {
  if (services.provider === 'auto') return services.braveApiKey ? 'brave' : 'duckduckgo';
  if (services.provider === 'brave' && !services.braveApiKey) {
    throw new Error('WEB_SEARCH_BRAVE_API_KEY or BRAVE_API_KEY is required when WEB_SEARCH_PROVIDER=brave');
  }
  return services.provider;
}

async function fetchBraveResults(
  services: WebSearchToolServices,
  input: Extract<WebSearchInput, { action: 'search' }>,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!services.braveApiKey) throw new Error('Brave Search API key is not configured');

  const params = new URLSearchParams({ q: input.query, count: input.count.toString(), country: input.country });
  if (input.freshness) params.set('freshness', input.freshness);

  const response = await fetchWithTimeout(
    services,
    `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
    {
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'x-subscription-token': services.braveApiKey,
      },
    },
    signal,
  );
  if (!response.ok) throw new Error(await httpErrorMessage('Brave Search failed', response));

  const data = asRecord(await response.json()) ?? {};
  const web = asRecord(data.web);
  const rawResults = Array.isArray(web?.results) ? web.results : [];
  const results: SearchResult[] = [];
  for (const rawResult of rawResults) {
    if (results.length >= input.count) break;
    const result = asRecord(rawResult);
    if (!result) continue;
    const url = stringValue(result.url);
    if (!url) continue;
    const searchResult: SearchResult = {
      title: cleanInlineText(stringValue(result.title)),
      url,
      snippet: cleanInlineText(stringValue(result.description)),
    };
    const age = stringValue(result.age) || stringValue(result.page_age);
    if (age) searchResult.age = age;
    results.push(searchResult);
  }
  return results;
}

async function fetchDuckDuckGoResults(
  services: WebSearchToolServices,
  input: Extract<WebSearchInput, { action: 'search' }>,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', input.query);
  url.searchParams.set('kl', `${input.country.toLowerCase()}-en`);
  const freshness = duckDuckGoFreshness(input.freshness);
  if (freshness) url.searchParams.set('df', freshness);

  const response = await fetchWithTimeout(
    services,
    url.toString(),
    {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': defaultUserAgent,
      },
    },
    signal,
  );
  if (!response.ok) throw new Error(await httpErrorMessage('DuckDuckGo search failed', response));
  const html = await response.text();
  return parseDuckDuckGoResults(html, input.count);
}

function duckDuckGoFreshness(freshness: string | undefined): string | undefined {
  switch (freshness) {
    case undefined:
      return undefined;
    case 'pd':
      return 'd';
    case 'pw':
      return 'w';
    case 'pm':
      return 'm';
    case 'py':
      return 'y';
    default:
      throw new Error('DuckDuckGo search supports freshness pd, pw, pm, or py. Use Brave for custom date ranges.');
  }
}

function parseDuckDuckGoResults(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.matchAll(
    /<div[^>]*class=["'][^"']*result[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*result[^"']*["'][^>]*>|<\/body>|$)/gi,
  );
  for (const blockMatch of blocks) {
    if (results.length >= count) break;
    const block = blockMatch[1] ?? '';
    const linkMatch = block.match(
      /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkMatch) continue;
    const url = normalizeDuckDuckGoUrl(decodeHtml(linkMatch[1] ?? ''));
    if (!url) continue;
    const snippetMatch = block.match(
      /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>|<div[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );
    results.push({
      title: cleanInlineText(linkMatch[2] ?? ''),
      url,
      snippet: cleanInlineText(snippetMatch?.[1] ?? snippetMatch?.[2] ?? ''),
    });
  }
  return results;
}

function normalizeDuckDuckGoUrl(rawUrl: string): string | null {
  try {
    const url = rawUrl.startsWith('//') ? new URL(`https:${rawUrl}`) : new URL(rawUrl, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    if (uddg) return uddg;
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    return null;
  }
  return null;
}

async function fetchReadableContentResult(
  services: WebSearchToolServices,
  url: string,
  signal?: AbortSignal,
): Promise<PageContent> {
  try {
    return await fetchReadableContent(services, url, signal);
  } catch (error) {
    assertNotAborted(signal);
    return { url, content: `(Error: ${errorMessage(error)})`, truncated: false };
  }
}

async function fetchReadableContent(
  services: WebSearchToolServices,
  url: string,
  signal?: AbortSignal,
): Promise<PageContent> {
  const { response, finalUrl } = await fetchPublicUrl(services, url, signal);
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const base = compactDetails({ status: response.status, contentType }) as Pick<PageContent, 'status' | 'contentType'>;

  if (!response.ok) {
    return { url: finalUrl, ...base, content: `(HTTP ${response.status} ${response.statusText})`, truncated: false };
  }

  if (contentType && !isReadableContentType(contentType)) {
    return { url: finalUrl, ...base, content: `(Unsupported content type: ${contentType})`, truncated: false };
  }

  const maxHtmlBytes = Math.min(Math.max(services.contentMaxChars * 4, 32_768), 1_000_000);
  const raw = await readResponseText(response, maxHtmlBytes);
  const title = isHtmlContentType(contentType) ? extractHtmlTitle(raw.text) : undefined;
  const readable = isHtmlContentType(contentType) ? htmlToReadableText(raw.text) : cleanPlainText(raw.text);
  const truncated = truncateText(readable || '(No readable content extracted)', services.contentMaxChars);
  return {
    url: finalUrl,
    ...base,
    ...(title ? { title } : {}),
    content: truncated.text,
    truncated: raw.truncated || truncated.truncated,
  };
}

function isReadableContentType(contentType: string): boolean {
  return (
    isHtmlContentType(contentType) ||
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/xml' ||
    contentType === 'application/xhtml+xml' ||
    contentType === 'application/rss+xml'
  );
}

function isHtmlContentType(contentType: string | undefined): boolean {
  return !contentType || contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

async function fetchPublicUrl(
  services: WebSearchToolServices,
  initialUrl: string,
  signal?: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let url = await assertPublicHttpUrl(services, initialUrl);

  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const response = await fetchWithTimeout(
      services,
      url.toString(),
      {
        redirect: 'manual',
        headers: {
          accept: 'text/html,text/plain,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
          'user-agent': defaultUserAgent,
        },
      },
      signal,
    );
    if (!isRedirect(response.status)) return { response, finalUrl: url.toString() };

    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: url.toString() };
    url = await assertPublicHttpUrl(services, new URL(location, url).toString());
  }

  throw new Error('Too many redirects while fetching URL');
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

async function assertPublicHttpUrl(services: WebSearchToolServices, rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be fetched');

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isBlockedHostname(hostname)) throw new Error(`Refusing to fetch private or local URL: ${rawUrl}`);

  const literalIpVersion = net.isIP(hostname);
  if (literalIpVersion) {
    if (!isPublicIp(hostname)) throw new Error(`Refusing to fetch private or local URL: ${rawUrl}`);
    return url;
  }

  const addresses = await (services.lookup ?? defaultLookup)(hostname);
  if (!addresses.length) throw new Error(`Could not resolve host: ${hostname}`);
  for (const address of addresses) {
    if (!isPublicIp(address.address)) throw new Error(`Refusing to fetch private or local URL: ${rawUrl}`);
  }
  return url;
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  return dnsLookup(hostname, { all: true, verbatim: true }) as Promise<Array<{ address: string; family: 4 | 6 }>>;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  );
}

function isPublicIp(address: string): boolean {
  const normalized = normalizeHostname(address);
  const version = net.isIP(normalized);
  if (version === 4) return isPublicIpv4(normalized);
  if (version === 6) return isPublicIpv6(normalized);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  const mappedIpv4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isPublicIpv4(mappedIpv4);
  if (lower === '::' || lower === '::1' || lower.startsWith('2001:db8')) return false;

  const firstSegment = Number.parseInt(lower.split(':')[0] || '0', 16);
  if (!Number.isFinite(firstSegment)) return false;
  if ((firstSegment & 0xfe00) === 0xfc00) return false;
  if ((firstSegment & 0xffc0) === 0xfe80) return false;
  if ((firstSegment & 0xff00) === 0xff00) return false;
  return true;
}

async function fetchWithTimeout(
  services: WebSearchToolServices,
  input: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(services.timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return (services.fetch ?? fetch)(input, { ...init, signal: combinedSignal });
}

async function readResponseText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    const truncated = truncateText(text, maxBytes);
    return { text: truncated.text, truncated: truncated.truncated };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - bytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

function htmlToReadableText(html: string): string {
  const main =
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
    html;
  return cleanPlainText(
    decodeHtml(
      main
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|svg|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    ),
  );
}

function extractHtmlTitle(html: string): string | undefined {
  const title = cleanInlineText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  return title || undefined;
}

function cleanInlineText(input: string): string {
  return cleanPlainText(decodeHtml(input.replace(/<[^>]+>/g, ' '))).replace(/\n+/g, ' ');
}

function cleanPlainText(input: string): string {
  return input
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtml(input: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '...',
    laquo: '"',
    ldquo: '"',
    lsaquo: "'",
    lsquo: "'",
    lt: '<',
    mdash: '-',
    nbsp: ' ',
    ndash: '-',
    quot: '"',
    raquo: '"',
    rdquo: '"',
    rsaquo: "'",
    rsquo: "'",
  };
  return input.replace(/&(#x[\da-f]+|#\d+|[a-z][\w]+);/gi, (entity, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return named[body.toLowerCase()] ?? entity;
  });
}

function formatSearchResults(provider: ResolvedWebSearchProviderKind, query: string, results: SearchResult[]): string {
  if (!results.length) return `No web results found for "${query}". Provider: ${provider}.`;
  const lines = [`Provider: ${provider}`, `Query: ${query}`, ''];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!;
    lines.push(`--- Result ${index + 1} ---`, `Title: ${result.title || '(untitled)'}`, `Link: ${result.url}`);
    if (result.age) lines.push(`Age: ${result.age}`);
    if (result.snippet) lines.push(`Snippet: ${result.snippet}`);
    if (result.content) {
      lines.push('Content:', result.content);
      if (result.contentTruncated) lines.push('[Content truncated]');
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function formatPageContent(page: PageContent): string {
  const lines = [`URL: ${page.url}`];
  if (page.status) lines.push(`Status: ${page.status}`);
  if (page.contentType) lines.push(`Content-Type: ${page.contentType}`);
  if (page.title) lines.push(`Title: ${page.title}`);
  lines.push('', page.content);
  if (page.truncated) lines.push('', '[Content truncated]');
  return lines.join('\n').trim();
}

function compactDetails(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(maxChars, 0)).trimEnd(), truncated: true };
}

async function httpErrorMessage(prefix: string, response: Response): Promise<string> {
  const body = truncateText(await response.text().catch(() => ''), 500).text;
  return `${prefix} with HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
