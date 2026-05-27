import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import type { RunnerArtifact, RunnerResult } from '../runner/types.js';
import type { ArtifactRecord, CreateArtifactRecord, SessionRecord } from '../store/types.js';
import { checksumSha256, type ArtifactObjectStorage } from './storage.js';

type ArtifactStore = {
  createArtifact(record: CreateArtifactRecord): Promise<ArtifactRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  getArtifacts?: (sessionId: string) => Promise<ArtifactRecord[]>;
};

export class ArtifactServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'storage_disabled' | 'unsupported_preview',
    message: string,
  ) {
    super(message);
  }
}

export class ArtifactService {
  constructor(
    private readonly store: ArtifactStore,
    private readonly events: EventService,
    private readonly objectStorage?: ArtifactObjectStorage,
  ) {}

  async recordRunArtifacts(input: {
    sessionId: string;
    runId: string;
    messageId: string;
    result: RunnerResult;
  }): Promise<ArtifactRecord[]> {
    const artifacts = input.result.artifacts ?? [];
    const records: ArtifactRecord[] = [];

    for (const artifact of artifacts) {
      records.push(
        await this.create({
          sessionId: input.sessionId,
          runId: input.runId,
          messageId: input.messageId,
          artifact,
        }),
      );
    }

    return records;
  }

  async createStoredArtifact(input: {
    sessionId: string;
    runId: string;
    messageId: string;
    type: string;
    body: Uint8Array;
    title?: string;
    contentType?: string;
    fileName?: string;
    payload?: Record<string, unknown>;
  }): Promise<ArtifactRecord> {
    const artifact: RunnerArtifact = {
      type: input.type,
      content: input.body,
      ...(input.payload ? { payload: input.payload } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.contentType ? { contentType: input.contentType } : {}),
      ...(input.fileName ? { fileName: input.fileName } : {}),
    };
    return this.create({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      artifact,
    });
  }

  private async create(input: {
    sessionId: string;
    runId: string;
    messageId: string;
    artifact: RunnerArtifact;
  }): Promise<ArtifactRecord> {
    const id = randomUUID();
    const artifact = input.artifact;
    const createdAt = new Date();
    const create: CreateArtifactRecord = {
      id,
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      type: artifact.type,
      payload: artifact.payload ? { ...artifact.payload } : {},
      createdAt,
    };
    const title = artifact.title ?? titleFromFileName(artifact.fileName);
    if (title) create.title = title;
    if (artifact.url) Object.assign(create, { url: artifact.url });

    const content = artifactContentBytes(artifact);
    if (content) {
      if (!this.objectStorage)
        throw new ArtifactServiceError('storage_disabled', 'Artifact object storage is disabled');
      const session = await this.store.getSession(input.sessionId);
      if (!session) throw new ArtifactServiceError('not_found', 'Session not found');
      const storageKey = buildStorageKey(
        session.createdAt,
        createdAt,
        input.sessionId,
        input.runId,
        id,
        artifact.fileName,
      );
      await this.objectStorage.put({
        key: storageKey,
        body: content,
        ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
      });
      create.storageKey = storageKey;
      create.payload = {
        ...create.payload,
        storage: 'internal',
        sizeBytes: content.byteLength,
        checksumSha256: checksumSha256(content),
      };
      if (artifact.contentType) Object.assign(create.payload, { contentType: artifact.contentType });
      if (artifact.fileName) Object.assign(create.payload, { fileName: artifact.fileName });
    }

    try {
      const record = await this.store.createArtifact(create);
      await this.events.append({
        sessionId: input.sessionId,
        runId: input.runId,
        messageId: input.messageId,
        type: 'artifact_created',
        payload: { artifact: record },
      });
      return record;
    } catch (error) {
      if (create.storageKey) await this.cleanupStoredObject(create.storageKey);
      throw error;
    }
  }

  private async cleanupStoredObject(storageKey: string): Promise<void> {
    if (!this.objectStorage?.delete) return;
    await this.objectStorage.delete(storageKey).catch(() => undefined);
  }

  async list(sessionId: string): Promise<ArtifactRecord[]> {
    if (!this.store.getArtifacts) throw new Error('Artifact store does not support listing artifacts');
    return this.store.getArtifacts(sessionId);
  }

