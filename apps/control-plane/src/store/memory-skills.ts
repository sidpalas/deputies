import { StoreConflictError } from './types.js';
import type {
  CreateSkillRecord,
  SkillOwnerKind,
  SkillRecord,
  SkillRevisionRecord,
  SkillRevisionSelection,
  SkillRunCandidate,
  SkillShareMode,
  SkillStore,
  UpdateSkillRecord,
} from './types.js';

type MemorySkillStoreDependencies = {
  userExists(userId: string): boolean;
  getGroupState(groupId: string): { archived: boolean } | null;
};

export class MemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, SkillRecord>();
  private readonly skillRevisions = new Map<string, SkillRevisionRecord>();
  private readonly skillSharesByGroup = new Map<string, Set<string>>();

  constructor(private readonly dependencies: MemorySkillStoreDependencies) {}

  async createSkill(record: CreateSkillRecord): Promise<SkillRecord> {
    if (this.skills.has(record.id)) throw new Error(`Skill already exists: ${record.id}`);
    this.assertSkillOwner(record);
    if (record.ownerKind === 'group') this.assertActiveGroup(record.ownerGroupId);
    const ownerId = record.ownerKind === 'group' ? record.ownerGroupId : record.ownerUserId;
    this.assertSkillNameAvailable(record.revision.name, record.ownerKind, ownerId);
    const revision: SkillRevisionRecord = { ...record.revision, skillId: record.id, revisionNumber: 1 };
    const skill: SkillRecord = {
      id: record.id,
      name: record.revision.name,
      description: record.revision.description,
      body: record.revision.body,
      currentRevisionId: revision.id,
      currentRevisionNumber: revision.revisionNumber,
      autoLoad: record.autoLoad ?? true,
      enabled: record.enabled ?? true,
      shareGroupIds: [],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.ownerKind === 'group'
        ? { ownerKind: record.ownerKind, ownerGroupId: record.ownerGroupId, shareMode: record.shareMode ?? 'none' }
        : { ownerKind: record.ownerKind, ownerUserId: record.ownerUserId, shareMode: record.shareMode ?? 'none' }),
      ...(record.createdByUserId ? { createdByUserId: record.createdByUserId } : {}),
    };
    this.skillRevisions.set(revision.id, cloneSkillRevision(revision));
    this.skills.set(skill.id, skill);
    return cloneSkill(skill);
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    const skill = this.skills.get(id);
    return skill ? cloneSkill(skill) : null;
  }

  async listSkillRevisions(skillId: string): Promise<SkillRevisionRecord[]> {
    return [...this.skillRevisions.values()]
      .filter((revision) => revision.skillId === skillId)
      .sort((left, right) => right.revisionNumber - left.revisionNumber)
      .map(cloneSkillRevision);
  }

  async updateSkill(input: UpdateSkillRecord): Promise<SkillRecord> {
    const existing = this.skills.get(input.id);
    if (!existing) throw new Error(`Skill does not exist: ${input.id}`);
    this.assertActiveSkill(existing);
    if (input.revision && existing.currentRevisionId !== input.expectedCurrentRevisionId) {
      throw new StoreConflictError('skill_update_conflict', 'The skill changed while it was being edited');
    }
    if (input.revision) {
      this.assertSkillNameAvailable(
        input.revision.name,
        existing.ownerKind,
        existing.ownerKind === 'group' ? existing.ownerGroupId : existing.ownerUserId,
        existing.id,
      );
    }
    const revision: SkillRevisionRecord | undefined = input.revision
      ? {
          ...input.revision,
          skillId: existing.id,
          revisionNumber: existing.currentRevisionNumber + 1,
        }
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
      ...(input.autoLoad !== undefined ? { autoLoad: input.autoLoad } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    if (revision) this.skillRevisions.set(revision.id, cloneSkillRevision(revision));
    this.skills.set(input.id, updated);
    return cloneSkill(updated);
  }

  async archiveSkill(input: { skillId: string; archivedAt: Date }): Promise<SkillRecord | null> {
    const existing = this.skills.get(input.skillId);
    if (!existing) return null;
    const archived = {
      ...existing,
      archivedAt: existing.archivedAt ?? input.archivedAt,
      updatedAt: input.archivedAt,
    };
    this.skills.set(input.skillId, archived);
    return cloneSkill(archived);
  }

  async restoreSkill(input: { skillId: string; updatedAt: Date }): Promise<SkillRecord | null> {
    const existing = this.skills.get(input.skillId);
    if (!existing) return null;
    if (existing.ownerGroupId) this.assertActiveGroup(existing.ownerGroupId);
    const { archivedAt: _archivedAt, ...active } = existing;
    const restored = { ...active, updatedAt: input.updatedAt };
    this.skills.set(input.skillId, restored);
    return cloneSkill(restored);
  }

  async promoteSkill(id: string, groupId: string, now: Date): Promise<SkillRecord | null> {
    const existing = this.skills.get(id);
    if (!existing || existing.ownerKind !== 'user') return null;
    this.assertActiveSkill(existing);
    this.assertActiveGroup(groupId);
    this.assertSkillNameAvailable(existing.name, 'group', groupId, id);
    const { ownerUserId: _ownerUserId, ...withoutUserOwner } = existing;
    const promoted: SkillRecord = {
      ...withoutUserOwner,
      ownerKind: 'group',
      ownerGroupId: groupId,
      shareMode: 'none',
      updatedAt: now,
    };
    this.skills.set(id, promoted);
    return cloneSkill(promoted);
  }

  async setSkillShares(
    id: string,
    shareMode: SkillShareMode,
    groupIds: string[],
    now: Date,
  ): Promise<SkillRecord | null> {
    const existing = this.skills.get(id);
    if (!existing || existing.ownerKind !== 'group') return null;
    this.assertActiveSkill(existing);
    this.assertActiveGroup(existing.ownerGroupId);
    if (shareMode === 'specific') this.replaceSkillShares(existing, groupIds);
    const current = this.skills.get(id);
    if (!current || current.ownerKind !== 'group') return null;
    const updated: SkillRecord = { ...current, shareMode, updatedAt: now };
    this.skills.set(id, updated);
    return cloneSkill(updated);
  }

  async listSkillsForUser(userId: string): Promise<SkillRecord[]> {
    return this.sortedSkills((skill) => skill.ownerKind === 'user' && skill.ownerUserId === userId);
  }

  async listSkillsForGroups(groupIds: string[]): Promise<SkillRecord[]> {
    const groups = new Set(groupIds);
    return this.sortedSkills((skill) => skill.ownerKind === 'group' && groups.has(skill.ownerGroupId));
  }

  async listSkillsSharedIntoGroups(groupIds: string[]): Promise<SkillRecord[]> {
    if (!groupIds.length) return [];
    const groups = new Set(groupIds);
    const specificallyShared = new Set(
      groupIds.flatMap((groupId) => [...(this.skillSharesByGroup.get(groupId) ?? [])]),
    );
    return this.sortedSkills(
      (skill) =>
        skill.ownerKind === 'group' &&
        !groups.has(skill.ownerGroupId) &&
        (skill.shareMode === 'all_groups' || (skill.shareMode === 'specific' && specificallyShared.has(skill.id))),
    );
  }

  async listSkillsForRun(input: {
    ownerGroupId: string;
    createdByUserId?: string;
    invokedNames?: string[];
    invokedRevisions?: SkillRevisionSelection[];
  }): Promise<SkillRunCandidate[]> {
    const invoked = new Set(input.invokedNames ?? []);
    const eligible = this.currentCandidates(input, (skill) => skill.autoLoad || invoked.has(skill.name));
    const pinned = (input.invokedRevisions ?? []).flatMap((selection): SkillRunCandidate[] => {
      const skill = this.skills.get(selection.skillId);
      const revision = this.skillRevisions.get(selection.revisionId);
      if (!skill || !revision || revision.skillId !== skill.id || !this.skillAvailableForRun(skill, input)) return [];
      return [
        {
          ...cloneSkill(skill),
          name: revision.name,
          description: revision.description,
          body: revision.body,
          source: skillSourceForRun(skill, input.ownerGroupId),
          resolvedRevisionId: revision.id,
          resolvedRevisionNumber: revision.revisionNumber,
        },
      ];
    });
    const seen = new Set<string>();
    return [...eligible, ...pinned].filter((skill) => {
      const key = `${skill.id}:${skill.resolvedRevisionId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async listSkillInvocationCandidates(input: { ownerGroupId: string; userId?: string }): Promise<SkillRunCandidate[]> {
    return this.currentCandidates(
      { ownerGroupId: input.ownerGroupId, ...(input.userId ? { createdByUserId: input.userId } : {}) },
      () => true,
    );
  }

  private currentCandidates(
    input: { ownerGroupId: string; createdByUserId?: string },
    include: (skill: SkillRecord) => boolean,
  ): SkillRunCandidate[] {
    const specificallyShared = this.skillSharesByGroup.get(input.ownerGroupId) ?? new Set<string>();
    return [...this.skills.values()]
      .filter((skill) => include(skill) && this.skillAvailableForRun(skill, input, specificallyShared))
      .map((skill) => runCandidate(skill, skillSourceForRun(skill, input.ownerGroupId)))
      .sort(compareSkillsOldestFirst);
  }

  private skillAvailableForRun(
    skill: SkillRecord,
    input: { ownerGroupId: string; createdByUserId?: string },
    specificallyShared = this.skillSharesByGroup.get(input.ownerGroupId) ?? new Set<string>(),
  ): boolean {
    if (
      !skill.enabled ||
      skill.archivedAt ||
      (skill.ownerGroupId && this.dependencies.getGroupState(skill.ownerGroupId)?.archived)
    ) {
      return false;
    }
    if (skill.ownerKind === 'user') {
      return Boolean(input.createdByUserId && skill.ownerUserId === input.createdByUserId);
    }
    if (skill.ownerGroupId === input.ownerGroupId) return true;
    return skill.shareMode === 'all_groups' || (skill.shareMode === 'specific' && specificallyShared.has(skill.id));
  }

  private assertSkillOwner(record: CreateSkillRecord): void {
    if (record.ownerKind === 'group' && this.dependencies.getGroupState(record.ownerGroupId)) return;
    if (record.ownerKind === 'user' && this.dependencies.userExists(record.ownerUserId)) return;
    throw new Error('Invalid skill owner');
  }

  private assertSkillNameAvailable(
    name: string,
    ownerKind: SkillOwnerKind,
    ownerId: string,
    exceptSkillId?: string,
  ): void {
    const normalized = name.toLowerCase();
    const conflict = [...this.skills.values()].some(
      (skill) =>
        skill.id !== exceptSkillId &&
        skill.ownerKind === ownerKind &&
        (ownerKind === 'group' ? skill.ownerGroupId : skill.ownerUserId) === ownerId &&
        skill.name.toLowerCase() === normalized,
    );
    if (conflict) throw new StoreConflictError('skill_name_exists', 'Skill name already exists');
  }

  private replaceSkillShares(skill: SkillRecord, groupIds: string[]): void {
    const replacement = [...new Set(groupIds)].sort(compareStringAsc);
    const existing = new Set(skill.shareGroupIds);
    for (const groupId of replacement) {
      if (!existing.has(groupId)) this.assertActiveGroup(groupId);
    }
    for (const groupId of skill.shareGroupIds) this.skillSharesByGroup.get(groupId)?.delete(skill.id);
    for (const groupId of replacement) {
      const skillIds = this.skillSharesByGroup.get(groupId) ?? new Set<string>();
      skillIds.add(skill.id);
      this.skillSharesByGroup.set(groupId, skillIds);
    }
    this.skills.set(skill.id, { ...skill, shareGroupIds: replacement });
  }

  private assertActiveSkill(skill: SkillRecord): void {
    if (skill.archivedAt) throw new StoreConflictError('skill_archived', 'Restore this skill before editing it');
    if (skill.ownerGroupId) this.assertActiveGroup(skill.ownerGroupId);
  }

  private assertActiveGroup(groupId: string): void {
    const group = this.dependencies.getGroupState(groupId);
    if (!group) throw new Error(`Group does not exist: ${groupId}`);
    if (group.archived) throw new StoreConflictError('archived_group', 'Cannot modify skills in an archived group');
  }

  private sortedSkills(predicate: (skill: SkillRecord) => boolean): SkillRecord[] {
    return [...this.skills.values()].filter(predicate).sort(compareSkillsOldestFirst).map(cloneSkill);
  }
}

function runCandidate(skill: SkillRecord, source: SkillRunCandidate['source']): SkillRunCandidate {
  return {
    ...cloneSkill(skill),
    source,
    resolvedRevisionId: skill.currentRevisionId,
    resolvedRevisionNumber: skill.currentRevisionNumber,
  };
}

function skillSourceForRun(skill: SkillRecord, ownerGroupId: string): SkillRunCandidate['source'] {
  if (skill.ownerKind === 'user') return 'personal';
  return skill.ownerGroupId === ownerGroupId ? 'group' : 'shared';
}

function cloneSkill(skill: SkillRecord): SkillRecord {
  return { ...skill, shareGroupIds: [...skill.shareGroupIds] };
}

function cloneSkillRevision(revision: SkillRevisionRecord): SkillRevisionRecord {
  return { ...revision };
}

function compareSkillsOldestFirst(left: SkillRecord, right: SkillRecord): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || compareStringAsc(left.id, right.id);
}

function compareStringAsc(left: string, right: string): number {
  return left.localeCompare(right);
}
