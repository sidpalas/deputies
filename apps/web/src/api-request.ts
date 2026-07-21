export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const requestTimeoutMs = 15_000;
const requestRetryDelayMs = 250;
const streamIdleTimeoutMs = 45_000;

export const apiConnectionOkEvent = 'deputies:api-connection-ok';
export const apiConnectionDelayedEvent = 'deputies:api-connection-delayed';

export type RequestOptions = { traceparent?: string; signal?: AbortSignal };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function getApiBaseUrl(): string {
  return apiBaseUrl || window.location.origin;
}

export async function request<T>(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    traceparent?: string;
    signal?: AbortSignal;
    expectJson?: boolean;
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const attempts = method === 'GET' ? 2 : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOnce<T>(path, { ...options, method });
    } catch (error) {
      const retryableTimeout = error instanceof ApiError && error.status === 0 && attempt < attempts;
      if (!retryableTimeout) throw error;
      await delay(requestRetryDelayMs);
    }
  }

  throw new ApiError(0, `Request failed: ${path}`);
}

export async function streamEventResponse<TEvent>(
  path: string,
  input: {
    token: string;
    signal: AbortSignal;
    onOpen?: () => void;
    onEvent: (event: TEvent) => void;
  },
): Promise<void> {
  const abort = new AbortController();
  let idleTimedOut = false;
  let idleTimeout: number | undefined;
  const abortStream = () => abort.abort();
  input.signal.addEventListener('abort', abortStream, { once: true });
  const resetIdleTimeout = () => {
    if (idleTimeout !== undefined) window.clearTimeout(idleTimeout);
    idleTimeout = window.setTimeout(() => {
      idleTimedOut = true;
      abort.abort();
    }, streamIdleTimeoutMs);
  };

  let response: Response;
  try {
    resetIdleTimeout();
    response = await fetch(`${apiBaseUrl}${path}`, {
      headers: authHeaders(input.token),
      credentials: 'include',
      signal: abort.signal,
    });
  } catch (error) {
    if (!input.signal.aborted)
      dispatchApiConnectionDelayed(
        idleTimedOut ? 'Realtime connection went idle.' : 'Realtime connection interrupted.',
      );
    throw error;
  }

  if (!response.ok) {
    dispatchApiConnectionDelayed(`Realtime connection failed with ${response.status}.`);
    throw new ApiError(response.status, `Event stream failed with ${response.status}`);
  }
  if (!response.body) throw new ApiError(response.status, 'Event stream response has no body');
  input.onOpen?.();
  dispatchApiConnectionOk('stream');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    try {
      while (!input.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        resetIdleTimeout();
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = parseSseData(frame);
          if (data) input.onEvent(JSON.parse(data) as TEvent);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!idleTimedOut) throw error;
    }
    if (idleTimedOut) {
      dispatchApiConnectionDelayed('Realtime connection went idle.');
      throw new ApiError(0, 'Realtime connection went idle');
    }
  } finally {
    if (idleTimeout !== undefined) window.clearTimeout(idleTimeout);
    input.signal.removeEventListener('abort', abortStream);
    if (input.signal.aborted || abort.signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function requestOnce<T>(
  path: string,
  options: {
    method: string;
    token?: string;
    body?: unknown;
    traceparent?: string;
    signal?: AbortSignal;
    expectJson?: boolean;
    keepalive?: boolean;
  },
): Promise<T> {
  const abort = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, requestTimeoutMs);
  const abortRequest = () => abort.abort();
  if (options.signal?.aborted) abort.abort();
  else options.signal?.addEventListener('abort', abortRequest, { once: true });
  const requestInit: RequestInit = {
    method: options.method,
    credentials: 'include',
    cache: 'no-store',
    signal: abort.signal,
    headers: {
      ...authHeaders(options.token ?? ''),
      ...(options.traceparent ? { traceparent: options.traceparent } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
  };
  if (options.keepalive !== undefined) requestInit.keepalive = options.keepalive;
  if (options.body) requestInit.body = JSON.stringify(options.body);

  try {
    const response = await fetch(`${apiBaseUrl}${path}`, requestInit);

    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      const message = isErrorBody(body) ? body.message : `Request failed with ${response.status}`;
      const code = isErrorBody(body) && typeof body.error === 'string' ? body.error : undefined;
      throw new ApiError(response.status, message, code);
    }

    dispatchApiConnectionOk('request');
    if (options.expectJson === false) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    if (timedOut) {
      dispatchApiConnectionDelayed(`Request timed out: ${path}`);
      throw new ApiError(0, `Request timed out: ${path}`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortRequest);
  }
}

function dispatchApiConnectionOk(source: 'request' | 'stream') {
  window.dispatchEvent(new CustomEvent(apiConnectionOkEvent, { detail: { source } }));
}

function dispatchApiConnectionDelayed(message: string) {
  window.dispatchEvent(new CustomEvent(apiConnectionDelayedEvent, { detail: { message } }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function authHeaders(token: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function parseSseData(frame: string): string | null {
  const lines = frame.replace(/\r\n/g, '\n').split('\n');
  const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart());
  return dataLines.length ? dataLines.join('\n') : null;
}

function isErrorBody(value: unknown): value is { message: string; error?: unknown } {
  if (!value || typeof value !== 'object') return false;
  return 'message' in value && typeof (value as { message?: unknown }).message === 'string';
}
