import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { StoreConflictError } from '../types.js';
import type {
  AuditActorType,
  CreateSkillRecord,
  SkillOwnerKind,
  SkillRecord,
  SkillRevisionRecord,
  SkillRevisionSelection,
  SkillRunCandidate,
  SkillShareMode,
  SkillStore,
  UpdateSkillRecord,
} from '../types.js';

type PgInteger = number | string;

type SkillRow = QueryResultRow & {
  id: string;
  owner_kind: SkillOwnerKind;
  owner_group_id: string | null;
  owner_user_id: string | null;
  name: string;
  description: string;
  body: string;
  current_revision_id: string;
  current_revision_number: PgInteger;
  auto_load: boolean;
  enabled: boolean;
  share_mode: SkillShareMode;
  created_by_user_id: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  share_group_ids: string[];
};

type SkillRevisionRow = QueryResultRow & {
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

type LockedSkillWriteRow = {
  owner_kind: SkillOwnerKind;
  owner_group_id: string | null;
  archived_at: Date | null;
  current_revision_id: string;
  current_revision_number: PgInteger;
};

const skillSelectColumns =
  'id, owner_kind, owner_group_id, owner_user_id, (SELECT name FROM skill_revisions WHERE id = skills.current_revision_id) AS name, (SELECT description FROM skill_revisions WHERE id = skills.current_revision_id) AS description, (SELECT body FROM skill_revisions WHERE id = skills.current_revision_id) AS body, current_revision_id, current_revision_number, auto_load, enabled, share_mode, created_by_user_id, archived_at, created_at, updated_at, ARRAY(SELECT group_id FROM skill_group_shares WHERE skill_id = skills.id ORDER BY group_id) AS share_group_ids';
const skillRevisionSelectColumns =
  'id, skill_id, revision_number, name, description, body, actor_type, actor_user_id, created_at';
const joinedSkillSelectColumns =
  'skills.id, skills.owner_kind, skills.owner_group_id, skills.owner_user_id, current_revision.name, current_revision.description, current_revision.body, skills.current_revision_id, skills.current_revision_number, skills.auto_load, skills.enabled, skills.share_mode, skills.created_by_user_id, skills.archived_at, skills.created_at, skills.updated_at, ARRAY(SELECT group_id FROM skill_group_shares WHERE skill_id = skills.id ORDER BY group_id) AS share_group_ids';

export class PostgresSkillStore implements SkillStore {
  constructor(private readonly pool: Pool) {}

  async createSkill(record: CreateSkillRecord): Promise<SkillRecord> {
    try {
      return await this.transaction(async (client) => {
        if (record.ownerKind === 'group') {
          await lockActiveSkillGroup(client, record.ownerGroupId);
        }
        const revision: SkillRevisionRecord = { ...record.revision, skillId: record.id, revisionNumber: 1 };
        await client.query(
          `INSERT INTO skills (
             id, owner_kind, owner_group_id, owner_user_id, name, current_revision_id, current_revision_number,
             auto_load, enabled, share_mode, created_by_user_id, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            record.id,
            record.ownerKind,
            record.ownerGroupId ?? null,
            record.ownerUserId ?? null,
            record.revision.name,
            revision.id,
            revision.revisionNumber,
            record.autoLoad ?? true,
            record.enabled ?? true,
            record.shareMode ?? 'none',
            record.createdByUserId ?? null,
            record.createdAt,
            record.updatedAt,
          ],
        );
        await insertSkillRevision(client, revision);
        return requireSkill(await getSkillWithClient(client, record.id), record.id);
      });
    } catch (error) {
      throwSkillNameConflict(error);
    }
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    const result = await this.pool.query<SkillRow>(`SELECT ${skillSelectColumns} FROM skills WHERE id = $1`, [id]);
    return result.rows[0] ? toSkill(result.rows[0]) : null;
  }

  async listSkillRevisions(skillId: string): Promise<SkillRevisionRecord[]> {
    const result = await this.pool.query<SkillRevisionRow>(
      `SELECT ${skillRevisionSelectColumns}
       FROM skill_revisions
       WHERE skill_id = $1
       ORDER BY revision_number DESC`,
      [skillId],
    );
    return result.rows.map(toSkillRevision);
  }

  async updateSkill(input: UpdateSkillRecord): Promise<SkillRecord> {
    try {
      return await this.transaction(async (client) => {
        const existing = await lockSkillForWrite(client, input.id);
        if (!existing) throw new Error(`Skill does not exist: ${input.id}`);
        if (input.revision && existing.current_revision_id !== input.expectedCurrentRevisionId) {
          throw new StoreConflictError('skill_update_conflict', 'The skill changed while it was being edited');
        }
        const updates = ['updated_at = $2'];
        const values: unknown[] = [input.id, input.updatedAt];
        const addUpdate = (column: string, value: unknown): void => {
          values.push(value);
          updates.push(`${column} = $${values.length}`);
        };
        if (input.revision) {
          const revision: SkillRevisionRecord = {
            ...input.revision,
            skillId: input.id,
            revisionNumber: Number(existing.current_revision_number) + 1,
          };
          await insertSkillRevision(client, revision);
          addUpdate('name', revision.name);
          addUpdate('current_revision_id', revision.id);
          addUpdate('current_revision_number', revision.revisionNumber);
        }
        if (input.autoLoad !== undefined) addUpdate('auto_load', input.autoLoad);
        if (input.enabled !== undefined) addUpdate('enabled', input.enabled);
        const result = await client.query(
          `UPDATE skills SET ${updates.join(', ')} WHERE id = $1 AND archived_at IS NULL RETURNING id`,
          values,
        );
        if (!result.rows[0]) throw new Error(`Skill does not exist: ${input.id}`);
        return requireSkill(await getSkillWithClient(client, input.id), input.id);
      });
    } catch (error) {
      throwSkillNameConflict(error);
    }
  }

  async archiveSkill(input: { skillId: string; archivedAt: Date }): Promise<SkillRecord | null> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE skills
         SET archived_at = COALESCE(archived_at, $2), updated_at = $2
         WHERE id = $1
         RETURNING id`,
        [input.skillId, input.archivedAt],
      );
      return result.rows[0] ? getSkillWithClient(client, input.skillId) : null;
    });
  }

  async restoreSkill(input: { skillId: string; updatedAt: Date }): Promise<SkillRecord | null> {
    return this.transaction(async (client) => {
      const skill = await lockSkillForRestore(client, input.skillId);
      if (!skill) return null;
      if (skill.owner_group_id) await lockActiveSkillGroup(client, skill.owner_group_id);
      const result = await client.query(
        'UPDATE skills SET archived_at = NULL, updated_at = $2 WHERE id = $1 RETURNING id',
        [input.skillId, input.updatedAt],
      );
      return result.rows[0] ? getSkillWithClient(client, input.skillId) : null;
    });
  }

  async promoteSkill(id: string, groupId: string, now: Date): Promise<SkillRecord | null> {
    try {
      return await this.transaction(async (client) => {
        const skill = await lockSkillForWrite(client, id);
        if (!skill || skill.owner_kind !== 'user') return null;
        await lockActiveSkillGroup(client, groupId);
        const result = await client.query(
          `UPDATE skills
           SET owner_kind = 'group', owner_group_id = $2, owner_user_id = NULL,
               share_mode = 'none', updated_at = $3
           WHERE id = $1 AND owner_kind = 'user' AND archived_at IS NULL
           RETURNING id`,
          [id, groupId, now],
        );
        if (!result.rows[0]) return null;
        return getSkillWithClient(client, id);
      });
    } catch (error) {
      throwSkillNameConflict(error);
    }
  }

  async setSkillShares(
    id: string,
    shareMode: SkillShareMode,
    groupIds: string[],
    now: Date,
  ): Promise<SkillRecord | null> {
    return this.transaction(async (client) => {
      const skill = await lockSkillForWrite(client, id);
      if (!skill || skill.owner_kind !== 'group') return null;

      if (shareMode === 'specific') {
        const replacement = [...new Set(groupIds)];
        const existing = await client.query<{ group_id: string }>(
          'SELECT group_id FROM skill_group_shares WHERE skill_id = $1',
          [id],
        );
        const existingGroupIds = new Set(existing.rows.map((share) => share.group_id));
        await lockActiveSkillGroups(
          client,
          replacement.filter((groupId) => !existingGroupIds.has(groupId)),
        );
        await client.query(
          `DELETE FROM skill_group_shares
           WHERE skill_id = $1 AND NOT (group_id = ANY($2::uuid[]))`,
          [id, replacement],
        );
        await client.query(
          `INSERT INTO skill_group_shares (skill_id, group_id, created_at)
           SELECT $1, group_id, $3
           FROM unnest($2::uuid[]) AS group_id
           ON CONFLICT (skill_id, group_id) DO NOTHING`,
          [id, replacement, now],
        );
      }

      await client.query('UPDATE skills SET share_mode = $2, updated_at = $3 WHERE id = $1 AND archived_at IS NULL', [
        id,
        shareMode,
        now,
      ]);
      return getSkillWithClient(client, id);
    });
  }

  async listSkillsForUser(userId: string): Promise<SkillRecord[]> {
    const result = await this.pool.query<SkillRow>(
      `SELECT ${skillSelectColumns}
       FROM skills
       WHERE owner_kind = 'user' AND owner_user_id = $1
       ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    return result.rows.map(toSkill);
  }

  async listSkillsForGroups(groupIds: string[]): Promise<SkillRecord[]> {
    if (!groupIds.length) return [];
    const result = await this.pool.query<SkillRow>(
      `SELECT ${skillSelectColumns}
       FROM skills
       WHERE owner_kind = 'group' AND owner_group_id = ANY($1::uuid[])
       ORDER BY created_at ASC, id ASC`,
      [groupIds],
    );
    return result.rows.map(toSkill);
  }

  async listSkillsSharedIntoGroups(groupIds: string[]): Promise<SkillRecord[]> {
    if (!groupIds.length) return [];
    const result = await this.pool.query<SkillRow>(
      `SELECT ${skillSelectColumns}
       FROM skills
       WHERE owner_kind = 'group'
         AND NOT (owner_group_id = ANY($1::uuid[]))
         AND (
           share_mode = 'all_groups'
           OR (
             share_mode = 'specific'
             AND EXISTS (
               SELECT 1 FROM skill_group_shares
               WHERE skill_id = skills.id AND group_id = ANY($1::uuid[])
             )
           )
         )
       ORDER BY created_at ASC, id ASC`,
      [groupIds],
    );
    return result.rows.map(toSkill);
  }

  async listSkillsForRun(input: {
    ownerGroupId: string;
    createdByUserId?: string;
    invokedNames?: string[];
    invokedRevisions?: SkillRevisionSelection[];
  }): Promise<SkillRunCandidate[]> {
    const current = await this.listCurrentSkillsForAccess(input, false, input.invokedNames ?? []);
    const selections = input.invokedRevisions ?? [];
    if (!selections.length) return current;
    const pinned = await this.listPinnedSkillsForRun(input, selections);
    const seen = new Set<string>();
    return [...current, ...pinned].filter((skill) => {
      const key = `${skill.id}:${skill.resolvedRevisionId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async listSkillInvocationCandidates(input: { ownerGroupId: string; userId?: string }): Promise<SkillRunCandidate[]> {
    return this.listCurrentSkillsForAccess(
      { ownerGroupId: input.ownerGroupId, ...(input.userId ? { createdByUserId: input.userId } : {}) },
      true,
      [],
    );
  }

  private async listCurrentSkillsForAccess(
    input: { ownerGroupId: string; createdByUserId?: string },
    includeManual: boolean,
    invokedNames: string[],
  ): Promise<SkillRunCandidate[]> {
    const result = await this.pool.query<SkillRow & { source: SkillRunCandidate['source'] }>(
      `SELECT ${joinedSkillSelectColumns},
              CASE
                WHEN skills.owner_kind = 'user' THEN 'personal'
                WHEN skills.owner_group_id = $1 THEN 'group'
                ELSE 'shared'
              END AS source
       FROM skills
       JOIN skill_revisions current_revision ON current_revision.id = skills.current_revision_id
       LEFT JOIN groups owner_group ON owner_group.id = skills.owner_group_id
       WHERE skills.enabled = true
         AND skills.archived_at IS NULL
         AND (owner_group.id IS NULL OR owner_group.archived_at IS NULL)
          AND ($3::boolean OR skills.auto_load = true OR skills.name = ANY($4::text[]))
         AND (
           (skills.owner_kind = 'user' AND skills.owner_user_id = $2::uuid)
           OR (skills.owner_kind = 'group' AND skills.owner_group_id = $1)
           OR (
             skills.owner_kind = 'group'
             AND skills.owner_group_id <> $1
             AND (
               skills.share_mode = 'all_groups'
               OR (
                 skills.share_mode = 'specific'
                 AND EXISTS (
                   SELECT 1 FROM skill_group_shares
                   WHERE skill_id = skills.id AND group_id = $1
                 )
               )
             )
           )
         )
       ORDER BY skills.created_at ASC, skills.id ASC`,
      [input.ownerGroupId, input.createdByUserId ?? null, includeManual, invokedNames],
    );
    return result.rows.map((row) => ({
      ...toSkill(row),
      source: row.source,
      resolvedRevisionId: row.current_revision_id,
      resolvedRevisionNumber: Number(row.current_revision_number),
    }));
  }

  private async listPinnedSkillsForRun(
    input: { ownerGroupId: string; createdByUserId?: string },
    selections: SkillRevisionSelection[],
  ): Promise<SkillRunCandidate[]> {
    const result = await this.pool.query<
      SkillRow & {
        source: SkillRunCandidate['source'];
        resolved_revision_id: string;
        resolved_revision_number: PgInteger;
      }
    >(
      `WITH requested AS (
         SELECT skill_id, revision_id, position
         FROM unnest($3::uuid[], $4::uuid[]) WITH ORDINALITY AS request(skill_id, revision_id, position)
       )
       SELECT skills.id, skills.owner_kind, skills.owner_group_id, skills.owner_user_id,
              requested_revision.name, requested_revision.description, requested_revision.body,
              skills.current_revision_id, skills.current_revision_number, skills.auto_load, skills.enabled,
              skills.share_mode, skills.created_by_user_id, skills.archived_at, skills.created_at, skills.updated_at,
              ARRAY(SELECT group_id FROM skill_group_shares WHERE skill_id = skills.id ORDER BY group_id) AS share_group_ids,
              requested_revision.id AS resolved_revision_id,
              requested_revision.revision_number AS resolved_revision_number,
              CASE
                WHEN skills.owner_kind = 'user' THEN 'personal'
                WHEN skills.owner_group_id = $1 THEN 'group'
                ELSE 'shared'
              END AS source
       FROM requested
       JOIN skills ON skills.id = requested.skill_id
       JOIN skill_revisions requested_revision
         ON requested_revision.id = requested.revision_id AND requested_revision.skill_id = skills.id
       LEFT JOIN groups owner_group ON owner_group.id = skills.owner_group_id
       WHERE skills.enabled = true
         AND skills.archived_at IS NULL
         AND (owner_group.id IS NULL OR owner_group.archived_at IS NULL)
         AND (
           (skills.owner_kind = 'user' AND skills.owner_user_id = $2::uuid)
           OR (skills.owner_kind = 'group' AND skills.owner_group_id = $1)
           OR (
             skills.owner_kind = 'group'
             AND skills.owner_group_id <> $1
             AND (
               skills.share_mode = 'all_groups'
               OR (
                 skills.share_mode = 'specific'
                 AND EXISTS (
                   SELECT 1 FROM skill_group_shares
                   WHERE skill_id = skills.id AND group_id = $1
                 )
               )
             )
           )
         )
       ORDER BY requested.position`,
      [
        input.ownerGroupId,
        input.createdByUserId ?? null,
        selections.map((selection) => selection.skillId),
        selections.map((selection) => selection.revisionId),
      ],
    );
    return result.rows.map((row) => ({
      ...toSkill(row),
      source: row.source,
      resolvedRevisionId: row.resolved_revision_id,
      resolvedRevisionNumber: Number(row.resolved_revision_number),
    }));
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function getSkillWithClient(client: PoolClient, id: string): Promise<SkillRecord | null> {
  const result = await client.query<SkillRow>(`SELECT ${skillSelectColumns} FROM skills WHERE id = $1`, [id]);
  return result.rows[0] ? toSkill(result.rows[0]) : null;
}

async function lockSkillForWrite(client: PoolClient, id: string): Promise<LockedSkillWriteRow | null> {
  const result = await client.query<LockedSkillWriteRow>(
    'SELECT owner_kind, owner_group_id, archived_at, current_revision_id, current_revision_number FROM skills WHERE id = $1 FOR UPDATE',
    [id],
  );
  const skill = result.rows[0];
  if (!skill) return null;
  if (skill.archived_at) throw new StoreConflictError('skill_archived', 'Restore this skill before editing it');
  if (skill.owner_group_id) await lockActiveSkillGroup(client, skill.owner_group_id);
  return skill;
}

async function lockSkillForRestore(client: PoolClient, id: string): Promise<LockedSkillWriteRow | null> {
  const result = await client.query<LockedSkillWriteRow>(
    'SELECT owner_kind, owner_group_id, archived_at, current_revision_id, current_revision_number FROM skills WHERE id = $1 FOR UPDATE',
    [id],
  );
  return result.rows[0] ?? null;
}

async function insertSkillRevision(client: PoolClient, revision: SkillRevisionRecord): Promise<void> {
  await client.query(
    `INSERT INTO skill_revisions (
       id, skill_id, revision_number, name, description, body, actor_type, actor_user_id, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      revision.id,
      revision.skillId,
      revision.revisionNumber,
      revision.name,
      revision.description,
      revision.body,
      revision.actorType,
      revision.actorUserId ?? null,
      revision.createdAt,
    ],
  );
}

async function lockActiveSkillGroup(client: PoolClient, groupId: string): Promise<void> {
  await lockActiveSkillGroups(client, [groupId]);
}

async function lockActiveSkillGroups(client: PoolClient, groupIds: string[]): Promise<void> {
  const ids = [...new Set(groupIds)].sort();
  if (!ids.length) return;
  const result = await client.query<{ id: string; archived_at: Date | null }>(
    'SELECT id, archived_at FROM groups WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  if (result.rows.length !== ids.length) {
    const found = new Set(result.rows.map((group) => group.id));
    throw new Error(`Group does not exist: ${ids.find((id) => !found.has(id))}`);
  }
  if (result.rows.some((group) => group.archived_at)) {
    throw new StoreConflictError('archived_group', 'Cannot modify skills in an archived group');
  }
}

function requireSkill(skill: SkillRecord | null, id: string): SkillRecord {
  if (!skill) throw new Error(`Skill does not exist: ${id}`);
  return skill;
}

function throwSkillNameConflict(error: unknown): never {
  if (isUniqueViolation(error, 'skills_group_name_idx') || isUniqueViolation(error, 'skills_user_name_idx')) {
    throw new StoreConflictError('skill_name_exists', 'Skill name already exists');
  }
  throw error;
}

function toSkill(row: SkillRow): SkillRecord {
  const base = {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    currentRevisionId: row.current_revision_id,
    currentRevisionNumber: Number(row.current_revision_number),
    autoLoad: row.auto_load,
    enabled: row.enabled,
    shareMode: row.share_mode,
    shareGroupIds: row.share_group_ids,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.created_by_user_id ? { createdByUserId: row.created_by_user_id } : {}),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
  if (row.owner_kind === 'group' && row.owner_group_id) {
    return { ...base, ownerKind: row.owner_kind, ownerGroupId: row.owner_group_id };
  }
  if (row.owner_kind === 'user' && row.owner_user_id) {
    return { ...base, ownerKind: row.owner_kind, ownerUserId: row.owner_user_id };
  }
  throw new Error(`Invalid skill owner: ${row.id}`);
}

function toSkillRevision(row: SkillRevisionRow): SkillRevisionRecord {
  const base = {
    id: row.id,
    skillId: row.skill_id,
    revisionNumber: Number(row.revision_number),
    name: row.name,
    description: row.description,
    body: row.body,
    createdAt: row.created_at,
  };
  if (row.actor_type === 'user' && row.actor_user_id) {
    return { ...base, actorType: row.actor_type, actorUserId: row.actor_user_id };
  }
  if (row.actor_type === 'system' && !row.actor_user_id) return { ...base, actorType: row.actor_type };
  throw new Error(`Invalid skill revision actor: ${row.id}`);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint,
  );
}
