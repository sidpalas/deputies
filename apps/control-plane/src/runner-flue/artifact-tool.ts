import path from 'node:path';
import type { ToolDef } from '@flue/sdk';
import type { ArtifactService } from '../artifacts/service.js';
import type { SandboxHandle } from '../sandbox/types.js';

const allowedTypes = new Set(['file', 'log', 'screenshot', 'report', 'image', 'video']);
const maxStringLength = 512;

export type ArtifactToolServices = {
  artifacts: ArtifactService;
  sandbox: SandboxHandle;
  sessionId: string;
  runId: string;
  messageId: string;
  maxBytes: number;
};

export function createArtifactTool(services: ArtifactToolServices): ToolDef {
  return {
    name: 'artifact',
    description:
      'Manage durable artifacts visible in the product UI. Use action=create to publish a file from the current sandbox for screenshots, generated images, reports, large logs, and other files the user should be able to view or download. ' +
      'For create, provide a sandbox file path, artifact type, and optional title/content type. Use a user-facing title such as "Generated image", "Screenshot", or "Test report", not process context like "retry attempt". Prefer kebab-case download filenames with a useful extension, such as generated-image.png, test-report.md, run-log.txt, or browser-video.mp4. Use type=video only for browser-playable MP4 artifacts; publish AVI, MOV, MKV, and other non-browser-playable videos as type=file. The tool returns an artifact ID, downloadUrl, and markdownLink. If you mention the artifact in your response, use markdownLink as-is or use downloadUrl as the markdown href; do not wrap it in the session URL.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create'], description: 'Artifact action to perform.' },
        path: { type: 'string', maxLength: 2_048, description: 'Path to an existing file in the sandbox.' },
        type: {
          type: 'string',
          enum: [...allowedTypes],
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
    },
    async execute(params) {
      const action = typeof params.action === 'string' ? params.action : '';
      if (action !== 'create') throw new Error('artifact action must be one of: create');
      const input = validateParams(params);
      if (!services.sandbox.fs)
        throw new Error(`Sandbox provider "${services.sandbox.provider}" does not expose files`);
      validateVideoArtifact(input);

      const stat = await services.sandbox.fs.stat(input.path);
      if (!stat.isFile) throw new Error('artifact create path must point to a regular file');
      if (stat.size > services.maxBytes) {
        throw new Error(`artifact create file exceeds max size of ${services.maxBytes} bytes`);
      }

      const body = await services.sandbox.fs.readFileBuffer(input.path);
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

      return JSON.stringify({
        artifactId: artifact.id,
        type: artifact.type,
        ...(artifact.title ? { title: artifact.title } : {}),
        downloadUrl: artifactDownloadUrl(services.sessionId, artifact.id),
        markdownLink: `[${artifactLinkLabel(artifact.title ?? fileName)}](${artifactDownloadUrl(services.sessionId, artifact.id)})`,
      });
    },
  };
}

function artifactDownloadUrl(sessionId: string, artifactId: string): string {
  return `/sessions/${sessionId}/artifacts/${artifactId}/download`;
}

function artifactLinkLabel(value: string): string {
  return value.replace(/[\[\]\r\n]/g, '').trim() || 'Download artifact';
}

function validateParams(params: Record<string, unknown>): {
  path: string;
  type: string;
  title?: string;
  contentType?: string;
  fileName?: string;
} {
  const filePath = readString(params.path, 'path', 2_048);
  if (filePath.includes('\0')) throw new Error('artifact create path cannot contain NUL bytes');
  const type = readString(params.type, 'type', maxStringLength);
  if (!allowedTypes.has(type)) throw new Error(`artifact create type must be one of ${[...allowedTypes].join(', ')}`);
  const result = { path: filePath, type };
  const title = readOptionalString(params.title, 'title', maxStringLength);
  const contentType = readOptionalString(params.contentType, 'contentType', 128);
  const fileName = readOptionalString(params.fileName, 'fileName', maxStringLength);
  if (title) Object.assign(result, { title });
  if (contentType) Object.assign(result, { contentType });
  if (fileName) Object.assign(result, { fileName });
  return result;
}

function validateVideoArtifact(input: { path: string; type: string; contentType?: string; fileName?: string }) {
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
