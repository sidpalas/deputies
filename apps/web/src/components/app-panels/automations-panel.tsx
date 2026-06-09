import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, CalendarClock, PanelLeftOpen, Play, RotateCcw, Save } from 'lucide-react';
import {
  ApiError,
  createAutomation,
  invokeAutomation,
  listAutomationInvocations,
  listBranches,
  updateAutomation,
  type Automation,
  type AutomationInvocation,
  type BranchOption,
  type Group,
  type ModelChoice,
  type RepositoryOption,
  type Session,
} from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';
import { BranchPicker, OptionPicker, RepositoryPicker, type OptionPickerOption } from './option-picker.js';
import { formatDate, statusTextClass } from './shared.js';

type AutomationForm = {
  id: string;
  groupId: string;
  name: string;
  scheduleCron: string;
  repository: string;
  branch: string;
  model: string;
  prompt: string;
  enabled: boolean;
};

type AsyncState<T> = {
  data: T;
  loading: boolean;
  error: string;
};

const invocationHistoryPageSize = 20;

function automationGroupOptions(input: {
  formGroupId: string;
  selectableGroups: Group[];
  selected: Automation | null;
  selectedGroup: Group | undefined;
  selectedGroupSelectable: boolean;
}): OptionPickerOption[] {
  const options = input.selectableGroups.map((group) => ({ value: group.id, label: group.name }));
  if (!input.formGroupId || input.selectedGroupSelectable) return options;

  options.unshift(unavailableAutomationGroupOption(input.formGroupId, input.selectedGroup, input.selected));
  return options;
}

function unavailableAutomationGroupOption(
  groupId: string,
  group: Group | undefined,
  automation: Automation | null,
): OptionPickerOption {
  if (group?.archivedAt) {
    return {
      value: groupId,
      label: `${group.name} (archived)`,
      available: false,
      unavailableReason: 'Archived group.',
      action: 'New sessions are suspended until this group is unarchived.',
    };
  }

  return {
    value: groupId,
    label: `${group?.name ?? automation?.ownerGroupName ?? groupId} (current)`,
    available: false,
    unavailableReason: 'Unavailable group.',
  };
}

