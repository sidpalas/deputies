import { createHash, randomUUID } from 'node:crypto';
import { builtinAgentProfile, builtinAgentProfiles } from './builtins.js';
import type {
  AgentProfileDefinition,
  AgentProfileExecutionContext,
  AgentProfileInvocation,
  AppliedAgentProfileSnapshot,
  RuntimeAgentProfile,
} from './types.js';
import {
  StoreConflictError,
  type AgentProfileRecord,
  type AgentProfileRevisionRecord,
  type AgentProfileStore,
  type AutomationStore,
  type BuiltinAgentProfileSettingRecord,
} from '../store/types.js';

export type ManagedProfileWrite = Omit<
  AgentProfileDefinition,
  'id' | 'source' | 'revision' | 'revisionNumber' | 'enabled' | 'archivedAt' | 'createdAt' | 'updatedAt'
>;
export type ManagedProfileCreate = Omit<ManagedProfileWrite, 'supportedInvocations'> & {
  supportedInvocations?: AgentProfileInvocation[];
};
export type BuiltinProfileSettingsWrite = {
  enabled?: boolean;
  defaultModel?: string | null;
  defaultReasoningLevel?: string | null;
};
export type TenantAgentProfileConfigurationView = {
  configuredProfileId: string | null;
  effectiveProfileId: string | null;
  updatedByUserId?: string;
  updatedAt?: Date;
};
export class AgentProfileError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'immutable_builtin'
      | 'name_collision'
      | 'invalid'
      | 'incompatible'
      | 'conflict'
      | 'in_use',
    message: string,
  ) {
    super(message);
  }
}

