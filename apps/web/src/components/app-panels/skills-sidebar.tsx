import { useMemo, useState, type SyntheticEvent } from 'react';
import {
  Archive,
  ChevronDown,
  CircleOff,
  CornerUpLeft,
  MousePointerClick,
  PanelLeftClose,
  Plus,
  RotateCcw,
  X,
  Zap,
} from 'lucide-react';
import type { Group, Skill } from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { SidebarFooter, type SidebarFooterProps } from './sidebar-footer.js';

export function SkillsSidebar(props: {
  canCallApi: boolean;
  canCreateSkills: boolean;
  footerProps: SidebarFooterProps;
  groups: Group[];
  loading: boolean;
  skills: Skill[];
  selectedSkillId: string;
  onBackToSessions: () => void;
  onArchiveSkill: (skillId: string) => void;
  onCollapse: () => void;
  onCreateSkill: () => void;
  onRestoreSkill: (skillId: string) => void;
  onSelectSkill: (skillId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [archivedOpenState, setArchivedOpenState] = useState(false);
  const normalized = search.trim().toLowerCase();
  const skills = useMemo(
    () =>
      props.skills.filter(
        (skill) =>
          !normalized ||
          skill.name.toLowerCase().includes(normalized) ||
          skill.description.toLowerCase().includes(normalized),
      ),
    [props.skills, normalized],
  );
  const activeSkills = skills.filter((skill) => !skill.archivedAt);
  const archivedSkills = skills.filter((skill) => skill.archivedAt);
  const personal = activeSkills.filter(
    (skill) => skill.source === 'personal' || (!skill.ownerGroupId && skill.source !== 'repo'),
  );
  const shared = activeSkills.filter((skill) => skill.source === 'shared');
  const groupSkills = activeSkills.filter((skill) => skill.source === 'group' || (skill.ownerGroupId && !skill.source));
  const searching = Boolean(normalized);
  const selectedArchived = archivedSkills.some((skill) => skill.id === props.selectedSkillId);
  const archivedOpen = searching || selectedArchived || archivedOpenState;

  function handleArchivedToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (searching || selectedArchived) return;
    setArchivedOpenState(event.currentTarget.open);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="icon" onClick={props.onCollapse} aria-label="Hide sidebar" title="Hide sidebar">
          <PanelLeftClose className="h-4 w-4" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Skills</h2>
        <Button variant="secondary" size="icon" onClick={props.onBackToSessions} aria-label="Back to sessions">
          <CornerUpLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          onClick={props.onCreateSkill}
          disabled={!props.canCallApi || !props.canCreateSkills}
          aria-label="New skill"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="relative mb-3 shrink-0">
        <Input
          className="pr-9"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search skills..."
        />
        {search ? (
          <Button
            className="absolute right-1 top-1 h-8 w-8 p-0"
            variant="ghost"
            size="icon"
            onClick={() => setSearch('')}
            aria-label="Clear skill search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <SkillSection
          title="My skills"
          skills={personal}
          selectedSkillId={props.selectedSkillId}
          onArchiveSkill={props.onArchiveSkill}
          onSelectSkill={props.onSelectSkill}
        />
        {props.groups.map((group) => {
          const items = groupSkills.filter((skill) => skill.ownerGroupId === group.id);
          return items.length ? (
            <SkillSection
              key={group.id}
              title={group.name}
              skills={items}
              selectedSkillId={props.selectedSkillId}
              onArchiveSkill={props.onArchiveSkill}
              onSelectSkill={props.onSelectSkill}
            />
          ) : null;
        })}
        <SkillSection
          title="Shared with my groups"
          skills={shared}
          selectedSkillId={props.selectedSkillId}
          onArchiveSkill={props.onArchiveSkill}
          onSelectSkill={props.onSelectSkill}
        />
        {archivedSkills.length || searching ? (
          <details className="mt-4 border-t border-border pt-3" open={archivedOpen} onToggle={handleArchivedToggle}>
            <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-muted-foreground">
              <ChevronDown className={cn('h-4 w-4 -rotate-90 transition-transform', archivedOpen && 'rotate-0')} />
              Archived · {archivedSkills.length}
            </summary>
            {archivedSkills.length ? (
              <div className="mt-2 opacity-80">
                <SkillSection
                  skills={archivedSkills}
                  selectedSkillId={props.selectedSkillId}
                  onRestoreSkill={props.onRestoreSkill}
                  onSelectSkill={props.onSelectSkill}
                />
              </div>
            ) : (
              <p className="px-2 py-3 text-sm text-muted-foreground">No matching archived skills.</p>
            )}
          </details>
        ) : null}
        {!skills.length ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {props.loading ? 'Loading skills...' : search ? 'No matching skills.' : 'No skills available.'}
          </p>
        ) : null}
      </div>
      <SidebarFooter {...props.footerProps} />
    </div>
  );
}

function SkillSection(props: {
  title?: string;
  skills: Skill[];
  selectedSkillId: string;
  onArchiveSkill?: (skillId: string) => void;
  onRestoreSkill?: (skillId: string) => void;
  onSelectSkill: (skillId: string) => void;
}) {
  if (!props.skills.length) return null;
  return (
    <section className="mb-4">
      {props.title ? (
        <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {props.title}
        </h3>
      ) : null}
      <div className="grid gap-1">
        {props.skills.map((skill) => {
          const canArchive = Boolean(skill.canManage && !skill.archivedAt && props.onArchiveSkill);
          const canRestore = Boolean(skill.canManage && skill.archivedAt && props.onRestoreSkill);
          return (
            <div
              key={skill.id}
              className={cn(
                'group relative block w-full min-w-0 rounded-md border border-transparent p-2 text-left hover:bg-accent',
                skill.id === props.selectedSkillId && 'border-primary bg-primary/15',
                skill.archivedAt && 'opacity-65',
              )}
            >
              <button
                type="button"
                className={cn(
                  'block w-full min-w-0 overflow-hidden bg-transparent p-0 text-left',
                  (canArchive || canRestore) && 'pr-10',
                )}
                onClick={() => props.onSelectSkill(skill.id)}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <strong className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{skill.name}</strong>
                  <SkillStatusIcon skill={skill} />
                </span>
                <span
                  className="block truncate text-xs text-muted-foreground"
                  title={`${skill.description}${
                    skill.source === 'shared' && skill.ownerGroupName ? ` · ${skill.ownerGroupName}` : ''
                  }`}
                >
                  {skill.description}
                  {skill.source === 'shared' && skill.ownerGroupName ? ` · ${skill.ownerGroupName}` : ''}
                </span>
              </button>
              {canArchive ? (
                <Button
                  className="absolute right-2 top-0.5 h-8 w-8 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onArchiveSkill?.(skill.id)}
                  aria-label={`Archive ${skill.name} skill`}
                  title="Archive skill"
                >
                  <Archive className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              {canRestore ? (
                <Button
                  className="absolute right-2 top-0.5 h-8 w-8 p-0 md:w-auto md:px-2.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onRestoreSkill?.(skill.id)}
                  aria-label={`Restore ${skill.name} skill`}
                  title="Restore skill"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SkillStatusIcon(props: { skill: Skill }) {
  if (props.skill.archivedAt) return null;
  if (!props.skill.enabled) {
    return (
      <span className="shrink-0 text-muted-foreground" aria-label="Disabled" title="Disabled">
        <CircleOff className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (props.skill.autoLoad) {
    return (
      <span className="shrink-0 text-primary" aria-label="Loads automatically" title="Loads automatically">
        <Zap className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span className="shrink-0 text-warning" aria-label="Manual invocation only" title="Manual invocation only">
      <MousePointerClick className="h-3.5 w-3.5" />
    </span>
  );
}
