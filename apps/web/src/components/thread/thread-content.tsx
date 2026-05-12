import { useEffect, useRef, useState } from 'react';
import { Check, Copy, RotateCcw, X, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AgentEvent, Artifact, CallbackDelivery, Message } from '../../api.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Textarea } from '../ui/textarea.js';
import { cn } from '../../lib/utils.js';

export function ChatPanel(props: {
  canRetryMessages: boolean;
  editingMessageId: string;
  events: AgentEvent[];
  messageDraft: string;
  messages: Message[];
  onCancelEdit: () => void;
  onCancelQueuedMessage: (messageId: string) => void;
  onCancelRun: () => void;
  onEditMessage: (message: Message) => void;
  onMessageDraftChange: (value: string) => void;
  onRetryFailedMessages: (messageIds: string[]) => void;
  onSaveEdit: () => void;
}) {
  const assistantText = buildAssistantText(props.events);
  const diagnostics = groupDiagnosticsByRun(props.events);
  const groups = groupMessagesByRun(props.messages, props.events);

  return (
    <section className="grid gap-3">
      {groups.map((group) => {
        const response = assistantText[group.responseMessageId];
        const groupDiagnostics = diagnostics[group.runId ?? group.responseMessageId] ?? [];
        const activeRun = isActiveRunGroup(group.messages);
        const cancellingRun = isCancellingRunGroup(group.messages);
        const failedMessages = group.messages.filter((message) => message.status === 'failed');
        return (
          <div className="grid min-w-0 gap-2" key={group.key}>
            {group.messages.length > 1 ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  Queued batch · {group.messages.filter((message) => message.status !== 'cancelled').length} active
                  messages
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  {failedMessages.length > 0 && !activeRun ? (
                    <RetryMessagesButton
                      count={failedMessages.length}
                      disabled={!props.canRetryMessages}
                      onRetry={() => props.onRetryFailedMessages(failedMessages.map((message) => message.id))}
                    />
                  ) : null}
                  {activeRun ? <CancelRunButton cancelling={cancellingRun} onCancelRun={props.onCancelRun} /> : null}
                </div>
              </div>
            ) : null}
            {group.messages.map((message) => (
              <UserMessageCard
                canRetryMessages={props.canRetryMessages}
                editingMessageId={props.editingMessageId}
                key={message.id}
                message={message}
                messageDraft={props.messageDraft}
                showMessageRetry={group.messages.length === 1 && message.status === 'failed'}
                showRunCancel={group.messages.length === 1 && activeRun}
                runCancelling={cancellingRun}
                onCancelEdit={props.onCancelEdit}
                onCancelQueuedMessage={props.onCancelQueuedMessage}
                onCancelRun={props.onCancelRun}
                onEditMessage={props.onEditMessage}
                onMessageDraftChange={props.onMessageDraftChange}
                onRetryFailedMessages={props.onRetryFailedMessages}
                onSaveEdit={props.onSaveEdit}
              />
            ))}
            {response ? (
              <Card className="min-w-0 overflow-hidden p-3">
                <h3 className="mb-1 text-xs font-medium text-muted-foreground">
                  {activeRun ? 'Deputy progress' : 'Deputy response'}
                </h3>
                <MarkdownText text={formatAssistantDisplayText(response)} />
              </Card>
            ) : null}
            <Diagnostics events={groupDiagnostics} />
          </div>
        );
      })}
      {!props.messages.length ? <p className="text-sm text-muted-foreground">No messages yet.</p> : null}
    </section>
  );
}

