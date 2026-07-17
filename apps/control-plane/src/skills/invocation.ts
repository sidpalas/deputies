import type { NormalizedEventPayload } from '../events/types.js';
import type { SkillRunCandidate, EventStore } from '../store/types.js';
import type { SkillService } from './service.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SkillInvocationRef = { id: string; name: string; revisionId?: string };

export type RepositorySkillInvocationCandidate = {
  id: string;
  name: string;
  source: 'repo';
  repo: string;
  advertised: boolean;
  discoveredAt: Date;
};

export type SkillInvocationCandidate = SkillRunCandidate | RepositorySkillInvocationCandidate;

type InvocationSkills = Pick<SkillService, 'listInvocationCandidates'>;

export async function listSkillInvocationCandidates(input: {
  skills: InvocationSkills;
  events: Pick<EventStore, 'getLatestEventByType'>;
  ownerGroupId: string;
  userId?: string;
  sessionId?: string;
  repoSkillsEnabled: boolean;
  canUse?: (skill: SkillRunCandidate) => boolean;
}): Promise<SkillInvocationCandidate[]> {
  const managed = await input.skills.listInvocationCandidates(input.ownerGroupId, input.userId, input.canUse);
  if (!input.repoSkillsEnabled || !input.sessionId) return managed;

  const latest = await input.events.getLatestEventByType(input.sessionId, 'skills_loaded');
  const repository =
    latest?.type === 'skills_loaded'
      ? uniqueRepositorySkills([...latest.payload.skills, ...latest.payload.shadowed], latest.createdAt)
      : [];
  return [...managed, ...repository];
}

export async function canonicalizeMessageSkillContext(input: {
  skills: InvocationSkills;
  events: Pick<EventStore, 'getLatestEventByType'>;
  ownerGroupId: string;
  userId?: string;
  sessionId: string;
  skillsEnabled: boolean;
  repoSkillsEnabled: boolean;
  canUse?: (skill: SkillRunCandidate) => boolean;
  value: unknown;
}): Promise<{ skills: string[]; skillRefs: SkillInvocationRef[] } | undefined> {
  if (input.value === undefined) return undefined;
  if (!isRecord(input.value)) throw new SkillContextError('invalid_request', 'Expected context to be an object');
  if (!Object.prototype.hasOwnProperty.call(input.value, 'skills')) return undefined;
  const skills = input.value.skills;
  if (!Array.isArray(skills) || skills.length > 8 || skills.some((name) => typeof name !== 'string' || !name)) {
    throw new SkillContextError('invalid_request', 'Expected context.skills to contain at most 8 non-empty strings');
  }
  if (!input.skillsEnabled && skills.length) {
    throw new SkillContextError('unknown_skill', `Unknown or inaccessible skill: ${String(skills[0])}`);
  }

  const requestedRefs = parseSkillInvocationRefs(input.value.skillRefs, skills as string[]);
  const candidates = await listSkillInvocationCandidates(input);
  const canonicalRefs = (skills as string[]).map((name, index) => {
    const requested = requestedRefs?.[index];
    const candidate = requested
      ? candidates.find((item) => item.id === requested.id && item.name === requested.name)
      : candidates.find((item) => item.name === name);
    if (!candidate || (candidate.source === 'repo' && requested?.revisionId)) {
      throw new SkillContextError('unknown_skill', `Unknown or inaccessible skill: ${name}`);
    }
    if (candidate.source === 'repo') return { id: candidate.id, name: candidate.name };
    if (requested?.revisionId && requested.revisionId !== candidate.currentRevisionId) {
      throw new SkillContextError('unknown_skill', `Unknown or inaccessible skill: ${name}`);
    }
    return { id: candidate.id, name: candidate.name, revisionId: candidate.currentRevisionId };
  });
  return { skills: skills as string[], skillRefs: canonicalRefs };
}

export async function resolveIntegrationSkillInvocation(input: {
  skills: InvocationSkills;
  events: Pick<EventStore, 'getLatestEventByType'>;
  ownerGroupId: string;
  sessionId: string;
  repoSkillsEnabled: boolean;
  skillsEnabled: boolean;
  currentMessageText: string;
}): Promise<{
  name: string;
  text: string;
  ref: SkillInvocationRef;
  source: SkillInvocationCandidate['source'];
} | null> {
  if (!input.skillsEnabled) return null;
  const leading = input.currentMessageText.trimStart();
  if (!leading.startsWith('/')) return null;
  const token = leading.split(/\s/, 1)[0] ?? '';
  const name = token.slice(1);
  if (!name) return null;
  const candidates = await listSkillInvocationCandidates({
    skills: input.skills,
    events: input.events,
    ownerGroupId: input.ownerGroupId,
    sessionId: input.sessionId,
    repoSkillsEnabled: input.repoSkillsEnabled,
  });
  const candidate = candidates.find((item) => item.name === name);
  if (!candidate) return null;
  return {
    name,
    text: leading.slice(token.length).trimStart(),
    ref:
      candidate.source === 'repo'
        ? { id: candidate.id, name: candidate.name }
        : { id: candidate.id, name: candidate.name, revisionId: candidate.currentRevisionId },
    source: candidate.source,
  };
}

export class SkillContextError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'unknown_skill',
    message: string,
  ) {
    super(message);
  }
}

function parseSkillInvocationRefs(value: unknown, skills: string[]): SkillInvocationRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== skills.length) {
    throw new SkillContextError('invalid_request', 'Expected context.skillRefs to align with context.skills');
  }
  return value.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      !candidate.id ||
      typeof candidate.name !== 'string' ||
      candidate.name !== skills[index] ||
      (candidate.revisionId !== undefined &&
        (typeof candidate.revisionId !== 'string' || !uuidPattern.test(candidate.revisionId)))
    ) {
      throw new SkillContextError('invalid_request', 'Expected context.skillRefs to align with context.skills');
    }
    return {
      id: candidate.id,
      name: candidate.name,
      ...(typeof candidate.revisionId === 'string' ? { revisionId: candidate.revisionId } : {}),
    };
  });
}

function uniqueRepositorySkills(
  skills: NormalizedEventPayload<'skills_loaded'>['skills'],
  discoveredAt: Date,
): RepositorySkillInvocationCandidate[] {
  const seen = new Set<string>();
  return skills.flatMap((skill) => {
    if (skill.source !== 'repo' || !skill.repo) return [];
    const id = repositorySkillId(skill.repo, skill.name);
    if (seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        name: skill.name,
        source: 'repo' as const,
        repo: skill.repo,
        advertised: skill.advertised !== false,
        discoveredAt,
      },
    ];
  });
}

function repositorySkillId(repo: string, name: string): string {
  return `repo:${repo}:${name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
