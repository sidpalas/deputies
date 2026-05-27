import { ROOT_CONTEXT, trace, type Context, type Span, type SpanContext, type Tracer } from '@opentelemetry/api';
import pino from 'pino';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';

import { EventService } from '../../src/events/service.js';
import { EventSpanTracker } from '../../src/observability/event-spans.js';
import { loggerRedactPaths } from '../../src/observability/logger.js';
import { telemetryExporterOptions } from '../../src/observability/telemetry.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { EventRecord } from '../../src/store/types.js';

type RecordedSpan = {
  name: string;
  attributes: Record<string, unknown>;
  context: SpanContext;
  startedAt?: Date;
  parentSpanId?: string;
  status?: { code: number; message?: string };
  endedAt?: Date;
};

describe('observability', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider({ getTracer: () => tracer as unknown as Tracer });
  });

  beforeEach(() => {
    tracer.reset();
  });

  it('subscribes event span projection to local events only', async () => {
    const events = new EventService(new MemoryStore());
    const local: EventRecord[] = [];
    const all: EventRecord[] = [];
    events.subscribeLocalEvents((event) => local.push(event));
    events.subscribeAllEvents((event) => all.push(event));

    const localEvent = await events.append({
      sessionId: 'session-1',
      type: 'session_created',
      payload: { title: null },
    });
    const externalEvent = { ...localEvent, id: localEvent.id + 1, sequence: localEvent.sequence + 1 };
    events.publishExternal(externalEvent);

    expect(local.map((event) => event.id)).toEqual([localEvent.id]);
    expect(all.map((event) => event.id)).toEqual([localEvent.id, externalEvent.id]);
  });

  it('keeps the root run span open until message completion and parents child spans under it', () => {
    const tracker = new EventSpanTracker({ now: () => time(20) });

    tracker.record(
      testEvent(
        'message_created',
        { sequence: 1, source: null },
        { id: 1, createdAt: time(-10), messageId: 'message-1' },
      ),
    );
    tracker.record(testEvent('message_started', { sequences: [1], batchSize: 1 }, { id: 2, createdAt: time(0) }));
    tracker.record(testEvent('sandbox_starting', { provider: 'fake' }, { id: 3, createdAt: time(1) }));
    tracker.record(
      testEvent(
        'sandbox_ready',
        { provider: 'fake', providerSandboxId: 'sandbox-1', created: true, workspacePath: '/workspace' },
        { id: 4, createdAt: time(2) },
      ),
    );
    tracker.record(testEvent('run_started', { runner: 'flue' }, { id: 5, createdAt: time(3) }));
    tracker.record(
      testEvent('tool_started', { toolName: 'shell', toolCallId: 'tool-1' }, { id: 7, createdAt: time(6) }),
    );
    tracker.record(
      testEvent(
        'tool_finished',
        { toolName: 'shell', toolCallId: 'tool-1', result: 'ok' },
        { id: 8, createdAt: time(8) },
      ),
    );
    tracker.record(testEvent('agent_text_delta', { text: 'hello' }, { id: 9, createdAt: time(10) }));
    tracker.record(testEvent('agent_response_final', { text: 'hello' }, { id: 10, createdAt: time(11) }));
    tracker.record(testEvent('run_completed', { runner: 'flue' }, { id: 12, createdAt: time(13) }));

    const root = tracer.span('run queue-to-response');
    const queue = tracer.span('queue wait');
    const run = tracer.span('run flue');
    const sandbox = tracer.span('sandbox fake');
    const tool = tracer.span('tool shell');
    const waitSpans = tracer.spans.filter((span) => span.name === 'llm wait');
    expect(root.endedAt).toBeUndefined();
    expect(root.startedAt).toEqual(time(-10));
    expect(root.attributes['queue.wait_ms_max']).toBe(10);
    expect(queue.parentSpanId).toBe(root.context.spanId);
    expect(queue.endedAt).toEqual(time(0));
    expect(run.parentSpanId).toBe(root.context.spanId);
    expect(sandbox.parentSpanId).toBe(root.context.spanId);
    expect(tool.parentSpanId).toBe(run.context.spanId);
    expect(waitSpans).toHaveLength(2);
    expect(waitSpans.map((span) => span.parentSpanId)).toEqual([run.context.spanId, run.context.spanId]);
    expect(waitSpans.map((span) => span.attributes['llm.wait.reason'])).toEqual(['before_tool', 'before_text_delta']);
    expect(root.attributes['agent.response.length']).toBe(5);

    tracker.record(testEvent('message_completed', { sequence: 1 }, { id: 13, createdAt: time(14) }));

    expect(root.endedAt).toEqual(time(14));
    expect(root.attributes['deputies.span_end_reason']).toBe('message_completed');
  });

  it('records queue wait for batched queued messages', () => {
    const tracker = new EventSpanTracker();

    tracker.record(
      testEvent(
        'message_started',
        {
          sequences: [1, 2],
          batchSize: 2,
          queuedAtBySequence: { '1': time(0).toISOString(), '2': time(50).toISOString() },
        },
        { id: 1, createdAt: time(100) },
      ),
    );

    const root = tracer.span('run queue-to-response');
    const queue = tracer.span('queue wait');
    expect(root.startedAt).toEqual(time(0));
    expect(root.attributes['queue.message_count']).toBe(2);
    expect(root.attributes['queue.wait_ms_min']).toBe(50);
    expect(root.attributes['queue.wait_ms_max']).toBe(100);
    expect(root.attributes['queue.wait_ms_avg']).toBe(75);
    expect(queue.startedAt).toEqual(time(0));
    expect(queue.endedAt).toEqual(time(100));
  });

  it('buffers terminal events that arrive before their start events', () => {
    const tracker = new EventSpanTracker();

    tracker.record(
      testEvent(
        'tool_finished',
        { toolName: 'shell', toolCallId: 'tool-1', result: 'ok' },
        { id: 1, createdAt: time(2) },
      ),
    );
    tracker.record(
      testEvent('tool_started', { toolName: 'shell', toolCallId: 'tool-1' }, { id: 2, createdAt: time(1) }),
    );

    expect(tracer.span('tool shell').endedAt).toEqual(time(2));
  });

  it('ends replaced duplicate spans and TTL-expired open spans', () => {
    let now = time(0);
    const tracker = new EventSpanTracker({ spanTtlMs: 10, now: () => now });

    tracker.record(testEvent('message_started', { sequences: [1], batchSize: 1 }, { id: 1, createdAt: time(0) }));
    tracker.record(testEvent('message_started', { sequences: [1], batchSize: 1 }, { id: 2, createdAt: time(1) }));
    const replaced = tracer.spans.filter((span) => span.name === 'run queue-to-response')[0]!;
    expect(replaced.attributes['deputies.span_end_reason']).toBe('duplicate_start_replaced');

    now = time(20);
    tracker.record(testEvent('session_updated', { title: null }, { id: 3, createdAt: time(20) }));
    const expired = tracer.spans.filter((span) => span.name === 'run queue-to-response')[1]!;
    expect(expired.attributes['deputies.span_end_reason']).toBe('ttl_expired');
  });

  it('synthesizes Honeycomb headers only for Honeycomb endpoints', () => {
    const direct = telemetryExporterOptions({ HONEYCOMB_API_KEY: 'hny-key' }) as {
      url?: string;
      headers?: Record<string, string>;
    };
    expect(direct.url).toBe('https://api.honeycomb.io/v1/traces');
    expect(direct.headers?.['x-honeycomb-team']).toBe('hny-key');

    const collector = telemetryExporterOptions({
      HONEYCOMB_API_KEY: 'hny-key',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
    }) as { url?: string; headers?: Record<string, string> };
    expect(collector.url).toBe('https://collector.example.com/v1/traces');
    expect(collector.headers?.['x-honeycomb-team']).toBeUndefined();

    const explicit = telemetryExporterOptions({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer token',
    }) as { headers?: Record<string, string> };
    expect(explicit.headers?.authorization).toBe('Bearer token');
  });

  it('redacts nested secrets from structured logs', () => {
    const lines: string[] = [];
    const testLogger = pino(
      { base: null, redact: { paths: loggerRedactPaths } },
      { write: (line: string) => lines.push(line) },
    );

    testLogger.info({
      accessToken: 'top-secret-token',
      headers: { authorization: 'Bearer top-secret-auth' },
      err: {
        config: { headers: { Authorization: 'Bearer nested-secret', 'set-cookie': 'session=secret' } },
        privateKey: 'private-secret',
      },
    });

    const log = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(JSON.stringify(log)).not.toContain('top-secret');
    expect(JSON.stringify(log)).not.toContain('nested-secret');
    expect(JSON.stringify(log)).not.toContain('private-secret');
  });
});

