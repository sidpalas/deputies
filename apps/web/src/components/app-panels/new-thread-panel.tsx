import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import type { BranchOption, Environment, Group, ModelChoice, RepositoryOption } from '../../api.js';
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

export function NewThreadPanel(props: {
  canCallApi: boolean;
  readOnly: boolean;
  loading: boolean;
  groupId: string;
  groups: Group[];
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
  showOpenSidebar: boolean;
  openSidebarLabel?: string;
  onOpenSidebar: () => void;
  onGroupChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onCodebaseChange: (value: string) => void;
  onEnvironmentBranchOverridesChange: (value: EnvironmentBranchOverrides) => void;
  onEnvironmentRepositoryBranchesLoad: (repository: EnvironmentBranchOverrideRepository) => Promise<BranchOption[]>;
  onBranchChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const [branchControlsOpen, setBranchControlsOpen] = useState(false);
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
  const hasBranchControls = Boolean(branchControlKey);
  const branchControlLabel = selectedEnvironment && selectedEnvironment.repositories.length > 1 ? 'Branches' : 'Branch';

  useEffect(() => {
    setBranchControlsOpen(false);
  }, [branchControlKey]);

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
          <form className="mt-4 grid min-w-0 gap-3" onSubmit={props.onSubmit}>
            {props.groups.length > 1 ? (
              <div className="min-w-0">
                <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-group">
                  Access group
                </label>
                <OptionPicker
                  id="new-thread-group"
                  label="Access group"
                  value={props.groupId}
                  options={props.groups.map((group) => ({ value: group.id, label: group.name }))}
                  emptyLabel="Select access group..."
                  onChange={props.onGroupChange}
                  disabled={!props.canCallApi}
                />
              </div>
            ) : null}
            <div className="flex min-w-0 flex-wrap gap-2">
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
              {hasBranchControls ? (
                <div className="shrink-0">
                  <span className="mb-1 block text-xs font-medium opacity-0" aria-hidden="true">
                    {branchControlLabel}
                  </span>
                  <Button
                    className="h-10 shrink-0 px-3"
                    type="button"
                    variant={branchControlsOpen ? 'default' : 'secondary'}
                    size="sm"
                    onClick={() => setBranchControlsOpen((open) => !open)}
                    disabled={!props.canCallApi}
                    aria-expanded={branchControlsOpen}
                  >
                    {branchControlLabel}
                  </Button>
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
            </div>
            {branchControlsOpen && props.repository ? (
              <div className="max-w-xs min-w-0">
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
            ) : null}
            {branchControlsOpen && selectedEnvironment ? (
              <EnvironmentBranchOverridesEditor
                environment={selectedEnvironment}
                value={props.environmentBranchOverrides}
                disabled={!props.canCallApi || !props.environmentId}
                onLoadBranches={props.onEnvironmentRepositoryBranchesLoad}
                onChange={props.onEnvironmentBranchOverridesChange}
              />
            ) : null}
            {props.modelUnavailableReason ? (
              <p className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning-foreground dark:text-warning">
                {props.modelUnavailableReason}
              </p>
            ) : null}
            <Textarea
              className="min-h-40 min-w-0"
              value={props.prompt}
              onChange={(event) => props.onPromptChange(event.target.value)}
              onKeyDown={(event) => submitOnEnter(event)}
              placeholder="Ask Deputies to investigate, change code, or answer a question..."
              disabled={!props.canCallApi}
              autoFocus
            />
            <Button
              className="justify-self-end"
              type="submit"
              disabled={
                !props.canCallApi || props.loading || !props.prompt.trim() || Boolean(props.modelUnavailableReason)
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
