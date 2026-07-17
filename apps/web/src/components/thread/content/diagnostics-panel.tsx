import { useState, type MouseEvent, type ReactNode } from 'react';
import type { AgentEvent } from '../../../api.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { DebugCode, DebugText, JsonPayload } from './debug-code.js';

type DiagnosticActivity = {
  key: string;
  title: string;
  subtitle: string;
  status: 'started' | 'completed' | 'failed' | 'info';
  createdAt: string;
  command?: string;
  detail?: string;
  error?: string;
  rawEvents: AgentEvent[];
};

type DiagnosticFailureAnalysis = {
  title: string;
  detail: string;
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
  day: 'numeric',
});

export function Diagnostics(props: { events: AgentEvent[] }) {
  if (!props.events.length) return null;

  return (
    <LazyDetails
      className="min-w-0 rounded-md border border-border bg-muted/30 p-2"
      summaryClassName="cursor-pointer text-sm text-muted-foreground"
      summary={`Activity · ${props.events.length} events`}
    >
      {({ close }) => {
        const failureAnalysis = analyzeDiagnosticFailure(props.events);
        const activities = buildDiagnosticActivities(props.events);

        return (
          <div className="mt-2 grid min-w-0 gap-2">
            {failureAnalysis ? <FailureAnalysisNotice analysis={failureAnalysis} /> : null}
            {activities.map((activity) => (
              <DiagnosticActivityCard activity={activity} key={activity.key} />
            ))}
            <Button className="justify-self-start px-2" type="button" variant="secondary" size="sm" onClick={close}>
              Collapse activity
            </Button>
          </div>
        );
      }}
    </LazyDetails>
  );
}

