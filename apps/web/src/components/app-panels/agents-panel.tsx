import { useEffect, useState, type ReactNode } from 'react';
import { Archive, Check, Info, PanelLeftOpen, Play, RotateCcw, Save } from 'lucide-react';
import {
  createAgentProfile,
  listAgentProfileRevisions,
  setAgentProfileDefaultConfiguration,
  updateBuiltinAgentProfileSettings,
  updateAgentProfile,
  type AgentProfile,
  type AgentProfileDefaultConfiguration,
  type AgentProfileInvocation,
  type ModelChoice,
  type ReasoningLevel,
} from '../../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';
import { OptionPicker } from './option-picker.js';
import { REASONING_LEVEL_OPTIONS } from './reasoning-level.js';
import { RevisionSelector, useRevisionViewer } from './revision-selector.js';

type Form = {
  name: string;
  description: string;
  instructions: string;
  defaultModel: string;
  defaultReasoningLevel: ReasoningLevel | '';
  supportedInvocations: AgentProfileInvocation[];
};
const emptyForm = (): Form => ({
  name: '',
  description: '',
  instructions: '',
  defaultModel: '',
  defaultReasoningLevel: '',
  supportedInvocations: ['agent', 'subagent'],
});
const fromProfile = (p: AgentProfile): Form => ({
  name: p.name,
  description: p.description,
  instructions: p.instructions,
  defaultModel: p.defaultModel ?? '',
  defaultReasoningLevel: p.defaultReasoningLevel ?? '',
  supportedInvocations: p.supportedInvocations,
});

