import { createSyntheticSourceInfo, stripFrontmatter } from '@earendil-works/pi-coding-agent';
import type { NormalizedEventPayload } from '../events/types.js';
import type { RunnerInput, RunnerMessageInput } from '../runner/types.js';
import { compareManagedSkillPrecedence, skillSourcePrecedence } from '../skills/catalog.js';
import { clearManagedSkillsRoot, materializeManagedSkill } from './managed-skills.js';
import { scanRepositorySkills } from './repository-mirror.js';
import type {
  ManagedSkillCandidate,
  MessageSkillInvocation,
  MessageSkillInvocations,
  PiSkillsProvider,
  PreparedPiSkills,
  PreparedSkillTrace,
  ResolvedSkill,
  SkillRepositoryPlan,
} from './skill-types.js';
import { rethrowIfAborted, warnSkillDegradation } from './skill-utils.js';

export { serializeManagedSkill } from './managed-skills.js';
export type {
  ManagedSkillCandidate,
  ManagedSkillSource,
  PiSkillsProvider,
  PreparedPiSkills,
  PreparedSkillTrace,
  SkillRepositoryPlan,
} from './skill-types.js';

export function unavailablePiSkills(runnerInput: RunnerInput, diagnostic: string): PreparedPiSkills {
  return {
    skills: [],
    prompt: buildSkillPrompt(runnerInput, []),
    event: { skills: [], shadowed: [], diagnostics: [diagnostic] },
    modelInvocable: [],
    userInvocations: [],
  };
}

