import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Archive, PanelLeftOpen, Plus, RotateCcw, Save, Share2, Trash2 } from 'lucide-react';
import {
  archiveEnvironment,
  createEnvironment,
  listEnvironmentRevisions,
  unarchiveEnvironment,
  updateEnvironment,
  type Environment,
  type EnvironmentRevision,
  type EnvironmentRepositoryInput,
  type EnvironmentShareMode,
  type Group,
  type RepositoryOption,
} from '../../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { OptionPicker, RepositoryPicker, type OptionPickerOption } from './option-picker.js';
import { RevisionSelector, useRevisionViewer } from './revision-selector.js';
import { SharingGroupPicker } from './sharing-group-picker.js';
import { UnsavedIndicator } from './shared.js';
import { useEditorDirty } from './use-editor-dirty.js';

const MAX_ENVIRONMENT_REPOSITORIES = 10;

type EnvironmentRepositoryForm = {
  key: string;
  repository: string;
  branch: string;
  primary: boolean;
};

type EnvironmentForm = {
  id: string;
  name: string;
  ownerGroupId: string;
  shareMode: EnvironmentShareMode;
  sharedGroupIds: string[];
  repositories: EnvironmentRepositoryForm[];
};

let repositoryKeyCounter = 0;

function loadRevisions(environmentId: string, token: string) {
  return listEnvironmentRevisions({ environmentId, token });
}

