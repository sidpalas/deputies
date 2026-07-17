import type { SkillSource } from '../store/types.js';

const sourceRank: Record<SkillSource | 'repo', number> = { personal: 0, group: 1, shared: 2, repo: 3 };

export function skillSourcePrecedence(source: SkillSource | 'repo'): number {
  return sourceRank[source];
}

export function compareManagedSkillPrecedence(
  left: { source: SkillSource; createdAt: Date; id: string },
  right: { source: SkillSource; createdAt: Date; id: string },
): number {
  const sourceDifference = skillSourcePrecedence(left.source) - skillSourcePrecedence(right.source);
  if (sourceDifference) return sourceDifference;
  const createdDifference = left.createdAt.getTime() - right.createdAt.getTime();
  return createdDifference || left.id.localeCompare(right.id);
}

export function compareManagedSkillCatalogEntries(
  left: { name: string; source: SkillSource; createdAt: Date; id: string },
  right: { name: string; source: SkillSource; createdAt: Date; id: string },
): number {
  return left.name.localeCompare(right.name) || compareManagedSkillPrecedence(left, right);
}