export function AutomationsPanel(props: {
  automation: Automation | null;
  automationsLoaded: boolean;
  automationsLoading: boolean;
  canCallApi: boolean;
  canCreateAutomations: boolean;
  groups: Group[];
  token: string;
  repositoryOptions: RepositoryOption[];
  repositoryOptionsLoading: boolean;
  repositoryOptionsError: string;
  modelChoices: ModelChoice[];
  selectedAutomationId: string;
  showOpenSidebar: boolean;
  openSidebarLabel?: string;
  onAutomationChanged: (automation: Automation) => void;
  onArchiveAutomation: (automationId: string) => void;
  onAutomationSaved: (automation: Automation) => void;
  onOpenSidebar: () => void;
  onSessionCreated: (session: Session) => void;
  onSelectSession: (sessionId: string) => void;
  onUnarchiveAutomation: (automationId: string) => void;
  onError: (error: unknown) => void;
}) {
  const [invocations, setInvocations] = useState<AutomationInvocation[]>([]);
  const [invocationsNextCursor, setInvocationsNextCursor] = useState('');
  const [invocationsLoading, setInvocationsLoading] = useState(false);
  const [olderInvocationsLoading, setOlderInvocationsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<AutomationForm>(() => emptyForm(props.groups));
  const [branchOptionsState, setBranchOptionsState] = useState<AsyncState<BranchOption[]>>({
    data: [],
    loading: false,
    error: '',
  });
  const branchOptionsRepositoryRef = useRef('');
  const selected = props.automation;
  const selectedArchived = Boolean(selected?.archivedAt);
  const selectedAutomationIdRef = useRef(selected?.id ?? '');
  const selectableGroups = props.groups.filter((group) => {
    if (group.archivedAt) return false;
    return selected ? group.canManage : group.canCreateAutomations;
  });
  const selectedGroup = props.groups.find((group) => group.id === form.groupId);
  const selectedOwnerGroup = selected ? props.groups.find((group) => group.id === selected.ownerGroupId) : null;
  const selectedOwnerGroupArchived = Boolean(
    selected && form.groupId === selected.ownerGroupId && (selectedGroup?.archivedAt || selected.ownerGroupArchivedAt),
  );
  const selectedGroupSelectable = selectableGroups.some((group) => group.id === form.groupId);
  const groupOptions = automationGroupOptions({
    formGroupId: form.groupId,
    selectableGroups,
    selected,
    selectedGroup,
    selectedGroupSelectable,
  });
  const branchOptions = branchOptionsState.data;
  const branchOptionsLoading = branchOptionsState.loading;
  const branchOptionsError = branchOptionsState.error;
  const modelOptions = props.modelChoices.length
    ? props.modelChoices
    : [{ value: '', label: 'Default model', available: true }];
  const displayedModelOptions =
    form.model && !modelOptions.some((option) => option.value === form.model)
      ? [{ value: form.model, label: `${form.model} (saved)`, available: true }, ...modelOptions]
      : modelOptions;
  const canEdit =
    props.canCallApi && (selected ? Boolean(selected.canManage) && !selectedArchived : props.canCreateAutomations);
  const canEditDefinition = canEdit;
  const canChangeGroup = canEdit && (selected ? Boolean(selectedOwnerGroup?.canManage) : true);
  const formComplete = Boolean(form.groupId && form.name.trim() && form.scheduleCron.trim() && form.prompt.trim());
  const saveDisabled = !canEdit || saving || !formComplete || (!selected && !selectedGroupSelectable);

  useEffect(() => {
    selectedAutomationIdRef.current = selected?.id ?? '';
  }, [selected?.id]);

  useEffect(() => {
    setForm((current) => (current.groupId ? current : { ...current, groupId: defaultAutomationGroupId(props.groups) }));
  }, [props.groups]);

  useEffect(() => {
    if (!selected) {
      setInvocations([]);
      setInvocationsNextCursor('');
      setInvocationsLoading(false);
      setOlderInvocationsLoading(false);
      if (!props.selectedAutomationId) setForm(emptyForm(props.groups));
      return;
    }
    let cancelled = false;
    setForm(formFromAutomation(selected));
    setInvocationsLoading(true);
    setOlderInvocationsLoading(false);
    setInvocationsNextCursor('');
    listAutomationInvocations({ automationId: selected.id, token: props.token, limit: invocationHistoryPageSize })
      .then((page) => {
        if (cancelled) return;
        setInvocations(page.invocations);
        setInvocationsNextCursor(page.nextCursor ?? '');
      })
      .catch((error) => {
        if (!cancelled) props.onError(error);
      })
      .finally(() => {
        if (!cancelled) setInvocationsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, props.selectedAutomationId, props.token]);

  useEffect(() => {
    const repository = form.repository.trim();
    if (branchOptionsRepositoryRef.current !== repository) {
      branchOptionsRepositoryRef.current = repository;
      setBranchOptionsState((current) => ({ ...current, data: [], error: '' }));
    }
    if (!props.canCallApi || !repository) {
      setBranchOptionsState((current) => ({ ...current, loading: false }));
      return;
    }

    let cancelled = false;
    setBranchOptionsState((current) => ({ ...current, loading: true, error: '' }));
    listBranches({ repository, token: props.token })
      .then((branches) => {
        if (cancelled) return;
        setBranchOptionsState({ data: branches, loading: false, error: '' });
        setForm((current) => {
          if (current.repository.trim() !== repository || current.branch) return current;
          const repo = props.repositoryOptions.find((option) => option.fullName === repository);
          return { ...current, branch: repo?.defaultBranch ?? branches[0]?.name ?? '' };
        });
      })
      .catch(() => {
        if (!cancelled) setBranchOptionsState({ data: [], loading: false, error: 'Could not load branches.' });
      });

    return () => {
      cancelled = true;
    };
  }, [form.repository, props.canCallApi, props.repositoryOptions, props.token]);

  async function saveAutomation() {
    if (saveDisabled) return;
    setSaving(true);
    try {
      const input = automationFormInput(form, props.token);
      let saved: Automation;
      if (form.id) {
        saved = await updateAutomation({ ...input, automationId: form.id });
      } else {
        saved = await createAutomation(input);
      }
      props.onAutomationSaved(saved);
      setForm(formFromAutomation(saved));
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(automation: Automation) {
    if (!automation.canManage || automation.archivedAt) return;
    setSaving(true);
    try {
      const updated = await updateAutomation({
        automationId: automation.id,
        token: props.token,
        enabled: !automation.enabled,
      });
      props.onAutomationChanged(updated);
      if (selected?.id === updated.id) setForm(formFromAutomation(updated));
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function invokeSelected(options: { allowOverlap?: boolean; disabledConfirmed?: boolean } = {}) {
    if (!selected?.canManage || selected.archivedAt) return;
    if (selectedOwnerGroupArchived) return;
    const allowDisabled = !selected.enabled;
    const allowOverlap = options.allowOverlap === true;
    if (
      allowDisabled &&
      !options.disabledConfirmed &&
      !window.confirm('This automation is disabled. Invoke it once anyway?')
    ) {
      return;
    }
    setSaving(true);
    try {
      const result = await invokeAutomation({
        automationId: selected.id,
        token: props.token,
        allowDisabled,
        allowOverlap,
      });
      props.onAutomationChanged(result.automation);
      setInvocations((current) => [
        result.invocation,
        ...current.filter((invocation) => invocation.id !== result.invocation.id),
      ]);
      if (result.session) props.onSessionCreated(result.session);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && !allowOverlap) {
        const confirmed = window.confirm(
          'This automation already has a queued or active session. Invoke another session anyway?',
        );
        if (confirmed) await invokeSelected({ allowOverlap: true, disabledConfirmed: allowDisabled });
      } else {
        props.onError(error);
      }
    } finally {
      setSaving(false);
    }
  }

  async function loadOlderInvocations() {
    if (!selected || !invocationsNextCursor || olderInvocationsLoading) return;
    const automationId = selected.id;
    setOlderInvocationsLoading(true);
    try {
      const page = await listAutomationInvocations({
        automationId,
        token: props.token,
        limit: invocationHistoryPageSize,
        cursor: invocationsNextCursor,
      });
      if (selectedAutomationIdRef.current !== automationId) return;
      setInvocations((current) => [
        ...current,
        ...page.invocations.filter((invocation) => !current.some((existing) => existing.id === invocation.id)),
      ]);
      setInvocationsNextCursor(page.nextCursor ?? '');
    } catch (error) {
      props.onError(error);
    } finally {
      setOlderInvocationsLoading(false);
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
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">Automations</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Scheduled automations</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Create recurring sessions from 5-field cron expressions. Cron is always evaluated in UTC.
              </p>
            </div>
          </div>
        </div>

        {props.selectedAutomationId && !selected ? (
          <Card className="p-5">
            <h2 className="text-lg font-semibold text-foreground">
              {!props.automationsLoaded || props.automationsLoading ? 'Loading automation' : 'Automation not found'}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {!props.automationsLoaded || props.automationsLoading
                ? 'Fetching the selected automation.'
                : 'The selected automation is not available or you no longer have access to it.'}
            </p>
          </Card>
        ) : (
          <div className="grid gap-5">
            <Card className="p-5">
              {/* Keep this panel kind-aware when non-scheduled automation types are added. */}
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                <div className="min-w-0 flex-1 basis-64">
                  <h2 className="text-lg font-semibold text-foreground">
                    {form.id ? 'Edit automation' : 'New automation'}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Generated sessions use this automation&apos;s group and prompt context.
                  </p>
                </div>
                {selected && !selected.archivedAt ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => void toggleEnabled(selected)}
                      disabled={saving || !selected.canManage}
                    >
                      {selected.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      onClick={() => void invokeSelected()}
                      disabled={saving || !selected.canManage || selectedOwnerGroupArchived}
                    >
                      <Play className="h-4 w-4" /> Invoke now
                    </Button>
                  </div>
                ) : null}
              </div>

              {selectedArchived ? (
                <div className="mt-4 rounded-md border border-border bg-muted/60 p-3 text-sm text-muted-foreground">
                  This automation is archived. Restore it before editing or invoking it. Restored automations stay
                  disabled until you enable them.
                </div>
              ) : null}

              <form
                className="mt-5 grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAutomation();
                }}
              >
                <div className="grid gap-3 md:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)]">
                  <Field label="Name" htmlFor="automation-name">
                    <Input
                      id="automation-name"
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      placeholder="Nightly dependency check"
                      disabled={!canEditDefinition}
                    />
                  </Field>
                  <Field label="Access group" htmlFor="automation-group">
                    <OptionPicker
                      id="automation-group"
                      label="Access group"
                      value={form.groupId}
                      options={groupOptions}
                      emptyLabel="Select access group..."
                      onChange={(value) => setForm({ ...form, groupId: value })}
                      disabled={!canChangeGroup || (selectableGroups.length <= 1 && selectedGroupSelectable)}
                    />
                  </Field>
                </div>

                <div className="grid gap-3 md:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)]">
                  <Field label="UTC cron" htmlFor="automation-cron" hint="Five fields: minute hour day month weekday.">
                    <Input
                      id="automation-cron"
                      className="font-mono"
                      value={form.scheduleCron}
                      onChange={(event) => setForm({ ...form, scheduleCron: event.target.value })}
                      placeholder="0 9 * * 1-5"
                      disabled={!canEditDefinition}
                    />
                  </Field>
                  <label className="mt-5 flex h-10 items-center gap-2 text-sm text-muted-foreground">
                    <input
                      className="disabled:cursor-not-allowed disabled:opacity-50"
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                      disabled={!canEditDefinition}
                    />
                    Enabled for automatic scheduled invocations
                  </label>
                </div>

                <div className="grid gap-3 md:grid-cols-[minmax(10rem,1fr)_minmax(8rem,12rem)_minmax(8rem,14rem)]">
                  <Field label="Repository" htmlFor="automation-repository">
                    <RepositoryPicker
                      id="automation-repository"
                      value={form.repository}
                      repositories={props.repositoryOptions}
                      loading={props.repositoryOptionsLoading}
                      error={props.repositoryOptionsError}
                      onChange={(value) => setForm({ ...form, repository: value, branch: '' })}
                      placeholder="GitHub repository, e.g. owner/repo"
                      disabled={!canEditDefinition}
                    />
                  </Field>
                  <Field label="Branch" htmlFor="automation-branch">
                    <BranchPicker
                      id="automation-branch"
                      value={form.branch}
                      branches={branchOptions}
                      loading={branchOptionsLoading}
                      error={branchOptionsError}
                      onChange={(value) => setForm({ ...form, branch: value })}
                      placeholder="Default"
                      disabled={!canEditDefinition || !form.repository}
                    />
                  </Field>
                  <Field label="Model" htmlFor="automation-model">
                    <OptionPicker
                      id="automation-model"
                      label="Model"
                      value={form.model}
                      options={displayedModelOptions}
                      emptyLabel="Default model"
                      allowEmpty={Boolean(form.model)}
                      onChange={(value) => setForm({ ...form, model: value })}
                      disabled={!canEditDefinition || props.modelChoices.length <= 1}
                    />
                  </Field>
                </div>

                <Field label="Prompt" htmlFor="automation-prompt">
                  <Textarea
                    id="automation-prompt"
                    className="min-h-40"
                    value={form.prompt}
                    onChange={(event) => setForm({ ...form, prompt: event.target.value })}
                    placeholder="Ask Deputies to run this recurring check..."
                    disabled={!canEditDefinition}
                  />
                </Field>

                {!formComplete ? (
                  <p className="text-sm text-muted-foreground">Name, group, UTC cron, and prompt are required.</p>
                ) : null}
                {selectedOwnerGroupArchived ? (
                  <div className="rounded-md border border-border bg-muted/60 p-3 text-sm text-muted-foreground">
                    This automation is {selected?.enabled ? 'enabled, but' : 'disabled, and'} scheduled and manual
                    invocations are suspended while its access group is archived. Unarchive the group or move the
                    automation to an active access group to resume creating sessions.
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={saveDisabled}>
                    <Save className="h-4 w-4" /> {form.id ? 'Save automation' : 'Create automation'}
                  </Button>
                  {selected ? (
                    <AutomationArchiveAction
                      automation={selected}
                      saving={saving}
                      onArchiveAutomation={props.onArchiveAutomation}
                      onUnarchiveAutomation={props.onUnarchiveAutomation}
                    />
                  ) : null}
                </div>
              </form>
            </Card>

            <Card className="p-5">
              <div className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-primary" />
                <h2 className="text-lg font-semibold text-foreground">Invocation history</h2>
              </div>
              {selected ? (
                <div className="mt-4 grid gap-2">
                  {invocationsLoading ? (
                    <p className="text-sm text-muted-foreground">Loading invocation history...</p>
                  ) : null}
                  {!invocationsLoading
                    ? invocations.map((invocation) => (
                        <InvocationRow
                          key={invocation.id}
                          invocation={invocation}
                          onSelectSession={props.onSelectSession}
                        />
                      ))
                    : null}
                  {!invocationsLoading && !invocations.length ? (
                    <p className="text-sm text-muted-foreground">No invocations recorded yet.</p>
                  ) : null}
                  {!invocationsLoading && invocationsNextCursor ? (
                    <Button
                      className="justify-self-start"
                      variant="secondary"
                      size="sm"
                      onClick={() => void loadOlderInvocations()}
                      disabled={olderInvocationsLoading}
                    >
                      {olderInvocationsLoading ? 'Loading older...' : 'Load older'}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">
                  Select an automation to inspect created, skipped, or failed invocations.
                </p>
              )}
            </Card>
          </div>
        )}
      </div>
    </section>
  );
}

function Field(props: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={props.htmlFor}>
        {props.label}
      </label>
      {props.children}
      {props.hint ? <p className="mt-1 text-xs text-muted-foreground">{props.hint}</p> : null}
    </div>
  );
}

function AutomationArchiveAction(props: {
  automation: Automation;
  saving: boolean;
  onArchiveAutomation: (automationId: string) => void;
  onUnarchiveAutomation: (automationId: string) => void;
}) {
  if (props.automation.archivedAt) {
    return (
      <Button
        type="button"
        variant="secondary"
        onClick={() => props.onUnarchiveAutomation(props.automation.id)}
        disabled={props.saving || !props.automation.canManage}
      >
        <RotateCcw className="h-4 w-4" /> Restore automation
      </Button>
    );
  }

  return (
    <Button
      type="button"
      className="border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10"
      variant="secondary"
      onClick={() => props.onArchiveAutomation(props.automation.id)}
      disabled={props.saving || !props.automation.canManage}
    >
      <Archive className="h-4 w-4" /> Archive automation
    </Button>
  );
}

function InvocationRow(props: { invocation: AutomationInvocation; onSelectSession: (sessionId: string) => void }) {
  const statusParts = [
    props.invocation.sessionStatus ? (
      <span key="session">
        Session{' '}
        <span className={statusTextClass(props.invocation.sessionStatus)}>{props.invocation.sessionStatus}</span>
      </span>
    ) : null,
    props.invocation.messageStatus ? (
      <span key="message">
        Message{' '}
        <span className={statusTextClass(props.invocation.messageStatus)}>{props.invocation.messageStatus}</span>
      </span>
    ) : null,
  ].filter(Boolean);

  return (
    <div className="rounded-md border border-border bg-background/70 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn('font-semibold', statusTextClass(props.invocation.status))}>
            {props.invocation.status}
          </span>
          <span className="text-xs text-muted-foreground">{props.invocation.trigger}</span>
          <span className="text-xs text-muted-foreground">{formatDate(props.invocation.createdAt)}</span>
        </div>
        {props.invocation.sessionId ? (
          <Button
            className="h-7 px-2 text-xs"
            variant="secondary"
            size="sm"
            onClick={() => props.onSelectSession(props.invocation.sessionId!)}
          >
            Open session
          </Button>
        ) : null}
      </div>
      {statusParts.length ? (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {statusParts.map((part, index) => (
            <span key={index}>
              {index > 0 ? <span className="mr-3 text-muted-foreground">|</span> : null}
              {part}
            </span>
          ))}
        </div>
      ) : null}
      {props.invocation.reason ? (
        <p className="mt-1 text-xs text-muted-foreground">Reason: {props.invocation.reason}</p>
      ) : null}
      {props.invocation.error ? <p className="mt-1 text-xs text-destructive">{props.invocation.error}</p> : null}
    </div>
  );
}

function emptyForm(groups: Group[]): AutomationForm {
  return {
    id: '',
    groupId: defaultAutomationGroupId(groups),
    name: '',
    scheduleCron: '0 9 * * 1-5',
    repository: '',
    branch: '',
    model: '',
    prompt: '',
    enabled: true,
  };
}

function defaultAutomationGroupId(groups: Group[]): string {
  return groups.find((group) => !group.archivedAt && group.canCreateAutomations)?.id ?? '';
}

function formFromAutomation(automation: Automation): AutomationForm {
  return {
    id: automation.id,
    groupId: automation.ownerGroupId,
    name: automation.name,
    scheduleCron: automation.scheduleCron,
    repository: repositoryContextLabel(automation.context?.repository),
    branch: typeof automation.context?.branch === 'string' ? automation.context.branch : '',
    model: typeof automation.context?.model === 'string' ? automation.context.model : '',
    prompt: automation.prompt,
    enabled: automation.enabled,
  };
}

function automationFormInput(form: AutomationForm, token: string) {
  return {
    token,
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    scheduleCron: form.scheduleCron.trim(),
    ownerGroupId: form.groupId,
    enabled: form.enabled,
    repository: form.repository.trim(),
    branch: form.branch.trim(),
    model: form.model,
  };
}

function repositoryContextLabel(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const repository = value as Record<string, unknown>;
  const owner = typeof repository.owner === 'string' ? repository.owner : '';
  const repo = typeof repository.repo === 'string' ? repository.repo : '';
  return owner && repo ? `${owner}/${repo}` : '';
}
