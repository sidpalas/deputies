import { useMemo, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Archive, ChevronDown, Monitor, Moon, PanelLeftClose, Plus, RefreshCw, RotateCcw, Sun, X } from 'lucide-react';
import { getApiBaseUrl, type Health, type Session } from '../../api.js';
import { archivedSessionsOpenStorageKey } from '../../app-helpers.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import {
  connectionStatusLabel,
  filterSessions,
  formatDate,
  sessionDisplayStatus,
  sessionDisplayTooltip,
  statusTextClass,
} from './shared.js';
import type { ConnectionStatus, ThemePreference } from './types.js';

export function ThreadSidebar(props: {
  archivedSessionsOpen: boolean;
  authRequired: boolean;
  canCallApi: boolean;
  canViewGroups: boolean;
  canStartNewThread: boolean;
  canViewSetup: boolean;
  canWriteSession: (session: Session) => boolean;
  connectionStatus: ConnectionStatus;
  health: Health | null;
  navPage: 'sessions' | 'setup';
  loading: boolean;
  sessions: Session[];
  selectedSessionId: string;
  themePreference: ThemePreference;
  token: string;
  onArchive: (sessionId: string) => void;
  onArchivedSessionsOpenChange: (open: boolean) => void;
  onCollapse: () => void;
  onNewThread: () => void;
  onOpenGroups: () => void;
  onOpenSessions: () => void;
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
    sessionStorage.setItem(archivedSessionsOpenStorageKey, String(open));
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
          <Button size="icon" onClick={props.onNewThread} disabled={!props.canStartNewThread} aria-label="New session">
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
              canWriteSession={props.canWriteSession(session)}
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
                    canWriteSession={props.canWriteSession(session)}
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
        canViewGroups={props.canViewGroups}
        canViewSetup={props.canViewSetup}
        connectionStatus={props.connectionStatus}
        health={props.health}
        navPage={props.navPage}
        token={props.token}
        onOpenGroups={props.onOpenGroups}
        onOpenSessions={props.onOpenSessions}
        onOpenSetup={props.onOpenSetup}
        onSignOut={props.onSignOut}
      />
    </div>
  );
}

export function ThemeToggle(props: { preference: ThemePreference; onChange: (value: ThemePreference) => void }) {
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

export function ApiStatusFooter(props: {
  authRequired: boolean;
  canViewGroups: boolean;
  canViewSetup: boolean;
  connectionStatus: ConnectionStatus;
  health: Health | null;
  navPage: 'sessions' | 'setup' | 'groups';
  token: string;
  onOpenGroups: () => void;
  onOpenSessions: () => void;
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
      <div className="mt-2 flex flex-nowrap gap-1">
        {props.canViewSetup ? (
          <Button
            className="h-7 px-2 text-xs"
            variant={props.navPage === 'setup' ? 'default' : 'secondary'}
            size="sm"
            aria-current={props.navPage === 'setup' ? 'page' : undefined}
            onClick={props.onOpenSetup}
          >
            Setup
          </Button>
        ) : null}
        <Button
          className="h-7 px-2 text-xs"
          variant={props.navPage === 'sessions' ? 'default' : 'secondary'}
          size="sm"
          aria-current={props.navPage === 'sessions' ? 'page' : undefined}
          onClick={props.onOpenSessions}
        >
          Sessions
        </Button>
        {props.canViewGroups ? (
          <Button
            className="h-7 px-2 text-xs"
            variant={props.navPage === 'groups' ? 'default' : 'secondary'}
            size="sm"
            aria-current={props.navPage === 'groups' ? 'page' : undefined}
            onClick={props.onOpenGroups}
          >
            Access
          </Button>
        ) : null}
        {props.authRequired && (props.token || props.health?.apiAuthMode === 'session') ? (
          <Button className="h-7 px-2 text-xs" variant="secondary" size="sm" onClick={props.onSignOut}>
            {props.health?.apiAuthMode === 'session' ? 'Sign out' : 'Clear token'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SessionButton(props: {
  canWriteSession: boolean;
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
      {props.canWriteSession && props.onArchive ? (
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
      {props.canWriteSession && props.onUnarchive ? (
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
