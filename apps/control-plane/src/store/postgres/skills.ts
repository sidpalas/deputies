import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { StoreConflictError } from '../types.js';
import type {
  AuditActorType,
  CreateSkillRecord,
  SkillRecord,
  SkillRevisionRecord,
  SkillRevisionSelection,
  SkillRunCandidate,
  SkillStore,
  UpdateSkillRecord,
} from '../types.js';
type PgInteger = number | string;
type SkillRow = QueryResultRow & {
  id: string;
  name: string;
  description: string;
  body: string;
  current_revision_id: string;
  current_revision_number: PgInteger;
  auto_load: boolean;
  enabled: boolean;
  scope: 'tenant' | 'personal';
  owner_user_id: string | null;
  created_by_user_id: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
type RevisionRow = QueryResultRow & {
  id: string;
  skill_id: string;
  revision_number: PgInteger;
  name: string;
  description: string;
  body: string;
  actor_type: AuditActorType;
  actor_user_id: string | null;
  created_at: Date;
};
const columns =
  'skills.id, current_revision.name, current_revision.description, current_revision.body, skills.current_revision_id, skills.current_revision_number, skills.auto_load, skills.enabled, skills.scope, skills.owner_user_id, skills.created_by_user_id, skills.archived_at, skills.created_at, skills.updated_at';
const joined = `FROM skills JOIN skill_revisions current_revision ON current_revision.id = skills.current_revision_id`;

export class PostgresSkillStore implements SkillStore {
  constructor(private readonly pool: Pool) {}
  async createSkill(record: CreateSkillRecord): Promise<SkillRecord> {
    try {
      return await this.transaction(async (client) => {
        const revision: SkillRevisionRecord = { ...record.revision, skillId: record.id, revisionNumber: 1 };
        await client.query(
          `INSERT INTO skills (id, scope, owner_user_id, name, current_revision_id, current_revision_number, auto_load, enabled, created_by_user_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10)`,
          [
            record.id,
            record.scope,
            record.ownerUserId ?? null,
            revision.name,
            revision.id,
            record.scope === 'personal' ? false : (record.autoLoad ?? true),
            record.enabled ?? true,
            record.createdByUserId ?? null,
            record.createdAt,
            record.updatedAt,
          ],
        );
        await insertRevision(client, revision);
        return requireSkill(await getWithClient(client, record.id), record.id);
      });
    } catch (error) {
      throwNameConflict(error);
    }
  }
  async getSkill(id: string): Promise<SkillRecord | null> {
    const result = await this.pool.query<SkillRow>(`SELECT ${columns} ${joined} WHERE skills.id=$1`, [id]);
    return result.rows[0] ? toSkill(result.rows[0]) : null;
  }
  async listSkills(input: { userId?: string }): Promise<SkillRecord[]> {
    const result = await this.pool.query<SkillRow>(
      `SELECT ${columns} ${joined} WHERE skills.scope='tenant' OR skills.owner_user_id=$1 ORDER BY skills.created_at, skills.id`,
      [input.userId ?? null],
    );
    return result.rows.map(toSkill);
  }
  async listSkillRevisions(skillId: string): Promise<SkillRevisionRecord[]> {
    const result = await this.pool.query<RevisionRow>(
      'SELECT id, skill_id, revision_number, name, description, body, actor_type, actor_user_id, created_at FROM skill_revisions WHERE skill_id=$1 ORDER BY revision_number DESC',
      [skillId],
    );
    return result.rows.map(toRevision);
  }
  async updateSkill(input: UpdateSkillRecord): Promise<SkillRecord> {
    try {
      return await this.transaction(async (client) => {
        const locked = await client.query<{
          archived_at: Date | null;
          current_revision_id: string;
          current_revision_number: PgInteger;
          scope: 'tenant' | 'personal';
        }>('SELECT archived_at,current_revision_id,current_revision_number,scope FROM skills WHERE id=$1 FOR UPDATE', [
          input.id,
        ]);
        const existing = locked.rows[0];
        if (!existing) throw new Error(`Skill does not exist: ${input.id}`);
        if (existing.archived_at)
          throw new StoreConflictError('skill_archived', 'Restore this skill before editing it');
        if (input.revision && existing.current_revision_id !== input.expectedCurrentRevisionId)
          throw new StoreConflictError('skill_update_conflict', 'The skill changed while it was being edited');
        const updates = ['updated_at=$2'];
        const values: unknown[] = [input.id, input.updatedAt];
        const add = (column: string, value: unknown) => {
          values.push(value);
          updates.push(`${column}=$${values.length}`);
        };
        if (input.revision) {
          const revision = {
            ...input.revision,
            skillId: input.id,
            revisionNumber: Number(existing.current_revision_number) + 1,
          };
          await insertRevision(client, revision);
          add('name', revision.name);
          add('current_revision_id', revision.id);
          add('current_revision_number', revision.revisionNumber);
        }
        if (input.autoLoad !== undefined) add('auto_load', existing.scope === 'personal' ? false : input.autoLoad);
        if (input.enabled !== undefined) add('enabled', input.enabled);
        await client.query(`UPDATE skills SET ${updates.join(',')} WHERE id=$1`, values);
        return requireSkill(await getWithClient(client, input.id), input.id);
      });
    } catch (error) {
      throwNameConflict(error);
    }
  }
  async archiveSkill(input: { skillId: string; archivedAt: Date }): Promise<SkillRecord | null> {
    const result = await this.pool.query(
      'UPDATE skills SET archived_at=COALESCE(archived_at,$2),updated_at=$2 WHERE id=$1 RETURNING id',
      [input.skillId, input.archivedAt],
    );
    return result.rows[0] ? this.getSkill(input.skillId) : null;
  }
  async restoreSkill(input: { skillId: string; updatedAt: Date }): Promise<SkillRecord | null> {
    try {
      const result = await this.pool.query(
        'UPDATE skills SET archived_at=NULL,updated_at=$2 WHERE id=$1 RETURNING id',
        [input.skillId, input.updatedAt],
      );
      return result.rows[0] ? this.getSkill(input.skillId) : null;
    } catch (error) {
      throwNameConflict(error);
    }
  }
  async listSkillInvocationCandidates(input: { userId?: string }): Promise<SkillRunCandidate[]> {
    return this.current(true, [], input.userId);
  }
  async listSkillsForRun(input: {
    userId?: string;
    invokedNames?: string[];
    invokedRevisions?: SkillRevisionSelection[];
  }): Promise<SkillRunCandidate[]> {
    const current = await this.current(false, input.invokedNames ?? [], input.userId);
    const selections = input.invokedRevisions ?? [];
    if (!selections.length) return current;
    const result = await this.pool.query<
      SkillRow & { resolved_revision_id: string; resolved_revision_number: PgInteger }
    >(
      `WITH requested AS (SELECT skill_id,revision_id,position FROM unnest($1::uuid[],$2::uuid[]) WITH ORDINALITY request(skill_id,revision_id,position)) SELECT skills.id, requested_revision.name, requested_revision.description, requested_revision.body, skills.current_revision_id,skills.current_revision_number,skills.auto_load,skills.enabled,skills.scope,skills.owner_user_id,skills.created_by_user_id,skills.archived_at,skills.created_at,skills.updated_at,requested_revision.id resolved_revision_id,requested_revision.revision_number resolved_revision_number FROM requested JOIN skills ON skills.id=requested.skill_id JOIN skill_revisions requested_revision ON requested_revision.id=requested.revision_id AND requested_revision.skill_id=skills.id WHERE skills.enabled AND skills.archived_at IS NULL AND (skills.scope='tenant' OR skills.owner_user_id=$3) ORDER BY requested.position`,
      [selections.map((x) => x.skillId), selections.map((x) => x.revisionId), input.userId ?? null],
    );
    const pinned = result.rows.map((row) => ({
      ...toSkill(row),
      source: 'managed' as const,
      resolvedRevisionId: row.resolved_revision_id,
      resolvedRevisionNumber: Number(row.resolved_revision_number),
    }));
    const seen = new Set<string>();
    return [...current, ...pinned].filter((x) => {
      const key = `${x.id}:${x.resolvedRevisionId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  private async current(all: boolean, names: string[], userId?: string): Promise<SkillRunCandidate[]> {
    const result = await this.pool.query<SkillRow>(
      `SELECT ${columns} ${joined} WHERE skills.enabled AND skills.archived_at IS NULL AND (skills.scope='tenant' OR skills.owner_user_id=$3) AND ($1::boolean OR (skills.scope='tenant' AND skills.auto_load) OR current_revision.name=ANY($2::text[])) ORDER BY skills.created_at,skills.id`,
      [all, names, userId ?? null],
    );
    return result.rows.map((row) => ({
      ...toSkill(row),
      source: 'managed',
      resolvedRevisionId: row.current_revision_id,
      resolvedRevisionNumber: Number(row.current_revision_number),
    }));
  }
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
async function getWithClient(client: PoolClient, id: string) {
  const result = await client.query<SkillRow>(`SELECT ${columns} ${joined} WHERE skills.id=$1`, [id]);
  return result.rows[0] ? toSkill(result.rows[0]) : null;
}
async function insertRevision(client: PoolClient, r: SkillRevisionRecord) {
  await client.query(
    'INSERT INTO skill_revisions (id,skill_id,revision_number,name,description,body,actor_type,actor_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [r.id, r.skillId, r.revisionNumber, r.name, r.description, r.body, r.actorType, r.actorUserId ?? null, r.createdAt],
  );
}
function toSkill(r: SkillRow): SkillRecord {
  const base = {
    id: r.id,
    name: r.name,
    description: r.description,
    body: r.body,
    currentRevisionId: r.current_revision_id,
    currentRevisionNumber: Number(r.current_revision_number),
    autoLoad: r.auto_load,
    enabled: r.enabled,
    ...(r.created_by_user_id ? { createdByUserId: r.created_by_user_id } : {}),
    ...(r.archived_at ? { archivedAt: r.archived_at } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.scope === 'personal' && r.owner_user_id) return { ...base, scope: 'personal', ownerUserId: r.owner_user_id };
  if (r.scope === 'tenant' && !r.owner_user_id) return { ...base, scope: 'tenant' };
  throw new Error(`Invalid skill ownership: ${r.id}`);
}
function toRevision(r: RevisionRow): SkillRevisionRecord {
  const base = {
    id: r.id,
    skillId: r.skill_id,
    revisionNumber: Number(r.revision_number),
    name: r.name,
    description: r.description,
    body: r.body,
    createdAt: r.created_at,
  };
  if (r.actor_type === 'user' && r.actor_user_id) return { ...base, actorType: 'user', actorUserId: r.actor_user_id };
  if (r.actor_type === 'system' && !r.actor_user_id) return { ...base, actorType: 'system' };
  throw new Error(`Invalid skill revision actor: ${r.id}`);
}
function requireSkill(skill: SkillRecord | null, id: string): SkillRecord {
  if (!skill) throw new Error(`Skill does not exist: ${id}`);
  return skill;
}
function throwNameConflict(error: unknown): never {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    ['skills_tenant_name_unique_idx', 'skills_personal_active_owner_name_unique_idx'].includes(String(error.constraint))
  )
    throw new StoreConflictError('skill_name_exists', 'Skill name already exists');
  throw error;
}
