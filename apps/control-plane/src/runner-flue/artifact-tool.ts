import type { ToolDefinition } from '@flue/runtime';
import {
  artifactToolDescription,
  artifactToolParameters,
  createArtifactFromSandbox,
  type ArtifactToolServices,
} from '../artifacts/tool.js';

export type { ArtifactToolServices } from '../artifacts/tool.js';

export function createArtifactTool(services: ArtifactToolServices): ToolDefinition {
  return {
    name: 'artifact',
    description: artifactToolDescription,
    parameters: artifactToolParameters,
    async execute(params) {
      return JSON.stringify(await createArtifactFromSandbox(services, params));
    },
  };
}