export async function preparePiSkills(input: {
  runnerInput: RunnerInput;
  provider?: PiSkillsProvider;
  repositories: SkillRepositoryPlan[];
}): Promise<PreparedPiSkills> {
  const diagnostics: string[] = [];
  const messageInvocations = collectMessageSkillInvocations(input.runnerInput);
  const candidates: ResolvedSkill[] = [];
  let order = 0;

  if (input.provider) {
    const managedRoot = await clearManagedSkillsRoot(input.runnerInput, diagnostics);
    let managed: Array<{ candidate: ManagedSkillCandidate; invocationKeys: Set<string>; advertised: boolean }> = [];
    if (!input.runnerInput.ownerGroupId) {
      diagnostics.push('Managed skills were not resolved because the run has no owner group.');
    } else {
      try {
        const autoLoaded = await input.provider.listForRun({
          ownerGroupId: input.runnerInput.ownerGroupId,
          ...(input.runnerInput.createdByUserId ? { createdByUserId: input.runnerInput.createdByUserId } : {}),
          invokedNames: [],
          invokedRevisions: [],
        });
        const byId = new Map(
          autoLoaded.map((candidate) => [
            managedCandidateKey(candidate),
            { candidate, invocationKeys: new Set<string>(), advertised: candidate.autoLoad },
          ]),
        );
        for (const message of messageInvocations) {
          if (!message.invocations.length) continue;
          const invoked = await input.provider.listForRun({
            ownerGroupId: input.runnerInput.ownerGroupId,
            ...(message.authorUserId ? { createdByUserId: message.authorUserId } : {}),
            invokedNames: [
              ...new Set(
                message.invocations.filter((invocation) => !invocation.revisionId).map((invocation) => invocation.name),
              ),
            ],
            invokedRevisions: message.invocations.flatMap((invocation) =>
              invocation.ref && invocation.revisionId
                ? [{ skillId: invocation.ref, revisionId: invocation.revisionId }]
                : [],
            ),
          });
          for (const candidate of invoked) {
            const invocationKeys = message.invocations
              .filter(
                (invocation) =>
                  invocation.name === candidate.name &&
                  (!invocation.ref || invocation.ref === candidate.id) &&
                  (!invocation.revisionId || invocation.revisionId === candidate.revisionId),
              )
              .map((invocation) => invocation.key);
            if (!invocationKeys.length) continue;
            const key = managedCandidateKey(candidate);
            const resolved = byId.get(key) ?? {
              candidate,
              invocationKeys: new Set<string>(),
              advertised: false,
            };
            for (const key of invocationKeys) resolved.invocationKeys.add(key);
            byId.set(key, resolved);
          }
        }
        managed = [...byId.values()];
      } catch (error) {
        rethrowIfAborted(error, input.runnerInput.signal);
        warnSkillDegradation('managed skill resolution');
        diagnostics.push('Managed skills could not be resolved for this run.');
      }
    }
    const managedGroups = new Map<
      string,
      Array<{ candidate: ManagedSkillCandidate; invocationKeys: Set<string>; advertised: boolean }>
    >();
    for (const resolved of managed) {
      const key = `${resolved.candidate.source}:${resolved.candidate.name}`;
      const group = managedGroups.get(key) ?? [];
      group.push(resolved);
      managedGroups.set(key, group);
    }
    const orderedManaged = [...managedGroups.values()].flatMap((group) =>
      group[0]?.candidate.source === 'shared'
        ? group.sort((left, right) => compareManagedSkillPrecedence(left.candidate, right.candidate))
        : group,
    );
    for (const resolved of orderedManaged) {
      const candidate = resolved.candidate;
      const materialized = await materializeManagedSkill(
        input.runnerInput.sandbox,
        managedRoot,
        candidate,
        diagnostics,
        input.runnerInput.signal,
      );
      if (!materialized) continue;
      candidates.push({
        ref: candidate.id,
        content: materialized.content,
        skill: {
          name: candidate.name,
          description: candidate.description,
          filePath: materialized.filePath,
          baseDir: materialized.baseDir,
          sourceInfo: createSyntheticSourceInfo(materialized.filePath, {
            source: 'deputies',
            scope: 'temporary',
            baseDir: materialized.baseDir,
          }),
          disableModelInvocation: !resolved.advertised,
        },
        source: candidate.source,
        skillId: candidate.id,
        revisionId: candidate.revisionId,
        revisionNumber: candidate.revisionNumber,
        ...(candidate.ownerGroupId ? { ownerGroupId: candidate.ownerGroupId } : {}),
        ...(candidate.ownerGroupName ? { ownerGroupName: candidate.ownerGroupName } : {}),
        createdAt: candidate.createdAt,
        invocationKeys: resolved.invocationKeys,
        order: order++,
      });
    }
  }

  if (input.provider?.repoScanEnabled) {
    for (const repository of input.repositories) {
      let scanned: Awaited<ReturnType<typeof scanRepositorySkills>> = [];
      try {
        scanned = await scanRepositorySkills(
          input.runnerInput.sandbox,
          repository,
          diagnostics,
          input.runnerInput.signal,
        );
      } catch (error) {
        rethrowIfAborted(error, input.runnerInput.signal);
        warnSkillDegradation('repository skill scan');
        diagnostics.push(
          `Repository skills in ${repository.repository.owner}/${repository.repository.repo} could not be loaded.`,
        );
      }
      for (const scannedSkill of scanned) {
        const { skill } = scannedSkill;
        const ref = repositorySkillRef(repository.repository, skill.name);
        const invocationKeys = new Set(
          messageInvocations.flatMap((message) =>
            message.invocations
              .filter((invocation) => invocation.name === skill.name && (!invocation.ref || invocation.ref === ref))
              .map((invocation) => invocation.key),
          ),
        );
        candidates.push({
          ref,
          content: scannedSkill.content,
          skill,
          source: 'repo',
          repo: `${repository.repository.owner}/${repository.repository.repo}`,
          invocationKeys,
          order: order++,
        });
      }
    }
  }

  const { selected, shadowed } = dedupeSkills(
    candidates.filter((candidate) => !candidate.skill.disableModelInvocation),
  );
  const selectedCandidates = new Set(selected);
  const candidatesByInvocation = resolvedSkillsByInvocation(candidates);
  const manualRepositoryCandidates = candidates.filter(
    (candidate) => candidate.source === 'repo' && candidate.skill.disableModelInvocation,
  );
  const observedCandidates = new Set([...selected, ...manualRepositoryCandidates]);
  const observed = [
    ...selected.map((candidate) => skillLoadEventItem(candidate, true)),
    ...manualRepositoryCandidates.map((candidate) => skillLoadEventItem(candidate, false)),
    ...candidates
      .filter(
        (candidate) =>
          candidate.invocationKeys.size > 0 && !selectedCandidates.has(candidate) && !observedCandidates.has(candidate),
      )
      .map((candidate) => skillLoadEventItem(candidate, false)),
  ];
  return {
    skills: selected.map((candidate) => candidate.skill),
    prompt: buildSkillPrompt(input.runnerInput, candidates, messageInvocations),
    event: { skills: observed, shadowed, diagnostics },
    modelInvocable: selected.map(skillTrace),
    userInvocations: messageInvocations.flatMap(({ message, invocations }) =>
      invocations.flatMap((invocation) => {
        const candidate = candidatesByInvocation.get(invocation.key);
        return candidate
          ? [{ messageId: message.messageId ?? input.runnerInput.messageId, skill: skillTrace(candidate) }]
          : [];
      }),
    ),
  };
}

