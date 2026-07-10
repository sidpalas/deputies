import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Archive, PanelLeftOpen, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import {
  archiveEnvironment,
  createEnvironment,
  unarchiveEnvironment,
  updateEnvironment,
  type Environment,
  type EnvironmentRepositoryInput,
  type EnvironmentShareMode,
  type Group,
  type RepositoryOption,
} from '../../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { OptionPicker, RepositoryPicker, type OptionPickerOption } from './option-picker.js';

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

export function EnvironmentsPanel(props: {
  environments: Environment[];
  environmentsLoading: boolean;
  environmentsError: string;
  selectedEnvironmentId: string;
  canCallApi: boolean;
  groups: Group[];
  token: string;
  repositoryOptions: RepositoryOption[];
  repositoryOptionsLoading: boolean;
  repositoryOptionsError: string;
  showOpenSidebar: boolean;
  openSidebarLabel?: string;
  onCreateEnvironment: () => void;
  onEnvironmentChanged: (environment: Environment) => void;
  onOpenSidebar: () => void;
  onError: (error: unknown) => void;
}) {
  const [form, setForm] = useState<EnvironmentForm>(() => emptyForm(props.groups));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [sharedGroupSearch, setSharedGroupSearch] = useState('');
  const selected = props.environments.find((environment) => environment.id === props.selectedEnvironmentId) ?? null;
  const manageableGroups = useMemo(
    () => props.groups.filter((group) => !group.archivedAt && group.canManage),
    [props.groups],
  );
  const ownerGroup = props.groups.find((group) => group.id === form.ownerGroupId);
  const activeSharingGroups = props.groups.filter((group) => !group.archivedAt);
  const filteredSharingGroups = activeSharingGroups.filter((group) =>
    group.name.toLowerCase().includes(sharedGroupSearch.trim().toLowerCase()),
  );
  const selectedSharingGroupCount = Number(Boolean(ownerGroup && !ownerGroup.archivedAt)) + form.sharedGroupIds.length;
  const canCreate = props.canCallApi && manageableGroups.length > 0;
  const canEdit = props.canCallApi && (form.id ? Boolean(selected?.canManage) && !selected?.archivedAt : canCreate);
  const complete = validateForm(form) === '';
  const saveDisabled = !canEdit || saving || !complete;

  useEffect(() => {
    setForm(selected ? formFromEnvironment(selected) : emptyForm(props.groups));
    setFormError('');
  }, [props.selectedEnvironmentId, selected?.id, props.groups]);

  useEffect(() => {
    setForm((current) => {
      if (current.ownerGroupId || !manageableGroups[0]) return current;
      return { ...current, ownerGroupId: manageableGroups[0].id };
    });
  }, [manageableGroups]);

  function startNewEnvironment() {
    props.onCreateEnvironment();
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

  function updateShareMode(shareMode: string) {
    setForm((current) => ({
      ...current,
      shareMode: shareMode as EnvironmentShareMode,
      sharedGroupIds: shareMode === 'selected_groups' ? current.sharedGroupIds : [],
    }));
  }

  function toggleSharedGroup(groupId: string, checked: boolean) {
    setForm((current) => ({
      ...current,
      sharedGroupIds: checked
        ? [...new Set([...current.sharedGroupIds, groupId])]
        : current.sharedGroupIds.filter((candidate) => candidate !== groupId),
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
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {form.id ? (selected?.archivedAt ? 'Archived environment' : 'Edit environment') : 'New environment'}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  The primary repository sets the initial working directory. Other repositories are cloned beside it.
                </p>
              </div>
              {selected?.archivedAt ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void unarchiveSelectedEnvironment()}
                  disabled={saving || !selected.canManage}
                >
                  <RotateCcw className="h-4 w-4" /> Restore
                </Button>
              ) : selected ? (
                <Button
                  type="button"
                  className="border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10"
                  variant="secondary"
                  onClick={() => void archiveSelectedEnvironment()}
                  disabled={saving || !selected.canManage}
                >
                  <Archive className="h-4 w-4" /> Archive
                </Button>
              ) : null}
            </div>

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

              <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                <Field label="Sharing" htmlFor="environment-sharing">
                  <OptionPicker
                    id="environment-sharing"
                    label="Sharing"
                    value={form.shareMode}
                    options={[
                      { value: 'private', label: 'Owner group only' },
                      { value: 'selected_groups', label: 'Selected groups' },
                      { value: 'all_groups', label: 'All groups' },
                    ]}
                    emptyLabel="Owner group only"
                    onChange={updateShareMode}
                    disabled={!canEdit}
                  />
                </Field>
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
                    <div className="rounded-md border border-border bg-background/70 p-3">
                      {activeSharingGroups.length ? (
                        <>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm text-muted-foreground">{selectedSharingGroupCount} selected</p>
                          </div>
                          <Input
                            className="mt-3"
                            value={sharedGroupSearch}
                            onChange={(event) => setSharedGroupSearch(event.target.value)}
                            placeholder="Search groups..."
                          />
                          {filteredSharingGroups.length ? (
                            <div className="mt-3 grid max-h-56 gap-2 overflow-auto pr-1 sm:grid-cols-2">
                              {filteredSharingGroups.map((group) => (
                                <label key={group.id} className="flex items-center gap-2 text-sm text-foreground">
                                  <input
                                    type="checkbox"
                                    checked={group.id === form.ownerGroupId || form.sharedGroupIds.includes(group.id)}
                                    onChange={(event) => toggleSharedGroup(group.id, event.target.checked)}
                                    disabled={!canEdit || group.id === form.ownerGroupId}
                                  />
                                  <span className="min-w-0 truncate">
                                    {group.name}
                                    {group.id === form.ownerGroupId ? ' (owner)' : ''}
                                  </span>
                                </label>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-3 text-sm text-muted-foreground">No matching groups.</p>
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">No active groups are available.</p>
                      )}
                    </div>
                  ) : (
                    <p className="min-w-0 pt-6 text-sm text-muted-foreground">
                      Only members of {ownerGroup?.name ?? 'the owner group'} can view and use this environment.
                    </p>
                  )}
                </div>
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
                        repositories={props.repositoryOptions}
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
                  ))}
                </div>
              </div>

              {formError || (!complete && form.name.trim()) ? (
                <p className="text-sm text-destructive">{formError || validateForm(form)}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={saveDisabled}>
                  <Save className="h-4 w-4" /> {form.id ? 'Save environment' : 'Create environment'}
                </Button>
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
