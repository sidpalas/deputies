import {
  StoreConflictError,
  type AgentProfileRecord,
  type AgentProfileRevisionRecord,
  type AgentProfileStore,
  type BuiltinAgentProfileSettingRecord,
  type BuiltinAgentProfileSettingWrite,
  type CreateAgentProfileRecord,
  type TenantAgentProfileConfigurationRecord,
  type TenantAgentProfileConfigurationWrite,
  type UpdateAgentProfileRecord,
} from './types.js';

export class MemoryAgentProfileStore implements AgentProfileStore {
  private profiles = new Map<string, AgentProfileRecord>();
  private revisions = new Map<string, AgentProfileRevisionRecord[]>();
  private builtinSettings = new Map<string, BuiltinAgentProfileSettingRecord>();
  private configuration: TenantAgentProfileConfigurationRecord | null = null;
  async getTenantAgentProfileConfiguration() {
    return this.configuration ? structuredClone(this.configuration) : null;
  }
  async setTenantAgentProfileConfiguration(input: TenantAgentProfileConfigurationWrite) {
    const configuration: TenantAgentProfileConfigurationRecord = {
      ...(input.defaultProfileId !== null ? { defaultProfileId: input.defaultProfileId } : {}),
      ...(input.updatedByUserId ? { updatedByUserId: input.updatedByUserId } : {}),
      updatedAt: input.updatedAt,
    };
    this.configuration = structuredClone(configuration);
    return structuredClone(configuration);
  }
  async listBuiltinAgentProfileSettings() {
    return structuredClone([...this.builtinSettings.values()]);
  }
  async setBuiltinAgentProfileSettings(input: BuiltinAgentProfileSettingWrite) {
    const current = this.builtinSettings.get(input.profileId);
    const setting: BuiltinAgentProfileSettingRecord = {
      profileId: input.profileId,
      enabled: input.enabled ?? current?.enabled ?? true,
      updatedAt: input.updatedAt,
      ...(input.updatedByUserId ? { updatedByUserId: input.updatedByUserId } : {}),
      ...(Object.hasOwn(input, 'defaultModel')
        ? input.defaultModel
          ? { defaultModel: input.defaultModel }
          : {}
        : current?.defaultModel
          ? { defaultModel: current.defaultModel }
          : {}),
      ...(Object.hasOwn(input, 'defaultReasoningLevel')
        ? input.defaultReasoningLevel
          ? { defaultReasoningLevel: input.defaultReasoningLevel }
          : {}
        : current?.defaultReasoningLevel
          ? { defaultReasoningLevel: current.defaultReasoningLevel }
          : {}),
    };
    this.builtinSettings.set(input.profileId, structuredClone(setting));
    return structuredClone(setting);
  }
  async createAgentProfile(input: CreateAgentProfileRecord) {
    this.available(input.name);
    const revision = { ...input.revision, profileId: input.id, revisionNumber: 1 };
    const profile = toCurrent(input, revision);
    this.profiles.set(input.id, profile);
    this.revisions.set(input.id, [revision]);
    return structuredClone(profile);
  }
  async getAgentProfile(id: string) {
    const value = this.profiles.get(id);
    return value ? structuredClone(value) : null;
  }
  async listAgentProfiles() {
    return [...this.profiles.values()].map((value) => structuredClone(value));
  }
  async listAgentProfileRevisions(id: string) {
    return structuredClone([...(this.revisions.get(id) ?? [])].reverse());
  }
  async updateAgentProfile(input: UpdateAgentProfileRecord) {
    const old = this.profiles.get(input.id);
    if (!old) throw new StoreConflictError('not_found', 'Agent profile not found');
    if (old.archivedAt)
      throw new StoreConflictError('agent_profile_archived', 'Restore this profile before editing it');
    if (old.currentRevisionId !== input.expectedCurrentRevisionId)
      throw new StoreConflictError('agent_profile_update_conflict', 'The profile changed while it was being edited');
    this.available(input.revision.name, input.id);
    const revision = { ...input.revision, profileId: input.id, revisionNumber: old.currentRevisionNumber + 1 };
    const profile = {
      id: input.id,
      name: revision.name,
      description: revision.description,
      instructions: revision.instructions,
      currentRevisionId: revision.id,
      currentRevisionNumber: revision.revisionNumber,
      enabled: input.enabled ?? old.enabled,
      supportedInvocations: revision.supportedInvocations,
      createdAt: old.createdAt,
      updatedAt: input.updatedAt,
      ...(old.createdByUserId ? { createdByUserId: old.createdByUserId } : {}),
      ...(revision.defaultModel ? { defaultModel: revision.defaultModel } : {}),
      ...(revision.defaultReasoningLevel ? { defaultReasoningLevel: revision.defaultReasoningLevel } : {}),
    };
    this.revisions.get(input.id)!.push(revision);
    this.profiles.set(input.id, profile);
    return structuredClone(profile);
  }
  async archiveAgentProfile(input: { id: string; archivedAt: Date }) {
    const old = this.profiles.get(input.id);
    if (!old) return null;
    const value = { ...old, archivedAt: old.archivedAt ?? input.archivedAt, updatedAt: input.archivedAt };
    this.profiles.set(input.id, value);
    return structuredClone(value);
  }
  async restoreAgentProfile(input: { id: string; updatedAt: Date }) {
    const old = this.profiles.get(input.id);
    if (!old) return null;
    this.available(old.name, old.id);
    const { archivedAt: _, ...base } = old;
    const value = { ...base, updatedAt: input.updatedAt };
    this.profiles.set(input.id, value);
    return structuredClone(value);
  }
  private available(name: string, except?: string) {
    if (
      [...this.profiles.values()].some(
        (x) => x.id !== except && !x.archivedAt && x.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new StoreConflictError('agent_profile_name_exists', 'Agent profile name already exists');
  }
}
function toCurrent(input: CreateAgentProfileRecord, revision: AgentProfileRevisionRecord): AgentProfileRecord {
  return {
    id: input.id,
    name: revision.name,
    description: revision.description,
    instructions: revision.instructions,
    currentRevisionId: revision.id,
    currentRevisionNumber: 1,
    enabled: input.enabled,
    supportedInvocations: revision.supportedInvocations,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
    ...(revision.defaultModel ? { defaultModel: revision.defaultModel } : {}),
    ...(revision.defaultReasoningLevel ? { defaultReasoningLevel: revision.defaultReasoningLevel } : {}),
  };
}
