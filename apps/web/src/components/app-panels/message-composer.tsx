import { useRef, useState } from 'react';
import type { FocusEvent, FormEvent, TouchEvent } from 'react';
import type { BranchOption, ModelChoice, RepositoryOption } from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Textarea } from '../ui/textarea.js';
import { BranchPicker, OptionPicker, RepositoryPicker } from './option-picker.js';
import { blurFocusedTextControl, formatModelLabel, submitOnEnter } from './shared.js';

export function MessageComposer(props: {
  archived: boolean;
  readOnly: boolean;
  compactInput?: boolean;
  hasSelectedRepository: boolean;
  repository: string;
  inheritedRepository: string;
  repositoryOptions: RepositoryOption[];
  repositoryOptionsLoading: boolean;
  repositoryOptionsError: string;
  branch: string;
  inheritedBranch: string;
  branchOptions: BranchOption[];
  branchOptionsLoading: boolean;
  branchOptionsError: string;
  model: string;
  inheritedModel: string;
  modelChoices: ModelChoice[];
  modelUnavailableReason: string;
  onRepositoryChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
  onSubmit: (input: { prompt: string }) => Promise<boolean>;
}) {
  const [prompt, setPrompt] = useState('');
  const [promptResetKey, setPromptResetKey] = useState(0);
  const submitTouchRef = useRef<{ moved: boolean; x: number; y: number } | null>(null);

  const canSubmit = !props.archived && !props.readOnly && Boolean(prompt.trim()) && !props.modelUnavailableReason;

  async function submitPrompt() {
    if (!canSubmit) return;
    const submittedPrompt = prompt;
    blurFocusedTextControl();
    setPromptResetKey((key) => key + 1);
    setPrompt('');
    const sent = await props.onSubmit({ prompt: submittedPrompt });
    if (!sent) setPrompt(submittedPrompt);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submitPrompt();
  }

  function handleSubmitTouchStart(event: TouchEvent<HTMLButtonElement>) {
    const touch = event.changedTouches[0];
    if (!touch) return;
    submitTouchRef.current = { moved: false, x: touch.clientX, y: touch.clientY };
  }

  function handleSubmitTouchMove(event: TouchEvent<HTMLButtonElement>) {
    const touch = event.changedTouches[0];
    const start = submitTouchRef.current;
    if (!touch || !start) return;
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) start.moved = true;
  }

  function handleSubmitTouchEnd(event: TouchEvent<HTMLButtonElement>) {
    const start = submitTouchRef.current;
    submitTouchRef.current = null;
    if (!canSubmit || start?.moved) return;
    event.preventDefault();
    void submitPrompt();
  }

  function handleSubmitTouchCancel() {
    submitTouchRef.current = null;
  }

  function handleBlur(event: FocusEvent<HTMLFormElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) props.onFocusChange(false);
  }

  return (
    <form
      className="shrink-0 bg-background/95 py-3"
      data-thread-composer="true"
      onFocus={() => props.onFocusChange(true)}
      onBlur={handleBlur}
      onSubmit={handleSubmit}
    >
      <Card className="bg-card/90">
        <Textarea
          key={promptResetKey}
          className={cn(props.compactInput ? 'min-h-12' : 'min-h-28', 'border-0 bg-transparent focus:ring-0')}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => submitOnEnter(event)}
          placeholder={
            props.archived
              ? 'Restore this archived session before sending new work.'
              : props.readOnly
                ? 'You have read-only access to this session. You can inspect messages, artifacts, and service metadata, but only group members and admins can send follow-ups.'
                : 'Ask your deputy to investigate, change code, or follow up...'
          }
          disabled={props.archived || props.readOnly}
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <RepositoryPicker
            className="min-w-0 flex-[2_1_16rem]"
            triggerClassName="h-8 text-xs"
            direction="up"
            value={props.repository}
            repositories={props.repositoryOptions}
            loading={props.repositoryOptionsLoading}
            error={props.repositoryOptionsError}
            onChange={props.onRepositoryChange}
            placeholder={props.inheritedRepository || 'GitHub repo, e.g. owner/repo'}
            disabled={props.archived || props.readOnly}
          />
          <BranchPicker
            className="min-w-0 flex-[1_2_8rem]"
            triggerClassName="h-8 text-xs"
            direction="up"
            value={props.branch}
            branches={props.branchOptions}
            loading={props.branchOptionsLoading}
            error={props.branchOptionsError}
            onChange={props.onBranchChange}
            disabled={props.archived || props.readOnly || (!props.repository && !props.hasSelectedRepository)}
            placeholder={props.inheritedBranch || 'Branch'}
          />
          <OptionPicker
            className="min-w-0 flex-[1_2_9rem]"
            triggerClassName="h-8 text-xs"
            direction="up"
            label="Model"
            value={props.model}
            options={props.modelChoices}
            emptyLabel={props.inheritedModel ? formatModelLabel(props.inheritedModel) : 'Default model'}
            onChange={props.onModelChange}
            disabled={props.archived || props.readOnly || props.modelChoices.length <= 1}
          />
          {props.modelUnavailableReason ? (
            <p className="basis-full rounded-md border border-warning/50 bg-warning/10 px-2 py-1.5 text-warning-foreground dark:text-warning">
              {props.modelUnavailableReason}
            </p>
          ) : null}
          <Button
            className="ml-auto shrink-0 whitespace-nowrap"
            type="submit"
            disabled={!canSubmit}
            onTouchStart={handleSubmitTouchStart}
            onTouchMove={handleSubmitTouchMove}
            onTouchEnd={handleSubmitTouchEnd}
            onTouchCancel={handleSubmitTouchCancel}
          >
            Send message
          </Button>
        </div>
      </Card>
    </form>
  );
}