function UserMessageCard(props: {
  canRetryMessages: boolean;
  editingMessageId: string;
  message: Message;
  messageDraft: string;
  showMessageRetry: boolean;
  showRunCancel: boolean;
  runCancelling: boolean;
  onCancelEdit: () => void;
  onCancelQueuedMessage: (messageId: string) => void;
  onCancelRun: () => void;
  onEditMessage: (message: Message) => void;
  onMessageDraftChange: (value: string) => void;
  onRetryFailedMessages: (messageIds: string[]) => void;
  onSaveEdit: () => void;
}) {
  const { message } = props;
  return (
    <Card className="border-primary/50 bg-primary/10 p-3" role="article" aria-label={`Message ${message.sequence}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {messageLabel(message)}{' '}
          <Badge className={statusTextClass(message.status)}>{messageStatusLabel(message)}</Badge>
        </h3>
        {message.status === 'pending' && props.editingMessageId !== message.id ? (
          <div className="flex gap-1">
            <Button className="h-7 px-2" variant="ghost" size="sm" onClick={() => props.onEditMessage(message)}>
              Edit
            </Button>
            <Button
              className="h-7 px-2"
              variant="ghost"
              size="sm"
              onClick={() => props.onCancelQueuedMessage(message.id)}
            >
              Cancel
            </Button>
          </div>
        ) : null}
        {props.showMessageRetry ? (
          <RetryMessagesButton
            disabled={!props.canRetryMessages}
            onRetry={() => props.onRetryFailedMessages([message.id])}
          />
        ) : null}
        {props.showRunCancel ? (
          <CancelRunButton cancelling={props.runCancelling} onCancelRun={props.onCancelRun} />
        ) : null}
      </div>
      {props.editingMessageId === message.id ? (
        <div className="grid gap-2">
          <Textarea
            className="min-h-24"
            value={props.messageDraft}
            onChange={(event) => props.onMessageDraftChange(event.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={props.onCancelEdit}>
              Cancel
            </Button>
            <Button size="sm" onClick={props.onSaveEdit} disabled={!props.messageDraft.trim()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <PlainText text={message.prompt} />
      )}
    </Card>
  );
}

function messageLabel(message: Message): string {
  if (message.source === 'github_notice') return `GitHub notice ${message.sequence}`;
  if (message.source === 'slack_notice') return `Slack notice ${message.sequence}`;
  if (message.context?.transcriptOnly && message.source === 'github') return `GitHub comment ${message.sequence}`;
  if (message.context?.transcriptOnly && message.source === 'slack') return `Slack message ${message.sequence}`;
  return `Message ${message.sequence}`;
}

function messageStatusLabel(message: Message): string {
  if (message.context?.transcriptOnly && message.status === 'cancelled') return 'not queued';
  return message.status === 'pending' ? 'queued' : message.status;
}

function PlainText(props: { text: string }) {
  return <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{props.text}</p>;
}

function MarkdownText(props: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ className, ...props }) => (
          <a
            className={cn(
              'text-primary underline decoration-primary/60 underline-offset-2 hover:text-primary/80',
              className,
            )}
            target="_blank"
            rel="noreferrer"
            {...props}
          />
        ),
        blockquote: ({ className, ...props }) => (
          <blockquote className={cn('border-l-2 border-border pl-3 text-muted-foreground', className)} {...props} />
        ),
        code: ({ children, className, ...props }) => {
          const code = String(children).replace(/\n$/, '');
          const language = className?.match(/language-(\S+)/)?.[1];
          if (language || String(children).includes('\n'))
            return <HighlightedCode code={code} {...(language ? { language } : {})} />;
          return (
            <code
              className={cn(
                'rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground shadow-sm break-words',
                className,
              )}
              {...props}
            >
              {children}
            </code>
          );
        },
        h1: ({ className, ...props }) => (
          <h1 className={cn('mt-4 text-xl font-semibold text-foreground first:mt-0', className)} {...props} />
        ),
        h2: ({ className, ...props }) => (
          <h2 className={cn('mt-4 text-lg font-semibold text-foreground first:mt-0', className)} {...props} />
        ),
        h3: ({ className, ...props }) => (
          <h3 className={cn('mt-3 text-base font-semibold text-foreground first:mt-0', className)} {...props} />
        ),
        hr: ({ className, ...props }) => <hr className={cn('border-border', className)} {...props} />,
        li: ({ className, ...props }) => <li className={cn('pl-1', className)} {...props} />,
        ol: ({ className, ...props }) => <ol className={cn('list-decimal space-y-1 pl-5', className)} {...props} />,
        p: ({ className, ...props }) => (
          <p className={cn('whitespace-pre-wrap text-sm leading-6 text-foreground', className)} {...props} />
        ),
        pre: ({ children }) => <>{children}</>,
        table: ({ className, ...props }) => (
          <div
            className="my-3 max-w-full overflow-x-auto overscroll-x-contain touch-pan-x"
            data-markdown-table-wrapper="true"
          >
            <table className={cn('min-w-full w-max border-collapse text-sm', className)} {...props} />
          </div>
        ),
        tbody: ({ className, ...props }) => <tbody className={cn('divide-y divide-border', className)} {...props} />,
        td: ({ className, ...props }) => (
          <td className={cn('border border-border px-2 py-1 align-top text-foreground', className)} {...props} />
        ),
        th: ({ className, ...props }) => (
          <th
            className={cn('border border-border px-2 py-1 text-left font-medium text-foreground', className)}
            {...props}
          />
        ),
        thead: ({ className, ...props }) => <thead className={cn('bg-muted/80', className)} {...props} />,
        ul: ({ className, ...props }) => <ul className={cn('list-disc space-y-1 pl-5', className)} {...props} />,
      }}
    >
      {props.text}
    </ReactMarkdown>
  );
}

type ResolvedColorTheme = 'light' | 'dark';

function getResolvedColorTheme(): ResolvedColorTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function useResolvedColorTheme(): ResolvedColorTheme {
  const [theme, setTheme] = useState<ResolvedColorTheme>(getResolvedColorTheme);

  useEffect(() => {
    const updateTheme = () => setTheme(getResolvedColorTheme());
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    updateTheme();

    return () => observer.disconnect();
  }, []);

  return theme;
}

function codeHighlightTheme(theme: ResolvedColorTheme): 'github-light-default' | 'github-dark-default' {
  return theme === 'dark' ? 'github-dark-default' : 'github-light-default';
}

function HighlightedCode(props: { code: string; language?: string; wrap?: boolean; chrome?: boolean }) {
  const [html, setHtml] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedResetTimer = useRef<number | null>(null);
  const colorTheme = useResolvedColorTheme();

  useEffect(() => {
    return () => {
      if (copiedResetTimer.current !== null) window.clearTimeout(copiedResetTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    import('shiki')
      .then(({ codeToHtml }) =>
        codeToHtml(props.code, { lang: props.language ?? 'text', theme: codeHighlightTheme(colorTheme) }),
      )
      .then((nextHtml) => {
        if (!cancelled) setHtml(nextHtml);
      })
      .catch(() => {
        if (!cancelled) setHtml('');
      });
    return () => {
      cancelled = true;
    };
  }, [props.code, props.language, colorTheme]);

  async function copyCode() {
    await navigator.clipboard.writeText(props.code);
    setCopied(true);
    if (copiedResetTimer.current !== null) window.clearTimeout(copiedResetTimer.current);
    copiedResetTimer.current = window.setTimeout(() => {
      copiedResetTimer.current = null;
      setCopied(false);
    }, 1400);
  }

  return (
    <figure className="my-3 w-full max-w-full min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-[0_12px_32px_rgb(0_0_0_/_0.18)]">
      {props.chrome !== false ? (
        <figcaption className="flex items-center justify-between border-b border-border bg-muted/80 px-3 py-1.5 text-[0.7rem] font-medium uppercase tracking-widest text-muted-foreground">
          <span>{props.language ?? 'text'}</span>
          <button
            className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[0.65rem] text-muted-foreground transition hover:text-foreground"
            type="button"
            onClick={copyCode}
            aria-label="Copy code"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </figcaption>
      ) : null}
      {html ? (
        <div
          className={cn(
            'highlighted-code text-sm leading-6',
            props.wrap ? 'highlighted-code-wrap overflow-hidden' : 'overflow-x-auto overflow-y-hidden',
          )}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          className={cn(
            'p-3 text-sm leading-6 text-foreground',
            props.wrap ? 'overflow-hidden whitespace-pre-wrap break-words' : 'overflow-x-auto overflow-y-hidden',
          )}
        >
          <code>{props.code}</code>
        </pre>
      )}
    </figure>
  );
}

function JsonPayload(props: { value: unknown }) {
  return <HighlightedCode code={JSON.stringify(props.value, null, 2)} language="json" wrap chrome={false} />;
}

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

function CancelRunButton(props: { cancelling: boolean; onCancelRun: () => void }) {
  return (
    <Button
      className="h-7 px-2"
      type="button"
      variant="secondary"
      size="sm"
      onClick={props.onCancelRun}
      disabled={props.cancelling}
    >
      <X className="h-3.5 w-3.5" /> {props.cancelling ? 'Cancelling...' : 'Cancel task'}
    </Button>
  );
}

function RetryMessagesButton(props: { count?: number; disabled?: boolean; onRetry: () => void }) {
  return (
    <Button
      className="h-7 px-2"
      type="button"
      variant="secondary"
      size="sm"
      onClick={props.onRetry}
      disabled={props.disabled}
    >
      <RotateCcw className="h-3.5 w-3.5" /> {props.count && props.count > 1 ? `Retry ${props.count} failed` : 'Retry'}
    </Button>
  );
}

function Diagnostics(props: { events: AgentEvent[] }) {
  const [open, setOpen] = useState(false);
  const failureAnalysis = analyzeDiagnosticFailure(props.events);
  const activities = buildDiagnosticActivities(props.events);
  if (!props.events.length) return null;

  return (
    <details
      className="min-w-0 rounded-md border border-border bg-muted/30 p-2"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm text-muted-foreground">
        Activity · {props.events.length} events
      </summary>
      <div className="mt-2 grid min-w-0 gap-2">
        {failureAnalysis ? <FailureAnalysisNotice analysis={failureAnalysis} /> : null}
        {activities.map((activity) => (
          <DiagnosticActivityCard activity={activity} key={activity.key} />
        ))}
        <Button
          className="justify-self-start px-2"
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setOpen(false)}
        >
          Collapse activity
        </Button>
      </div>
    </details>
  );
}

const DIAGNOSTIC_SCROLL_TEXT_LENGTH = 480;
const DIAGNOSTIC_SCROLL_LINE_COUNT = 8;

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
      {activity.command ? <HighlightedCode code={activity.command} language="bash" wrap chrome={false} /> : null}
      {activity.detail ? <DiagnosticText text={activity.detail} /> : null}
      {activity.error ? <DiagnosticText text={activity.error} tone="error" /> : null}
      <details className="mt-2 min-w-0">
        <summary className="cursor-pointer text-xs text-muted-foreground">Debug details</summary>
        <div className="mt-2 grid max-h-64 min-w-0 gap-2 overflow-auto text-xs [&_figure]:my-0 [&_figure]:shadow-none [&_.highlighted-code]:text-xs">
          {activity.rawEvents.map((event) => (
            <div className="min-w-0 rounded border border-border p-2" key={`${event.sessionId}-${event.sequence}`}>
              <span className="text-muted-foreground">
                #{event.sequence} · {event.type}
              </span>
              <JsonPayload value={event.payload} />
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

function DiagnosticText(props: { text: string; tone?: 'error' }) {
  const isLong = isLongDiagnosticText(props.text);
  const textClassName = cn(
    'whitespace-pre-wrap break-words text-sm leading-6',
    props.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
  );

  if (!isLong) {
    return (
      <p
        className={cn(
          'mt-2',
          props.tone === 'error' ? 'rounded-md border border-destructive/40 bg-destructive/10 p-2' : '',
          textClassName,
        )}
      >
        {props.text}
      </p>
    );
  }

  return (
    <div
      className={cn(
        'mt-2 max-h-56 min-w-0 overflow-auto rounded-md border p-2 overscroll-contain',
        props.tone === 'error' ? 'border-destructive/40 bg-destructive/10' : 'border-border bg-muted/30',
      )}
      aria-label={props.tone === 'error' ? 'Scrollable diagnostic error' : 'Scrollable diagnostic output'}
      role="region"
    >
      <p className={textClassName}>{props.text}</p>
    </div>
  );
}

function isLongDiagnosticText(value: string): boolean {
  return value.length > DIAGNOSTIC_SCROLL_TEXT_LENGTH || value.split('\n').length > DIAGNOSTIC_SCROLL_LINE_COUNT;
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
  if (event.type === 'sandbox_starting') return `Starting ${provider ?? 'sandbox'} sandbox`;
  if (event.type === 'sandbox_ready') return `${provider ?? 'Sandbox'} sandbox ready`;
  if (event.type === 'run_completed') return 'Run completed';
  if (event.type === 'run_failed') return 'Run failed';
  if (event.type === 'message_failed') return 'Message failed';
  if (event.type === 'message_completed') return 'Message completed';
  return `${humanizeEventName(event.type)}${isFailure ? ' failed' : ''}`;
}

function standaloneActivityDetail(event: AgentEvent): string | undefined {
  if (event.type === 'message_started') {
    const batchSize = typeof event.payload.batchSize === 'number' ? event.payload.batchSize : undefined;
    return batchSize && batchSize > 1 ? `${batchSize} queued messages are running together.` : undefined;
  }
  if (event.type === 'sandbox_ready' && event.payload.created === true) return 'Sandbox was created for this run.';
  return previewValue(event.payload.message) ?? previewValue(event.payload.result);
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

export function MobileContextPanel(props: {
  repository: string | null;
  artifacts: Artifact[];
  callbacks: CallbackDelivery[];
  onReplayCallback: (callbackId: string) => void;
}) {
  return (
    <details className="mb-5 rounded-md border border-border bg-card/90 shadow-sm xl:hidden">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-foreground">Context</summary>
      <ContextPanelContent {...props} />
    </details>
  );
}

export function DesktopContextPanel(props: {
  repository: string | null;
  artifacts: Artifact[];
  callbacks: CallbackDelivery[];
  onReplayCallback: (callbackId: string) => void;
}) {
  return (
    <aside
      aria-label="Desktop context"
      className="hidden min-h-0 overflow-auto border-l border-border bg-card/50 p-4 xl:block"
      data-thread-scroll-exclude="true"
    >
      <h2 className="text-sm font-semibold">Context</h2>
      <ContextPanelContent {...props} />
    </aside>
  );
}

function ContextPanelContent(props: {
  repository: string | null;
  artifacts: Artifact[];
  callbacks: CallbackDelivery[];
  onReplayCallback: (callbackId: string) => void;
}) {
  return (
    <div className="p-4 pt-0 xl:p-0 xl:pt-0">
      <div className="mt-3 border-b border-border pb-3 text-sm text-muted-foreground">
        <strong className="block font-medium text-foreground">Repository</strong>
        {props.repository ? (
          <>
            <a
              className="mt-1 block break-all text-primary"
              href={`https://github.com/${props.repository}`}
              target="_blank"
              rel="noreferrer"
            >
              {props.repository}
            </a>
            <span className="mt-1 block text-xs">
              Follow-ups inherit this repo. Enter another repo in the composer to switch.
            </span>
          </>
        ) : (
          <span className="mt-1 block">No repository selected.</span>
        )}
      </div>
      <div className="mt-3 border-b border-border pb-3 text-sm text-muted-foreground">
        <strong className="block font-medium text-foreground">Artifacts</strong>
        <span>Outputs and links created by the deputy appear here.</span>
      </div>
      <div className="mt-3 grid gap-2">
        {props.artifacts.map((artifact) => (
          <Card className="p-3" key={artifact.id}>
            <span className="text-xs text-muted-foreground">
              {artifact.type} · {formatDate(artifact.createdAt)}
            </span>
            <strong className="mt-1 block text-sm font-medium">{artifact.title || artifact.url || artifact.id}</strong>
            {artifact.url ? (
              <a className="mt-1 block text-sm text-primary" href={artifact.url} target="_blank" rel="noreferrer">
                Open artifact
              </a>
            ) : null}
            <div className="max-h-44 min-w-0 overflow-auto text-xs [&_figure]:my-2 [&_figure]:shadow-none [&_.highlighted-code]:text-xs">
              <JsonPayload value={artifact.payload} />
            </div>
          </Card>
        ))}
        {!props.artifacts.length ? <p className="text-sm text-muted-foreground">No artifacts yet.</p> : null}
      </div>
      <div className="mt-6 border-b border-border pb-3 text-sm text-muted-foreground">
        <strong className="block font-medium text-foreground">Callbacks</strong>
        <span>Delivery status for Slack and webhook completion replies.</span>
      </div>
      <div className="mt-3 grid gap-2">
        {props.callbacks.map((callback) => (
          <details
            className="group rounded-md border border-border bg-card/70 text-xs text-muted-foreground"
            key={callback.id}
          >
            <summary
              aria-label={`${callback.targetType} callback ${callback.status}`}
              className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden"
            >
              <ChevronDown
                className="h-3.5 w-3.5 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0"
                aria-hidden="true"
              />
              <span className="min-w-0 truncate text-muted-foreground">
                {callback.targetType} · {formatDate(callback.updatedAt)}
              </span>
              <Badge className={statusTextClass(callback.status)}>{callback.status}</Badge>
            </summary>
            <div className="border-t border-border px-3 py-2">
              <dl className="grid gap-1">
                <div>Type: {callbackEventLabel(callback.eventType)}</div>
                <div>
                  Attempts: {callback.attempts}/{callback.maxAttempts}
                </div>
                {callback.nextAttemptAt ? <div>Next retry: {formatDate(callback.nextAttemptAt)}</div> : null}
                {callback.lastAttemptAt ? <div>Last attempt: {formatDate(callback.lastAttemptAt)}</div> : null}
                {callback.deliveredAt ? <div>Delivered: {formatDate(callback.deliveredAt)}</div> : null}
                {callback.lastError ? <div className="text-destructive">Last error: {callback.lastError}</div> : null}
                <div className="truncate">ID: {callback.id}</div>
              </dl>
              {callback.status === 'failed' ? (
                <Button
                  className="mt-2 h-7 px-2"
                  size="sm"
                  variant="secondary"
                  onClick={() => props.onReplayCallback(callback.id)}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Replay callback
                </Button>
              ) : null}
            </div>
          </details>
        ))}
        {!props.callbacks.length ? <p className="text-sm text-muted-foreground">No callbacks yet.</p> : null}
      </div>
    </div>
  );
}

