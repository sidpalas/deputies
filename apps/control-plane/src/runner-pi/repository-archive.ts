import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import type { SandboxHandle } from '../sandbox/types.js';
import {
  ARCHIVE_ENTRY_CAP_DIAGNOSTIC,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_STDOUT_BYTES,
  MAX_MIRROR_VISITED_ENTRIES,
  MAX_REPO_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_UNCOMPRESSED_ARCHIVE_BYTES,
  REPO_BYTE_CAP_DIAGNOSTIC,
  SKIPPED_OVERSIZED_DIAGNOSTIC,
  SKIPPED_SYMLINK_DIAGNOSTIC,
} from './repository-policy.js';
import { addDiagnostic, shellQuote, throwIfAborted } from './skill-utils.js';

export async function mirrorRepositoryArchive(
  sandbox: SandboxHandle,
  workspacePath: string,
  roots: string[],
  destination: string,
  diagnostics: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const rootArguments = roots.map(shellQuote).join(' ');
  const command = [
    'set -eu',
    'LC_ALL=C',
    'export LC_ALL',
    'list=$(mktemp)',
    'trap \'rm -f "$list"\' EXIT',
    'archive_entries=0',
    'archive_bytes=0',
    'archive_stopped=0',
    'skipped_symlink=0',
    'skipped_oversized=0',
    'capped_entries=0',
    'capped_bytes=0',
    'add_file() {',
    '  if [ -L "$1" ]; then skipped_symlink=1; return 0; fi',
    '  if [ ! -f "$1" ]; then return 0; fi',
    '  size=$(wc -c < "$1")',
    `  if [ "$size" -gt ${MAX_SKILL_FILE_BYTES} ]; then skipped_oversized=1; return 0; fi`,
    `  if [ "$archive_entries" -ge ${MAX_ARCHIVE_ENTRIES} ]; then capped_entries=1; archive_stopped=1; return 0; fi`,
    `  if [ $((archive_bytes + size)) -gt ${MAX_REPO_BYTES} ]; then capped_bytes=1; archive_stopped=1; return 0; fi`,
    '  archive_entries=$((archive_entries + 1))',
    '  archive_bytes=$((archive_bytes + size))',
    '  printf \'%s\\0\' "$1" >> "$list"',
    '}',
    'collect_dir() {',
    '  dir=$1',
    '  include_root_files=$2',
    '  if [ "$archive_stopped" != 0 ]; then return 0; fi',
    '  if [ -L "$dir" ]; then skipped_symlink=1; return 0; fi',
    '  for ignore_name in .gitignore .ignore .fdignore; do',
    '    ignore_file="$dir/$ignore_name"',
    '    if [ -e "$ignore_file" ] || [ -L "$ignore_file" ]; then add_file "$ignore_file"; fi',
    '    if [ "$archive_stopped" != 0 ]; then return 0; fi',
    '  done',
    '  if [ -e "$dir/SKILL.md" ] || [ -L "$dir/SKILL.md" ]; then',
    '    add_file "$dir/SKILL.md"',
    '    return',
    '  fi',
    '  if [ "$include_root_files" = 1 ]; then',
    '    for file in "$dir"/*.md; do',
    '      if [ ! -e "$file" ] && [ ! -L "$file" ]; then continue; fi',
    '      add_file "$file"',
    '      if [ "$archive_stopped" != 0 ]; then return 0; fi',
    '    done',
    '  fi',
    '  for entry in "$dir"/*; do',
    '    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
    '    if [ -L "$entry" ]; then skipped_symlink=1; continue; fi',
    '    [ -d "$entry" ] || continue',
    '    [ "${entry##*/}" != node_modules ] || continue',
    '    collect_dir "$entry" 0',
    '    if [ "$archive_stopped" != 0 ]; then return 0; fi',
    '  done',
    '}',
    `for root in ${rootArguments}; do collect_dir "$root" 1; done`,
    'tar -czf - --null -T "$list" | base64',
    'if [ "$skipped_symlink" = 1 ]; then printf \'DEPUTIES_SKILLS_SKIPPED_SYMLINK\\n\' >&2; fi',
    'if [ "$skipped_oversized" = 1 ]; then printf \'DEPUTIES_SKILLS_SKIPPED_OVERSIZED\\n\' >&2; fi',
    'if [ "$capped_entries" = 1 ]; then printf \'DEPUTIES_SKILLS_CAPPED_ENTRIES\\n\' >&2; fi',
    'if [ "$capped_bytes" = 1 ]; then printf \'DEPUTIES_SKILLS_CAPPED_BYTES\\n\' >&2; fi',
  ].join('\n');
  const result = await sandbox.exec({
    command,
    cwd: workspacePath,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  });
  if (result.exitCode !== 0 || !result.stdout.trim() || result.stdout.length > MAX_ARCHIVE_STDOUT_BYTES) {
    throw new Error('archive transfer failed');
  }
  addArchiveDiagnostics(result.stderr, diagnostics);
  const encoded = result.stdout.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('archive output was truncated');
  await extractBoundedTarGzip(Buffer.from(encoded, 'base64'), destination, diagnostics, signal);
}

