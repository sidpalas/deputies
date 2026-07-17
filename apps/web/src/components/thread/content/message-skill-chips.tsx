import { BookOpenCheck } from 'lucide-react';
import type { Message } from '../../../api.js';
import { Badge } from '../../ui/badge.js';

export type PersistedMessageSkillInvocation = {
  name: string;
  managedSkillId?: string;
  revisionId?: string;
  repository?: string;
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
    const id = typeof record.id === 'string' && record.name === value ? record.id : undefined;
    const managedSkillId = id && !id.startsWith('repo:') ? id : undefined;
    const revisionId = managedSkillId && typeof record.revisionId === 'string' ? record.revisionId : undefined;
    const repository = id ? repositoryFromSkillRef(id, value) : undefined;
    return [
      {
        name: value,
        ...(managedSkillId ? { managedSkillId } : {}),
        ...(revisionId ? { revisionId } : {}),
        ...(repository ? { repository } : {}),
      },
    ];
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
      {invocations.map(({ name, managedSkillId, revisionId, repository }, index) => {
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
            className="inline-flex h-6 max-w-[min(16rem,100%)] items-center gap-1 whitespace-nowrap rounded-md border border-primary/30 bg-primary/10 px-2 text-xs font-medium text-foreground hover:bg-primary/20"
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
            className="h-6 max-w-[min(16rem,100%)] gap-1 whitespace-nowrap border border-primary/30 bg-primary/10 text-foreground"
            title={
              repository
                ? `Repository skill from ${repository}. It is not clickable because repository skills do not have a managed skill page.`
                : name
            }
          >
            {content}
          </Badge>
        );
      })}
    </div>
  );
}

function repositoryFromSkillRef(id: string, name: string): string | undefined {
  const suffix = `:${name}`;
  if (!id.startsWith('repo:') || !id.endsWith(suffix)) return undefined;
  return id.slice('repo:'.length, -suffix.length) || undefined;
}