  async getDownload(input: { sessionId: string; artifactId: string }): Promise<{
    artifact: ArtifactRecord;
    body: Uint8Array;
    contentType: string;
    fileName: string;
  }> {
    if (!this.objectStorage) throw new ArtifactServiceError('storage_disabled', 'Artifact object storage is disabled');
    const artifacts = await this.list(input.sessionId);
    const artifact = artifacts.find((candidate) => candidate.id === input.artifactId);
    if (!artifact || !artifact.storageKey) throw new ArtifactServiceError('not_found', 'Artifact not found');

    const object = await this.objectStorage.get(artifact.storageKey);
    if (!object) throw new ArtifactServiceError('not_found', 'Artifact object not found');

    return {
      artifact,
      body: object.body,
      contentType: stringPayload(artifact.payload.contentType) ?? object.contentType ?? 'application/octet-stream',
      fileName: stringPayload(artifact.payload.fileName) ?? `${artifact.id}.bin`,
    };
  }

  async getPreview(input: { sessionId: string; artifactId: string; maxBytes?: number }): Promise<{
    artifact: ArtifactRecord;
    text: string;
    contentType: string;
    truncated: boolean;
    sizeBytes: number;
  }> {
    if (!this.objectStorage) throw new ArtifactServiceError('storage_disabled', 'Artifact object storage is disabled');
    const artifacts = await this.list(input.sessionId);
    const artifact = artifacts.find((candidate) => candidate.id === input.artifactId);
    if (!artifact || !artifact.storageKey) throw new ArtifactServiceError('not_found', 'Artifact not found');

    const contentType = stringPayload(artifact.payload.contentType) ?? 'application/octet-stream';
    const fileName = stringPayload(artifact.payload.fileName) ?? artifact.title ?? '';
    if (!isPreviewableText(contentType, fileName, artifact.type)) {
      throw new ArtifactServiceError('unsupported_preview', 'Artifact is not a previewable text type');
    }
    const maxBytes = input.maxBytes ?? 32 * 1024;
    const object = this.objectStorage.getRange
      ? await this.objectStorage.getRange(artifact.storageKey, 0, maxBytes - 1)
      : await this.objectStorage.get(artifact.storageKey);
    if (!object) throw new ArtifactServiceError('not_found', 'Artifact object not found');
    const slice = object.body.slice(0, maxBytes);
    const sizeBytes = numberPayload(artifact.payload.sizeBytes) ?? object.contentLength ?? object.body.byteLength;
    return {
      artifact,
      text: new TextDecoder('utf-8', { fatal: false }).decode(slice),
      contentType,
      truncated: sizeBytes > maxBytes,
      sizeBytes,
    };
  }
}

function numberPayload(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const previewableTextExtensions = new Set([
  '.txt',
  '.log',
  '.md',
  '.markdown',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.html',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.sh',
]);

function isPreviewableText(contentType: string, fileName: string, artifactType: string): boolean {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!isTextContentType(normalized)) return false;
  if (artifactType === 'log' || artifactType === 'report') return true;
  return previewableTextExtensions.has(fileExtension(fileName));
}

function isTextContentType(contentType: string): boolean {
  if (contentType.startsWith('text/')) return true;
  return [
    'application/json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/javascript',
  ].includes(contentType);
}

function fileExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? '';
}

function artifactContentBytes(artifact: RunnerArtifact): Uint8Array | null {
  if (artifact.content instanceof Uint8Array) return artifact.content;
  if (typeof artifact.content === 'string') return Buffer.from(artifact.content);
  if (artifact.contentBase64) return Buffer.from(artifact.contentBase64, 'base64');
  return null;
}

function buildStorageKey(
  sessionCreatedAt: Date,
  artifactCreatedAt: Date,
  sessionId: string,
  runId: string,
  artifactId: string,
  fileName?: string,
): string {
  const suffix = fileName ? `-${sanitizeStorageFileName(fileName)}` : '';
  return `artifacts/${formatStorageTimestamp(sessionCreatedAt)}/sessions/${sessionId}/runs/${runId}/${formatStorageTimestamp(artifactCreatedAt)}-${artifactId}${suffix}`;
}

function sanitizeStorageFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function formatStorageTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

function titleFromFileName(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const baseName =
    fileName
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? '';
  const title = baseName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
  return title || undefined;
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