function LazyDetails(props: {
  children: (state: { close: () => void }) => ReactNode;
  className?: string;
  summary: ReactNode;
  summaryClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  function handleSummaryClick(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    setOpen((current) => !current);
  }

  return (
    <details className={props.className} open={open}>
      <summary className={props.summaryClassName} onClick={handleSummaryClick}>
        {props.summary}
      </summary>
      {open ? props.children({ close: () => setOpen(false) }) : null}
    </details>
  );
}

function FailureAnalysisNotice(props: { analysis: DiagnosticFailureAnalysis }) {
  return (
    <div
      className="rounded-md border border-warning/50 bg-warning/10 p-2 text-sm text-warning-foreground dark:text-warning"
      role="note"
    >
      <strong className="block text-foreground dark:text-warning">{props.analysis.title}</strong>
      <p className="mt-1">{props.analysis.detail}</p>
    </div>
  );
}

function DiagnosticActivityCard(props: { activity: DiagnosticActivity }) {
  const { activity } = props;
  return (
    <article className="min-w-0 rounded-md border border-border bg-card/80 p-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-xs text-muted-foreground">
            {formatDate(activity.createdAt)} · {activity.subtitle}
          </span>
          <strong className="mt-1 block break-words text-sm font-medium text-foreground">{activity.title}</strong>
        </div>
        <Badge className={diagnosticStatusClass(activity.status)}>{diagnosticStatusLabel(activity.status)}</Badge>
      </div>
      {activity.command ? <DebugCode code={activity.command} language="bash" label="Diagnostic command" /> : null}
      {activity.detail ? <DebugText text={activity.detail} /> : null}
      {activity.error ? <DebugText text={activity.error} tone="error" /> : null}
      <LazyDetails summary="Debug details" summaryClassName="cursor-pointer text-xs text-muted-foreground">
        {() => (
          <div className="mt-2 grid min-w-0 gap-2 text-xs [&_figure]:my-0 [&_figure]:shadow-none [&_.highlighted-code]:text-xs">
            {activity.rawEvents.map((event) => (
              <div className="min-w-0 rounded border border-border p-2" key={`${event.sessionId}-${event.sequence}`}>
                <span className="text-muted-foreground">
                  #{event.sequence} · {event.type}
                </span>
                <JsonPayload value={event.payload} label="Diagnostic debug details" />
              </div>
            ))}
          </div>
        )}
      </LazyDetails>
    </article>
  );
}

function buildDiagnosticActivities(events: AgentEvent[]): DiagnosticActivity[] {
  const activities: DiagnosticActivity[] = [];
  const startsByKey = new Map<string, AgentEvent>();
  const consumedStarts = new Set<AgentEvent>();

  for (const event of events) {
    if (event.type === 'tool_started') {
      startsByKey.set(toolActivityKey(event) ?? `event-${event.sequence}`, event);
      continue;
    }

    if (event.type === 'tool_finished') {
      const start = startsByKey.get(toolActivityKey(event) ?? '');
      if (start) consumedStarts.add(start);
      activities.push(formatToolActivity(start, event));
      continue;
    }

    activities.push(formatStandaloneActivity(event));
  }

  for (const event of events) {
    if (event.type !== 'tool_started' || consumedStarts.has(event)) continue;
    activities.push(formatToolActivity(event, null));
  }

  return activities.sort((a, b) => firstActivitySequence(a) - firstActivitySequence(b));
}

function formatToolActivity(start: AgentEvent | undefined, finish: AgentEvent | null): DiagnosticActivity {
  const payload = { ...(start?.payload ?? {}), ...(finish?.payload ?? {}) };
  const toolName = stringValue(payload.toolName) ?? 'tool';
  const isError = finish ? payload.isError === true : false;
  const command = toolCommand(start, finish);
  const taskPrompt = toolName === 'task' ? stringValue(payload.prompt) : undefined;
  const resultPreview = previewToolResult(toolName, payload.result);
  const errorPreview = previewValue(payload.error) ?? (isError ? resultPreview : undefined);
  const customTool = customToolName(payload.result);

  const activity: DiagnosticActivity = {
    key: `tool-${start?.sequence ?? 'missing'}-${finish?.sequence ?? 'running'}`,
    title: toolActivityTitle(toolName, command, taskPrompt, isError, Boolean(finish), Boolean(customTool)),
    subtitle: toolActivitySubtitle(start, finish),
    status: finish ? (isError ? 'failed' : 'completed') : 'started',
    createdAt: (start ?? finish)!.createdAt,
    rawEvents: [start, finish].filter((item): item is AgentEvent => Boolean(item)),
  };
  if (command) activity.command = command;
  if (!errorPreview && resultPreview) activity.detail = resultPreview;
  if (errorPreview) activity.error = errorPreview;
  return activity;
}

function formatStandaloneActivity(event: AgentEvent): DiagnosticActivity {
  const isFailure = event.type === 'run_failed' || event.type === 'message_failed' || event.payload.isError === true;
  const provider = stringValue(event.payload.provider);
  const error = previewValue(event.payload.error);
  const activity: DiagnosticActivity = {
    key: `event-${event.sequence}`,
    title: standaloneActivityTitle(event, provider, isFailure),
    subtitle: `#${event.sequence}`,
    status: isFailure ? 'failed' : 'info',
    createdAt: event.createdAt,
    rawEvents: [event],
  };
  const detail = standaloneActivityDetail(event);
  if (!error && detail) activity.detail = detail;
  if (error) activity.error = error;
  return activity;
}

function toolActivityKey(event: AgentEvent): string | null {
  const payload = event.payload;
  const key = stringValue(payload.toolCallId) ?? stringValue(payload.taskId) ?? stringValue(payload.operationId);
  if (key) return key;
  const args = payload.args;
  if (args && typeof args === 'object') return stringValue((args as Record<string, unknown>).operationId) ?? null;
  return null;
}

function toolActivitySubtitle(start: AgentEvent | undefined, finish: AgentEvent | null): string {
  if (start && finish) return `#${start.sequence} to #${finish.sequence}`;
  return `#${start?.sequence ?? finish?.sequence}`;
}

function toolCommand(start: AgentEvent | undefined, finish: AgentEvent | null): string | undefined {
  const startArgs = start?.payload.args;
  if (startArgs && typeof startArgs === 'object') {
    const command = stringValue((startArgs as Record<string, unknown>).command);
    if (command) return command;
  }

  const result = finish?.payload.result;
  if (result && typeof result === 'object') return stringValue((result as Record<string, unknown>).command);
  return undefined;
}

function toolActivityTitle(
  toolName: string,
  command: string | undefined,
  taskPrompt: string | undefined,
  isError: boolean,
  finished: boolean,
  customTool: boolean,
): string {
  const status = finished ? (isError ? 'failed' : 'completed') : 'started';
  if (command) return `Command ${status}: ${singleLine(command, 80)}`;
  if (taskPrompt) return `Task ${status}: ${singleLine(taskPrompt, 80)}`;
  return `${humanizeEventName(toolName)}${customTool ? ' custom tool' : ''} ${status}`;
}

function standaloneActivityTitle(event: AgentEvent, provider: string | undefined, isFailure: boolean): string {
  if (event.type === 'message_started') return 'Message run started';
  if (event.type === 'skills_loaded') return 'Skills loaded';
  if (event.type === 'skill_invoked') {
    const name = stringValue(event.payload.name) ?? 'skill';
    return event.payload.trigger === 'model' ? `Model invoked ${name}` : `User invoked ${name}`;
  }
  if (event.type === 'sandbox_starting') return `Starting ${provider ?? 'sandbox'} sandbox`;
  if (event.type === 'sandbox_ready') return `${provider ?? 'Sandbox'} sandbox ready`;
  if (event.type === 'run_completed') return 'Run completed';
  if (event.type === 'run_failed') return 'Run failed';
  if (event.type === 'message_failed') return 'Message failed';
  if (event.type === 'message_completed') return 'Message completed';
  if (event.type === 'setup_script_finished') {
    const subject = event.payload.phase === 'probe' ? 'Setup script probe' : 'Setup script';
    return `${subject} ${isFailure ? 'failed' : 'completed'}`;
  }
  return `${humanizeEventName(event.type)}${isFailure ? ' failed' : ''}`;
}

function standaloneActivityDetail(event: AgentEvent): string | undefined {
  if (event.type === 'message_started') {
    const batchSize = typeof event.payload.batchSize === 'number' ? event.payload.batchSize : undefined;
    return batchSize && batchSize > 1 ? `${batchSize} queued messages are running together.` : undefined;
  }
  if (event.type === 'skills_loaded') return skillsLoadedDetail(event.payload);
  if (event.type === 'skill_invoked') return skillInvokedDetail(event.payload);
  if (event.type === 'setup_script_finished') return setupScriptFinishedDetail(event.payload);
  if (event.type === 'run_completed') return runCompletedDetail(event.payload);
  if (event.type === 'sandbox_ready' && event.payload.created === true) return 'Sandbox was created for this run.';
  return previewValue(event.payload.message) ?? previewValue(event.payload.result);
}

function skillInvokedDetail(payload: Record<string, unknown>): string | undefined {
  const source = stringValue(payload.ownerGroupName) ?? stringValue(payload.repo) ?? stringValue(payload.source);
  const filePath = stringValue(payload.filePath);
  const parts = [source ? `Source: ${source}` : '', filePath ? `Definition: ${filePath}` : ''].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

function skillsLoadedDetail(payload: Record<string, unknown>): string {
  const skills = skillNames(payload.skills);
  const shadowed = skillNames(payload.shadowed);
  const diagnostics = Array.isArray(payload.diagnostics)
    ? payload.diagnostics.filter((item): item is string => typeof item === 'string')
    : [];
  const parts = [skills.length ? `Loaded: ${skills.join(', ')}` : 'No skills loaded.'];
  if (shadowed.length) parts.push(`Shadowed: ${shadowed.join(', ')}`);
  parts.push(...diagnostics);
  return parts.join('\n');
}

function skillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== 'string') return [];
    const ownerGroupName = stringValue(record.ownerGroupName);
    const repo = stringValue(record.repo);
    const source = stringValue(record.source);
    const provenance = ownerGroupName ?? repo ?? source;
    return [`${name}${provenance ? ` (${provenance})` : ''}`];
  });
}

