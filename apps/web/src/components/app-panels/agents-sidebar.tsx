import { Archive, CornerUpLeft, PanelLeftClose, Plus, RotateCcw } from 'lucide-react';
import type { AgentProfile } from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { SidebarFooter, type SidebarFooterProps } from './sidebar-footer.js';

const builtinOrder = [
  'builtin:general',
  'builtin:reviewer',
  'builtin:adversary',
  'builtin:codebase-researcher',
  'builtin:external-codebase-researcher',
];

export function AgentsSidebar(props: {
  profiles: AgentProfile[];
  defaultProfileId: string | null;
  selectedId: string;
  loading: boolean;
  canManage: boolean;
  footerProps: SidebarFooterProps;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onBack: () => void;
  onCollapse: () => void;
}) {
  const builtins = props.profiles
    .filter((profile) => profile.source === 'builtin')
    .sort((left, right) => builtinOrder.indexOf(left.id) - builtinOrder.indexOf(right.id));
  const managed = props.profiles
    .filter((profile) => profile.source === 'managed')
    .sort((left, right) => {
      const archiveOrder = Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt));
      return (
        archiveOrder ||
        left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
        left.id.localeCompare(right.id)
      );
    });
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="mb-3 flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={props.onCollapse} aria-label="Hide sidebar">
          <PanelLeftClose className="h-4 w-4" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Agents</h2>
        <Button variant="secondary" size="icon" onClick={props.onBack} aria-label="Back to sessions">
          <CornerUpLeft className="h-4 w-4" />
        </Button>
        <Button size="icon" onClick={props.onCreate} disabled={!props.canManage} aria-label="New agent">
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ProfileSection {...props} title="Built-in agents" profiles={builtins} />
        <ProfileSection {...props} title="Custom agents" profiles={managed} />
        {!props.profiles.length ? (
          <p className="p-2 text-sm text-muted-foreground">
            {props.loading ? 'Loading agents...' : 'No agents available.'}
          </p>
        ) : null}
      </div>
      <SidebarFooter {...props.footerProps} />
    </div>
  );
}

function ProfileSection(props: {
  title: string;
  profiles: AgentProfile[];
  defaultProfileId: string | null;
  selectedId: string;
  canManage: boolean;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  if (!props.profiles.length) return null;
  return (
    <section className="mb-5">
      <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {props.title}
      </h3>
      <div className="grid gap-1">
        {props.profiles.map((profile) => (
          <div
            key={profile.id}
            className={cn(
              'group relative rounded-md border border-transparent p-2 hover:bg-accent',
              profile.id === props.selectedId && 'border-primary bg-primary/15',
              (profile.archivedAt || !profile.enabled) &&
                'border-dashed border-muted-foreground/40 bg-muted/40 text-muted-foreground',
            )}
          >
            <button
              className={cn(
                'block w-full min-w-0 text-left',
                profile.source === 'managed' && props.canManage && 'pr-8',
              )}
              onClick={() => props.onSelect(profile.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <strong className="min-w-0 flex-1 truncate text-sm">{profile.name}</strong>
                {profile.archivedAt || !profile.enabled ? (
                  <span className="shrink-0 rounded border border-muted-foreground/40 bg-background/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
                    {profile.archivedAt ? 'Archived' : 'Disabled'}
                  </span>
                ) : profile.id === props.defaultProfileId ? (
                  <span className="shrink-0 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
                    Default
                  </span>
                ) : null}
              </span>
              <span
                className="line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground"
                title={profile.description}
              >
                {profile.description}
              </span>
            </button>
            {profile.source === 'managed' && props.canManage ? (
              <Button
                className="absolute bottom-1 right-1 h-7 w-7 bg-background/90 p-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                variant="ghost"
                size="icon"
                aria-label={`${profile.archivedAt ? 'Restore' : 'Archive'} ${profile.name}`}
                onClick={() => (profile.archivedAt ? props.onRestore(profile.id) : props.onArchive(profile.id))}
              >
                {profile.archivedAt ? <RotateCcw className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
