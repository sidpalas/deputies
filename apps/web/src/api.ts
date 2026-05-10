export type ApiAuthMode = 'none' | 'bearer' | 'session';
export type AuthProvider = 'static' | 'github';

export type Health = {
  status: 'ok';
  runMode: string;
  apiAuthMode: ApiAuthMode;
  authProvider?: AuthProvider;
  sandboxProvider?: string;
};

export type Session = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  queuePausedAt?: string;
  context?: Record<string, unknown>;
};

export type Message = {
  id: string;
  sessionId: string;
  sequence: number;
  status: string;
  prompt: string;
  createdAt: string;
  source?: string;
  context?: Record<string, unknown>;
};

export type RepositoryInput = {
  provider: 'github';
  owner: string;
  repo: string;
};

export type AgentEvent = {
  id?: number;
  sessionId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  runId?: string;
  messageId?: string;
};

export type Artifact = {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  title?: string;
  url?: string;
};

export type CallbackDelivery = {
  id: string;
  sessionId: string;
  targetType: string;
  target: Record<string, unknown>;
  status: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  messageId?: string;
  lastError?: string;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
};

export type AuthUser = {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const requestTimeoutMs = 15_000;
const requestRetryDelayMs = 250;
export const apiConnectionOkEvent = 'deputies:api-connection-ok';
export const apiConnectionDelayedEvent = 'deputies:api-connection-delayed';

export function getApiBaseUrl(): string {
  return apiBaseUrl || window.location.origin;
}

export async function getHealth(): Promise<Health> {
  return request<Health>('/health');
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const body = await request<{ user: AuthUser | null }>('/auth/me');
  return body.user;
}

export async function login(input: { username: string; password: string }): Promise<AuthUser> {
  const body = await request<{ user: AuthUser }>('/auth/login', {
    method: 'POST',
    body: { username: input.username, password: input.password },
  });
  return body.user;
}

export function githubLoginUrl(): string {
  return `${apiBaseUrl}/auth/oauth/github/start`;
}

export async function logout(): Promise<void> {
  await request<{ ok: true }>('/auth/logout', { method: 'POST', body: {} });
}

export async function listSessions(token: string): Promise<Session[]> {
  const body = await request<{ sessions: Session[] }>('/sessions', { token });
  return body.sessions;
}

export async function createSession(input: { title?: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>('/sessions', {
    method: 'POST',
    token: input.token,
    body: input.title ? { title: input.title } : {},
  });
  return body.session;
}

export async function updateSession(input: { sessionId: string; title: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}`, {
    method: 'PATCH',
    token: input.token,
    body: { title: input.title },
  });
  return body.session;
}

export async function archiveSession(input: { sessionId: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}/archive`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.session;
}

export async function unarchiveSession(input: { sessionId: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}/unarchive`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.session;
}

export async function listMessages(sessionId: string, token: string): Promise<Message[]> {
  const body = await request<{ messages: Message[] }>(`/sessions/${sessionId}/messages`, { token });
  return body.messages;
}

export async function enqueueMessage(input: { sessionId: string; prompt: string; token: string; repository?: string | RepositoryInput }): Promise<Message> {
  const requestBody: { prompt: string; repository?: string | RepositoryInput } = { prompt: input.prompt };
  if (input.repository) requestBody.repository = input.repository;
  const body = await request<{ message: Message }>(`/sessions/${input.sessionId}/messages`, {
    method: 'POST',
    token: input.token,
    body: requestBody,
  });
  return body.message;
}

export async function updateMessage(input: { sessionId: string; messageId: string; prompt: string; token: string }): Promise<Message> {
  const body = await request<{ message: Message }>(`/sessions/${input.sessionId}/messages/${input.messageId}`, {
    method: 'PATCH',
    token: input.token,
    body: { prompt: input.prompt },
  });
  return body.message;
}

export async function cancelMessage(input: { sessionId: string; messageId: string; token: string }): Promise<Message> {
  const body = await request<{ message: Message }>(`/sessions/${input.sessionId}/messages/${input.messageId}/cancel`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.message;
}

export async function cancelCurrentRun(input: { sessionId: string; token: string }): Promise<Message[]> {
  const body = await request<{ messages: Message[] }>(`/sessions/${input.sessionId}/runs/current/cancel`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.messages;
}

export async function pauseQueue(input: { sessionId: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}/queue/pause`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.session;
}

export async function resumeQueue(input: { sessionId: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}/queue/resume`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.session;
}

export async function listEvents(sessionId: string, token: string, after?: number): Promise<AgentEvent[]> {
  const body = await request<{ events: AgentEvent[] }>(`/sessions/${sessionId}/events${after ? `?after=${after}` : ''}`, { token });
  return body.events;
}

export async function listArtifacts(sessionId: string, token: string): Promise<Artifact[]> {
  const body = await request<{ artifacts: Artifact[] }>(`/sessions/${sessionId}/artifacts`, { token });
  return body.artifacts;
}

export async function listCallbacks(sessionId: string, token: string): Promise<CallbackDelivery[]> {
  const body = await request<{ callbacks: CallbackDelivery[] }>(`/sessions/${sessionId}/callbacks`, { token });
  return body.callbacks;
}

export async function replayCallback(input: { sessionId: string; callbackId: string; token: string }): Promise<CallbackDelivery> {
  const body = await request<{ callback: CallbackDelivery }>(`/sessions/${input.sessionId}/callbacks/${input.callbackId}/replay`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.callback;
}

export async function streamEvents(input: {
  sessionId: string;
  after: number;
  token: string;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  await streamEventResponse(`/sessions/${input.sessionId}/events/stream?after=${input.after}`, input);
}

export async function streamGlobalEvents(input: {
  after: number;
  token: string;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  await streamEventResponse(`/events/stream?after=${input.after}&include=all&replay=false`, input);
}

async function streamEventResponse(
  path: string,
  input: {
    token: string;
    signal: AbortSignal;
    onEvent: (event: AgentEvent) => void;
  },
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      headers: authHeaders(input.token),
      credentials: 'include',
      signal: input.signal,
    });
  } catch (error) {
    if (!input.signal.aborted) dispatchApiConnectionDelayed('Realtime connection interrupted.');
    throw error;
  }

  if (!response.ok) {
    dispatchApiConnectionDelayed(`Realtime connection failed with ${response.status}.`);
    throw new ApiError(response.status, `Event stream failed with ${response.status}`);
  }
  if (!response.body) throw new ApiError(response.status, 'Event stream response has no body');
  dispatchApiConnectionOk('stream');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!input.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = parseSseData(frame);
        if (data) input.onEvent(JSON.parse(data) as AgentEvent);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    if (input.signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function request<T>(path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
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

async function requestOnce<T>(path: string, options: { method: string; token?: string; body?: unknown }): Promise<T> {
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), requestTimeoutMs);
  const requestInit: RequestInit = {
    method: options.method,
    credentials: 'include',
    cache: 'no-store',
    signal: abort.signal,
    headers: {
      ...authHeaders(options.token ?? ''),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
  };
  if (options.body) requestInit.body = JSON.stringify(options.body);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, requestInit);
  } catch (error) {
    if (abort.signal.aborted) {
      dispatchApiConnectionDelayed(`Request timed out: ${path}`);
      throw new ApiError(0, `Request timed out: ${path}`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    const message = isErrorBody(body) ? body.message : `Request failed with ${response.status}`;
    throw new ApiError(response.status, message);
  }

  dispatchApiConnectionOk('request');
  return (await response.json()) as T;
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

function isErrorBody(value: unknown): value is { message: string } {
  if (!value || typeof value !== 'object') return false;
  return 'message' in value && typeof (value as { message?: unknown }).message === 'string';
}
