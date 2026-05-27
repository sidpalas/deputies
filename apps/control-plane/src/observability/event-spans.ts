import { ROOT_CONTEXT, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { EventRecord } from '../store/types.js';
import { logger } from './logger.js';

type StoredSpan = {
  span: Span;
  startedAt: Date;
  recordedAtMs: number;
};

type PendingEnd = {
  endedAt: Date;
  recordedAtMs: number;
  attributes?: Record<string, string | number | boolean>;
  error?: string;
  reason?: string;
};

type PendingAttributes = {
  attributes: Record<string, string | number | boolean>;
  recordedAtMs: number;
};

type QueueStats = {
  count: number;
  queuedAtMin: Date;
  waitMsMin: number;
  waitMsMax: number;
  waitMsAvg: number;
};

export type EventSpanTrackerOptions = {
  maxOpenSpans?: number;
  spanTtlMs?: number;
  now?: () => Date;
};

const tracer = trace.getTracer('deputies-control-plane-events');
const maxSeenEventIds = 10_000;
const defaultMaxOpenSpans = 5_000;
const defaultSpanTtlMs = 30 * 60 * 1000;

export class EventSpanTracker {
  private readonly maxOpenSpans: number;
  private readonly spanTtlMs: number;
  private readonly now: () => Date;
  private readonly seenEventIds: number[] = [];
  private readonly seenEvents = new Set<number>();
  private readonly rootRuns = new Map<string, StoredSpan>();
  private readonly sandboxes = new Map<string, StoredSpan>();
  private readonly runs = new Map<string, StoredSpan>();
  private readonly tools = new Map<string, StoredSpan>();
  private readonly messageCreatedAtBySequence = new Map<string, Date>();
  private readonly llmWaitStartedAtByRun = new Map<string, Date>();
  private readonly implicitToolKeys = new Map<string, string[]>();
  private readonly pendingRootEnds = new Map<string, PendingEnd>();
  private readonly pendingRunEnds = new Map<string, PendingEnd>();
  private readonly pendingSandboxEnds = new Map<string, PendingEnd>();
  private readonly pendingToolEnds = new Map<string, PendingEnd>();
  private readonly pendingImplicitToolEnds = new Map<string, PendingEnd[]>();
  private readonly pendingRootAttributes = new Map<string, PendingAttributes>();
  private readonly pendingRunAttributes = new Map<string, PendingAttributes>();

  constructor(options: EventSpanTrackerOptions = {}) {
    this.maxOpenSpans = options.maxOpenSpans ?? defaultMaxOpenSpans;
    this.spanTtlMs = options.spanTtlMs ?? defaultSpanTtlMs;
    this.now = options.now ?? (() => new Date());
  }

  record(event: EventRecord): void {
    if (this.isDuplicate(event.id)) return;
    try {
      this.prune(this.now());
      this.recordUnsafe(event);
    } catch (error) {
      logger.warn({ err: error, eventType: event.type, eventId: event.id }, 'Event tracing failed');
    }
  }

  close(): void {
    const endedAt = this.now();
    for (const span of this.tools.values()) endSpan(span, endedAt, undefined, 'shutdown');
    for (const span of this.runs.values()) endSpan(span, endedAt, undefined, 'shutdown');
    for (const span of this.sandboxes.values()) endSpan(span, endedAt, undefined, 'shutdown');
    for (const span of this.rootRuns.values()) endSpan(span, endedAt, undefined, 'shutdown');
    this.rootRuns.clear();
    this.sandboxes.clear();
    this.runs.clear();
    this.tools.clear();
    this.messageCreatedAtBySequence.clear();
    this.llmWaitStartedAtByRun.clear();
    this.implicitToolKeys.clear();
    this.pendingRootEnds.clear();
    this.pendingRunEnds.clear();
    this.pendingSandboxEnds.clear();
    this.pendingToolEnds.clear();
    this.pendingImplicitToolEnds.clear();
    this.pendingRootAttributes.clear();
    this.pendingRunAttributes.clear();
  }

  private recordUnsafe(event: EventRecord): void {
    switch (event.type) {
      case 'message_created':
        this.recordMessageCreated(event);
        return;
      case 'message_started':
        this.startRootRun(event);
        return;
      case 'message_completed':
        this.endRootRun(event, undefined, 'message_completed');
        return;
      case 'message_failed':
        this.endRootRun(event, event.payload.error);
        return;
      case 'message_cancelled':
        this.endRootRun(event, 'cancelled');
        return;
      case 'run_started':
        this.startRun(event);
        return;
      case 'sandbox_starting':
        this.startSandbox(event);
        return;
      case 'sandbox_ready':
        this.endSandbox(event);
        return;
      case 'repository_ready':
        this.recordRepositoryReady(event);
        return;
      case 'run_completed':
        this.closeLlmWait(event.runId, event.createdAt, 'before_run_end');
        this.endRun(event);
        return;
      case 'run_failed':
        this.closeLlmWait(event.runId, event.createdAt, 'before_run_failure');
        this.endRun(event, event.payload.error);
        this.endSandbox(event, event.payload.error);
        this.endRootRun(event, event.payload.error);
        return;
      case 'run_cancelled':
        this.closeLlmWait(event.runId, event.createdAt, 'before_run_cancelled');
        this.endRun(event, 'cancelled');
        this.endSandbox(event, 'cancelled');
        this.endRootRun(event, 'cancelled');
        return;
      case 'agent_response_final':
        this.recordAgentResponse(event);
        return;
      case 'agent_text_delta':
        this.recordAgentOutput(event);
        return;
      case 'tool_started':
        this.startTool(event);
        return;
      case 'tool_finished':
        this.endTool(event);
        return;
      default:
        return;
    }
  }

  private isDuplicate(eventId: number): boolean {
    if (this.seenEvents.has(eventId)) return true;
    this.seenEvents.add(eventId);
    this.seenEventIds.push(eventId);
    while (this.seenEventIds.length > maxSeenEventIds) {
      const expired = this.seenEventIds.shift();
      if (expired !== undefined) this.seenEvents.delete(expired);
    }
    return false;
  }

  private recordMessageCreated(event: EventRecord & { type: 'message_created' }): void {
    if (event.payload.transcriptOnly) return;
    this.messageCreatedAtBySequence.set(messageSequenceKey(event.sessionId, event.payload.sequence), event.createdAt);
  }

  private startRootRun(event: EventRecord & { type: 'message_started' }): void {
    if (!event.runId) return;
    const queueStats = this.queueStats(event);
    const span = tracer.startSpan(
      'run queue-to-response',
      {
        startTime: queueStats?.queuedAtMin ?? event.createdAt,
        attributes: {
          ...eventAttributes(event),
          'message.batch_size': event.payload.batchSize,
          'message.sequences': event.payload.sequences.join(','),
          ...(queueStats ? queueAttributes(queueStats) : {}),
        },
      },
      ROOT_CONTEXT,
    );
    this.setSpan(this.rootRuns, event.runId, this.storedSpan(span, event.createdAt));
    if (queueStats) this.recordQueueWaitSpan(event, queueStats);
    this.applyPendingAttributes(this.rootRuns, this.pendingRootAttributes, event.runId);
    this.applyPendingEnd(this.rootRuns, this.pendingRootEnds, event.runId);
  }

  private queueStats(event: EventRecord & { type: 'message_started' }): QueueStats | null {
    const queuedTimes = event.payload.sequences.flatMap((sequence) => {
      const payloadQueuedAt = event.payload.queuedAtBySequence?.[String(sequence)];
      const queuedAt = payloadQueuedAt ? dateFromString(payloadQueuedAt) : undefined;
      const fallback = this.messageCreatedAtBySequence.get(messageSequenceKey(event.sessionId, sequence));
      this.messageCreatedAtBySequence.delete(messageSequenceKey(event.sessionId, sequence));
      return queuedAt ?? fallback ?? [];
    });
    if (queuedTimes.length === 0) return null;
    const waits = queuedTimes.map((queuedAt) => Math.max(0, event.createdAt.getTime() - queuedAt.getTime()));
    return {
      count: queuedTimes.length,
      queuedAtMin: new Date(Math.min(...queuedTimes.map((queuedAt) => queuedAt.getTime()))),
      waitMsMin: Math.min(...waits),
      waitMsMax: Math.max(...waits),
      waitMsAvg: Math.round(waits.reduce((sum, value) => sum + value, 0) / waits.length),
    };
  }

  private recordQueueWaitSpan(event: EventRecord & { type: 'message_started' }, queueStats: QueueStats): void {
    const parent = event.runId ? this.rootRuns.get(event.runId) : undefined;
    const span = tracer.startSpan(
      'queue wait',
      {
        startTime: queueStats.queuedAtMin,
        attributes: {
          ...eventAttributes(event),
          ...queueAttributes(queueStats),
        },
      },
      spanContext(parent),
    );
    endSpan(this.storedSpan(span, queueStats.queuedAtMin), event.createdAt);
  }

  private endRootRun(
    event: EventRecord & {
      type: 'message_completed' | 'message_failed' | 'message_cancelled' | 'run_failed' | 'run_cancelled';
    },
    error?: string,
    reason?: string,
  ): void {
    if (!event.runId) return;
    const pending = this.pendingEnd(event.createdAt, error, reason);
    this.endSpanOrStore(this.rootRuns, this.pendingRootEnds, event.runId, pending);
  }

  private recordAgentResponse(event: EventRecord & { type: 'agent_response_final' }): void {
    if (!event.runId) return;
    this.setOrStoreAttributes(this.rootRuns, this.pendingRootAttributes, event.runId, {
      'agent.response.length': event.payload.text.length,
    });
  }

  private startRun(event: EventRecord & { type: 'run_started' }): void {
    if (!event.runId) return;
    const parent = this.rootRuns.get(event.runId);
    const attributes = {
      ...eventAttributes(event),
      'runner.type': event.payload.runner,
    };
    if (parent) parent.span.setAttribute('runner.type', event.payload.runner);
    const span = tracer.startSpan(
      `run ${event.payload.runner}`,
      { startTime: event.createdAt, attributes },
      spanContext(parent),
    );
    this.setSpan(this.runs, event.runId, this.storedSpan(span, event.createdAt));
    this.applyPendingAttributes(this.runs, this.pendingRunAttributes, event.runId);
    this.applyPendingEnd(this.runs, this.pendingRunEnds, event.runId);
    this.startLlmWait(event);
  }

  private recordAgentOutput(event: EventRecord & { type: 'agent_text_delta' }): void {
    if (!event.runId) return;
    this.closeLlmWait(event.runId, event.createdAt, 'before_text_delta');
  }

  private startSandbox(event: EventRecord & { type: 'sandbox_starting' }): void {
    const key = runScopedKey(event);
    if (!key) return;
    const parent = event.runId ? this.rootRuns.get(event.runId) : undefined;
    const span = tracer.startSpan(
      `sandbox ${event.payload.provider}`,
      {
        startTime: event.createdAt,
        attributes: {
          ...eventAttributes(event),
          'sandbox.provider': event.payload.provider,
        },
      },
      spanContext(parent),
    );
    this.setSpan(this.sandboxes, key, this.storedSpan(span, event.createdAt));
    this.applyPendingEnd(this.sandboxes, this.pendingSandboxEnds, key);
  }

  private endSandbox(
    event: EventRecord & { type: 'sandbox_ready' | 'run_failed' | 'run_cancelled' },
    error?: string,
  ): void {
    const key = runScopedKey(event);
    if (!key) return;
    const attributes = event.type === 'sandbox_ready' ? sandboxReadyAttributes(event) : undefined;
    const pending = this.pendingEnd(event.createdAt, error, undefined, attributes);
    this.endSpanOrStore(this.sandboxes, this.pendingSandboxEnds, key, pending);
  }

  private recordRepositoryReady(event: EventRecord & { type: 'repository_ready' }): void {
    if (!event.runId) return;
    const attributes = repositoryAttributes(event);
    this.setOrStoreAttributes(this.runs, this.pendingRunAttributes, event.runId, attributes);
    this.setOrStoreAttributes(this.rootRuns, this.pendingRootAttributes, event.runId, attributes);
  }

  private endRun(
    event: EventRecord & { type: 'run_completed' | 'run_failed' | 'run_cancelled' },
    error?: string,
  ): void {
    if (!event.runId) return;
    this.endSpanOrStore(this.runs, this.pendingRunEnds, event.runId, this.pendingEnd(event.createdAt, error));
  }

  private startTool(event: EventRecord & { type: 'tool_started' }): void {
    const explicitKey = explicitToolKey(event);
    const queueKey = implicitToolQueueKey(event);
    const key = explicitKey ?? (queueKey ? `${queueKey}:${event.id}` : null);
    if (!key) return;
    if (event.runId) this.closeLlmWait(event.runId, event.createdAt, 'before_tool');

    const parent = event.runId ? (this.runs.get(event.runId) ?? this.rootRuns.get(event.runId)) : undefined;
    const span = tracer.startSpan(
      `tool ${event.payload.toolName}`,
      {
        startTime: event.createdAt,
        attributes: {
          ...eventAttributes(event),
          ...toolAttributes(event),
        },
      },
      spanContext(parent),
    );
    this.setSpan(this.tools, key, this.storedSpan(span, event.createdAt));

    if (explicitKey) {
      this.applyPendingEnd(this.tools, this.pendingToolEnds, explicitKey);
      return;
    }

    const pending = queueKey ? this.pendingImplicitToolEnds.get(queueKey)?.shift() : undefined;
    if (queueKey && this.pendingImplicitToolEnds.get(queueKey)?.length === 0)
      this.pendingImplicitToolEnds.delete(queueKey);
    if (pending) {
      this.endSpanOrStore(this.tools, this.pendingToolEnds, key, pending);
      return;
    }
    if (queueKey) {
      const queue = this.implicitToolKeys.get(queueKey) ?? [];
      queue.push(key);
      this.implicitToolKeys.set(queueKey, queue);
    }
  }

  private endTool(event: EventRecord & { type: 'tool_finished' }): void {
    const explicitKey = explicitToolKey(event);
    const attributes = toolAttributes(event);
    const pending = this.pendingEnd(
      event.createdAt,
      event.payload.isError ? errorString(event.payload.error) : undefined,
      undefined,
      attributes,
    );
    if (explicitKey) {
      this.endSpanOrStore(this.tools, this.pendingToolEnds, explicitKey, pending);
      this.startLlmWait(event);
      return;
    }

    const queueKey = implicitToolQueueKey(event);
    if (!queueKey) return;
    const queue = this.implicitToolKeys.get(queueKey);
    const key = queue?.shift();
    if (queue?.length === 0) this.implicitToolKeys.delete(queueKey);
    if (key) {
      this.endSpanOrStore(this.tools, this.pendingToolEnds, key, pending);
      this.startLlmWait(event);
      return;
    }
    const pendingQueue = this.pendingImplicitToolEnds.get(queueKey) ?? [];
    pendingQueue.push(pending);
    this.pendingImplicitToolEnds.set(queueKey, pendingQueue);
    this.startLlmWait(event);
  }

  private startLlmWait(event: EventRecord & { type: 'tool_finished' | 'run_started' }): void {
    if (!event.runId) return;
    const run = this.runs.get(event.runId);
    if (!run) return;
    this.llmWaitStartedAtByRun.set(event.runId, event.createdAt);
  }

  private closeLlmWait(runId: string | undefined, endedAt: Date, reason: string): void {
    if (!runId) return;
    const startedAt = this.llmWaitStartedAtByRun.get(runId);
    if (!startedAt) return;
    this.llmWaitStartedAtByRun.delete(runId);
    if (endedAt.getTime() <= startedAt.getTime()) return;
    const parent = this.runs.get(runId) ?? this.rootRuns.get(runId);
    const span = tracer.startSpan(
      'llm wait',
      {
        startTime: startedAt,
        attributes: {
          'run.id': runId,
          'llm.wait.reason': reason,
        },
      },
      spanContext(parent),
    );
    endSpan(this.storedSpan(span, startedAt), endedAt);
  }

  private storedSpan(span: Span, startedAt: Date): StoredSpan {
    return { span, startedAt, recordedAtMs: this.now().getTime() };
  }

  private pendingEnd(
    endedAt: Date,
    error?: string,
    reason?: string,
    attributes?: Record<string, string | number | boolean>,
  ): PendingEnd {
    const pending: PendingEnd = { endedAt, recordedAtMs: this.now().getTime() };
    if (error) pending.error = error;
    if (reason) pending.reason = reason;
    if (attributes) pending.attributes = attributes;
    return pending;
  }

  private setSpan(map: Map<string, StoredSpan>, key: string, stored: StoredSpan): void {
    const existing = map.get(key);
    if (existing) endSpan(existing, stored.startedAt, undefined, 'duplicate_start_replaced');
    map.set(key, stored);
    this.prune(this.now());
  }

  private endSpanOrStore(
    spans: Map<string, StoredSpan>,
    pendingEnds: Map<string, PendingEnd>,
    key: string,
    pending: PendingEnd,
  ): void {
    const stored = spans.get(key);
    if (!stored) {
      pendingEnds.set(key, pending);
      return;
    }
    spans.delete(key);
    if (pending.attributes) setAttributes(stored.span, pending.attributes);
    endSpan(stored, pending.endedAt, pending.error, pending.reason);
  }

  private applyPendingEnd(spans: Map<string, StoredSpan>, pendingEnds: Map<string, PendingEnd>, key: string): void {
    const pending = pendingEnds.get(key);
    if (!pending) return;
    pendingEnds.delete(key);
    this.endSpanOrStore(spans, pendingEnds, key, pending);
  }

  private setOrStoreAttributes(
    spans: Map<string, StoredSpan>,
    pendingAttributes: Map<string, PendingAttributes>,
    key: string,
    attributes: Record<string, string | number | boolean>,
  ): void {
    const stored = spans.get(key);
    if (stored) {
      setAttributes(stored.span, attributes);
      return;
    }
    const existing = pendingAttributes.get(key)?.attributes ?? {};
    pendingAttributes.set(key, {
      attributes: { ...existing, ...attributes },
      recordedAtMs: this.now().getTime(),
    });
  }

  private applyPendingAttributes(
    spans: Map<string, StoredSpan>,
    pendingAttributes: Map<string, PendingAttributes>,
    key: string,
  ): void {
    const pending = pendingAttributes.get(key);
    const stored = spans.get(key);
    if (!pending || !stored) return;
    pendingAttributes.delete(key);
    setAttributes(stored.span, pending.attributes);
  }

  private prune(now: Date): void {
    const nowMs = now.getTime();
    this.pruneSpans(this.tools, now, nowMs);
    this.pruneSpans(this.runs, now, nowMs);
    this.pruneSpans(this.sandboxes, now, nowMs);
    this.pruneSpans(this.rootRuns, now, nowMs);
    this.prunePending(nowMs);
    this.pruneImplicitToolQueues();
    this.enforceOpenSpanLimit(now);
  }

  private pruneSpans(spans: Map<string, StoredSpan>, now: Date, nowMs: number): void {
    for (const [key, stored] of spans) {
      if (nowMs - stored.recordedAtMs <= this.spanTtlMs) continue;
      spans.delete(key);
      endSpan(stored, now, undefined, 'ttl_expired');
    }
  }

  private prunePending(nowMs: number): void {
    prunePendingMap(this.pendingRootEnds, nowMs, this.spanTtlMs);
    prunePendingMap(this.pendingRunEnds, nowMs, this.spanTtlMs);
    prunePendingMap(this.pendingSandboxEnds, nowMs, this.spanTtlMs);
    prunePendingMap(this.pendingToolEnds, nowMs, this.spanTtlMs);
    prunePendingAttributesMap(this.pendingRootAttributes, nowMs, this.spanTtlMs);
    prunePendingAttributesMap(this.pendingRunAttributes, nowMs, this.spanTtlMs);
    for (const [key, queuedAt] of this.messageCreatedAtBySequence) {
      if (nowMs - queuedAt.getTime() > this.spanTtlMs) this.messageCreatedAtBySequence.delete(key);
    }
    for (const [runId, startedAt] of this.llmWaitStartedAtByRun) {
      if (nowMs - startedAt.getTime() > this.spanTtlMs) this.llmWaitStartedAtByRun.delete(runId);
    }
    for (const [key, pending] of this.pendingImplicitToolEnds) {
      const kept = pending.filter((item) => nowMs - item.recordedAtMs <= this.spanTtlMs);
      if (kept.length) this.pendingImplicitToolEnds.set(key, kept);
      else this.pendingImplicitToolEnds.delete(key);
    }
  }

  private pruneImplicitToolQueues(): void {
    for (const [key, queue] of this.implicitToolKeys) {
      const kept = queue.filter((toolKey) => this.tools.has(toolKey));
      if (kept.length) this.implicitToolKeys.set(key, kept);
      else this.implicitToolKeys.delete(key);
    }
  }

  private enforceOpenSpanLimit(now: Date): void {
    while (this.openSpanCount() > this.maxOpenSpans) {
      const oldest = this.oldestOpenSpan();
      if (!oldest) return;
      oldest.spans.delete(oldest.key);
      endSpan(oldest.stored, now, undefined, 'open_span_limit');
    }
    this.pruneImplicitToolQueues();
  }

  private openSpanCount(): number {
    return this.rootRuns.size + this.sandboxes.size + this.runs.size + this.tools.size;
  }

  private oldestOpenSpan(): { spans: Map<string, StoredSpan>; key: string; stored: StoredSpan } | null {
    let oldest: { spans: Map<string, StoredSpan>; key: string; stored: StoredSpan } | null = null;
    for (const spans of [this.rootRuns, this.sandboxes, this.runs, this.tools]) {
      for (const [key, stored] of spans) {
        if (!oldest || stored.recordedAtMs < oldest.stored.recordedAtMs) oldest = { spans, key, stored };
      }
    }
    return oldest;
  }
}

function sandboxReadyAttributes(
  event: EventRecord & { type: 'sandbox_ready' },
): Record<string, string | number | boolean> {
  return compactAttributes({
    'sandbox.provider': event.payload.provider,
    'sandbox.provider_sandbox_id': event.payload.providerSandboxId,
    'sandbox.created': event.payload.created,
    'sandbox.restarted': event.payload.restarted,
    'sandbox.workspace_path': event.payload.workspacePath,
  });
}

function repositoryAttributes(
  event: EventRecord & { type: 'repository_ready' },
): Record<string, string | number | boolean> {
  return compactAttributes({
    'repository.provider': event.payload.provider,
    'repository.owner': event.payload.owner,
    'repository.repo': event.payload.repo,
    'repository.branch': event.payload.branch,
  });
}

function queueAttributes(stats: QueueStats): Record<string, string | number | boolean> {
  return {
    'queue.message_count': stats.count,
    'queue.wait_ms_min': stats.waitMsMin,
    'queue.wait_ms_max': stats.waitMsMax,
    'queue.wait_ms_avg': stats.waitMsAvg,
  };
}

function endSpan(stored: StoredSpan, endedAt: Date, error?: string, reason?: string): void {
  if (error) {
    stored.span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    stored.span.setAttribute('error.message', error);
  }
  if (reason) stored.span.setAttribute('deputies.span_end_reason', reason);
  stored.span.setAttribute('duration.ms', Math.max(0, endedAt.getTime() - stored.startedAt.getTime()));
  stored.span.end(endedAt);
}

function eventAttributes(event: EventRecord): Record<string, string | number | boolean> {
  return compactAttributes({
    'deputies.event_id': event.id,
    'deputies.event_sequence': event.sequence,
    'deputies.event_type': event.type,
    'session.id': event.sessionId,
    'run.id': event.runId,
    'message.id': event.messageId,
  });
}

function toolAttributes(
  event: EventRecord & { type: 'tool_started' | 'tool_finished' },
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean | undefined> = {
    'tool.name': event.payload.toolName,
    'tool.call_id': event.payload.toolCallId,
    'tool.task_id': event.payload.taskId,
    'flue.session_id': event.payload.flueSessionId,
  };
  if (event.type === 'tool_started') attributes['tool.has_args'] = event.payload.args !== undefined;
  if (event.type === 'tool_finished') {
    attributes['tool.has_result'] = event.payload.result !== undefined;
    attributes['tool.is_error'] = event.payload.isError ?? false;
  }
  return compactAttributes(attributes);
}

function setAttributes(span: Span, attributes: Record<string, string | number | boolean>): void {
  for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
}

function explicitToolKey(event: EventRecord & { type: 'tool_started' | 'tool_finished' }): string | null {
  const id = event.payload.toolCallId ?? event.payload.taskId;
  if (!event.runId || !id) return null;
  return `${event.runId}:${event.payload.toolName}:${id}`;
}

function implicitToolQueueKey(event: EventRecord & { type: 'tool_started' | 'tool_finished' }): string | null {
  if (!event.runId) return null;
  return `${event.runId}:${event.payload.toolName}`;
}

function runScopedKey(event: Pick<EventRecord, 'runId'>): string | null {
  return event.runId ?? null;
}

function messageSequenceKey(sessionId: string, sequence: number): string {
  return `${sessionId}:${sequence}`;
}

function dateFromString(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function spanContext(stored: StoredSpan | undefined) {
  return stored ? trace.setSpan(ROOT_CONTEXT, stored.span) : ROOT_CONTEXT;
}

function errorString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Tool failed';
}

function prunePendingMap(pending: Map<string, PendingEnd>, nowMs: number, ttlMs: number): void {
  for (const [key, item] of pending) {
    if (nowMs - item.recordedAtMs > ttlMs) pending.delete(key);
  }
}

function prunePendingAttributesMap(pending: Map<string, PendingAttributes>, nowMs: number, ttlMs: number): void {
  for (const [key, item] of pending) {
    if (nowMs - item.recordedAtMs > ttlMs) pending.delete(key);
  }
}

function compactAttributes(input: Record<string, string | number | boolean | undefined>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Record<
    string,
    string | number | boolean
  >;
}
