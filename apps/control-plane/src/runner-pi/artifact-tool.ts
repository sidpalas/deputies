import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  artifactToolDescription,
  artifactToolParameters,
  createArtifactFromSandbox,
  type ArtifactToolServices,
} from '../artifacts/tool.js';

const piArtifactToolParameters = artifactToolParameters as unknown as ToolDefinition['parameters'];

export function createPiArtifactToolDefinition(services: ArtifactToolServices): ToolDefinition {
  return {
    name: 'artifact',
    label: 'artifact',
    description: artifactToolDescription,
    promptSnippet: 'Publish sandbox files as durable artifacts visible in the product UI',
    promptGuidelines: [
      'Use artifact({ action: "create", ... }) for files the user should view or download, including screenshots, images, reports, logs, and videos.',
      'If you mention a created artifact in your final response, use the markdownLink returned by the artifact tool as-is, or use its downloadUrl as the markdown href. Do not wrap artifact download URLs in the session URL.',
      'Use artifact type=video only for browser-playable MP4 files. If you create AVI, MOV, MKV, or another video format, publish it as type=file so it is download-only.',
    ],
    parameters: piArtifactToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const result = await createArtifactFromSandbox(services, params as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
