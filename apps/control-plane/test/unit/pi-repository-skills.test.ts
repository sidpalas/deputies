import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { preparePiSkills } from '../../src/runner-pi/skills.js';
import {
  execResult,
  MemorySandboxFileSystem,
  runnerInput,
  sandboxHandle,
  skillDocument,
} from '../support/pi-skills.js';

const execFileAsync = promisify(execFile);

describe('Pi repository skill walker', () => {
  it('applies the same pruning policy to the sandbox filesystem fallback', async () => {
    const fs = new MemorySandboxFileSystem('/workspace');
    await fs.writeFile('/workspace/repo/.agents/skills/review/SKILL.md', skillDocument('review', 'Review'));
    await fs.writeFile(
      '/workspace/repo/.agents/skills/review/nested/SKILL.md',
      skillDocument('nested', 'Must not load'),
    );
    await fs.writeFile(
      '/workspace/repo/.agents/skills/.hidden/hidden/SKILL.md',
      skillDocument('hidden', 'Must not load'),
    );
    await fs.writeFile(
      '/workspace/repo/.agents/skills/node_modules/dependency/SKILL.md',
      skillDocument('dependency', 'Must not load'),
    );
    await fs.writeFile(
      '/workspace/repo/.agents/skills/oversized.md',
      `---\nname: oversized\ndescription: too large\n---\n${'x'.repeat(256 * 1024)}`,
    );
    const originalStat = fs.stat.bind(fs);
    fs.stat = async (filePath) => {
      const stat = await originalStat(filePath);
      return filePath.endsWith('/oversized.md') ? { ...stat, size: 1 } : stat;
    };

    const prepared = await preparePiSkills({
      runnerInput: runnerInput({
        sandbox: sandboxHandle(fs, async (request) => {
          if (request.command.includes("printf '%s\\n'")) return execResult(0, '.agents/skills\n');
          if (request.command.includes('find "$root" -type l')) return execResult(0);
          return execResult(1, '', 'archive unavailable');
        }),
      }),
      provider: { repoScanEnabled: true, listForRun: async () => [] },
      repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'pruned' } }],
    });

    expect(prepared.event.skills).toEqual([{ name: 'review', source: 'repo', repo: 'acme/pruned' }]);
    expect(prepared.event.diagnostics).toContain(
      'A repository skill file exceeded the per-file size limit and was skipped.',
    );
  });

  it('rejects oversized archive entries and bounds filesystem traversal', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-pi-skills-oversized-'));
    try {
      const sourceDir = path.join(tempDir, 'source');
      const skillDir = path.join(sourceDir, '.agents', 'skills', 'oversized');
      const archivePath = path.join(tempDir, 'skills.tar.gz');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: oversized\ndescription: oversized\n---\n${'x'.repeat(256 * 1024)}`,
      );
      const safeDir = path.join(sourceDir, '.agents', 'skills', 'safe');
      await mkdir(safeDir, { recursive: true });
      await writeFile(path.join(safeDir, 'SKILL.md'), skillDocument('safe', 'Safe'));
      for (let index = 0; index < 9; index += 1) {
        const name = `bulk-${index}`;
        await writeFile(
          path.join(sourceDir, '.agents', 'skills', `${name}.md`),
          `${skillDocument(name, name)}${'x'.repeat(240 * 1024)}`,
        );
      }
      await execFileAsync('tar', ['-czf', archivePath, '-C', sourceDir, '.agents']);
      const archiveBase64 = (await readFile(archivePath)).toString('base64');
      const archived = await preparePiSkills({
        runnerInput: runnerInput({
          sandbox: sandboxHandle(undefined, async (request) => {
            if (request.command.includes("printf '%s\\n'")) return execResult(0, '.agents/skills\n');
            if (request.command.includes('tar -czf -')) return execResult(0, archiveBase64);
            return execResult(0);
          }),
        }),
        provider: { repoScanEnabled: true, listForRun: async () => [] },
        repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'oversized' } }],
      });
      expect(archived.event.skills).toContainEqual({ name: 'safe', source: 'repo', repo: 'acme/oversized' });
      expect(archived.event.skills.length).toBeGreaterThan(1);
      expect(archived.event.skills.length).toBeLessThan(10);
      expect(archived.event.diagnostics).toContain(
        'A repository skill file exceeded the per-file size limit and was skipped.',
      );
      expect(archived.event.diagnostics).toContain('Repository skill discovery reached the repository byte limit.');

      const fs = new MemorySandboxFileSystem('/workspace');
      await fs.writeFile('/workspace/repo/.agents/skills/00-safe.md', skillDocument('safe', 'Safe'));
      for (let index = 0; index <= 2_000; index += 1) {
        await fs.mkdir(`/workspace/repo/.agents/skills/entry-${index}`);
      }
      const traversed = await preparePiSkills({
        runnerInput: runnerInput({
          sandbox: sandboxHandle(fs, async (request) => {
            if (request.command.includes("printf '%s\\n'")) return execResult(0, '.agents/skills\n');
            if (request.command.includes('find "$root" -type l')) return execResult(0);
            return execResult(1, '', 'archive unavailable');
          }),
        }),
        provider: { repoScanEnabled: true, listForRun: async () => [] },
        repositories: [{ workspacePath: '/workspace/repo', repository: { owner: 'acme', repo: 'wide' } }],
      });
      expect(traversed.event.skills).toEqual([{ name: 'safe', source: 'repo', repo: 'acme/wide' }]);
      expect(traversed.event.diagnostics).toContain('Repository skill traversal was limited to 2000 entries.');
      expect(traversed.event.diagnostics).not.toContain('Repository skills in acme/wide could not be loaded.');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
