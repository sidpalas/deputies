import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Skill, SkillInvocationRef } from '../../api.js';

export const MAX_INVOKED_SKILLS = 8;

export type SkillInvocationSubmission = {
  prompt: string;
  skills: string[];
  skillRefs: SkillInvocationRef[];
};

export function prepareSkillSubmission(prompt: string, selected: Skill[], available: Skill[]) {
  const reconciled = reconcileSelectedSkills(selected, available);
  const match = /^\/([^\s]+)(?:\s+|$)/.exec(prompt);
  if (!match?.[1] || reconciled.length >= MAX_INVOKED_SKILLS) return { prompt, skills: reconciled };
  const skill = available.find(
    (candidate) => !candidate.archivedAt && candidate.enabled && candidate.name === match[1],
  );
  if (!skill || reconciled.some((candidate) => candidate.id === skill.id)) {
    return { prompt, skills: reconciled };
  }
  return {
    prompt: prompt.slice(match[0].length).trimStart(),
    skills: [...reconciled, skill],
  };
}

export function reconcileSelectedSkills(selected: Skill[], available: Skill[]): Skill[] {
  const availableById = new Map(
    available.filter((skill) => !skill.archivedAt && skill.enabled).map((skill) => [skill.id, skill]),
  );
  const ids = new Set<string>();
  return selected.filter((skill) => {
    const current = availableById.get(skill.id);
    if (
      !current ||
      ids.has(skill.id) ||
      (skill.source === 'repo' ? current.name !== skill.name : !skill.currentRevisionId && current.name !== skill.name)
    )
      return false;
    ids.add(skill.id);
    return true;
  });
}

export function skillInvocationRef(skill: Skill): SkillInvocationRef {
  return {
    id: skill.id,
    name: skill.name,
    ...(skill.source !== 'repo' && skill.currentRevisionId ? { revisionId: skill.currentRevisionId } : {}),
  };
}

export function prepareSkillInvocationSubmission(
  prompt: string,
  selected: Skill[],
  available: Skill[],
): SkillInvocationSubmission {
  const prepared = prepareSkillSubmission(prompt, selected, available);
  return {
    prompt: prepared.prompt,
    skills: prepared.skills.map((skill) => skill.name),
    skillRefs: prepared.skills.map(skillInvocationRef),
  };
}

export function matchingSkills(available: Skill[], selected: Skill[], prompt: string): Skill[] {
  const slash = /^\/([^\s]*)$/.exec(prompt);
  if (!slash) return [];
  const query = slash[1]!.trim().toLowerCase();
  const selectedIds = new Set(selected.map((skill) => skill.id));
  return available
    .filter((skill) => !skill.archivedAt && skill.enabled && !selectedIds.has(skill.id))
    .filter(
      (skill) => !query || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query),
    )
    .slice(0, 30);
}

export function useSkillInvocationDraft(input: {
  available: Skill[];
  enabled: boolean;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}) {
  const [selectedSkills, setSelectedSkills] = useState<Skill[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const pickerOpen = input.enabled && /^\/[^\s]*$/.test(input.prompt);
  const options = matchingSkills(input.available, selectedSkills, input.prompt);

  useEffect(() => {
    setSelectedSkills((current) => {
      const reconciled = input.enabled ? reconcileSelectedSkills(current, input.available) : [];
      return reconciled.length === current.length && reconciled.every((skill, index) => skill === current[index])
        ? current
        : reconciled;
    });
  }, [input.available, input.enabled]);

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, input.prompt]);

  function changePrompt(prompt: string) {
    input.onPromptChange(prompt);
    setActiveIndex(0);
  }

  function selectSkill(skill: Skill) {
    if (selectedSkills.length >= MAX_INVOKED_SKILLS || selectedSkills.some((candidate) => candidate.id === skill.id))
      return;
    setSelectedSkills([...selectedSkills, skill]);
    input.onPromptChange('');
    setActiveIndex(0);
  }

  function removeSkill(skillId: string) {
    setSelectedSkills((current) => current.filter((skill) => skill.id !== skillId));
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!pickerOpen) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (options.length) {
        if (event.key === 'ArrowDown') setActiveIndex((index) => (index + 1) % options.length);
        else if (event.key === 'ArrowUp') setActiveIndex((index) => (index - 1 + options.length) % options.length);
        else setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
      }
      return true;
    }
    if (event.key !== 'Enter' || event.shiftKey) return false;
    event.preventDefault();
    const skill = options[Math.min(activeIndex, Math.max(0, options.length - 1))];
    if (skill) selectSkill(skill);
    return true;
  }

  return {
    activeIndex,
    activeOptionRef,
    changePrompt,
    clearSelectedSkills: () => setSelectedSkills([]),
    handlePromptKeyDown,
    options,
    pickerOpen,
    prepareSubmission: () => prepareSkillInvocationSubmission(input.prompt, selectedSkills, input.available),
    removeSkill,
    restoreSelectedSkills: setSelectedSkills,
    selectedSkills,
    selectSkill,
    setActiveIndex,
  };
}
