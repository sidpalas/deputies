import type { FormEvent } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import type { BranchOption, Group, ModelChoice, RepositoryOption } from '../../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Textarea } from '../ui/textarea.js';
import { BranchPicker, OptionPicker, RepositoryPicker } from './option-picker.js';
import { submitOnEnter } from './shared.js';

export function NewThreadPanel(props: {
  canCallApi: boolean;
  readOnly: boolean;
  loading: boolean;
  groupId: string;
  groups: Group[];
  prompt: string;
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
  onRepositoryChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-2xl p-5">
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
        <form className="mt-4 grid gap-3" onSubmit={props.onSubmit}>
          {props.groups.length > 1 ? (
            <div>
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
          <div className="grid gap-2 sm:grid-cols-[minmax(16rem,1fr)_minmax(8rem,12rem)_minmax(8rem,14rem)]">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-repository">
                Repository
              </label>
              <RepositoryPicker
                id="new-thread-repository"
                value={props.repository}
                repositories={props.repositoryOptions}
                loading={props.repositoryOptionsLoading}
                error={props.repositoryOptionsError}
                onChange={props.onRepositoryChange}
                placeholder="GitHub repository, e.g. owner/repo"
                disabled={!props.canCallApi}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-thread-branch">
                Branch
              </label>
              <BranchPicker
                id="new-thread-branch"
                value={props.branch}
                branches={props.branchOptions}
                loading={props.branchOptionsLoading}
                error={props.branchOptionsError}
                onChange={props.onBranchChange}
                disabled={!props.canCallApi || !props.repository}
              />
            </div>
            <div>
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
          {props.modelUnavailableReason ? (
            <p className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning-foreground dark:text-warning">
              {props.modelUnavailableReason}
            </p>
          ) : null}
          <Textarea
            className="min-h-40"
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
    </section>
  );
}