function collectMessageSkillInvocations(
  input: Pick<RunnerInput, 'messages' | 'messageId' | 'prompt' | 'createdByUserId' | 'skillInvocations'>,
): MessageSkillInvocations[] {
  const messages = input.messages?.length
    ? input.messages
    : [
        {
          messageId: input.messageId,
          prompt: input.prompt,
          skillInvocations: input.skillInvocations ?? [],
          ...(input.createdByUserId ? { authorUserId: input.createdByUserId } : {}),
        },
      ];
  return messages.map((message, messageIndex) => ({
    message,
    ...(message.authorUserId ? { authorUserId: message.authorUserId } : {}),
    invocations: (message.skillInvocations ?? []).map((invocation, invocationIndex) => ({
      key: `${messageIndex}:${invocationIndex}`,
      name: invocation.name,
      ...(invocation.ref ? { ref: invocation.ref } : {}),
      ...(invocation.revisionId ? { revisionId: invocation.revisionId } : {}),
    })),
  }));
}

function skillTrace(candidate: ResolvedSkill): PreparedSkillTrace {
  return {
    name: candidate.skill.name,
    source: candidate.source,
    ref: candidate.ref,
    filePath: candidate.skill.filePath,
    ...(candidate.repo ? { repo: candidate.repo } : {}),
    ...(candidate.ownerGroupId ? { ownerGroupId: candidate.ownerGroupId } : {}),
    ...(candidate.ownerGroupName ? { ownerGroupName: candidate.ownerGroupName } : {}),
    ...(candidate.source !== 'repo'
      ? {
          skillId: candidate.skillId,
          revisionId: candidate.revisionId,
          revisionNumber: candidate.revisionNumber,
        }
      : {}),
  };
}

function skillLoadEventItem(
  candidate: ResolvedSkill,
  advertised: boolean,
): NormalizedEventPayload<'skills_loaded'>['skills'][number] {
  return {
    name: candidate.skill.name,
    source: candidate.source,
    ...(candidate.repo ? { repo: candidate.repo } : {}),
    ...(candidate.ownerGroupId ? { ownerGroupId: candidate.ownerGroupId } : {}),
    ...(candidate.ownerGroupName ? { ownerGroupName: candidate.ownerGroupName } : {}),
    ...(candidate.source !== 'repo'
      ? {
          skillId: candidate.skillId,
          revisionId: candidate.revisionId,
          revisionNumber: candidate.revisionNumber,
        }
      : {}),
    ...(candidate.ref && !advertised ? { ref: candidate.ref } : {}),
    ...(candidate.invocationKeys.size > 0 ? { invoked: true as const } : {}),
    ...(!advertised ? { advertised: false as const } : {}),
  };
}

