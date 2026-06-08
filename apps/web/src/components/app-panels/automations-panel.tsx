import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CalendarClock, CornerUpLeft, PanelLeftClose, PanelLeftOpen, Play, Plus, Save, X } from 'lucide-react';
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
  type Health,
  type ModelChoice,
  type RepositoryOption,
} from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';
import { BranchPicker, OptionPicker, RepositoryPicker } from './option-picker.js';
import { formatDate, statusTextClass } from './shared.js';
import { ApiStatusFooter, ThemeToggle } from './session-sidebar.js';
import type { ConnectionStatus, ThemePreference } from './types.js';

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

export function AutomationsSidebar(props: {
  authRequired: boolean;
  automations: Automation[];
  canCallApi: boolean;
  canViewGroups: boolean;
  canViewAutomations: boolean;
  canViewSetup: boolean;
  connectionStatus: ConnectionStatus;
  health: Health | null;
  loading: boolean;
  navPage: 'sessions' | 'setup' | 'groups' | 'automations';
  selectedAutomationId: string;
  themePreference: ThemePreference;
  token: string;
  onBackToSessions: () => void;
  onCollapse: () => void;
  onCreateAutomation: () => void;
  onOpenAutomations: () => void;
  onOpenGroups: () => void;
  onOpenSessions: () => void;
  onOpenSetup: () => void;
  onSelectAutomation: (automationId: string) => void;
  onSignOut: () => void;
  onThemeChange: (value: ThemePreference) => void;
}) {
  const [search, setSearch] = useState('');
  const normalizedSearch = search.trim().toLowerCase();
  const sortedAutomations = useMemo(
    () => [...props.automations].sort((a, b) => a.name.localeCompare(b.name)),
    [props.automations],
  );
  const filteredAutomations = normalizedSearch
    ? sortedAutomations.filter(
        (automation) =>
          automation.name.toLowerCase().includes(normalizedSearch) ||
          automation.scheduleCron.toLowerCase().includes(normalizedSearch),
      )
    : sortedAutomations;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <Button
          className="shrink-0"
          variant="ghost"
          size="icon"
          onClick={props.onCollapse}
          aria-label="Hide sidebar"
          title="Hide sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Automations</h2>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            size="icon"
            onClick={props.onBackToSessions}
            aria-label="Back to sessions"
            title="Back to sessions"
          >
            <CornerUpLeft className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            onClick={props.onCreateAutomation}
            disabled={!props.canCallApi}
            aria-label="New automation"
            title="New automation"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="relative mb-3 shrink-0">
        <Input
          className="pr-9"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search automations..."
        />
        {search ? (
          <Button
            className="absolute right-1 top-1 h-8 w-8 p-0"
            variant="ghost"
            size="icon"
            onClick={() => setSearch('')}
            aria-label="Clear automation search"
            title="Clear automation search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {filteredAutomations.length ? (
          <div className="grid min-w-0 gap-1">
            {filteredAutomations.map((automation) => (
              <AutomationSidebarButton
                key={automation.id}
                automation={automation}
                selected={automation.id === props.selectedAutomationId}
                onSelect={props.onSelectAutomation}
              />
            ))}
          </div>
        ) : (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {props.loading
              ? 'Loading automations...'
              : search
                ? 'No matching automations.'
                : 'No scheduled automations yet.'}
          </p>
        )}
      </div>

      <ThemeToggle preference={props.themePreference} onChange={props.onThemeChange} />
      <ApiStatusFooter
        authRequired={props.authRequired}
        canViewGroups={props.canViewGroups}
        canViewAutomations={props.canViewAutomations}
        canViewSetup={props.canViewSetup}
        health={props.health}
        navPage={props.navPage}
        token={props.token}
        onOpenGroups={props.onOpenGroups}
        onOpenAutomations={props.onOpenAutomations}
        onOpenSessions={props.onOpenSessions}
        onOpenSetup={props.onOpenSetup}
        onSignOut={props.onSignOut}
      />
    </div>
  );
}

