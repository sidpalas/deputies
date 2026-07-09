import { useEffect, useRef, useState } from 'react';
import type { FocusEvent, FormEvent, TouchEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import type { BranchOption, Environment, ModelChoice, RepositoryOption } from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Textarea } from '../ui/textarea.js';
import {
  EnvironmentBranchOverridesEditor,
  type EnvironmentBranchOverrides,
  type EnvironmentBranchOverrideRepository,
  type EnvironmentBranchOverrideTarget,
} from './environment-branch-overrides.js';
import {
  BranchPicker,
  CodebasePicker,
  codebaseEnvironmentValue,
  codebaseRepositoryValue,
  OptionPicker,
} from './option-picker.js';
import { blurFocusedTextControl, formatModelLabel, submitOnEnter } from './shared.js';

export function MessageComposer(props: {
  archived: boolean;
  readOnly: boolean;
  compactInput?: boolean;
  environmentId: string;
  environmentBranchOverrides: EnvironmentBranchOverrides;
  environmentOptions: Environment[];
  environmentOptionsLoading: boolean;
  environmentOptionsError: string;
  repository: string;
  inheritedEnvironment: EnvironmentBranchOverrideTarget | null;
  inheritedCodebaseLabel: string;
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
  onCodebaseChange: (value: string) => void;
  onEnvironmentBranchOverridesChange: (value: EnvironmentBranchOverrides) => void;
  onEnvironmentRepositoryBranchesLoad: (repository: EnvironmentBranchOverrideRepository) => Promise<BranchOption[]>;
  onBranchChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
  onSubmit: (input: { prompt: string }) => Promise<boolean>;
}) {
  const [prompt, setPrompt] = useState('');
  const [promptResetKey, setPromptResetKey] = useState(0);
  const [branchControlsOpen, setBranchControlsOpen] = useState(false);
  const submitTouchRef = useRef<{ moved: boolean; x: number; y: number } | null>(null);
  const explicitEnvironment =
    props.environmentOptions.find((environment) => environment.id === props.environmentId) ?? null;
  const codebaseValue = props.environmentId
    ? codebaseEnvironmentValue(props.environmentId)
    : props.repository
      ? codebaseRepositoryValue(props.repository)
      : '';
  const inheritedEnvironmentActive = !props.environmentId && !props.repository && Boolean(props.inheritedEnvironment);
  const selectedEnvironment = explicitEnvironment ?? (inheritedEnvironmentActive ? props.inheritedEnvironment : null);
  const branchRepository = selectedEnvironment ? '' : props.repository || props.inheritedRepository;
  const branchControlKey = selectedEnvironment
    ? `environment:${selectedEnvironment.id}`
    : branchRepository
      ? `repository:${branchRepository}`
      : '';
  const hasBranchControls = Boolean(branchControlKey);
  const branchControlLabel = selectedEnvironment && selectedEnvironment.repositories.length > 1 ? 'Branches' : 'Branch';

  const canSubmit = !props.archived && !props.readOnly && Boolean(prompt.trim()) && !props.modelUnavailableReason;

  useEffect(() => {
    setBranchControlsOpen(false);
  }, [branchControlKey]);

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
          <CodebasePicker
            className="min-w-0 flex-[2_1_16rem]"
            triggerClassName="h-8 text-xs"
            direction="up"
            value={codebaseValue}
            environments={props.environmentOptions}
            environmentsLoading={props.environmentOptionsLoading}
            environmentsError={props.environmentOptionsError}
            repositories={props.repositoryOptions}
            repositoriesLoading={props.repositoryOptionsLoading}
            repositoriesError={props.repositoryOptionsError}
            onChange={props.onCodebaseChange}
            placeholder={props.inheritedCodebaseLabel || 'Select codebase...'}
            allowEmpty={Boolean(codebaseValue)}
            emptyOptionLabel="Use session codebase"
            disabled={props.archived || props.readOnly}
          />
          {hasBranchControls ? (
            <Button
              className="h-8 shrink-0 px-2 text-xs"
              type="button"
              variant={branchControlsOpen ? 'default' : 'secondary'}
              size="sm"
              onClick={() => setBranchControlsOpen((open) => !open)}
              disabled={props.archived || props.readOnly}
              aria-expanded={branchControlsOpen}
            >
              {branchControlLabel}
            </Button>
          ) : null}
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
          {branchControlsOpen && branchRepository ? (
            <div className="basis-full">
              <BranchPicker
                className="min-w-0 max-w-xs"
                triggerClassName="h-8 text-xs"
                direction="up"
                value={props.branch}
                branches={props.branchOptions}
                loading={props.branchOptionsLoading}
                error={props.branchOptionsError}
                onChange={props.onBranchChange}
                disabled={props.archived || props.readOnly}
                placeholder={props.inheritedBranch || 'Branch'}
              />
            </div>
          ) : null}
          {branchControlsOpen && selectedEnvironment ? (
            <EnvironmentBranchOverridesEditor
              compact
              environment={selectedEnvironment}
              value={props.environmentBranchOverrides}
              direction="up"
              disabled={props.archived || props.readOnly}
              onLoadBranches={props.onEnvironmentRepositoryBranchesLoad}
              onChange={props.onEnvironmentBranchOverridesChange}
            />
          ) : null}
          <Button
            className="ml-auto h-8 w-8 shrink-0 p-0"
            type="submit"
            disabled={!canSubmit}
            aria-label="Send message"
            title="Send message"
            onTouchStart={handleSubmitTouchStart}
            onTouchMove={handleSubmitTouchMove}
            onTouchEnd={handleSubmitTouchEnd}
            onTouchCancel={handleSubmitTouchCancel}
          >
            <SendHorizontal className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </Card>
    </form>
  );
}
