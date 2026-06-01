import {
  FocusEvent,
  FormEvent,
  KeyboardEvent,
  ReactNode,
  SelectHTMLAttributes,
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
  CornerUpLeft,
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
  AppNotice,
  AuthUser,
  Group,
  GroupMember,
  GroupRole,
  ModelChoice,
  RepositoryOption,
  Session,
  SessionVisibility,
  SessionWritePolicy,
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
const archivedGroupsOpenStorageKey = 'deputies-archived-groups-open';
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

export function AppNoticesBanner(props: { notices: AppNotice[] }) {
  if (!props.notices.length) return null;
  return (
    <div
      className="border-b border-warning/50 bg-warning/15 px-3 py-2 text-sm text-warning-foreground dark:text-warning md:px-8 xl:px-20"
      role="alert"
    >
      <div className="grid gap-1">
        {props.notices.map((notice) => (
          <p key={notice.code}>
            <strong>{notice.message}</strong> {notice.action ?? ''}
          </p>
        ))}
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
  canStartNewThread: boolean;
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
            <Button onClick={props.onStartNewThread} disabled={!props.canStartNewThread}>
              New session
            </Button>
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

export function GroupsSidebar(props: {
  authRequired: boolean;
  canCreateGroups: boolean;
  canViewGroups: boolean;
  canViewSetup: boolean;
  connectionStatus: ConnectionStatus;
  currentUser: AuthUser | null;
  groups: Group[];
  health: Health | null;
  selectedGroupId: string;
  selectedView: 'group' | 'super_admins';
  superAdminUsers: AuthUser[];
  themePreference: ThemePreference;
  token: string;
  onBackToSessions: () => void;
  onCollapse: () => void;
  onCreateGroup: () => void;
  onOpenGroups: () => void;
  onOpenSetup: () => void;
  onSelectGroup: (groupId: string) => void;
  onSelectSuperAdmins: () => void;
  onSignOut: () => void;
  onThemeChange: (value: ThemePreference) => void;
}) {
  const [groupSearch, setGroupSearch] = useState('');
  const [archivedGroupsOpen, setArchivedGroupsOpen] = useState(
    () => sessionStorage.getItem(archivedGroupsOpenStorageKey) === 'true',
  );
  const normalizedGroupSearch = groupSearch.trim().toLowerCase();
  const searchingGroups = Boolean(normalizedGroupSearch);
  const activeGroups = props.groups.filter(
    (group) => !group.archivedAt && (!searchingGroups || group.name.toLowerCase().includes(normalizedGroupSearch)),
  );
  const archivedGroups = props.groups.filter(
    (group) => group.archivedAt && (!searchingGroups || group.name.toLowerCase().includes(normalizedGroupSearch)),
  );
  const archivedOpen = searchingGroups || archivedGroupsOpen;
  const hasMatchingGroups = activeGroups.length > 0 || archivedGroups.length > 0;
  const currentUserIsSuperAdmin = props.currentUser?.role === 'super_admin';

  function handleArchivedGroupsToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (searchingGroups) return;
    const open = event.currentTarget.open;
    sessionStorage.setItem(archivedGroupsOpenStorageKey, String(open));
    setArchivedGroupsOpen(open);
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
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Access groups</h2>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            size="icon"
            onClick={props.onBackToSessions}
            aria-label="Back to sessions"
            title="Back to sessions"
          >
            <CornerUpLeft className="h-4 w-4" />
          </Button>
          {props.canCreateGroups ? (
            <Button size="icon" onClick={props.onCreateGroup} aria-label="New group" title="New group">
              <Plus className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="relative mb-3 shrink-0">
        <Input
          className="pr-9"
          value={groupSearch}
          onChange={(event) => setGroupSearch(event.target.value)}
          placeholder="Search groups..."
        />
        {groupSearch ? (
          <Button
            className="absolute right-1 top-1 h-8 w-8 p-0"
            variant="ghost"
            size="icon"
            onClick={() => setGroupSearch('')}
            aria-label="Clear group search"
            title="Clear group search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-thread-scroll-exclude="true">
        {props.canCreateGroups ? (
          <div className="mb-1 grid min-w-0 gap-1">
            <button
              type="button"
              className={cn(
                'group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-transparent p-2 text-left hover:bg-accent',
                props.selectedView === 'super_admins' && 'border-primary bg-primary/15',
              )}
              onClick={props.onSelectSuperAdmins}
            >
              <span className="block min-w-0 flex-1 overflow-hidden">
                <strong className="block w-full truncate text-sm font-medium text-foreground">
                  Manage super admins{currentUserIsSuperAdmin ? ' (you are one)' : ''}
                </strong>
                <span className="block w-full truncate text-xs text-muted-foreground">
                  {props.superAdminUsers.length} users
                </span>
              </span>
            </button>
          </div>
        ) : null}

        <div className={cn('mb-1', props.canCreateGroups && 'mt-4 border-t border-border pt-3')}>
          <h3 className="px-2 text-sm font-medium text-muted-foreground">Groups</h3>
        </div>

        {activeGroups.length ? (
          <div className="grid min-w-0 gap-1">
            {activeGroups.map((group) => (
              <button
                key={group.id}
                type="button"
                className={cn(
                  'group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-transparent p-2 text-left hover:bg-accent',
                  props.selectedView === 'group' &&
                    group.id === props.selectedGroupId &&
                    'border-primary bg-primary/15',
                )}
                onClick={() => props.onSelectGroup(group.id)}
              >
                <span className="block min-w-0 flex-1 overflow-hidden">
                  <strong className="block w-full truncate text-sm font-medium text-foreground">{group.name}</strong>
                  <span className="block w-full truncate text-xs text-muted-foreground">
                    {groupAccessLabel(group, props.currentUser)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : searchingGroups && !hasMatchingGroups ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">No matching groups.</p>
        ) : !searchingGroups ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">No access groups available.</p>
        ) : null}

        {archivedGroups.length ? (
          <details
            className="mt-4 border-t border-border pt-3"
            open={archivedOpen}
            onToggle={handleArchivedGroupsToggle}
          >
            <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-muted-foreground">
              <ChevronDown className={cn('h-4 w-4 -rotate-90 transition-transform', archivedOpen && 'rotate-0')} />
              Archived groups · {archivedGroups.length}
            </summary>
            <div className="mt-2 grid min-w-0 gap-1 opacity-80">
              {archivedGroups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className={cn(
                    'group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-transparent p-2 text-left hover:bg-accent',
                    props.selectedView === 'group' &&
                      group.id === props.selectedGroupId &&
                      'border-primary bg-primary/15',
                  )}
                  onClick={() => props.onSelectGroup(group.id)}
                >
                  <span className="block min-w-0 flex-1 overflow-hidden">
                    <strong className="block w-full truncate text-sm font-medium text-foreground">{group.name}</strong>
                    <span className="block w-full truncate text-xs text-muted-foreground">
                      Archived · {groupAccessLabel(group, props.currentUser)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
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
        navPage="groups"
        token={props.token}
        onOpenGroups={props.onOpenGroups}
        onOpenSessions={props.onBackToSessions}
        onOpenSetup={props.onOpenSetup}
        onSignOut={props.onSignOut}
      />
    </div>
  );
}

export function GroupsPanel(props: {
  canCreateGroups: boolean;
  currentUser: AuthUser | null;
  groupMembers: GroupMember[];
  groups: Group[];
  groupFormError: string;
  groupFormName: string;
  groupFormVisibility: SessionVisibility;
  groupFormWritePolicy: SessionWritePolicy;
  memberRole: GroupRole;
  memberSearchLoading: boolean;
  memberSearchQuery: string;
  memberUserId: string;
  selectedGroupId: string;
  selectedView: 'group' | 'super_admins';
  superAdminSearchLoading: boolean;
  superAdminSearchQuery: string;
  superAdminUserId: string;
  superAdminUserOptions: AuthUser[];
  superAdminUsers: AuthUser[];
  users: AuthUser[];
  showOpenSidebar: boolean;
  onAddMember: () => void;
  onArchiveGroup: (groupId: string, archived: boolean) => void;
  onCreateGroup: () => void;
  onGroupFormNameChange: (value: string) => void;
  onGroupFormVisibilityChange: (value: SessionVisibility) => void;
  onGroupFormWritePolicyChange: (value: SessionWritePolicy) => void;
  onMemberRoleChange: (value: GroupRole) => void;
  onMemberSearchQueryChange: (value: string) => void;
  onMemberUserIdChange: (value: string) => void;
  onOpenSidebar: () => void;
  onPromoteSuperAdmin: () => void;
  onRemoveMember: (userId: string) => void;
  onRemoveSuperAdmin: (userId: string) => void;
  onSaveGroup: () => void;
  onSelectGroup: (groupId: string) => void;
  onSelectMemberUser: (userId: string) => void;
  onSelectSuperAdminUser: (userId: string) => void;
  onSelectSuperAdmins: () => void;
  onSuperAdminSearchQueryChange: (value: string) => void;
  onSuperAdminUserIdChange: (value: string) => void;
  onUpdateMemberRole: (userId: string, role: GroupRole) => void;
}) {
  const selectedGroup = props.groups.find((group) => group.id === props.selectedGroupId) ?? null;
  const selectedMemberUser = props.users.find((user) => user.id === props.memberUserId);
  const selectedSuperAdminUser = props.superAdminUserOptions.find((user) => user.id === props.superAdminUserId);

  return (
    <section className="h-full overflow-auto px-3 py-6 md:px-8 xl:px-20">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            {props.showOpenSidebar ? (
              <Button
                className="mt-1 h-8 w-8 shrink-0 p-0 md:hidden"
                variant="ghost"
                size="icon"
                onClick={props.onOpenSidebar}
                aria-label="Open access groups"
                title="Open access groups"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            ) : null}
            <div>
              <p className="text-sm font-medium text-muted-foreground">Access control</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Access groups</h1>
              <p className="mt-1 text-sm text-muted-foreground">Manage access groups and user roles.</p>
            </div>
          </div>
        </div>
        <div className="grid content-start gap-4">
          {props.selectedView === 'super_admins' && props.canCreateGroups ? (
            <Card className="p-4">
              <h2 className="text-lg font-semibold">Super admins</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Super admins can manage all access groups, users, and access defaults.
              </p>
              <div className="mt-4 grid gap-2">
                {props.superAdminUsers.map((user) => {
                  const self = user.id === props.currentUser?.id;
                  return (
                    <div
                      key={user.id}
                      className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                      <div className="min-w-0">
                        <strong className="block truncate text-sm">{user.displayName || user.username}</strong>
                        <p className="truncate text-xs text-muted-foreground">
                          {user.username} · {user.id}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => props.onRemoveSuperAdmin(user.id)}
                        disabled={self}
                      >
                        {self ? 'Current user' : 'Remove'}
                      </Button>
                    </div>
                  );
                })}
                {!props.superAdminUsers.length ? (
                  <p className="text-sm text-muted-foreground">No super admins found.</p>
                ) : null}
              </div>
              <div className="mt-4 grid gap-3 rounded-md border border-border bg-muted/30 p-3">
                <label className="grid gap-1 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">Find user</span>
                  <Input
                    value={props.superAdminSearchQuery}
                    onChange={(event) => props.onSuperAdminSearchQueryChange(event.target.value)}
                    placeholder="Search by username, display name, or exact user ID"
                  />
                </label>
                {props.superAdminSearchQuery.trim().length < 2 ? (
                  <p className="text-xs text-muted-foreground">Type at least 2 characters to search users.</p>
                ) : props.superAdminSearchLoading ? (
                  <p className="text-xs text-muted-foreground">Searching users...</p>
                ) : props.superAdminUserOptions.length ? (
                  <div className="grid max-h-40 gap-1 overflow-auto rounded-md border border-border bg-background p-1">
                    {props.superAdminUserOptions.map((user) => (
                      <button
                        key={user.id}
                        type="button"
                        className="rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                        onClick={() => props.onSelectSuperAdminUser(user.id)}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <strong className="min-w-0 truncate">{user.displayName || user.username}</strong>
                          <Badge>{authRoleLabel(user.role)}</Badge>
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {user.username} · {user.id}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No matching users.</p>
                )}
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                  <label className="grid gap-1 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">User ID</span>
                    <Input
                      value={props.superAdminUserId}
                      onChange={(event) => props.onSuperAdminUserIdChange(event.target.value)}
                      placeholder="Select a user or paste user ID"
                    />
                    {selectedSuperAdminUser ? <SelectedUserSummary user={selectedSuperAdminUser} /> : null}
                  </label>
                  <Button
                    className="sm:mt-5"
                    onClick={props.onPromoteSuperAdmin}
                    disabled={!props.superAdminUserId.trim() || selectedSuperAdminUser?.role === 'super_admin'}
                  >
                    Promote
                  </Button>
                </div>
              </div>
            </Card>
          ) : selectedGroup ? (
            selectedGroup.canManage ? (
              <>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold">Access group settings</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Defaults apply when new sessions are created in this access group.
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      {selectedGroup.archivedAt ? <Badge>Archived</Badge> : null}
                      <Badge>{groupAccessLabel(selectedGroup, props.currentUser)}</Badge>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <label className="grid gap-1 text-sm sm:col-span-3">
                      <span className="text-xs font-medium text-muted-foreground">Name</span>
                      <Input
                        value={props.groupFormName}
                        onChange={(event) => props.onGroupFormNameChange(event.target.value)}
                        aria-invalid={Boolean(props.groupFormError)}
                      />
                      {props.groupFormError ? (
                        <span className="text-xs text-destructive" role="alert">
                          {props.groupFormError}
                        </span>
                      ) : null}
                    </label>
                    <label className="grid gap-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Default visibility</span>
                      <SelectWithCaret
                        value={props.groupFormVisibility}
                        onChange={(event) => props.onGroupFormVisibilityChange(event.target.value as SessionVisibility)}
                      >
                        <option value="organization">Organization</option>
                        <option value="group">Group only</option>
                      </SelectWithCaret>
                    </label>
                    <label className="grid gap-1 text-sm sm:col-span-2">
                      <span className="text-xs font-medium text-muted-foreground">Default write policy</span>
                      <SelectWithCaret
                        value={props.groupFormWritePolicy}
                        onChange={(event) =>
                          props.onGroupFormWritePolicyChange(event.target.value as SessionWritePolicy)
                        }
                      >
                        <option value="group_members">Group members</option>
                        <option value="creator_only">Creator only</option>
                      </SelectWithCaret>
                    </label>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      onClick={props.onSaveGroup}
                      disabled={!props.groupFormName.trim() || Boolean(props.groupFormError)}
                    >
                      Save group
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => props.onArchiveGroup(selectedGroup.id, !selectedGroup.archivedAt)}
                    >
                      {selectedGroup.archivedAt ? 'Unarchive group' : 'Archive group'}
                    </Button>
                  </div>
                </Card>

                <Card className="p-4">
                  <h2 className="text-lg font-semibold">Members</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Viewers can read group-only sessions. Members can create and write group-member sessions. Admins
                    manage this access group.
                  </p>
                  <div className="mt-4 grid gap-2">
                    {props.groupMembers.map((member) => (
                      <div
                        key={member.userId}
                        className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <strong className="block truncate text-sm">
                            {member.user?.displayName || member.user?.username || member.userId}
                          </strong>
                          <p className="truncate text-xs text-muted-foreground">
                            {member.user?.username ? member.userId : 'User ID'}
                          </p>
                        </div>
                        <SelectWithCaret
                          className="h-9"
                          value={member.role}
                          onChange={(event) => props.onUpdateMemberRole(member.userId, event.target.value as GroupRole)}
                        >
                          <option value="viewer">Viewer</option>
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </SelectWithCaret>
                        <Button variant="secondary" size="sm" onClick={() => props.onRemoveMember(member.userId)}>
                          Remove
                        </Button>
                      </div>
                    ))}
                    {!props.groupMembers.length ? (
                      <p className="text-sm text-muted-foreground">No members yet.</p>
                    ) : null}
                  </div>
                  <div className="mt-4 grid gap-3 rounded-md border border-border bg-muted/30 p-3">
                    <label className="grid gap-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Find user</span>
                      <Input
                        value={props.memberSearchQuery}
                        onChange={(event) => props.onMemberSearchQueryChange(event.target.value)}
                        placeholder="Search by username, display name, or exact user ID"
                      />
                    </label>
                    {props.memberSearchQuery.trim().length < 2 ? (
                      <p className="text-xs text-muted-foreground">Type at least 2 characters to search users.</p>
                    ) : props.memberSearchLoading ? (
                      <p className="text-xs text-muted-foreground">Searching users...</p>
                    ) : props.users.length ? (
                      <div className="grid max-h-40 gap-1 overflow-auto rounded-md border border-border bg-background p-1">
                        {props.users.map((user) => (
                          <button
                            key={user.id}
                            type="button"
                            className="rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                            onClick={() => props.onSelectMemberUser(user.id)}
                          >
                            <strong className="block truncate">{user.displayName || user.username}</strong>
                            <span className="block truncate text-xs text-muted-foreground">
                              {user.username} · {user.id}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No matching users.</p>
                    )}
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-start">
                      <label className="grid gap-1 text-sm">
                        <span className="text-xs font-medium text-muted-foreground">User ID</span>
                        <Input
                          value={props.memberUserId}
                          onChange={(event) => props.onMemberUserIdChange(event.target.value)}
                          placeholder="Select a user or paste user ID"
                        />
                        {selectedMemberUser ? <SelectedUserSummary user={selectedMemberUser} /> : null}
                      </label>
                      <label className="grid gap-1 text-sm">
                        <span className="text-xs font-medium text-muted-foreground">Role</span>
                        <SelectWithCaret
                          value={props.memberRole}
                          onChange={(event) => props.onMemberRoleChange(event.target.value as GroupRole)}
                        >
                          <option value="viewer">Viewer</option>
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </SelectWithCaret>
                      </label>
                      <Button className="sm:mt-5" onClick={props.onAddMember} disabled={!props.memberUserId.trim()}>
                        Add member
                      </Button>
                    </div>
                  </div>
                </Card>
              </>
            ) : (
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{selectedGroup.name}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">Your access in this access group.</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {selectedGroup.archivedAt ? <Badge>Archived</Badge> : null}
                    <Badge>{groupAccessLabel(selectedGroup, props.currentUser)}</Badge>
                  </div>
                </div>
                <div className="mt-4 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                  <div className="rounded-md border border-border p-3">
                    <strong className="block text-foreground">Default visibility</strong>
                    <span>{sessionVisibilityLabel(selectedGroup.defaultVisibility)}</span>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <strong className="block text-foreground">Default writes</strong>
                    <span>{sessionWritePolicyLabel(selectedGroup.defaultWritePolicy)}</span>
                  </div>
                </div>
              </Card>
            )
          ) : (
            <Card className="p-5 text-sm text-muted-foreground">Select an access group to view your access.</Card>
          )}
        </div>
      </div>
    </section>
  );
}

function SelectedUserSummary(props: { user: AuthUser }) {
  return (
    <p className="mt-1 truncate text-xs text-muted-foreground">
      Selected user: {props.user.displayName || props.user.username}
    </p>
  );
}

export function SessionAccessPanel(props: {
  canManageAccess: boolean;
  groups: Group[];
  session: Session;
  onUpdateAccess: (input: { ownerGroupId: string }) => Promise<boolean>;
}) {
  const [ownerGroupId, setOwnerGroupId] = useState(props.session.ownerGroupId);
  const [saving, setSaving] = useState(false);
  const ownerGroup = props.groups.find((group) => group.id === props.session.ownerGroupId);
  const editableGroups = props.groups.filter(
    (group) => group.id === props.session.ownerGroupId || (group.canManage && !group.archivedAt),
  );

  useEffect(() => {
    setOwnerGroupId(props.session.ownerGroupId);
  }, [props.session.id, props.session.ownerGroupId]);

  async function handleOwnerGroupChange(nextOwnerGroupId: string) {
    if (!props.canManageAccess || saving || nextOwnerGroupId === props.session.ownerGroupId) {
      setOwnerGroupId(nextOwnerGroupId);
      return;
    }

    setOwnerGroupId(nextOwnerGroupId);
    setSaving(true);
    try {
      const saved = await props.onUpdateAccess({ ownerGroupId: nextOwnerGroupId });
      if (!saved) setOwnerGroupId(props.session.ownerGroupId);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <div className="grid gap-2">
        <label className="grid gap-1">
          <span className="font-medium text-foreground">Access group</span>
          {props.canManageAccess ? (
            <SelectWithCaret
              className="h-8 min-w-0 pl-2 text-sm text-foreground"
              value={ownerGroupId}
              onChange={(event) => handleOwnerGroupChange(event.target.value)}
              disabled={saving}
            >
              {editableGroups.map((group) => (
                <option key={group.id} value={group.id} disabled={!group.canManage}>
                  {group.name}
                </option>
              ))}
            </SelectWithCaret>
          ) : (
            <span className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground">
              {ownerGroup?.name ?? props.session.ownerGroupId}
            </span>
          )}
        </label>
        {saving ? <p className="text-xs text-muted-foreground">Saving...</p> : null}
      </div>
    </div>
  );
}

function SelectWithCaret(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, ...selectProps } = props;

  return (
    <span className="relative block min-w-0">
      <select
        {...selectProps}
        className={cn(
          'h-10 w-full appearance-none rounded-md border border-input bg-background pl-3 pr-11 text-sm text-foreground disabled:opacity-70',
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </span>
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
            Groups
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
  readOnly: boolean;
  loading: boolean;
  groupId: string;
  groups: Group[];
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
  modelChoices: ModelChoice[];
  modelUnavailableReason: string;
  showOpenSidebar: boolean;
  onOpenSidebar: () => void;
  onGroupChange: (value: string) => void;
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
        {props.readOnly ? (
          <p className="mt-4 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
            You have read-only access. You can inspect existing sessions, but only admins can start new work.
          </p>
        ) : null}
        <h2 className="mt-6 text-xl font-semibold">What needs doing?</h2>
        <form className="mt-4 grid gap-3" onSubmit={props.onSubmit}>
          {props.groups.length > 1 ? (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-group">
                Group
              </label>
              <OptionPicker
                id="new-thread-group"
                label="Group"
                value={props.groupId}
                options={props.groups.map((group) => ({ value: group.id, label: group.name }))}
                emptyLabel="Select group..."
                onChange={props.onGroupChange}
                disabled={!props.canCallApi}
              />
            </div>
          ) : null}
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
                options={props.modelChoices}
                emptyLabel="Default model"
                onChange={props.onModelChange}
                disabled={!props.canCallApi || props.modelChoices.length <= 1}
              />
            </div>
          </div>
          {props.modelUnavailableReason ? (
            <p className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning-foreground dark:text-warning">
              {props.modelUnavailableReason}
            </p>
          ) : null}
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
            disabled={
              !props.canCallApi || props.loading || !props.prompt.trim() || Boolean(props.modelUnavailableReason)
            }
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
  readOnly: boolean;
  compactInput?: boolean;
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
  modelChoices: ModelChoice[];
  modelUnavailableReason: string;
  onRepositoryChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
  onSubmit: (input: { prompt: string }) => Promise<boolean>;
}) {
  const [prompt, setPrompt] = useState('');
  const [promptResetKey, setPromptResetKey] = useState(0);
  const submitTouchRef = useRef<{ moved: boolean; x: number; y: number } | null>(null);

  const canSubmit = !props.archived && !props.readOnly && Boolean(prompt.trim()) && !props.modelUnavailableReason;

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
          className={cn(props.compactInput ? 'min-h-12' : 'min-h-28', 'border-0 bg-transparent focus:ring-0')}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => submitOnEnter(event)}
          placeholder={
            props.archived
              ? 'Restore this archived session before sending new work.'
              : props.readOnly
                ? 'You have read-only access to this session. You can inspect messages, artifacts, and service metadata, but only group members and admins can send follow-ups.'
                : 'Ask your deputy to investigate, change code, or follow up...'
          }
          disabled={props.archived || props.readOnly}
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
            disabled={props.archived || props.readOnly}
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
            disabled={props.archived || props.readOnly || (!props.repository && !props.hasSelectedRepository)}
            placeholder={props.inheritedBranch || 'Branch'}
          />
          <OptionPicker
            className="min-w-0 flex-[1_2_9rem]"
            triggerClassName="h-8 text-xs"
            direction="up"
            label="Model"
            value={props.model}
            options={props.modelChoices}
            emptyLabel={props.inheritedModel ? formatModelLabel(props.inheritedModel) : 'Default model'}
            onChange={props.onModelChange}
            disabled={props.archived || props.readOnly || props.modelChoices.length <= 1}
          />
          {props.modelUnavailableReason ? (
            <p className="basis-full rounded-md border border-warning/50 bg-warning/10 px-2 py-1.5 text-warning-foreground dark:text-warning">
              {props.modelUnavailableReason}
            </p>
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
  options: { value: string; label: string; available?: boolean; unavailableReason?: string; action?: string }[];
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
    if (props.options.find((option) => option.value === value)?.available === false) return;
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
          'relative flex h-10 w-full items-center rounded-md border border-input bg-background/80 py-0 pl-3 pr-12 text-left text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:opacity-50',
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
        <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
                  'block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-current',
                  option.value === props.value && 'bg-accent text-accent-foreground',
                )}
                disabled={option.available === false}
                role="option"
                aria-selected={option.value === props.value}
                title={option.available === false ? option.unavailableReason : option.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(option.value)}
              >
                <span className="block break-words leading-snug">{option.label}</span>
                {option.available === false ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.action
                      ? `${option.unavailableReason ?? 'Unavailable'} ${option.action}`
                      : (option.unavailableReason ?? 'Unavailable')}
                  </span>
                ) : null}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
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

function groupRoleLabel(role: GroupRole): string {
  if (role === 'admin') return 'Admin';
  if (role === 'member') return 'Member';
  return 'Viewer';
}

function groupAccessLabel(group: Group, user: AuthUser | null): string {
  const membership = group.membershipRole ? groupRoleLabel(group.membershipRole) : 'None';
  if (user?.role === 'super_admin') return `${membership} (+ super admin)`;
  if (group.membershipRole) return membership;
  return 'No membership';
}

function sessionVisibilityLabel(visibility: SessionVisibility): string {
  return visibility === 'organization' ? 'Organization' : 'Group only';
}

function sessionWritePolicyLabel(policy: SessionWritePolicy): string {
  return policy === 'group_members' ? 'Group members' : 'Creator only';
}

function authRoleLabel(role: AuthUser['role']): string {
  return role === 'super_admin' ? 'Super admin' : 'User';
}

function workspaceToolUnavailableReason(session: Session): string {
  if (!session.sandbox) return 'Start a run to create a workspace before opening tools.';
  if (session.sandbox.status === 'destroyed') return 'This workspace was destroyed. Start a fresh run to use tools.';
  return '';
}

type ThreadHeaderProps = {
  canWriteSession: boolean;
  canOpenWorkspaceTools?: boolean;
  workspaceToolsDisabled?: boolean;
  selectedSession: Session;
  showOpenSidebar: boolean;
  workspaceToolsUnavailableReason?: string;
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
  const canOpenWorkspaceTools = props.canOpenWorkspaceTools ?? props.canWriteSession;
  const workspaceToolsDisabled = Boolean(props.workspaceToolsDisabled);
  const workspaceUnavailableReason =
    props.workspaceToolsUnavailableReason ?? workspaceToolUnavailableReason(props.selectedSession);

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
    if (!props.canWriteSession) return;
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
    if (!canOpenWorkspaceTools || workspaceToolsDisabled) return;
    setOpeningWorkspaceTool(toolId);
    try {
      await props.onOpenWorkspaceTool(toolId);
    } finally {
      setOpeningWorkspaceTool('');
    }
  }

  function archiveSession() {
    setToolsOpen(false);
    if (!props.canWriteSession) return;
    props.onArchive();
  }

  return (
    <section className="sticky top-0 z-20 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
      <div className="flex min-w-0 items-start gap-2 overflow-hidden">
        {props.showOpenSidebar ? (
          <Button
            className="self-center h-8 w-8 shrink-0 p-0 md:hidden"
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
              {props.canWriteSession ? (
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
              ) : null}
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
          {canOpenWorkspaceTools ? (
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
                        disabled={workspaceToolsDisabled || Boolean(openingWorkspaceTool)}
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
                        disabled={!props.canWriteSession}
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
          ) : null}
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
