import { randomUUID } from 'node:crypto';
import type {
  AppStore,
  AutomationRecord,
  EnvironmentRepositoryRecord,
  EnvironmentShareMode,
  EnvironmentWithDetailsRecord,
  RepositoryProvider,
} from '../store/types.js';
import { parseStructuredGitHubRepository } from '../repositories/extract.js';

export type EnvironmentRepositoryInput = {
  provider?: RepositoryProvider;
  owner: string;
  repo: string;
  branch?: string;
  primary?: boolean;
};

export type EnvironmentBranchOverride = {
  provider?: RepositoryProvider;
  owner: string;
  repo: string;
  branch?: string;
};

export type EnvironmentSnapshotRepository = {
  provider: RepositoryProvider;
  owner: string;
  repo: string;
  primary: boolean;
  branch?: string;
};

export type EnvironmentSnapshot = {
  id: string;
  name: string;
  ownerGroupId: string;
  codebase: {
    repositories: EnvironmentSnapshotRepository[];
  };
};

export type EnvironmentCreateInput = {
  name: string;
  ownerGroupId: string;
  shareMode?: EnvironmentShareMode;
  repositories: EnvironmentRepositoryInput[];
  sharedGroupIds?: string[];
};

export type EnvironmentUpdateInput = {
  id: string;
  name?: string;
  ownerGroupId?: string;
  shareMode?: EnvironmentShareMode;
  repositories?: EnvironmentRepositoryInput[];
  sharedGroupIds?: string[];
};

