import type { ToolDef } from '@flue/sdk';
import type { RunnerInput } from '../runner/types.js';
import type { SandboxKeepaliveService } from '../sandbox/service.js';
import { sandboxRuntimeId } from '../sandbox/runtime.js';
import {
  isValidPreviewPath,
  maxPreviewLabelLength,
  maxPreviewPathLength,
  type PublishedPreview,
  readPreviews,
} from '../sessions/previews.js';

export type PreviewToolServices = {
  sessionId: string;
  providerSandboxId: string;
  sandboxMetadata: Record<string, unknown>;
  updateSessionContext: NonNullable<RunnerInput['updateSessionContext']>;
  getContext: () => Record<string, unknown>;
  setContext: (context: Record<string, unknown>) => void;
  keepalive?: SandboxKeepaliveService;
  keepaliveMaxExtensionMs?: number;
};

const defaultPreviewTtlSeconds = 600;

export function createPreviewTool(services: PreviewToolServices): ToolDef {
  return {
    name: 'preview',
    description:
      'Manage live app previews visible in the product UI. Use action=publish after starting a web server in the sandbox so the user can open it. Multiple previews may be visible at the same time. Use action=extend to keep the sandbox alive longer when a preview needs more interaction time. Use action=list to inspect published previews and action=unpublish to remove stale links. Publish one preview per app/port, with a user-facing label such as "Web app", "Vite dev server", or "API docs".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['publish', 'unpublish', 'list', 'extend'], description: 'Preview action to perform.' },
        port: { type: 'number', minimum: 1, maximum: 65535, description: 'TCP port the app listens on.' },
        ttlSeconds: { type: 'number', minimum: 1, description: 'Seconds to keep the sandbox alive.' },
        label: { type: 'string', maxLength: maxPreviewLabelLength, description: 'Human-readable preview label.' },
        path: {
          type: 'string',
          maxLength: maxPreviewPathLength,
          description: 'Optional path to open, for example /docs.',
        },
      },
    },
    async execute(params) {
      const action = readAction(params.action);
      const runtimeId = sandboxRuntimeId({ metadata: services.sandboxMetadata });
      if (action === 'list')
        return JSON.stringify({ previews: currentRuntimePreviews(readPreviews(services.getContext()), services.providerSandboxId, runtimeId) });

      const port = readPort(params.port);
      if (action === 'extend') return JSON.stringify({ keepalive: await extendKeepalive(services, params, port) });
      const ttlSeconds = action === 'publish' ? publishTtlSeconds(params.ttlSeconds) : undefined;
      const keepalive = ttlSeconds !== undefined ? await extendKeepalive(services, { ...params, ttlSeconds }, port) : undefined;
      const current = readPreviews(services.getContext());
      const next =
        action === 'publish'
          ? publishPreview(current, params, port, services.providerSandboxId, runtimeId)
          : unpublishPreview(current, port);
      const context = { ...services.getContext(), previews: next };
      services.setContext(await services.updateSessionContext(context));

      return JSON.stringify({ previews: next, ...(keepalive ? { keepalive } : {}) });
    },
  };
}

function publishPreview(
  current: PublishedPreview[],
  params: Record<string, unknown>,
  port: number,
  providerSandboxId: string,
  runtimeId: string | undefined,
): PublishedPreview[] {
  const preview: PublishedPreview = { port, providerSandboxId };
  const label = readOptionalString(params.label, 'label', maxPreviewLabelLength);
  const path = readOptionalPath(params.path);
  if (label) preview.label = label;
  if (path) preview.path = path;
  if (runtimeId) preview.runtimeId = runtimeId;
  const base = currentRuntimePreviews(current, providerSandboxId, runtimeId).filter((item) => item.port !== port);
  return [...base, preview].sort((a, b) => a.port - b.port);
}

function currentRuntimePreviews(
  current: PublishedPreview[],
  providerSandboxId: string,
  runtimeId: string | undefined,
): PublishedPreview[] {
  return current.filter(
    (item) => item.providerSandboxId === providerSandboxId && runtimeId !== undefined && item.runtimeId === runtimeId,
  );
}

function unpublishPreview(current: PublishedPreview[], port: number): PublishedPreview[] {
  return current.filter((item) => item.port !== port);
}

async function extendKeepalive(services: PreviewToolServices, params: Record<string, unknown>, port: number) {
  if (!services.keepalive) throw new Error('sandbox keepalive is not available');
  const ttlSeconds = readTtlSeconds(params.ttlSeconds);
  const result = await services.keepalive.extend({
    sessionId: services.sessionId,
    durationMs: ttlSeconds * 1000,
    maxDurationMs: services.keepaliveMaxExtensionMs ?? ttlSeconds * 1000,
    port,
  });
  if (!result) throw new Error('active sandbox is not available');
  return {
    keepaliveUntil: result.keepaliveUntil.toISOString(),
    providerSync: result.providerSync,
  };
}

function readAction(value: unknown): 'publish' | 'unpublish' | 'list' | 'extend' {
  if (value === 'publish' || value === 'unpublish' || value === 'list' || value === 'extend') return value;
  throw new Error('preview action must be one of: publish, unpublish, list, extend');
}

function readPort(value: unknown): number {
  if (!isValidPort(value)) throw new Error('preview port must be an integer from 1 to 65535');
  return value;
}

function readTtlSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
    throw new Error('preview ttlSeconds must be a positive integer');
  return value;
}

function readOptionalTtlSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return readTtlSeconds(value);
}

function publishTtlSeconds(value: unknown): number {
  return Math.max(readOptionalTtlSeconds(value) ?? defaultPreviewTtlSeconds, defaultPreviewTtlSeconds);
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function readOptionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`preview ${name} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`preview ${name} cannot exceed ${maxLength} characters`);
  return value;
}

function readOptionalPath(value: unknown): string | undefined {
  const path = readOptionalString(value, 'path', maxPreviewPathLength);
  if (path === undefined) return undefined;
  if (!isValidPreviewPath(path)) throw new Error('preview path must start with / and cannot contain whitespace');
  return path;
}
