import type { SessionRecord } from '../store/types.js';

export type AgentPrincipal = {
  kind: 'session_agent';
  sessionId: string;
  spawnDepth: number;
};

export function agentCanReadSession(_agent: AgentPrincipal, _session: SessionRecord): boolean {
  return true;
}

export function agentCanManageSession(agent: AgentPrincipal, session: SessionRecord): boolean {
  return session.id === agent.sessionId || session.parentSessionId === agent.sessionId;
}

export function agentCanWriteSession(agent: AgentPrincipal, session: SessionRecord): boolean {
  return session.parentSessionId === agent.sessionId && session.status !== 'archived';
}

export function agentCanCancelSession(agent: AgentPrincipal, session: SessionRecord): boolean {
  return agentCanWriteSession(agent, session);
}
