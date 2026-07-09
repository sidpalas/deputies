#!/usr/bin/env node
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export type SandboxFilesystemOperation = 'stat' | 'readdir' | 'exists' | 'mkdir' | 'rm';

export type SandboxFilesystemOperationInput = {
  operation: SandboxFilesystemOperation;
  path: string;
  recursive?: boolean;
  force?: boolean;
};

export async function runSandboxFilesystemOperation(
  input: SandboxFilesystemOperationInput,
): Promise<Record<string, unknown>> {
  switch (input.operation) {
    case 'stat': {
      const info = await lstat(input.path);
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        isSymbolicLink: info.isSymbolicLink(),
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    }
    case 'readdir':
      return { entries: await readdir(input.path) };
    case 'exists':
      return { exists: await pathExists(input.path) };
    case 'mkdir':
      await mkdir(input.path, { recursive: input.recursive === true });
      return { ok: true };
    case 'rm':
      await rm(input.path, { recursive: input.recursive === true, force: input.force === true });
      return { ok: true };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function main(): Promise<void> {
  const operation = process.argv[2];
  const path = process.env.DEPUTIES_PATH;
  if (!isSandboxFilesystemOperation(operation) || !path)
    throw new Error('Usage: filesystem.js <stat|readdir|exists|mkdir|rm> with DEPUTIES_PATH set');
  const result = await runSandboxFilesystemOperation({
    operation,
    path,
    recursive: process.env.DEPUTIES_RECURSIVE === 'true',
    force: process.env.DEPUTIES_FORCE === 'true',
  });
  process.stdout.write(JSON.stringify(result));
}

function isSandboxFilesystemOperation(value: string | undefined): value is SandboxFilesystemOperation {
  return value === 'stat' || value === 'readdir' || value === 'exists' || value === 'mkdir' || value === 'rm';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Sandbox filesystem operation failed'}\n`);
    process.exitCode = 1;
  });
}
