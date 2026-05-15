import { randomUUID } from 'node:crypto';
import type { SandboxRecord } from '../store/types.js';

export const sandboxRuntimeIdMetadataKey = 'runtimeId';

export function sandboxRuntimeId(record: Pick<SandboxRecord, 'metadata'>): string | undefined {
  const value = record.metadata[sandboxRuntimeIdMetadataKey];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function withNewSandboxRuntime(record: SandboxRecord): SandboxRecord {
  return { ...record, metadata: { ...record.metadata, [sandboxRuntimeIdMetadataKey]: randomUUID() } };
}

export function withSandboxRuntimeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return { ...metadata, [sandboxRuntimeIdMetadataKey]: randomUUID() };
}