export function AgentsPanel(props: {
  profile: AgentProfile | null;
  selectedId: string;
  selectedRevisionId: string;
  loaded: boolean;
  loading: boolean;
  canManage: boolean;
  canConfigureDefault: boolean;
  defaultConfiguration: AgentProfileDefaultConfiguration | null;
  token: string;
  models: ModelChoice[];
  showOpenSidebar: boolean;
  onOpenSidebar: () => void;
  onChanged: (profile: AgentProfile) => void;
  onDefaultConfigurationChanged: (configuration: AgentProfileDefaultConfiguration) => void;
  onSelectRevision: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onStartSession: (id: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const [form, setForm] = useState<Form>(emptyForm);
  const [saving, setSaving] = useState(false);
  const revisionViewer = useRevisionViewer<AgentProfile & { id: string; revisionNumber: number; createdAt: string }>({
    resourceId: props.profile?.id ?? '',
    currentRevisionId: props.profile?.revision,
    selectedRevisionId: props.selectedRevisionId,
    token: props.token,
    enabled: props.profile?.source === 'managed',
    loadRevisions: async (id, token) =>
      (await listAgentProfileRevisions({ profileId: id, token })).map((revision) => ({
        ...revision,
        id: revision.revision,
        createdAt: revision.updatedAt,
      })),
    onSelectRevision: props.onSelectRevision,
    onError: props.onError,
  });
  const displayed = revisionViewer.viewedRevision ?? props.profile;
  useEffect(
    () => setForm(displayed ? fromProfile(displayed) : emptyForm()),
    [
      displayed?.id,
      displayed?.revision,
      displayed?.defaultModel,
      displayed?.defaultReasoningLevel,
      displayed?.enabled,
      props.selectedId,
    ],
  );
  const dirty = JSON.stringify(form) !== JSON.stringify(displayed ? fromProfile(displayed) : emptyForm());
  useEffect(() => {
    props.onDirtyChange(dirty);
    return () => props.onDirtyChange(false);
  }, [dirty]);
  const historical = Boolean(revisionViewer.viewedRevision);
  const builtin = props.profile?.source === 'builtin';
  const canEdit = props.canManage && !builtin && !historical && !props.profile?.archivedAt;
  const canEditBuiltinSettings = props.canManage && builtin;
  const isEffectiveDefault = props.profile?.id === props.defaultConfiguration?.effectiveProfileId;
  const configuredDefaultUnavailable =
    props.defaultConfiguration?.configuredProfileId !== null &&
    props.defaultConfiguration?.configuredProfileId !== props.defaultConfiguration?.effectiveProfileId;
  const canBeDefault = Boolean(
    props.profile?.enabled && !props.profile.archivedAt && props.profile.supportedInvocations.includes('agent'),
  );
  async function setTenantDefault(profileId: string) {
    setSaving(true);
    try {
      props.onDefaultConfigurationChanged(
        await setAgentProfileDefaultConfiguration({ token: props.token, defaultProfileId: profileId }),
      );
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }
  async function save() {
    if (
      (!canEdit && !canEditBuiltinSettings) ||
      !form.name.trim() ||
      !form.description.trim() ||
      !form.instructions.trim() ||
      !form.supportedInvocations.length
    )
      return;
    setSaving(true);
    try {
      const { defaultModel, defaultReasoningLevel, ...required } = form;
      const payload = {
        ...required,
        ...(defaultModel ? { defaultModel } : {}),
        ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
      };
      const saved = builtin
        ? await updateBuiltinAgentProfileSettings({
            profileId: props.profile!.id,
            token: props.token,
            defaultModel: defaultModel || null,
            defaultReasoningLevel: defaultReasoningLevel || null,
          })
        : props.profile
          ? await updateAgentProfile({
              ...payload,
              profileId: props.profile.id,
              expectedCurrentRevisionId: props.profile.revision,
              token: props.token,
            })
          : await createAgentProfile({ ...payload, token: props.token });
      props.onChanged(saved);
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="h-full overflow-auto px-4 py-6 md:px-8 xl:px-14">
      <div className="mx-auto grid max-w-4xl gap-5">
        <div className="flex gap-2">
          {props.showOpenSidebar ? (
            <Button
              className="md:hidden"
              variant="ghost"
              size="icon"
              onClick={props.onOpenSidebar}
              aria-label="Open agents"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          ) : null}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">Agents</p>
            <h1 className="text-2xl font-semibold">Agent profiles</h1>
            <p className="text-sm text-muted-foreground">Choose and manage reusable agent identities and defaults.</p>
          </div>
        </div>
        {props.selectedId && !props.profile ? (
          <Card className="p-5">
            <h2>{props.loaded && !props.loading ? 'Agent not found' : 'Loading agent'}</h2>
          </Card>
        ) : (
          <Card className="p-5">
            <div className="flex justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">
                  {props.profile ? props.profile.name : 'New organization agent'}
                </h2>
                {props.profile ? (
                  <p className="text-sm text-muted-foreground">
                    Source: {builtin ? 'Deputies built-in' : 'Organization managed'}
                  </p>
                ) : null}
                {isEffectiveDefault ? (
                  <p className="mt-1 flex items-center gap-1 text-xs font-medium text-primary">
                    <Check className="h-3.5 w-3.5" /> Tenant default
                  </p>
                ) : null}
              </div>
              {props.profile?.source === 'managed' && props.profile.revisionNumber ? (
                <RevisionSelector
                  currentRevisionId={props.profile.revision}
                  currentRevisionNumber={props.profile.revisionNumber}
                  selectedRevisionId={props.selectedRevisionId}
                  revisions={revisionViewer.revisions}
                  loading={revisionViewer.loading}
                  error={revisionViewer.error}
                  onSelectRevision={revisionViewer.selectRevision}
                />
              ) : null}
            </div>
            {builtin ? (
              <div
                className="mt-3 flex items-start gap-2.5 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm"
                role="note"
              >
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <p>
                  Built-in identity and instructions are code-defined. Default model and reasoning are configurable.
                </p>
              </div>
            ) : historical ? (
              <p className="mt-3 rounded-md border p-3 text-sm">
                Viewing revision {revisionViewer.viewedRevision?.revisionNumber}. This historical profile is read-only.
              </p>
            ) : props.profile?.archivedAt ? (
              <p className="mt-3 rounded-md border p-3 text-sm">This agent is archived. Restore it before editing.</p>
            ) : null}
            {configuredDefaultUnavailable && isEffectiveDefault ? (
              <div
                className="mt-3 flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                role="note"
              >
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                <p>The configured tenant default is unavailable, so this profile is being used as the fallback.</p>
              </div>
            ) : null}
            <form
              className="mt-5 grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Field label="Name">
                <Input
                  value={form.name}
                  disabled={!canEdit}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Field>
              <Field label="Description">
                <Input
                  value={form.description}
                  disabled={!canEdit}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </Field>
              <Field label="Instructions">
                <Textarea
                  className="min-h-64 font-mono"
                  value={form.instructions}
                  disabled={!canEdit}
                  onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Default model">
                  <OptionPicker
                    label="Default model"
                    value={form.defaultModel}
                    options={props.models}
                    emptyLabel="Inherit from session"
                    allowEmpty
                    onChange={(value) => setForm({ ...form, defaultModel: value })}
                    disabled={!canEdit && !canEditBuiltinSettings}
                  />
                </Field>
                <Field label="Default reasoning">
                  <OptionPicker
                    label="Default reasoning"
                    value={form.defaultReasoningLevel}
                    options={REASONING_LEVEL_OPTIONS}
                    emptyLabel="Inherit from session"
                    allowEmpty
                    onChange={(value) => setForm({ ...form, defaultReasoningLevel: value as ReasoningLevel | '' })}
                    disabled={!canEdit && !canEditBuiltinSettings}
                  />
                </Field>
              </div>
              <Field label="Invocation compatibility">
                <div className="flex flex-wrap gap-4">
                  {(['agent', 'subagent'] as const).map((mode) => (
                    <label key={mode} className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        disabled={!canEdit}
                        checked={form.supportedInvocations.includes(mode)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            supportedInvocations: e.target.checked
                              ? [...form.supportedInvocations, mode]
                              : form.supportedInvocations.filter((x) => x !== mode),
                          })
                        }
                      />
                      {mode}
                    </label>
                  ))}
                </div>
              </Field>
              <div className="flex flex-wrap gap-2">
                {canEdit || canEditBuiltinSettings ? (
                  <Button type="submit" disabled={!dirty || saving}>
                    <Save className="h-4 w-4" />
                    {builtin ? 'Save defaults' : props.profile ? 'Save agent' : 'Create agent'}
                  </Button>
                ) : null}
                {props.profile?.enabled &&
                props.profile.supportedInvocations.includes('agent') &&
                !props.profile.archivedAt ? (
                  <Button type="button" variant="secondary" onClick={() => props.onStartSession(props.profile!.id)}>
                    <Play className="h-4 w-4" />
                    Start session
                  </Button>
                ) : null}
                {props.profile &&
                props.canConfigureDefault &&
                canBeDefault &&
                props.profile.id !== props.defaultConfiguration?.configuredProfileId ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={saving || dirty}
                    onClick={() => void setTenantDefault(props.profile!.id)}
                  >
                    Set as tenant default
                  </Button>
                ) : null}
                {builtin ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!props.canManage || saving || dirty}
                    onClick={() => {
                      setSaving(true);
                      void updateBuiltinAgentProfileSettings({
                        profileId: props.profile!.id,
                        token: props.token,
                        enabled: !props.profile!.enabled,
                      })
                        .then(props.onChanged)
                        .catch(props.onError)
                        .finally(() => setSaving(false));
                    }}
                  >
                    {props.profile?.enabled ? 'Disable built-in' : 'Enable built-in'}
                  </Button>
                ) : null}
                {props.profile?.source === 'managed' ? (
                  props.profile.archivedAt ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={!props.canManage}
                      onClick={() => props.onRestore(props.profile!.id)}
                    >
                      <RotateCcw className="h-4 w-4" />
                      Restore agent
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={!props.canManage}
                      onClick={() => props.onArchive(props.profile!.id)}
                    >
                      <Archive className="h-4 w-4" />
                      Archive agent
                    </Button>
                  )
                ) : null}
              </div>
            </form>
          </Card>
        )}
      </div>
    </section>
  );
}
function Field(props: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{props.label}</p>
      {props.children}
    </div>
  );
}
