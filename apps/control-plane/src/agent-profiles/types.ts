export type AgentProfileInvocation = 'agent' | 'subagent';

export type AgentProfileDefinition = {
  id: string;
  source: 'builtin' | 'managed';
  name: string;
  description: string;
  instructions: string;
  revision: string;
  revisionNumber?: number;
  defaultModel?: string;
  defaultReasoningLevel?: string;
  supportedInvocations: AgentProfileInvocation[];
  enabled: boolean;
  archivedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
};

export type AppliedAgentProfileSnapshot = {
  profileId: string;
  source: 'builtin' | 'managed';
  revision: string;
  hash: string;
  instructions: string;
  model?: string;
  reasoningLevel?: string;
  supportedInvocations: AgentProfileInvocation[];
};

export type AgentProfileExecutionContext = {
  agentProfileSnapshot: AppliedAgentProfileSnapshot;
  model?: string;
  reasoningLevel?: string;
};

export type RuntimeAgentProfile = {
  id: string;
  name: string;
  source: 'builtin' | 'managed';
  revision: string;
  hash: string;
  description: string;
  instructions: string;
  model?: string;
  reasoningLevel?: string;
};

export type AgentProfileCatalogEntry = Pick<RuntimeAgentProfile, 'id' | 'name' | 'description'>;

export function formatAgentProfileCatalog(profiles: readonly AgentProfileCatalogEntry[]): string {
  return profiles.map((profile) => `${profile.id} — ${profile.name}: ${profile.description}`).join('; ');
}

export function readAppliedAgentProfileSnapshot(value: unknown): AppliedAgentProfileSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.profileId !== 'string' ||
    (snapshot.source !== 'builtin' && snapshot.source !== 'managed') ||
    typeof snapshot.revision !== 'string' ||
    typeof snapshot.hash !== 'string' ||
    typeof snapshot.instructions !== 'string' ||
    (snapshot.model !== undefined && typeof snapshot.model !== 'string') ||
    (snapshot.reasoningLevel !== undefined && typeof snapshot.reasoningLevel !== 'string') ||
    !Array.isArray(snapshot.supportedInvocations) ||
    snapshot.supportedInvocations.some((invocation) => invocation !== 'agent' && invocation !== 'subagent')
  )
    return null;
  return snapshot as AppliedAgentProfileSnapshot;
}