export class EnvironmentServiceError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'archived'
      | 'invalid_request'
      | 'group_not_found'
      | 'archived_group'
      | 'automation_conflict',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class EnvironmentService {
  constructor(private readonly store: AppStore) {}

  async create(input: EnvironmentCreateInput): Promise<EnvironmentWithDetailsRecord> {
    const now = new Date();
    const ownerGroup = await this.store.getGroup(input.ownerGroupId);
    if (!ownerGroup) throw new EnvironmentServiceError('group_not_found', 'Group not found');
    if (ownerGroup.archivedAt)
      throw new EnvironmentServiceError('archived_group', 'Cannot create environments in an archived group');
    const id = randomUUID();
    const shareMode = input.shareMode ?? 'private';
    const sharedGroupIds = await this.normalizeSharedGroupIds(
      shareMode,
      input.sharedGroupIds ?? [],
      input.ownerGroupId,
    );
    return this.store.createEnvironment({
      environment: {
        id,
        name: requiredName(input.name),
        ownerGroupId: input.ownerGroupId,
        shareMode,
        createdAt: now,
        updatedAt: now,
      },
      repositories: normalizeRepositories(input.repositories, id, now),
      sharedGroupIds,
    });
  }

  async get(id: string): Promise<EnvironmentWithDetailsRecord | null> {
    return this.store.getEnvironment(id);
  }

  async list(): Promise<EnvironmentWithDetailsRecord[]> {
    return this.store.listEnvironments();
  }

  async update(input: EnvironmentUpdateInput): Promise<EnvironmentWithDetailsRecord> {
    const existing = await this.store.getEnvironment(input.id);
    if (!existing) throw new EnvironmentServiceError('not_found', 'Environment not found');
    if (existing.archivedAt) throw new EnvironmentServiceError('archived', 'Archived environments are read-only');

    const now = new Date();
    const ownerGroupId = input.ownerGroupId ?? existing.ownerGroupId;
    const ownerGroup = await this.store.getGroup(ownerGroupId);
    if (!ownerGroup) throw new EnvironmentServiceError('group_not_found', 'Group not found');
    if (ownerGroup.archivedAt)
      throw new EnvironmentServiceError('archived_group', 'Cannot move environments to an archived group');

    const shareMode = input.shareMode ?? existing.shareMode;
    const sharedGroupIds = await this.normalizeSharedGroupIds(
      shareMode,
      input.sharedGroupIds ?? existing.sharedGroupIds,
      ownerGroupId,
    );
    const repositories = normalizeRepositories(input.repositories ?? existing.repositories, existing.id, now);
    const next: EnvironmentWithDetailsRecord = {
      ...existing,
      name: input.name === undefined ? existing.name : requiredName(input.name),
      ownerGroupId,
      shareMode,
      updatedAt: now,
      repositories,
      sharedGroupIds,
    };

    await this.assertNoAutomationAccessLoss(existing, next);
    await this.assertNoAutomationOverrideRepositoryLoss(existing, next);
    return this.store.updateEnvironment({
      environment: {
        id: next.id,
        name: next.name,
        ownerGroupId: next.ownerGroupId,
        shareMode: next.shareMode,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
        ...(next.archivedAt ? { archivedAt: next.archivedAt } : {}),
      },
      repositories: next.repositories,
      sharedGroupIds: next.sharedGroupIds,
    });
  }

  async archive(id: string): Promise<EnvironmentWithDetailsRecord> {
    const existing = await this.store.getEnvironment(id);
    if (!existing) throw new EnvironmentServiceError('not_found', 'Environment not found');
    const affected = await this.activeAutomationsReferencingEnvironment(id);
    if (affected.length) {
      throw new EnvironmentServiceError('automation_conflict', 'Environment is used by active automations', {
        automations: affected,
      });
    }
    const archived = await this.store.archiveEnvironment({ environmentId: id, archivedAt: new Date() });
    if (!archived) throw new EnvironmentServiceError('not_found', 'Environment not found');
    return archived;
  }

  async unarchive(id: string): Promise<EnvironmentWithDetailsRecord> {
    const existing = await this.store.getEnvironment(id);
    if (!existing) throw new EnvironmentServiceError('not_found', 'Environment not found');
    const ownerGroup = await this.store.getGroup(existing.ownerGroupId);
    if (!ownerGroup) throw new EnvironmentServiceError('group_not_found', 'Group not found');
    if (ownerGroup.archivedAt)
      throw new EnvironmentServiceError('archived_group', 'Cannot restore environments in an archived group');
    if (!existing.archivedAt) return existing;
    const unarchived = await this.store.unarchiveEnvironment({ environmentId: id, updatedAt: new Date() });
    if (!unarchived) throw new EnvironmentServiceError('not_found', 'Environment not found');
    return unarchived;
  }

  async resolveForGroup(input: {
    environmentId: string;
    groupId: string;
    branchOverrides?: EnvironmentBranchOverride[];
  }): Promise<EnvironmentSnapshot> {
    const environment = await this.store.getEnvironment(input.environmentId);
    if (!environment) throw new EnvironmentServiceError('not_found', 'Environment not found');
    if (environment.archivedAt) throw new EnvironmentServiceError('archived', 'Environment is archived');
    const group = await this.store.getGroup(input.groupId);
    if (!group) throw new EnvironmentServiceError('group_not_found', 'Group not found');
    if (group.archivedAt) throw new EnvironmentServiceError('archived_group', 'Group is archived');
    if (!environmentAvailableToGroup(environment, input.groupId)) {
      throw new EnvironmentServiceError('not_found', 'Environment not found');
    }

    const overrides = new Map(
      (input.branchOverrides ?? []).map((override) => [
        repositoryKey({
          provider: override.provider ?? 'github',
          owner: override.owner,
          repo: override.repo,
        }),
        normalizeBranch(override.branch),
      ]),
    );
    for (const key of overrides.keys()) {
      if (!environment.repositories.some((repository) => repositoryKey(repository) === key)) {
        throw new EnvironmentServiceError(
          'invalid_request',
          'Branch override references a repository outside the environment',
        );
      }
    }

    return {
      id: environment.id,
      name: environment.name,
      ownerGroupId: environment.ownerGroupId,
      codebase: {
        repositories: environment.repositories.map((repository) => ({
          provider: repository.provider,
          owner: repository.owner,
          repo: repository.repo,
          primary: repository.isPrimary,
          ...(overrides.has(repositoryKey(repository))
            ? optionalBranch(overrides.get(repositoryKey(repository)))
            : optionalBranch(repository.branch)),
        })),
      },
    };
  }

  private async normalizeSharedGroupIds(
    shareMode: EnvironmentShareMode,
    groupIds: string[],
    ownerGroupId: string,
  ): Promise<string[]> {
    if (shareMode !== 'selected_groups') return [];
    const unique = [...new Set(groupIds)].filter((groupId) => groupId !== ownerGroupId).sort();
    for (const groupId of unique) {
      const group = await this.store.getGroup(groupId);
      if (!group) throw new EnvironmentServiceError('group_not_found', 'Shared group not found');
      if (group.archivedAt)
        throw new EnvironmentServiceError('archived_group', 'Cannot share environments with archived groups');
    }
    return unique;
  }

  private async assertNoAutomationAccessLoss(
    current: EnvironmentWithDetailsRecord,
    next: EnvironmentWithDetailsRecord,
  ): Promise<void> {
    const affected = (await this.activeAutomationRecordsReferencingEnvironment(current.id)).filter(
      (automation) =>
        environmentAvailableToGroup(current, automation.ownerGroupId) &&
        !environmentAvailableToGroup(next, automation.ownerGroupId),
    );
    if (affected.length) {
      throw new EnvironmentServiceError('automation_conflict', 'Environment access is used by active automations', {
        automations: automationConflictDetails(affected),
      });
    }
  }

  private async assertNoAutomationOverrideRepositoryLoss(
    current: EnvironmentWithDetailsRecord,
    next: EnvironmentWithDetailsRecord,
  ): Promise<void> {
    const nextRepositories = new Set(next.repositories.map(repositoryKey));
    const affected = (await this.activeAutomationRecordsReferencingEnvironment(current.id)).filter((automation) =>
      storedEnvironmentBranchOverrides(automation.context?.environmentBranchOverrides).some(
        (override) =>
          !nextRepositories.has(
            repositoryKey({
              provider: override.provider ?? 'github',
              owner: override.owner,
              repo: override.repo,
            }),
          ),
      ),
    );
    if (affected.length) {
      throw new EnvironmentServiceError(
        'automation_conflict',
        'Environment repository overrides are used by active automations',
        { automations: automationConflictDetails(affected) },
      );
    }
  }

  private async activeAutomationRecordsReferencingEnvironment(environmentId: string): Promise<AutomationRecord[]> {
    return (await this.store.listAutomations()).filter(
      (automation) => automation.environmentId === environmentId && !automation.archivedAt,
    );
  }

  private async activeAutomationsReferencingEnvironment(
    environmentId: string,
  ): Promise<Array<{ id: string; name: string; ownerGroupId: string }>> {
    return automationConflictDetails(await this.activeAutomationRecordsReferencingEnvironment(environmentId));
  }
}

