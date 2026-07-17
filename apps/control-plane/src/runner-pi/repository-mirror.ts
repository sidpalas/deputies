import path from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createSyntheticSourceInfo, loadSkillsFromDir, type Skill } from '@earendil-works/pi-coding-agent';
import type { SandboxFileSystem, SandboxHandle } from '../sandbox/types.js';
import { findSandboxMirrorSymlinks, mirrorRepositoryArchive } from './repository-archive.js';
import {
  IGNORE_FILE_NAMES,
  MAX_MIRROR_VISITED_ENTRIES,
  MAX_SKILL_FILE_BYTES,
  REPO_SKILL_ROOTS,
  SKIPPED_OVERSIZED_DIAGNOSTIC,
  SKIPPED_SYMLINK_DIAGNOSTIC,
  addCapDiagnostics,
  assertMirrorTraversal,
  boundedMirrorOperation,
  canReadMirrorFile,
  createMirrorBudget,
  isolateMirrorEntry,
  mirrorBudgetStopped,
  reserveMirrorFile,
  rethrowMirrorBoundaryError,
  takeMirrorEntries,
  type MirrorBudget,
} from './repository-policy.js';
import type { SkillRepositoryPlan } from './skill-types.js';
import {
  addDiagnostic,
  localRootPath,
  rethrowIfAborted,
  shellQuote,
  throwIfAborted,
  toPosixRelative,
  warnSkillDegradation,
} from './skill-utils.js';

