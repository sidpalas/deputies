import type { RunnerInput } from '../runner/types.js';
import { sandboxRuntimeId } from '../sandbox/runtime.js';
import type { SandboxKeepaliveService } from '../sandbox/service.js';
import type { SandboxServiceProcess, SandboxServiceProcessInput } from '../sandbox/types.js';
import {
  isValidServicePath,
  maxServiceLabelLength,
  maxServicePathLength,
  type PublishedService,
  readServices,
} from './services.js';

export type ServiceToolServices = {
  sessionId: string;
  providerSandboxId: string;
  sandboxMetadata: Record<string, unknown>;
  updateSessionContext: NonNullable<RunnerInput['updateSessionContext']>;
  getContext: () => Record<string, unknown>;
  setContext: (context: Record<string, unknown>) => void;
  keepalive?: SandboxKeepaliveService;
  keepaliveMaxExtensionMs?: number;
  launchService?: (input: SandboxServiceProcessInput) => Promise<SandboxServiceProcess>;
};

export type ServiceToolResult = {
  services?: PublishedService[];
  keepalive?: {
    keepaliveUntil: string;
    providerSync: 'not_supported' | 'ok' | 'failed';
  };
  process?: SandboxServiceProcess;
};

const defaultServiceTtlSeconds = 600;

export const serviceToolDescription =
  "Launch and manage live HTTP services visible in the product UI, including app previews, API docs, dashboards, notebooks, code-server, and other browser-accessible sandbox tools. Prefer action=launch with the service command and port so Deputies can use the provider's persistent process API. Use action=publish only for an already-managed service. Multiple services may be visible at the same time. Use action=extend to keep the sandbox alive longer, action=list to inspect published services, and action=unpublish to remove stale links.";

export const serviceToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['launch', 'publish', 'unpublish', 'list', 'extend'],
      description: 'Service action to perform.',
    },
    port: { type: 'number', minimum: 1, maximum: 65535, description: 'TCP port the service listens on.' },
    command: { type: 'string', description: 'Command to launch as a persistent managed service.' },
    cwd: { type: 'string', description: 'Optional service working directory.' },
    ttlSeconds: { type: 'number', minimum: 1, description: 'Seconds to keep the sandbox alive.' },
    label: { type: 'string', maxLength: maxServiceLabelLength, description: 'Human-readable service label.' },
    path: {
      type: 'string',
      maxLength: maxServicePathLength,
      description: 'Optional path to open, for example /docs.',
    },
  },
} as const;

export async function executeServiceTool(
  services: ServiceToolServices,
  params: Record<string, unknown>,
): Promise<ServiceToolResult> {
  const action = readAction(params.action);
  const runtimeId = sandboxRuntimeId({ metadata: services.sandboxMetadata });
  if (action === 'list') {
    return {
      services: currentRuntimeServices(readServices(services.getContext()), services.providerSandboxId, runtimeId),
    };
  }

  const port = readPort(params.port);
  if (action === 'extend') return { keepalive: await extendKeepalive(services, params, port) };

  const ttlSeconds = action === 'publish' || action === 'launch' ? publishTtlSeconds(params.ttlSeconds) : undefined;
  const keepalive =
    ttlSeconds !== undefined ? await extendKeepalive(services, { ...params, ttlSeconds }, port) : undefined;
  const process = action === 'launch' ? await launchService(services, params, port) : undefined;
  const latestContext = await refreshSessionContextWithoutStaleServices(services);
  const current = readServices(latestContext);
  const next =
    action === 'publish' || action === 'launch'
      ? publishService(current, params, port, services.providerSandboxId, runtimeId)
      : unpublishService(current, port, services.providerSandboxId, runtimeId);
  services.setContext(await services.updateSessionContext({ ...latestContext, services: next }));

  return { services: next, ...(process ? { process } : {}), ...(keepalive ? { keepalive } : {}) };
}

async function refreshSessionContextWithoutStaleServices(
  services: ServiceToolServices,
): Promise<Record<string, unknown>> {
  const { services: _staleServices, ...contextWithoutServices } = services.getContext();
  return services.updateSessionContext(contextWithoutServices);
}

function publishService(
  current: PublishedService[],
  params: Record<string, unknown>,
  port: number,
  providerSandboxId: string,
  runtimeId: string | undefined,
): PublishedService[] {
  const service: PublishedService = { port, providerSandboxId };
  const label = readOptionalString(params.label, 'label', maxServiceLabelLength);
  const path = readOptionalPath(params.path);
  if (label) service.label = label;
  if (path) service.path = path;
  if (runtimeId) service.runtimeId = runtimeId;
  const base = current.filter((item) => !isSameRuntimeService(item, providerSandboxId, runtimeId, port));
  return [...base, service].sort((a, b) => a.port - b.port);
}

function currentRuntimeServices(
  current: PublishedService[],
  providerSandboxId: string,
  runtimeId: string | undefined,
): PublishedService[] {
  return current.filter(
    (item) => item.providerSandboxId === providerSandboxId && runtimeId !== undefined && item.runtimeId === runtimeId,
  );
}

function unpublishService(
  current: PublishedService[],
  port: number,
  providerSandboxId: string,
  runtimeId: string | undefined,
): PublishedService[] {
  return current.filter((item) => !isSameRuntimeService(item, providerSandboxId, runtimeId, port));
}

function isSameRuntimeService(
  item: PublishedService,
  providerSandboxId: string,
  runtimeId: string | undefined,
  port: number,
): boolean {
  return item.port === port && item.providerSandboxId === providerSandboxId && item.runtimeId === runtimeId;
}

async function extendKeepalive(
  services: ServiceToolServices,
  params: Record<string, unknown>,
  port: number,
): Promise<NonNullable<ServiceToolResult['keepalive']>> {
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

async function launchService(
  services: ServiceToolServices,
  params: Record<string, unknown>,
  port: number,
): Promise<SandboxServiceProcess> {
  if (!services.launchService) throw new Error('managed service launch is not available');
  const command = readOptionalString(params.command, 'command', 16_384);
  if (!command) throw new Error('service command is required for action=launch');
  const cwd = readOptionalString(params.cwd, 'cwd', 4096);
  return services.launchService({ command, port, ...(cwd ? { cwd } : {}) });
}

function readAction(value: unknown): 'launch' | 'publish' | 'unpublish' | 'list' | 'extend' {
  if (value === 'launch' || value === 'publish' || value === 'unpublish' || value === 'list' || value === 'extend')
    return value;
  throw new Error('service action must be one of: launch, publish, unpublish, list, extend');
}

function readPort(value: unknown): number {
  if (!isValidPort(value)) throw new Error('service port must be an integer from 1 to 65535');
  return value;
}

function readTtlSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
    throw new Error('service ttlSeconds must be a positive integer');
  return value;
}

function readOptionalTtlSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return readTtlSeconds(value);
}

function publishTtlSeconds(value: unknown): number {
  return Math.max(readOptionalTtlSeconds(value) ?? defaultServiceTtlSeconds, defaultServiceTtlSeconds);
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function readOptionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`service ${name} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`service ${name} cannot exceed ${maxLength} characters`);
  return value;
}

function readOptionalPath(value: unknown): string | undefined {
  const path = readOptionalString(value, 'path', maxServicePathLength);
  if (path === undefined) return undefined;
  if (!isValidServicePath(path)) throw new Error('service path must start with / and cannot contain whitespace');
  return path;
}
