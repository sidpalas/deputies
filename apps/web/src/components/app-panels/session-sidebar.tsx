import { useEffect, useMemo, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import {
  Archive,
  ChevronDown,
  FilePlus2,
  MessageCircle,
  Monitor,
  Moon,
  PanelLeftClose,
  Plus,
  RefreshCw,
  RotateCcw,
  Star,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import { type Health, type Session, type SessionSearchResult, type SessionTagSummary } from '../../api.js';
import { archivedSessionsOpenStorageKey } from '../../app-helpers.js';
import { cn } from '../../lib/utils.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { formatDate, sessionDisplayStatus, sessionDisplayTooltip, statusTextClass } from './shared.js';
import type { ConnectionStatus, ThemePreference } from './types.js';

type SessionFilters = {
  tags: string[];
  createdByMe: boolean;
  participatedByMe: boolean;
  starredByMe: boolean;
};

export function ThreadSidebar(props: {
  archivedSessionsOpen: boolean;
  authRequired: boolean;
  canCallApi: boolean;
  canViewGroups: boolean;
  canViewAutomations: boolean;
  canStartNewThread: boolean;
  canViewSetup: boolean;
  canWriteSession: (session: Session) => boolean;
  connectionStatus: ConnectionStatus;
  health: Health | null;
  archivedSessionsLoaded: boolean;
  archivedSessionsLoading: boolean;
  hasMoreArchivedSessions: boolean;
  hasMoreSessions: boolean;
  navPage: 'sessions' | 'setup' | 'automations';
  loading: boolean;
  loadingMoreSessions: boolean;
  searchQuery: string;
  searchResults: SessionSearchResult[];
  searchLoading: boolean;
  hasMoreSearchResults: boolean;
  sessionFilters: SessionFilters;
  sessionFilterCount: number;
  sessionTagOptions: SessionTagSummary[];
  sessions: Session[];
  selectedSessionId: string;
  themePreference: ThemePreference;
  token: string;
  onArchive: (sessionId: string) => void;
  onArchivedSessionsOpenChange: (open: boolean) => void;
  onCollapse: () => void;
  onLoadMoreArchivedSessions: () => void;
  onLoadMoreSearchResults: () => void;
  onLoadMoreSessions: () => void;
  onNewThread: () => void;
  onOpenGroups: () => void;
  onOpenAutomations: () => void;
  onOpenSessions: () => void;
  onOpenSetup: () => void;
  onRefresh: () => void;
  onSearchChange: (query: string) => void;
  onSelect: (sessionId: string) => void;
  onSessionFiltersChange: (filters: SessionFilters) => void;
  onSessionFiltersClear: () => void;
  onSessionListHoverChange: (hovered: boolean) => void;
  onSessionStarChange: (sessionId: string, starred: boolean) => void;
  onSignOut: () => void;
  onThemeChange: (value: ThemePreference) => void;
  onUnarchive: (sessionId: string) => void;
}) {
  const activeSessions = useMemo(
    () => props.sessions.filter((session) => session.status !== 'archived'),
    [props.sessions],
  );
  const archivedSessions = useMemo(
    () => props.sessions.filter((session) => session.status === 'archived'),
    [props.sessions],
  );
  const searching = Boolean(props.searchQuery.trim());
  const archivedOpen = props.archivedSessionsOpen;

  useEffect(() => () => props.onSessionListHoverChange(false), [props.onSessionListHoverChange]);

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
          value={props.searchQuery}
          onChange={(event) => props.onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') props.onSearchChange('');
          }}
          placeholder="Search sessions..."
        />
        {props.searchQuery ? (
          <Button
            className="absolute right-1 top-1 h-8 w-8 p-0"
            variant="ghost"
            size="icon"
            onClick={() => props.onSearchChange('')}
            aria-label="Clear search"
            title="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <SessionFilterControls
        count={props.sessionFilterCount}
        filters={props.sessionFilters}
        tagOptions={props.sessionTagOptions}
        onChange={props.onSessionFiltersChange}
        onClear={props.onSessionFiltersClear}
      />
      <div
        className="min-h-0 min-w-0 flex-1 overflow-auto"
        onPointerEnter={() => props.onSessionListHoverChange(true)}
        onPointerLeave={() => props.onSessionListHoverChange(false)}
      >
        {searching ? (
          <SearchResultsList
            canWriteSession={props.canWriteSession}
            filterCount={props.sessionFilterCount}
            loading={props.searchLoading}
            results={props.searchResults}
            selectedSessionId={props.selectedSessionId}
            hasMore={props.hasMoreSearchResults}
            onArchive={props.onArchive}
            onLoadMore={props.onLoadMoreSearchResults}
            onSelect={props.onSelect}
            onStarChange={props.onSessionStarChange}
            onUnarchive={props.onUnarchive}
          />
        ) : (
          <>
            <div className="grid min-w-0 gap-1">
              {activeSessions.map((session) => (
                <SessionButton
                  key={session.id}
                  session={session}
                  selected={session.id === props.selectedSessionId}
                  canWriteSession={props.canWriteSession(session)}
                  onArchive={props.onArchive}
                  onSelect={props.onSelect}
                  onStarChange={props.onSessionStarChange}
                />
              ))}
              {!activeSessions.length ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">
                  {props.sessionFilterCount ? 'No sessions match the current filters.' : 'No active sessions.'}
                </p>
              ) : null}
              {props.hasMoreSessions ? (
                <Button
                  className="mt-2 w-full"
                  variant="secondary"
                  size="sm"
                  disabled={props.loadingMoreSessions}
                  onClick={props.onLoadMoreSessions}
                >
                  {props.loadingMoreSessions ? 'Loading...' : 'Load more sessions'}
                </Button>
              ) : null}
            </div>
            <details className="mt-4 border-t border-border pt-3" open={archivedOpen} onToggle={handleArchivedToggle}>
              <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-muted-foreground">
                <ChevronDown className={cn('h-4 w-4 -rotate-90 transition-transform', archivedOpen && 'rotate-0')} />{' '}
                Archived
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
                      onStarChange={props.onSessionStarChange}
                      onUnarchive={props.onUnarchive}
                    />
                  ))}
                  {props.hasMoreArchivedSessions ? (
                    <Button
                      className="mt-2 w-full"
                      variant="secondary"
                      size="sm"
                      disabled={props.archivedSessionsLoading}
                      onClick={props.onLoadMoreArchivedSessions}
                    >
                      {props.archivedSessionsLoading ? 'Loading...' : 'Load more archived'}
                    </Button>
                  ) : null}
                </div>
              ) : props.archivedSessionsLoading ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">Loading archived sessions...</p>
              ) : props.archivedSessionsLoaded ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">No archived sessions.</p>
              ) : (
                <p className="px-2 py-3 text-sm text-muted-foreground">Expand to load archived sessions.</p>
              )}
            </details>
          </>
        )}
      </div>
      <ThemeToggle preference={props.themePreference} onChange={props.onThemeChange} />
      <ApiStatusFooter
        authRequired={props.authRequired}
        canViewGroups={props.canViewGroups}
        canViewAutomations={props.canViewAutomations}
        canViewSetup={props.canViewSetup}
        health={props.health}
        navPage={props.navPage}
        token={props.token}
        onOpenGroups={props.onOpenGroups}
        onOpenAutomations={props.onOpenAutomations}
        onOpenSessions={props.onOpenSessions}
        onOpenSetup={props.onOpenSetup}
        onSignOut={props.onSignOut}
      />
    </div>
  );
}

