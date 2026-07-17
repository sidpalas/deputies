import { useMemo, useState, type SyntheticEvent } from 'react';
import { Archive, ChevronDown, CornerUpLeft, PanelLeftClose, Plus, RotateCcw, X } from 'lucide-react';
import type { Environment } from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { formatDate } from './shared.js';
import { SidebarFooter, type SidebarFooterProps } from './sidebar-footer.js';

export function EnvironmentsSidebar(props: {
  canCallApi: boolean;
  canCreateEnvironments: boolean;
  environments: Environment[];
  footerProps: SidebarFooterProps;
  loading: boolean;
  selectedEnvironmentId: string;
  onArchiveEnvironment: (environmentId: string) => void;
  onBackToSessions: () => void;
  onCollapse: () => void;
  onCreateEnvironment: () => void;
  onRestoreEnvironment: (environmentId: string) => void;
  onSelectEnvironment: (environmentId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [archivedOpenState, setArchivedOpenState] = useState(false);
  const normalizedSearch = search.trim().toLowerCase();
  const sortedEnvironments = useMemo(
    () => [...props.environments].sort((left, right) => left.name.localeCompare(right.name)),
    [props.environments],
  );
  const filteredEnvironments = normalizedSearch
    ? sortedEnvironments.filter(
        (environment) =>
          environment.name.toLowerCase().includes(normalizedSearch) ||
          (environment.ownerGroupName ?? '').toLowerCase().includes(normalizedSearch) ||
          environment.repositories.some((repository) =>
            `${repository.owner}/${repository.repo}`.toLowerCase().includes(normalizedSearch),
          ),
      )
    : sortedEnvironments;
  const activeEnvironments = filteredEnvironments.filter((environment) => !environment.archivedAt);
  const archivedEnvironments = filteredEnvironments.filter((environment) => environment.archivedAt);
  const selectedArchived = archivedEnvironments.some((environment) => environment.id === props.selectedEnvironmentId);
  const searching = Boolean(normalizedSearch);
  const archivedOpen = searching || selectedArchived || archivedOpenState;

  function handleArchivedToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (searching || selectedArchived) return;
    setArchivedOpenState(event.currentTarget.open);
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
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Environments</h2>
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
          <Button
            size="icon"
            onClick={props.onCreateEnvironment}
            disabled={!props.canCallApi || !props.canCreateEnvironments}
            aria-label="New environment"
            title={props.canCreateEnvironments ? 'New environment' : 'Group admin access is required'}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="relative mb-3 shrink-0">
        <Input
          className="pr-9"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search environments..."
        />
        {search ? (
          <Button
            className="absolute right-1 top-1 h-8 w-8 p-0"
            variant="ghost"
            size="icon"
            onClick={() => setSearch('')}
            aria-label="Clear environment search"
            title="Clear environment search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="grid min-w-0 gap-1">
          {activeEnvironments.map((environment) => (
            <EnvironmentSidebarButton
              key={environment.id}
              environment={environment}
              selected={environment.id === props.selectedEnvironmentId}
              onArchive={props.onArchiveEnvironment}
              onSelect={props.onSelectEnvironment}
            />
          ))}
          {!activeEnvironments.length ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              {activeEnvironmentsEmptyMessage(props.loading, search)}
            </p>
          ) : null}
        </div>

        {archivedEnvironments.length || searching ? (
          <details className="mt-4 border-t border-border pt-3" open={archivedOpen} onToggle={handleArchivedToggle}>
            <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-muted-foreground">
              <ChevronDown className={cn('h-4 w-4 -rotate-90 transition-transform', archivedOpen && 'rotate-0')} />
              Archived · {archivedEnvironments.length}
            </summary>
            {archivedEnvironments.length ? (
              <div className="mt-2 grid min-w-0 gap-1 opacity-80">
                {archivedEnvironments.map((environment) => (
                  <EnvironmentSidebarButton
                    key={environment.id}
                    environment={environment}
                    selected={environment.id === props.selectedEnvironmentId}
                    onRestore={props.onRestoreEnvironment}
                    onSelect={props.onSelectEnvironment}
                  />
                ))}
              </div>
            ) : (
              <p className="px-2 py-3 text-sm text-muted-foreground">No matching archived environments.</p>
            )}
          </details>
        ) : null}
      </div>

      <SidebarFooter {...props.footerProps} />
    </div>
  );
}

function EnvironmentSidebarButton(props: {
  environment: Environment;
  selected: boolean;
  onArchive?: (environmentId: string) => void;
  onRestore?: (environmentId: string) => void;
  onSelect: (environmentId: string) => void;
}) {
  const repositoryCount = props.environment.repositories.length;
  return (
    <div
      className={cn(
        'group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-transparent p-2 text-left hover:bg-accent',
        props.selected && 'border-primary bg-primary/15',
      )}
    >
      <button
        type="button"
        className="block min-w-0 flex-1 overflow-hidden bg-transparent p-0 text-left"
        onClick={() => props.onSelect(props.environment.id)}
      >
        <strong className="block w-full truncate text-sm font-medium text-foreground">{props.environment.name}</strong>
        <span className="block w-full truncate text-xs text-muted-foreground">
          {props.environment.ownerGroupName ?? 'Unknown group'} · {repositoryCount} repo
          {repositoryCount === 1 ? '' : 's'}
        </span>
        <span className="block w-full truncate text-xs text-muted-foreground">
          {props.environment.archivedAt
            ? `Archived ${formatDate(props.environment.archivedAt)}`
            : shareModeLabel(props.environment)}
        </span>
      </button>
      {props.environment.canManage && !props.environment.archivedAt && props.onArchive ? (
        <Button
          className="w-8 shrink-0 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          variant="ghost"
          size="sm"
          onClick={() => props.onArchive?.(props.environment.id)}
          aria-label={`Archive ${props.environment.name} environment`}
          title="Archive environment"
        >
          <Archive className="h-3.5 w-3.5" />
        </Button>
      ) : null}
      {props.environment.canManage && props.environment.archivedAt && props.onRestore ? (
        <Button
          className="w-8 shrink-0 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          variant="ghost"
          size="sm"
          onClick={() => props.onRestore?.(props.environment.id)}
          aria-label={`Restore ${props.environment.name} environment`}
          title="Restore environment"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function activeEnvironmentsEmptyMessage(loading: boolean, search: string): string {
  if (loading) return 'Loading environments...';
  if (search) return 'No matching active environments.';
  return 'No active environments.';
}

function shareModeLabel(environment: Environment): string {
  if (environment.shareMode === 'all_groups') return 'Available to all groups';
  if (environment.shareMode === 'selected_groups') return `Shared with ${environment.sharedGroupIds.length} group(s)`;
  return 'Owner group only';
}
