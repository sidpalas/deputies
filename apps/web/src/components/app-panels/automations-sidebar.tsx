import { useMemo, useState, type SyntheticEvent } from 'react';
import { Archive, ChevronDown, CornerUpLeft, PanelLeftClose, Plus, RotateCcw, X } from 'lucide-react';
import type { Automation, Group, Health } from '../../api.js';
import { archivedAutomationsOpenStorageKey } from '../../app-helpers.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { formatDate } from './shared.js';
import { SidebarFooter } from './session-sidebar.js';
import type { ConnectionStatus, ThemePreference } from './types.js';

export function AutomationsSidebar(props: {
  archivedAutomationsOpen: boolean;
  authRequired: boolean;
  automations: Automation[];
  canCallApi: boolean;
  canCreateAutomations: boolean;
  canViewGroups: boolean;
  canViewAutomations: boolean;
  canViewEnvironments: boolean;
  canViewSetup: boolean;
  connectionStatus: ConnectionStatus;
  groups: Group[];
  health: Health | null;
  loading: boolean;
  navPage: 'sessions' | 'setup' | 'groups' | 'automations' | 'environments';
  selectedAutomationId: string;
  themePreference: ThemePreference;
  token: string;
  onArchiveAutomation: (automationId: string) => void;
  onArchivedAutomationsOpenChange: (open: boolean) => void;
  onBackToSessions: () => void;
  onCollapse: () => void;
  onCreateAutomation: () => void;
  onOpenAutomations: () => void;
  onOpenEnvironments: () => void;
  onOpenGroups: () => void;
  onOpenSessions: () => void;
  onOpenSetup: () => void;
  onSelectAutomation: (automationId: string) => void;
  onSignOut: () => void;
  onThemeChange: (value: ThemePreference) => void;
  onUnarchiveAutomation: (automationId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const normalizedSearch = search.trim().toLowerCase();
  const sortedAutomations = useMemo(
    () => [...props.automations].sort((a, b) => a.name.localeCompare(b.name)),
    [props.automations],
  );
  const filteredAutomations = normalizedSearch
    ? sortedAutomations.filter(
        (automation) =>
          automation.name.toLowerCase().includes(normalizedSearch) ||
          automation.scheduleCron.toLowerCase().includes(normalizedSearch),
      )
    : sortedAutomations;
  const activeAutomations = filteredAutomations.filter((automation) => !automation.archivedAt);
  const archivedAutomations = filteredAutomations.filter((automation) => automation.archivedAt);
  const searching = Boolean(normalizedSearch);
  const archivedOpen = searching || props.archivedAutomationsOpen;
  const emptyActiveAutomationsMessage = activeAutomationsEmptyMessage(props.loading, search);

  function handleArchivedToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (searching) return;
    const open = event.currentTarget.open;
    sessionStorage.setItem(archivedAutomationsOpenStorageKey, String(open));
    props.onArchivedAutomationsOpenChange(open);
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
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Automations</h2>
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
            onClick={props.onCreateAutomation}
            disabled={!props.canCallApi || !props.canCreateAutomations}
            aria-label="New automation"
            title={props.canCreateAutomations ? 'New automation' : 'No access group allows you to create automations'}
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
          placeholder="Search automations..."
        />
        {search ? (
          <Button
            className="absolute right-1 top-1 h-8 w-8 p-0"
            variant="ghost"
            size="icon"
            onClick={() => setSearch('')}
            aria-label="Clear automation search"
            title="Clear automation search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="grid min-w-0 gap-1">
          {activeAutomations.map((automation) => (
            <AutomationSidebarButton
              key={automation.id}
              automation={automation}
              ownerGroupArchived={automationOwnerGroupArchived(automation, props.groups)}
              selected={automation.id === props.selectedAutomationId}
              onArchive={props.onArchiveAutomation}
              onSelect={props.onSelectAutomation}
            />
          ))}
          {!activeAutomations.length ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">{emptyActiveAutomationsMessage}</p>
          ) : null}
        </div>

        {archivedAutomations.length || searching ? (
          <details className="mt-4 border-t border-border pt-3" open={archivedOpen} onToggle={handleArchivedToggle}>
            <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-muted-foreground">
              <ChevronDown className={cn('h-4 w-4 -rotate-90 transition-transform', archivedOpen && 'rotate-0')} />
              Archived · {archivedAutomations.length}
            </summary>
            {archivedAutomations.length ? (
              <div className="mt-2 grid min-w-0 gap-1 opacity-80">
                {archivedAutomations.map((automation) => (
                  <AutomationSidebarButton
                    key={automation.id}
                    automation={automation}
                    ownerGroupArchived={automationOwnerGroupArchived(automation, props.groups)}
                    selected={automation.id === props.selectedAutomationId}
                    onSelect={props.onSelectAutomation}
                    onUnarchive={props.onUnarchiveAutomation}
                  />
                ))}
              </div>
            ) : (
              <p className="px-2 py-3 text-sm text-muted-foreground">No matching archived automations.</p>
            )}
          </details>
        ) : null}
      </div>

      <SidebarFooter
        authRequired={props.authRequired}
        canViewGroups={props.canViewGroups}
        canViewAutomations={props.canViewAutomations}
        canViewEnvironments={props.canViewEnvironments}
        canViewSetup={props.canViewSetup}
        health={props.health}
        navPage={props.navPage}
        themePreference={props.themePreference}
        token={props.token}
        onOpenGroups={props.onOpenGroups}
        onOpenAutomations={props.onOpenAutomations}
        onOpenEnvironments={props.onOpenEnvironments}
        onOpenSessions={props.onOpenSessions}
        onOpenSetup={props.onOpenSetup}
        onSignOut={props.onSignOut}
        onThemeChange={props.onThemeChange}
      />
    </div>
  );
}

function AutomationSidebarButton(props: {
  automation: Automation;
  ownerGroupArchived: boolean;
  selected: boolean;
  onArchive?: (automationId: string) => void;
  onSelect: (automationId: string) => void;
  onUnarchive?: (automationId: string) => void;
}) {
  const status = automationSidebarStatus(props.automation, props.ownerGroupArchived);

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
        onClick={() => props.onSelect(props.automation.id)}
      >
        <strong className="block w-full truncate text-sm font-medium text-foreground">{props.automation.name}</strong>
        <span className="block w-full truncate font-mono text-xs text-muted-foreground">
          {props.automation.scheduleCron} UTC
        </span>
        <span className="block w-full truncate text-xs">
          <span className={cn('font-medium', status.labelClassName)}>{status.label}</span>
          <span className="text-muted-foreground"> · {status.detail}</span>
        </span>
      </button>
      {props.automation.canManage && !props.automation.archivedAt && props.onArchive ? (
        <Button
          className="w-8 shrink-0 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          variant="ghost"
          size="sm"
          onClick={() => props.onArchive?.(props.automation.id)}
          aria-label="Archive automation"
          title="Archive automation"
        >
          <Archive className="h-3.5 w-3.5" />
        </Button>
      ) : null}
      {props.automation.canManage && props.automation.archivedAt && props.onUnarchive ? (
        <Button
          className="w-8 shrink-0 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          variant="ghost"
          size="sm"
          onClick={() => props.onUnarchive?.(props.automation.id)}
          aria-label="Restore automation"
          title="Restore automation"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function activeAutomationsEmptyMessage(loading: boolean, search: string): string {
  if (loading) return 'Loading automations...';
  if (search) return 'No matching active automations.';
  return 'No active scheduled automations.';
}

function automationSidebarStatus(
  automation: Automation,
  ownerGroupArchived: boolean,
): { label: string; labelClassName: string; detail: string } {
  if (automation.archivedAt) {
    return { label: 'Archived', labelClassName: 'text-muted-foreground', detail: formatDate(automation.archivedAt) };
  }

  const label = automation.enabled ? 'Enabled' : 'Disabled';
  const labelClassName = automation.enabled ? 'text-success' : 'text-warning';
  if (ownerGroupArchived) return { label, labelClassName, detail: 'Suspended: access group archived' };

  const nextInvocation = automation.nextInvocationAt ? formatDate(automation.nextInvocationAt) : 'not scheduled';
  return { label, labelClassName, detail: `Next ${nextInvocation}` };
}

function automationOwnerGroupArchived(automation: Automation, groups: Group[]): boolean {
  return Boolean(
    groups.find((group) => group.id === automation.ownerGroupId)?.archivedAt ?? automation.ownerGroupArchivedAt,
  );
}