function SessionFilterControls(props: {
  count: number;
  filters: SessionFilters;
  tagOptions: SessionTagSummary[];
  onChange: (filters: SessionFilters) => void;
  onClear: () => void;
}) {
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [tagQueryDraft, setTagQueryDraft] = useState('');
  const tagPickerRef = useRef<HTMLDivElement>(null);
  const selectedTags = new Set(props.filters.tags);
  const availableTags = props.tagOptions.filter((option) => !selectedTags.has(option.tag));
  const tagQuery = normalizeTagQuery(tagQueryDraft);
  const filteredTags = availableTags.filter((option) => !tagQuery || option.tag.includes(tagQuery)).slice(0, 8);

  useEffect(() => {
    if (!tagPickerOpen) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (event.target instanceof Node && tagPickerRef.current?.contains(event.target)) return;
      setTagPickerOpen(false);
      setTagQueryDraft('');
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setTagPickerOpen(false);
      setTagQueryDraft('');
    }

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [tagPickerOpen]);

  function update(next: Partial<SessionFilters>) {
    props.onChange({ ...props.filters, ...next });
  }

  function addTagFilter(tag: string) {
    if (!tag || selectedTags.has(tag)) return;
    update({ tags: [...props.filters.tags, tag].sort(compareTagNames) });
    setTagPickerOpen(false);
    setTagQueryDraft('');
  }

  function toggle(key: 'createdByMe' | 'participatedByMe' | 'starredByMe') {
    update({ [key]: !props.filters[key] });
  }

  return (
    <div className="mb-3 grid gap-2 rounded-md border border-border bg-muted/30 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-muted-foreground">Filters{props.count ? ` (${props.count})` : ''}</span>
        {props.count ? (
          <button
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            type="button"
            onClick={props.onClear}
          >
            Clear all
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-1">
        <FilterChip
          active={props.filters.starredByMe}
          icon={Star}
          label="Starred"
          title="Sessions you starred"
          onClick={() => toggle('starredByMe')}
        />
        <FilterChip
          active={props.filters.createdByMe}
          icon={FilePlus2}
          label="Created"
          title="Sessions you created"
          onClick={() => toggle('createdByMe')}
        />
        <FilterChip
          active={props.filters.participatedByMe}
          icon={MessageCircle}
          label="Joined"
          title="Sessions where you sent a message"
          onClick={() => toggle('participatedByMe')}
        />
      </div>
      <div className="relative flex flex-wrap items-center gap-1.5" ref={tagPickerRef}>
        {props.filters.tags.map((tag) => (
          <Badge key={tag} className="gap-1 border border-border bg-background text-foreground">
            {tag}
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => update({ tags: props.filters.tags.filter((candidate) => candidate !== tag) })}
              aria-label={`Remove ${tag} filter`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <button
          className="inline-flex h-[22px] min-w-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0 text-xs font-medium leading-none text-muted-foreground hover:bg-muted/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          disabled={!availableTags.length}
          onClick={() => setTagPickerOpen((open) => !open)}
          aria-expanded={tagPickerOpen}
          aria-haspopup="listbox"
          aria-label="Filter by tags"
          title={availableTags.length ? 'Filter by tags' : 'No additional tags available'}
        >
          <span>Tags</span>
          <ChevronDown className="h-3 w-3" />
        </button>
        {tagPickerOpen ? (
          <div className="absolute left-0 top-[calc(100%+0.25rem)] z-40 w-full rounded-md border border-border bg-card p-2 text-sm text-card-foreground shadow-lg">
            <Input
              className="h-8 text-xs"
              placeholder="Search tags..."
              value={tagQueryDraft}
              onChange={(event) => setTagQueryDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const firstTag = filteredTags[0]?.tag;
                if (firstTag) addTagFilter(firstTag);
              }}
            />
            <div className="mt-2 max-h-52 overflow-auto" role="listbox">
              {filteredTags.map((option) => (
                <button
                  key={option.tag}
                  type="button"
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
                  role="option"
                  onClick={() => addTagFilter(option.tag)}
                >
                  <span className="min-w-0 truncate">{option.tag}</span>
                </button>
              ))}
              {!filteredTags.length ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">No matching tags.</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FilterChip(props: { active: boolean; icon: LucideIcon; label: string; title: string; onClick: () => void }) {
  const Icon = props.icon;
  return (
    <button
      className={cn(
        'inline-flex min-w-0 items-center justify-center gap-1 rounded-full border border-border px-1.5 py-1 text-muted-foreground transition-colors hover:text-foreground',
        props.active && 'border-primary bg-primary/15 text-foreground',
      )}
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      title={props.title}
    >
      <Icon className={cn('h-3.5 w-3.5', props.active && props.icon === Star && 'fill-current text-warning')} />
      <span className="min-w-0 truncate">{props.label}</span>
    </button>
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
  canViewAutomations: boolean;
  canViewSetup: boolean;
  health: Health | null;
  navPage: 'sessions' | 'setup' | 'groups' | 'automations';
  token: string;
  onOpenGroups: () => void;
  onOpenAutomations: () => void;
  onOpenSessions: () => void;
  onOpenSetup: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="mt-3 shrink-0 border-t border-border pt-3 text-left text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-1">
        <Button
          className="h-7 px-2 text-xs"
          variant={props.navPage === 'sessions' ? 'default' : 'secondary'}
          size="sm"
          aria-current={props.navPage === 'sessions' ? 'page' : undefined}
          onClick={props.onOpenSessions}
        >
          Sessions
        </Button>
        {props.canViewAutomations ? (
          <Button
            className="h-7 px-2 text-xs"
            variant={props.navPage === 'automations' ? 'default' : 'secondary'}
            size="sm"
            aria-current={props.navPage === 'automations' ? 'page' : undefined}
            onClick={props.onOpenAutomations}
          >
            Automations
          </Button>
        ) : null}
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
        {props.authRequired && (props.token || props.health?.apiAuthMode === 'session') ? (
          <Button className="h-7 px-2 text-xs" variant="secondary" size="sm" onClick={props.onSignOut}>
            {props.health?.apiAuthMode === 'session' ? 'Sign out' : 'Clear token'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SearchResultsList(props: {
  canWriteSession: (session: Session) => boolean;
  filterCount: number;
  loading: boolean;
  results: SessionSearchResult[];
  selectedSessionId: string;
  hasMore: boolean;
  onArchive: (sessionId: string) => void;
  onLoadMore: () => void;
  onSelect: (sessionId: string) => void;
  onStarChange: (sessionId: string, starred: boolean) => void;
  onUnarchive: (sessionId: string) => void;
}) {
  const activeResults = props.results.filter((result) => result.session.status !== 'archived');
  const archivedResults = props.results.filter((result) => result.session.status === 'archived');

  function renderResult(result: SessionSearchResult) {
    return (
      <SessionButton
        key={result.session.id}
        session={result.session}
        selected={result.session.id === props.selectedSessionId}
        canWriteSession={props.canWriteSession(result.session)}
        compact
        matchKind={result.matchKind}
        snippet={result.snippet}
        onSelect={props.onSelect}
        onStarChange={props.onStarChange}
        {...(result.session.status === 'archived'
          ? { onUnarchive: props.onUnarchive }
          : { onArchive: props.onArchive })}
      />
    );
  }

  return (
    <div className="grid min-w-0 gap-1">
      {activeResults.map(renderResult)}
      {archivedResults.length ? (
        <div className="mt-3 border-t border-border pt-3 text-sm font-medium text-muted-foreground">Archived</div>
      ) : null}
      {archivedResults.map(renderResult)}
      {!props.results.length ? (
        <p className="px-2 py-3 text-sm text-muted-foreground">
          {props.loading
            ? 'Searching sessions...'
            : props.filterCount
              ? 'No sessions match the current filters.'
              : 'No matching sessions.'}
        </p>
      ) : null}
      {props.hasMore ? (
        <Button
          className="mt-2 w-full"
          variant="secondary"
          size="sm"
          disabled={props.loading}
          onClick={props.onLoadMore}
        >
          {props.loading ? 'Loading...' : 'Load more results'}
        </Button>
      ) : null}
    </div>
  );
}

function SessionButton(props: {
  canWriteSession: boolean;
  session: Session;
  selected: boolean;
  compact?: boolean | undefined;
  matchKind?: SessionSearchResult['matchKind'];
  snippet?: string;
  onSelect: (sessionId: string) => void;
  onStarChange: (sessionId: string, starred: boolean) => void;
  onArchive?: (sessionId: string) => void;
  onUnarchive?: (sessionId: string) => void;
}) {
  const displayStatus = sessionDisplayStatus(props.session);
  const displayTooltip = sessionDisplayTooltip(props.session);
  const title = props.session.title || 'Untitled session';
  const snippet = props.snippet ? cleanSnippet(props.snippet) : '';
  const showSnippet = Boolean(
    snippet && !(props.matchKind === 'title' && normalizedSearchText(snippet) === normalizedSearchText(title)),
  );
  const showContextLine = props.compact && showSnippet && props.matchKind !== 'title';
  const canArchive = props.canWriteSession && Boolean(props.onArchive);
  const canRestore = props.canWriteSession && Boolean(props.onUnarchive);

  function toggleStar() {
    props.onStarChange(props.session.id, !props.session.starred);
  }

  function archiveSession() {
    props.onArchive?.(props.session.id);
  }

  function restoreSession() {
    props.onUnarchive?.(props.session.id);
  }

  return (
    <div
      className={cn(
        'group relative w-full min-w-0 rounded-md border border-transparent px-2 py-1.5 hover:bg-accent',
        props.compact && 'p-1.5',
        props.selected && 'border-primary bg-primary/15',
        props.session.status === 'archived' && 'opacity-75',
      )}
    >
      <button
        className="block w-full min-w-0 overflow-hidden bg-transparent p-0 text-left"
        type="button"
        onClick={() => props.onSelect(props.session.id)}
      >
        <strong
          className={cn(
            'flex w-full min-w-0 items-center gap-1.5 text-sm font-medium text-foreground',
            props.compact && 'leading-4',
          )}
        >
          <span className="min-w-0 truncate">{title}</span>
        </strong>
      </button>
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <button
          className="block min-w-0 flex-1 overflow-hidden bg-transparent p-0 text-left"
          type="button"
          onClick={() => props.onSelect(props.session.id)}
        >
          <span
            className={cn(
              'block w-full truncate text-xs leading-5 text-muted-foreground',
              props.compact && props.matchKind && 'mt-0.5 whitespace-normal leading-4',
            )}
            title={displayTooltip}
          >
            <span className={statusTextClass(displayStatus)}>{displayStatus}</span> ·{' '}
            {formatDate(props.session.lastActivityAt ?? props.session.updatedAt)}
            {props.matchKind ? (
              <>
                {' '}
                ·{' '}
                <span className="rounded border border-border px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
                  {props.matchKind}
                </span>
              </>
            ) : null}
            {showSnippet && !showContextLine ? <> · {snippet}</> : null}
          </span>
        </button>
        <div className="flex h-6 shrink-0 items-center gap-1">
          <Button
            className={cn(
              'h-5 w-5 bg-card/90 p-0 text-muted-foreground shadow-sm hover:text-foreground md:shadow-none',
              !props.session.starred &&
                'md:pointer-events-none md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100',
            )}
            variant="ghost"
            size="icon"
            type="button"
            onClick={toggleStar}
            aria-label={props.session.starred ? 'Unstar session' : 'Star session'}
            aria-pressed={props.session.starred === true}
            title={props.session.starred ? 'Unstar session' : 'Star session'}
          >
            <Star className={cn('h-3.5 w-3.5', props.session.starred && 'fill-current text-warning')} />
          </Button>
          {canArchive ? (
            <Button
              className="h-5 w-5 bg-card/90 p-0 text-muted-foreground shadow-sm hover:text-destructive md:pointer-events-none md:opacity-0 md:shadow-none md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100"
              variant="ghost"
              size="icon"
              type="button"
              onClick={archiveSession}
              aria-label="Archive session"
              title="Archive session"
            >
              <Archive className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {canRestore ? (
            <Button
              className="h-5 w-5 bg-card/90 p-0 text-muted-foreground shadow-sm hover:text-foreground md:pointer-events-none md:opacity-0 md:shadow-none md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100"
              variant="ghost"
              size="icon"
              type="button"
              onClick={restoreSession}
              aria-label="Restore session"
              title="Restore session"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
      <button
        className="block w-full min-w-0 overflow-hidden bg-transparent p-0 text-left"
        type="button"
        onClick={() => props.onSelect(props.session.id)}
      >
        {showContextLine ? (
          <span className="mt-0.5 line-clamp-3 block text-xs leading-4 text-muted-foreground">{snippet}</span>
        ) : null}
      </button>
    </div>
  );
}

function cleanSnippet(value: string): string {
  return value
    .replace(/<\/?mark>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeTagQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function compareTagNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
