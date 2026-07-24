import { StoreConflictError } from './types.js';
import type {
  CreateSkillRecord,
  SkillRecord,
  SkillRevisionRecord,
  SkillRevisionSelection,
  SkillRunCandidate,
  SkillStore,
  UpdateSkillRecord,
} from './types.js';

export class MemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, SkillRecord>();
  private readonly skillRevisions = new Map<string, SkillRevisionRecord>();

  async createSkill(record: CreateSkillRecord): Promise<SkillRecord> {
    if (this.skills.has(record.id)) throw new Error(`Skill already exists: ${record.id}`);
    this.assertSkillNameAvailable(record.revision.name, record.scope, record.ownerUserId);
    const revision: SkillRevisionRecord = { ...record.revision, skillId: record.id, revisionNumber: 1 };
    const ownership =
      record.scope === 'personal'
        ? { scope: 'personal' as const, ownerUserId: record.ownerUserId }
        : { scope: 'tenant' as const };
    const skill: SkillRecord = {
      id: record.id,
      ...ownership,
      name: revision.name,
      description: revision.description,
      body: revision.body,
      currentRevisionId: revision.id,
      currentRevisionNumber: 1,
      autoLoad: record.scope === 'personal' ? false : (record.autoLoad ?? true),
      enabled: record.enabled ?? true,
      ...(record.createdByUserId ? { createdByUserId: record.createdByUserId } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    this.skillRevisions.set(revision.id, { ...revision });
    this.skills.set(skill.id, skill);
    return { ...skill };
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    const skill = this.skills.get(id);
    return skill ? { ...skill } : null;
  }
  async listSkills(input: { userId?: string }): Promise<SkillRecord[]> {
    return this.sortedSkills((skill) => this.visible(skill, input.userId));
  }
  async listSkillRevisions(skillId: string): Promise<SkillRevisionRecord[]> {
    return [...this.skillRevisions.values()]
      .filter((revision) => revision.skillId === skillId)
      .sort((a, b) => b.revisionNumber - a.revisionNumber)
      .map((revision) => ({ ...revision }));
  }

  async updateSkill(input: UpdateSkillRecord): Promise<SkillRecord> {
    const existing = this.skills.get(input.id);
    if (!existing) throw new Error(`Skill does not exist: ${input.id}`);
    if (existing.archivedAt) throw new StoreConflictError('skill_archived', 'Restore this skill before editing it');
    if (input.revision && existing.currentRevisionId !== input.expectedCurrentRevisionId)
      throw new StoreConflictError('skill_update_conflict', 'The skill changed while it was being edited');
    if (input.revision)
      this.assertSkillNameAvailable(input.revision.name, existing.scope, existing.ownerUserId, input.id);
    const revision = input.revision
      ? { ...input.revision, skillId: input.id, revisionNumber: existing.currentRevisionNumber + 1 }
      : undefined;
    const updated: SkillRecord = {
      ...existing,
      updatedAt: input.updatedAt,
      ...(revision
        ? {
            name: revision.name,
            description: revision.description,
            body: revision.body,
            currentRevisionId: revision.id,
            currentRevisionNumber: revision.revisionNumber,
          }
        : {}),
      ...(input.autoLoad !== undefined ? { autoLoad: existing.scope === 'personal' ? false : input.autoLoad } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    if (revision) this.skillRevisions.set(revision.id, revision);
    this.skills.set(input.id, updated);
    return { ...updated };
  }

  async archiveSkill(input: { skillId: string; archivedAt: Date }): Promise<SkillRecord | null> {
    const skill = this.skills.get(input.skillId);
    if (!skill) return null;
    const archived = { ...skill, archivedAt: skill.archivedAt ?? input.archivedAt, updatedAt: input.archivedAt };
    this.skills.set(skill.id, archived);
    return { ...archived };
  }
  async restoreSkill(input: { skillId: string; updatedAt: Date }): Promise<SkillRecord | null> {
    const skill = this.skills.get(input.skillId);
    if (!skill) return null;
    this.assertSkillNameAvailable(skill.name, skill.scope, skill.ownerUserId, skill.id);
    const { archivedAt: _, ...active } = skill;
    const restored = { ...active, updatedAt: input.updatedAt };
    this.skills.set(skill.id, restored);
    return { ...restored };
  }

  async listSkillInvocationCandidates(input: { userId?: string }): Promise<SkillRunCandidate[]> {
    return this.currentCandidates((skill) => this.visible(skill, input.userId));
  }
  async listSkillsForRun(input: {
    userId?: string;
    invokedNames?: string[];
    invokedRevisions?: SkillRevisionSelection[];
  }): Promise<SkillRunCandidate[]> {
    const names = new Set(input.invokedNames ?? []);
    const current = this.currentCandidates(
      (skill) =>
        this.visible(skill, input.userId) && ((skill.scope === 'tenant' && skill.autoLoad) || names.has(skill.name)),
    );
    const pinned = (input.invokedRevisions ?? []).flatMap((selection): SkillRunCandidate[] => {
      const skill = this.skills.get(selection.skillId),
        revision = this.skillRevisions.get(selection.revisionId);
      if (
        !skill ||
        !revision ||
        revision.skillId !== skill.id ||
        skill.archivedAt ||
        !skill.enabled ||
        !this.visible(skill, input.userId)
      )
        return [];
      return [
        {
          ...skill,
          name: revision.name,
          description: revision.description,
          body: revision.body,
          source: 'managed',
          resolvedRevisionId: revision.id,
          resolvedRevisionNumber: revision.revisionNumber,
        },
      ];
    });
    const seen = new Set<string>();
    return [...current, ...pinned].filter((skill) => {
      const key = `${skill.id}:${skill.resolvedRevisionId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private currentCandidates(include: (skill: SkillRecord) => boolean): SkillRunCandidate[] {
    return [...this.skills.values()]
      .filter((skill) => skill.enabled && !skill.archivedAt && include(skill))
      .sort(compareSkills)
      .map((skill) => ({
        ...skill,
        source: 'managed',
        resolvedRevisionId: skill.currentRevisionId,
        resolvedRevisionNumber: skill.currentRevisionNumber,
      }));
  }
  private assertSkillNameAvailable(
    name: string,
    scope: SkillRecord['scope'],
    ownerUserId?: string,
    except?: string,
  ): void {
    if (
      [...this.skills.values()].some(
        (skill) =>
          skill.id !== except &&
          skill.scope === scope &&
          (scope === 'tenant' || (!skill.archivedAt && skill.ownerUserId === ownerUserId)) &&
          skill.name.trim().toLowerCase() === name.trim().toLowerCase(),
      )
    )
      throw new StoreConflictError('skill_name_exists', 'Skill name already exists');
  }
  private visible(skill: SkillRecord, userId?: string): boolean {
    return skill.scope === 'tenant' || (userId !== undefined && skill.ownerUserId === userId);
  }
  private sortedSkills(predicate: (skill: SkillRecord) => boolean): SkillRecord[] {
    return [...this.skills.values()]
      .filter(predicate)
      .sort(compareSkills)
      .map((skill) => ({ ...skill }));
  }
}
function compareSkills(a: SkillRecord, b: SkillRecord): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}
