import { RotateCcw, X } from 'lucide-react';
import type { Message } from '../../../api.js';
import { cn } from '../../../lib/utils.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Textarea } from '../../ui/textarea.js';
import { MessageSkillChips, parsePersistedMessageSkillInvocations } from './message-skill-chips.js';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
  day: 'numeric',
});

export function UserMessageCard(props: {
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
  onToggleSteering: (message: Message) => void;
  steeringPending: boolean;
  openableManagedSkillIds?: ReadonlySet<string>;
  onOpenSkill?: (skillId: string, revisionId: string) => void;
  onRetryFailedMessages: (messageIds: string[]) => void;
  onSaveEdit: () => void;
}) {
  const { message } = props;
  return (
    <Card className="border-primary/50 bg-primary/10 p-3" role="article" aria-label={`Message ${message.sequence}`}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 overflow-hidden text-xs font-medium text-muted-foreground">
          <span className="min-w-0 truncate">
            {messageLabel(message)}
            {message.authorName ? ` from ${message.authorName}` : ''}
          </span>
          <InlineTimestamp value={message.createdAt} />
          <Badge className={cn('shrink-0', statusTextClass(message.status))}>{messageStatusLabel(message)}</Badge>
          {message.status === 'pending' && message.steering ? <Badge className="shrink-0">Steering</Badge> : null}
        </h3>
        {props.canWriteSession && message.status === 'pending' && props.editingMessageId !== message.id ? (
          <div className="flex gap-1">
            <Button
              className="h-7 px-2"
              variant={message.steering ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={message.steering}
              title={
                message.steering
                  ? 'Cancel steering and leave this message in the ordinary queue.'
                  : 'Send this message into the active turn ahead of ordinary queued messages.'
              }
              disabled={props.steeringPending}
              onClick={() => props.onToggleSteering(message)}
            >
              {message.steering ? 'Cancel steering' : 'Steer'}
            </Button>
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
            <Button
              size="sm"
              onClick={props.onSaveEdit}
              disabled={!props.messageDraft.trim() && !parsePersistedMessageSkillInvocations(message).length}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-2">
          <MessageSkillChips
            message={message}
            {...(props.openableManagedSkillIds ? { openableManagedSkillIds: props.openableManagedSkillIds } : {})}
            {...(props.onOpenSkill ? { onOpenSkill: props.onOpenSkill } : {})}
          />
          {message.prompt ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{message.prompt}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No additional instructions.</p>
          )}
        </div>
      )}
    </Card>
  );
}

export function CancelRunButton(props: { cancelling: boolean; onCancelRun: () => void }) {
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

export function RetryMessagesButton(props: { count?: number; disabled?: boolean; onRetry: () => void }) {
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

function messageLabel(message: Message): string {
  if (message.source === 'deputy') return `Deputy message ${message.sequence}`;
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

function InlineTimestamp(props: { value: string | undefined }) {
  if (!props.value) return null;
  return (
    <time className="shrink-0 text-[11px] font-normal text-muted-foreground/80" dateTime={props.value}>
      {dateFormatter.format(new Date(props.value))}
    </time>
  );
}

function statusTextClass(status: string): string {
  if (['completed', 'ready', 'ok'].includes(status)) return 'text-success';
  if (['active', 'processing', 'running', 'starting', 'cancelling'].includes(status)) return 'text-info';
  if (['pending', 'queued', 'created', 'stopped'].includes(status)) return 'text-warning';
  if (['failed', 'cancelled', 'unhealthy', 'destroyed', 'missing'].includes(status)) return 'text-destructive';
  if (status === 'idle' || status === 'archived') return 'text-muted-foreground';
  return 'text-foreground';
}
