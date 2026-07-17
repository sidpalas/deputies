import { BookOpenCheck } from 'lucide-react';
import type { Message } from '../../../api.js';
import { Badge } from '../../ui/badge.js';

export type PersistedMessageSkillInvocation = {
  name: string;
  managedSkillId?: string;
  revisionId?: string;
};

export function parsePersistedMessageSkillInvocations(
  message: Pick<Message, 'context'>,
): PersistedMessageSkillInvocation[] {
  const skills = message.context?.skills;
  if (!Array.isArray(skills)) return [];
  const refs = Array.isArray(message.context?.skillRefs) ? message.context.skillRefs : [];

  return skills.flatMap((value, index) => {
    if (typeof value !== 'string') return [];
    const ref = refs[index];
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return [{ name: value }];
    const record = ref as Record<string, unknown>;
    const managedSkillId =
      typeof record.id === 'string' && record.name === value && !record.id.startsWith('repo:') ? record.id : undefined;
    const revisionId = managedSkillId && typeof record.revisionId === 'string' ? record.revisionId : undefined;
    return [{ name: value, ...(managedSkillId ? { managedSkillId } : {}), ...(revisionId ? { revisionId } : {}) }];
  });
}

export function MessageSkillChips(props: {
  message: Pick<Message, 'context'>;
  openableManagedSkillIds?: ReadonlySet<string>;
  onOpenSkill?: (skillId: string, revisionId: string) => void;
}) {
  const invocations = parsePersistedMessageSkillInvocations(props.message);
  if (!invocations.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Invoked skills">
      {invocations.map(({ name, managedSkillId, revisionId }, index) => {
        const content = (
          <>
            <BookOpenCheck className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{name}</span>
          </>
        );
        return managedSkillId &&
          revisionId &&
          props.openableManagedSkillIds?.has(managedSkillId) &&
          props.onOpenSkill ? (
          <button
            key={`${name}:${index}`}
            className="inline-flex max-w-[min(16rem,100%)] items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-foreground hover:bg-primary/20"
            type="button"
            title="Open invoked skill revision"
            aria-label={`Open invoked ${name} skill revision`}
            onClick={() => props.onOpenSkill?.(managedSkillId, revisionId)}
          >
            {content}
          </button>
        ) : (
          <Badge
            key={`${name}:${index}`}
            className="max-w-[min(16rem,100%)] gap-1 border border-primary/30 bg-primary/10 text-foreground"
            title={name}
          >
            {content}
          </Badge>
        );
      })}
    </div>
  );
}
