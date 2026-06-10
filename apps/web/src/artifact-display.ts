import type { Artifact } from './api.js';

export function artifactName(artifact: Artifact): string {
  return artifact.title || stringPayloadValue(artifact.payload.fileName) || artifact.url || artifact.id;
}

export function isInlineDisplayableArtifact(artifact: Artifact): boolean {
  return isImageArtifact(artifact) || isBrowserPlayableVideoArtifact(artifact) || isTextPreviewableArtifact(artifact);
}

export function isImageArtifact(artifact: Artifact): boolean {
  const contentType = stringPayloadValue(artifact.payload.contentType);
  return artifact.type === 'image' || artifact.type === 'screenshot' || Boolean(contentType?.startsWith('image/'));
}

export function isBrowserPlayableVideoArtifact(artifact: Artifact): boolean {
  const contentType = stringPayloadValue(artifact.payload.contentType)?.split(';')[0]?.trim().toLowerCase();
  const extension = fileExtension(stringPayloadValue(artifact.payload.fileName) ?? artifactName(artifact));
  return contentType === 'video/mp4' || extension === '.mp4' || extension === '.m4v';
}

export function isTextPreviewableArtifact(artifact: Artifact): boolean {
  if (!artifact.storageKey) return false;
  const contentType = stringPayloadValue(artifact.payload.contentType)?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!isTextContentType(contentType)) return false;
  if (artifact.type === 'log' || artifact.type === 'report') return true;
  return previewableTextExtensions.has(
    fileExtension(stringPayloadValue(artifact.payload.fileName) ?? artifactName(artifact)),
  );
}

export function fileExtension(fileName: string): string {
  return fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
}

export function stringPayloadValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
