import type { Skill } from '@earendil-works/pi-coding-agent';
import type { NormalizedEventPayload } from '../events/types.js';
import type { RunnerMessageInput } from '../runner/types.js';

export type ManagedSkillSource = 'managed';
export type LoadedSkillSource = ManagedSkillSource | 'repo';

export type ManagedSkillCandidate = {
  id: string;
  revisionId: string;
  revisionNumber: number;
  name: string;
  description: string;
  body: string;
  autoLoad: boolean;
  source: ManagedSkillSource;
  createdAt: Date;
};

export type PiSkillsProvider = {
  repoScanEnabled: boolean;
  listForRun(input: {
    userId?: string;
    invokedNames: string[];
    invokedRevisions: Array<{ skillId: string; revisionId: string }>;
  }): Promise<ManagedSkillCandidate[]>;
};

export type SkillRepositoryPlan = {
  workspacePath: string;
  repository: { owner: string; repo: string };
};

type ResolvedSkillBase = {
  ref: string;
  skill: Skill;
  content: string;
  invocationKeys: Set<string>;
  order: number;
};

export type ResolvedSkill = ResolvedSkillBase &
  (
    | {
        source: ManagedSkillSource;
        skillId: string;
        revisionId: string;
        revisionNumber: number;
        createdAt: Date;
        repo?: never;
      }
    | {
        source: 'repo';
        repo: string;
        skillId?: never;
        revisionId?: never;
        revisionNumber?: never;
        createdAt?: never;
      }
  );

export type MessageSkillInvocation = {
  key: string;
  name: string;
  ref?: string;
  revisionId?: string;
};

export type MessageSkillInvocations = {
  message: RunnerMessageInput;
  authorUserId?: string;
  invocations: MessageSkillInvocation[];
};

export type PreparedPiSkills = {
  skills: Skill[];
  prompt: string;
  event: NormalizedEventPayload<'skills_loaded'>;
  modelInvocable: PreparedSkillTrace[];
  userInvocations: Array<{ messageId: string; skill: PreparedSkillTrace }>;
};

export type PreparedSkillTrace = Omit<NormalizedEventPayload<'skill_invoked'>, 'trigger'>;