export class AgentProfileService {
  constructor(private readonly store: AgentProfileStore & Pick<AutomationStore, 'listAutomations'>) {}
  async list(): Promise<AgentProfileDefinition[]> {
    const [settings, managed] = await Promise.all([
      this.store.listBuiltinAgentProfileSettings(),
      this.store.listAgentProfiles(),
    ]);
    const settingsById = new Map(settings.map((setting) => [setting.profileId, setting]));
    return [
      ...builtinAgentProfiles.map((profile) => applyBuiltinSettings(profile, settingsById.get(profile.id))),
      ...managed.map(definition),
    ];
  }
  async get(id: string): Promise<AgentProfileDefinition | null> {
    const builtin = builtinAgentProfile(id);
    if (builtin) {
      const setting = (await this.store.listBuiltinAgentProfileSettings()).find((value) => value.profileId === id);
      return applyBuiltinSettings(builtin, setting);
    }
    const managed = await this.store.getAgentProfile(id);
    return managed ? definition(managed) : null;
  }
  async resolve(id: string, invocation: AgentProfileInvocation): Promise<AgentProfileDefinition> {
    const profile = await this.get(id);
    if (!profile || profile.archivedAt || !profile.enabled)
      throw new AgentProfileError('not_found', `Agent profile not found: ${id}`);
    if (!profile.supportedInvocations.includes(invocation))
      throw new AgentProfileError('incompatible', `Agent profile ${id} does not support ${invocation} invocation`);
    return profile;
  }
  async getTenantConfiguration(): Promise<TenantAgentProfileConfigurationView> {
    const configuration = await this.store.getTenantAgentProfileConfiguration();
    const configuredProfileId = configuration?.defaultProfileId ?? null;
    const effectiveProfileId = await this.effectiveDefault(configuredProfileId);
    return {
      configuredProfileId,
      effectiveProfileId,
      ...(configuration?.updatedByUserId ? { updatedByUserId: configuration.updatedByUserId } : {}),
      ...(configuration ? { updatedAt: configuration.updatedAt } : {}),
    };
  }
  async setTenantDefault(profileId: string | null, actorUserId?: string): Promise<TenantAgentProfileConfigurationView> {
    if (profileId !== null) {
      try {
        await this.resolve(profileId, 'agent');
      } catch (error) {
        if (!isUnavailable(error)) throw error;
        throw new AgentProfileError('invalid', 'defaultProfileId must reference an enabled, unarchived agent profile');
      }
    }
    await this.store.setTenantAgentProfileConfiguration({
      defaultProfileId: profileId,
      ...(actorUserId ? { updatedByUserId: actorUserId } : {}),
      updatedAt: new Date(),
    });
    return this.getTenantConfiguration();
  }
  async effectiveDefault(configuredId?: string | null): Promise<string | null> {
    const configured =
      configuredId === undefined
        ? (await this.store.getTenantAgentProfileConfiguration())?.defaultProfileId
        : configuredId;
    if (configured) {
      try {
        return (await this.resolve(configured, 'agent')).id;
      } catch (error) {
        if (!isUnavailable(error)) throw error;
      }
    }
    return selectEffectiveDefault(await this.list());
  }
  async snapshot(
    id: string,
    invocation: AgentProfileInvocation,
    overrides: {
      model?: string | null;
      reasoningLevel?: string | null;
    } = {},
  ): Promise<AppliedAgentProfileSnapshot> {
    return snapshotFromProfile(await this.resolve(id, invocation), overrides);
  }
  async executionContext(
    id: string,
    invocation: AgentProfileInvocation,
    overrides: {
      model?: string | null;
      reasoningLevel?: string | null;
    } = {},
  ): Promise<AgentProfileExecutionContext> {
    return executionContextFromSnapshot(await this.snapshot(id, invocation, overrides));
  }
  async resolveRuntimeProfile(id: string, invocation: AgentProfileInvocation): Promise<RuntimeAgentProfile> {
    return runtimeProfile(await this.resolve(id, invocation));
  }
  async listRuntimeProfiles(invocation: AgentProfileInvocation): Promise<RuntimeAgentProfile[]> {
    return (await this.list())
      .filter((profile) => profile.enabled && !profile.archivedAt && profile.supportedInvocations.includes(invocation))
      .map(runtimeProfile);
  }
  async create(input: ManagedProfileCreate, actorUserId?: string): Promise<AgentProfileDefinition> {
    const normalized = normalizeWrite(input);
    this.validate(normalized);
    const now = new Date();
    await this.assertNameAvailable(normalized.name);
    const revisionId = randomUUID();
    try {
      return definition(
        await this.store.createAgentProfile({
          id: randomUUID(),
          name: normalized.name,
          revision: {
            ...normalized,
            id: revisionId,
            ...(actorUserId ? { actorType: 'user' as const, actorUserId } : { actorType: 'system' as const }),
            createdAt: now,
          },
          enabled: true,
          ...(actorUserId ? { createdByUserId: actorUserId } : {}),
          createdAt: now,
          updatedAt: now,
        }),
      );
    } catch (error) {
      translate(error);
    }
  }
  async updateBuiltinSettings(
    id: string,
    input: BuiltinProfileSettingsWrite,
    actorUserId?: string,
  ): Promise<AgentProfileDefinition> {
    const builtin = builtinAgentProfile(id);
    if (!builtin) throw new AgentProfileError('not_found', `Built-in agent profile not found: ${id}`);
    const defaultModel = settingValue(input, 'defaultModel', undefined);
    const defaultReasoningLevel = settingValue(input, 'defaultReasoningLevel', undefined);
    if (defaultModel !== undefined && !defaultModel.trim())
      throw new AgentProfileError('invalid', 'defaultModel must not be empty');
    if (
      defaultReasoningLevel !== undefined &&
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(defaultReasoningLevel)
    )
      throw new AgentProfileError('invalid', 'defaultReasoningLevel is invalid');
    if (input.enabled === false) await this.assertNotUsedByActiveAutomations(id);
    const setting = await this.store.setBuiltinAgentProfileSettings({
      profileId: id,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(Object.hasOwn(input, 'defaultModel') ? { defaultModel: defaultModel?.trim() ?? null } : {}),
      ...(Object.hasOwn(input, 'defaultReasoningLevel')
        ? { defaultReasoningLevel: defaultReasoningLevel ?? null }
        : {}),
      updatedAt: new Date(),
      ...(actorUserId ? { updatedByUserId: actorUserId } : {}),
    });
    return applyBuiltinSettings(builtin, setting);
  }
  async update(
    id: string,
    expectedRevision: string,
    input: ManagedProfileWrite,
    actorUserId?: string,
  ): Promise<AgentProfileDefinition> {
    this.mutable(id);
    input = normalizeWrite(input);
    this.validate(input);
    await this.assertNameAvailable(input.name, id);
    const existing = await this.store.getAgentProfile(id);
    if (!existing) return this.missing(id);
    if (existing.supportedInvocations.includes('agent') && !input.supportedInvocations.includes('agent'))
      await this.assertNotUsedByActiveAutomations(id);
    try {
      return definition(
        await this.store.updateAgentProfile({
          id,
          expectedCurrentRevisionId: expectedRevision,
          revision: {
            ...input,
            id: randomUUID(),
            ...(actorUserId ? { actorType: 'user' as const, actorUserId } : { actorType: 'system' as const }),
            createdAt: new Date(),
          },
          enabled: existing.enabled,
          updatedAt: new Date(),
        }),
      );
    } catch (error) {
      translate(error);
    }
  }
  async listRevisions(id: string) {
    this.mutable(id);
    if (!(await this.store.getAgentProfile(id))) return this.missing(id);
    return (await this.store.listAgentProfileRevisions(id)).map(revisionDefinition);
  }
  async archive(id: string) {
    this.mutable(id);
    if (!(await this.store.getAgentProfile(id))) return this.missing(id);
    await this.assertNotUsedByActiveAutomations(id);
    try {
      return definition((await this.store.archiveAgentProfile({ id, archivedAt: new Date() })) ?? this.missing(id));
    } catch (error) {
      translate(error);
    }
  }
  async restore(id: string) {
    this.mutable(id);
    try {
      return definition((await this.store.restoreAgentProfile({ id, updatedAt: new Date() })) ?? this.missing(id));
    } catch (error) {
      translate(error);
    }
  }
  private mutable(id: string) {
    if (id.startsWith('builtin:'))
      throw new AgentProfileError('immutable_builtin', 'Built-in agent profiles are immutable');
  }
  private missing(id: string): never {
    throw new AgentProfileError('not_found', `Agent profile not found: ${id}`);
  }
  private validate(input: ManagedProfileWrite) {
    if (!input.name?.trim() || !input.description?.trim() || !input.instructions?.trim())
      throw new AgentProfileError('invalid', 'name, description, and instructions are required');
    if (builtinAgentProfiles.some((x) => x.name.toLowerCase() === input.name.trim().toLowerCase()))
      throw new AgentProfileError('name_collision', 'Managed profile name collides with a built-in profile');
    if (
      !input.supportedInvocations?.length ||
      input.supportedInvocations.some((x) => !['agent', 'subagent'].includes(x))
    )
      throw new AgentProfileError('invalid', 'supportedInvocations must contain a supported mode');
    if (
      input.defaultReasoningLevel !== undefined &&
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.defaultReasoningLevel)
    )
      throw new AgentProfileError('invalid', 'defaultReasoningLevel is invalid');
  }
  private async assertNameAvailable(name: string, except?: string) {
    const collision = (await this.store.listAgentProfiles()).some(
      (x) => x.id !== except && !x.archivedAt && x.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (collision) throw new AgentProfileError('name_collision', 'Agent profile name already exists');
  }
  private async assertNotUsedByActiveAutomations(id: string): Promise<void> {
    const automations = (await this.store.listAutomations()).filter(
      (automation) => automation.profileId === id && automation.enabled && !automation.archivedAt,
    );
    if (!automations.length) return;
    const examples = automations
      .slice(0, 3)
      .map((automation) => `${automation.name} (${automation.id})`)
      .join(', ');
    const remainder = automations.length > 3 ? `, and ${automations.length - 3} more` : '';
    throw new AgentProfileError(
      'in_use',
      `Agent profile is used by ${automations.length} active automation${automations.length === 1 ? '' : 's'}: ${examples}${remainder}. Disable or update the automations before making this profile unavailable.`,
    );
  }
}

