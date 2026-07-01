import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchBucket,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { AppConfig } from '../config/index.js';

export type StoredArtifactObject = {
  body: Uint8Array;
  contentType?: string;
  contentLength?: number;
};

export type PutArtifactObjectInput = {
  key: string;
  body: Uint8Array;
  contentType?: string;
};

export interface ArtifactObjectStorage {
  put(input: PutArtifactObjectInput): Promise<void>;
  get(key: string): Promise<StoredArtifactObject | null>;
  getRange?(key: string, start: number, endInclusive: number): Promise<StoredArtifactObject | null>;
  delete?(key: string): Promise<void>;
}

export class DisabledArtifactObjectStorage implements ArtifactObjectStorage {
  async put(): Promise<void> {
    throw new Error('Artifact object storage is disabled');
  }

  async get(): Promise<StoredArtifactObject | null> {
    return null;
  }

  async getRange(): Promise<StoredArtifactObject | null> {
    return null;
  }

  async delete(): Promise<void> {}
}

export class FilesystemArtifactObjectStorage implements ArtifactObjectStorage {
  constructor(private readonly rootPath: string) {}

  async put(input: PutArtifactObjectInput): Promise<void> {
    const filePath = this.filePath(input.key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, input.body);
    if (input.contentType) {
      await writeFile(`${filePath}.metadata.json`, JSON.stringify({ contentType: input.contentType }));
    }
  }

  async get(key: string): Promise<StoredArtifactObject | null> {
    const filePath = this.filePath(key);
    try {
      const [body, metadata] = await Promise.all([readFile(filePath), this.readMetadata(filePath)]);
      return {
        body,
        contentLength: body.byteLength,
        ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<StoredArtifactObject | null> {
    const filePath = this.filePath(key);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(filePath);
      const [metadata, stat] = await Promise.all([this.readMetadata(filePath), handle.stat()]);
      const length = Math.max(0, Math.min(endInclusive, stat.size - 1) - start + 1);
      const body = new Uint8Array(length);
      if (length > 0) await handle.read(body, 0, length, start);
      return { body, contentLength: stat.size, ...(metadata.contentType ? { contentType: metadata.contentType } : {}) };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.filePath(key);
    await Promise.all([rm(filePath, { force: true }), rm(`${filePath}.metadata.json`, { force: true })]);
  }

  private async readMetadata(filePath: string): Promise<{ contentType?: string }> {
    try {
      const metadata = JSON.parse(await readFile(`${filePath}.metadata.json`, 'utf8')) as { contentType?: unknown };
      return typeof metadata.contentType === 'string' ? { contentType: metadata.contentType } : {};
    } catch (error) {
      if (isNotFoundError(error)) return {};
      throw error;
    }
  }

  private filePath(key: string): string {
    const fullPath = path.resolve(this.rootPath, key);
    const root = path.resolve(this.rootPath);
    if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`))
      throw new Error('Invalid artifact storage key');
    return fullPath;
  }
}

export class S3ArtifactObjectStorage implements ArtifactObjectStorage {
  private bucketReady = false;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly options: { createBucket: boolean } = { createBucket: false },
  ) {}

  async put(input: PutArtifactObjectInput): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ...(input.contentType ? { ContentType: input.contentType } : {}),
      }),
    );
  }

  async get(key: string): Promise<StoredArtifactObject | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = result.Body ? await result.Body.transformToByteArray() : new Uint8Array();
      return {
        body,
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        ...(result.ContentLength !== undefined ? { contentLength: result.ContentLength } : {}),
      };
    } catch (error) {
      if (isS3NotFoundError(error)) return null;
      throw error;
    }
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<StoredArtifactObject | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }),
      );
      const body = result.Body ? await result.Body.transformToByteArray() : new Uint8Array();
      return {
        body,
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        ...(result.ContentLength !== undefined ? { contentLength: result.ContentLength } : {}),
      };
    } catch (error) {
      if (isS3NotFoundError(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketReady || !this.options.createBucket) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isS3NotFoundError(error)) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    this.bucketReady = true;
  }
}

export function createArtifactObjectStorage(config: AppConfig): ArtifactObjectStorage {
  if (config.artifactStorage === 'disabled') return new DisabledArtifactObjectStorage();
  if (config.artifactStorage === 'filesystem') {
    return new FilesystemArtifactObjectStorage(config.artifactStorageFilesystemPath!);
  }

  return new S3ArtifactObjectStorage(
    new S3Client({
      region: config.artifactStorageS3Region,
      forcePathStyle: config.artifactStorageS3ForcePathStyle,
      ...(config.artifactStorageS3AccessKeyId && config.artifactStorageS3SecretAccessKey
        ? {
            credentials: {
              accessKeyId: config.artifactStorageS3AccessKeyId,
              secretAccessKey: config.artifactStorageS3SecretAccessKey,
            },
          }
        : {}),
      ...(config.artifactStorageS3Endpoint ? { endpoint: config.artifactStorageS3Endpoint } : {}),
    }),
    config.artifactStorageS3Bucket!,
    { createBucket: config.artifactStorageS3CreateBucket },
  );
}

export function checksumSha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isS3NotFoundError(error: unknown): boolean {
  if (error instanceof NoSuchBucket) return true;
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? error.name : undefined;
  const statusCode = '$metadata' in error && isRecord(error.$metadata) ? error.$metadata.httpStatusCode : undefined;
  return name === 'NoSuchKey' || name === 'NotFound' || statusCode === 404;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