export function environmentAvailableToGroup(environment: EnvironmentWithDetailsRecord, groupId: string): boolean {
  return (
    environment.ownerGroupId === groupId ||
    environment.shareMode === 'all_groups' ||
    (environment.shareMode === 'selected_groups' && environment.sharedGroupIds.includes(groupId))
  );
}

function normalizeRepositories(
  repositories: EnvironmentRepositoryInput[] | EnvironmentRepositoryRecord[],
  environmentId: string,
  now: Date,
): EnvironmentRepositoryRecord[] {
  if (!Array.isArray(repositories) || repositories.length < 1) {
    throw new EnvironmentServiceError('invalid_request', 'Environment codebase must include at least one repository');
  }
  const normalized = repositories.map((repository, index) => {
    const provider = repository.provider ?? 'github';
    if (provider !== 'github')
      throw new EnvironmentServiceError('invalid_request', 'Only GitHub repositories are supported');
    const owner = requiredRepositoryPart(repository.owner, 'repository.owner');
    const repo = requiredRepositoryPart(repository.repo, 'repository.repo');
    if (!parseStructuredGitHubRepository(owner, repo)) {
      throw new EnvironmentServiceError('invalid_request', 'Expected valid GitHub repository owner and name');
    }
    return {
      id: 'id' in repository ? repository.id : randomUUID(),
      environmentId,
      provider,
      owner,
      repo,
      isPrimary: Boolean('isPrimary' in repository ? repository.isPrimary : repository.primary),
      position: index,
      createdAt: 'createdAt' in repository ? repository.createdAt : now,
      updatedAt: now,
      ...optionalBranch(normalizeBranch(repository.branch)),
    };
  });
  if (new Set(normalized.map(repositoryKey)).size !== normalized.length) {
    throw new EnvironmentServiceError('invalid_request', 'Environment codebase cannot contain duplicate repositories');
  }
  const primaryCount = normalized.filter((repository) => repository.isPrimary).length;
  if (primaryCount !== 1) {
    throw new EnvironmentServiceError(
      'invalid_request',
      'Environment codebase must have exactly one primary repository',
    );
  }
  return normalized;
}

function requiredName(value: string): string {
  const name = value.trim();
  if (!name) throw new EnvironmentServiceError('invalid_request', 'Expected non-empty environment name');
  return name;
}

function requiredRepositoryPart(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\0')) {
    throw new EnvironmentServiceError('invalid_request', `Expected valid ${field}`);
  }
  return trimmed;
}

function normalizeBranch(value: string | undefined): string | undefined {
  const branch = value?.trim();
  if (!branch) return undefined;
  if (branch.includes('\0') || branch.startsWith('-') || branch.includes('..')) {
    throw new EnvironmentServiceError('invalid_request', 'Expected valid branch name');
  }
  return branch;
}

function optionalBranch(branch: string | undefined): { branch?: string } {
  return branch ? { branch } : {};
}

function repositoryKey(repository: { provider: RepositoryProvider; owner: string; repo: string }): string {
  return `${repository.provider}:${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`;
}

function storedEnvironmentBranchOverrides(value: unknown): EnvironmentBranchOverride[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<EnvironmentBranchOverride[]>((overrides, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return overrides;
    const record = item as Record<string, unknown>;
    const owner = typeof record.owner === 'string' ? record.owner : '';
    const repo = typeof record.repo === 'string' ? record.repo : '';
    const branch = typeof record.branch === 'string' ? record.branch : '';
    if (!owner || !repo) return overrides;
    overrides.push({
      provider: 'github',
      owner,
      repo,
      ...(branch ? { branch } : {}),
    });
    return overrides;
  }, []);
}

function automationConflictDetails(
  automations: AutomationRecord[],
): Array<{ id: string; name: string; ownerGroupId: string }> {
  return automations.map((automation) => ({
    id: automation.id,
    name: automation.name,
    ownerGroupId: automation.ownerGroupId,
  }));
}
