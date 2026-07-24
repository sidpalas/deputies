import { describe, expect, it } from 'vitest';
import {
  agentCanCancelSession,
  agentCanManageSession,
  agentCanReadSession,
  agentCanWriteSession,
  type AgentPrincipal,
} from '../../src/auth/agent-authorization.js';
import {
  canAdministerTenant,
  canManageSkill,
  canManageTenantResources,
  canReadSession,
  canReadSkill,
  canReadTenantResources,
  canWriteSession,
  type RequestAuthorization,
} from '../../src/auth/authorization.js';
import type { AuthUserRecord, SessionRecord, SkillRecord } from '../../src/store/types.js';

const now = new Date('2026-05-01T00:00:00.000Z');

describe('tenant authorization rules', () => {
  it.each(['viewer', 'member', 'admin'] as const)('%s can read active and archived resources', (role) => {
    const auth = authFor(role);
    expect(canReadTenantResources(auth)).toBe(true);
    expect(canReadSession(auth, session())).toBe(true);
    expect(canReadSession(auth, session({ status: 'archived' }))).toBe(true);
    expect(canReadSkill(auth, skill())).toBe(true);
  });

  it('allows members and admins, but not viewers, to mutate any creator’s resources', () => {
    const resource = session({ createdByUserId: 'another-user' });
    expect(canWriteSession(authFor('viewer'), resource)).toBe(false);
    expect(canManageTenantResources(authFor('viewer'))).toBe(false);
    for (const role of ['member', 'admin'] as const) {
      expect(canWriteSession(authFor(role), resource)).toBe(true);
      expect(canManageTenantResources(authFor(role))).toBe(true);
      expect(canManageSkill(authFor(role), skill({ createdByUserId: 'another-user' }))).toBe(true);
    }
  });

  it('reserves user and configuration administration for admins', () => {
    expect(canAdministerTenant(authFor('viewer'))).toBe(false);
    expect(canAdministerTenant(authFor('member'))).toBe(false);
    expect(canAdministerTenant(authFor('admin'))).toBe(true);
    expect(canAdministerTenant({ bypass: true, user: null })).toBe(true);
  });
});

describe('agent authorization rules', () => {
  const agent: AgentPrincipal = { kind: 'session_agent', sessionId: 'parent-session', spawnDepth: 1 };

  it('reads tenant sessions and writes only to active direct children', () => {
    expect(agentCanReadSession(agent, session())).toBe(true);
    expect(agentCanReadSession(agent, session({ status: 'archived' }))).toBe(true);
    expect(agentCanWriteSession(agent, session({ parentSessionId: agent.sessionId }))).toBe(true);
    expect(agentCanWriteSession(agent, session({ parentSessionId: 'other-parent' }))).toBe(false);
    expect(agentCanWriteSession(agent, session({ parentSessionId: agent.sessionId, status: 'archived' }))).toBe(false);
  });

  it('manages itself and direct children, but cancels only active direct children', () => {
    expect(agentCanManageSession(agent, session({ id: agent.sessionId }))).toBe(true);
    expect(agentCanManageSession(agent, session({ parentSessionId: agent.sessionId, status: 'archived' }))).toBe(true);
    expect(agentCanCancelSession(agent, session({ parentSessionId: agent.sessionId }))).toBe(true);
    expect(agentCanCancelSession(agent, session({ parentSessionId: agent.sessionId, status: 'archived' }))).toBe(false);
  });
});

function authFor(role: AuthUserRecord['role']): RequestAuthorization {
  return { bypass: false, user: { id: role, username: role, role, createdAt: now, updatedAt: now } };
}

function session(input: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    status: 'idle',
    spawnDepth: 0,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    tags: [],
    ...input,
  };
}

function skill(input: Partial<Omit<SkillRecord, 'scope' | 'ownerUserId'>> = {}): SkillRecord {
  return {
    id: 'skill-1',
    scope: 'tenant',
    name: 'skill',
    description: '',
    body: '# Skill',
    enabled: true,
    autoLoad: false,
    createdAt: now,
    updatedAt: now,
    currentRevisionId: 'revision-1',
    currentRevisionNumber: 1,
    createdByUserId: 'creator',
    ...input,
  };
}
