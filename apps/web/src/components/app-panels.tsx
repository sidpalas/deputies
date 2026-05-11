import { FocusEvent, FormEvent, KeyboardEvent, SyntheticEvent, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Archive, ChevronDown, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, RotateCcw, Sun, X } from 'lucide-react';
import { getApiBaseUrl, githubLoginUrl, Health, Session } from '../api.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card } from './ui/card.js';
import { Input } from './ui/input.js';
import { Textarea } from './ui/textarea.js';
import { cn } from '../lib/utils.js';

const archivedSessionsOpenStorageKey = 'deputies-archived-sessions-open';
const connectionLimitHint = 'If you have Deputies open in several windows, browser connection limits may block API requests.';
const wakeRecoveryMessage = 'Reconnecting after your computer was asleep or offline.';

export type ThemePreference = 'light' | 'dark' | 'system';

export type ConnectionStatus = {
  state: 'ok' | 'delayed' | 'reconnecting';
  message: string;
};

export function LocalSandboxWarning() {
  return (
    <div className="border-b border-warning/50 bg-warning/15 px-3 py-2 text-sm text-warning-foreground dark:text-warning md:px-8 xl:px-20" role="alert">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p>
          <strong>Local sandbox mode is not a security boundary.</strong> Commands run on the API/worker host runtime in a temporary workspace. Use it only for trusted local development.
        </p>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      </div>
    </div>
  );
}

export function ConnectionStatusBanner(props: { status: ConnectionStatus }) {
  return (
    <div className="pointer-events-none fixed left-3 right-3 top-3 z-50 rounded-md border border-warning/50 bg-warning/15 px-3 py-2 text-sm text-warning-foreground shadow-lg backdrop-blur dark:text-warning md:left-8 md:right-8 xl:left-20 xl:right-20" role="status">
      <div className="flex flex-wrap items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <p className="min-w-0 flex-1">
          <strong>{connectionStatusTitle(props.status)}</strong> {props.status.message} {connectionStatusHint(props.status)}
        </p>
      </div>
    </div>
  );
}

