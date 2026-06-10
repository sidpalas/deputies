import type { BrowserMilestoneName } from '@deputies/browser-milestones';
import { context, metrics, propagation, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { RunMode } from '../config/index.js';

export type TelemetryResource = { close(): Promise<void> };

const tracer = trace.getTracer('deputies-control-plane');
const meter = metrics.getMeter('deputies-control-plane');
const milestoneBuckets = [50, 100, 150, 250, 500, 750, 1_000, 2_000, 5_000, 10_000];
const milestoneHistograms = new Map<BrowserMilestoneName, ReturnType<typeof meter.createHistogram>>();
const milestoneMetricNames = {
  session_detail_ready: 'web.session_detail_ready.duration',
  session_outputs_ready: 'web.session_outputs_ready.duration',
  sandbox_services_ready: 'web.sandbox_services_ready.duration',
} satisfies Record<BrowserMilestoneName, string>;

export function startTelemetry(input: { runMode: RunMode }): TelemetryResource | null {
  if (process.env.OTEL_SDK_DISABLED === 'true') return null;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;

  const traceExporter = new OTLPTraceExporter();
  const metricExporter = new OTLPMetricExporter();
  const sdk = new NodeSDK({
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter }),
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'deputies-control-plane',
      'deputies.run_mode': input.runMode,
    }),
  });
  sdk.start();
  return { close: () => sdk.shutdown() };
}

export async function traceAsync<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = tracer.startSpan(name, { attributes });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function runWithExtractedTraceContext<T>(headers: Headers, fn: () => Promise<T>): Promise<T> {
  const carrier = Object.fromEntries(
    ['traceparent', 'tracestate'].flatMap((name) => {
      const value = headers.get(name);
      return value ? [[name, value]] : [];
    }),
  );
  return context.with(propagation.extract(context.active(), carrier), fn);
}

export function addSpanEvent(name: string, attributes: Attributes = {}): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
}

export function recordBrowserMilestone(input: {
  name: BrowserMilestoneName;
  durationMs: number;
  attributes: Attributes;
}): void {
  histogram(input.name).record(input.durationMs, input.attributes);
}

function histogram(name: BrowserMilestoneName) {
  const existing = milestoneHistograms.get(name);
  if (existing) return existing;
  const created = meter.createHistogram(milestoneMetricNames[name], {
    unit: 'ms',
    advice: { explicitBucketBoundaries: milestoneBuckets },
  });
  milestoneHistograms.set(name, created);
  return created;
}
