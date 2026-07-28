import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  StoreConflictError,
  type AgentProfileRecord,
  type AgentProfileRevisionRecord,
  type AgentProfileStore,
  type BuiltinAgentProfileSettingWrite,
  type CreateAgentProfileRecord,
  type TenantAgentProfileConfigurationWrite,
  type UpdateAgentProfileRecord,
} from '../types.js';
type Row = QueryResultRow & {
  id: string;
  name: string;
  description: string;
  instructions: string;
  current_revision_id: string;
  current_revision_number: number | string;
  enabled: boolean;
  default_model: string | null;
  default_reasoning_level: string | null;
  supported_invocations: AgentProfileRecord['supportedInvocations'];
  created_by_user_id: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
type RevisionRow = QueryResultRow & {
  id: string;
  profile_id: string;
  revision_number: number | string;
  name: string;
  description: string;
  instructions: string;
  default_model: string | null;
  default_reasoning_level: string | null;
  supported_invocations: AgentProfileRecord['supportedInvocations'];
  actor_type: 'user' | 'system';
  actor_user_id: string | null;
  created_at: Date;
};
const columns =
  'p.id,r.name,r.description,r.instructions,p.current_revision_id,p.current_revision_number,p.enabled,r.default_model,r.default_reasoning_level,r.supported_invocations,p.created_by_user_id,p.archived_at,p.created_at,p.updated_at';
export class PostgresAgentProfileStore implements AgentProfileStore {
  constructor(private pool: Pool) {}
  async getTenantAgentProfileConfiguration() {
    const result = await this.pool.query<ConfigurationRow>(
      'SELECT default_profile_id,updated_by_user_id,updated_at FROM tenant_agent_profile_configuration WHERE singleton=true',
    );
    return result.rows[0] ? configurationRecord(result.rows[0]) : null;
  }
  async setTenantAgentProfileConfiguration(input: TenantAgentProfileConfigurationWrite) {
    const result = await this.pool.query<ConfigurationRow>(
      'INSERT INTO tenant_agent_profile_configuration(singleton,default_profile_id,updated_by_user_id,updated_at) VALUES(true,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET default_profile_id=EXCLUDED.default_profile_id,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at RETURNING default_profile_id,updated_by_user_id,updated_at',
      [input.defaultProfileId, input.updatedByUserId ?? null, input.updatedAt],
    );
    return configurationRecord(result.rows[0]!);
  }
  async listBuiltinAgentProfileSettings() {
    const result = await this.pool.query<{
      profile_id: string;
      enabled: boolean;
      default_model: string | null;
      default_reasoning_level: string | null;
      updated_by_user_id: string | null;
      updated_at: Date;
    }>(
      'SELECT profile_id,enabled,default_model,default_reasoning_level,updated_by_user_id,updated_at FROM builtin_agent_profile_settings',
    );
    return result.rows.map((row) => ({
      profileId: row.profile_id,
      enabled: row.enabled,
      ...(row.default_model ? { defaultModel: row.default_model } : {}),
      ...(row.default_reasoning_level ? { defaultReasoningLevel: row.default_reasoning_level } : {}),
      updatedAt: row.updated_at,
      ...(row.updated_by_user_id ? { updatedByUserId: row.updated_by_user_id } : {}),
    }));
  }
  async setBuiltinAgentProfileSettings(input: BuiltinAgentProfileSettingWrite) {
    const result = await this.pool.query<{
      profile_id: string;
      enabled: boolean;
      default_model: string | null;
      default_reasoning_level: string | null;
      updated_by_user_id: string | null;
      updated_at: Date;
    }>(
      'INSERT INTO builtin_agent_profile_settings(profile_id,enabled,default_model,default_reasoning_level,updated_by_user_id,updated_at) VALUES($1,$2,$4,$6,$8,$9) ON CONFLICT(profile_id) DO UPDATE SET enabled=CASE WHEN $3 THEN EXCLUDED.enabled ELSE builtin_agent_profile_settings.enabled END,default_model=CASE WHEN $5 THEN EXCLUDED.default_model ELSE builtin_agent_profile_settings.default_model END,default_reasoning_level=CASE WHEN $7 THEN EXCLUDED.default_reasoning_level ELSE builtin_agent_profile_settings.default_reasoning_level END,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at RETURNING profile_id,enabled,default_model,default_reasoning_level,updated_by_user_id,updated_at',
      [
        input.profileId,
        input.enabled ?? true,
        Object.hasOwn(input, 'enabled'),
        input.defaultModel ?? null,
        Object.hasOwn(input, 'defaultModel'),
        input.defaultReasoningLevel ?? null,
        Object.hasOwn(input, 'defaultReasoningLevel'),
        input.updatedByUserId ?? null,
        input.updatedAt,
      ],
    );
    const row = result.rows[0]!;
    return {
      profileId: row.profile_id,
      enabled: row.enabled,
      ...(row.default_model ? { defaultModel: row.default_model } : {}),
      ...(row.default_reasoning_level ? { defaultReasoningLevel: row.default_reasoning_level } : {}),
      updatedAt: row.updated_at,
      ...(row.updated_by_user_id ? { updatedByUserId: row.updated_by_user_id } : {}),
    };
  }
  async createAgentProfile(input: CreateAgentProfileRecord) {
    try {
      return await this.tx(async (c) => {
        await c.query(
          'INSERT INTO agent_profiles(id,name,current_revision_id,current_revision_number,enabled,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,1,$4,$5,$6,$7)',
          [
            input.id,
            input.name,
            input.revision.id,
            input.enabled,
            input.createdByUserId ?? null,
            input.createdAt,
            input.updatedAt,
          ],
        );
        await insertRevision(c, { ...input.revision, profileId: input.id, revisionNumber: 1 });
        return required(await get(c, input.id));
      });
    } catch (e) {
      conflict(e);
    }
  }
  async getAgentProfile(id: string) {
    return get(this.pool, id);
  }
  async listAgentProfiles() {
    const result = await this.pool.query<Row>(
      `SELECT ${columns} FROM agent_profiles p JOIN agent_profile_revisions r ON r.id=p.current_revision_id ORDER BY p.created_at,p.id`,
    );
    return result.rows.map(toRecord);
  }
  async listAgentProfileRevisions(id: string) {
    const result = await this.pool.query<RevisionRow>(
      'SELECT * FROM agent_profile_revisions WHERE profile_id=$1 ORDER BY revision_number DESC',
      [id],
    );
    return result.rows.map(toRevision);
  }
  async updateAgentProfile(input: UpdateAgentProfileRecord) {
    try {
      return await this.tx(async (c) => {
        const lock = await c.query<{
          current_revision_id: string;
          current_revision_number: number | string;
          enabled: boolean;
          archived_at: Date | null;
        }>(
          'SELECT current_revision_id,current_revision_number,enabled,archived_at FROM agent_profiles WHERE id=$1 FOR UPDATE',
          [input.id],
        );
        const old = lock.rows[0];
        if (!old) throw new StoreConflictError('not_found', 'Agent profile not found');
        if (old.archived_at)
          throw new StoreConflictError('agent_profile_archived', 'Restore this profile before editing it');
        if (old.current_revision_id !== input.expectedCurrentRevisionId)
          throw new StoreConflictError(
            'agent_profile_update_conflict',
            'The profile changed while it was being edited',
          );
        const revision = {
          ...input.revision,
          profileId: input.id,
          revisionNumber: Number(old.current_revision_number) + 1,
        };
        await insertRevision(c, revision);
        await c.query(
          'UPDATE agent_profiles SET name=$2,current_revision_id=$3,current_revision_number=$4,enabled=$5,updated_at=$6 WHERE id=$1',
          [
            input.id,
            revision.name,
            revision.id,
            revision.revisionNumber,
            input.enabled ?? old.enabled,
            input.updatedAt,
          ],
        );
        return required(await get(c, input.id));
      });
    } catch (e) {
      conflict(e);
    }
  }
  async archiveAgentProfile(input: { id: string; archivedAt: Date }) {
    const r = await this.pool.query(
      'UPDATE agent_profiles SET archived_at=COALESCE(archived_at,$2),updated_at=$2 WHERE id=$1 RETURNING id',
      [input.id, input.archivedAt],
    );
    return r.rows[0] ? this.getAgentProfile(input.id) : null;
  }
  async restoreAgentProfile(input: { id: string; updatedAt: Date }) {
    try {
      const r = await this.pool.query(
        'UPDATE agent_profiles SET archived_at=NULL,updated_at=$2 WHERE id=$1 RETURNING id',
        [input.id, input.updatedAt],
      );
      return r.rows[0] ? this.getAgentProfile(input.id) : null;
    } catch (e) {
      conflict(e);
    }
  }
  private async tx<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const value = await fn(c);
      await c.query('COMMIT');
      return value;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}
type ConfigurationRow = QueryResultRow & {
  default_profile_id: string | null;
  updated_by_user_id: string | null;
  updated_at: Date;
};
function configurationRecord(row: ConfigurationRow) {
  return {
    ...(row.default_profile_id !== null ? { defaultProfileId: row.default_profile_id } : {}),
    ...(row.updated_by_user_id ? { updatedByUserId: row.updated_by_user_id } : {}),
    updatedAt: row.updated_at,
  };
}
async function insertRevision(c: PoolClient, r: AgentProfileRevisionRecord) {
  await c.query(
    'INSERT INTO agent_profile_revisions(id,profile_id,revision_number,name,description,instructions,default_model,default_reasoning_level,supported_invocations,actor_type,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      r.id,
      r.profileId,
      r.revisionNumber,
      r.name,
      r.description,
      r.instructions,
      r.defaultModel ?? null,
      r.defaultReasoningLevel ?? null,
      r.supportedInvocations,
      r.actorType,
      r.actorUserId ?? null,
      r.createdAt,
    ],
  );
}
async function get(q: Pick<Pool, 'query'>, id: string) {
  const r = await q.query<Row>(
    `SELECT ${columns} FROM agent_profiles p JOIN agent_profile_revisions r ON r.id=p.current_revision_id WHERE p.id=$1`,
    [id],
  );
  return r.rows[0] ? toRecord(r.rows[0]) : null;
}
function toRecord(r: Row): AgentProfileRecord {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    instructions: r.instructions,
    currentRevisionId: r.current_revision_id,
    currentRevisionNumber: Number(r.current_revision_number),
    enabled: r.enabled,
    supportedInvocations: r.supported_invocations,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.default_model ? { defaultModel: r.default_model } : {}),
    ...(r.default_reasoning_level ? { defaultReasoningLevel: r.default_reasoning_level } : {}),
    ...(r.created_by_user_id ? { createdByUserId: r.created_by_user_id } : {}),
    ...(r.archived_at ? { archivedAt: r.archived_at } : {}),
  };
}
function toRevision(r: RevisionRow): AgentProfileRevisionRecord {
  return {
    id: r.id,
    profileId: r.profile_id,
    revisionNumber: Number(r.revision_number),
    name: r.name,
    description: r.description,
    instructions: r.instructions,
    supportedInvocations: r.supported_invocations,
    actorType: r.actor_type,
    createdAt: r.created_at,
    ...(r.actor_user_id ? { actorUserId: r.actor_user_id } : {}),
    ...(r.default_model ? { defaultModel: r.default_model } : {}),
    ...(r.default_reasoning_level ? { defaultReasoningLevel: r.default_reasoning_level } : {}),
  };
}
function required(v: AgentProfileRecord | null) {
  if (!v) throw new Error('Agent profile write failed');
  return v;
}
function conflict(e: unknown): never {
  if (e instanceof StoreConflictError) throw e;
  if ((e as { code?: string }).code === '23505')
    throw new StoreConflictError('agent_profile_name_exists', 'Agent profile name already exists');
  throw e;
}
