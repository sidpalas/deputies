import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunnerInput } from '../runner/types.js';
import type { SandboxHandle } from '../sandbox/types.js';
import type { ManagedSkillCandidate } from './skill-types.js';
import { rethrowIfAborted, safePathSegment, shellQuote, throwIfAborted, warnSkillDegradation } from './skill-utils.js';

const MANAGED_SKILLS_DIR = '.deputies-skills';

export function serializeManagedSkill(candidate: Pick<ManagedSkillCandidate, 'name' | 'description' | 'body'>): string {
  return `---\nname: ${JSON.stringify(candidate.name)}\ndescription: ${JSON.stringify(candidate.description)}\n---\n${candidate.body}`;
}

export async function clearManagedSkillsRoot(input: RunnerInput, diagnostics: string[]): Promise<string> {
  const sandbox = input.sandbox;
  const managedRoot = path.posix.join(sandbox.workspacePath, MANAGED_SKILLS_DIR);
  throwIfAborted(input.signal);
  try {
    if (sandbox.fs) {
      await sandbox.fs.rm(managedRoot, { recursive: true, force: true });
      await sandbox.fs.mkdir(managedRoot, { recursive: true });
      return managedRoot;
    }
  } catch (error) {
    rethrowIfAborted(error, input.signal);
  }

  try {
    const result = await sandbox.exec({
      command: `rm -rf -- ${shellQuote(managedRoot)} && mkdir -p -- ${shellQuote(managedRoot)}`,
      cwd: sandbox.workspacePath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.exitCode !== 0) throw new Error('sandbox command failed');
    return managedRoot;
  } catch (error) {
    rethrowIfAborted(error, input.signal);
  }

  warnSkillDegradation('managed skill cleanup');
  diagnostics.push('The managed skill directory could not be cleared; an isolated run directory was used.');
  return `${managedRoot}-${safePathSegment(input.runId)}-${randomUUID()}`;
}

export async function materializeManagedSkill(
  sandbox: SandboxHandle,
  managedRoot: string,
  candidate: ManagedSkillCandidate,
  diagnostics: string[],
  signal: AbortSignal | undefined,
): Promise<{ filePath: string; baseDir: string; content: string } | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name)) {
    diagnostics.push('A managed skill with an invalid name was skipped.');
    return null;
  }
  const baseDir = path.posix.join(
    managedRoot,
    candidate.source,
    safePathSegment(candidate.id),
    safePathSegment(candidate.revisionId),
    candidate.name,
  );
  const filePath = path.posix.join(baseDir, 'SKILL.md');
  const content = serializeManagedSkill(candidate);
  throwIfAborted(signal);
  if (sandbox.fs) {
    try {
      await sandbox.fs.mkdir(baseDir, { recursive: true });
      await sandbox.fs.writeFile(filePath, content);
      return { filePath, baseDir, content };
    } catch (error) {
      rethrowIfAborted(error, signal);
    }
  }

  try {
    const result = await sandbox.exec({
      command: `mkdir -p -- ${shellQuote(baseDir)} && printf '%s' ${shellQuote(content)} > ${shellQuote(filePath)}`,
      cwd: sandbox.workspacePath,
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) throw new Error('sandbox command failed');
    return { filePath, baseDir, content };
  } catch (error) {
    rethrowIfAborted(error, signal);
    warnSkillDegradation('managed skill materialization');
    diagnostics.push(`Managed skill "${candidate.name}" could not be materialized and was skipped.`);
    return null;
  }
}
