import { randomUUID } from 'node:crypto';
import { canCreateSessionInGroup, canInvokeSkillInSession, type RequestAuthorization } from '../auth/authorization.js';
import type {
  AuthStore,
  GroupStore,
  SkillRecord,
  SkillRevisionRecord,
  SkillRevisionWrite,
  SkillRunCandidate,
  SkillShareMode,
  SkillStore,
} from '../store/types.js';
import { compareManagedSkillCatalogEntries } from './catalog.js';

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maxSkillNameLength = 64;
const maxSkillDescriptionLength = 1024;
const maxSkillBodyBytes = 64 * 1024;

type CreateSkillInputBase = {
  name: string;
  description: string;
  body: string;
  autoLoad?: boolean;
  createdByUserId?: string;
  actor?: SkillMutationActor;
};

export type CreateSkillInput = CreateSkillInputBase &
  ({ ownerGroupId: string; ownerUserId?: never } | { ownerUserId: string; ownerGroupId?: never });

export type UpdateSkillInput = {
  id: string;
  expectedCurrentRevisionId?: string;
  name?: string;
  description?: string;
  body?: string;
  autoLoad?: boolean;
  enabled?: boolean;
  actor?: SkillMutationActor;
};

export type SkillMutationActor = { type: 'user'; userId: string } | { type: 'system'; userId?: never };

export type SkillServiceStore = SkillStore & AuthStore & GroupStore;

export class SkillService {
  constructor(private readonly store: SkillServiceStore) {}

