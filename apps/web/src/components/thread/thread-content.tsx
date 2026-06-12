import { useEffect, useState } from 'react';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode, ToggleEvent } from 'react';
import { ChevronDown, Download, ExternalLink, Play, RotateCcw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  AgentEvent,
  Artifact,
  ArtifactPreview,
  CallbackDelivery,
  ExternalResource,
  Message,
  SandboxService,
} from '../../api.js';
import { getApiBaseUrl } from '../../api.js';
import {
  artifactName,
  isBrowserPlayableVideoArtifact,
  isImageArtifact,
  isInlineDisplayableArtifact,
  isTextPreviewableArtifact,
  stringPayloadValue,
} from '../../artifact-display.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Textarea } from '../ui/textarea.js';
import { cn } from '../../lib/utils.js';
import {
  buildAssistantText,
  formatAssistantDisplayText,
  groupDiagnosticsByRun,
  groupMessagesByRun,
  isActiveRunGroup,
  isCancellingRunGroup,
  type MessageGroup,
} from './content/chat-helpers.js';
import { JsonPayload } from './content/debug-code.js';
import { Diagnostics } from './content/diagnostics-panel.js';
import { HighlightedCode } from './content/highlighted-code.js';

const mobileContextOpenStorageKey = 'deputies-mobile-context-open';
const staticDemoServiceUnavailableReason = 'Service previews are unavailable in the static demo.';
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
  day: 'numeric',
});

export function ChatPanel(props: {
  activeProgress: Record<string, string>;
  artifacts: Artifact[];
  canWriteSession: boolean;
  services: SandboxService[];
  serviceLinksDisabled?: boolean;
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
  onExtendSandbox: (port?: number) => void;
  onLoadArtifactPreview: (artifact: Artifact) => Promise<ArtifactPreview>;
}) {
  const assistantText = { ...buildAssistantText(props.events), ...props.activeProgress };
  const diagnostics = groupDiagnosticsByRun(props.events);
  const groups = groupMessagesByRun(props.messages, props.events);

  return (
    <section className="grid gap-3">
      {groups.map((group) => {
        const response = assistantText[group.responseMessageId];
        const inlineArtifacts = artifactsForGroup(props.artifacts, group);
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
                  {activeRun && props.canWriteSession ? (
                    <CancelRunButton cancelling={cancellingRun} onCancelRun={props.onCancelRun} />
                  ) : null}
                </div>
              </div>
            ) : null}
            {group.messages.map((message) => (
              <UserMessageCard
                canRetryMessages={props.canRetryMessages}
                canWriteSession={props.canWriteSession}
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
                {activeRun ? (
                  <StreamingProgressText text={formatAssistantDisplayText(response)} />
                ) : (
                  <MarkdownText text={formatAssistantDisplayText(response)} />
                )}
              </Card>
            ) : null}
            {inlineArtifacts.length ? (
              <InlineArtifacts artifacts={inlineArtifacts} onLoadArtifactPreview={props.onLoadArtifactPreview} />
            ) : null}
            {props.services.length > 0 && group.key === groups.at(-1)?.key ? (
              <InlineServices
                services={props.services}
                serviceLinksDisabled={props.serviceLinksDisabled ?? false}
                canWriteSession={props.canWriteSession}
                onExtendSandbox={props.onExtendSandbox}
              />
            ) : null}
            <Diagnostics events={groupDiagnostics} />
          </div>
        );
      })}
      {!props.messages.length ? <p className="text-sm text-muted-foreground">No messages yet.</p> : null}
    </section>
  );
}

function InlineServices(props: {
  services: SandboxService[];
  serviceLinksDisabled?: boolean;
  canWriteSession: boolean;
  onExtendSandbox: (port?: number) => void;
}) {
  return (
    <div className="grid gap-2" aria-label="Inline services">
      {props.services.map((service) => (
        <ServiceCard
          compact
          key={service.port}
          service={service}
          serviceLinksDisabled={props.serviceLinksDisabled ?? false}
          canWriteSession={props.canWriteSession}
          onExtendSandbox={props.onExtendSandbox}
        />
      ))}
    </div>
  );
}