export function EnvironmentsPanel(props: {
  environments: Environment[];
  environmentsLoading: boolean;
  environmentsError: string;
  selectedEnvironmentId: string;
  selectedRevisionId: string;
  canCallApi: boolean;
  groups: Group[];
  token: string;
  repositoryOptions: RepositoryOption[];
  repositoryOptionsLoading: boolean;
  repositoryOptionsError: string;
  showOpenSidebar: boolean;
  openSidebarLabel?: string;
  onCreateEnvironment: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
  onEnvironmentChanged: (environment: Environment) => void;
  onOpenSidebar: () => void;
  onSelectRevision: (revisionId: string) => void;
  onError: (error: unknown) => void;
}) {
  const [form, setForm] = useState<EnvironmentForm>(() => emptyForm(props.groups));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const selected = props.environments.find((environment) => environment.id === props.selectedEnvironmentId) ?? null;
  const revisionViewer = useRevisionViewer({
    resourceId: selected?.id ?? '',
    currentRevisionId: selected?.currentRevisionId,
    selectedRevisionId: props.selectedRevisionId,
    token: props.token,
    enabled: Boolean(selected),
    loadRevisions,
    onSelectRevision: props.onSelectRevision,
    onError: props.onError,
  });
  const viewedRevision = revisionViewer.viewedRevision;
  const manageableGroups = useMemo(
    () => props.groups.filter((group) => !group.archivedAt && group.canManage),
    [props.groups],
  );
  const ownerGroup = props.groups.find((group) => group.id === form.ownerGroupId);
  const canCreate = props.canCallApi && manageableGroups.length > 0;
  const canEdit =
    props.canCallApi &&
    !viewedRevision &&
    (form.id ? Boolean(selected?.canManage) && !selected?.archivedAt : canCreate);
  const complete = validateForm(form) === '';
  let displayedForm: EnvironmentForm;
  if (!selected) displayedForm = emptyForm(props.groups);
  else if (viewedRevision) displayedForm = formFromEnvironmentRevision(selected, viewedRevision);
  else displayedForm = formFromEnvironment(selected);
  const baselineForm = displayedForm;
  const dirty = environmentFormChanged(form, baselineForm);
  const saveDisabled = !canEdit || saving || !complete || !dirty;
  useEditorDirty(dirty, props.onDirtyChange);

  useEffect(() => {
    setForm(displayedForm);
    setFormError('');
  }, [
    props.selectedEnvironmentId,
    selected?.id,
    selected?.currentRevisionId,
    selected?.updatedAt,
    viewedRevision?.id,
    props.groups,
  ]);

  useEffect(() => {
    setForm((current) => {
      if (current.ownerGroupId || !manageableGroups[0]) return current;
      return { ...current, ownerGroupId: manageableGroups[0].id };
    });
  }, [manageableGroups]);

  function startNewEnvironment() {
    if (!props.onCreateEnvironment()) return;
    setForm(emptyForm(props.groups));
    setFormError('');
  }

  function updateOwnerGroup(ownerGroupId: string) {
    setForm((current) => ({
      ...current,
      ownerGroupId,
      sharedGroupIds: current.sharedGroupIds.filter((groupId) => groupId !== ownerGroupId),
    }));
  }

  function updateShareMode(shareMode: EnvironmentShareMode) {
    setForm((current) => ({
      ...current,
      shareMode,
      sharedGroupIds: shareMode === 'selected_groups' ? current.sharedGroupIds : [],
    }));
  }

  function updateRepository(key: string, next: Partial<EnvironmentRepositoryForm>) {
    setForm((current) => ({
      ...current,
      repositories: current.repositories.map((repository) =>
        repository.key === key ? { ...repository, ...next } : repository,
      ),
    }));
  }

  function selectPrimaryRepository(key: string) {
    setForm((current) => ({
      ...current,
      repositories: current.repositories.map((repository) => ({ ...repository, primary: repository.key === key })),
    }));
  }

  function addRepository() {
    setForm((current) => {
      if (current.repositories.length >= MAX_ENVIRONMENT_REPOSITORIES) return current;
      return {
        ...current,
        repositories: [
          ...current.repositories,
          { key: nextRepositoryKey(), repository: '', branch: '', primary: current.repositories.length === 0 },
        ],
      };
    });
  }

  function removeRepository(key: string) {
    setForm((current) => {
      const removed = current.repositories.find((repository) => repository.key === key);
      const repositories = current.repositories.filter((repository) => repository.key !== key);
      if (removed?.primary && repositories[0]) repositories[0] = { ...repositories[0], primary: true };
      return { ...current, repositories };
    });
  }

  async function saveEnvironment() {
    const validationError = validateForm(form);
    if (saveDisabled || validationError) {
      setFormError(validationError);
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const input = {
        token: props.token,
        name: form.name.trim(),
        ownerGroupId: form.ownerGroupId,
        shareMode: form.shareMode,
        sharedGroupIds: form.shareMode === 'selected_groups' ? form.sharedGroupIds : [],
        repositories: repositoriesInput(form.repositories),
      };
      const saved = form.id
        ? await updateEnvironment({ ...input, environmentId: form.id })
        : await createEnvironment(input);
      props.onEnvironmentChanged(saved);
      setForm(formFromEnvironment(saved));
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function archiveSelectedEnvironment() {
    if (!selected?.canManage || selected.archivedAt) return;
    if (dirty && !window.confirm('Discard unsaved changes and archive this environment?')) return;
    setSaving(true);
    setFormError('');
    try {
      const archived = await archiveEnvironment({ environmentId: selected.id, token: props.token });
      props.onEnvironmentChanged(archived);
      setForm(formFromEnvironment(archived));
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function unarchiveSelectedEnvironment() {
    if (!selected?.canManage || !selected.archivedAt) return;
    setSaving(true);
    setFormError('');
    try {
      const unarchived = await unarchiveEnvironment({ environmentId: selected.id, token: props.token });
      props.onEnvironmentChanged(unarchived);
      setForm(formFromEnvironment(unarchived));
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full min-h-0 overflow-auto px-4 py-6 md:px-8 xl:px-14">
      <div className="mx-auto grid max-w-4xl gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            {props.showOpenSidebar ? (
              <Button
                className="mt-1 h-8 w-8 shrink-0 p-0 md:hidden"
                variant="ghost"
                size="icon"
                onClick={props.onOpenSidebar}
                aria-label={props.openSidebarLabel ?? 'Open sessions'}
                title={props.openSidebarLabel ?? 'Open sessions'}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            ) : null}
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">Environments</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Code environments</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Manage reusable multi-repository codebases for sessions and automations.
              </p>
            </div>
          </div>
          <Button onClick={startNewEnvironment} disabled={!canCreate}>
            <Plus className="h-4 w-4" /> New environment
          </Button>
        </div>

        {props.environmentsError ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {props.environmentsError}
          </p>
        ) : null}

        {props.selectedEnvironmentId && !selected ? (
          <Card className="min-w-0 p-5">
            <h2 className="text-lg font-semibold text-foreground">
              {props.environmentsLoading ? 'Loading environment' : 'Environment not found'}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {props.environmentsLoading
                ? 'Fetching the selected environment.'
                : 'The selected environment is not available or you no longer have access to it.'}
            </p>
          </Card>
        ) : (
          <Card className="min-w-0 p-5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
              <h2 className="min-w-0 text-lg font-semibold text-foreground">
                {form.id ? (selected?.archivedAt ? 'Archived environment' : 'Edit environment') : 'New environment'}
              </h2>
              {selected?.currentRevisionId && selected.currentRevisionNumber ? (
                <div className="flex shrink-0 items-center gap-2">
                  {!viewedRevision && dirty ? <UnsavedIndicator /> : null}
                  <RevisionSelector
                    currentRevisionId={selected.currentRevisionId}
                    currentRevisionNumber={selected.currentRevisionNumber}
                    selectedRevisionId={props.selectedRevisionId}
                    revisions={revisionViewer.revisions}
                    loading={revisionViewer.loading}
                    error={revisionViewer.error}
                    onSelectRevision={revisionViewer.selectRevision}
                  />
                </div>
              ) : dirty ? (
                <UnsavedIndicator />
              ) : null}
              <p className="col-span-2 text-sm text-muted-foreground">
                The primary repository sets the initial working directory. Other repositories are cloned beside it.
              </p>
            </div>

            {viewedRevision ? (
              <p className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                Viewing repository configuration from revision {viewedRevision.revisionNumber}. Name, owner, and sharing
                reflect the current environment; this view is read-only.
              </p>
            ) : revisionViewer.requestedRevisionMissing ? (
              <p className="mt-4 rounded-md border border-border bg-muted/60 p-3 text-sm text-muted-foreground">
                The requested revision is unavailable. Showing the current repository configuration.
              </p>
            ) : null}

            {selected?.archivedAt ? (
              <div className="mt-4 rounded-md border border-border bg-muted/60 p-3 text-sm text-muted-foreground">
                Archived environments are read-only and cannot be selected for new work.
              </div>
            ) : null}

            <form
              className="mt-5 grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void saveEnvironment();
              }}
            >
              <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Field label="Name" htmlFor="environment-name">
                  <Input
                    id="environment-name"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    placeholder="Control plane and web"
                    disabled={!canEdit}
                  />
                </Field>
                <Field label="Owner group" htmlFor="environment-owner-group">
                  <OptionPicker
                    id="environment-owner-group"
                    label="Owner group"
                    value={form.ownerGroupId}
                    options={ownerGroupOptions(manageableGroups, ownerGroup)}
                    emptyLabel="Select owner group..."
                    onChange={updateOwnerGroup}
                    disabled={!canEdit || ownerGroupOptions(manageableGroups, ownerGroup).length <= 1}
                  />
                </Field>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">Repositories</h3>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={addRepository}
                    disabled={!canEdit || form.repositories.length >= MAX_ENVIRONMENT_REPOSITORIES}
                  >
                    <Plus className="h-4 w-4" /> Add repo
                  </Button>
                </div>
                <p className="mb-2 text-sm text-muted-foreground">
                  Environments support up to {MAX_ENVIRONMENT_REPOSITORIES} repositories.
                </p>
                <div className="grid gap-2">
                  {form.repositories.map((repository, index) => (
                    <div
                      key={repository.key}
                      className="grid min-w-0 gap-2 rounded-md border border-border bg-background/70 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto_auto]"
                    >
                      <RepositoryPicker
                        className="min-w-0"
                        menuClassName="min-w-full"
                        label={`Repository ${index + 1}`}
                        value={repository.repository}
                        repositories={repositoryOptionsForValue(props.repositoryOptions, repository.repository)}
                        loading={props.repositoryOptionsLoading}
                        error={props.repositoryOptionsError}
                        onChange={(value) => updateRepository(repository.key, { repository: value, branch: '' })}
                        placeholder="GitHub repository"
                        disabled={!canEdit}
                      />
                      <Input
                        className="min-w-0"
                        value={repository.branch}
                        onChange={(event) => updateRepository(repository.key, { branch: event.target.value })}
                        placeholder="Default branch"
                        aria-label={`Branch for repository ${index + 1}`}
                        disabled={!canEdit}
                      />
                      <div className="flex min-w-0 items-center justify-between gap-2 md:contents">
                        <label className="flex h-10 min-w-0 items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
                          <input
                            type="radio"
                            name="environment-primary-repository"
                            aria-label={`Make repository ${index + 1} primary`}
                            checked={repository.primary}
                            onChange={() => selectPrimaryRepository(repository.key)}
                            disabled={!canEdit}
                          />
                          Primary
                        </label>
                        <Button
                          type="button"
                          className="h-10 w-10 shrink-0 p-0"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeRepository(repository.key)}
                          disabled={!canEdit || (form.repositories.length === 1 && index === 0)}
                          aria-label={`Remove repository ${index + 1}`}
                          title={`Remove repository ${index + 1}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-md border border-border bg-muted/20 p-4">
                <div className="flex items-center gap-2">
                  <Share2 className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold text-foreground">Sharing</h3>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sharing grants use and read access. Management stays with the owner group.
                </p>
                <div className="mt-4 grid min-w-0 gap-3 xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                  <fieldset className="grid self-start gap-2 text-sm" disabled={!canEdit}>
                    <legend className="sr-only">Sharing</legend>
                    {(['private', 'selected_groups', 'all_groups'] as const).map((mode) => (
                      <label key={mode} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="environment-share-mode"
                          checked={form.shareMode === mode}
                          onChange={() => updateShareMode(mode)}
                        />
                        {environmentShareModeLabel(mode)}
                      </label>
                    ))}
                  </fieldset>
                  <div className="min-w-0">
                    {form.shareMode === 'all_groups' ? (
                      <div className="flex min-w-0 gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning-foreground dark:text-warning">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <p className="min-w-0">
                          All current and future active groups can use this environment and its repositories. Management
                          stays with {ownerGroup?.name ?? 'the owner group'}.
                        </p>
                      </div>
                    ) : form.shareMode === 'selected_groups' ? (
                      <SharingGroupPicker
                        groups={props.groups}
                        ownerGroupId={form.ownerGroupId}
                        selectedGroupIds={form.sharedGroupIds}
                        disabled={!canEdit}
                        onSelectedGroupIdsChange={(sharedGroupIds) => setForm({ ...form, sharedGroupIds })}
                      />
                    ) : (
                      <p className="flex min-h-10 min-w-0 items-center text-sm text-muted-foreground">
                        Only members of {ownerGroup?.name ?? 'the owner group'} can view and use this environment.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {formError || (!complete && form.name.trim()) ? (
                <p className="text-sm text-destructive">{formError || validateForm(form)}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={saveDisabled}>
                  <Save className="h-4 w-4" /> {form.id ? 'Save environment' : 'Create environment'}
                </Button>
                {selected?.archivedAt ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void unarchiveSelectedEnvironment()}
                    disabled={saving || !selected.canManage || Boolean(viewedRevision)}
                  >
                    <RotateCcw className="h-4 w-4" /> Restore
                  </Button>
                ) : selected ? (
                  <Button
                    type="button"
                    className="border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10"
                    variant="secondary"
                    onClick={() => void archiveSelectedEnvironment()}
                    disabled={saving || !selected.canManage || Boolean(viewedRevision)}
                  >
                    <Archive className="h-4 w-4" /> Archive
                  </Button>
                ) : null}
                {!canCreate && !form.id ? (
                  <p className="self-center text-sm text-muted-foreground">
                    Group admin access is required to create environments.
                  </p>
                ) : null}
              </div>
            </form>
          </Card>
        )}
      </div>
    </section>
  );
}

function Field(props: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={props.htmlFor}>
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

function emptyForm(groups: Group[]): EnvironmentForm {
  return {
    id: '',
    name: '',
    ownerGroupId: groups.find((group) => !group.archivedAt && group.canManage)?.id ?? '',
    shareMode: 'private',
    sharedGroupIds: [],
    repositories: [{ key: nextRepositoryKey(), repository: '', branch: '', primary: true }],
  };
}

function formFromEnvironment(environment: Environment): EnvironmentForm {
  return {
    id: environment.id,
    name: environment.name,
    ownerGroupId: environment.ownerGroupId,
    shareMode: environment.shareMode,
    sharedGroupIds: environment.sharedGroupIds,
    repositories: environment.repositories
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((repository) => ({
        key: repository.id,
        repository: `${repository.owner}/${repository.repo}`,
        branch: repository.branch ?? '',
        primary: repository.primary,
      })),
  };
}

function formFromEnvironmentRevision(environment: Environment, revision: EnvironmentRevision): EnvironmentForm {
  return {
    ...formFromEnvironment(environment),
    repositories: revision.repositories
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((repository, index) => ({
        key: `${revision.id}-repository-${index}`,
        repository: `${repository.owner}/${repository.repo}`,
        branch: repository.branch ?? '',
        primary: repository.primary,
      })),
  };
}

function environmentFormChanged(form: EnvironmentForm, baseline: EnvironmentForm): boolean {
  return (
    form.name !== baseline.name ||
    form.ownerGroupId !== baseline.ownerGroupId ||
    form.shareMode !== baseline.shareMode ||
    [...form.sharedGroupIds].sort().join('\0') !== [...baseline.sharedGroupIds].sort().join('\0') ||
    JSON.stringify(form.repositories.map(({ repository, branch, primary }) => ({ repository, branch, primary }))) !==
      JSON.stringify(baseline.repositories.map(({ repository, branch, primary }) => ({ repository, branch, primary })))
  );
}

function ownerGroupOptions(manageableGroups: Group[], ownerGroup: Group | undefined): OptionPickerOption[] {
  const options: OptionPickerOption[] = manageableGroups.map((group) => ({ value: group.id, label: group.name }));
  if (ownerGroup && !options.some((option) => option.value === ownerGroup.id)) {
    options.unshift({
      value: ownerGroup.id,
      label: `${ownerGroup.name}${ownerGroup.archivedAt ? ' (archived)' : ''}`,
      available: false,
      unavailableReason: ownerGroup.archivedAt ? 'Archived group.' : 'Unavailable group.',
    });
  }
  return options;
}

function repositoryOptionsForValue(options: RepositoryOption[], value: string): RepositoryOption[] {
  if (!value || options.some((option) => option.fullName === value)) return options;
  const [owner, name] = parseRepository(value);
  return [{ fullName: value, owner, name }, ...options];
}

function environmentShareModeLabel(mode: EnvironmentShareMode): string {
  if (mode === 'all_groups') return 'All groups';
  if (mode === 'selected_groups') return 'Specific groups';
  return 'Owner group only';
}

function validateForm(form: EnvironmentForm): string {
  if (!form.name.trim()) return 'Name is required.';
  if (!form.ownerGroupId) return 'Owner group is required.';
  if (!form.repositories.length) return 'At least one repository is required.';
  if (form.repositories.filter((repository) => repository.primary).length !== 1)
    return 'Select one primary repository.';
  const seen = new Set<string>();
  for (const repository of form.repositories) {
    const [owner, repo] = parseRepository(repository.repository);
    if (!owner || !repo) return 'Each repository must be selected.';
    const key = `${owner}/${repo}`.toLowerCase();
    if (seen.has(key)) return 'Repositories cannot be duplicated in one environment.';
    seen.add(key);
  }
  return '';
}

function repositoriesInput(repositories: EnvironmentRepositoryForm[]): EnvironmentRepositoryInput[] {
  return repositories.map((repository) => {
    const [owner, repo] = parseRepository(repository.repository);
    return {
      provider: 'github',
      owner,
      repo,
      primary: repository.primary,
      ...(repository.branch.trim() ? { branch: repository.branch.trim() } : {}),
    };
  });
}

function parseRepository(value: string): [string, string] {
  const [owner, repo] = value.trim().split('/');
  return [owner?.trim() ?? '', repo?.trim() ?? ''];
}

function nextRepositoryKey(): string {
  repositoryKeyCounter += 1;
  return `repository-${repositoryKeyCounter}`;
}