  async create(input: CreateSkillInput): Promise<SkillRecord> {
    const now = new Date();
    const id = randomUUID();
    const name = validateSkillName(input.name);
    const description = validateSkillDescription(input.description);
    const body = validateSkillBody(input.body);
    const record = {
      id,
      revision: skillRevision({
        id: randomUUID(),
        name,
        description,
        body,
        actor: input.actor ?? actorFromUserId(input.createdByUserId),
        createdAt: now,
      }),
      autoLoad: input.autoLoad ?? true,
      enabled: true,
      shareMode: 'none' as const,
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    if ('ownerGroupId' in input && input.ownerGroupId !== undefined) {
      return this.store.createSkill({ ...record, ownerKind: 'group', ownerGroupId: input.ownerGroupId });
    }
    return this.store.createSkill({ ...record, ownerKind: 'user', ownerUserId: input.ownerUserId });
  }

  get(id: string): Promise<SkillRecord | null> {
    return this.store.getSkill(id);
  }

  listRevisions(id: string): Promise<SkillRevisionRecord[]> {
    return this.store.listSkillRevisions(id);
  }

  async update(input: UpdateSkillInput): Promise<SkillRecord> {
    const existing = await this.requireSkill(input.id);
    assertMutable(existing);
    const fields = validateSkillFields(input);
    const name = fields.name ?? existing.name;
    const description = fields.description ?? existing.description;
    const body = fields.body ?? existing.body;
    const contentChanged = name !== existing.name || description !== existing.description || body !== existing.body;
    const liveChanged =
      (input.autoLoad !== undefined && input.autoLoad !== existing.autoLoad) ||
      (input.enabled !== undefined && input.enabled !== existing.enabled);
    if (!contentChanged && !liveChanged) return existing;
    const now = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
    return this.store.updateSkill({
      id: input.id,
      expectedCurrentRevisionId: input.expectedCurrentRevisionId ?? existing.currentRevisionId,
      updatedAt: now,
      ...(contentChanged
        ? {
            revision: skillRevision({
              id: randomUUID(),
              name,
              description,
              body,
              actor: input.actor ?? { type: 'system' },
              createdAt: now,
            }),
          }
        : {}),
      ...(input.autoLoad !== undefined ? { autoLoad: input.autoLoad } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    });
  }

  async archive(id: string): Promise<SkillRecord> {
    const existing = await this.requireSkill(id);
    assertMutable(existing);
    return (await this.store.archiveSkill({ skillId: id, archivedAt: new Date() })) ?? this.notFound(id);
  }

  async restore(id: string): Promise<SkillRecord> {
    await this.requireSkill(id);
    return (await this.store.restoreSkill({ skillId: id, updatedAt: new Date() })) ?? this.notFound(id);
  }

  async promote(id: string, groupId: string): Promise<SkillRecord> {
    const existing = await this.requireSkill(id);
    assertMutable(existing);
    if (existing.ownerKind !== 'user') {
      throw new SkillServiceError('invalid_owner', 'Only personal skills can be promoted');
    }
    return (await this.store.promoteSkill(id, groupId, new Date())) ?? this.notFound(id);
  }

  async setShares(id: string, shareMode: SkillShareMode, groupIds: string[]): Promise<SkillRecord> {
    const existing = await this.requireSkill(id);
    assertMutable(existing);
    if (existing.ownerKind !== 'group') {
      throw new SkillServiceError('invalid_owner', 'Personal skills cannot be shared');
    }
    return (await this.store.setSkillShares(id, shareMode, groupIds, new Date())) ?? this.notFound(id);
  }

  listPersonal(userId: string): Promise<SkillRecord[]> {
    return this.store.listSkillsForUser(userId);
  }

  listGroup(groupId: string): Promise<SkillRecord[]> {
    return this.store.listSkillsForGroups([groupId]);
  }

  listSharedInto(groupId: string): Promise<SkillRecord[]> {
    return this.store.listSkillsSharedIntoGroups([groupId]);
  }

  async listInvocationCandidates(
    ownerGroupId: string,
    userId?: string,
    canUse: (skill: SkillRunCandidate) => boolean = () => true,
  ): Promise<SkillRunCandidate[]> {
    const candidates = await this.store.listSkillInvocationCandidates({
      ownerGroupId,
      ...(userId ? { userId } : {}),
    });
    return candidates.filter(canUse).sort(compareManagedSkillCatalogEntries);
  }

  async listForRun(input: {
    ownerGroupId: string;
    createdByUserId?: string;
    invokedNames: string[];
    invokedRevisions: Array<{ skillId: string; revisionId: string }>;
  }): Promise<SkillRunCandidate[]> {
    const authorization = input.createdByUserId
      ? await this.liveInvocationAuthorization(input.createdByUserId, input.ownerGroupId)
      : null;
    if (input.createdByUserId && !authorization) return [];
    const candidates = await this.store.listSkillsForRun(input);
    return candidates
      .filter((skill) =>
        authorization ? canInvokeSkillInSession(authorization, skill, { ownerGroupId: input.ownerGroupId }) : true,
      )
      .sort(compareManagedSkillCatalogEntries);
  }

  private async liveInvocationAuthorization(
    userId: string,
    ownerGroupId: string,
  ): Promise<RequestAuthorization | null> {
    const [user, memberships] = await Promise.all([
      this.store.getAuthUser(userId),
      this.store.listUserGroupMemberships(userId),
    ]);
    if (!user) return null;
    const groups = await Promise.all(memberships.map((membership) => this.store.getGroup(membership.groupId)));
    const auth: RequestAuthorization = {
      bypass: false,
      user,
      memberships: memberships.filter((_, index) => !groups[index]?.archivedAt),
    };
    return canCreateSessionInGroup(auth, ownerGroupId) ? auth : null;
  }

  private async requireSkill(id: string): Promise<SkillRecord> {
    return (await this.store.getSkill(id)) ?? this.notFound(id);
  }

  private notFound(id: string): never {
    throw new SkillServiceError('not_found', `Skill not found: ${id}`);
  }
}

function validateSkillFields(input: { name?: unknown; description?: unknown; body?: unknown }): {
  name?: string;
  description?: string;
  body?: string;
} {
  const fields: { name?: string; description?: string; body?: string } = {};
  if (input.name !== undefined) {
    fields.name = validateSkillName(input.name);
  }
  if (input.description !== undefined) {
    fields.description = validateSkillDescription(input.description);
  }
  if (input.body !== undefined) {
    fields.body = validateSkillBody(input.body);
  }
  return fields;
}

function validateSkillName(value: unknown): string {
  if (typeof value !== 'string' || value.length > maxSkillNameLength || !skillNamePattern.test(value)) {
    throw new SkillServiceError('invalid_name', 'Skill name must be a lowercase slug of at most 64 characters');
  }
  return value;
}

function validateSkillDescription(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SkillServiceError('invalid_description', 'Skill description must be a string');
  }
  const description = value.trim();
  if (!description || description.length > maxSkillDescriptionLength) {
    throw new SkillServiceError(
      'invalid_description',
      'Skill description must be non-empty and at most 1024 characters',
    );
  }
  return description;
}

function validateSkillBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SkillServiceError('invalid_body', 'Skill body must be at most 64 KB');
  }
  const body = value.replace(/\r\n?/g, '\n');
  if (Buffer.byteLength(body, 'utf8') > maxSkillBodyBytes) {
    throw new SkillServiceError('invalid_body', 'Skill body must be at most 64 KB');
  }
  return body;
}

function skillRevision(input: {
  id: string;
  name: string;
  description: string;
  body: string;
  actor: SkillMutationActor;
  createdAt: Date;
}): SkillRevisionWrite {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    body: input.body,
    createdAt: input.createdAt,
    ...(input.actor.type === 'user'
      ? { actorType: input.actor.type, actorUserId: input.actor.userId }
      : { actorType: input.actor.type }),
  };
}

function actorFromUserId(userId: string | undefined): SkillMutationActor {
  return userId ? { type: 'user', userId } : { type: 'system' };
}

function assertMutable(skill: SkillRecord): void {
  if (skill.archivedAt) {
    throw new SkillServiceError('skill_archived', 'Restore this skill before editing it');
  }
}

export class SkillServiceError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_owner'
      | 'invalid_name'
      | 'invalid_description'
      | 'invalid_body'
      | 'skill_archived',
    message: string,
  ) {
    super(message);
  }
}