function InlineArtifacts(props: {
  artifacts: Artifact[];
  onLoadArtifactPreview: (artifact: Artifact) => Promise<ArtifactPreview>;
}) {
  return (
    <div className="grid gap-2" aria-label="Inline artifacts">
      {props.artifacts.map((artifact) => (
        <ArtifactPreviewCard
          artifact={artifact}
          compact
          key={artifact.id}
          onLoadArtifactPreview={props.onLoadArtifactPreview}
        />
      ))}
    </div>
  );
}

function UserMessageCard(props: {
  canWriteSession: boolean;
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
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 text-xs font-medium text-muted-foreground">
          {messageLabel(message)}
          {message.authorName ? ` from ${message.authorName}` : ''}{' '}
          <Badge className={statusTextClass(message.status)}>{messageStatusLabel(message)}</Badge>
        </h3>
        {props.canWriteSession && message.status === 'pending' && props.editingMessageId !== message.id ? (
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
        {props.canWriteSession && props.showRunCancel ? (
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

const STREAMING_PROGRESS_MAX_CHARS = 20_000;

function StreamingProgressText(props: { text: string }) {
  const text = truncateStreamingProgressText(props.text);
  return (
    <div
      className="min-w-0 rounded-md border border-border/70 bg-muted/20 p-3"
      role="region"
      aria-label="Deputy progress"
    >
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{text}</p>
    </div>
  );
}

function truncateStreamingProgressText(text: string): string {
  if (text.length <= STREAMING_PROGRESS_MAX_CHARS) return text;
  const omitted = text.length - STREAMING_PROGRESS_MAX_CHARS;
  return `Showing latest deputy progress; ${omitted.toLocaleString()} earlier characters hidden while the run is active.\n\n…${text.slice(-STREAMING_PROGRESS_MAX_CHARS)}`;
}

function markdownNodeText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number' || typeof children === 'bigint') return children.toString();
  if (Array.isArray(children)) return children.map(markdownNodeText).join('');
  return '';
}

function MarkdownText(props: { text: string }) {
  const highlightCode = true;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ className, ...props }) => <MarkdownLink className={className} {...props} />,
        blockquote: ({ className, ...props }) => (
          <blockquote className={cn('border-l-2 border-border pl-3 text-muted-foreground', className)} {...props} />
        ),
        code: ({ children, className, ...props }) => {
          const code = markdownNodeText(children).replace(/\n$/, '');
          const language = className?.match(/language-(\S+)/)?.[1];
          if (language || code.includes('\n'))
            return <HighlightedCode code={code} highlight={highlightCode} {...(language ? { language } : {})} />;
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

function MarkdownLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { className, href, onClick, ...rest } = props;
  const [downloading, setDownloading] = useState(false);
  const artifactDownload = href ? artifactDownloadUrlFromHref(href) : null;

  async function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || !artifactDownload) return;
    event.preventDefault();
    if (downloading) return;
    setDownloading(true);
    try {
      const { url, fileName } = await loadArtifactBlob({ downloadUrl: artifactDownload });
      triggerBrowserDownload(url, fileName);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <a
      className={cn('text-primary underline decoration-primary/60 underline-offset-2 hover:text-primary/80', className)}
      href={href}
      target={artifactDownload ? undefined : '_blank'}
      rel="noreferrer"
      onClick={(event) => {
        void handleClick(event);
      }}
      {...rest}
    >
      {downloading ? 'Downloading...' : props.children}
    </a>
  );
}

function CancelRunButton(props: { cancelling: boolean; onCancelRun: () => void }) {
  return (
    <Button
      className="h-7 shrink-0 whitespace-nowrap px-2"
      type="button"
      variant="secondary"
      size="sm"
      onClick={props.onCancelRun}
      disabled={props.cancelling}
      aria-label={props.cancelling ? 'Cancelling...' : 'Cancel task'}
    >
      <X className="h-3.5 w-3.5 shrink-0" /> {props.cancelling ? 'Cancelling' : 'Cancel'}
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

function humanizeEventName(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function MobileContextPanel(props: {
  accessPanel?: ReactNode;
  canWriteSession: boolean;
  repository: string | null;
  branch: string | null;
  artifacts: Artifact[];
  services: SandboxService[];
  serviceLinksDisabled?: boolean;
  externalResources: ExternalResource[];
  callbacks: CallbackDelivery[];
  onExtendSandbox: (port?: number) => void;
  onReplayCallback: (callbackId: string) => void;
}) {
  const [open, setOpen] = useState(() => sessionStorage.getItem(mobileContextOpenStorageKey) === 'true');

  function handleToggle(event: ToggleEvent<HTMLDetailsElement>) {
    const nextOpen = event.currentTarget.open;
    sessionStorage.setItem(mobileContextOpenStorageKey, String(nextOpen));
    setOpen(nextOpen);
  }

  return (
    <details
      className="mb-5 rounded-md border border-border bg-card/90 shadow-sm xl:hidden"
      open={open}
      onToggle={handleToggle}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-foreground">Context</summary>
      <ContextPanelContent {...props} />
    </details>
  );
}

export function DesktopContextPanel(props: {
  accessPanel?: ReactNode;
  canWriteSession: boolean;
  repository: string | null;
  branch: string | null;
  artifacts: Artifact[];
  services: SandboxService[];
  serviceLinksDisabled?: boolean;
  externalResources: ExternalResource[];
  callbacks: CallbackDelivery[];
  onExtendSandbox: (port?: number) => void;
  onReplayCallback: (callbackId: string) => void;
}) {
  return (
    <aside
      aria-label="Desktop context"
      className="hidden min-h-0 overflow-auto border-l border-border bg-card/50 p-4 xl:block"
    >
      <h2 className="text-sm font-semibold">Context</h2>
      <ContextPanelContent {...props} />
    </aside>
  );
}

function ContextPanelContent(props: {
  accessPanel?: ReactNode;
  canWriteSession: boolean;
  repository: string | null;
  branch: string | null;
  artifacts: Artifact[];
  services: SandboxService[];
  serviceLinksDisabled?: boolean;
  externalResources: ExternalResource[];
  callbacks: CallbackDelivery[];
  onExtendSandbox: (port?: number) => void;
  onReplayCallback: (callbackId: string) => void;
}) {
  return (
    <div className="p-4 pt-0 xl:p-0 xl:pt-0">
      {props.accessPanel ? <div className="mt-3 border-b border-border pb-3">{props.accessPanel}</div> : null}
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
            {props.branch ? (
              <span className="mt-1 block text-xs text-muted-foreground">Branch: {props.branch}</span>
            ) : null}
            <span className="mt-1 block text-xs">
              {props.canWriteSession
                ? 'Follow-ups inherit this repo. Enter another repo in the composer to switch.'
                : 'Write-access follow-ups inherit this repo.'}
            </span>
          </>
        ) : (
          <span className="mt-1 block">No repository selected.</span>
        )}
      </div>
      <div className="mt-3 border-b border-border pb-3 text-sm text-muted-foreground">
        <strong className="block font-medium text-foreground">Live services</strong>
        <span>
          {props.serviceLinksDisabled
            ? staticDemoServiceUnavailableReason
            : props.canWriteSession
              ? 'Authenticated links to HTTP services running inside the sandbox.'
              : 'Service metadata is visible, but write access is required to extend.'}
        </span>
      </div>
      <div className="mt-3 grid gap-2">
        {props.services.map((service) => (
          <ServiceCard
            key={service.port}
            service={service}
            serviceLinksDisabled={props.serviceLinksDisabled ?? false}
            canWriteSession={props.canWriteSession}
            onExtendSandbox={props.onExtendSandbox}
          />
        ))}
        {!props.services.length ? <p className="text-sm text-muted-foreground">No live services available.</p> : null}
      </div>
      <div className="mt-6 border-b border-border pb-3 text-sm text-muted-foreground">
        <strong className="block font-medium text-foreground">External resources</strong>
        <span>Durable resources created outside the sandbox, such as pull requests.</span>
      </div>
      <div className="mt-3 grid gap-2">
        {props.externalResources.map((resource) => (
          <ExternalResourceCard key={resource.id} resource={resource} />
        ))}
        {!props.externalResources.length ? (
          <p className="text-sm text-muted-foreground">No external resources yet.</p>
        ) : null}
      </div>
      <div className="mt-6 border-b border-border pb-3 text-sm text-muted-foreground">
        <strong className="block font-medium text-foreground">Artifacts</strong>
        <span>Downloadable or previewable files created by the deputy appear here.</span>
      </div>
      <div className="mt-3 grid gap-2">
        {props.artifacts.map((artifact) => (
          <ArtifactPreviewCard artifact={artifact} key={artifact.id} />
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
              {props.canWriteSession && callback.status === 'failed' ? (
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

const inlineImageMaxBytes = 1_000_000;

type ArtifactPreviewCardProps = {
  artifact: Artifact;
  compact?: boolean;
  onLoadArtifactPreview?: (artifact: Artifact) => Promise<ArtifactPreview>;
};

function ServiceCard(props: {
  service: SandboxService;
  canWriteSession: boolean;
  compact?: boolean;
  serviceLinksDisabled?: boolean;
  onExtendSandbox: (port?: number) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!props.service.shutdownAt) return;
    const schedule = () => {
      const deadline = new Date(props.service.shutdownAt!).getTime();
      const remainingMs = deadline - Date.now();
      const delayMs = remainingMs > 60_000 ? 30_000 : 1_000;
      return window.setTimeout(() => {
        setNow(Date.now());
        timer = schedule();
      }, delayMs);
    };
    let timer = schedule();
    return () => window.clearTimeout(timer);
  }, [props.service.shutdownAt]);
  const shutdownLabel = props.service.shutdownAt ? formatRelativeDeadline(props.service.shutdownAt, now) : null;
  const extensionLabel = serviceExtensionLabel(props.service, now);
  const extensionAtMax = extensionLabel === serviceExtensionMaxLabel;
  const servicePathLabel = visibleServicePath(props.service.path);
  return (
    <Card className={cn('min-w-0 p-3', props.compact ? 'bg-card/80' : 'bg-card/70')}>
      <div className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <strong className="min-w-0 text-sm leading-5 text-foreground">
            {props.service.label ?? 'Sandbox service'}
          </strong>
          {props.serviceLinksDisabled ? (
            <Button
              className="shrink-0"
              size="sm"
              variant="secondary"
              disabled
              title={staticDemoServiceUnavailableReason}
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open
            </Button>
          ) : (
            <Button asChild className="shrink-0" size="sm" variant="secondary">
              <a href={props.service.url} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" /> Open
              </a>
            </Button>
          )}
        </div>
        <div className="min-w-0 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge>:{props.service.port}</Badge>
            {props.service.status ? <Badge className="text-muted-foreground">{props.service.status}</Badge> : null}
            {servicePathLabel ? <span className="min-w-0 truncate">{servicePathLabel}</span> : null}
          </div>
          {shutdownLabel ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Shuts down {shutdownLabel}.{' '}
              {!props.canWriteSession ? (
                <span className="text-muted-foreground">Write access is required to extend.</span>
              ) : extensionAtMax ? (
                <span className="text-muted-foreground">{extensionLabel}</span>
              ) : (
                <button
                  className="font-medium text-primary hover:underline"
                  type="button"
                  onClick={() => props.onExtendSandbox(props.service.port)}
                >
                  {extensionLabel}
                </button>
              )}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function visibleServicePath(path: string | undefined): string {
  if (!path || path.startsWith('/?folder=')) return '';
  return path;
}

function formatRelativeDeadline(value: string, now: number): string {
  const deadline = new Date(value).getTime();
  if (!Number.isFinite(deadline)) return 'soon';
  const remainingSeconds = Math.max(0, Math.floor((deadline - now) / 1000));
  if (remainingSeconds <= 0) return 'now';
  if (remainingSeconds < 60) return `in ${remainingSeconds}s`;
  const remainingMinutes = Math.floor(remainingSeconds / 60);
  if (remainingMinutes < 60) return `in ${remainingMinutes}m`;
  const remainingHours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return minutes ? `in ${remainingHours}h ${minutes}m` : `in ${remainingHours}h`;
}

const serviceExtensionMaxLabel = '(2hr max)';
const serviceExtensionCapBufferMs = 30_000;

function serviceExtensionLabel(service: SandboxService, now: number): string {
  const maxKeepaliveUntil = service.maxKeepaliveUntil ? new Date(service.maxKeepaliveUntil).getTime() : undefined;
  if (!maxKeepaliveUntil || !Number.isFinite(maxKeepaliveUntil)) return 'Extend by 10m';
  const currentUntil = service.keepaliveUntil ? new Date(service.keepaliveUntil).getTime() : now;
  const baseUntil = Number.isFinite(currentUntil) && currentUntil > now ? currentUntil : now;
  if (baseUntil >= maxKeepaliveUntil - serviceExtensionCapBufferMs) return serviceExtensionMaxLabel;
  return 'Extend by 10m';
}

function ExternalResourceCard(props: { resource: ExternalResource }) {
  const { resource } = props;
  const resourceUrl = safeExternalHref(resource.url);
  const owner = stringPayloadValue(resource.metadata.owner);
  const repo = stringPayloadValue(resource.metadata.repo);
  const number = numberPayloadValue(resource.metadata.number);
  const repository = owner && repo ? `${owner}/${repo}` : undefined;
  const label = resourceLabel(resource);
  const description = externalResourceDescription(resource, repository, number);
  return (
    <Card className="min-w-0 p-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <strong className="truncate text-sm text-foreground">{label}</strong>
            <Badge>{externalResourceTypeLabel(resource.type)}</Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{description}</p>
          <p className="mt-1 text-xs text-muted-foreground">Created: {formatDate(resource.createdAt)}</p>
        </div>
        {resourceUrl ? (
          <Button asChild size="sm" variant="secondary">
            <a href={resourceUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" /> Open
            </a>
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function ArtifactPreviewCard(props: ArtifactPreviewCardProps) {
  const { artifact } = props;
  const name = artifactName(artifact);
  const downloadUrl = artifactDownloadUrl(artifact);
  const externalUrl = safeExternalHref(artifact.url);
  const image = isImageArtifact(artifact);
  const video = isBrowserPlayableVideoArtifact(artifact);
  const sizeBytes = artifactSizeBytes(artifact);
  const largeImage = image && (!sizeBytes || sizeBytes > inlineImageMaxBytes);
  const textPreviewable = isTextPreviewableArtifact(artifact);
  if (!props.compact) {
    return (
      <details className="group rounded-md border border-border bg-card/70 text-xs text-muted-foreground">
        <summary
          aria-label={`${artifact.type} artifact ${name}`}
          className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden"
        >
          <ChevronDown
            className="h-3.5 w-3.5 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0"
            aria-hidden="true"
          />
          <span className="min-w-0 truncate text-muted-foreground">
            {artifact.type} · {name}
          </span>
          {downloadUrl ? (
            <ArtifactDownloadLink artifact={artifact} downloadUrl={downloadUrl} label="Download" />
          ) : externalUrl ? (
            <a className="text-primary hover:text-primary/80" href={externalUrl} target="_blank" rel="noreferrer">
              Open
            </a>
          ) : null}
        </summary>
        <div className="border-t border-border px-3 py-2">
          <dl className="mb-2 grid gap-1">
            <div>Created: {formatDate(artifact.createdAt)}</div>
            <div className="truncate">ID: {artifact.id}</div>
          </dl>
          <div className="mt-2 min-w-0 text-xs [&_figure]:my-2 [&_figure]:shadow-none [&_.highlighted-code]:text-xs">
            <JsonPayload value={artifact.payload} />
          </div>
        </div>
      </details>
    );
  }

  return (
    <Card className="min-w-0 overflow-hidden border-primary/30 bg-primary/5 p-3">
      <span className="text-xs text-muted-foreground">
        {artifact.type} · {formatDate(artifact.createdAt)}
      </span>
      <strong className="mt-1 block break-words text-sm font-medium">
        {externalUrl ? (
          <a className="text-primary hover:text-primary/80" href={externalUrl} target="_blank" rel="noreferrer">
            {name}
          </a>
        ) : (
          name
        )}
      </strong>
      {image && downloadUrl && !largeImage ? (
        <a className="mt-3 block" href={downloadUrl} target="_blank" rel="noreferrer" aria-label="Open image artifact">
          <img
            className="max-h-80 w-full rounded-md border border-border object-contain shadow-sm"
            src={downloadUrl}
            alt={name}
            loading="lazy"
          />
        </a>
      ) : null}
      {largeImage ? (
        <p className="mt-2 text-sm text-muted-foreground">Large image preview skipped. Open the image to view it.</p>
      ) : null}
      {video && downloadUrl ? <VideoArtifactPreview artifact={artifact} downloadUrl={downloadUrl} /> : null}
      {textPreviewable && props.onLoadArtifactPreview ? (
        <TextArtifactPreview artifact={artifact} onLoadArtifactPreview={props.onLoadArtifactPreview} />
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {downloadUrl ? (
          <ArtifactDownloadLink
            artifact={artifact}
            downloadUrl={downloadUrl}
            label={image ? 'Download image' : 'Download artifact'}
          />
        ) : null}
        {externalUrl ? (
          <a
            className="text-sm font-medium text-primary hover:text-primary/80"
            href={externalUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open external link
          </a>
        ) : null}
      </div>
    </Card>
  );
}

type TextArtifactPreviewProps = {
  artifact: Artifact;
  onLoadArtifactPreview: (artifact: Artifact) => Promise<ArtifactPreview>;
};

function TextArtifactPreview(props: TextArtifactPreviewProps) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const name = artifactName(props.artifact);

  async function handleToggle(event: ToggleEvent<HTMLDetailsElement>) {
    if (!event.currentTarget.open || preview || loading) return;
    setLoading(true);
    setError('');
    try {
      setPreview(await props.onLoadArtifactPreview(props.artifact));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load preview');
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="mt-3 min-w-0"
      onToggle={(event) => {
        void handleToggle(event);
      }}
    >
      <summary className="cursor-pointer text-sm font-medium text-primary">Preview {name}</summary>
      <div className="mt-2 min-w-0 rounded-md border border-border bg-muted/30 p-2 text-xs">
        {loading ? <p className="text-muted-foreground">Loading preview...</p> : null}
        {error ? <p className="text-destructive">{error}</p> : null}
        {preview ? (
          <>
            <pre className="whitespace-pre-wrap break-words font-mono text-foreground">{preview.text}</pre>
            {preview.truncated ? <p className="mt-2 text-muted-foreground">Preview truncated.</p> : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

function ArtifactDownloadLink(props: { artifact: Artifact; downloadUrl: string; label: string }) {
  const [downloading, setDownloading] = useState(false);

  async function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (downloading) return;
    setDownloading(true);
    try {
      const { url, fileName } = await loadArtifactBlob({ artifact: props.artifact, downloadUrl: props.downloadUrl });
      triggerBrowserDownload(url, fileName);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <a
      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80"
      href={props.downloadUrl}
      onClick={(event) => {
        void handleClick(event);
      }}
    >
      <Download className="h-3.5 w-3.5" /> {downloading ? 'Downloading...' : props.label}
    </a>
  );
}

function VideoArtifactPreview(props: { artifact: Artifact; downloadUrl: string }) {
  const [showPlayer, setShowPlayer] = useState(false);
  const [error, setError] = useState('');
  const name = artifactName(props.artifact);

  if (showPlayer) {
    return (
      <div className="mt-3 grid gap-2">
        <video
          className="max-h-[28rem] w-full rounded-md border border-border bg-black shadow-sm"
          src={artifactMediaUrl(props.downloadUrl)}
          controls
          playsInline
          autoPlay
          onError={() => setError('This video cannot be played by this browser. Download it and try a local player.')}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="mt-3 grid min-h-48 place-items-center rounded-md border border-dashed border-border bg-muted/30 p-4 text-center">
      <div className="grid gap-2 justify-items-center">
        <div className="rounded-full border border-border bg-background p-3 text-primary shadow-sm">
          <Play className="h-5 w-5 fill-current" aria-hidden="true" />
        </div>
        <p className="text-sm font-medium text-foreground">{name}</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Video streams from artifact storage after you press play.
        </p>
        <Button size="sm" variant="secondary" onClick={() => setShowPlayer(true)}>
          <Play className="h-3.5 w-3.5" /> Play video
        </Button>
      </div>
    </div>
  );
}

function callbackEventLabel(eventType: string): string {
  if (eventType === 'message_completed') return 'Completion reply';
  return eventType.replace(/_/g, ' ');
}

function artifactsForGroup(artifacts: Artifact[], group: MessageGroup): Artifact[] {
  const messageIds = new Set(group.messages.map((message) => message.id));
  return artifacts.filter((artifact) => {
    if (!isInlineDisplayableArtifact(artifact)) return false;
    if (group.runId && artifact.runId === group.runId) return true;
    return Boolean(artifact.messageId && messageIds.has(artifact.messageId));
  });
}

function artifactDownloadUrl(artifact: Artifact): string | undefined {
  if (artifact.url && isStaticDemoArtifact(artifact)) return artifact.url;
  if (!artifact.storageKey) return undefined;
  return `${getApiBaseUrl()}/sessions/${artifact.sessionId}/artifacts/${artifact.id}/download`;
}

function isStaticDemoArtifact(artifact: Artifact): boolean {
  const staticDemo = artifact.payload.staticDemo;
  return Boolean(staticDemo && typeof staticDemo === 'object' && !Array.isArray(staticDemo));
}

function artifactDownloadUrlFromHref(href: string): string | null {
  const url = new URL(href, window.location.origin);
  if (!url.pathname.match(/^\/sessions\/[^/]+\/artifacts\/[^/]+\/download$/)) return null;
  return `${getApiBaseUrl()}${url.pathname}`;
}

function artifactMediaUrl(downloadUrl: string): string {
  const url = new URL(downloadUrl, window.location.origin);
  url.searchParams.set('disposition', 'inline');
  return url.toString();
}

function safeExternalHref(value: string | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('/') && !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin === window.location.origin && value.startsWith('/')) return value;
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function artifactSizeBytes(artifact: Artifact): number | undefined {
  return typeof artifact.payload.sizeBytes === 'number' ? artifact.payload.sizeBytes : undefined;
}

async function loadArtifactBlob(input: {
  artifact?: Artifact;
  downloadUrl: string;
}): Promise<{ url: string; fileName: string }> {
  const { artifact, downloadUrl } = input;
  const response = await fetch(downloadUrl, { credentials: 'include' });
  if (!response.ok) throw new Error(`Download failed with ${response.status}`);
  const blob = await response.blob();
  return {
    url: URL.createObjectURL(blob),
    fileName:
      fileNameFromContentDisposition(response.headers.get('content-disposition')) ??
      (artifact ? artifactFileName(artifact) : 'artifact'),
  };
}

function triggerBrowserDownload(url: string, fileName: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noreferrer';
  document.body.append(link);
  link.click();
  link.remove();
}

function artifactFileName(artifact: Artifact): string {
  return (
    stringPayloadValue(artifact.payload.fileName) ??
    `${artifactName(artifact).replace(/[^A-Za-z0-9._-]/g, '_') || artifact.id}`
  );
}

function fileNameFromContentDisposition(value: string | null): string | undefined {
  const encoded = value?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  const quoted = value?.match(/filename="([^"]+)"/i)?.[1];
  return quoted || undefined;
}

function numberPayloadValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function resourceLabel(resource: ExternalResource): string {
  const title = resource.title?.trim();
  if (title) return title;
  const number = numberPayloadValue(resource.metadata.number);
  if (resource.type === 'pull_request' && number) return `Pull request #${number}`;
  return resource.url;
}

function externalResourceTypeLabel(value: string): string {
  if (value === 'pull_request') return 'PR';
  return humanizeEventName(value);
}

function externalResourceDescription(
  resource: ExternalResource,
  repository: string | undefined,
  number: number | undefined,
): string {
  if (!repository) return resource.url;
  if (!number) return repository;
  return `${repository} #${number}`;
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
  return dateFormatter.format(new Date(value));
}