export function executionContextFromSnapshot(snapshot: AppliedAgentProfileSnapshot): AgentProfileExecutionContext {
  return {
    agentProfileSnapshot: snapshot,
    ...(snapshot.model ? { model: snapshot.model } : {}),
    ...(snapshot.reasoningLevel ? { reasoningLevel: snapshot.reasoningLevel } : {}),
  };
}

export function overrideAgentProfileSnapshot(
  snapshot: AppliedAgentProfileSnapshot,
  overrides: { model?: string | null; reasoningLevel?: string | null },
): AppliedAgentProfileSnapshot {
  const { hash: _hash, model, reasoningLevel, ...values } = snapshot;
  const effectiveModel = Object.hasOwn(overrides, 'model') ? (overrides.model ?? undefined) : model;
  const effectiveReasoningLevel = Object.hasOwn(overrides, 'reasoningLevel')
    ? (overrides.reasoningLevel ?? undefined)
    : reasoningLevel;
  return snapshotWithHash({
    ...values,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(effectiveReasoningLevel ? { reasoningLevel: effectiveReasoningLevel } : {}),
  });
}

function snapshotWithHash(snapshot: Omit<AppliedAgentProfileSnapshot, 'hash'>): AppliedAgentProfileSnapshot {
  return { ...snapshot, hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}
function snapshotFromProfile(
  profile: AgentProfileDefinition,
  overrides: { model?: string | null; reasoningLevel?: string | null } = {},
): AppliedAgentProfileSnapshot {
  const model = Object.hasOwn(overrides, 'model') ? (overrides.model ?? undefined) : profile.defaultModel;
  const reasoningLevel = Object.hasOwn(overrides, 'reasoningLevel')
    ? (overrides.reasoningLevel ?? undefined)
    : profile.defaultReasoningLevel;
  return snapshotWithHash({
    profileId: profile.id,
    source: profile.source,
    revision: profile.revision,
    instructions: profile.instructions,
    ...(model ? { model } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    supportedInvocations: profile.supportedInvocations,
  });
}
function runtimeProfile(profile: AgentProfileDefinition): RuntimeAgentProfile {
  const snapshot = snapshotFromProfile(profile);
  return {
    id: snapshot.profileId,
    name: profile.name,
    source: snapshot.source,
    revision: snapshot.revision,
    hash: snapshot.hash,
    description: profile.description,
    instructions: snapshot.instructions,
    ...(snapshot.model ? { model: snapshot.model } : {}),
    ...(snapshot.reasoningLevel ? { reasoningLevel: snapshot.reasoningLevel } : {}),
  };
}
function isUnavailable(error: unknown): error is AgentProfileError {
  return error instanceof AgentProfileError && ['not_found', 'incompatible'].includes(error.code);
}
function usableProfile(profile: AgentProfileDefinition) {
  return profile.enabled && !profile.archivedAt && profile.supportedInvocations.includes('agent');
}
function selectEffectiveDefault(profiles: AgentProfileDefinition[]) {
  const usable = profiles.filter(usableProfile);
  return usable.find((profile) => profile.id === 'builtin:general')?.id ?? usable[0]?.id ?? null;
}
function normalizeWrite(input: ManagedProfileCreate): ManagedProfileWrite {
  return {
    ...input,
    name: input.name.trim(),
    description: input.description.trim(),
    instructions: input.instructions.trim(),
    supportedInvocations: input.supportedInvocations ?? ['agent', 'subagent'],
  };
}
function definition(p: AgentProfileRecord): AgentProfileDefinition {
  return { ...p, source: 'managed', revision: p.currentRevisionId, revisionNumber: p.currentRevisionNumber };
}
function revisionDefinition(p: AgentProfileRevisionRecord): AgentProfileDefinition {
  return { ...p, id: p.profileId, source: 'managed', revision: p.id, enabled: true, updatedAt: p.createdAt };
}
function applyBuiltinSettings(
  profile: AgentProfileDefinition,
  setting: BuiltinAgentProfileSettingRecord | undefined,
): AgentProfileDefinition {
  if (!setting) return profile;
  const { defaultModel: _, defaultReasoningLevel: __, ...base } = profile;
  return {
    ...base,
    enabled: setting.enabled,
    ...(setting.defaultModel ? { defaultModel: setting.defaultModel } : {}),
    ...(setting.defaultReasoningLevel ? { defaultReasoningLevel: setting.defaultReasoningLevel } : {}),
    updatedAt: setting.updatedAt,
  };
}
function settingValue(
  input: BuiltinProfileSettingsWrite,
  key: 'defaultModel' | 'defaultReasoningLevel',
  current: string | undefined,
): string | undefined {
  if (!Object.hasOwn(input, key)) return current;
  return input[key] ?? undefined;
}
function translate(error: unknown): never {
  if (error instanceof StoreConflictError)
    throw new AgentProfileError(
      error.code === 'not_found'
        ? 'not_found'
        : error.code === 'agent_profile_name_exists'
          ? 'name_collision'
          : 'conflict',
      error.message,
    );
  throw error;
}
