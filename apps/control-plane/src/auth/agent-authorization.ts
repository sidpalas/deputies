import type { SessionRecord } from '../store/types.js';

export type AgentPrincipal = {
  kind: 'session_agent';
  sessionId: string;
  ownerGroupId: string;
  spawnDepth: number;
};

export function agentCanReadSession(agent: AgentPrincipal, session: SessionRecord): boolean {
  return session.visibility === 'organization' || session.ownerGroupId === agent.ownerGroupId;
}

export function agentCanSpawnInGroup(agent: AgentPrincipal, groupId: string): boolean {
  return groupId === agent.ownerGroupId;
}

export function agentCanWriteSession(agent: AgentPrincipal, session: SessionRecord): boolean {
  return session.parentSessionId === agent.sessionId && session.status !== 'archived';
}

export function agentCanCancelSession(agent: AgentPrincipal, session: SessionRecord): boolean {
  return agentCanWriteSession(agent, session);
}