function callbackEventLabel(eventType: string): string {
  if (eventType === 'message_completed') return 'Completion reply';
  return eventType.replace(/_/g, ' ');
}

function buildAssistantText(events: AgentEvent[]): Record<string, string> {
  const messageIdsBySequence: Record<number, string> = {};
  const outputByMessageId: Record<string, string> = {};
  let currentSequence = 0;
  let currentMessageId = '';

  for (const event of events) {
    const maybeSequence = event.payload.sequence;
    if (typeof maybeSequence === 'number') {
      currentSequence = maybeSequence;
      if (event.messageId) messageIdsBySequence[maybeSequence] = event.messageId;
    }
    if (event.messageId) currentMessageId = event.messageId;
    const messageId = event.messageId || currentMessageId || messageIdsBySequence[currentSequence];
    if (!messageId) continue;
    const text = event.payload.text;
    if (typeof text !== 'string') continue;
    if (event.type === 'agent_response_final') {
      outputByMessageId[messageId] = text;
    } else if (event.type === 'agent_text_delta') {
      outputByMessageId[messageId] = `${outputByMessageId[messageId] ?? ''}${text}`;
    }
  }

  return outputByMessageId;
}

function formatAssistantDisplayText(text: string): string {
  return text.replace(/([.!?])(?=[A-Z])/g, '$1 ').replace(/:(?=[A-Z][a-z])/g, ': ');
}

