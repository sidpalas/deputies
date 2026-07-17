import { useMemo, useRef, useState } from 'react';
import { ApiError, archiveSkill, listSkills, restoreSkill, type Group, type Skill } from './api.js';

type StateUpdate<T> = T | ((current: T) => T);

export function useSkillsAdmin(input: {
  token: string;
  groups: Group[];
  canCallApi: boolean;
  selectedSkillId: string;
  setSelectedSkillId: (next: StateUpdate<string>) => void;
  onError: (error: unknown) => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef(input);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const refreshRequestRef = useRef(0);
  inputRef.current = input;
  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === input.selectedSkillId) ?? null,
    [skills, input.selectedSkillId],
  );

  async function refresh() {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    const currentInput = inputRef.current;
    if (!currentInput.canCallApi) return;
    refreshInFlightRef.current = true;
    setLoading(true);
    try {
      const groupIds = currentInput.groups
        .filter((group) => !group.archivedAt && (group.membershipRole || group.canManage))
        .map((group) => group.id);
      const personal = await listSkills({ token: currentInput.token, scope: 'personal' });
      if (refreshRequestRef.current !== requestId) return;
      setAvailable(true);
      const groupResults = await Promise.allSettled([
        ...groupIds.map((groupId) => listSkills({ token: currentInput.token, scope: 'group', groupId })),
        ...groupIds.map((groupId) => listSkills({ token: currentInput.token, scope: 'shared', groupId })),
      ]);
      if (refreshRequestRef.current !== requestId) return;
      const failed = groupResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) currentInput.onError(failed.reason);
      const next = dedupeSkills([
        ...personal,
        ...groupResults.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
      ]);
      setSkills(next);
      currentInput.setSelectedSkillId((current) =>
        current && !next.some((skill) => skill.id === current) ? '' : current,
      );
    } catch (error) {
      if (refreshRequestRef.current !== requestId) return;
      if (error instanceof ApiError && error.status === 404) {
        setSkills([]);
        setAvailable(false);
        currentInput.setSelectedSkillId('');
      } else {
        currentInput.onError(error);
      }
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refresh();
      } else if (refreshRequestRef.current === requestId) {
        setLoaded(true);
        setLoading(false);
      }
    }
  }

  function changed(skill: Skill) {
    refreshRequestRef.current += 1;
    if (refreshInFlightRef.current) refreshQueuedRef.current = true;
    setSkills((current) => [skill, ...current.filter((candidate) => candidate.id !== skill.id)]);
  }

  async function archive(skillId: string) {
    const skill = skills.find((candidate) => candidate.id === skillId);
    if (!skill?.canManage || skill.archivedAt) return;
    try {
      changed(await archiveSkill({ skillId, token: input.token }));
    } catch (error) {
      input.onError(error);
    }
  }

  async function restore(skillId: string) {
    const skill = skills.find((candidate) => candidate.id === skillId);
    if (!skill?.canManage || !skill.archivedAt) return;
    try {
      changed(await restoreSkill({ skillId, token: input.token }));
    } catch (error) {
      input.onError(error);
    }
  }

  function reset() {
    refreshRequestRef.current += 1;
    refreshQueuedRef.current = false;
    setSkills([]);
    setAvailable(null);
    setLoading(false);
    setLoaded(false);
  }

  return {
    skills,
    selectedSkill,
    available,
    loading,
    loaded,
    refresh,
    changed,
    archive,
    restore,
    reset,
  };
}

function dedupeSkills(skills: Skill[]): Skill[] {
  const byId = new Map<string, Skill>();
  for (const skill of skills) {
    const current = byId.get(skill.id);
    if (!current) {
      byId.set(skill.id, skill);
      continue;
    }
    const preferred = sourcePriority(skill.source) < sourcePriority(current.source) ? skill : current;
    byId.set(skill.id, preferred);
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function sourcePriority(source: Skill['source']): number {
  if (source === 'personal') return 0;
  if (source === 'group') return 1;
  if (source === 'shared') return 2;
  return 3;
}
