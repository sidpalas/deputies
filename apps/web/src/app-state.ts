import { ApiError, type AgentEvent, type AuthUser, type Message, type ModelChoice, type Session } from './api.js';

export type ActiveProgress = { text: string; omitted: number; lastSequence?: number };
export type ActiveProgressByMessageId = Record<string, ActiveProgress>;

export type SnippetMutationContext = {
  authority: string;
  version: number;
  editorEpoch: number;
  panel: string;
  selectedSnippetId: string;
};

export function isSnippetMutationAuthoritative(
  origin: Pick<SnippetMutationContext, 'authority' | 'version'>,
  current: Pick<SnippetMutationContext, 'authority' | 'version'>,
): boolean {
  return current.authority === origin.authority && current.version === origin.version;
}

export function isSnippetMutationCurrent(origin: SnippetMutationContext, current: SnippetMutationContext): boolean {
  return (
    isSnippetMutationAuthoritative(origin, current) &&
    current.editorEpoch === origin.editorEpoch &&
    current.panel === origin.panel &&
    current.selectedSnippetId === origin.selectedSnippetId
  );
}

const activeProgressMaxChars = 20_000;

export function upsertEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (events.some((current) => current.sequence === event.sequence)) return events;
  return [...events, event].sort((a, b) => a.sequence - b.sequence);
}

export function shouldUseActiveProgressEvent(event: AgentEvent, messages: Message[]): boolean {
  return event.type === 'agent_text_delta' && Boolean(activeProgressMessageId(event, messages));
}

export function appendActiveProgress(
  progress: ActiveProgressByMessageId,
  event: AgentEvent,
): ActiveProgressByMessageId {
  const messageId = event.messageId;
  const text = event.payload.text;
  if (!messageId || typeof text !== 'string') return progress;

  const current = progress[messageId] ?? { text: '', omitted: 0 };
  if (current.lastSequence !== undefined && event.sequence <= current.lastSequence) return progress;

  const next = truncateActiveProgress(current.text + text, current.omitted);
  next.lastSequence = event.sequence;
  return { ...progress, [messageId]: next };
}

export function appendActiveProgressEvents(
  progress: ActiveProgressByMessageId,
  events: AgentEvent[],
): ActiveProgressByMessageId {
  if (events.length === 0) return progress;

  const nextProgress = { ...progress };
  for (const [messageId, messageEvents] of groupActiveProgressEvents(events)) {
    const current = nextProgress[messageId] ?? { text: '', omitted: 0 };
    let text = '';
    let lastSequence = current.lastSequence;

    for (const event of messageEvents) {
      const delta = event.payload.text;
      if (typeof delta !== 'string') continue;
      if (lastSequence !== undefined && event.sequence <= lastSequence) continue;
      text += delta;
      lastSequence = event.sequence;
    }

    if (!text) continue;
    const next = truncateActiveProgress(current.text + text, current.omitted);
    if (lastSequence !== undefined) next.lastSequence = lastSequence;
    nextProgress[messageId] = next;
  }

  return nextProgress;
}

export function omitActiveProgress(progress: ActiveProgressByMessageId, messageId: string): ActiveProgressByMessageId {
  if (!progress[messageId]) return progress;
  const { [messageId]: _removed, ...next } = progress;
  return next;
}

export function buildActiveProgress(events: AgentEvent[], messages: Message[]): ActiveProgressByMessageId {
  let progress: ActiveProgressByMessageId = {};
  for (const event of events) {
    if (shouldUseActiveProgressEvent(event, messages)) {
      progress = appendActiveProgress(progress, event);
    } else if (event.type === 'agent_response_final' && event.messageId) {
      progress = omitActiveProgress(progress, event.messageId);
    }
  }
  return progress;
}

export function filterActiveProgressEvents(events: AgentEvent[], messages: Message[]): AgentEvent[] {
  return events.filter((event) => !shouldUseActiveProgressEvent(event, messages));
}

export function activeProgressDisplayText(
  progress: ActiveProgressByMessageId,
  messages: Message[],
): Record<string, string> {
  const activeMessageIds = new Set(messages.filter(isActiveProgressMessage).map((message) => message.id));
  return Object.fromEntries(
    Object.entries(progress)
      .filter(([messageId]) => activeMessageIds.has(messageId))
      .map(([messageId, value]) => [messageId, formatActiveProgressText(value)]),
  );
}

function activeProgressMessageId(event: AgentEvent, messages: Message[]): string | null {
  if (!event.messageId || typeof event.payload.text !== 'string') return null;
  const message = messages.find((candidate) => candidate.id === event.messageId);
  return message && isActiveProgressMessage(message) ? event.messageId : null;
}

function isActiveProgressMessage(message: Message): boolean {
  return message.status === 'processing' || message.status === 'cancelling';
}

function truncateActiveProgress(text: string, omitted: number): ActiveProgress {
  if (text.length <= activeProgressMaxChars) return { text, omitted };
  const nextOmitted = omitted + text.length - activeProgressMaxChars;
  return { text: text.slice(-activeProgressMaxChars), omitted: nextOmitted };
}

