import type { SessionRecord } from '../store/types.js';

export type AgentPrincipal = {
  kind: 'session_agent';
  sessionId: string;
  spawnDepth: number;
  ownerUserId?: string;
};

export function agentCanReadSession(agent: AgentPrincipal, session: SessionRecord): boolean {
  return session.visibility !== 'private' || Boolean(agent.ownerUserId && session.ownerUserId === agent.ownerUserId);
}

export function agentCanManageSession(agent: AgentPrincipal, session: SessionRecord): boolean {
  return agentCanReadSession(agent, session);
}

export function agentCanWriteSession(agent: AgentPrincipal, session: SessionRecord): boolean {
  return agentCanReadSession(agent, session) && session.status !== 'archived';
}

export function agentCanCancelSession(agent: AgentPrincipal, session: SessionRecord): boolean {
  return agentCanWriteSession(agent, session);
}
