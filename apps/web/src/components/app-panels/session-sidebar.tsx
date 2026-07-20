import { useEffect, useMemo, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import {
  ChevronDown,
  FilePlus2,
  ListTree,
  MessageCircle,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Star,
  X,
  type LucideIcon,
} from 'lucide-react';
import { type Session, type SessionSearchResult, type SessionTagSummary } from '../../api.js';
import { archivedSessionsOpenStorageKey } from '../../app-helpers.js';
import { cn } from '../../lib/utils.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import {
  formatDate,
  sessionDisplayStatus,
  sessionDisplayTooltip,
  SidebarArchiveRestoreAction,
  statusTextClass,
} from './shared.js';
import { SidebarFooter, type SidebarFooterProps } from './sidebar-footer.js';

type SessionFilters = {
  tags: string[];
  createdByMe: boolean;
  participatedByMe: boolean;
  starredByMe: boolean;
};

type SessionTreeNode = {
  session: Session;
  children: SessionTreeNode[];
};

export function ThreadSidebar(props: {
  archivedSessionsOpen: boolean;
  canCallApi: boolean;
  canStartNewThread: boolean;
  canWriteSession: (session: Session) => boolean;
  archivedSessionsLoaded: boolean;
  archivedSessionsLoading: boolean;
  hasMoreArchivedSessions: boolean;
  hasMoreSessions: boolean;
  loading: boolean;
  loadingMoreSessions: boolean;
  childSessionCursors: Map<string, string | null>;
  childSessionsLoading: Set<string>;
  revealedLineage: Session[];
  revealedLineageSearchQuery: string;
  searchQuery: string;
  searchResults: SessionSearchResult[];
  searchLoading: boolean;
  hasMoreSearchResults: boolean;
  sessionFilters: SessionFilters;
  sessionFilterCount: number;
  sessionTagOptions: SessionTagSummary[];
  sessions: Session[];
  selectedSessionId: string;
  footerProps: SidebarFooterProps;
  onArchive: (sessionId: string) => void;
  onArchivedSessionsOpenChange: (open: boolean) => void;
  onCollapse: () => void;
  onLoadMoreArchivedSessions: () => void;
  onLoadMoreSearchResults: () => void;
  onLoadMoreSessions: () => void;
  onLoadChildSessions: (session: Session) => void;
  onNewThread: () => void;
  onRefresh: () => void;
  onClearLineageFilters: () => void;
  onClearLineageSearch: () => void;
  onDismissLineageReveal: () => void;
  onSearchChange: (query: string) => void;
  onSelect: (sessionId: string) => void;
  onShowInTree: (session: Session) => void;
  onSessionFiltersChange: (filters: SessionFilters) => void;
  onSessionFiltersClear: () => void;
  onSessionListHoverChange: (hovered: boolean) => void;
  onSessionStarChange: (sessionId: string, starred: boolean) => void;
  onUnarchive: (sessionId: string) => void;
}) {
  const revealedIds = useMemo(
    () => new Set(props.revealedLineage.map((session) => session.id)),
    [props.revealedLineage],
  );
  const activeSessions = useMemo(
    () => props.sessions.filter((session) => session.status !== 'archived' && !revealedIds.has(session.id)),
    [props.sessions, revealedIds],
  );
  const archivedSessions = useMemo(
    () => props.sessions.filter((session) => session.status === 'archived' && !revealedIds.has(session.id)),
    [props.sessions, revealedIds],
  );
  const revealedSessionTree = useMemo(() => buildSessionTree(props.revealedLineage), [props.revealedLineage]);
  const activeSessionTree = useMemo(() => buildSessionTree(activeSessions), [activeSessions]);
  const archivedSessionTree = useMemo(() => buildSessionTree(archivedSessions), [archivedSessions]);
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
            onShowInTree={props.onShowInTree}
            onStarChange={props.onSessionStarChange}
            onUnarchive={props.onUnarchive}
          />
        ) : (
          <>
            {props.revealedLineage.length ? (
              <div className="mb-2">
                <div className="rounded-md border border-primary/40 bg-primary/10 p-2 text-xs" role="status">
                  <p className="font-medium text-foreground">Showing selected session lineage</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {props.revealedLineageSearchQuery
                      ? 'Ancestors are included even when they do not match your search.'
                      : props.sessionFilterCount
                        ? 'Some ancestors are outside your current filters.'
                        : 'Ancestors outside the loaded session page are included.'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {props.revealedLineageSearchQuery ? (
                      <Button variant="secondary" size="sm" className="h-7 px-2" onClick={props.onClearLineageSearch}>
                        Clear search
                      </Button>
                    ) : null}
                    {props.sessionFilterCount ? (
                      <Button variant="secondary" size="sm" className="h-7 px-2" onClick={props.onClearLineageFilters}>
                        Clear filters
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={props.onDismissLineageReveal}>
                      Hide lineage
                    </Button>
                  </div>
                </div>
                <div className="mt-1 grid min-w-0 gap-1">
                  <SessionTree
                    nodes={revealedSessionTree}
                    selectedSessionId={props.selectedSessionId}
                    canWriteSession={props.canWriteSession}
                    onSelect={props.onSelect}
                    onShowInTree={props.onShowInTree}
                    onStarChange={props.onSessionStarChange}
                    showActions={false}
                  />
                </div>
              </div>
            ) : null}
            <div className="grid min-w-0 gap-1">
              <SessionTree
                nodes={activeSessionTree}
                selectedSessionId={props.selectedSessionId}
                canWriteSession={props.canWriteSession}
                onArchive={props.onArchive}
                onSelect={props.onSelect}
                onShowInTree={props.onShowInTree}
                onStarChange={props.onSessionStarChange}
                childSessionCursors={props.childSessionCursors}
                childSessionsLoading={props.childSessionsLoading}
                onLoadChildSessions={props.onLoadChildSessions}
              />
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
                  <SessionTree
                    nodes={archivedSessionTree}
                    selectedSessionId={props.selectedSessionId}
                    canWriteSession={props.canWriteSession}
                    onSelect={props.onSelect}
                    onShowInTree={props.onShowInTree}
                    onStarChange={props.onSessionStarChange}
                    childSessionCursors={props.childSessionCursors}
                    childSessionsLoading={props.childSessionsLoading}
                    onLoadChildSessions={props.onLoadChildSessions}
                    onUnarchive={props.onUnarchive}
                  />
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
      <SidebarFooter {...props.footerProps} />
    </div>
  );
}

function SessionTree(props: {
  nodes: SessionTreeNode[];
  depth?: number;
  selectedSessionId: string;
  canWriteSession: (session: Session) => boolean;
  onSelect: (sessionId: string) => void;
  onShowInTree: (session: Session) => void;
  onStarChange: (sessionId: string, starred: boolean) => void;
  childSessionCursors?: Map<string, string | null>;
  childSessionsLoading?: Set<string>;
  onLoadChildSessions?: (session: Session) => void;
  showActions?: boolean;
  onArchive?: (sessionId: string) => void;
  onUnarchive?: (sessionId: string) => void;
}) {
  return props.nodes.map((node) => (
    <SessionTreeItem key={node.session.id} {...props} node={node} depth={props.depth ?? 0} />
  ));
}

function SessionTreeItem(props: {
  node: SessionTreeNode;
  depth: number;
  selectedSessionId: string;
  canWriteSession: (session: Session) => boolean;
  onSelect: (sessionId: string) => void;
  onShowInTree: (session: Session) => void;
  onStarChange: (sessionId: string, starred: boolean) => void;
  childSessionCursors?: Map<string, string | null>;
  childSessionsLoading?: Set<string>;
  onLoadChildSessions?: (session: Session) => void;
  showActions?: boolean;
  onArchive?: (sessionId: string) => void;
  onUnarchive?: (sessionId: string) => void;
}) {
  const { session, children } = props.node;
  const unloadedChildCount = Math.max(0, (session.directChildCount ?? 0) - children.length);
  const childCursorKnown = props.childSessionCursors?.has(session.id) ?? false;
  const canLoadChildren =
    unloadedChildCount > 0 && (!childCursorKnown || props.childSessionCursors?.get(session.id) !== null);

  return (
    <div className="min-w-0">
      <SessionButton
        session={session}
        selected={session.id === props.selectedSessionId}
        canWriteSession={props.canWriteSession(session)}
        detachedSubSession={props.depth === 0 && Boolean(session.parentSessionId)}
        onSelect={props.onSelect}
        onShowInTree={props.onShowInTree}
        onStarChange={props.onStarChange}
        {...(props.showActions === undefined ? {} : { showActions: props.showActions })}
        {...(props.onArchive ? { onArchive: props.onArchive } : {})}
        {...(props.onUnarchive ? { onUnarchive: props.onUnarchive } : {})}
      />
      {children.length || canLoadChildren ? (
        <div className="ml-2 border-l border-border/80 pl-2">
          {children.length ? (
            <SessionTree
              nodes={children}
              depth={props.depth + 1}
              selectedSessionId={props.selectedSessionId}
              canWriteSession={props.canWriteSession}
              onSelect={props.onSelect}
              onShowInTree={props.onShowInTree}
              onStarChange={props.onStarChange}
              {...(props.childSessionCursors ? { childSessionCursors: props.childSessionCursors } : {})}
              {...(props.childSessionsLoading ? { childSessionsLoading: props.childSessionsLoading } : {})}
              {...(props.onLoadChildSessions ? { onLoadChildSessions: props.onLoadChildSessions } : {})}
              {...(props.showActions === undefined ? {} : { showActions: props.showActions })}
              {...(props.onArchive ? { onArchive: props.onArchive } : {})}
              {...(props.onUnarchive ? { onUnarchive: props.onUnarchive } : {})}
            />
          ) : null}
          {canLoadChildren && props.onLoadChildSessions ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-start px-2 text-xs text-muted-foreground"
              disabled={props.childSessionsLoading?.has(session.id)}
              onClick={() => props.onLoadChildSessions?.(session)}
            >
              {props.childSessionsLoading?.has(session.id)
                ? 'Loading sub-sessions...'
                : `Load ${unloadedChildCount} more sub-session${unloadedChildCount === 1 ? '' : 's'}`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function buildSessionTree(sessions: Session[]): SessionTreeNode[] {
  const nodesById = new Map(sessions.map((session) => [session.id, { session, children: [] as SessionTreeNode[] }]));
  const roots: SessionTreeNode[] = [];

  for (const session of sessions) {
    const node = nodesById.get(session.id)!;
    const parent = session.parentSessionId ? nodesById.get(session.parentSessionId) : undefined;
    if (parent && parent.session.spawnDepth < session.spawnDepth) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
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
  onShowInTree: (session: Session) => void;
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
        detachedSubSession={Boolean(result.session.parentSessionId)}
        matchKind={result.matchKind}
        snippet={result.snippet}
        onSelect={props.onSelect}
        onShowInTree={props.onShowInTree}
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
  detachedSubSession?: boolean;
  showActions?: boolean;
  onSelect: (sessionId: string) => void;
  onShowInTree?: (session: Session) => void;
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
              'flex w-full min-w-0 items-baseline text-xs leading-5 text-muted-foreground',
              props.compact && props.matchKind && 'mt-0.5 whitespace-normal leading-4',
            )}
            title={displayTooltip}
          >
            <span className="min-w-0 truncate">
              <span className={statusTextClass(displayStatus)}>{displayStatus}</span>
            </span>
            <span className="shrink-0 whitespace-nowrap">
              {' '}
              · {formatDate(props.session.lastActivityAt ?? props.session.updatedAt)}
            </span>
            {props.matchKind ? (
              <>
                {' '}
                ·{' '}
                <span className="shrink-0 rounded border border-border px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
                  {props.matchKind}
                </span>
              </>
            ) : null}
            {showSnippet && !showContextLine ? <span className="min-w-0 truncate"> · {snippet}</span> : null}
          </span>
        </button>
        {props.showActions !== false ? (
          <div className="flex h-6 shrink-0 items-center gap-1">
            {props.detachedSubSession && props.onShowInTree ? (
              <Button
                className="h-5 w-5 bg-card/90 p-0 text-muted-foreground shadow-sm hover:text-foreground md:shadow-none"
                variant="ghost"
                size="icon"
                type="button"
                onClick={() => props.onShowInTree?.(props.session)}
                aria-label="Show in session tree"
                title="Show in session tree"
              >
                <ListTree className="h-3.5 w-3.5" />
              </Button>
            ) : null}
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
              <SidebarArchiveRestoreAction
                archived={false}
                resourceLabel="session"
                resourceType="session"
                className="h-5 w-5 bg-card/90 p-0 text-muted-foreground shadow-sm hover:text-destructive md:pointer-events-none md:opacity-0 md:shadow-none md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100"
                onClick={archiveSession}
              />
            ) : null}
            {canRestore ? (
              <SidebarArchiveRestoreAction
                archived
                resourceLabel="session"
                resourceType="session"
                className="h-5 w-5 bg-card/90 p-0 text-muted-foreground shadow-sm hover:text-foreground md:pointer-events-none md:opacity-0 md:shadow-none md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100"
                onClick={restoreSession}
              />
            ) : null}
          </div>
        ) : null}
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