function setupScriptFinishedDetail(payload: Record<string, unknown>): string | undefined {
  const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : undefined;
  const stdoutTail = stringValue(payload.stdoutTail);
  const stderrTail = stringValue(payload.stderrTail);
  const output = [stdoutTail, stderrTail].filter(Boolean).join('\n').trim();
  const parts: string[] = [];
  if (durationMs !== undefined) parts.push(`Duration: ${formatDuration(durationMs)}`);
  if (output) parts.push(output);
  return parts.length ? parts.join('\n') : undefined;
}

function runCompletedDetail(payload: Record<string, unknown>): string | undefined {
  const model = stringValue(payload.model);
  const usage = payload.usage;
  const totalTokens = usage && typeof usage === 'object' ? (usage as Record<string, unknown>).totalTokens : undefined;
  const cost = usage && typeof usage === 'object' ? (usage as Record<string, unknown>).cost : undefined;
  const totalCost = cost && typeof cost === 'object' ? (cost as Record<string, unknown>).total : undefined;
  const parts: string[] = [];
  if (model) parts.push(`Model: ${model}`);
  if (typeof totalTokens === 'number') parts.push(`Tokens: ${totalTokens.toLocaleString()}`);
  if (typeof totalCost === 'number' && totalCost > 0) parts.push(`Estimated cost: $${totalCost.toFixed(4)}`);
  return parts.length ? parts.join(' · ') : undefined;
}