export function ThreadSidebar(props: {
  archivedSessionsOpen: boolean;
  authRequired: boolean;
  canCallApi: boolean;
  connectionStatus: ConnectionStatus;
  health: Health | null;
  loading: boolean;
  sessions: Session[];
  selectedSessionId: string;
  themePreference: ThemePreference;
  token: string;
  onArchive: (sessionId: string) => void;
  onArchivedSessionsOpenChange: (open: boolean) => void;
  onCollapse: () => void;
  onNewThread: () => void;
  onRefresh: () => void;
  onSelect: (sessionId: string) => void;
  onSignOut: () => void;
  onThemeChange: (value: ThemePreference) => void;
  onUnarchive: (sessionId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const filteredSessions = useMemo(() => filterSessions(props.sessions, search), [props.sessions, search]);
  const activeSessions = useMemo(() => filteredSessions.filter((session) => session.status !== 'archived'), [filteredSessions]);
  const archivedSessions = useMemo(() => filteredSessions.filter((session) => session.status === 'archived'), [filteredSessions]);
  const searching = Boolean(search.trim());

  function handleArchivedToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (searching) return;
    const open = event.currentTarget.open;
    localStorage.setItem(archivedSessionsOpenStorageKey, String(open));
    props.onArchivedSessionsOpenChange(open);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <Button className="shrink-0" variant="ghost" size="icon" onClick={props.onCollapse} aria-label="Hide sidebar" title="Hide sidebar"><PanelLeftClose className="h-4 w-4" /></Button>
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Sessions</h2>
        <div className="flex shrink-0 gap-2">
          <Button size="icon" onClick={props.onNewThread} disabled={!props.canCallApi} aria-label="New session"><Plus className="h-4 w-4" /></Button>
          <Button variant="secondary" size="icon" onClick={props.onRefresh} disabled={!props.canCallApi || props.loading} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>
      <div className="relative mb-3 shrink-0">
        <Input className="pr-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sessions..." />
        {search ? (
          <Button className="absolute right-1 top-1 h-8 w-8 p-0" variant="ghost" size="icon" onClick={() => setSearch('')} aria-label="Clear search" title="Clear search">
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-thread-scroll-exclude="true">
        <div className="grid min-w-0 gap-1">
          {activeSessions.map((session) => (
            <SessionButton key={session.id} session={session} selected={session.id === props.selectedSessionId} onArchive={props.onArchive} onSelect={props.onSelect} />
          ))}
          {!activeSessions.length ? <p className="px-2 py-3 text-sm text-muted-foreground">{search ? 'No matching active sessions.' : 'No active sessions.'}</p> : null}
        </div>
        {archivedSessions.length || searching ? (
          <details className="mt-4 border-t border-border pt-3" open={searching || props.archivedSessionsOpen} onToggle={handleArchivedToggle}>
            <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-muted-foreground"><ChevronDown className="h-4 w-4" /> Archived · {archivedSessions.length}</summary>
            {archivedSessions.length ? (
              <div className="mt-2 grid min-w-0 gap-1 opacity-80">
                {archivedSessions.map((session) => <SessionButton key={session.id} session={session} selected={session.id === props.selectedSessionId} onSelect={props.onSelect} onUnarchive={props.onUnarchive} />)}
              </div>
            ) : <p className="px-2 py-3 text-sm text-muted-foreground">No matching archived sessions.</p>}
          </details>
        ) : null}
      </div>
      <ThemeToggle preference={props.themePreference} onChange={props.onThemeChange} />
      <ApiStatusFooter authRequired={props.authRequired} connectionStatus={props.connectionStatus} health={props.health} token={props.token} onSignOut={props.onSignOut} />
    </div>
  );
}

function ThemeToggle(props: { preference: ThemePreference; onChange: (value: ThemePreference) => void }) {
  const options: { value: ThemePreference; label: string; icon: typeof Monitor }[] = [
    { value: 'system', label: 'System theme', icon: Monitor },
    { value: 'light', label: 'Light theme', icon: Sun },
    { value: 'dark', label: 'Dark theme', icon: Moon },
  ];

  return (
    <div className="mt-3 grid grid-cols-3 gap-1 rounded-md border border-border bg-muted/60 p-1" aria-label="Theme preference">
      {options.map((option) => {
        const Icon = option.icon;
        const active = props.preference === option.value;
        return (
          <button
            className={cn('inline-flex h-8 items-center justify-center rounded border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground', active && 'border-border bg-card text-foreground shadow-sm')}
            key={option.value}
            type="button"
            onClick={() => props.onChange(option.value)}
            aria-label={option.label}
            aria-pressed={active}
            title={option.label}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}

export function StartupLoadingPanel(props: { connectionStatus: ConnectionStatus }) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="max-w-lg p-6 text-center">
        <h2 className="text-lg font-semibold">Loading Deputies</h2>
        <p className="mt-2 text-sm text-muted-foreground">Restoring your session and workspace.</p>
        {props.connectionStatus.state !== 'ok' ? (
          <div className="mt-4 rounded-md border border-warning/50 bg-warning/10 p-3 text-left text-sm text-warning-foreground dark:text-warning" role="status">
            <strong>{connectionStatusTitle(props.connectionStatus)}</strong>
            <p className="mt-1">{props.connectionStatus.message} {connectionStatusHint(props.connectionStatus)}</p>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

function ApiStatusFooter(props: { authRequired: boolean; connectionStatus: ConnectionStatus; health: Health | null; token: string; onSignOut: () => void }) {
  const connected = props.health?.status === 'ok' && props.connectionStatus.state === 'ok';
  return (
    <div className="mt-3 shrink-0 border-t border-border pt-3 text-left text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-success' : 'bg-warning')} />
        <strong className="text-foreground">{props.health ? `API ${props.health.status}` : 'Checking API'}</strong>
        <span>{connectionStatusLabel(props.connectionStatus)}</span>
      </div>
      <p className="mt-1 truncate">{getApiBaseUrl()}</p>
      {props.health ? <p>{props.health.runMode} mode · auth {props.health.apiAuthMode}</p> : null}
      {props.authRequired && (props.token || props.health?.apiAuthMode === 'session') ? <Button className="mt-2" variant="secondary" size="sm" onClick={props.onSignOut}>{props.health?.apiAuthMode === 'session' ? 'Sign out' : 'Clear token'}</Button> : null}
    </div>
  );
}

function SessionButton(props: { session: Session; selected: boolean; onSelect: (sessionId: string) => void; onArchive?: (sessionId: string) => void; onUnarchive?: (sessionId: string) => void }) {
  return (
    <div className={cn('group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-transparent p-2 hover:bg-accent', props.selected && 'border-primary bg-primary/15')}>
      <button className="block min-w-0 flex-1 overflow-hidden bg-transparent p-0 text-left" type="button" onClick={() => props.onSelect(props.session.id)}>
        <strong className="block w-full truncate text-sm font-medium text-foreground">{props.session.title || 'Untitled session'}</strong>
        <span className="block w-full truncate text-xs text-muted-foreground"><span className={statusTextClass(props.session.status)}>{props.session.status}</span> · {formatDate(props.session.updatedAt)}</span>
      </button>
      {props.onArchive ? <Button className="w-8 shrink-0 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100" variant="ghost" size="sm" onClick={() => props.onArchive?.(props.session.id)} aria-label="Archive session" title="Archive session"><Archive className="h-3.5 w-3.5" /></Button> : null}
      {props.onUnarchive ? <Button className="w-8 shrink-0 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100" variant="ghost" size="sm" onClick={() => props.onUnarchive?.(props.session.id)} aria-label="Restore session" title="Restore session"><RotateCcw className="h-3.5 w-3.5" /></Button> : null}
    </div>
  );
}

export function ArchivedSessionNotice(props: { onRestore: () => void }) {
  return (
    <Card className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3 border-warning/50 bg-warning/10 p-3">
      <div>
        <p className="text-sm font-medium text-warning-foreground dark:text-warning">This session is archived.</p>
        <p className="text-xs text-warning-foreground/80 dark:text-warning/80">Restore it before sending a new message.</p>
      </div>
      <Button type="button" variant="secondary" onClick={props.onRestore}><RotateCcw className="h-4 w-4" /> Restore session</Button>
    </Card>
  );
}

export function BearerAuthPanel(props: { draftToken: string; setDraftToken: (value: string) => void; saveToken: (event: FormEvent) => void }) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Engineering agents for delegated work.</h1>
        <p className="mt-2 text-sm text-muted-foreground">Assign follow-ups, watch the work trail, and inspect the results.</p>
        <form className="mt-6 grid gap-3" onSubmit={props.saveToken}>
          <div>
            <strong>API token required</strong>
            <p className="text-sm text-muted-foreground">Enter the backend bearer token. It stays in this browser's local storage.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input type="password" value={props.draftToken} onChange={(event) => props.setDraftToken(event.target.value)} placeholder="Bearer token" />
            <Button type="submit">Use token</Button>
          </div>
        </form>
      </Card>
    </section>
  );
}

export function SessionAuthPanel(props: { provider: 'static' | 'github'; username: string; password: string; onUsernameChange: (value: string) => void; onPasswordChange: (value: string) => void; onSubmit: (event: FormEvent) => void }) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Sign in to Deputies.</h1>
        <p className="mt-2 text-sm text-muted-foreground">The API will set an HTTP-only session cookie after login.</p>
        {props.provider === 'github' ? (
          <div className="mt-6 grid gap-3">
            <div>
              <strong>GitHub login</strong>
              <p className="text-sm text-muted-foreground">Continue with a GitHub account allowed by this Deputies deployment.</p>
            </div>
            <Button className="justify-self-end" type="button" onClick={() => { window.location.href = githubLoginUrl(); }}>Continue with GitHub</Button>
          </div>
        ) : (
          <form className="mt-6 grid gap-3" onSubmit={props.onSubmit}>
            <div>
              <strong>Operator login</strong>
              <p className="text-sm text-muted-foreground">Use the static credentials configured for this environment.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input value={props.username} onChange={(event) => props.onUsernameChange(event.target.value)} placeholder="Username" autoComplete="username" />
              <Input type="password" value={props.password} onChange={(event) => props.onPasswordChange(event.target.value)} placeholder="Password" autoComplete="current-password" />
            </div>
            <Button className="justify-self-end" type="submit" disabled={!props.username.trim() || !props.password}>Sign in</Button>
          </form>
        )}
      </Card>
    </section>
  );
}

export function NewThreadPanel(props: { canCallApi: boolean; loading: boolean; prompt: string; repository: string; showOpenSidebar: boolean; onOpenSidebar: () => void; onPromptChange: (value: string) => void; onRepositoryChange: (value: string) => void; onSubmit: (event: FormEvent) => void }) {
  return (
    <section className="relative grid min-h-screen place-items-center px-4">
      {props.showOpenSidebar ? (
        <Button className="absolute left-4 top-4 h-8 w-8 p-0 md:hidden" variant="ghost" size="icon" onClick={props.onOpenSidebar} aria-label="Open sessions" title="Open sessions">
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
      ) : null}
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Engineering agents for delegated work.</h1>
        <p className="mt-2 text-sm text-muted-foreground">Assign follow-ups, watch the work trail, and inspect the results.</p>
        <h2 className="mt-6 text-xl font-semibold">What needs doing?</h2>
        <form className="mt-4 grid gap-3" onSubmit={props.onSubmit}>
          <Input value={props.repository} onChange={(event) => props.onRepositoryChange(event.target.value)} placeholder="GitHub repository, e.g. owner/repo or https://github.com/owner/repo" disabled={!props.canCallApi} />
          <Textarea className="min-h-40" value={props.prompt} onChange={(event) => props.onPromptChange(event.target.value)} onKeyDown={(event) => submitOnEnter(event)} placeholder="Ask Deputies to investigate, change code, or answer a question..." disabled={!props.canCallApi} autoFocus />
          <Button className="justify-self-end" type="submit" disabled={!props.canCallApi || props.loading || !props.prompt.trim()}>Start session</Button>
        </form>
      </Card>
    </section>
  );
}

export function MessageComposer(props: { archived: boolean; hasSelectedRepository: boolean; onFocusChange: (focused: boolean) => void; onSubmit: (input: { prompt: string; repository: string }) => Promise<boolean> }) {
  const [prompt, setPrompt] = useState('');
  const [repository, setRepository] = useState('');

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const submittedPrompt = prompt;
    const submittedRepository = repository;
    blurFocusedTextControl();
    setPrompt('');
    const sent = await props.onSubmit({ prompt: submittedPrompt, repository: submittedRepository });
    if (!sent) setPrompt(submittedPrompt);
  }

  function handleBlur(event: FocusEvent<HTMLFormElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) props.onFocusChange(false);
  }

  return (
    <form className="shrink-0 bg-background/95 py-3" data-thread-composer="true" onFocus={() => props.onFocusChange(true)} onBlur={handleBlur} onSubmit={handleSubmit}>
      <Card className="overflow-hidden bg-card/90">
        <Textarea
          className="min-h-28 border-0 bg-transparent focus:ring-0"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => submitOnEnter(event)}
          placeholder={props.archived ? 'Restore this archived session before sending new work.' : 'Ask your deputy to investigate, change code, or follow up...'}
          disabled={props.archived}
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <Input
            className="h-8 min-w-0 flex-1 text-xs min-[480px]:max-w-80"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder={props.hasSelectedRepository ? 'Override repo...' : 'GitHub repo, e.g. owner/repo'}
            disabled={props.archived}
          />
          {props.archived ? <span className="min-w-full text-center sm:min-w-0 sm:flex-1 sm:text-left">Archived sessions are read-only until restored.</span> : null}
          <Button className="ml-auto shrink-0 whitespace-nowrap" type="submit" disabled={props.archived || !prompt.trim()}>Send message</Button>
        </div>
      </Card>
    </form>
  );
}

export function ThreadHeader(props: { selectedSession: Session; showOpenSidebar: boolean; onArchive: () => void; onOpenSidebar: () => void; onUpdateTitle: (title: string) => Promise<boolean> }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(props.selectedSession.title ?? '');

  useEffect(() => {
    setEditingTitle(false);
    setTitleDraft(props.selectedSession.title ?? '');
  }, [props.selectedSession.id, props.selectedSession.title]);

  function startEditingTitle() {
    setTitleDraft(props.selectedSession.title ?? '');
    setEditingTitle(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = await props.onUpdateTitle(titleDraft);
    if (saved) setEditingTitle(false);
  }

  return (
    <section className="sticky top-0 z-20 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
      <div className="flex min-w-0 items-start gap-2 overflow-hidden">
        {props.showOpenSidebar ? (
          <Button className="mt-4 h-8 w-8 shrink-0 p-0 md:hidden" variant="ghost" size="icon" onClick={props.onOpenSidebar} aria-label="Open sessions" title="Open sessions">
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Session</p>
          {editingTitle ? (
            <form className="mt-1 flex flex-wrap items-center gap-2" onSubmit={handleSubmit}>
              <Input className="max-w-xl" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} autoFocus />
              <Button type="submit" disabled={!titleDraft.trim()}>Save</Button>
              <Button type="button" variant="secondary" onClick={() => setEditingTitle(false)}>Cancel</Button>
            </form>
          ) : (
            <div className="mt-1 flex min-w-0 items-center gap-1">
              <h2 className="min-w-0 truncate text-base font-semibold text-foreground">{props.selectedSession.title || 'Untitled session'}</h2>
              <Button className="h-7 w-7 shrink-0 p-0" type="button" variant="ghost" size="icon" onClick={startEditingTitle} aria-label="Edit title" title="Edit title"><Pencil className="h-3.5 w-3.5" /></Button>
            </div>
          )}
          <p className="mt-1 hidden truncate text-xs text-muted-foreground sm:block">{props.selectedSession.id}</p>
        </div>
      </div>
      <div className="grid min-h-9 shrink-0 grid-cols-[auto_auto] items-center justify-items-end gap-2 justify-self-end">
        <Badge className={cn('col-start-1', statusTextClass(props.selectedSession.status))}>{props.selectedSession.status}</Badge>
        <div className="col-start-2 flex justify-end gap-2">
          {props.selectedSession.status !== 'archived' ? <Button className="h-9 w-9 p-0" type="button" variant="secondary" size="icon" onClick={props.onArchive} aria-label="Archive session" title="Archive session"><Archive className="h-4 w-4" /></Button> : null}
        </div>
      </div>
    </section>
  );
}

function connectionStatusTitle(status: ConnectionStatus): string {
  if (isWakeRecoveryStatus(status)) return 'Reconnecting after sleep.';
  if (status.state === 'reconnecting') return 'Realtime updates are reconnecting.';
  return 'Connection delayed.';
}

function connectionStatusHint(status: ConnectionStatus): string {
  if (isWakeRecoveryStatus(status)) return 'We will retry automatically as your network comes back online.';
  return `${connectionLimitHint} Close inactive windows or keep one visible tab active.`;
}

function connectionStatusLabel(status: ConnectionStatus): string {
  if (status.state === 'ok') return 'Live';
  if (status.state === 'reconnecting') return 'Reconnecting';
  return 'Delayed';
}

function isWakeRecoveryStatus(status: ConnectionStatus): boolean {
  return status.state === 'reconnecting' && status.message === wakeRecoveryMessage;
}

function filterSessions(sessions: Session[], search: string): Session[] {
  const query = search.trim().toLowerCase();
  if (!query) return sessions;
  return sessions
    .map((session) => ({ session, score: fuzzyScore(`${session.title ?? ''} ${session.status} ${session.id}`, query) }))
    .filter((match) => match.score !== null)
    .sort((a, b) => a.score! - b.score!)
    .map((match) => match.session);
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

function statusTextClass(status: string): string {
  if (['completed', 'ready', 'ok'].includes(status)) return 'text-success';
  if (['active', 'processing', 'running', 'starting', 'cancelling'].includes(status)) return 'text-info';
  if (['pending', 'queued', 'created', 'stopped'].includes(status)) return 'text-warning';
  if (['failed', 'cancelled', 'unhealthy', 'destroyed', 'missing'].includes(status)) return 'text-destructive';
  if (status === 'idle' || status === 'archived') return 'text-muted-foreground';
  return 'text-foreground';
}

function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key !== 'Enter' || event.shiftKey || isMobileTextEntryViewport()) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function isMobileTextEntryViewport(): boolean {
  return window.matchMedia?.('(hover: none) and (pointer: coarse)').matches ?? false;
}

function blurFocusedTextControl(): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLTextAreaElement || activeElement instanceof HTMLInputElement) activeElement.blur();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }).format(new Date(value));
}
