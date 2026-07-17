import path from 'node:path';

export function addDiagnostic(diagnostics: string[], diagnostic: string): void {
  if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
}

export function localRootPath(base: string, root: string): string {
  return path.join(base, ...root.split('/'));
}

export function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || 'run';
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

export function rethrowIfAborted(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
}

export function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}

export function warnSkillDegradation(stage: string): void {
  console.warn(`Skill loading degraded during ${stage}; affected skills were skipped.`);
}