function groupActiveProgressEvents(events: AgentEvent[]): Map<string, AgentEvent[]> {
  const groups = new Map<string, AgentEvent[]>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (!event.messageId) continue;
    const messageEvents = groups.get(event.messageId) ?? [];
    messageEvents.push(event);
    groups.set(event.messageId, messageEvents);
  }
  return groups;
}

function formatActiveProgressText(progress: ActiveProgress): string {
  if (progress.omitted <= 0) return progress.text;
  return `Showing latest deputy progress; ${progress.omitted.toLocaleString()} earlier characters hidden while the run is active.\n\n…${progress.text}`;
}

export function shouldRefreshSessions(eventType: string): boolean {
  return new Set([
    'session_created',
    'session_updated',
    'session_archived',
    'session_unarchived',
    'session_queue_paused',
    'session_queue_resumed',
    'message_created',
    'message_started',
    'message_completed',
    'message_failed',
    'message_cancelled',
    'run_failed',
    'run_cancelled',
    'sandbox_ready',
    'sandbox_stopped',
    'sandbox_destroyed',
  ]).has(eventType);
}

export function waitForRealtimeReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, delayMs);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export function repositoryLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const repository = value as Record<string, unknown>;
  if (repository.provider !== 'github') return null;
  const owner = typeof repository.owner === 'string' ? repository.owner : '';
  const repo = typeof repository.repo === 'string' ? repository.repo : '';
  return owner && repo ? `${owner}/${repo}` : null;
}

export function resolveSelectableModel(
  current: string,
  inherited: string,
  fallback: string,
  options: string[],
): string {
  for (const model of [current, inherited, fallback]) {
    if (model && options.includes(model)) return model;
  }
  return options[0] ?? '';
}

export function normalizeModelChoices(models: { models: string[]; modelChoices?: ModelChoice[] }): ModelChoice[] {
  return (
    models.modelChoices ??
    models.models.map((model) => ({ value: model, label: formatModelLabel(model), available: true }))
  );
}

export function modelUnavailableReason(model: string, choices: ModelChoice[]): string {
  const choice = choices.find((candidate) => candidate.value === model);
  if (!choice || choice.available) return '';
  return choice.action
    ? `${choice.unavailableReason ?? 'This model is unavailable'} ${choice.action}`
    : (choice.unavailableReason ?? 'This model is unavailable');
}

function formatModelLabel(model: string): string {
  const separator = model.indexOf('/');
  if (separator === -1) return model.replace(/-/g, ' ');

  return `${model.slice(separator + 1).replace(/-/g, ' ')} (${formatModelProvider(model.slice(0, separator))})`;
}

function formatModelProvider(provider: string): string {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'openai-codex') return 'OpenAI Codex';
  if (provider === 'opencode') return 'OpenCode Zen';
  return provider.replace(/-/g, ' ');
}

export function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 61)}...`;
}

export function sortSessionsByLastActivity(sessions: Session[]): Session[] {
  return [...sessions].sort(
    (a, b) =>
      sessionActivityTime(b) - sessionActivityTime(a) ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
      compareDescendingStrings(a.id, b.id),
  );
}

function compareDescendingStrings(left: string, right: string): number {
  if (right > left) return 1;
  if (right < left) return -1;
  return 0;
}

export function applyFrozenSessionOrder(
  sessions: Session[],
  frozenOrder: string[],
  options: { frozen: boolean; appendIds?: string[] },
): { sessions: Session[]; order: string[] } {
  if (!options.frozen || frozenOrder.length === 0) {
    const ordered = sortSessionsByLastActivity(sessions);
    return { sessions: ordered, order: ordered.map((session) => session.id) };
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const ordered = frozenOrder.flatMap((id) => {
    const session = byId.get(id);
    return session ? [session] : [];
  });
  const orderedIds = new Set(ordered.map((session) => session.id));
  const appended = (options.appendIds ?? []).flatMap((id) => {
    const session = byId.get(id);
    return session && !orderedIds.has(session.id) ? [session] : [];
  });
  const nextSessions = [...ordered, ...appended];
  return { sessions: nextSessions, order: nextSessions.map((session) => session.id) };
}

function sessionActivityTime(session: Session): number {
  return new Date(session.lastActivityAt ?? session.updatedAt).getTime();
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

export function isWorkspaceToolPreflightError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 401);
}

export function canWriteSession(user: AuthUser | null, _session: Session): boolean {
  if (!user) return false;
  return user.role === 'member' || user.role === 'admin';
}

export function upsertAuthUser(users: AuthUser[], user: AuthUser): AuthUser[] {
  const next = users.some((candidate) => candidate.id === user.id)
    ? users.map((candidate) => (candidate.id === user.id ? user : candidate))
    : [...users, user];
  return next.sort((a, b) => a.username.localeCompare(b.username));
}