type MessageGroup = {
  key: string;
  messages: Message[];
  responseMessageId: string;
  runId?: string;
};

function groupMessagesByRun(messages: Message[], events: AgentEvent[]): MessageGroup[] {
  const batchBySequence = new Map<number, { runId: string; sequences: number[] }>();
  for (const event of events) {
    if (event.type !== 'message_started' || !event.runId) continue;
    const sequences = Array.isArray(event.payload.sequences)
      ? event.payload.sequences.filter((value): value is number => typeof value === 'number')
      : [];
    if (sequences.length <= 1) continue;
    for (const sequence of sequences) batchBySequence.set(sequence, { runId: event.runId, sequences });
  }

  const groups: MessageGroup[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (seen.has(message.id)) continue;
    const batch = batchBySequence.get(message.sequence);
    if (!batch) {
      groups.push({ key: message.id, messages: [message], responseMessageId: message.id });
      seen.add(message.id);
      continue;
    }

    const minSequence = Math.min(...batch.sequences);
    const maxSequence = Math.max(...batch.sequences);
    const batchSequenceSet = new Set(batch.sequences);
    const batchMessages = messages.filter((candidate) => {
      if (batchSequenceSet.has(candidate.sequence)) return true;
      return candidate.status === 'cancelled' && candidate.sequence > minSequence && candidate.sequence < maxSequence;
    });
    for (const item of batchMessages) seen.add(item.id);
    groups.push({
      key: batch.runId,
      messages: batchMessages,
      responseMessageId: batchMessages[0]?.id ?? message.id,
      runId: batch.runId,
    });
  }

  return groups;
}