function testEvent<T extends EventRecord['type']>(
  type: T,
  payload: Extract<EventRecord, { type: T }>['payload'],
  overrides: Partial<EventRecord> = {},
): EventRecord & { type: T } {
  return {
    id: overrides.id ?? 1,
    sequence: overrides.sequence ?? overrides.id ?? 1,
    sessionId: overrides.sessionId ?? 'session-1',
    runId: overrides.runId ?? 'run-1',
    messageId: overrides.messageId ?? 'message-1',
    type,
    payload,
    createdAt: overrides.createdAt ?? time(0),
  } as EventRecord & { type: T };
}

function time(ms: number): Date {
  return new Date(ms);
}

class FakeTracer {
  readonly spans: RecordedSpan[] = [];
  private nextSpanId = 1;

  startSpan(
    name: string,
    options: { attributes?: Record<string, unknown>; startTime?: Date } = {},
    ctx: Context = ROOT_CONTEXT,
  ): Span {
    const parent = trace.getSpan(ctx);
    const parentContext = parent?.spanContext();
    const span: RecordedSpan = {
      name,
      attributes: { ...(options.attributes ?? {}) },
      context: {
        traceId: parentContext?.traceId ?? '00000000000000000000000000000001',
        spanId: this.spanId(),
        traceFlags: 1,
      },
      ...(options.startTime ? { startedAt: options.startTime } : {}),
      ...(parentContext ? { parentSpanId: parentContext.spanId } : {}),
    };
    this.spans.push(span);
    return fakeSpan(span);
  }

