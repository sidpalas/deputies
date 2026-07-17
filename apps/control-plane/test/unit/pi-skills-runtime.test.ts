import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { preparePiSkills, serializeManagedSkill } from '../../src/runner-pi/skills.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';
import {
  execResult,
  managedSkill as managed,
  MemorySandboxFileSystem,
  runnerInput as input,
  sandboxHandle as sandbox,
  skillDocument,
} from '../support/pi-skills.js';

const execFileAsync = promisify(execFile);

describe('Pi skill resolution and materialization', () => {
  it('uses typed runner invocations instead of parsing persisted message context', async () => {
    const listForRun = vi.fn(async (request: { invokedNames: string[] }) =>
      request.invokedNames.length ? [managed('legacy', 'Legacy', 'legacy body', 'group', false)] : [],
    );

    const prepared = await preparePiSkills({
      runnerInput: input({ context: { skills: ['legacy'], skillRefs: [{ id: 'legacy-id', name: 'legacy' }] } }),
      provider: { repoScanEnabled: false, listForRun },
      repositories: [],
    });

    expect(listForRun).toHaveBeenCalledOnce();
    expect(listForRun).toHaveBeenCalledWith(expect.objectContaining({ invokedNames: [] }));
    expect(prepared.prompt).toBe('request');
    expect(prepared.userInvocations).toEqual([]);
  });

  it('resolves precedence, safely materializes managed skills, and prefixes only their messages', async () => {
    const fs = new MemorySandboxFileSystem('/custom/workspace');
    await fs.writeFile('/custom/workspace/.deputies-skills/stale/SKILL.md', 'stale');
    const listForRun = vi.fn(async () => [
      managed('shared-name', 'new shared', 'new body', 'shared', false, '2026-02-01T00:00:00Z'),
      managed('shared-name', 'old shared', 'old body', 'shared', true, '2026-01-01T00:00:00Z'),
      managed('collision', 'shared collision', 'shared', 'shared'),
      {
        ...managed('collision', 'group collision', 'group', 'group'),
        ownerGroupId: 'group-1',
        ownerGroupName: 'Platform',
      },
      managed('collision', 'personal collision', 'personal', 'personal'),
      managed('manual', 'line one\nline two: quoted', 'manual body', 'group', false),
      managed('dormant', 'not advertised', 'dormant body', 'group', false),
    ]);
    const runnerInput = input({
      createdByUserId: 'user-1',
      ownerGroupId: 'group-1',
      sandbox: sandbox(fs, undefined, '/custom/workspace'),
      messages: [
        {
          sequence: 1,
          prompt: 'first request',
          authorUserId: 'user-1',
          skillInvocations: [{ name: 'manual' }, { name: 'missing' }],
        },
        { sequence: 2, prompt: 'second request', authorUserId: 'user-1', context: {} },
      ],
    });

    const prepared = await preparePiSkills({
      runnerInput,
      provider: { repoScanEnabled: false, listForRun },
      repositories: [],
    });

    expect(listForRun).toHaveBeenCalledWith({
      ownerGroupId: 'group-1',
      createdByUserId: 'user-1',
      invokedNames: ['manual', 'missing'],
      invokedRevisions: [],
    });
    expect(prepared.event.skills).toEqual([
      expect.objectContaining({ name: 'shared-name', source: 'shared', revisionNumber: 1 }),
      expect.objectContaining({ name: 'collision', source: 'personal', revisionNumber: 1 }),
      {
        name: 'manual',
        source: 'group',
        skillId: 'skill-group-manual-1768435200000',
        revisionId: 'revision-group-manual-1768435200000',
        revisionNumber: 1,
        ref: 'skill-group-manual-1768435200000',
        invoked: true,
        advertised: false,
      },
    ]);
    expect(prepared.event.shadowed).toEqual([
      expect.objectContaining({
        name: 'collision',
        source: 'group',
        ownerGroupId: 'group-1',
        ownerGroupName: 'Platform',
        revisionNumber: 1,
      }),
      expect.objectContaining({ name: 'collision', source: 'shared', revisionNumber: 1 }),
    ]);
    expect(prepared.skills.find((skill) => skill.name === 'manual')).toBeUndefined();
    expect(prepared.skills.find((skill) => skill.name === 'dormant')).toBeUndefined();
    expect(
      await fs.readFile(
        '/custom/workspace/.deputies-skills/shared/skill-shared-shared-name-1767225600000/revision-shared-shared-name-1767225600000/shared-name/SKILL.md',
      ),
    ).toContain('old body');
    expect(await fs.exists('/custom/workspace/.deputies-skills/stale/SKILL.md')).toBe(false);
    expect(
      await fs.readFile(
        '/custom/workspace/.deputies-skills/group/skill-group-manual-1768435200000/revision-group-manual-1768435200000/manual/SKILL.md',
      ),
    ).toBe(serializeManagedSkill({ name: 'manual', description: 'line one\nline two: quoted', body: 'manual body' }));
    expect(prepared.prompt).toContain('<skill name="manual" location="/custom/workspace/.deputies-skills/group/');
    expect(prepared.prompt).toContain('References are relative to /custom/workspace/.deputies-skills/group/');
    expect(prepared.prompt).toContain('manual body\n</skill>');
    expect(prepared.prompt).not.toContain('description: "line one');
    expect(prepared.prompt).not.toContain('Read /custom/workspace/.deputies-skills');
    expect(prepared.prompt).toContain('The user invoked the skill "missing", but it is unavailable for this run.');
    expect(prepared.prompt).toContain('Message 1:\n<skill name="manual"');
    expect(prepared.prompt).toContain('\n\nfirst request\n\nMessage 2:\nsecond request');
    expect(prepared.prompt).not.toContain('Message 2:\n<skill');
  });

  it('resolves explicit personal invocations against each claimed message author', async () => {
    const ownerSkill = managed('same-name', 'Owner personal', 'owner body', 'personal', true);
    const writerSkill = managed(
      'same-name',
      'Writer personal',
      'writer body',
      'personal',
      false,
      '2026-01-16T00:00:00Z',
    );
    const groupSkill = managed('same-name', 'Group candidate', 'group body', 'group', false);
    const listForRun = vi.fn(async (request: { createdByUserId?: string; invokedNames: string[] }) => {
      if (!request.invokedNames.length) return request.createdByUserId === 'owner' ? [ownerSkill] : [];
      if (request.createdByUserId === 'owner') return [ownerSkill, groupSkill];
      if (request.createdByUserId === 'writer') return [writerSkill, groupSkill];
      return [groupSkill];
    });
    const prepared = await preparePiSkills({
      runnerInput: input({
        createdByUserId: 'owner',
        messages: [
          {
            messageId: 'message-owner',
            prompt: 'owner request',
            authorUserId: 'owner',
            skillInvocations: [{ name: 'same-name', ref: ownerSkill.id }],
          },
          {
            messageId: 'message-writer',
            prompt: 'writer request',
            authorUserId: 'writer',
            skillInvocations: [
              { name: 'same-name', ref: writerSkill.id },
              { name: 'same-name', ref: groupSkill.id },
            ],
          },
          {
            messageId: 'message-unauthorized',
            prompt: 'unauthorized request',
            authorUserId: 'outsider',
            skillInvocations: [{ name: 'same-name', ref: ownerSkill.id }],
          },
          {
            messageId: 'message-group-repeat',
            prompt: 'group request',
            authorUserId: 'owner',
            skillInvocations: [{ name: 'same-name', ref: groupSkill.id }],
          },
        ],
      }),
      provider: { repoScanEnabled: false, listForRun },
      repositories: [],
    });

    expect(listForRun.mock.calls.map(([request]) => request.createdByUserId)).toEqual([
      'owner',
      'owner',
      'writer',
      'outsider',
      'owner',
    ]);
    expect(prepared.prompt).toContain(
      `Message 1:\n<skill name="same-name" location="/workspace/.deputies-skills/personal/${ownerSkill.id}`,
    );
    expect(prepared.prompt).toContain('owner body\n</skill>');
    expect(prepared.prompt).toContain(
      `Message 2:\n<skill name="same-name" location="/workspace/.deputies-skills/personal/${writerSkill.id}`,
    );
    expect(prepared.prompt).toContain('writer body\n</skill>');
    expect(prepared.prompt).toContain(
      `<skill name="same-name" location="/workspace/.deputies-skills/group/${groupSkill.id}`,
    );
    expect(prepared.prompt).toContain('group body\n</skill>');
    expect(prepared.prompt).toContain(
      'Message 3:\nThe user invoked the skill "same-name", but it is unavailable for this run.',
    );
    expect(prepared.userInvocations.map((invocation) => [invocation.messageId, invocation.skill.ref])).toEqual([
      ['message-owner', ownerSkill.id],
      ['message-writer', writerSkill.id],
      ['message-writer', groupSkill.id],
      ['message-group-repeat', groupSkill.id],
    ]);
    expect(prepared.skills).toHaveLength(1);
    expect(prepared.skills[0]).toMatchObject({ name: 'same-name', description: 'Owner personal' });
  });

  it('materializes two pinned revisions of one managed skill at distinct paths in one batch', async () => {
    const first = {
      ...managed('same-skill', 'First revision', 'first body', 'group', false),
      id: 'managed-skill-id',
      revisionId: 'managed-revision-1',
      revisionNumber: 1,
    };
    const second = {
      ...managed('same-skill', 'Second revision', 'second body', 'group', false),
      id: 'managed-skill-id',
      revisionId: 'managed-revision-2',
      revisionNumber: 2,
    };
    const listForRun = vi.fn(async (request: { invokedRevisions: Array<{ skillId: string; revisionId: string }> }) =>
      request.invokedRevisions.flatMap((selection) =>
        selection.revisionId === first.revisionId
          ? [first]
          : selection.revisionId === second.revisionId
            ? [second]
            : [],
      ),
    );
    const prepared = await preparePiSkills({
      runnerInput: input({
        messages: [
          {
            messageId: 'message-first',
            prompt: 'first',
            skillInvocations: [{ name: first.name, ref: first.id, revisionId: first.revisionId }],
          },
          {
            messageId: 'message-second',
            prompt: 'second',
            skillInvocations: [{ name: second.name, ref: second.id, revisionId: second.revisionId }],
          },
        ],
      }),
      provider: { repoScanEnabled: false, listForRun },
      repositories: [],
    });

    expect(prepared.prompt).toContain('/managed-skill-id/managed-revision-1/same-skill/SKILL.md');
    expect(prepared.prompt).toContain('/managed-skill-id/managed-revision-2/same-skill/SKILL.md');
    expect(prepared.prompt).toContain('first body');
    expect(prepared.prompt).toContain('second body');
    expect(prepared.userInvocations.map(({ skill }) => [skill.skillId, skill.revisionId])).toEqual([
      [first.id, first.revisionId],
      [second.id, second.revisionId],
    ]);
    expect(prepared.event.skills).toEqual([
      expect.objectContaining({ skillId: first.id, revisionId: first.revisionId, revisionNumber: 1 }),
      expect.objectContaining({ skillId: second.id, revisionId: second.revisionId, revisionNumber: 2 }),
    ]);
  });

  it('scans repository roots through one tar attempt and filesystem fallback with root precedence', async () => {
    const fs = new MemorySandboxFileSystem('/workspace');
    await fs.writeFile('/workspace/repo/.agents/skills/review/SKILL.md', skillDocument('review', 'Agents review'));
    await fs.writeFile('/workspace/repo/.claude/skills/review/SKILL.md', skillDocument('review', 'Claude review'));
    await fs.writeFile('/workspace/repo/.pi/skills/release.md', skillDocument('release', 'Release checks', true));
    const execCalls: Parameters<SandboxHandle['exec']>[0][] = [];
    const exec = vi.fn(async (request: Parameters<SandboxHandle['exec']>[0]) => {
      execCalls.push(request);
      if (request.command.includes("printf '%s\\n'")) {
        return execResult(0, '.agents/skills\n.claude/skills\n.pi/skills\n');
      }
      if (request.command.includes('find "$root" -type l')) return execResult(0);
      return execResult(1, '', 'archive unavailable');
    });

    const prepared = await preparePiSkills({
      runnerInput: input({ sandbox: sandbox(fs, exec), skillInvocations: [{ name: 'release' }] }),
      provider: { repoScanEnabled: true, listForRun: async () => [] },
      repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'project' } }],
    });

    expect(exec).toHaveBeenCalledTimes(3);
    expect(execCalls[1]).toMatchObject({ cwd: '/workspace/repo' });
    expect(execCalls[1]?.command).toContain('tar -czf -');
    expect(prepared.event.skills).toEqual([
      { name: 'review', source: 'repo', repo: 'acme/project' },
      {
        name: 'release',
        source: 'repo',
        repo: 'acme/project',
        ref: 'repo:acme/project:release',
        invoked: true,
        advertised: false,
      },
    ]);
    expect(prepared.event.diagnostics).not.toContainEqual(expect.stringContaining('higher-precedence repository root'));
    expect(prepared.skills.find((skill) => skill.name === 'review')).toMatchObject({
      description: 'Agents review',
      filePath: '/workspace/repo/.agents/skills/review/SKILL.md',
      baseDir: '/workspace/repo/.agents/skills/review',
      sourceInfo: {
        path: '/workspace/repo/.agents/skills/review/SKILL.md',
        source: 'repository',
        scope: 'project',
      },
    });
    expect(prepared.skills.find((skill) => skill.name === 'release')).toBeUndefined();
    expect(prepared.prompt).toContain('<skill name="release" location="/workspace/repo/.pi/skills/release.md">');
    expect(prepared.prompt).toContain('References are relative to /workspace/repo/.pi/skills.');
    expect(prepared.prompt).toContain('body\n</skill>');
    expect(prepared.prompt).not.toContain('disable-model-invocation');
  });

  it('loads a valid repository tar mirror without using the filesystem fallback', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-pi-skills-test-'));
    try {
      const sourceDir = path.join(tempDir, 'source');
      const skillDir = path.join(sourceDir, '.agents', 'skills', 'archive-skill');
      const archivePath = path.join(tempDir, 'skills.tar.gz');
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), skillDocument('archive-skill', 'From archive'));
      await execFileAsync('tar', ['-czf', archivePath, '-C', sourceDir, '.agents']);
      const archiveBase64 = (await readFile(archivePath)).toString('base64');
      const fs = new MemorySandboxFileSystem('/workspace');
      await fs.mkdir('/workspace/repo/.agents/skills');
      const controller = new AbortController();
      const calls: Parameters<SandboxHandle['exec']>[0][] = [];
      const exec = vi.fn(async (request: Parameters<SandboxHandle['exec']>[0]) => {
        calls.push(request);
        return request.command.includes("printf '%s\\n'")
          ? execResult(0, '.agents/skills\n')
          : execResult(0, archiveBase64);
      });

      const prepared = await preparePiSkills({
        runnerInput: input({ sandbox: sandbox(undefined, exec), signal: controller.signal }),
        provider: { repoScanEnabled: true, listForRun: async () => [] },
        repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'archive' } }],
      });

      expect(exec).toHaveBeenCalledTimes(3);
      expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
      const archiveCommand = calls.find((call) => call.command.includes('tar -czf -'))?.command ?? '';
      expect(archiveCommand.indexOf('wc -c')).toBeLessThan(archiveCommand.indexOf('tar -czf -'));
      expect(archiveCommand).toContain('[ "$archive_entries" -ge 200 ]');
      expect(archiveCommand).toContain('[ $((archive_bytes + size)) -gt 2097152 ]');
      expect(prepared.event.skills).toEqual([{ name: 'archive-skill', source: 'repo', repo: 'acme/archive' }]);
      expect(prepared.event.diagnostics).not.toContainEqual(expect.stringContaining('filesystem fallback'));
      expect(prepared.skills[0]?.filePath).toBe('/workspace/repo/.agents/skills/archive-skill/SKILL.md');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('discovers repository skills that disable model invocation without advertising them', async () => {
    const fs = new MemorySandboxFileSystem('/workspace');
    await fs.writeFile(
      '/workspace/repo/.agents/skills/manual-only/SKILL.md',
      skillDocument('manual-only', 'Manual only', true),
    );
    const prepared = await preparePiSkills({
      runnerInput: input({
        sandbox: sandbox(fs, async (request) => {
          if (request.command.includes("printf '%s\\n'")) return execResult(0, '.agents/skills\n');
          if (request.command.includes('find "$root" -type l')) return execResult(0);
          return execResult(1, '', 'archive unavailable');
        }),
      }),
      provider: { repoScanEnabled: true, listForRun: async () => [] },
      repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'manual' } }],
    });

    expect(prepared.skills).toEqual([]);
    expect(prepared.event.skills).toEqual([
      {
        name: 'manual-only',
        source: 'repo',
        repo: 'acme/manual',
        ref: 'repo:acme/manual:manual-only',
        advertised: false,
      },
    ]);
  });

  it('keeps the bounded prefix of an archive when its entry cap is reached', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-pi-skills-entry-cap-'));
    try {
      const sourceDir = path.join(tempDir, 'source');
      const skillsDir = path.join(sourceDir, '.agents', 'skills');
      const safePath = path.join(skillsDir, '00-safe.md');
      const archivePath = path.join(tempDir, 'skills.tar.gz');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(safePath, skillDocument('safe', 'Safe'));
      const archiveEntries = ['.agents/skills/00-safe.md'];
      for (let index = 0; index < 200; index += 1) {
        const name = `entry-${String(index).padStart(3, '0')}`;
        await writeFile(path.join(skillsDir, `${name}.md`), skillDocument(name, name));
        archiveEntries.push(`.agents/skills/${name}.md`);
      }
      await execFileAsync('tar', ['-czf', archivePath, '-C', sourceDir, ...archiveEntries]);
      const archiveBase64 = (await readFile(archivePath)).toString('base64');

      const prepared = await preparePiSkills({
        runnerInput: input({
          sandbox: sandbox(undefined, async (request) =>
            request.command.includes("printf '%s\\n'")
              ? execResult(0, '.agents/skills\n')
              : execResult(0, archiveBase64),
          ),
        }),
        provider: { repoScanEnabled: true, listForRun: async () => [] },
        repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'entries' } }],
      });

      expect(prepared.event.skills).toContainEqual({ name: 'safe', source: 'repo', repo: 'acme/entries' });
      expect(prepared.event.diagnostics).toContain('Repository skill archive was limited to 200 entries.');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses real exec to transfer valid skills while skipping unsafe repository entries', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-pi-skills-exec-'));
    try {
      const repositoryPath = path.join(tempDir, 'repo');
      const skillDir = path.join(repositoryPath, '.agents', 'skills', 'exec-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), skillDocument('exec-skill', 'Exec only'));
      await writeFile(
        path.join(repositoryPath, '.agents', 'skills', 'oversized.md'),
        `---\nname: oversized\ndescription: oversized\n---\n${'x'.repeat(256 * 1024)}`,
      );
      await symlink('/etc/passwd', path.join(repositoryPath, '.agents', 'skills', 'unsafe-link'));
      const exec: SandboxHandle['exec'] = async (request) => {
        try {
          const result = await execFileAsync('/bin/sh', ['-c', request.command], {
            cwd: request.cwd,
            timeout: request.timeoutMs,
            signal: request.signal,
            maxBuffer: 5 * 1024 * 1024,
          });
          return execResult(0, result.stdout, result.stderr);
        } catch (error) {
          const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
          return execResult(typeof failed.code === 'number' ? failed.code : 1, failed.stdout, failed.stderr);
        }
      };

      const prepared = await preparePiSkills({
        runnerInput: input({ sandbox: sandbox(undefined, exec, tempDir) }),
        provider: { repoScanEnabled: true, listForRun: async () => [] },
        repositories: [{ workspacePath: repositoryPath, repository: { owner: 'acme', repo: 'exec' } }],
      });

      expect(prepared.event.skills).toEqual([{ name: 'exec-skill', source: 'repo', repo: 'acme/exec' }]);
      expect(prepared.event.diagnostics).toContain('A repository skill symlink was skipped.');
      expect(prepared.event.diagnostics).toContain(
        'A repository skill file exceeded the per-file size limit and was skipped.',
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces repository skill count and file-size caps', async () => {
    const fs = new MemorySandboxFileSystem('/workspace');
    for (let index = 0; index < 51; index += 1) {
      const name = `skill-${String(index).padStart(2, '0')}`;
      await fs.writeFile(`/workspace/repo/.agents/skills/${name}.md`, skillDocument(name, name));
    }
    await fs.writeFile(
      '/workspace/repo/.agents/skills/oversized/SKILL.md',
      `---\nname: oversized\ndescription: too large\n---\n${'x'.repeat(256 * 1024)}`,
    );

    const prepared = await preparePiSkills({
      runnerInput: input({
        sandbox: sandbox(fs, async (request) => {
          if (request.command.includes("printf '%s\\n'")) return execResult(0, '.agents/skills\n');
          if (request.command.includes('find "$root" -type l')) return execResult(0);
          return execResult(1, '', 'no archive');
        }),
      }),
      provider: { repoScanEnabled: true, listForRun: async () => [] },
      repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'large' } }],
    });

    expect(prepared.event.skills).toHaveLength(50);
    expect(prepared.event.diagnostics).toContain('Repository skill discovery was limited to 50 skills.');
    expect(prepared.event.diagnostics).toContain(
      'A repository skill file exceeded the per-file size limit and was skipped.',
    );
  });

  it('preserves earlier filesystem skills when the repository byte cap is reached', async () => {
    const fs = new MemorySandboxFileSystem('/workspace');
    await fs.writeFile('/workspace/repo/.agents/skills/00-valid.md', skillDocument('valid', 'Valid'));
    for (let index = 0; index < 9; index += 1) {
      const name = `bulk-${index}`;
      await fs.writeFile(
        `/workspace/repo/.agents/skills/${name}/SKILL.md`,
        `${skillDocument(name, name)}${'x'.repeat(240 * 1024)}`,
      );
    }

    const prepared = await preparePiSkills({
      runnerInput: input({
        sandbox: sandbox(fs, async (request) => {
          if (request.command.includes("printf '%s\\n'")) return execResult(0, '.agents/skills\n');
          if (request.command.includes('find "$root" -type l')) return execResult(0);
          return execResult(1, '', 'no archive');
        }),
      }),
      provider: { repoScanEnabled: true, listForRun: async () => [] },
      repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'bytes' } }],
    });

    expect(prepared.event.skills).toContainEqual({ name: 'valid', source: 'repo', repo: 'acme/bytes' });
    expect(prepared.event.skills.length).toBeGreaterThan(1);
    expect(prepared.event.skills.length).toBeLessThan(10);
    expect(prepared.event.diagnostics).toContain('Repository skill discovery reached the repository byte limit.');
  });

  it('uses exec materialization without a filesystem and degrades provider failures non-fatally', async () => {
    const calls: Array<{ command: string; stdin?: string }> = [];
    const noFsSandbox = sandbox(
      undefined,
      async (request) => {
        calls.push({ command: request.command, ...(request.stdin ? { stdin: request.stdin } : {}) });
        return execResult(0);
      },
      '/agent/workspace',
    );
    const materialized = await preparePiSkills({
      runnerInput: input({ sandbox: noFsSandbox }),
      provider: { repoScanEnabled: false, listForRun: async () => [managed('safe', 'Safe skill', 'body', 'group')] },
      repositories: [],
    });

    expect(calls[0]?.command).toContain("'/agent/workspace/.deputies-skills'");
    expect(calls[1]?.command).toContain("printf '%s'");
    expect(calls[1]?.command).toContain('description: "Safe skill"');
    expect(calls[1]).not.toHaveProperty('stdin');
    expect(materialized.skills[0]?.filePath).toBe(
      '/agent/workspace/.deputies-skills/group/skill-group-safe-1768435200000/revision-group-safe-1768435200000/safe/SKILL.md',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const degraded = await preparePiSkills({
        runnerInput: input(),
        provider: {
          repoScanEnabled: false,
          async listForRun() {
            throw new Error('database password should not leak');
          },
        },
        repositories: [],
      });
      expect(degraded.skills).toEqual([]);
      expect(degraded.event.diagnostics).toEqual(['Managed skills could not be resolved for this run.']);
      expect(JSON.stringify(degraded.event)).not.toContain('database password');
      expect(warn).toHaveBeenCalledWith(
        'Skill loading degraded during managed skill resolution; affected skills were skipped.',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps auto-loaded personal skills associated with the session creator', async () => {
    const listForRun = vi.fn(async () => [
      managed('private', 'Private', 'private', 'personal'),
      managed('group-safe', 'Group safe', 'group', 'group'),
    ]);
    const prepared = await preparePiSkills({
      runnerInput: input({
        createdByUserId: 'owner',
        messages: [
          { prompt: 'owner message', authorUserId: 'owner' },
          { prompt: 'group writer message', authorUserId: 'writer' },
        ],
      }),
      provider: { repoScanEnabled: false, listForRun },
      repositories: [],
    });

    expect(listForRun).toHaveBeenCalledWith({
      ownerGroupId: 'group-1',
      createdByUserId: 'owner',
      invokedNames: [],
      invokedRevisions: [],
    });
    expect(prepared.event.skills).toEqual([
      expect.objectContaining({ name: 'private', source: 'personal', revisionNumber: 1 }),
      expect.objectContaining({ name: 'group-safe', source: 'group', revisionNumber: 1 }),
    ]);
  });

  it('retries cleanup and materialization through exec and isolates cleanup double failures', async () => {
    const cleanupFs = new MemorySandboxFileSystem('/workspace');
    cleanupFs.rm = vi.fn(async () => {
      throw new Error('filesystem cleanup failed');
    });
    const cleanupExec = vi.fn(async () => execResult(0));
    const cleaned = await preparePiSkills({
      runnerInput: input({ sandbox: sandbox(cleanupFs, cleanupExec) }),
      provider: { repoScanEnabled: false, listForRun: async () => [managed('cleaned', 'Cleaned', 'body', 'group')] },
      repositories: [],
    });
    expect(cleanupExec).toHaveBeenCalledTimes(1);
    expect(cleaned.skills[0]?.filePath).toBe(
      '/workspace/.deputies-skills/group/skill-group-cleaned-1768435200000/revision-group-cleaned-1768435200000/cleaned/SKILL.md',
    );

    const isolatedFs = new MemorySandboxFileSystem('/workspace');
    isolatedFs.rm = vi.fn(async () => {
      throw new Error('filesystem cleanup failed');
    });
    const isolated = await preparePiSkills({
      runnerInput: input({ sandbox: sandbox(isolatedFs, async () => execResult(1)) }),
      provider: { repoScanEnabled: false, listForRun: async () => [managed('isolated', 'Isolated', 'body', 'group')] },
      repositories: [],
    });
    expect(isolated.skills[0]?.filePath).toMatch(
      /^\/workspace\/\.deputies-skills-run-1-[0-9a-f-]+\/group\/skill-group-isolated-1768435200000\/revision-group-isolated-1768435200000\/isolated\/SKILL\.md$/,
    );
    expect(isolated.event.diagnostics).toContain(
      'The managed skill directory could not be cleared; an isolated run directory was used.',
    );

    const writeFs = new MemorySandboxFileSystem('/workspace');
    writeFs.writeFile = vi.fn(async () => {
      throw new Error('filesystem write failed');
    });
    const writeExec = vi.fn(async (_request: Parameters<SandboxHandle['exec']>[0]) => execResult(0));
    const written = await preparePiSkills({
      runnerInput: input({ sandbox: sandbox(writeFs, writeExec) }),
      provider: { repoScanEnabled: false, listForRun: async () => [managed('written', 'Written', 'body', 'group')] },
      repositories: [],
    });
    expect(writeExec).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("printf '%s'") }),
    );
    expect(writeExec.mock.calls[0]?.[0].stdin).toBeUndefined();
    expect(written.skills[0]?.filePath).toBe(
      '/workspace/.deputies-skills/group/skill-group-written-1768435200000/revision-group-written-1768435200000/written/SKILL.md',
    );
  });

  it('skips fallback symlinks without reading them or dropping valid skills', async () => {
    const fs = new MemorySandboxFileSystem('/workspace');
    await fs.writeFile('/workspace/repo/.agents/skills/safe/SKILL.md', skillDocument('safe', 'Safe'));
    fs.markSymlink('/workspace/repo/.agents/skills/link');
    const read = vi.spyOn(fs, 'readFileBuffer');
    const prepared = await preparePiSkills({
      runnerInput: input({
        sandbox: sandbox(fs, async (request) => {
          if (request.command.includes("printf '%s\\n'")) return execResult(0, '.agents/skills\n');
          if (request.command.includes('find "$root" -type l')) {
            return execResult(0, Buffer.from('.agents/skills/link\0').toString('base64'));
          }
          return execResult(1, '', 'archive unavailable');
        }),
      }),
      provider: { repoScanEnabled: true, listForRun: async () => [] },
      repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'linked' } }],
    });

    expect(prepared.event.skills).toEqual([{ name: 'safe', source: 'repo', repo: 'acme/linked' }]);
    expect(read).not.toHaveBeenCalledWith('/workspace/repo/.agents/skills/link');
    expect(prepared.event.diagnostics).toContain('A repository skill symlink was skipped.');
  });

  it('skips non-directory fallback roots without dropping later valid roots', async () => {
    const fs = new MemorySandboxFileSystem('/workspace');
    await fs.writeFile('/workspace/repo/.agents/skills', 'not a directory');
    await fs.writeFile('/workspace/repo/.claude/skills/safe/SKILL.md', skillDocument('safe', 'Safe skill'));

    const prepared = await preparePiSkills({
      runnerInput: input({
        sandbox: sandbox(fs, async (request) =>
          request.command.includes('find "$root" -type l') ? execResult(0) : execResult(1, '', 'exec unavailable'),
        ),
      }),
      provider: { repoScanEnabled: true, listForRun: async () => [] },
      repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'roots' } }],
    });

    expect(prepared.event.skills).toEqual([{ name: 'safe', source: 'repo', repo: 'acme/roots' }]);
  });
});
