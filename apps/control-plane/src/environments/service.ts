import { randomUUID } from 'node:crypto';
import type {
  AppStore,
  AutomationRecord,
  EnvironmentRepositoryRecord,
  EnvironmentRevisionRecord,
  EnvironmentActivityRecord,
  AuditActorType,
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

export const MAX_ENVIRONMENT_REPOSITORIES = 10;

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
  revisionId: string;
  revisionNumber: number;
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
  actor?: EnvironmentMutationActor;
};

export type EnvironmentUpdateInput = {
  id: string;
  name?: string;
  ownerGroupId?: string;
  shareMode?: EnvironmentShareMode;
  repositories?: EnvironmentRepositoryInput[];
  sharedGroupIds?: string[];
  actor?: EnvironmentMutationActor;
};

export type EnvironmentMutationActor = {
  type: AuditActorType;
  userId?: string;
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
    const revisionId = randomUUID();
    const shareMode = input.shareMode ?? 'private';
    const sharedGroupIds = await this.normalizeSharedGroupIds(
      shareMode,
      input.sharedGroupIds ?? [],
      input.ownerGroupId,
    );
    const repositories = normalizeRepositories(input.repositories, revisionId, now);
    const revision = environmentRevision({
      id: revisionId,
      environmentId: id,
      revisionNumber: 1,
      repositories,
      actor: input.actor,
      createdAt: now,
    });
    return this.store.createEnvironment({
      environment: {
        id,
        name: requiredName(input.name),
        ownerGroupId: input.ownerGroupId,
        shareMode,
        currentRevisionId: revision.id,
        currentRevisionNumber: revision.revisionNumber,
        createdAt: now,
        updatedAt: now,
      },
      repositories,
      sharedGroupIds,
      revision,
      activities: [
        environmentActivity({
          environmentId: id,
          type: 'environment_created',
          actor: input.actor,
          revisionId: revision.id,
          payload: { ownerGroupId: input.ownerGroupId, shareMode, sharedGroupIds },
          createdAt: now,
        }),
      ],
    });
  }

  async get(id: string): Promise<EnvironmentWithDetailsRecord | null> {
    return this.store.getEnvironment(id);
  }

  async list(): Promise<EnvironmentWithDetailsRecord[]> {
    return this.store.listEnvironments();
  }

  async listRevisions(environmentId: string): Promise<EnvironmentRevisionRecord[]> {
    return this.store.listEnvironmentRevisions(environmentId);
  }

  async listActivity(environmentId: string): Promise<EnvironmentActivityRecord[]> {
    return this.store.listEnvironmentActivity(environmentId);
  }

  async update(input: EnvironmentUpdateInput): Promise<EnvironmentWithDetailsRecord> {
    const existing = await this.store.getEnvironment(input.id);
    if (!existing) throw new EnvironmentServiceError('not_found', 'Environment not found');
    if (existing.archivedAt) throw new EnvironmentServiceError('archived', 'Archived environments are read-only');

    const now = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
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
    const candidateRevisionId = randomUUID();
    const candidateRepositories = input.repositories
      ? normalizeRepositories(input.repositories, candidateRevisionId, now)
      : existing.repositories;
    const repositoriesChanged =
      input.repositories !== undefined && !sameRepositoryConfiguration(existing.repositories, candidateRepositories);
    const revision = repositoriesChanged
      ? environmentRevision({
          id: candidateRevisionId,
          environmentId: existing.id,
          revisionNumber: existing.currentRevisionNumber + 1,
          repositories: candidateRepositories,
          actor: input.actor,
          createdAt: now,
        })
      : undefined;
    const repositories = repositoriesChanged ? candidateRepositories : existing.repositories;
    const next: EnvironmentWithDetailsRecord = {
      ...existing,
      name: input.name === undefined ? existing.name : requiredName(input.name),
      ownerGroupId,
      shareMode,
      currentRevisionId: revision?.id ?? existing.currentRevisionId,
      currentRevisionNumber: revision?.revisionNumber ?? existing.currentRevisionNumber,
      updatedAt: now,
      repositories,
      sharedGroupIds,
    };

    await this.assertNoAutomationAccessLoss(existing, next);
    await this.assertNoAutomationOverrideRepositoryLoss(existing, next);
    const activities = environmentUpdateActivities(existing, next, input.actor, now, revision);
    if (!revision && !activities.length) return existing;
    return this.store.updateEnvironment({
      expectedUpdatedAt: existing.updatedAt,
      environment: {
        id: next.id,
        name: next.name,
        ownerGroupId: next.ownerGroupId,
        shareMode: next.shareMode,
        currentRevisionId: next.currentRevisionId,
        currentRevisionNumber: next.currentRevisionNumber,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
        ...(next.archivedAt ? { archivedAt: next.archivedAt } : {}),
      },
      repositories: next.repositories,
      sharedGroupIds: next.sharedGroupIds,
      automationAccessAllowedGroupIds:
        next.shareMode === 'all_groups' ? null : [next.ownerGroupId, ...next.sharedGroupIds],
      ...(revision ? { revision } : {}),
      activities,
    });
  }

  async archive(id: string, actor?: EnvironmentMutationActor): Promise<EnvironmentWithDetailsRecord> {
    const existing = await this.store.getEnvironment(id);
    if (!existing) throw new EnvironmentServiceError('not_found', 'Environment not found');
    if (existing.archivedAt) return existing;
    const affected = await this.activeAutomationsReferencingEnvironment(id);
    if (affected.length) {
      throw new EnvironmentServiceError('automation_conflict', 'Environment is used by active automations', {
        automations: affected,
      });
    }
    const archivedAt = new Date();
    const archived = await this.store.archiveEnvironment({
      environmentId: id,
      archivedAt,
      activity: environmentActivity({
        environmentId: id,
        type: 'environment_archived',
        actor,
        payload: {},
        createdAt: archivedAt,
      }),
    });
    if (!archived) throw new EnvironmentServiceError('not_found', 'Environment not found');
    return archived;
  }

  async unarchive(id: string, actor?: EnvironmentMutationActor): Promise<EnvironmentWithDetailsRecord> {
    const existing = await this.store.getEnvironment(id);
    if (!existing) throw new EnvironmentServiceError('not_found', 'Environment not found');
    const ownerGroup = await this.store.getGroup(existing.ownerGroupId);
    if (!ownerGroup) throw new EnvironmentServiceError('group_not_found', 'Group not found');
    if (ownerGroup.archivedAt)
      throw new EnvironmentServiceError('archived_group', 'Cannot restore environments in an archived group');
    if (!existing.archivedAt) return existing;
    const updatedAt = new Date();
    const unarchived = await this.store.unarchiveEnvironment({
      environmentId: id,
      updatedAt,
      activity: environmentActivity({
        environmentId: id,
        type: 'environment_unarchived',
        actor,
        payload: {},
        createdAt: updatedAt,
      }),
    });
    if (!unarchived) throw new EnvironmentServiceError('not_found', 'Environment not found');
    return unarchived;
  }

  async resolveForGroup(input: {
    environmentId: string;
    groupId: string;
    revisionId?: string;
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
    const revisionId = input.revisionId ?? environment.currentRevisionId;
    const revision = await this.store.getEnvironmentRevision(revisionId);
    if (!revision || revision.environmentId !== environment.id) {
      throw new EnvironmentServiceError('not_found', 'Environment revision not found');
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
      if (!revision.repositories.some((repository) => repositoryKey(repository) === key)) {
        throw new EnvironmentServiceError(
          'invalid_request',
          'Branch override references a repository outside the environment',
        );
      }
    }

    return {
      id: environment.id,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      name: environment.name,
      ownerGroupId: environment.ownerGroupId,
      codebase: {
        repositories: revision.repositories.map((repository) => ({
          provider: repository.provider,
          owner: repository.owner,
          repo: repository.repo,
          primary: repository.primary,
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
    const affected = (await this.activeAutomationRecordsReferencingEnvironment(current.id)).filter(
      (automation) =>
        automation.environmentRevisionPolicy !== 'pinned' &&
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
  repositories: EnvironmentRepositoryInput[],
  revisionId: string,
  now: Date,
): EnvironmentRepositoryRecord[] {
  if (!Array.isArray(repositories) || repositories.length < 1) {
    throw new EnvironmentServiceError('invalid_request', 'Environment codebase must include at least one repository');
  }
  if (repositories.length > MAX_ENVIRONMENT_REPOSITORIES) {
    throw new EnvironmentServiceError(
      'invalid_request',
      `Environment codebase cannot contain more than ${MAX_ENVIRONMENT_REPOSITORIES} repositories`,
    );
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
      id: randomUUID(),
      revisionId,
      provider,
      owner,
      repo,
      isPrimary: Boolean(repository.primary),
      position: index,
      createdAt: now,
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

function environmentRevision(input: {
  id: string;
  environmentId: string;
  revisionNumber: number;
  repositories: EnvironmentRepositoryRecord[];
  actor: EnvironmentMutationActor | undefined;
  createdAt: Date;
}): EnvironmentRevisionRecord {
  const actor = normalizedActor(input.actor);
  return {
    id: input.id,
    environmentId: input.environmentId,
    revisionNumber: input.revisionNumber,
    repositories: input.repositories.map((repository) => ({
      provider: repository.provider,
      owner: repository.owner,
      repo: repository.repo,
      primary: repository.isPrimary,
      position: repository.position,
      ...(repository.branch ? { branch: repository.branch } : {}),
    })),
    actorType: actor.type,
    ...(actor.userId ? { actorUserId: actor.userId } : {}),
    createdAt: input.createdAt,
  };
}

function environmentActivity(input: {
  environmentId: string;
  type: EnvironmentActivityRecord['type'];
  actor: EnvironmentMutationActor | undefined;
  revisionId?: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}): EnvironmentActivityRecord {
  const actor = normalizedActor(input.actor);
  return {
    id: randomUUID(),
    environmentId: input.environmentId,
    type: input.type,
    actorType: actor.type,
    ...(actor.userId ? { actorUserId: actor.userId } : {}),
    ...(input.revisionId ? { revisionId: input.revisionId } : {}),
    payload: input.payload,
    createdAt: input.createdAt,
  };
}

function environmentUpdateActivities(
  current: EnvironmentWithDetailsRecord,
  next: EnvironmentWithDetailsRecord,
  actor: EnvironmentMutationActor | undefined,
  createdAt: Date,
  revision: EnvironmentRevisionRecord | undefined,
): EnvironmentActivityRecord[] {
  const activities: EnvironmentActivityRecord[] = [];
  if (revision) {
    activities.push(
      environmentActivity({
        environmentId: current.id,
        type: 'revision_published',
        actor,
        revisionId: revision.id,
        payload: { revisionNumber: revision.revisionNumber },
        createdAt,
      }),
    );
  }
  if (current.shareMode !== next.shareMode || current.sharedGroupIds.join('\0') !== next.sharedGroupIds.join('\0')) {
    activities.push(
      environmentActivity({
        environmentId: current.id,
        type: 'sharing_changed',
        actor,
        revisionId: next.currentRevisionId,
        payload: {
          before: { shareMode: current.shareMode, sharedGroupIds: current.sharedGroupIds },
          after: { shareMode: next.shareMode, sharedGroupIds: next.sharedGroupIds },
        },
        createdAt,
      }),
    );
  }
  if (current.ownerGroupId !== next.ownerGroupId) {
    activities.push(
      environmentActivity({
        environmentId: current.id,
        type: 'owner_transferred',
        actor,
        revisionId: next.currentRevisionId,
        payload: { beforeOwnerGroupId: current.ownerGroupId, afterOwnerGroupId: next.ownerGroupId },
        createdAt,
      }),
    );
  }
  if (current.name !== next.name) {
    activities.push(
      environmentActivity({
        environmentId: current.id,
        type: 'environment_renamed',
        actor,
        revisionId: next.currentRevisionId,
        payload: { beforeName: current.name, afterName: next.name },
        createdAt,
      }),
    );
  }
  return activities;
}

function sameRepositoryConfiguration(
  current: EnvironmentRepositoryRecord[],
  candidate: EnvironmentRepositoryRecord[],
): boolean {
  const shape = (repository: EnvironmentRepositoryRecord) => ({
    provider: repository.provider,
    owner: repository.owner.toLowerCase(),
    repo: repository.repo.toLowerCase(),
    branch: repository.branch ?? null,
    primary: repository.isPrimary,
    position: repository.position,
  });
  return JSON.stringify(current.map(shape)) === JSON.stringify(candidate.map(shape));
}

function normalizedActor(actor: EnvironmentMutationActor | undefined): EnvironmentMutationActor {
  return actor?.type === 'user' && actor.userId ? actor : { type: 'system' };
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