  span(name: string): RecordedSpan {
    const span = this.spans.find((candidate) => candidate.name === name);
    if (!span) throw new Error(`Span not found: ${name}`);
    return span;
  }

  reset(): void {
    this.spans.length = 0;
    this.nextSpanId = 1;
  }

  private spanId(): string {
    return (this.nextSpanId++).toString(16).padStart(16, '0');
  }
}

function fakeSpan(record: RecordedSpan): Span {
  return {
    spanContext: () => record.context,
    setAttribute: (key: string, value: unknown) => {
      record.attributes[key] = value;
      return fakeSpan(record);
    },
    setAttributes: (attributes: Record<string, unknown>) => {
      Object.assign(record.attributes, attributes);
      return fakeSpan(record);
    },
    addEvent: () => fakeSpan(record),
    addLink: () => fakeSpan(record),
    addLinks: () => fakeSpan(record),
    setStatus: (status: { code: number; message?: string }) => {
      record.status = status;
      return fakeSpan(record);
    },
    updateName: (name: string) => {
      record.name = name;
      return fakeSpan(record);
    },
    end: (endTime?: Date) => {
      if (endTime) record.endedAt = endTime;
    },
    isRecording: () => true,
    recordException: () => undefined,
  } as Span;
}

const tracer = new FakeTracer();
