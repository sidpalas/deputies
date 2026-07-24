import { useEffect, useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import type {
  BranchOption,
  Environment,
  ModelChoice,
  ReasoningLevel,
  RepositoryOption,
  Skill,
  Snippet,
  SkillInvocationRef,
} from '../../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Textarea } from '../ui/textarea.js';
import {
  EnvironmentBranchOverridesEditor,
  type EnvironmentBranchOverrides,
  type EnvironmentBranchOverrideRepository,
} from './environment-branch-overrides.js';
import {
  BranchPicker,
  CodebasePicker,
  codebaseEnvironmentValue,
  codebaseRepositoryValue,
  OptionPicker,
} from './option-picker.js';
import { submitOnEnter } from './shared.js';
import { defaultReasoningLevelLabel, REASONING_LEVEL_OPTIONS } from './reasoning-level.js';
import { SkillInvocationField } from './skill-invocation-field.js';
import { useSkillInvocationDraft } from './skill-invocation-draft.js';
import { SnippetPicker, useSnippetPicker } from './snippet-picker.js';

export function NewThreadPanel(props: {
  canCallApi: boolean;
  canCreatePrivateSession?: boolean;
  readOnly: boolean;
  loading: boolean;
  prompt: string;
  environmentId: string;
  environmentBranchOverrides: EnvironmentBranchOverrides;
  environmentOptions: Environment[];
  environmentOptionsLoading: boolean;
  environmentOptionsError: string;
  repository: string;
  repositoryOptions: RepositoryOption[];
  repositoryOptionsLoading: boolean;
  repositoryOptionsError: string;
  branch: string;
  branchOptions: BranchOption[];
  branchOptionsLoading: boolean;
  branchOptionsError: string;
  model: string;
  modelChoices: ModelChoice[];
  modelUnavailableReason: string;
  reasoningLevel: ReasoningLevel | '';
  defaultReasoningLevel: ReasoningLevel | '';
  skills: Skill[];
  skillsEnabled: boolean;
  snippets?: Snippet[];
  snippetsEnabled?: boolean;
  skillsLoading?: boolean;
  skillError?: string;
  showOpenSidebar: boolean;
  openSidebarLabel?: string;
  onOpenSidebar: () => void;
  onPromptChange: (value: string) => void;
  onCodebaseChange: (value: string) => void;
  onEnvironmentBranchOverridesChange: (value: EnvironmentBranchOverrides) => void;
  onEnvironmentRepositoryBranchesLoad: (repository: EnvironmentBranchOverrideRepository) => Promise<BranchOption[]>;
  onBranchChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onReasoningLevelChange: (value: ReasoningLevel | '') => void;
  onSubmit: (input: {
    prompt: string;
    skills: string[];
    skillRefs: SkillInvocationRef[];
    visibility: 'tenant' | 'private';
  }) => Promise<boolean>;
}) {
  const [branchControlsOpen, setBranchControlsOpen] = useState(false);
  const [privateSession, setPrivateSession] = useState(false);
  const selectedEnvironment =
    props.environmentOptions.find((environment) => environment.id === props.environmentId) ?? null;
  const codebaseValue = props.environmentId
    ? codebaseEnvironmentValue(props.environmentId)
    : props.repository
      ? codebaseRepositoryValue(props.repository)
      : '';
  const branchControlKey = selectedEnvironment
    ? `environment:${selectedEnvironment.id}`
    : props.repository
      ? `repository:${props.repository}`
      : '';
  const branchControlLabel = selectedEnvironment && selectedEnvironment.repositories.length > 1 ? 'Branches' : 'Branch';
  const snippetDraft = useSnippetPicker({
    snippets: props.snippets ?? [],
    enabled: Boolean(props.snippetsEnabled),
    prompt: props.prompt,
    onPromptChange: props.onPromptChange,
  });
  const skillDraft = useSkillInvocationDraft({
    available: props.skills,
    enabled: props.skillsEnabled,
    prompt: props.prompt,
    onPromptChange: props.onPromptChange,
    selectionStart: snippetDraft.selectionStart,
    textareaRef: snippetDraft.textareaRef,
    onSelectionStartChange: snippetDraft.setSelectionStart,
  });

  useEffect(() => {
    setBranchControlsOpen(false);
  }, [branchControlKey]);

  async function submit() {
    const prepared = skillDraft.prepareSubmission();
    if (!prepared.prompt.trim() && !prepared.skillRefs.length) return;
    const sent = await props.onSubmit({ ...prepared, visibility: privateSession ? 'private' : 'tenant' });
    if (sent) {
      skillDraft.clearSelectedSkills();
      setPrivateSession(false);
    }
  }

  function handlePromptKeyDown(event: Parameters<typeof skillDraft.handlePromptKeyDown>[0]) {
    if (snippetDraft.keyDown(event)) return;
    if (skillDraft.handlePromptKeyDown(event)) return;
    submitOnEnter(event);
  }

  return (
    <section className="h-full min-h-0 overflow-y-auto px-4 py-6 md:px-8 xl:px-14">
      <div className="mx-auto grid max-w-4xl gap-5">
        <Card className="min-w-0 w-full p-5">
          <div className="flex min-w-0 items-center gap-2">
            {props.showOpenSidebar ? (
              <Button
                className="h-8 w-8 shrink-0 p-0 md:hidden"
                variant="ghost"
                size="icon"
                onClick={props.onOpenSidebar}
                aria-label={props.openSidebarLabel ?? 'Open sessions'}
                title={props.openSidebarLabel ?? 'Open sessions'}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            ) : null}
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">Deputies</p>
          </div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
            Engineering agents for delegated work.
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Assign work, track each step, and inspect the final output.
          </p>
          {props.readOnly ? (
            <p className="mt-4 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
              You have read-only access. You can inspect existing sessions, but only admins can start new work.
            </p>
          ) : null}
          <h2 className="mt-6 text-xl font-semibold">What needs doing?</h2>
          <form
            className="mt-4 grid min-w-0 gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="relative flex min-w-0 flex-wrap gap-2">
              <div className="min-w-0 flex-[1.4_1_18rem]">
                <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-codebase">
                  Codebase
                </label>
                <CodebasePicker
                  id="new-thread-codebase"
                  menuClassName="min-w-full"
                  value={codebaseValue}
                  environments={props.environmentOptions}
                  environmentsLoading={props.environmentOptionsLoading}
                  environmentsError={props.environmentOptionsError}
                  repositories={props.repositoryOptions}
                  repositoriesLoading={props.repositoryOptionsLoading}
                  repositoriesError={props.repositoryOptionsError}
                  onChange={props.onCodebaseChange}
                  placeholder="Select environment or repository..."
                  disabled={!props.canCallApi}
                />
              </div>
              {props.repository ? (
                <div className="min-w-0 flex-[0.8_1_10rem]">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-branch">
                    Branch
                  </label>
                  <BranchPicker
                    id="new-thread-branch"
                    menuClassName="min-w-full"
                    value={props.branch}
                    branches={props.branchOptions}
                    loading={props.branchOptionsLoading}
                    error={props.branchOptionsError}
                    onChange={props.onBranchChange}
                    disabled={!props.canCallApi}
                  />
                </div>
              ) : selectedEnvironment ? (
                <div
                  className="shrink-0"
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setBranchControlsOpen(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setBranchControlsOpen(false);
                  }}
                >
                  <span className="mb-1 block text-xs font-medium opacity-0" aria-hidden="true">
                    {branchControlLabel}
                  </span>
                  <Button
                    className="h-10 px-3"
                    type="button"
                    variant={branchControlsOpen ? 'default' : 'secondary'}
                    size="sm"
                    onClick={() => setBranchControlsOpen((open) => !open)}
                    disabled={!props.canCallApi}
                    aria-expanded={branchControlsOpen}
                    aria-haspopup="dialog"
                  >
                    {branchControlLabel}
                  </Button>
                  {branchControlsOpen ? (
                    <div
                      className="absolute right-0 top-full z-30 mt-1 w-[28rem] max-w-full rounded-md border border-border bg-card p-2 text-card-foreground shadow-xl"
                      role="dialog"
                      aria-label={`${branchControlLabel} for ${selectedEnvironment.name}`}
                    >
                      <EnvironmentBranchOverridesEditor
                        compact
                        environment={selectedEnvironment}
                        value={props.environmentBranchOverrides}
                        direction="down"
                        disabled={!props.canCallApi || !props.environmentId}
                        onLoadBranches={props.onEnvironmentRepositoryBranchesLoad}
                        onChange={props.onEnvironmentBranchOverridesChange}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="min-w-0 flex-[0.7_1_9rem]">
                <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-model">
                  Model
                </label>
                <OptionPicker
                  id="new-thread-model"
                  label="Model"
                  value={props.model}
                  options={props.modelChoices}
                  emptyLabel="Default model"
                  onChange={props.onModelChange}
                  disabled={!props.canCallApi || props.modelChoices.length <= 1}
                />
              </div>
              <div className="min-w-0 flex-[0.55_1_8rem]">
                <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-reasoning">
                  Reasoning
                </label>
                <OptionPicker
                  id="new-thread-reasoning"
                  label="Reasoning"
                  value={props.reasoningLevel}
                  options={REASONING_LEVEL_OPTIONS}
                  emptyLabel={defaultReasoningLevelLabel(props.defaultReasoningLevel)}
                  allowEmpty={Boolean(props.reasoningLevel)}
                  onChange={(value) => props.onReasoningLevelChange(value as ReasoningLevel | '')}
                  disabled={!props.canCallApi}
                />
              </div>
            </div>
            {props.modelUnavailableReason ? (
              <p className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning-foreground dark:text-warning">
                {props.modelUnavailableReason}
              </p>
            ) : null}
            {props.canCreatePrivateSession ? (
              <label className="flex items-start gap-2 text-sm text-muted-foreground">
                <input
                  className="mt-0.5 disabled:cursor-not-allowed disabled:opacity-50"
                  type="checkbox"
                  checked={privateSession}
                  onChange={(event) => setPrivateSession(event.target.checked)}
                  disabled={!props.canCallApi}
                />
                <span>
                  <span className="font-medium text-foreground">Private session</span>
                  <span className="block text-xs">
                    Only you can find or access it. You can make it tenant-wide later.
                  </span>
                </span>
              </label>
            ) : null}
            <div className="min-w-0 rounded-md border border-input bg-background/80 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
              <SkillInvocationField
                controller={skillDraft}
                availableCount={props.skills.length}
                enabled={props.skillsEnabled}
                disabled={!props.canCallApi}
                loading={props.skillsLoading}
                error={props.skillError}
              />
              <SnippetPicker controller={snippetDraft} />
              <Textarea
                ref={snippetDraft.textareaRef}
                className="min-h-40 min-w-0 border-0 bg-transparent focus:border-transparent focus:ring-0"
                value={props.prompt}
                onChange={(event) => {
                  snippetDraft.setSelectionStart(event.target.selectionStart);
                  skillDraft.changePrompt(event.target.value);
                }}
                onSelect={(event) => snippetDraft.setSelectionStart(event.currentTarget.selectionStart)}
                onKeyDown={handlePromptKeyDown}
                placeholder="Ask Deputies to investigate, change code, or answer a question..."
                disabled={!props.canCallApi}
                autoFocus
              />
            </div>
            <Button
              className="justify-self-end"
              type="submit"
              disabled={
                !props.canCallApi ||
                props.loading ||
                (!props.prompt.trim() && !skillDraft.selectedSkills.length) ||
                Boolean(props.modelUnavailableReason)
              }
            >
              Start session
            </Button>
          </form>
        </Card>
      </div>
    </section>
  );
}
