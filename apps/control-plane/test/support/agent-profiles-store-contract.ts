import { describe, expect, it } from 'vitest';
import type { AppStore, CreateAgentProfileRecord } from '../../src/store/types.js';

const now = new Date('2026-07-27T00:00:00Z');

export function defineAgentProfilesStoreContract(getStore: () => AppStore): void {
  describe('agent profiles store contract', () => {
    it('persists the audited singleton tenant default configuration, including clear', async () => {
      const store = getStore();
      await expect(store.getTenantAgentProfileConfiguration()).resolves.toBeNull();
      const configured = await store.setTenantAgentProfileConfiguration({
        defaultProfileId: 'builtin:reviewer',
        updatedAt: now,
      });
      await expect(store.getTenantAgentProfileConfiguration()).resolves.toEqual(configured);
      const cleared = await store.setTenantAgentProfileConfiguration({
        defaultProfileId: null,
        updatedAt: new Date('2026-07-27T01:00:00Z'),
      });
      expect(cleared).not.toHaveProperty('defaultProfileId');
      await expect(store.getTenantAgentProfileConfiguration()).resolves.toEqual(cleared);
    });

    it('persists tenant settings for built-in profiles', async () => {
      const store = getStore();
      const setting = await store.setBuiltinAgentProfileSettings({
        profileId: 'builtin:reviewer',
        enabled: false,
        defaultModel: 'openai/reviewer',
        defaultReasoningLevel: 'high',
        updatedAt: now,
      });
      expect(setting).toMatchObject({
        profileId: 'builtin:reviewer',
        enabled: false,
        defaultModel: 'openai/reviewer',
        defaultReasoningLevel: 'high',
      });
      await expect(store.listBuiltinAgentProfileSettings()).resolves.toContainEqual(setting);
      const partial = await store.setBuiltinAgentProfileSettings({
        profileId: 'builtin:reviewer',
        enabled: true,
        updatedAt: new Date('2026-07-27T01:00:00Z'),
      });
      expect(partial).toMatchObject({
        enabled: true,
        defaultModel: 'openai/reviewer',
        defaultReasoningLevel: 'high',
      });
      const cleared = await store.setBuiltinAgentProfileSettings({
        profileId: 'builtin:reviewer',
        defaultModel: null,
        updatedAt: new Date('2026-07-27T02:00:00Z'),
      });
      expect(cleared).not.toHaveProperty('defaultModel');
      expect(cleared).toMatchObject({ enabled: true, defaultReasoningLevel: 'high' });
    });

    it('keeps immutable revisions and enforces compare-and-swap updates', async () => {
      const store = getStore();
      const created = await store.createAgentProfile(profile('00000000-0000-4000-8000-000000000501', 'Agent'));
      const updated = await store.updateAgentProfile({
        id: created.id,
        expectedCurrentRevisionId: created.currentRevisionId,
        revision: {
          ...profile(created.id, 'Agent v2').revision,
          id: '00000000-0000-4000-8000-000000000512',
          createdAt: new Date(now.getTime() + 1),
        },
        updatedAt: new Date(now.getTime() + 1),
      });
      expect(updated.currentRevisionNumber).toBe(2);
      expect((await store.listAgentProfileRevisions(created.id)).map((x) => x.name)).toEqual(['Agent v2', 'Agent']);
      await expect(
        store.updateAgentProfile({
          id: created.id,
          expectedCurrentRevisionId: created.currentRevisionId,
          revision: { ...profile(created.id, 'stale').revision, id: '00000000-0000-4000-8000-000000000513' },
          updatedAt: now,
        }),
      ).rejects.toMatchObject({ code: 'agent_profile_update_conflict' });
    });

    it('enforces active names and archive/restore semantics', async () => {
      const store = getStore();
      const first = await store.createAgentProfile(profile('00000000-0000-4000-8000-000000000521', 'Unique'));
      await expect(
        store.createAgentProfile(profile('00000000-0000-4000-8000-000000000522', 'unique')),
      ).rejects.toMatchObject({ code: 'agent_profile_name_exists' });
      await store.archiveAgentProfile({ id: first.id, archivedAt: now });
      await store.createAgentProfile(profile('00000000-0000-4000-8000-000000000522', 'unique'));
      await expect(store.restoreAgentProfile({ id: first.id, updatedAt: now })).rejects.toMatchObject({
        code: 'agent_profile_name_exists',
      });
    });
  });
}

function profile(id: string, name: string): CreateAgentProfileRecord {
  return {
    id,
    name,
    revision: {
      id,
      name,
      description: `${name} description`,
      instructions: `${name} instructions`,
      supportedInvocations: ['agent'],
      actorType: 'system',
      createdAt: now,
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}
