import { randomUUID } from 'node:crypto';
import type {
  SkillRecord,
  SkillRevisionRecord,
  SkillRevisionWrite,
  SkillRunCandidate,
  SkillStore,
} from '../store/types.js';
import { compareManagedSkillCatalogEntries } from './catalog.js';

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maxSkillNameLength = 64;
const maxSkillDescriptionLength = 1024;
const maxSkillBodyBytes = 64 * 1024;

type CreateSkillInputBase = {
  scope?: 'tenant' | 'personal';
  name: string;
  description: string;
  body: string;
  autoLoad?: boolean;
  createdByUserId?: string;
  actor?: SkillMutationActor;
};

export type CreateSkillInput = CreateSkillInputBase;

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

export type SkillServiceStore = SkillStore;

export class SkillService {
  constructor(private readonly store: SkillServiceStore) {}

  async create(input: CreateSkillInput): Promise<SkillRecord> {
    const now = new Date();
    const id = randomUUID();
    const name = validateSkillName(input.name);
    const description = validateSkillDescription(input.description);
    const body = validateSkillBody(input.body);
    const scope = input.scope ?? 'tenant';
    const ownerUserId = scope === 'personal' ? input.createdByUserId : undefined;
    if (scope === 'personal' && !ownerUserId) {
      throw new SkillServiceError('invalid_scope', 'Personal skills require an authenticated owner');
    }
    if (scope === 'personal' && input.autoLoad === true) {
      throw new SkillServiceError('invalid_scope', 'Personal skills cannot be auto-loaded');
    }
    const ownership =
      scope === 'personal' ? { scope: 'personal' as const, ownerUserId: ownerUserId! } : { scope: 'tenant' as const };
    const record = {
      id,
      ...ownership,
      revision: skillRevision({
        id: randomUUID(),
        name,
        description,
        body,
        actor: input.actor ?? actorFromUserId(input.createdByUserId),
        createdAt: now,
      }),
      autoLoad: scope === 'personal' ? false : (input.autoLoad ?? true),
      enabled: true,
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return this.store.createSkill(record);
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
    if (existing.scope === 'personal' && input.autoLoad === true) {
      throw new SkillServiceError('invalid_scope', 'Personal skills cannot be auto-loaded');
    }
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

  list(userId?: string): Promise<SkillRecord[]> {
    return this.store.listSkills(userId ? { userId } : {});
  }

  async listInvocationCandidates(
    userId?: string,
    canUse: (skill: SkillRunCandidate) => boolean = () => true,
  ): Promise<SkillRunCandidate[]> {
    const candidates = await this.store.listSkillInvocationCandidates(userId ? { userId } : {});
    return candidates.filter(canUse).sort(compareManagedSkillCatalogEntries);
  }

  async listForRun(input: {
    userId?: string;
    invokedNames: string[];
    invokedRevisions: Array<{ skillId: string; revisionId: string }>;
  }): Promise<SkillRunCandidate[]> {
    const candidates = await this.store.listSkillsForRun(input);
    return candidates.sort(compareManagedSkillCatalogEntries);
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
      | 'invalid_scope'
      | 'invalid_sharing'
      | 'skill_archived',
    message: string,
  ) {
    super(message);
  }
}
