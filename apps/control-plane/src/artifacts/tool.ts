import path from 'node:path';
import type { ArtifactService } from './service.js';
import type { SandboxHandle } from '../sandbox/types.js';

const artifactTypes = ['file', 'log', 'screenshot', 'report', 'image', 'video'] as const;
const allowedTypes = new Set<string>(artifactTypes);
const maxStringLength = 512;

export type ArtifactToolServices = {
  artifacts: ArtifactService;
  sandbox: SandboxHandle;
  sessionId: string;
  runId: string;
  messageId: string;
  maxBytes: number;
};

export type ArtifactToolResult = {
  artifactId: string;
  type: string;
  title?: string;
  downloadUrl: string;
  markdownLink: string;
};

type ArtifactCreateInput = {
  path: string;
  type: string;
  title?: string;
  contentType?: string;
  fileName?: string;
};

export const artifactToolDescription =
  'Manage durable artifacts visible in the product UI. Use action=create to publish a file from the current sandbox for screenshots, generated images, reports, large logs, and other files the user should be able to view or download. ' +
  'For create, provide a sandbox file path, artifact type, and optional title/content type. Use a user-facing title such as "Generated image", "Screenshot", or "Test report", not process context like "retry attempt". Prefer kebab-case download filenames with a useful extension, such as generated-image.png, test-report.md, run-log.txt, or browser-video.mp4. Use type=video only for browser-playable MP4 artifacts; publish AVI, MOV, MKV, and other non-browser-playable videos as type=file. The tool returns an artifact ID, downloadUrl, and markdownLink. If you mention the artifact in your response, use markdownLink as-is or use downloadUrl as the markdown href; do not wrap it in the session URL.';

export const artifactToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['create'], description: 'Artifact action to perform.' },
    path: { type: 'string', maxLength: 2_048, description: 'Path to an existing file in the sandbox.' },
    type: {
      type: 'string',
      enum: artifactTypes,
      description: 'Artifact type: file, log, screenshot, report, image, or video.',
    },
    title: { type: 'string', maxLength: maxStringLength, description: 'Human-readable title for the artifact.' },
    contentType: { type: 'string', maxLength: 128, description: 'MIME type, for example image/png or text/plain.' },
    fileName: {
      type: 'string',
      maxLength: maxStringLength,
      description:
        'Download filename to show users. Prefer kebab-case with a useful extension, for example generated-image.png or run-log.txt.',
    },
  },
} as const;

export async function createArtifactFromSandbox(
  services: ArtifactToolServices,
  params: Record<string, unknown>,
): Promise<ArtifactToolResult> {
  const action = typeof params.action === 'string' ? params.action : '';
  if (action !== 'create') throw new Error('artifact action must be one of: create');
  const input = validateParams(params);
  const sandboxFs = services.sandbox.fs;
  if (!sandboxFs) throw new Error(`Sandbox provider "${services.sandbox.provider}" does not expose files`);
  validateVideoArtifact(input);

  const stat = await sandboxFs.stat(input.path);
  if (!stat.isFile) throw new Error('artifact create path must point to a regular file');
  if (stat.size > services.maxBytes) {
    throw new Error(`artifact create file exceeds max size of ${services.maxBytes} bytes`);
  }

  const body = await sandboxFs.readFileBuffer(input.path);
  if (body.byteLength > services.maxBytes) {
    throw new Error(`artifact create file exceeds max size of ${services.maxBytes} bytes`);
  }

  const fileName = input.fileName ?? path.basename(input.path);
  const artifact = await services.artifacts.createStoredArtifact({
    sessionId: services.sessionId,
    runId: services.runId,
    messageId: services.messageId,
    type: input.type,
    body,
    fileName,
    payload: { sourcePath: input.path },
    ...(input.title ? { title: input.title } : {}),
    ...(input.contentType ? { contentType: input.contentType } : {}),
  });

  const downloadUrl = artifactDownloadUrl(services.sessionId, artifact.id);
  return {
    artifactId: artifact.id,
    type: artifact.type,
    ...(artifact.title ? { title: artifact.title } : {}),
    downloadUrl,
    markdownLink: `[${artifactLinkLabel(artifact.title ?? fileName)}](${downloadUrl})`,
  };
}

function artifactDownloadUrl(sessionId: string, artifactId: string): string {
  return `/sessions/${sessionId}/artifacts/${artifactId}/download`;
}

function artifactLinkLabel(value: string): string {
  return value.replace(/[\[\]\r\n]/g, '').trim() || 'Download artifact';
}

function validateParams(params: Record<string, unknown>): ArtifactCreateInput {
  const filePath = readString(params.path, 'path', 2_048);
  if (filePath.includes('\0')) throw new Error('artifact create path cannot contain NUL bytes');
  const type = readString(params.type, 'type', maxStringLength);
  if (!allowedTypes.has(type)) throw new Error(`artifact create type must be one of ${[...allowedTypes].join(', ')}`);
  const result: ArtifactCreateInput = { path: filePath, type };
  const title = readOptionalString(params.title, 'title', maxStringLength);
  const contentType = readOptionalString(params.contentType, 'contentType', 128);
  const fileName = readOptionalString(params.fileName, 'fileName', maxStringLength);
  if (title) result.title = title;
  if (contentType) result.contentType = contentType;
  if (fileName) result.fileName = fileName;
  return result;
}

function validateVideoArtifact(input: ArtifactCreateInput): void {
  if (input.type !== 'video') return;
  const fileName = input.fileName ?? path.basename(input.path);
  const extension = path.extname(fileName).toLowerCase();
  const contentType = input.contentType?.split(';')[0]?.trim().toLowerCase();
  if (extension === '.mp4' && (!contentType || contentType === 'video/mp4')) return;
  if (extension === '.m4v' && (!contentType || contentType === 'video/mp4' || contentType === 'video/x-m4v')) return;
  throw new Error(
    'artifact create type=video requires a browser-playable MP4 file. Publish this file as type=file or transcode it to MP4/H.264/yuv420p first.',
  );
}

function readString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`artifact create ${name} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`artifact create ${name} cannot exceed ${maxLength} characters`);
  return value;
}

function readOptionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, name, maxLength);
}
