import {
  FocusEvent,
  FormEvent,
  KeyboardEvent,
  ReactNode,
  SyntheticEvent,
  TouchEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  Code2,
  GitCompare,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Sun,
  Wrench,
  X,
} from 'lucide-react';
import {
  BranchOption,
  getApiBaseUrl,
  githubLoginUrl,
  Health,
  RepositoryOption,
  Session,
  SetupStatus,
  SetupStatusItem,
  SetupStatusState,
  type WorkspaceToolId,
} from '../api.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card } from './ui/card.js';
import { Input } from './ui/input.js';
import { Textarea } from './ui/textarea.js';
import { cn } from '../lib/utils.js';

const archivedSessionsOpenStorageKey = 'deputies-archived-sessions-open';
const optionPickerOpenEvent = 'deputies-option-picker-open';
const connectionLimitHint =
  'If you have Deputies open in several windows, browser connection limits may block API requests.';
const wakeRecoveryMessage = 'Reconnecting after your computer was asleep or offline.';

export type ThemePreference = 'light' | 'dark' | 'system';

export type ConnectionStatus = {
  state: 'ok' | 'delayed' | 'reconnecting';
  message: string;
};

export function LocalSandboxWarning() {
  return (
    <div
      className="border-b border-warning/50 bg-warning/15 px-3 py-2 text-sm text-warning-foreground dark:text-warning md:px-8 xl:px-20"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p>
          <strong>Unsafe local sandbox mode is not a security boundary.</strong> Commands run on the API/worker host
          runtime in a temporary workspace. Use it only for trusted local development.
        </p>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      </div>
    </div>
  );
}

