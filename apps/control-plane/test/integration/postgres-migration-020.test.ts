import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');
const databaseNames: string[] = [];

async function isolatedDatabase(label: string): Promise<{ client: Client; migration020: string }> {
  if (!baseUrl) throw new Error('TEST_DATABASE_URL is required');
  const baseName = new URL(baseUrl).pathname.slice(1);
  if (!/test/i.test(baseName)) throw new Error('TEST_DATABASE_URL must name a test database');
  const name = `${baseName}_migration_020_${label}_${process.pid}`.slice(0, 63);
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  databaseNames.push(name);

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files.filter((file) => file < '020_single_tenant_access.sql')) {
    await client.query(await readFile(join(migrationsDir, file), 'utf8'));
  }
  return { client, migration020: await readFile(join(migrationsDir, '020_single_tenant_access.sql'), 'utf8') };
}

describe.skipIf(!baseUrl)('020_single_tenant_access migration', () => {
  let client: Client;
  let migration020: string;

  beforeAll(async () => {
    ({ client, migration020 } = await isolatedDatabase('coverage'));
    await client.query(`
      BEGIN;
      SET CONSTRAINTS ALL DEFERRED;
      INSERT INTO auth_users(id,username,role,created_at,updated_at) VALUES
        ('10000000-0000-4000-8000-000000000001','root','super_admin','2024-01-01','2024-01-01'),
        ('10000000-0000-4000-8000-000000000002','member','user','2024-01-01','2024-01-01'),
        ('10000000-0000-4000-8000-000000000003','groupadmin','user','2024-01-01','2024-01-01'),
        ('10000000-0000-4000-8000-000000000004','viewer','user','2024-01-01','2024-01-01'),
        ('10000000-0000-4000-8000-000000000005','archivedonly','user','2024-01-01','2024-01-01');
      INSERT INTO groups(id,name,archived_at,created_at,updated_at) VALUES
        ('20000000-0000-4000-8000-000000000001','Alpha',NULL,'2024-01-01','2024-01-01'),
        ('20000000-0000-4000-8000-000000000002','Beta',NULL,'2024-01-01','2024-01-01'),
        ('20000000-0000-4000-8000-000000000003','Archive','2024-06-01','2024-01-01','2024-06-01');
      INSERT INTO group_members(group_id,user_id,role,created_at,updated_at) VALUES
        ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','member','2024-01-01','2024-01-01'),
        ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003','admin','2024-01-01','2024-01-01'),
        ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','viewer','2024-01-01','2024-01-01'),
        ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000005','admin','2024-01-01','2024-01-01');

      INSERT INTO sessions(id,status,title,owner_group_id,created_at,updated_at,last_activity_at) VALUES
        ('30000000-0000-4000-8000-000000000001','idle','active','20000000-0000-4000-8000-000000000001','2024-01-01','2024-02-01','2024-02-01'),
        ('30000000-0000-4000-8000-000000000002','archived','old archive','20000000-0000-4000-8000-000000000001','2024-01-01','2024-03-01','2024-03-01'),
        ('30000000-0000-4000-8000-000000000003','idle','group archive','20000000-0000-4000-8000-000000000003','2024-01-01','2024-02-01','2024-02-01');
      INSERT INTO automations(id,kind,name,prompt,schedule_cron,owner_group_id,visibility,write_policy,archived_at,created_at,updated_at) VALUES
        ('40000000-0000-4000-8000-000000000001','scheduled','active','p','0 0 * * *','20000000-0000-4000-8000-000000000001','group','group_members',NULL,'2024-01-01','2024-02-01'),
        ('40000000-0000-4000-8000-000000000002','scheduled','preserved','p','0 0 * * *','20000000-0000-4000-8000-000000000003','group','group_members','2024-05-01','2024-01-01','2024-02-01'),
        ('40000000-0000-4000-8000-000000000003','scheduled','group archive','p','0 0 * * *','20000000-0000-4000-8000-000000000003','group','group_members',NULL,'2024-01-01','2024-02-01');

      INSERT INTO environments(id,name,owner_group_id,current_revision_id,current_revision_number,archived_at,created_at,updated_at) VALUES
        ('00000001-0000-4000-8000-000000000001','Deploy','20000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001',1,NULL,'2024-01-01','2024-01-01'),
        ('22222222-0000-4000-8000-000000000002','Deploy','20000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000002',1,NULL,'2024-01-01','2024-01-01'),
        ('33333333-0000-4000-8000-000000000003','Deploy','20000000-0000-4000-8000-000000000003','51000000-0000-4000-8000-000000000003',1,'2024-05-01','2024-01-02','2024-05-01'),
        ('44444444-0000-4000-8000-000000000004','Deploy (Beta)','20000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000004',1,NULL,'2024-01-03','2024-01-03');
      INSERT INTO environment_revisions(id,environment_id,revision_number,actor_type,created_at)
        SELECT current_revision_id,id,1,'system',created_at FROM environments;

      INSERT INTO skills(id,owner_kind,owner_group_id,owner_user_id,name,current_revision_id,current_revision_number,archived_at,created_at,updated_at) VALUES
        ('61000000-0000-4000-8000-000000000001','group','20000000-0000-4000-8000-000000000001',NULL,'build','62000000-0000-4000-8000-000000000001',1,NULL,'2024-01-01','2024-01-01'),
        ('61000000-0000-4000-8000-000000000002','group','20000000-0000-4000-8000-000000000002',NULL,'build','62000000-0000-4000-8000-000000000002',1,NULL,'2024-01-02','2024-01-02'),
        ('61000000-0000-4000-8000-000000000003','user',NULL,'10000000-0000-4000-8000-000000000002','build','62000000-0000-4000-8000-000000000003',1,'2024-05-01','2024-01-03','2024-05-01');
      INSERT INTO skill_revisions(id,skill_id,revision_number,name,description,body,actor_type,created_at)
        SELECT current_revision_id,id,1,name,'description','body','system',created_at FROM skills;

      INSERT INTO snippets(id,owner_user_id,name,body,archived_at,created_at,updated_at) VALUES
        ('71000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Prompt','body',NULL,'2024-01-01','2024-01-01'),
        ('71000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Prompt','body',NULL,'2024-01-02','2024-01-02'),
        ('71000000-ffff-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','Prompt','body','2024-05-01','2024-01-03','2024-05-01'),
        ('72000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','Prompt (member)','body',NULL,'2024-01-04','2024-01-04'),
        ('72000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','Prompt (member, 71000000-0000-4000-8000-000000000002)','body',NULL,'2024-01-05','2024-01-05');
      INSERT INTO explicit_notepads(id,title,owner_group_id,visibility,write_policy,created_at,updated_at) VALUES
        ('81000000-0000-4000-8000-000000000001','active','20000000-0000-4000-8000-000000000001','group','group_members','2024-01-01','2024-02-01'),
        ('81000000-0000-4000-8000-000000000002','group archive','20000000-0000-4000-8000-000000000003','group','group_members','2024-01-01','2024-02-01');
      INSERT INTO notepad_revisions(notepad_kind,notepad_id,revision,content,size_bytes,actor,mutation_kind,created_at)
        VALUES ('explicit','81000000-0000-4000-8000-000000000002',1,'history',7,'{"kind":"system"}','replace','2024-02-01');
      COMMIT;
    `);
    await client.query('BEGIN');
    await client.query(migration020);
    await client.query('COMMIT');
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    if (!baseUrl) return;
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    for (const name of databaseNames) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  });

  it('maps roles using only active memberships', async () => {
    const { rows } = await client.query('SELECT username, role FROM auth_users ORDER BY username');
    expect(rows).toEqual([
      { username: 'archivedonly', role: 'viewer' },
      { username: 'groupadmin', role: 'member' },
      { username: 'member', role: 'member' },
      { username: 'root', role: 'admin' },
      { username: 'viewer', role: 'viewer' },
    ]);
  });

  it('materializes archived groups while preserving older explicit archive times', async () => {
    expect(
      (await client.query('SELECT status, updated_at::date::text AS updated FROM sessions ORDER BY id')).rows,
    ).toEqual([
      { status: 'idle', updated: '2024-02-01' },
      { status: 'archived', updated: '2024-03-01' },
      { status: 'archived', updated: '2024-06-01' },
    ]);
    expect(
      (await client.query('SELECT archived_at::date::text AS archived FROM automations ORDER BY id')).rows,
    ).toEqual([{ archived: null }, { archived: '2024-05-01' }, { archived: '2024-06-01' }]);
    expect(
      (await client.query('SELECT archived_at::date::text AS archived FROM explicit_notepads ORDER BY id')).rows,
    ).toEqual([{ archived: null }, { archived: '2024-06-01' }]);
    expect(
      (
        await client.query(
          "SELECT archived_at::date::text AS archived FROM environments WHERE id='33333333-0000-4000-8000-000000000003'",
        )
      ).rows[0],
    ).toEqual({ archived: '2024-05-01' });
  });

  it('uses deterministic canonical, readable, and stable collision names, including archived rows', async () => {
    expect((await client.query('SELECT id::text,name FROM environments ORDER BY id')).rows).toEqual([
      { id: '00000001-0000-4000-8000-000000000001', name: 'Deploy' },
      { id: '22222222-0000-4000-8000-000000000002', name: 'Deploy (Beta, 22222222-0000-4000-8000-000000000002)' },
      { id: '33333333-0000-4000-8000-000000000003', name: 'Deploy (Archive)' },
      { id: '44444444-0000-4000-8000-000000000004', name: 'Deploy (Beta)' },
    ]);
    expect((await client.query('SELECT name FROM skills ORDER BY id')).rows.map((r) => r.name)).toEqual([
      'build',
      'build-beta',
      'build',
    ]);
    expect((await client.query('SELECT name FROM skill_revisions ORDER BY skill_id')).rows.map((r) => r.name)).toEqual([
      'build',
      'build-beta',
      'build',
    ]);
    expect(
      (
        await client.query(
          "SELECT bool_and(name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64) AS valid FROM skills WHERE scope='tenant'",
        )
      ).rows[0].valid,
    ).toBe(true);
    const snippetNames = (await client.query('SELECT name FROM snippets ORDER BY id')).rows.map((r) => r.name);
    expect(snippetNames).toEqual([
      'Prompt',
      'Prompt',
      'Prompt',
      'Prompt (member)',
      'Prompt (member, 71000000-0000-4000-8000-000000000002)',
    ]);
    expect((await client.query('SELECT count(DISTINCT owner_user_id)::int AS n FROM snippets')).rows[0].n).toBe(2);
    expect(
      (
        await client.query(
          "SELECT scope,owner_user_id::text,auto_load,created_by_user_id::text FROM skills WHERE id='61000000-0000-4000-8000-000000000003'",
        )
      ).rows[0],
    ).toEqual({
      scope: 'personal',
      owner_user_id: '10000000-0000-4000-8000-000000000002',
      auto_load: false,
      created_by_user_id: '10000000-0000-4000-8000-000000000002',
    });
    expect(
      (await client.query("SELECT DISTINCT scope FROM skills WHERE id<>'61000000-0000-4000-8000-000000000003'")).rows,
    ).toEqual([{ scope: 'tenant' }]);
  });

  it('removes group/share/owner access schema without losing IDs or history', async () => {
    const absentTables = await client.query(
      "SELECT to_regclass(name) AS value FROM unnest(ARRAY['groups','group_members','environment_group_shares','skill_group_shares']) name",
    );
    expect(absentTables.rows.every((row) => row.value === null)).toBe(true);
    const forbiddenColumns = await client.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('owner_group_id','owner_kind','share_mode','visibility','write_policy')",
    );
    expect(forbiddenColumns.rows).toEqual([]);
    expect(
      (
        await client.query(
          "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='owner_user_id' ORDER BY table_name",
        )
      ).rows,
    ).toEqual([{ table_name: 'skills' }, { table_name: 'snippets' }]);
    expect((await client.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n).toBe(3);
    expect((await client.query('SELECT count(*)::int AS n FROM environments')).rows[0].n).toBe(4);
    expect((await client.query('SELECT count(*)::int AS n FROM environment_revisions')).rows[0].n).toBe(4);
    expect((await client.query('SELECT count(*)::int AS n FROM skills')).rows[0].n).toBe(3);
    expect((await client.query('SELECT count(*)::int AS n FROM skill_revisions')).rows[0].n).toBe(3);
    expect((await client.query('SELECT count(*)::int AS n FROM notepad_revisions')).rows[0].n).toBe(1);
  });

  it('rejects a nonempty installation that would have no administrator atomically', async () => {
    const state = await isolatedDatabase('no_admin');
    try {
      await state.client.query(
        "INSERT INTO auth_users(id,username,role,created_at,updated_at) VALUES ('90000000-0000-4000-8000-000000000001','only-viewer','user',now(),now())",
      );
      await state.client.query('BEGIN');
      await expect(state.client.query(state.migration020)).rejects.toThrow(/requires an administrator/);
      await state.client.query('ROLLBACK');
      expect((await state.client.query("SELECT role FROM auth_users WHERE username='only-viewer'")).rows[0].role).toBe(
        'user',
      );
      expect((await state.client.query("SELECT to_regclass('groups') AS value")).rows[0].value).toBe('groups');
    } finally {
      await state.client.end();
    }
  });
});
