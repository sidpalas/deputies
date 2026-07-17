import type { Ref } from 'react';
import { BookOpenCheck, X } from 'lucide-react';
import type { Skill } from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Badge } from '../ui/badge.js';
import { MAX_INVOKED_SKILLS } from './skill-invocation-draft.js';

export function SkillPicker(props: {
  availableCount: number;
  selected: Skill[];
  options: Skill[];
  open: boolean;
  disabled?: boolean;
  loading?: boolean | undefined;
  error?: string | undefined;
  activeIndex?: number;
  activeOptionRef?: Ref<HTMLButtonElement>;
  onActiveIndexChange?: (index: number) => void;
  onRemoveSkill: (skillId: string) => void;
  onSelectSkill: (skill: Skill) => void;
}) {
  const activeIndex = Math.min(props.activeIndex ?? 0, Math.max(0, props.options.length - 1));

  return (
    <div className="min-w-0 px-3 pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {props.selected.map((skill) => (
          <Badge
            key={skill.id}
            className="max-w-[min(16rem,100%)] gap-1 border border-primary/30 bg-primary/10 text-foreground"
            title={`${skill.name}: ${skill.description}`}
          >
            <BookOpenCheck className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{skill.name}</span>
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground">{skillProvenance(skill)}</span>
            <button
              type="button"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => props.onRemoveSkill(skill.id)}
              aria-label={`Remove ${skill.name} skill`}
              disabled={props.disabled}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      {props.open ? (
        <div className="z-50 mt-1 w-full rounded-md border border-border bg-card p-2 text-card-foreground shadow-xl">
          <p className="flex h-8 items-center px-2 text-xs text-muted-foreground">Type a skill name after /</p>
          <div className="mt-1 h-[clamp(8rem,35dvh,16rem)] overflow-auto" role="listbox" aria-label="Available skills">
            {props.options.map((skill, index) => (
              <button
                ref={index === activeIndex ? props.activeOptionRef : undefined}
                key={`${skill.source ?? 'skill'}:${skill.id}:${skill.name}`}
                type="button"
                className={cn(
                  'block w-full rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground',
                  index === activeIndex && 'bg-accent text-accent-foreground',
                )}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => props.onActiveIndexChange?.(index)}
                onClick={() => props.onSelectSkill(skill)}
              >
                <span className="flex items-center justify-between gap-2">
                  <strong className="truncate text-sm font-medium">/{skill.name}</strong>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {skillProvenance(skill)}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{skill.description}</span>
              </button>
            ))}
            {props.loading ? <p className="px-2 py-3 text-xs text-muted-foreground">Loading skills...</p> : null}
            {!props.loading && !props.options.length ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {props.error || (props.availableCount ? 'No matching skills.' : 'No skills available.')}
              </p>
            ) : null}
          </div>
          <p className="border-t border-border px-2 pt-2 text-[11px] text-muted-foreground">
            Up to {MAX_INVOKED_SKILLS} skills per message.
          </p>
        </div>
      ) : null}
      {props.error ? <p className="mt-1 text-xs text-destructive">{props.error}</p> : null}
    </div>
  );
}

function skillProvenance(skill: Skill): string {
  const provenance = skill.provenance;
  if (!provenance) return 'skill';
  if (provenance.kind === 'repo') return provenance.repo;
  if (provenance.kind !== 'personal' && provenance.ownerGroupName) {
    return `${provenance.kind} · ${provenance.ownerGroupName}`;
  }
  return provenance.kind;
}
