import type { KeyboardEvent, ReactNode } from 'react';
import type { Session, SetupStatusState } from '../../api.js';
import type { ConnectionStatus } from './types.js';

const connectionLimitHint =
  'If you have Deputies open in several windows, browser connection limits may block API requests.';
const wakeRecoveryMessage = 'Reconnecting after your computer was asleep or offline.';
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
  day: 'numeric',
});

const statusTextClasses: Record<string, string> = {
  active: 'text-info',
  archived: 'text-muted-foreground',
  cancelled: 'text-destructive',
  cancelling: 'text-info',
  completed: 'text-success',
  created: 'text-success',
  destroyed: 'text-destructive',
  expired: 'text-destructive',
  failed: 'text-destructive',
  idle: 'text-muted-foreground',
  missing: 'text-destructive',
  ok: 'text-success',
  pending: 'text-warning',
  processing: 'text-info',
  queued: 'text-warning',
  ready: 'text-success',
  running: 'text-info',
  skipped: 'text-warning',
  starting: 'text-info',
  stopped: 'text-warning',
  unhealthy: 'text-destructive',
};

export function connectionStatusTitle(status: ConnectionStatus): string {
  if (isWakeRecoveryStatus(status)) return 'Reconnecting after sleep.';
  if (status.state === 'reconnecting') return 'Realtime updates are reconnecting.';
  return 'Connection delayed.';
}

export function connectionStatusHint(status: ConnectionStatus): string {
  if (isWakeRecoveryStatus(status)) return 'We will retry automatically as your network comes back online.';
  return `${connectionLimitHint} Close inactive windows or keep one visible tab active.`;
}

export function connectionStatusLabel(status: ConnectionStatus): string {
  if (status.state === 'ok') return 'Live';
  if (status.state === 'reconnecting') return 'Reconnecting';
  return 'Delayed';
}

function isWakeRecoveryStatus(status: ConnectionStatus): boolean {
  return status.state === 'reconnecting' && status.message === wakeRecoveryMessage;
}

export function filterSessions(sessions: Session[], search: string): Session[] {
  const query = search.trim().toLowerCase();
  if (!query) return sessions;
  return sessions
    .map((session) => ({
      session,
      score: fuzzyScore(
        `${session.title ?? ''} ${session.status} ${sessionDisplayStatus(session)} ${session.id}`,
        query,
      ),
    }))
    .filter((match) => match.score !== null)
    .sort((a, b) => a.score! - b.score!)
    .map((match) => match.session);
}

export function sessionDisplayStatus(session: Session): string {
  return session.displayStatus ?? session.status;
}

export function sessionDisplayTooltip(session: Session): string {
  return session.displayStatusTooltip ?? `Session is ${session.status}.`;
}

function fuzzyScore(value: string, query: string): number | null {
  const haystack = value.toLowerCase();
  let score = 0;
  let lastIndex = -1;

  for (const char of query) {
    if (char === ' ') continue;
    const index = haystack.indexOf(char, lastIndex + 1);
    if (index === -1) return null;
    score += index - lastIndex - 1;
    lastIndex = index;
  }

  if (haystack.includes(query)) score -= query.length;
  if (haystack.startsWith(query)) score -= query.length * 2;
  return score;
}

export function statusTextClass(status: string): string {
  return statusTextClasses[status] ?? 'text-foreground';
}

export function setupStatusLabel(state: SetupStatusState): string {
  if (state === 'configured') return 'Configured';
  if (state === 'limited') return 'Limited';
  if (state === 'missing') return 'Missing';
  if (state === 'warning') return 'Check';
  return 'Error';
}

export function setupStatusBadgeClass(state: SetupStatusState): string {
  if (state === 'configured') return 'bg-success/10 text-success';
  if (state === 'limited') return 'bg-info/10 text-info';
  if (state === 'warning') return 'bg-warning/10 text-warning';
  return 'bg-destructive/10 text-destructive';
}

export function renderSetupText(text: string): ReactNode[] {
  return text
    .split(/([A-Z][A-Z0-9_]*=[^\s.,]+|[A-Z][A-Z0-9_]*_[A-Z0-9_]*(?:\*|\/[A-Z][A-Z0-9_]*_[A-Z0-9_]*)*)/g)
    .map((part, index) =>
      /^[A-Z][A-Z0-9_]*(?:=|_|$)/.test(part) && (part.includes('=') || part.includes('_')) ? (
        <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {part}
        </code>
      ) : (
        part
      ),
    );
}

export function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key !== 'Enter' || event.shiftKey || isMobileTextEntryViewport()) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function isMobileTextEntryViewport(): boolean {
  return window.matchMedia?.('(hover: none) and (pointer: coarse)').matches ?? false;
}

export function blurFocusedTextControl(): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLTextAreaElement || activeElement instanceof HTMLInputElement) activeElement.blur();
}

export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

export function formatModelLabel(model: string): string {
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
