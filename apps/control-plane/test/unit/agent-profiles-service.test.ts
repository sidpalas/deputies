import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentProfileService, type ManagedProfileWrite } from '../../src/agent-profiles/service.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('AgentProfileService', () => {
  let store: MemoryStore;
  let service: AgentProfileService;
  beforeEach(() => {
    store = new MemoryStore();
    service = new AgentProfileService(store);
  });

  it('merges built-ins, prevents mutation and name collisions', async () => {
    const profiles = await service.list();
    expect(profiles.some((x) => x.id === 'builtin:general')).toBe(true);
    expect(profiles).toContainEqual(
      expect.objectContaining({ id: 'builtin:adversary', name: 'Adversary', source: 'builtin' }),
    );
    expect(profiles.find((x) => x.id === 'builtin:general')?.supportedInvocations).toEqual(['agent', 'subagent']);
    expect(
      profiles.filter((x) => x.source === 'builtin').every((x) => x.supportedInvocations.join() === 'agent,subagent'),
    ).toBe(true);
    await expect(service.archive('builtin:general')).rejects.toMatchObject({ code: 'immutable_builtin' });
    await expect(service.create(write({ name: 'general' }))).rejects.toMatchObject({ code: 'name_collision' });
  });

  it('configures and resolves a tenant-wide effective default while retaining an unavailable configured id', async () => {
    await expect(service.getTenantConfiguration()).resolves.toMatchObject({
      configuredProfileId: null,
      effectiveProfileId: 'builtin:general',
    });
    const managed = await service.create(write({ name: 'Tenant default', supportedInvocations: ['agent'] }));
    await expect(service.setTenantDefault(managed.id, 'user-1')).resolves.toMatchObject({
      configuredProfileId: managed.id,
      effectiveProfileId: managed.id,
      updatedByUserId: 'user-1',
    });
    await service.archive(managed.id);
    await expect(service.getTenantConfiguration()).resolves.toMatchObject({
      configuredProfileId: managed.id,
      effectiveProfileId: 'builtin:general',
    });
    await expect(service.setTenantDefault('builtin:reviewer')).resolves.toMatchObject({
      effectiveProfileId: 'builtin:reviewer',
    });
    await service.updateBuiltinSettings('builtin:reviewer', { enabled: false });
    await expect(service.setTenantDefault('builtin:reviewer')).rejects.toMatchObject({ code: 'invalid' });
    await expect(service.setTenantDefault(null)).resolves.toMatchObject({
      configuredProfileId: null,
      effectiveProfileId: 'builtin:general',
    });
  });

  it('does not treat store failures as profile unavailability', async () => {
    vi.spyOn(store, 'getAgentProfile').mockRejectedValue(new Error('database unavailable'));
    await expect(service.effectiveDefault('managed-profile')).rejects.toThrow('database unavailable');
    await expect(service.setTenantDefault('managed-profile')).rejects.toThrow('database unavailable');
  });

  it('normalizes managed profile text before persistence and collision checks', async () => {
    const created = await service.create(
      write({ name: ' Collision ', description: ' Description ', instructions: ' Instructions ' }),
    );
    expect(created).toMatchObject({ name: 'Collision', description: 'Description', instructions: 'Instructions' });
    await expect(service.create(write({ name: 'collision' }))).rejects.toMatchObject({ code: 'name_collision' });
  });

  it('defaults new managed profiles to agent and subagent invocation', async () => {
    const { supportedInvocations: _, ...input } = write({ name: 'Default compatibility' });
    await expect(service.create(input)).resolves.toMatchObject({ supportedInvocations: ['agent', 'subagent'] });
  });

  it('applies tenant enabled, model, and reasoning settings to built-in profiles', async () => {
    await expect(
      service.updateBuiltinSettings(
        'builtin:reviewer',
        { enabled: false, defaultModel: 'openai/reviewer', defaultReasoningLevel: 'high' },
        'user-1',
      ),
    ).resolves.toMatchObject({
      id: 'builtin:reviewer',
      enabled: false,
      defaultModel: 'openai/reviewer',
      defaultReasoningLevel: 'high',
    });
    await expect(service.resolve('builtin:reviewer', 'subagent')).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      service.updateBuiltinSettings('builtin:reviewer', { enabled: true, defaultModel: null }),
    ).resolves.toMatchObject({ enabled: true, defaultReasoningLevel: 'high' });
    expect(await service.get('builtin:reviewer')).not.toHaveProperty('defaultModel');
    await expect(service.updateBuiltinSettings('missing', { enabled: false })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('lists only enabled profiles compatible with the requested runtime invocation', async () => {
    const managed = await service.create(write({ name: 'Custom researcher', supportedInvocations: ['subagent'] }));
    const agentOnly = await service.create(write({ name: 'Custom operator', supportedInvocations: ['agent'] }));
    const archived = await service.create(write({ name: 'Old researcher', supportedInvocations: ['subagent'] }));
    await service.archive(archived.id);
    await service.updateBuiltinSettings('builtin:reviewer', { enabled: false });
    const subagentProfiles = await service.listRuntimeProfiles('subagent');
    const agentProfiles = await service.listRuntimeProfiles('agent');
    expect(subagentProfiles.map((profile) => profile.id)).toContain(managed.id);
    expect(subagentProfiles.map((profile) => profile.id)).not.toContain(agentOnly.id);
    expect(subagentProfiles.map((profile) => profile.id)).not.toContain(archived.id);
    expect(subagentProfiles.map((profile) => profile.id)).not.toContain('builtin:reviewer');
    expect(agentProfiles.map((profile) => profile.id)).toContain(agentOnly.id);
    expect(agentProfiles.map((profile) => profile.id)).not.toContain(managed.id);
    expect(subagentProfiles.find((profile) => profile.id === managed.id)).toMatchObject({
      name: managed.name,
      source: 'managed',
      description: managed.description,
      instructions: managed.instructions,
    });
  });

  it('prevents active automations from losing their agent profile', async () => {
    const managed = await service.create(write({ name: 'Automation profile' }));
    const automation = await store.createAutomation({
      id: 'automation-1',
      kind: 'scheduled',
      name: 'Nightly review',
      prompt: 'Review changes',
      scheduleCron: '0 9 * * *',
      profileId: managed.id,
      enabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    await expect(service.archive(managed.id)).rejects.toMatchObject({
      code: 'in_use',
      message: expect.stringContaining(`Nightly review (${automation.id})`),
    });
    await expect(
      service.update(managed.id, managed.revision, write({ name: managed.name, supportedInvocations: ['subagent'] })),
    ).rejects.toMatchObject({ code: 'in_use' });

    await store.updateAutomation({ id: automation.id, enabled: false, updatedAt: new Date('2026-01-02T00:00:00Z') });
    const subagentOnly = await service.update(
      managed.id,
      managed.revision,
      write({ name: managed.name, supportedInvocations: ['subagent'] }),
    );
    await expect(service.archive(subagentOnly.id)).resolves.toMatchObject({ archivedAt: expect.any(Date) });
  });

  it('prevents disabling a built-in used by an active automation', async () => {
    const automation = await store.createAutomation({
      id: 'automation-2',
      kind: 'scheduled',
      name: 'Built-in review',
      prompt: 'Review changes',
      scheduleCron: '0 9 * * *',
      profileId: 'builtin:reviewer',
      enabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    await expect(service.updateBuiltinSettings('builtin:reviewer', { enabled: false })).rejects.toMatchObject({
      code: 'in_use',
    });
    await store.archiveAutomation({ automationId: automation.id, archivedAt: new Date('2026-01-02T00:00:00Z') });
    await expect(service.updateBuiltinSettings('builtin:reviewer', { enabled: false })).resolves.toMatchObject({
      enabled: false,
    });
  });

  it('creates immutable revisions, detects stale CAS, and archives/restores', async () => {
    const created = await service.create(write(), 'user-1');
    const updated = await service.update(created.id, created.revision, write({ instructions: 'new' }), 'user-1');
    expect(updated.revision).not.toBe(created.revision);
    expect((await service.listRevisions(created.id)).map((x) => x.instructions)).toEqual(['new', 'instructions']);
    await expect(service.update(created.id, created.revision, write())).rejects.toMatchObject({ code: 'conflict' });
    await service.archive(created.id);
    await expect(service.resolve(created.id, 'agent')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.restore(created.id)).resolves.toMatchObject({ id: created.id });
    await expect(service.listRevisions('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('checks invocation compatibility and applies deterministic pinned defaults with override precedence', async () => {
    const created = await service.create(write({ supportedInvocations: ['agent'], defaultModel: 'profile-model' }));
    await expect(service.resolve(created.id, 'subagent')).rejects.toMatchObject({ code: 'incompatible' });
    const first = await service.snapshot(created.id, 'agent', { model: 'override' });
    const second = await service.snapshot(created.id, 'agent', { model: 'override' });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ revision: created.revision, model: 'override' });
    const cleared = await service.snapshot(created.id, 'agent', {
      model: null,
      reasoningLevel: null,
    });
    expect(cleared).not.toHaveProperty('model');
    expect(cleared).not.toHaveProperty('reasoningLevel');
  });
});

function write(overrides: Partial<ManagedProfileWrite> = {}): ManagedProfileWrite {
  return {
    name: 'Managed',
    description: 'description',
    instructions: 'instructions',
    supportedInvocations: ['agent', 'subagent'],
    ...overrides,
  };
}
