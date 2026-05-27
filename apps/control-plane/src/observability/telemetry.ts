import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { CloseableResource } from '../app/lifecycle.js';
import { logger } from './logger.js';

const defaultHoneycombEndpoint = 'https://api.honeycomb.io/v1/traces';

let sdk: NodeSDK | null = null;

export function startTelemetry(env: NodeJS.ProcessEnv = process.env): CloseableResource | null {
  if (sdk) return { close: shutdownTelemetry };
  if (isTruthy(env.OTEL_SDK_DISABLED)) return null;
  if (!isTelemetryConfigured(env)) return null;

  try {
    const traceExporter = new OTLPTraceExporter(telemetryExporterOptions(env));
    sdk = new NodeSDK({
      serviceName: env.OTEL_SERVICE_NAME || 'deputies-control-plane',
      traceExporter,
    });
    sdk.start();
    logger.info({ exporter: 'otlp-http' }, 'OpenTelemetry tracing started');
    return { close: shutdownTelemetry };
  } catch (error) {
    sdk = null;
    logger.warn({ err: error }, 'OpenTelemetry tracing failed to start');
    return null;
  }
}

export async function shutdownTelemetry(): Promise<void> {
  const current = sdk;
  if (!current) return;
  sdk = null;
  await current.shutdown();
}

function isTelemetryConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HONEYCOMB_API_KEY || env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

export function telemetryExporterOptions(env: NodeJS.ProcessEnv): ConstructorParameters<typeof OTLPTraceExporter>[0] {
  const options: NonNullable<ConstructorParameters<typeof OTLPTraceExporter>[0]> = {};
  const url =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    (env.OTEL_EXPORTER_OTLP_ENDPOINT ? traceEndpointFromBase(env.OTEL_EXPORTER_OTLP_ENDPOINT) : undefined) ||
    (env.HONEYCOMB_API_KEY ? defaultHoneycombEndpoint : undefined);
  if (url) options.url = url;

  const headers = traceHeaders(env, url);
  if (Object.keys(headers).length > 0) options.headers = headers;
  return options;
}

function traceEndpointFromBase(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}

function traceHeaders(env: NodeJS.ProcessEnv, url: string | undefined): Record<string, string> {
  const headers = {
    ...parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseOtelHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
  };
  if (url && isHoneycombEndpoint(url) && env.HONEYCOMB_API_KEY) {
    setHeaderIfMissing(headers, 'x-honeycomb-team', env.HONEYCOMB_API_KEY);
    if (env.HONEYCOMB_DATASET) setHeaderIfMissing(headers, 'x-honeycomb-dataset', env.HONEYCOMB_DATASET);
  }
  return headers;
}

export function isHoneycombEndpoint(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'api.honeycomb.io' || hostname.endsWith('.honeycomb.io');
  } catch {
    return false;
  }
}

function parseOtelHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const headers: Record<string, string> = {};
  for (const item of value.split(',')) {
    const index = item.indexOf('=');
    if (index <= 0) continue;
    const key = item.slice(0, index).trim();
    const headerValue = item.slice(index + 1).trim();
    if (key) headers[key] = headerValue;
  }
  return headers;
}

function setHeaderIfMissing(headers: Record<string, string>, key: string, value: string): void {
  const normalizedKey = key.toLowerCase();
  if (Object.keys(headers).some((header) => header.toLowerCase() === normalizedKey)) return;
  headers[key] = value;
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}