export function ConnectionStatusBanner(props: { status: ConnectionStatus }) {
  return (
    <div
      className="pointer-events-none fixed left-3 right-3 top-3 z-50 rounded-md border border-warning/50 bg-warning/15 px-3 py-2 text-sm text-warning-foreground shadow-lg backdrop-blur dark:text-warning md:left-8 md:right-8 xl:left-20 xl:right-20"
      role="status"
    >
      <div className="flex flex-wrap items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <p className="min-w-0 flex-1">
          <strong>{connectionStatusTitle(props.status)}</strong> {props.status.message}{' '}
          {connectionStatusHint(props.status)}
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
  onOpenSetup: () => void;
  onRefresh: () => void;
  onSelect: (sessionId: string) => void;
  onSignOut: () => void;
  onThemeChange: (value: ThemePreference) => void;
  onUnarchive: (sessionId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const filteredSessions = useMemo(() => filterSessions(props.sessions, search), [props.sessions, search]);
  const activeSessions = useMemo(
    () => filteredSessions.filter((session) => session.status !== 'archived'),
    [filteredSessions],
  );
  const archivedSessions = useMemo(
    () => filteredSessions.filter((session) => session.status === 'archived'),
    [filteredSessions],
  );
  const searching = Boolean(search.trim());
  const archivedOpen = searching || props.archivedSessionsOpen;

  function handleArchivedToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (searching) return;
    const open = event.currentTarget.open;
    localStorage.setItem(archivedSessionsOpenStorageKey, String(open));
    props.onArchivedSessionsOpenChange(open);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <Button
          className="shrink-0"
          variant="ghost"
          size="icon"
          onClick={props.onCollapse}
          aria-label="Hide sidebar"
          title="Hide sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Sessions</h2>
        <div className="flex shrink-0 gap-2">
          <Button size="icon" onClick={props.onNewThread} disabled={!props.canCallApi} aria-label="New session">
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            onClick={props.onRefresh}
            disabled={!props.canCallApi || props.loading}
            aria-label="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="relative mb-3 shrink-0">
        <Input
          className="pr-9"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search sessions..."
        />
        {search ? (
          <Button
            className="absolute right-1 top-1 h-8 w-8 p-0"
            variant="ghost"
            size="icon"
            onClick={() => setSearch('')}
            aria-label="Clear search"
            title="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-thread-scroll-exclude="true">
        <div className="grid min-w-0 gap-1">
          {activeSessions.map((session) => (
            <SessionButton
              key={session.id}
              session={session}
              selected={session.id === props.selectedSessionId}
              onArchive={props.onArchive}
              onSelect={props.onSelect}
            />
          ))}
          {!activeSessions.length ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              {search ? 'No matching active sessions.' : 'No active sessions.'}
            </p>
          ) : null}
        </div>
        {archivedSessions.length || searching ? (
          <details className="mt-4 border-t border-border pt-3" open={archivedOpen} onToggle={handleArchivedToggle}>
            <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-muted-foreground">
              <ChevronDown className={cn('h-4 w-4 -rotate-90 transition-transform', archivedOpen && 'rotate-0')} />{' '}
              Archived · {archivedSessions.length}
            </summary>
            {archivedSessions.length ? (
              <div className="mt-2 grid min-w-0 gap-1 opacity-80">
                {archivedSessions.map((session) => (
                  <SessionButton
                    key={session.id}
                    session={session}
                    selected={session.id === props.selectedSessionId}
                    onSelect={props.onSelect}
                    onUnarchive={props.onUnarchive}
                  />
                ))}
              </div>
            ) : (
              <p className="px-2 py-3 text-sm text-muted-foreground">No matching archived sessions.</p>
            )}
          </details>
        ) : null}
      </div>
      <ThemeToggle preference={props.themePreference} onChange={props.onThemeChange} />
      <ApiStatusFooter
        authRequired={props.authRequired}
        connectionStatus={props.connectionStatus}
        health={props.health}
        token={props.token}
        onOpenSetup={props.onOpenSetup}
        onSignOut={props.onSignOut}
      />
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
    <div
      className="mt-3 grid grid-cols-3 gap-1 rounded-md border border-border bg-muted/60 p-1"
      aria-label="Theme preference"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = props.preference === option.value;
        return (
          <button
            className={cn(
              'inline-flex h-8 items-center justify-center rounded border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
              active && 'border-border bg-card text-foreground shadow-sm',
            )}
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
          <div
            className="mt-4 rounded-md border border-warning/50 bg-warning/10 p-3 text-left text-sm text-warning-foreground dark:text-warning"
            role="status"
          >
            <strong>{connectionStatusTitle(props.connectionStatus)}</strong>
            <p className="mt-1">
              {props.connectionStatus.message} {connectionStatusHint(props.connectionStatus)}
            </p>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

export function SetupGuidePanel(props: {
  loading: boolean;
  setupStatus: SetupStatus | null;
  setupError: string;
  onRefresh: () => void;
  onStartNewThread: () => void;
}) {
  const items = props.setupStatus?.items ?? [];
  const configured = items.filter((item) => item.state === 'configured').length;

  return (
    <section className="h-full overflow-auto px-3 py-6 md:px-8 xl:px-20">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Admin setup</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Setup guide</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Quick checks for the Deputies deployment.</p>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              To skip this page on startup, set {renderSetupText('HIDE_SETUP_PAGE=true')}.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={props.onRefresh} disabled={props.loading}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button onClick={props.onStartNewThread}>New session</Button>
          </div>
        </div>

        {props.setupError ? (
          <div className="mt-5 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {props.setupError}
          </div>
        ) : null}

        <Card className="mt-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <strong>
                {props.loading && !props.setupStatus ? 'Checking setup...' : `${configured}/${items.length} configured`}
              </strong>
              {props.setupStatus ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Last checked {formatDate(props.setupStatus.checkedAt)}
                </p>
              ) : null}
            </div>
            <a
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              href="https://github.com/sidpalas/deputies"
              target="_blank"
              rel="noreferrer"
            >
              Open repo docs
            </a>
          </div>
        </Card>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {items.map((item) => (
            <SetupStatusCard key={item.id} item={item} />
          ))}
        </div>
      </div>
    </section>
  );
}

function SetupStatusCard(props: { item: SetupStatusItem }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{props.item.label}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{props.item.summary}</p>
        </div>
        <Badge className={setupStatusBadgeClass(props.item.state)}>{setupStatusLabel(props.item.state)}</Badge>
      </div>
      {props.item.guidance ? (
        <p className="mt-3 text-sm text-foreground">{renderSetupText(props.item.guidance)}</p>
      ) : null}
      {props.item.guidanceItems?.length ? (
        <ul className="mt-2 space-y-1 text-sm text-foreground">
          {props.item.guidanceItems.map((item) => (
            <li key={item}>{renderSetupText(item)}</li>
          ))}
        </ul>
      ) : null}
      {props.item.details?.length ? (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {props.item.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      <a
        className="mt-4 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
        href={`https://github.com/sidpalas/deputies/blob/main/${props.item.docsPath}`}
        target="_blank"
        rel="noreferrer"
      >
        Docs
      </a>
    </Card>
  );
}

function ApiStatusFooter(props: {
  authRequired: boolean;
  connectionStatus: ConnectionStatus;
  health: Health | null;
  token: string;
  onOpenSetup: () => void;
  onSignOut: () => void;
}) {
  const connected = props.health?.status === 'ok' && props.connectionStatus.state === 'ok';
  return (
    <div className="mt-3 shrink-0 border-t border-border pt-3 text-left text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-success' : 'bg-warning')} />
        <strong className="text-foreground">{props.health ? `API ${props.health.status}` : 'Checking API'}</strong>
        <span>{connectionStatusLabel(props.connectionStatus)}</span>
      </div>
      <p className="mt-1 truncate">{getApiBaseUrl()}</p>
      {props.health ? (
        <p>
          {props.health.runMode} mode · auth {props.health.apiAuthMode}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={props.onOpenSetup}>
          Setup
        </Button>
        {props.authRequired && (props.token || props.health?.apiAuthMode === 'session') ? (
          <Button variant="secondary" size="sm" onClick={props.onSignOut}>
            {props.health?.apiAuthMode === 'session' ? 'Sign out' : 'Clear token'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SessionButton(props: {
  session: Session;
  selected: boolean;
  onSelect: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onUnarchive?: (sessionId: string) => void;
}) {
  const displayStatus = sessionDisplayStatus(props.session);
  const displayTooltip = sessionDisplayTooltip(props.session);

  return (
    <div
      className={cn(
        'group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-transparent p-2 hover:bg-accent',
        props.selected && 'border-primary bg-primary/15',
      )}
    >
      <button
        className="block min-w-0 flex-1 overflow-hidden bg-transparent p-0 text-left"
        type="button"
        onClick={() => props.onSelect(props.session.id)}
      >
        <strong className="block w-full truncate text-sm font-medium text-foreground">
          {props.session.title || 'Untitled session'}
        </strong>
        <span className="block w-full truncate text-xs text-muted-foreground" title={displayTooltip}>
          <span className={statusTextClass(displayStatus)}>{displayStatus}</span> ·{' '}
          {formatDate(props.session.updatedAt)}
        </span>
      </button>
      {props.onArchive ? (
        <Button
          className="w-8 shrink-0 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          variant="ghost"
          size="sm"
          onClick={() => props.onArchive?.(props.session.id)}
          aria-label="Archive session"
          title="Archive session"
        >
          <Archive className="h-3.5 w-3.5" />
        </Button>
      ) : null}
      {props.onUnarchive ? (
        <Button
          className="w-8 shrink-0 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          variant="ghost"
          size="sm"
          onClick={() => props.onUnarchive?.(props.session.id)}
          aria-label="Restore session"
          title="Restore session"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

export function ArchivedSessionNotice(props: { onRestore: () => void }) {
  return (
    <Card className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3 border-warning/50 bg-warning/10 p-3">
      <div>
        <p className="text-sm font-medium text-warning-foreground dark:text-warning">This session is archived.</p>
        <p className="text-xs text-warning-foreground/80 dark:text-warning/80">
          Restore it before sending a new message.
        </p>
      </div>
      <Button type="button" variant="secondary" onClick={props.onRestore}>
        <RotateCcw className="h-4 w-4" /> Restore session
      </Button>
    </Card>
  );
}

export function BearerAuthPanel(props: {
  draftToken: string;
  setDraftToken: (value: string) => void;
  saveToken: (event: FormEvent) => void;
}) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
          Engineering agents for delegated work.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Assign work, track each step, and inspect the final output.
        </p>
        <form className="mt-6 grid gap-3" onSubmit={props.saveToken}>
          <div>
            <strong>API token required</strong>
            <p className="text-sm text-muted-foreground">
              Enter the backend bearer token. It stays in this browser's local storage.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              type="password"
              value={props.draftToken}
              onChange={(event) => props.setDraftToken(event.target.value)}
              placeholder="Bearer token"
            />
            <Button type="submit">Use token</Button>
          </div>
        </form>
      </Card>
    </section>
  );
}

export function SessionAuthPanel(props: {
  provider: 'static' | 'github';
  username: string;
  password: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
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
              <p className="text-sm text-muted-foreground">
                Continue with a GitHub account allowed by this Deputies deployment.
              </p>
            </div>
            <Button
              className="justify-self-end"
              type="button"
              onClick={() => {
                window.location.href = githubLoginUrl();
              }}
            >
              Continue with GitHub
            </Button>
          </div>
        ) : (
          <form className="mt-6 grid gap-3" onSubmit={props.onSubmit}>
            <div>
              <strong>Operator login</strong>
              <p className="text-sm text-muted-foreground">
                Use the static credentials configured for this environment.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={props.username}
                onChange={(event) => props.onUsernameChange(event.target.value)}
                placeholder="Username"
                autoComplete="username"
              />
              <Input
                type="password"
                value={props.password}
                onChange={(event) => props.onPasswordChange(event.target.value)}
                placeholder="Password"
                autoComplete="current-password"
              />
            </div>
            <Button className="justify-self-end" type="submit" disabled={!props.username.trim() || !props.password}>
              Sign in
            </Button>
          </form>
        )}
      </Card>
    </section>
  );
}

export function NewThreadPanel(props: {
  canCallApi: boolean;
  loading: boolean;
  prompt: string;
  repository: string;
  repositoryOptions: RepositoryOption[];
  repositoryOptionsLoading: boolean;
  repositoryOptionsError: string;
  branch: string;
  branchOptions: BranchOption[];
  branchOptionsLoading: boolean;
  branchOptionsError: string;
  model: string;
  modelOptions: string[];
  showOpenSidebar: boolean;
  onOpenSidebar: () => void;
  onPromptChange: (value: string) => void;
  onRepositoryChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <section className="relative grid min-h-screen place-items-center px-4">
      {props.showOpenSidebar ? (
        <Button
          className="absolute left-4 top-4 h-8 w-8 p-0 md:hidden"
          variant="ghost"
          size="icon"
          onClick={props.onOpenSidebar}
          aria-label="Open sessions"
          title="Open sessions"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
      ) : null}
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
          Engineering agents for delegated work.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Assign work, track each step, and inspect the final output.
        </p>
        <h2 className="mt-6 text-xl font-semibold">What needs doing?</h2>
        <form className="mt-4 grid gap-3" onSubmit={props.onSubmit}>
          <div className="grid gap-2 sm:grid-cols-[minmax(16rem,1fr)_minmax(8rem,12rem)_minmax(8rem,14rem)]">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-repository">
                Repository
              </label>
              <RepositoryPicker
                id="new-thread-repository"
                value={props.repository}
                repositories={props.repositoryOptions}
                loading={props.repositoryOptionsLoading}
                error={props.repositoryOptionsError}
                onChange={props.onRepositoryChange}
                placeholder="GitHub repository, e.g. owner/repo"
                disabled={!props.canCallApi}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-branch">
                Branch
              </label>
              <BranchPicker
                id="new-thread-branch"
                value={props.branch}
                branches={props.branchOptions}
                loading={props.branchOptionsLoading}
                error={props.branchOptionsError}
                onChange={props.onBranchChange}
                disabled={!props.canCallApi || !props.repository}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-model">
                Model
              </label>
              <OptionPicker
                id="new-thread-model"
                label="Model"
                value={props.model}
                options={props.modelOptions.map((model) => ({ value: model, label: formatModelLabel(model) }))}
                emptyLabel="Default model"
                onChange={props.onModelChange}
                disabled={!props.canCallApi || props.modelOptions.length <= 1}
              />
            </div>
          </div>
          <Textarea
            className="min-h-40"
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            onKeyDown={(event) => submitOnEnter(event)}
            placeholder="Ask Deputies to investigate, change code, or answer a question..."
            disabled={!props.canCallApi}
            autoFocus
          />
          <Button
            className="justify-self-end"
            type="submit"
            disabled={!props.canCallApi || props.loading || !props.prompt.trim()}
          >
            Start session
          </Button>
        </form>
      </Card>
    </section>
  );
}

export function MessageComposer(props: {
  archived: boolean;
  hasSelectedRepository: boolean;
  repository: string;
  inheritedRepository: string;
  repositoryOptions: RepositoryOption[];
  repositoryOptionsLoading: boolean;
  repositoryOptionsError: string;
  branch: string;
  inheritedBranch: string;
  branchOptions: BranchOption[];
  branchOptionsLoading: boolean;
  branchOptionsError: string;
  model: string;
  inheritedModel: string;
  modelOptions: string[];
  onRepositoryChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
  onSubmit: (input: { prompt: string }) => Promise<boolean>;
}) {
  const [prompt, setPrompt] = useState('');
  const [promptResetKey, setPromptResetKey] = useState(0);
  const submitTouchRef = useRef<{ moved: boolean; x: number; y: number } | null>(null);

  const canSubmit = !props.archived && Boolean(prompt.trim());

  async function submitPrompt() {
    if (!canSubmit) return;
    const submittedPrompt = prompt;
    blurFocusedTextControl();
    setPromptResetKey((key) => key + 1);
    setPrompt('');
    const sent = await props.onSubmit({ prompt: submittedPrompt });
    if (!sent) setPrompt(submittedPrompt);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submitPrompt();
  }

  function handleSubmitTouchStart(event: TouchEvent<HTMLButtonElement>) {
    const touch = event.changedTouches[0];
    if (!touch) return;
    submitTouchRef.current = { moved: false, x: touch.clientX, y: touch.clientY };
  }

  function handleSubmitTouchMove(event: TouchEvent<HTMLButtonElement>) {
    const touch = event.changedTouches[0];
    const start = submitTouchRef.current;
    if (!touch || !start) return;
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) start.moved = true;
  }

  function handleSubmitTouchEnd(event: TouchEvent<HTMLButtonElement>) {
    const start = submitTouchRef.current;
    submitTouchRef.current = null;
    if (!canSubmit || start?.moved) return;
    event.preventDefault();
    void submitPrompt();
  }

  function handleSubmitTouchCancel() {
    submitTouchRef.current = null;
  }

  function handleBlur(event: FocusEvent<HTMLFormElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) props.onFocusChange(false);
  }

  return (
    <form
      className="shrink-0 bg-background/95 py-3"
      data-thread-composer="true"
      onFocus={() => props.onFocusChange(true)}
      onBlur={handleBlur}
      onSubmit={handleSubmit}
    >
      <Card className="bg-card/90">
        <Textarea
          key={promptResetKey}
          className="min-h-28 border-0 bg-transparent focus:ring-0"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => submitOnEnter(event)}
          placeholder={
            props.archived
              ? 'Restore this archived session before sending new work.'
              : 'Ask your deputy to investigate, change code, or follow up...'
          }
          disabled={props.archived}
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <RepositoryPicker
            className="min-w-0 flex-[2_1_16rem]"
            triggerClassName="h-8 text-xs"
            direction="up"
            value={props.repository}
            repositories={props.repositoryOptions}
            loading={props.repositoryOptionsLoading}
            error={props.repositoryOptionsError}
            onChange={props.onRepositoryChange}
            placeholder={props.inheritedRepository || 'GitHub repo, e.g. owner/repo'}
            disabled={props.archived}
          />
          <BranchPicker
            className="min-w-0 flex-[1_2_8rem]"
            triggerClassName="h-8 text-xs"
            direction="up"
            value={props.branch}
            branches={props.branchOptions}
            loading={props.branchOptionsLoading}
            error={props.branchOptionsError}
            onChange={props.onBranchChange}
            disabled={props.archived || (!props.repository && !props.hasSelectedRepository)}
            placeholder={props.inheritedBranch || 'Branch'}
          />
          <OptionPicker
            className="min-w-0 flex-[1_2_9rem]"
            triggerClassName="h-8 text-xs"
            direction="up"
            label="Model"
            value={props.model}
            options={props.modelOptions.map((model) => ({ value: model, label: formatModelLabel(model) }))}
            emptyLabel={props.inheritedModel ? formatModelLabel(props.inheritedModel) : 'Default model'}
            onChange={props.onModelChange}
            disabled={props.archived || props.modelOptions.length <= 1}
          />
          {props.archived ? (
            <span className="min-w-full text-center sm:min-w-0 sm:flex-1 sm:text-left">
              Archived sessions are read-only until restored.
            </span>
          ) : null}
          <Button
            className="ml-auto shrink-0 whitespace-nowrap"
            type="submit"
            disabled={!canSubmit}
            onTouchStart={handleSubmitTouchStart}
            onTouchMove={handleSubmitTouchMove}
            onTouchEnd={handleSubmitTouchEnd}
            onTouchCancel={handleSubmitTouchCancel}
          >
            Send message
          </Button>
        </div>
      </Card>
    </form>
  );
}

function RepositoryPicker(props: {
  id?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  direction?: 'up' | 'down';
  value: string;
  repositories: RepositoryOption[];
  loading: boolean;
  error: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <OptionPicker
      {...(props.id ? { id: props.id } : {})}
      {...(props.className ? { className: props.className } : {})}
      {...(props.triggerClassName ? { triggerClassName: props.triggerClassName } : {})}
      menuClassName="min-w-72"
      {...(props.direction ? { direction: props.direction } : {})}
      label="Repository"
      value={props.value}
      options={props.repositories.map((repository) => ({ value: repository.fullName, label: repository.fullName }))}
      emptyLabel={props.loading ? 'Loading repositories...' : props.placeholder}
      loading={props.loading}
      error={props.error ? 'Could not load repositories.' : ''}
      searchable
      allowEmpty={Boolean(props.value)}
      onChange={props.onChange}
      disabled={props.disabled}
    />
  );
}

function BranchPicker(props: {
  id?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  direction?: 'up' | 'down';
  value: string;
  branches: BranchOption[];
  loading: boolean;
  error: string;
  placeholder?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <OptionPicker
      {...(props.id ? { id: props.id } : {})}
      {...(props.className ? { className: props.className } : {})}
      {...(props.triggerClassName ? { triggerClassName: props.triggerClassName } : {})}
      menuClassName="min-w-72"
      {...(props.direction ? { direction: props.direction } : {})}
      label="Branch"
      value={props.value}
      options={props.branches.map((branch) => ({ value: branch.name, label: branch.name }))}
      emptyLabel={
        props.loading
          ? 'Loading branches...'
          : props.placeholder || (props.branches.length ? 'Select branch...' : 'No branches')
      }
      loading={props.loading}
      error={props.error ? 'Could not load branches.' : ''}
      allowCustom
      allowEmpty={Boolean(props.value)}
      onChange={props.onChange}
      disabled={props.disabled}
    />
  );
}

function OptionPicker(props: {
  id?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  direction?: 'up' | 'down';
  label: string;
  value: string;
  options: { value: string; label: string }[];
  emptyLabel: string;
  loading?: boolean;
  error?: string;
  searchable?: boolean;
  allowCustom?: boolean;
  allowEmpty?: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const pickerId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = props.options.find((option) => option.value === props.value);
  const filteredOptions = props.options.filter((option) =>
    `${option.label} ${option.value}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const customValue = search.trim();
  const showCustom = props.allowCustom && customValue && !props.options.some((option) => option.value === customValue);
  const disabled = props.disabled;
  const direction = props.direction ?? 'down';

  useEffect(() => {
    function closeOtherPicker(event: Event) {
      if (!(event instanceof CustomEvent) || event.detail === pickerId) return;
      setOpen(false);
    }

    window.addEventListener(optionPickerOpenEvent, closeOtherPicker);
    return () => window.removeEventListener(optionPickerOpenEvent, closeOtherPicker);
  }, [pickerId]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function select(value: string) {
    props.onChange(value);
    setSearch('');
    setOpen(false);
  }

  function toggleOpen() {
    setOpen((current) => {
      const next = !current;
      if (next) window.dispatchEvent(new CustomEvent(optionPickerOpenEvent, { detail: pickerId }));
      return next;
    });
  }

  return (
    <div
      className={cn('relative', props.className)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        id={props.id}
        type="button"
        className={cn(
          'relative flex h-10 w-full items-center rounded-md border border-input bg-background/80 py-0 pl-3 pr-9 text-left text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:opacity-50',
          props.triggerClassName,
        )}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props.label}
        onClick={toggleOpen}
      >
        <span className="truncate" title={selected?.label ?? props.emptyLabel}>
          {selected?.label ?? props.emptyLabel}
        </span>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 leading-none text-muted-foreground">
          ⌄
        </span>
      </button>
      {open ? (
        <div
          className={cn(
            'absolute left-0 right-0 z-30 overflow-auto rounded-md border border-border bg-card p-1 text-sm text-foreground shadow-xl',
            direction === 'up' ? 'bottom-full mb-1 max-h-[min(60vh,28rem)]' : 'top-full mt-1 max-h-80',
            props.menuClassName,
          )}
          role="listbox"
        >
          {(props.searchable || props.options.length > 8 || props.allowCustom) && !props.loading ? (
            <Input
              className="mb-1 h-8 bg-background text-xs"
              value={search}
              placeholder={props.allowCustom ? `Search or type ${props.label.toLowerCase()}...` : 'Search...'}
              aria-label={`Search ${props.label}`}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && showCustom) select(customValue);
              }}
            />
          ) : null}
          {props.allowEmpty ? (
            <button
              type="button"
              className="block w-full rounded-sm px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              role="option"
              aria-selected={!props.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select('')}
            >
              Clear override
            </button>
          ) : null}
          {props.loading ? <p className="px-2 py-2 text-muted-foreground">Loading...</p> : null}
          {!props.loading && props.error ? <p className="px-2 py-2 text-destructive">{props.error}</p> : null}
          {!props.loading && !props.error && !filteredOptions.length && !showCustom ? (
            <p className="px-2 py-2 text-muted-foreground">No matches.</p>
          ) : null}
          {!props.loading && showCustom ? (
            <button
              type="button"
              className="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
              role="option"
              aria-selected={false}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(customValue)}
            >
              Use "{customValue}"
            </button>
          ) : null}
          {!props.loading &&
            filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  'block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground',
                  option.value === props.value && 'bg-accent text-accent-foreground',
                )}
                role="option"
                aria-selected={option.value === props.value}
                title={option.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(option.value)}
              >
                <span className="block break-words leading-snug">{option.label}</span>
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function formatModelLabel(model: string): string {
  return model.replace(/^[^/]+\//, '').replace(/-/g, ' ');
}

function workspaceToolUnavailableReason(session: Session): string {
  if (!session.sandbox) return 'Start a run to create a workspace before opening tools.';
  if (session.sandbox.status === 'destroyed') return 'This workspace was destroyed. Start a fresh run to use tools.';
  return '';
}

type ThreadHeaderProps = {
  selectedSession: Session;
  showOpenSidebar: boolean;
  onArchive: () => void;
  onOpenSidebar: () => void;
  onUpdateTitle: (title: string) => Promise<boolean>;
  onOpenWorkspaceTool: (toolId: WorkspaceToolId) => Promise<void>;
};

const workspaceToolOptions = [
  { id: 'ide' as const, label: 'VS Code', Icon: Code2 },
  { id: 'diff' as const, label: 'Hunk Diff', Icon: GitCompare },
];

export function ThreadHeader(props: ThreadHeaderProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(props.selectedSession.title ?? '');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [openingWorkspaceTool, setOpeningWorkspaceTool] = useState<WorkspaceToolId | ''>('');
  const toolsRef = useRef<HTMLDivElement>(null);
  const workspaceUnavailableReason = workspaceToolUnavailableReason(props.selectedSession);

  useEffect(() => {
    setEditingTitle(false);
    setTitleDraft(props.selectedSession.title ?? '');
  }, [props.selectedSession.id, props.selectedSession.title]);

  useEffect(() => {
    if (!toolsOpen) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (event.target instanceof Node && toolsRef.current?.contains(event.target)) return;
      setToolsOpen(false);
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setToolsOpen(false);
    }

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [toolsOpen]);

  function startEditingTitle() {
    setTitleDraft(props.selectedSession.title ?? '');
    setEditingTitle(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = await props.onUpdateTitle(titleDraft);
    if (saved) setEditingTitle(false);
  }

  async function openWorkspaceTool(toolId: WorkspaceToolId) {
    setToolsOpen(false);
    setOpeningWorkspaceTool(toolId);
    try {
      await props.onOpenWorkspaceTool(toolId);
    } finally {
      setOpeningWorkspaceTool('');
    }
  }

  function archiveSession() {
    setToolsOpen(false);
    props.onArchive();
  }

  return (
    <section className="sticky top-0 z-20 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
      <div className="flex min-w-0 items-start gap-2 overflow-hidden">
        {props.showOpenSidebar ? (
          <Button
            className="mt-4 h-8 w-8 shrink-0 p-0 md:hidden"
            variant="ghost"
            size="icon"
            onClick={props.onOpenSidebar}
            aria-label="Open sessions"
            title="Open sessions"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Session</p>
          {editingTitle ? (
            <form className="mt-1 flex flex-wrap items-center gap-2" onSubmit={handleSubmit}>
              <Input
                className="max-w-xl"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                autoFocus
              />
              <Button type="submit" disabled={!titleDraft.trim()}>
                Save
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditingTitle(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="mt-1 flex min-w-0 items-center gap-1">
              <h2 className="min-w-0 truncate text-base font-semibold text-foreground">
                {props.selectedSession.title || 'Untitled session'}
              </h2>
              <Button
                className="h-7 w-7 shrink-0 p-0"
                type="button"
                variant="ghost"
                size="icon"
                onClick={startEditingTitle}
                aria-label="Edit title"
                title="Edit title"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          <p className="mt-1 hidden truncate text-xs text-muted-foreground sm:block">{props.selectedSession.id}</p>
        </div>
      </div>
      <div className="grid min-h-9 shrink-0 grid-cols-[auto_auto] items-center justify-items-end gap-2 justify-self-end">
        <Badge
          className={cn('col-start-1', statusTextClass(sessionDisplayStatus(props.selectedSession)))}
          title={sessionDisplayTooltip(props.selectedSession)}
        >
          {sessionDisplayStatus(props.selectedSession)}
        </Badge>
        <div className="col-start-2 flex justify-end gap-2">
          <div className="relative" ref={toolsRef}>
            <Button
              className="h-9 gap-2"
              type="button"
              variant="secondary"
              onClick={() => setToolsOpen((open) => !open)}
              aria-expanded={toolsOpen}
              aria-haspopup="menu"
              title="Tools"
            >
              <Wrench className="h-4 w-4" />
              <span className="hidden sm:inline">Tools</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            {toolsOpen ? (
              <div
                className="absolute right-0 top-11 z-30 w-56 rounded-md border border-border bg-card p-1 text-sm text-card-foreground shadow-lg"
                role="menu"
              >
                <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Workspace Tools</p>
                {workspaceUnavailableReason ? (
                  <p className="px-2 py-2 text-muted-foreground">{workspaceUnavailableReason}</p>
                ) : (
                  workspaceToolOptions.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={Boolean(openingWorkspaceTool)}
                      role="menuitem"
                      onClick={() => openWorkspaceTool(id)}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="min-w-0 flex-1">{label}</span>
                      {openingWorkspaceTool === id ? (
                        <span className="text-xs text-muted-foreground">Opening...</span>
                      ) : null}
                    </button>
                  ))
                )}
                {props.selectedSession.status !== 'archived' ? (
                  <>
                    <div className="my-1 h-px bg-border" />
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                      role="menuitem"
                      onClick={archiveSession}
                    >
                      <Archive className="h-4 w-4" />
                      <span className="min-w-0 flex-1">Archive session</span>
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
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

function sessionDisplayStatus(session: Session): string {
  return session.displayStatus ?? session.status;
}

function sessionDisplayTooltip(session: Session): string {
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

const statusTextClasses: Record<string, string> = {
  active: 'text-info',
  archived: 'text-muted-foreground',
  cancelled: 'text-destructive',
  cancelling: 'text-info',
  completed: 'text-success',
  created: 'text-warning',
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
  starting: 'text-info',
  stopped: 'text-warning',
  unhealthy: 'text-destructive',
};

function statusTextClass(status: string): string {
  return statusTextClasses[status] ?? 'text-foreground';
}

function setupStatusLabel(state: SetupStatusState): string {
  return state === 'configured'
    ? 'Configured'
    : state === 'limited'
      ? 'Limited'
      : state === 'missing'
        ? 'Missing'
        : state === 'warning'
          ? 'Check'
          : 'Error';
}

function setupStatusBadgeClass(state: SetupStatusState): string {
  if (state === 'configured') return 'bg-success/10 text-success';
  if (state === 'limited') return 'bg-info/10 text-info';
  if (state === 'warning') return 'bg-warning/10 text-warning';
  return 'bg-destructive/10 text-destructive';
}

function renderSetupText(text: string): ReactNode[] {
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
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}