function AutomationSidebarButton(props: {
  automation: Automation;
  selected: boolean;
  onSelect: (automationId: string) => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-transparent p-2 text-left hover:bg-accent',
        props.selected && 'border-primary bg-primary/15',
      )}
      onClick={() => props.onSelect(props.automation.id)}
    >
      <span className="block min-w-0 flex-1 overflow-hidden">
        <strong className="block w-full truncate text-sm font-medium text-foreground">{props.automation.name}</strong>
        <span className="block w-full truncate font-mono text-xs text-muted-foreground">
          {props.automation.scheduleCron} UTC
        </span>
        <span className="block w-full truncate text-xs text-muted-foreground">
          {props.automation.enabled ? 'Enabled' : 'Disabled'} · Next{' '}
          {props.automation.nextInvocationAt ? formatDate(props.automation.nextInvocationAt) : 'not scheduled'}
        </span>
      </span>
    </button>
  );
}

export function AutomationsPanel(props: {
  automation: Automation | null;
  automationsLoaded: boolean;
  automationsLoading: boolean;
  canCallApi: boolean;
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
  onAutomationSaved: (automation: Automation) => void;
  onOpenSidebar: () => void;
  onSelectSession: (sessionId: string) => void;
  onError: (error: unknown) => void;
}) {
  const [invocations, setInvocations] = useState<AutomationInvocation[]>([]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<AutomationForm>(() => emptyForm(props.groups));
  const [branchOptionsState, setBranchOptionsState] = useState<AsyncState<BranchOption[]>>({
    data: [],
    loading: false,
    error: '',
  });
  const branchOptionsRepositoryRef = useRef('');
  const selected = props.automation;
  const activeGroups = props.groups.filter((group) => !group.archivedAt);
  const branchOptions = branchOptionsState.data;
  const branchOptionsLoading = branchOptionsState.loading;
  const branchOptionsError = branchOptionsState.error;
  const modelOptions = props.modelChoices.length
    ? props.modelChoices
    : [{ value: '', label: 'Default model', available: true }];

  useEffect(() => {
    setForm((current) => (current.groupId ? current : { ...current, groupId: props.groups[0]?.id ?? '' }));
  }, [props.groups]);

  useEffect(() => {
    if (!selected) {
      setInvocations([]);
      if (!props.selectedAutomationId) setForm(emptyForm(props.groups));
      return;
    }
    let cancelled = false;
    setForm(formFromAutomation(selected));
    listAutomationInvocations({ automationId: selected.id, token: props.token })
      .then((nextInvocations) => {
        if (!cancelled) setInvocations(nextInvocations);
      })
      .catch((error) => {
        if (!cancelled) props.onError(error);
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
    if (!props.canCallApi || saving || !form.name.trim() || !form.prompt.trim() || !form.scheduleCron.trim()) return;
    setSaving(true);
    try {
      const input = automationFormInput(form, props.token);
      const saved = form.id
        ? await updateAutomation({ ...input, automationId: form.id })
        : await createAutomation(input);
      props.onAutomationSaved(saved);
      setForm(formFromAutomation(saved));
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(automation: Automation) {
    if (!automation.canManage) return;
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

  async function invokeSelected(allowOverlap = false) {
    if (!selected?.canManage) return;
    const allowDisabled = !selected.enabled;
    if (allowDisabled && !window.confirm('This automation is disabled. Invoke it once anyway?')) return;
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
      if (result.session) props.onSelectSession(result.session.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && !allowOverlap) {
        const confirmed = window.confirm(
          'This automation already has a queued or active session. Invoke another session anyway?',
        );
        if (confirmed) await invokeSelected(true);
      } else {
        props.onError(error);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="relative h-full min-h-0 overflow-auto px-4 py-6 md:px-8 xl:px-14">
      {props.showOpenSidebar ? (
        <Button
          className="absolute left-4 top-4 h-8 w-8 p-0 md:hidden"
          variant="ghost"
          size="icon"
          onClick={props.onOpenSidebar}
          aria-label={props.openSidebarLabel ?? 'Open sessions'}
          title={props.openSidebarLabel ?? 'Open sessions'}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
      ) : null}
      <div className="mx-auto grid max-w-4xl gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">Automations</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Scheduled automations</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Create recurring sessions from 5-field cron expressions. Cron is always evaluated in UTC.
            </p>
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
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    {form.id ? 'Edit automation' : 'New automation'}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Generated sessions use this automation&apos;s group and prompt context.
                  </p>
                </div>
                {selected ? (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => void toggleEnabled(selected)}
                      disabled={saving || !selected.canManage}
                    >
                      {selected.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button onClick={() => void invokeSelected()} disabled={saving || !selected.canManage}>
                      <Play className="h-4 w-4" /> Invoke now
                    </Button>
                  </div>
                ) : null}
              </div>

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
                      disabled={!props.canCallApi || (selected ? !selected.canManage : false)}
                    />
                  </Field>
                  <Field label="Group" htmlFor="automation-group">
                    <OptionPicker
                      id="automation-group"
                      label="Group"
                      value={form.groupId}
                      options={activeGroups.map((group) => ({ value: group.id, label: group.name }))}
                      emptyLabel="Select group..."
                      onChange={(value) => setForm({ ...form, groupId: value })}
                      disabled={
                        !props.canCallApi || activeGroups.length <= 1 || (selected ? !selected.canManage : false)
                      }
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
                      disabled={!props.canCallApi || (selected ? !selected.canManage : false)}
                    />
                  </Field>
                  <label className="mt-5 flex h-10 items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                      disabled={!props.canCallApi || (selected ? !selected.canManage : false)}
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
                      disabled={!props.canCallApi || (selected ? !selected.canManage : false)}
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
                      disabled={!props.canCallApi || !form.repository || (selected ? !selected.canManage : false)}
                    />
                  </Field>
                  <Field label="Model" htmlFor="automation-model">
                    <OptionPicker
                      id="automation-model"
                      label="Model"
                      value={form.model}
                      options={modelOptions}
                      emptyLabel="Default model"
                      allowEmpty={Boolean(form.model)}
                      onChange={(value) => setForm({ ...form, model: value })}
                      disabled={
                        !props.canCallApi || props.modelChoices.length <= 1 || (selected ? !selected.canManage : false)
                      }
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
                    disabled={!props.canCallApi || (selected ? !selected.canManage : false)}
                  />
                </Field>

                <Button
                  className="justify-self-end"
                  type="submit"
                  disabled={!props.canCallApi || saving || (selected ? !selected.canManage : false)}
                >
                  <Save className="h-4 w-4" /> {form.id ? 'Save automation' : 'Create automation'}
                </Button>
              </form>
            </Card>

            <Card className="p-5">
              <div className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-primary" />
                <h2 className="text-lg font-semibold text-foreground">Invocation history</h2>
              </div>
              {selected ? (
                <div className="mt-4 grid gap-2">
                  {invocations.map((invocation) => (
                    <InvocationRow
                      key={invocation.id}
                      invocation={invocation}
                      onSelectSession={props.onSelectSession}
                    />
                  ))}
                  {!invocations.length ? (
                    <p className="text-sm text-muted-foreground">No invocations recorded yet.</p>
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

function InvocationRow(props: { invocation: AutomationInvocation; onSelectSession: (sessionId: string) => void }) {
  return (
    <div className="rounded-md border border-border bg-background/70 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-foreground">
          <span className={statusTextClass(props.invocation.status)}>{props.invocation.status}</span> ·{' '}
          {props.invocation.trigger}
        </span>
        <span className="text-xs text-muted-foreground">{formatDate(props.invocation.createdAt)}</span>
      </div>
      {props.invocation.reason ? (
        <p className="mt-1 text-xs text-muted-foreground">Reason: {props.invocation.reason}</p>
      ) : null}
      {props.invocation.error ? <p className="mt-1 text-xs text-destructive">{props.invocation.error}</p> : null}
      {props.invocation.sessionId ? (
        <Button
          className="mt-2 h-7 px-2 text-xs"
          variant="secondary"
          size="sm"
          onClick={() => props.onSelectSession(props.invocation.sessionId!)}
        >
          Open created session
        </Button>
      ) : null}
    </div>
  );
}

function emptyForm(groups: Group[]): AutomationForm {
  return {
    id: '',
    groupId: groups[0]?.id ?? '',
    name: '',
    scheduleCron: '0 9 * * 1-5',
    repository: '',
    branch: '',
    model: '',
    prompt: '',
    enabled: true,
  };
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