function isActiveRunGroup(messages: Message[]): boolean {
  return messages.some((message) => message.status === 'processing' || message.status === 'cancelling');
}

function isCancellingRunGroup(messages: Message[]): boolean {
  return messages.some((message) => message.status === 'cancelling');
}

function groupDiagnosticsByRun(events: AgentEvent[]): Record<string, AgentEvent[]> {
  const grouped: Record<string, AgentEvent[]> = {};
  for (const event of events) {
    if (event.type === 'message_created' || event.type === 'agent_text_delta' || event.type === 'agent_response_final')
      continue;
    for (const key of diagnosticGroupKeys(event)) {
      grouped[key] = [...(grouped[key] ?? []), event];
    }
  }
  return grouped;
}

function diagnosticGroupKeys(event: AgentEvent): string[] {
  const keys = [event.runId, event.messageId].filter((key): key is string => Boolean(key));
  return Array.from(new Set(keys));
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

function statusTextClass(status: string): string {
  if (['completed', 'ready', 'ok'].includes(status)) return 'text-success';
  if (['active', 'processing', 'running', 'starting', 'cancelling'].includes(status)) return 'text-info';
  if (['pending', 'queued', 'created', 'stopped'].includes(status)) return 'text-warning';
  if (['failed', 'cancelled', 'unhealthy', 'destroyed', 'missing'].includes(status)) return 'text-destructive';
  if (status === 'idle' || status === 'archived') return 'text-muted-foreground';
  return 'text-foreground';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}