export async function scanRepositorySkills(
  sandbox: SandboxHandle,
  repository: SkillRepositoryPlan,
  diagnostics: string[],
  signal: AbortSignal | undefined,
): Promise<Array<{ skill: Skill; content: string }>> {
  const roots = await discoverRepositorySkillRoots(sandbox, repository.workspacePath, signal);
  if (!roots.length) return [];

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-pi-skills-'));
  const stagingDir = path.join(tempDir, 'staging');
  const mirrorDir = path.join(tempDir, 'mirror');
  try {
    await mkdir(stagingDir, { recursive: true });
    await mkdir(mirrorDir, { recursive: true });
    try {
      // The shell archive is only a transport optimization; staged and direct filesystems
      // both pass through the same bounded mirror policy below.
      await mirrorRepositoryArchive(sandbox, repository.workspacePath, roots, stagingDir, diagnostics, signal);
      await copyBoundedLocalMirror(stagingDir, mirrorDir, roots, diagnostics, signal);
    } catch (error) {
      rethrowIfAborted(error, signal);
      if (!sandbox.fs) throw error;
      diagnostics.push(
        `Repository skill archive transfer for ${repository.repository.owner}/${repository.repository.repo} was unavailable; filesystem fallback was used.`,
      );
      const symlinks = await findSandboxMirrorSymlinks(sandbox, repository.workspacePath, roots, signal);
      await rm(mirrorDir, { recursive: true, force: true });
      await mkdir(mirrorDir, { recursive: true });
      await copyBoundedSandboxMirror(
        sandbox.fs,
        repository.workspacePath,
        mirrorDir,
        roots,
        symlinks,
        diagnostics,
        signal,
      );
    }

    const skills: Array<{ skill: Skill; content: string }> = [];
    const names = new Set<string>();
    for (const root of roots) {
      const mirrorRoot = localRootPath(mirrorDir, root);
      const loaded = loadSkillsFromDir({ dir: mirrorRoot, source: 'path' });
      diagnostics.push(...loaded.diagnostics.map((diagnostic) => `Repository skill: ${diagnostic.message}`));
      for (const skill of loaded.skills) {
        if (names.has(skill.name)) {
          continue;
        }
        names.add(skill.name);
        const relativeFile = toPosixRelative(mirrorRoot, skill.filePath);
        const relativeBase = toPosixRelative(mirrorRoot, skill.baseDir);
        const sandboxRoot = path.posix.join(repository.workspacePath, root);
        const filePath = path.posix.join(sandboxRoot, relativeFile);
        const baseDir = path.posix.join(sandboxRoot, relativeBase);
        skills.push({
          content: await readFile(skill.filePath, 'utf8'),
          skill: {
            ...skill,
            filePath,
            baseDir,
            sourceInfo: createSyntheticSourceInfo(filePath, {
              source: 'repository',
              scope: 'project',
              baseDir,
            }),
          },
        });
      }
    }
    return skills;
  } catch (error) {
    rethrowIfAborted(error, signal);
    warnSkillDegradation('repository skill scan');
    diagnostics.push(
      `Repository skills in ${repository.repository.owner}/${repository.repository.repo} could not be loaded.`,
    );
    return [];
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function discoverRepositorySkillRoots(
  sandbox: SandboxHandle,
  workspacePath: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  throwIfAborted(signal);
  const command = REPO_SKILL_ROOTS.map(
    (root) => `[ ! -d ${shellQuote(root)} ] || printf '%s\\n' ${shellQuote(root)}`,
  ).join('\n');
  try {
    const result = await sandbox.exec({
      command,
      cwd: workspacePath,
      timeoutMs: 10_000,
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) throw new Error('repository skill root discovery failed');
    const allowed = new Set<string>(REPO_SKILL_ROOTS);
    return [...new Set(result.stdout.split(/\r?\n/).filter((root) => allowed.has(root)))];
  } catch (error) {
    rethrowIfAborted(error, signal);
    if (!sandbox.fs) throw error;
  }

  const roots: string[] = [];
  const budget = createMirrorBudget(signal);
  for (const root of REPO_SKILL_ROOTS) {
    throwIfAborted(signal);
    try {
      const rootPath = path.posix.join(workspacePath, root);
      if (!(await boundedMirrorOperation(() => sandbox.fs!.exists(rootPath), budget))) continue;
      const stat = await boundedMirrorOperation(() => sandbox.fs!.stat(rootPath), budget);
      if (stat.isDirectory && !stat.isSymbolicLink) roots.push(root);
    } catch (error) {
      rethrowMirrorBoundaryError(error, signal);
    }
  }
  return roots;
}

async function copyBoundedLocalMirror(
  stagingDir: string,
  mirrorDir: string,
  roots: string[],
  diagnostics: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  await copyBoundedMirror(localMirrorFileSystem(), stagingDir, mirrorDir, roots, diagnostics, signal);
}

async function copyBoundedSandboxMirror(
  fs: SandboxFileSystem,
  workspacePath: string,
  mirrorDir: string,
  roots: string[],
  symlinks: Set<string>,
  diagnostics: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  await copyBoundedMirror(sandboxMirrorFileSystem(fs, symlinks), workspacePath, mirrorDir, roots, diagnostics, signal);
}

type MirrorEntry = {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  size: number;
};

type RepositoryMirrorFileSystem = {
  join(...segments: string[]): string;
  relative(from: string, to: string): string;
  readdir(filePath: string, budget: MirrorBudget): Promise<string[]>;
  stat(filePath: string, budget: MirrorBudget): Promise<MirrorEntry>;
  readFile(filePath: string, budget: MirrorBudget): Promise<Uint8Array>;
};

function localMirrorFileSystem(): RepositoryMirrorFileSystem {
  return {
    join: (...segments) => path.join(...segments),
    relative: (from, to) => path.relative(from, to),
    readdir: (filePath) => readdir(filePath),
    async stat(filePath) {
      const stat = await lstat(filePath);
      return {
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
        size: stat.size,
      };
    },
    readFile,
  };
}

function sandboxMirrorFileSystem(fs: SandboxFileSystem, symlinks: Set<string>): RepositoryMirrorFileSystem {
  return {
    join: (...segments) => path.posix.join(...segments),
    relative: (from, to) => path.posix.relative(from, to),
    readdir: (filePath, budget) => boundedMirrorOperation(() => fs.readdir(filePath), budget),
    async stat(filePath, budget) {
      if (symlinks.has(filePath)) return { isDirectory: false, isFile: false, isSymbolicLink: true, size: 0 };
      const stat = await boundedMirrorOperation(() => fs.stat(filePath), budget);
      return {
        isDirectory: stat.isDirectory,
        isFile: stat.isFile,
        isSymbolicLink: stat.isSymbolicLink,
        size: stat.size,
      };
    },
    readFile: (filePath, budget) => boundedMirrorOperation(() => fs.readFileBuffer(filePath), budget),
  };
}

async function copyBoundedMirror(
  fs: RepositoryMirrorFileSystem,
  sourceBase: string,
  mirrorDir: string,
  roots: string[],
  diagnostics: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const budget = createMirrorBudget(signal);
  for (const root of roots) {
    if (mirrorBudgetStopped(budget)) break;
    const sourceRoot = fs.join(sourceBase, ...root.split('/'));
    const rootStat = await isolateMirrorEntry(() => fs.stat(sourceRoot, budget), budget, diagnostics);
    if (!rootStat) continue;
    if (rootStat.isSymbolicLink) {
      addDiagnostic(diagnostics, SKIPPED_SYMLINK_DIAGNOSTIC);
      continue;
    }
    if (!rootStat.isDirectory) continue;
    await isolateMirrorEntry(
      () => walkMirror(fs, sourceRoot, sourceRoot, localRootPath(mirrorDir, root), budget, diagnostics, true, 0),
      budget,
      diagnostics,
    );
  }
  addCapDiagnostics(budget, diagnostics);
}

async function walkMirror(
  fs: RepositoryMirrorFileSystem,
  root: string,
  current: string,
  destinationRoot: string,
  budget: MirrorBudget,
  diagnostics: string[],
  includeRootFiles: boolean,
  depth: number,
): Promise<void> {
  assertMirrorTraversal(budget, depth);
  if (mirrorBudgetStopped(budget)) return;
  if (budget.visited >= MAX_MIRROR_VISITED_ENTRIES) {
    budget.cappedEntries = true;
    return;
  }
  const names = takeMirrorEntries(budget, await fs.readdir(current, budget));

  for (const name of names.filter((entry) => IGNORE_FILE_NAMES.has(entry))) {
    await isolateMirrorEntry(
      () => copyMirrorFile(fs, root, fs.join(current, name), destinationRoot, budget, diagnostics),
      budget,
      diagnostics,
    );
    if (mirrorBudgetStopped(budget)) return;
  }

  if (names.includes('SKILL.md')) {
    const skillPath = fs.join(current, 'SKILL.md');
    const skillStat = await isolateMirrorEntry(() => fs.stat(skillPath, budget), budget, diagnostics);
    if (!skillStat) return;
    if (skillStat.isSymbolicLink) {
      addDiagnostic(diagnostics, SKIPPED_SYMLINK_DIAGNOSTIC);
    } else if (
      skillStat.isFile &&
      (await copyMirrorFile(fs, root, skillPath, destinationRoot, budget, diagnostics, skillStat))
    ) {
      return;
    }
  }

  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const source = fs.join(current, name);
    const stat = await isolateMirrorEntry(() => fs.stat(source, budget), budget, diagnostics);
    if (!stat) continue;
    if (stat.isSymbolicLink) {
      addDiagnostic(diagnostics, SKIPPED_SYMLINK_DIAGNOSTIC);
      continue;
    }
    if (stat.isDirectory) {
      await isolateMirrorEntry(
        () => walkMirror(fs, root, source, destinationRoot, budget, diagnostics, false, depth + 1),
        budget,
        diagnostics,
      );
      if (mirrorBudgetStopped(budget)) return;
      continue;
    }
    if (!stat.isFile || !includeRootFiles || !name.endsWith('.md')) continue;
    await isolateMirrorEntry(
      () => copyMirrorFile(fs, root, source, destinationRoot, budget, diagnostics, stat),
      budget,
      diagnostics,
    );
    if (mirrorBudgetStopped(budget)) return;
  }
}

async function copyMirrorFile(
  fs: RepositoryMirrorFileSystem,
  root: string,
  source: string,
  destinationRoot: string,
  budget: MirrorBudget,
  diagnostics: string[],
  knownStat?: MirrorEntry,
): Promise<boolean> {
  assertMirrorTraversal(budget, 0);
  const stat = knownStat ?? (await fs.stat(source, budget));
  if (stat.isSymbolicLink) {
    addDiagnostic(diagnostics, SKIPPED_SYMLINK_DIAGNOSTIC);
    return false;
  }
  if (!stat.isFile) return false;
  if (stat.size > MAX_SKILL_FILE_BYTES) {
    addDiagnostic(diagnostics, SKIPPED_OVERSIZED_DIAGNOSTIC);
    return false;
  }
  const relative = fs.relative(root, source);
  if (!canReadMirrorFile(relative, stat.size, budget)) return false;
  const content = await fs.readFile(source, budget);
  if (!reserveMirrorFile(relative, content.byteLength, budget, diagnostics)) return false;
  const destination = path.join(destinationRoot, ...relative.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
  return true;
}
