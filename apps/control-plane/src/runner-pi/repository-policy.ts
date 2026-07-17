import path from 'node:path';
import { abortError, addDiagnostic, rethrowIfAborted, throwIfAborted } from './skill-utils.js';

export const REPO_SKILL_ROOTS = ['.agents/skills', '.claude/skills', '.pi/skills'] as const;
export const IGNORE_FILE_NAMES = new Set(['.gitignore', '.ignore', '.fdignore']);
export const MAX_SKILLS_PER_REPO = 50;
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_REPO_BYTES = 2 * 1024 * 1024;
export const MAX_ARCHIVE_STDOUT_BYTES = 4 * 1024 * 1024;
export const MAX_UNCOMPRESSED_ARCHIVE_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 200;
export const MAX_MIRROR_VISITED_ENTRIES = 2_000;
export const MAX_MIRROR_DEPTH = 32;
export const MAX_MIRROR_WALK_MS = 30_000;
export const SKIPPED_SYMLINK_DIAGNOSTIC = 'A repository skill symlink was skipped.';
export const SKIPPED_OVERSIZED_DIAGNOSTIC = 'A repository skill file exceeded the per-file size limit and was skipped.';
export const ARCHIVE_ENTRY_CAP_DIAGNOSTIC = `Repository skill archive was limited to ${MAX_ARCHIVE_ENTRIES} entries.`;
export const MIRROR_ENTRY_CAP_DIAGNOSTIC = `Repository skill traversal was limited to ${MAX_MIRROR_VISITED_ENTRIES} entries.`;
export const REPO_BYTE_CAP_DIAGNOSTIC = 'Repository skill discovery reached the repository byte limit.';
export const SKIPPED_UNREADABLE_DIAGNOSTIC = 'A repository skill entry could not be read and was skipped.';

export type MirrorBudget = {
  skills: number;
  bytes: number;
  visited: number;
  deadline: number;
  signal: AbortSignal | undefined;
  cappedSkills: boolean;
  cappedBytes: boolean;
  cappedEntries: boolean;
};

export function createMirrorBudget(signal: AbortSignal | undefined): MirrorBudget {
  return {
    skills: 0,
    bytes: 0,
    visited: 0,
    deadline: Date.now() + MAX_MIRROR_WALK_MS,
    signal,
    cappedSkills: false,
    cappedBytes: false,
    cappedEntries: false,
  };
}

export function takeMirrorEntries(budget: MirrorBudget, names: string[]): string[] {
  assertMirrorTraversal(budget, 0);
  const remaining = MAX_MIRROR_VISITED_ENTRIES - budget.visited;
  if (names.length > remaining) budget.cappedEntries = true;
  const selected = names.slice(0, Math.max(0, remaining));
  budget.visited += selected.length;
  selected.sort();
  return selected;
}

export function canReadMirrorFile(relative: string, size: number, budget: MirrorBudget): boolean {
  if (isSkillFile(relative) && budget.skills >= MAX_SKILLS_PER_REPO) {
    budget.cappedSkills = true;
    return false;
  }
  if (budget.bytes + size > MAX_REPO_BYTES) {
    budget.cappedBytes = true;
    return false;
  }
  return true;
}

export function mirrorBudgetStopped(budget: MirrorBudget): boolean {
  return budget.cappedSkills || budget.cappedBytes;
}

export function assertMirrorTraversal(budget: MirrorBudget, depth: number): void {
  throwIfAborted(budget.signal);
  if (depth > MAX_MIRROR_DEPTH) throw new Error('repository skill traversal exceeded the depth limit');
  if (Date.now() > budget.deadline) throw new Error('repository skill traversal exceeded the time limit');
}

export async function boundedMirrorOperation<T>(operation: () => Promise<T>, budget: MirrorBudget): Promise<T> {
  assertMirrorTraversal(budget, 0);
  const remainingMs = Math.max(1, budget.deadline - Date.now());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      budget.signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(abortError()));
    const timer = setTimeout(
      () => finish(() => reject(new Error('repository skill traversal exceeded the time limit'))),
      remainingMs,
    );
    budget.signal?.addEventListener('abort', abort, { once: true });
    if (budget.signal?.aborted) {
      abort();
      return;
    }
    operation().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

export async function isolateMirrorEntry<T>(
  operation: () => Promise<T>,
  budget: MirrorBudget,
  diagnostics: string[],
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    rethrowMirrorBoundaryError(error, budget.signal);
    addDiagnostic(diagnostics, SKIPPED_UNREADABLE_DIAGNOSTIC);
    return undefined;
  }
}

export function rethrowMirrorBoundaryError(error: unknown, signal: AbortSignal | undefined): void {
  rethrowIfAborted(error, signal);
  if (error instanceof Error && error.message.startsWith('repository skill traversal exceeded')) throw error;
}

export function reserveMirrorFile(
  relative: string,
  size: number,
  budget: MirrorBudget,
  diagnostics: string[],
): boolean {
  const isSkill = isSkillFile(relative);
  if (size > MAX_SKILL_FILE_BYTES) {
    addDiagnostic(diagnostics, SKIPPED_OVERSIZED_DIAGNOSTIC);
    return false;
  }
  if (isSkill && budget.skills >= MAX_SKILLS_PER_REPO) {
    budget.cappedSkills = true;
    return false;
  }
  if (budget.bytes + size > MAX_REPO_BYTES) {
    budget.cappedBytes = true;
    return false;
  }
  if (isSkill) budget.skills += 1;
  budget.bytes += size;
  return true;
}

function isSkillFile(relative: string): boolean {
  const normalized = relative.split(path.sep).join('/');
  return path.posix.basename(normalized) === 'SKILL.md' || (!normalized.includes('/') && normalized.endsWith('.md'));
}

export function addCapDiagnostics(budget: MirrorBudget, diagnostics: string[]): void {
  if (budget.cappedSkills)
    addDiagnostic(diagnostics, `Repository skill discovery was limited to ${MAX_SKILLS_PER_REPO} skills.`);
  if (budget.cappedBytes) addDiagnostic(diagnostics, REPO_BYTE_CAP_DIAGNOSTIC);
  if (budget.cappedEntries) addDiagnostic(diagnostics, MIRROR_ENTRY_CAP_DIAGNOSTIC);
}