export async function findSandboxMirrorSymlinks(
  sandbox: SandboxHandle,
  workspacePath: string,
  roots: string[],
  signal: AbortSignal | undefined,
): Promise<Set<string>> {
  const rootArguments = roots.map(shellQuote).join(' ');
  const result = await sandbox.exec({
    command: `set -eu\nlist=$(mktemp)\ntrap 'rm -f "$list"' EXIT\nfor root in ${rootArguments}; do find "$root" -type l -print0 >> "$list"; done\nbase64 < "$list"`,
    cwd: workspacePath,
    timeoutMs: 10_000,
    ...(signal ? { signal } : {}),
  });
  if (result.exitCode !== 0) throw new Error('repository symlink preflight failed');
  if (result.stdout.length > MAX_ARCHIVE_STDOUT_BYTES) throw new Error('repository symlink preflight was too large');
  const encoded = result.stdout.replace(/\s/g, '');
  if (encoded && !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('repository symlink preflight output was invalid');
  }
  const symlinks = new Set<string>();
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  for (const relative of decoded.split('\0')) {
    if (!relative) continue;
    const normalized = path.posix.normalize(relative.replace(/\\/g, '/'));
    if (
      path.posix.isAbsolute(normalized) ||
      !roots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
    ) {
      throw new Error('repository symlink preflight escaped the repository skill roots');
    }
    symlinks.add(path.posix.join(workspacePath, normalized));
    if (symlinks.size > MAX_MIRROR_VISITED_ENTRIES) {
      throw new Error('repository symlink preflight exceeded the visited-entry limit');
    }
  }
  return symlinks;
}

function addArchiveDiagnostics(stderr: string, diagnostics: string[]): void {
  if (stderr.includes('DEPUTIES_SKILLS_SKIPPED_SYMLINK')) addDiagnostic(diagnostics, SKIPPED_SYMLINK_DIAGNOSTIC);
  if (stderr.includes('DEPUTIES_SKILLS_SKIPPED_OVERSIZED')) addDiagnostic(diagnostics, SKIPPED_OVERSIZED_DIAGNOSTIC);
  if (stderr.includes('DEPUTIES_SKILLS_CAPPED_ENTRIES')) addDiagnostic(diagnostics, ARCHIVE_ENTRY_CAP_DIAGNOSTIC);
  if (stderr.includes('DEPUTIES_SKILLS_CAPPED_BYTES')) addDiagnostic(diagnostics, REPO_BYTE_CAP_DIAGNOSTIC);
}

async function extractBoundedTarGzip(
  archive: Buffer,
  destination: string,
  diagnostics: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_ARCHIVE_BYTES });
  let offset = 0;
  let entries = 0;
  let extractedBytes = 0;
  let pendingPath: string | undefined;
  while (offset + 512 <= tar.length) {
    throwIfAborted(signal);
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES) {
      addDiagnostic(diagnostics, ARCHIVE_ENTRY_CAP_DIAGNOSTIC);
      return;
    }

    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header.subarray(124, 136)).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const type = String.fromCharCode(header[156] ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('archive entry has an invalid size');
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) throw new Error('archive output was truncated');

    const content = tar.subarray(contentStart, contentEnd);
    const nextOffset = contentStart + Math.ceil(size / 512) * 512;
    if (size > MAX_SKILL_FILE_BYTES) {
      addDiagnostic(diagnostics, SKIPPED_OVERSIZED_DIAGNOSTIC);
      pendingPath = undefined;
      offset = nextOffset;
      continue;
    }
    if (type === 'x' || type === 'g') {
      const paxPath = parsePaxPath(content);
      if (type === 'x' && paxPath) pendingPath = paxPath;
      if (type === 'g' && paxPath) throw new Error('archive contains an unsupported global path');
      offset = nextOffset;
      continue;
    }
    if (type === 'L') {
      pendingPath = tarString(content);
      offset = nextOffset;
      continue;
    }

    const entryPath = pendingPath ?? headerPath;
    pendingPath = undefined;
    if (type === '\0' || type === '0') {
      const segments = entryPath.replace(/\\/g, '/').split('/');
      if (!entryPath || path.posix.isAbsolute(entryPath) || segments.some((segment) => segment === '..')) {
        addDiagnostic(diagnostics, 'An unsafe repository skill archive entry was skipped.');
        offset = nextOffset;
        continue;
      }
      if (extractedBytes + size > MAX_REPO_BYTES) {
        addDiagnostic(diagnostics, REPO_BYTE_CAP_DIAGNOSTIC);
        offset = nextOffset;
        continue;
      }
      extractedBytes += size;
      const outputPath = path.join(destination, ...segments);
      await mkdir(path.dirname(outputPath), { recursive: true });
      throwIfAborted(signal);
      await writeFile(outputPath, content);
    } else if (type === '1' || type === '2') {
      addDiagnostic(diagnostics, SKIPPED_SYMLINK_DIAGNOSTIC);
    } else if (type !== '5') {
      addDiagnostic(diagnostics, 'An unsupported repository skill archive entry was skipped.');
    }
    offset = nextOffset;
  }
  throw new Error('archive did not contain a complete end marker');
}

function tarString(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end === -1 ? value.length : end).toString('utf8');
}

function parsePaxPath(value: Buffer): string | undefined {
  let offset = 0;
  let result: string | undefined;
  while (offset < value.length) {
    const space = value.indexOf(0x20, offset);
    if (space === -1) throw new Error('archive contains invalid PAX metadata');
    const length = Number.parseInt(value.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > value.length) {
      throw new Error('archive contains invalid PAX metadata');
    }
    const record = value.subarray(space + 1, offset + length - 1).toString('utf8');
    const separator = record.indexOf('=');
    if (separator !== -1 && record.slice(0, separator) === 'path') result = record.slice(separator + 1);
    offset += length;
  }
  return result;
}