function dedupeSkills(candidates: ResolvedSkill[]): {
  selected: ResolvedSkill[];
  shadowed: NormalizedEventPayload<'skills_loaded'>['shadowed'];
} {
  const grouped = new Map<string, ResolvedSkill[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.skill.name) ?? [];
    group.push(candidate);
    grouped.set(candidate.skill.name, group);
  }
  const selected: ResolvedSkill[] = [];
  const shadowed: NormalizedEventPayload<'skills_loaded'>['shadowed'] = [];
  for (const group of grouped.values()) {
    group.sort(compareCatalogPrecedence);
    const winner = group[0];
    if (!winner) continue;
    selected.push(winner);
    shadowed.push(
      ...group.slice(1).map((candidate) => ({
        name: candidate.skill.name,
        source: candidate.source,
        ...(candidate.repo ? { repo: candidate.repo } : {}),
        ...(candidate.ownerGroupId ? { ownerGroupId: candidate.ownerGroupId } : {}),
        ...(candidate.ownerGroupName ? { ownerGroupName: candidate.ownerGroupName } : {}),
        ...(candidate.source !== 'repo'
          ? {
              skillId: candidate.skillId,
              revisionId: candidate.revisionId,
              revisionNumber: candidate.revisionNumber,
            }
          : {}),
      })),
    );
  }
  selected.sort((left, right) => left.order - right.order);
  return { selected, shadowed };
}

function compareCatalogPrecedence(left: ResolvedSkill, right: ResolvedSkill): number {
  const sourceDifference = skillSourcePrecedence(left.source) - skillSourcePrecedence(right.source);
  if (sourceDifference) return sourceDifference;
  if (left.source === 'shared' && right.source === 'shared') {
    const createdDifference = left.createdAt.getTime() - right.createdAt.getTime();
    if (createdDifference) return createdDifference;
  }
  return left.order - right.order;
}

function buildSkillPrompt(
  input: RunnerInput,
  candidates: ResolvedSkill[],
  messages = collectMessageSkillInvocations(input),
): string {
  const byInvocation = resolvedSkillsByInvocation(candidates);
  const prefixed = messages.map(({ message, invocations }) => prefixInvokedSkills(message, invocations, byInvocation));
  if (prefixed.length === 1) return prefixed[0]?.prompt ?? input.prompt;
  return `The user sent these queued follow-up messages. Address them in order.\n\n${prefixed
    .map((message, index) => `Message ${message.sequence ?? index + 1}:\n${message.prompt}`)
    .join('\n\n')}`;
}

function resolvedSkillsByInvocation(candidates: ResolvedSkill[]): Map<string, ResolvedSkill> {
  const byInvocation = new Map<string, ResolvedSkill>();
  for (const candidate of candidates) {
    for (const key of candidate.invocationKeys) {
      const current = byInvocation.get(key);
      if (!current || compareCatalogPrecedence(candidate, current) < 0) byInvocation.set(key, candidate);
    }
  }
  return byInvocation;
}

function prefixInvokedSkills(
  message: RunnerMessageInput,
  invocations: MessageSkillInvocation[],
  byInvocation: Map<string, ResolvedSkill>,
): RunnerMessageInput {
  const prefixes = invocations.map((invocation) => {
    const candidate = byInvocation.get(invocation.key);
    return candidate
      ? `<skill name="${candidate.skill.name}" location="${candidate.skill.filePath}">
References are relative to ${candidate.skill.baseDir}.

${stripFrontmatter(candidate.content).trim()}
</skill>`
      : `The user invoked the skill "${invocation.name}", but it is unavailable for this run. Continue without it.`;
  });
  return prefixes.length ? { ...message, prompt: `${prefixes.join('\n')}\n\n${message.prompt}` } : message;
}

function repositorySkillRef(repository: { owner: string; repo: string }, name: string): string {
  return `repo:${repository.owner}/${repository.repo}:${name}`;
}

function managedCandidateKey(candidate: ManagedSkillCandidate): string {
  return `${candidate.id}:${candidate.revisionId}`;
}