function diagnosticStatusLabel(status: DiagnosticActivity['status']): string {
  if (status === 'started') return 'started';
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  return 'info';
}

function diagnosticStatusClass(status: DiagnosticActivity['status']): string {
  if (status === 'started') return 'text-info';
  if (status === 'completed') return 'text-success';
  if (status === 'failed') return 'text-destructive';
  return 'text-muted-foreground';
}

function firstActivitySequence(activity: DiagnosticActivity): number {
  return Math.min(...activity.rawEvents.map((event) => event.sequence));
}

function analyzeDiagnosticFailure(events: AgentEvent[]): DiagnosticFailureAnalysis | null {
  const providerFailure = sandboxProviderFailure(events);
  if (!providerFailure) return null;

  return {
    title: 'Likely sandbox provider issue',
    detail: `The run was still starting a ${providerFailure.provider} sandbox when the provider returned ${providerFailure.errorSummary}. This points to an upstream sandbox/API availability issue rather than a task or repository failure.`,
  };
}

type SandboxProviderFailure = {
  provider: string;
  errorSummary: string;
};

function sandboxProviderFailure(events: AgentEvent[]): SandboxProviderFailure | null {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.type !== 'sandbox_starting') continue;
    const provider = typeof event.payload.provider === 'string' ? event.payload.provider : 'sandbox provider';
    const failedEvent = events.slice(index + 1).find((candidate) => isGatewayFailureEvent(candidate));
    if (failedEvent) return { provider, errorSummary: summarizeProviderError(failedEvent.payload.error) };
  }

  return null;
}

function isGatewayFailureEvent(event: AgentEvent): boolean {
  if (event.type !== 'run_failed' && event.type !== 'message_failed') return false;
  const error = typeof event.payload.error === 'string' ? event.payload.error : '';
  return (
    /\b(?:50[0-4]|52[0-4])\b/.test(error) ||
    /\b(?:Bad Gateway|Service Unavailable|Gateway Timeout|upstream)\b/i.test(error)
  );
}

function summarizeProviderError(error: unknown): string {
  if (typeof error !== 'string' || !error.trim()) return 'an upstream error';
  const statusMatch = error.match(/\b(50[0-4]|52[0-4])\b(?:\s+([A-Za-z][A-Za-z ]{2,40}))?/);
  if (statusMatch?.[1]) return `${statusMatch[1]}${statusMatch[2] ? ` ${statusMatch[2].trim()}` : ''}`;
  const gatewayMatch = error.match(/\b(Bad Gateway|Service Unavailable|Gateway Timeout|upstream[^<\n.]*)\b/i);
  if (gatewayMatch?.[1]) return gatewayMatch[1];
  return 'an upstream error';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function previewValue(value: unknown): string | undefined {
  if (typeof value === 'string') return singleLine(value.trim(), 600);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return undefined;
  const contentText = previewTextContent(value as Record<string, unknown>);
  if (contentText) return contentText;
  try {
    return singleLine(JSON.stringify(value, null, 2), 600);
  } catch {
    return undefined;
  }
}

function previewToolResult(toolName: string, value: unknown): string | undefined {
  if (toolName !== 'read') return previewValue(value);
  if (typeof value === 'string') return truncateText(value.trim(), 4000);
  return previewValue(value);
}

function previewTextContent(value: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value.content)) return undefined;
  const text = value.content
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      return stringValue((item as Record<string, unknown>).text);
    })
    .filter((item): item is string => Boolean(item))
    .join('\n')
    .trim();
  if (!text) return undefined;
  return truncateText(text, 1200);
}

function customToolName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const details = (value as Record<string, unknown>).details;
  if (!details || typeof details !== 'object') return undefined;
  return stringValue((details as Record<string, unknown>).customTool);
}

function singleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function humanizeEventName(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${Math.round(durationMs / 1000)}s`;
}

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}
