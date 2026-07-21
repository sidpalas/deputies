import { useEffect, useState, type ReactNode } from 'react';
import { Archive, PanelLeftOpen, RotateCcw, Save, Share2 } from 'lucide-react';
import {
  createSkill,
  listSkillRevisions,
  promoteSkill,
  updateSkill,
  type Group,
  type Skill,
  type SkillShareMode,
} from '../../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';
import { SharingGroupPicker } from './sharing-group-picker.js';
import { RevisionSelector, useRevisionViewer } from './revision-selector.js';
import { slugNameValidationError, UnsavedIndicator } from './shared.js';
import { useEditorDirty } from './use-editor-dirty.js';

type SkillForm = {
  id: string;
  ownerGroupId: string;
  name: string;
  description: string;
  body: string;
  autoLoad: boolean;
  enabled: boolean;
  shareMode: SkillShareMode;
  shareGroupIds: string[];
};

function loadRevisions(skillId: string, token: string) {
  return listSkillRevisions({ skillId, token });
}

export function SkillsPanel(props: {
  skill: Skill | null;
  selectedSkillId: string;
  selectedRevisionId: string;
  loaded: boolean;
  loading: boolean;
  readOnly?: boolean;
  token: string;
  groups: Group[];
  creatableGroups: Group[];
  showOpenSidebar: boolean;
  onOpenSidebar: () => void;
  onSkillChanged: (skill: Skill) => void;
  onSkillSaved: (skill: Skill) => void;
  onArchiveSkill: (skillId: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRestoreSkill: (skillId: string) => void;
  onSelectRevision: (revisionId: string) => void;
  onError: (error: unknown) => void;
}) {
  const [form, setForm] = useState<SkillForm>(emptySkillForm);
  const [saving, setSaving] = useState(false);
  const selected = props.skill;
  const revisionViewer = useRevisionViewer({
    resourceId: selected?.id ?? '',
    currentRevisionId: selected?.currentRevisionId,
    selectedRevisionId: props.selectedRevisionId,
    token: props.token,
    enabled: Boolean(selected?.canManage) && !props.readOnly,
    loadRevisions,
    onSelectRevision: props.onSelectRevision,
    onError: props.onError,
    suppressForbidden: true,
  });
  const viewedRevision = revisionViewer.viewedRevision;
  const displayed =
    selected && viewedRevision
      ? {
          ...selected,
          name: viewedRevision.name,
          description: viewedRevision.description,
          body: viewedRevision.body,
        }
      : selected;
  const selectedArchived = Boolean(selected?.archivedAt);
  const selectedGroupOwned = selected?.ownerKind === 'group';
  const groupOwned = Boolean(selectedGroupOwned || (!selected && form.ownerGroupId));
  const canEdit =
    !props.readOnly && (selected ? Boolean(selected.canManage) && !selectedArchived && !viewedRevision : true);
  const nameError = skillNameValidationError(form.name);
  const bodySizeBytes = new TextEncoder().encode(form.body).byteLength;
  const complete = Boolean(!nameError && form.name && form.description.trim() && bodySizeBytes <= 65_536);
  const baselineForm = displayed ? skillFormFromSkill(displayed) : emptySkillForm();
  const skillDirty = skillFieldsChanged(form, baselineForm);
  const sharingDirty = Boolean(groupOwned && sharingFieldsChanged(form, baselineForm));
  const dirty = skillDirty || sharingDirty;
  const sharingComplete = !groupOwned || form.shareMode !== 'specific' || form.shareGroupIds.length > 0;
  useEditorDirty(dirty, props.onDirtyChange);

  useEffect(() => {
    setForm(displayed ? skillFormFromSkill(displayed) : emptySkillForm());
  }, [displayed?.id, displayed?.archivedAt, displayed?.currentRevisionId, props.selectedSkillId, viewedRevision?.id]);

  async function save() {
    if (!canEdit || !complete || !sharingComplete || !dirty || saving) return;
    setSaving(true);
    try {
      const saved = form.id
        ? await updateSkill({
            skillId: form.id,
            token: props.token,
            name: form.name,
            description: form.description.trim(),
            body: form.body,
            autoLoad: form.autoLoad,
            enabled: form.enabled,
            ...(selectedGroupOwned && sharingDirty
              ? {
                  shareMode: form.shareMode,
                  ...(form.shareMode === 'specific' ? { groupIds: form.shareGroupIds } : {}),
                }
              : {}),
            ...(selected?.currentRevisionId ? { expectedCurrentRevisionId: selected.currentRevisionId } : {}),
          })
        : await createSkill({
            token: props.token,
            name: form.name,
            description: form.description.trim(),
            body: form.body,
            autoLoad: form.autoLoad,
            ...(form.ownerGroupId ? { ownerGroupId: form.ownerGroupId } : {}),
            ...(form.ownerGroupId
              ? {
                  shareMode: form.shareMode,
                  ...(form.shareMode === 'specific' ? { groupIds: form.shareGroupIds } : {}),
                }
              : {}),
          });
      props.onSkillSaved(saved);
      setForm(skillFormFromSkill(saved));
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function promote(groupId: string) {
    if (props.readOnly || !selected?.canManage || selectedGroupOwned || selectedArchived || !groupId || saving) return;
    const target = props.groups.find((group) => group.id === groupId);
    if (
      !window.confirm(
        `Move this skill to ${target?.name ?? 'this group'}? It will stop loading as a personal skill and cannot be moved back.`,
      )
    )
      return;
    setSaving(true);
    try {
      const saved = await promoteSkill({ skillId: selected.id, groupId, token: props.token });
      props.onSkillChanged(saved);
      setForm(skillFormFromSkill(saved));
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }

  function archiveSelectedSkill() {
    if (props.readOnly || !selected?.canManage || selected.archivedAt) return;
    if (dirty && !window.confirm('Discard unsaved changes and archive this skill?')) return;
    props.onArchiveSkill(selected.id);
  }

  return (
    <section className="h-full min-h-0 overflow-auto px-4 py-6 md:px-8 xl:px-14">
      <div className="mx-auto grid max-w-4xl gap-5">
        <div className="flex items-start gap-2">
          {props.showOpenSidebar ? (
            <Button
              className="mt-1 h-8 w-8 shrink-0 p-0 md:hidden"
              variant="ghost"
              size="icon"
              onClick={props.onOpenSidebar}
              aria-label="Open skills"
              title="Open skills"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          ) : null}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">Skills</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Agent skills</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage reusable instructions and choose whether they load automatically or only when invoked.
            </p>
          </div>
        </div>

        {props.selectedSkillId && !selected ? (
          <Card className="p-5">
            <h2 className="text-lg font-semibold">
              {!props.loaded || props.loading ? 'Loading skill' : 'Skill not found'}
            </h2>
          </Card>
        ) : (
          <>
            <Card className="p-5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
                <h2 className="min-w-0 text-lg font-semibold">{selected ? 'Edit skill' : 'New skill'}</h2>
                {selected ? (
                  <div className="flex shrink-0 items-center gap-2">
                    {dirty ? <UnsavedIndicator /> : null}
                    {!props.readOnly &&
                    selected.canManage &&
                    selected.currentRevisionId &&
                    selected.currentRevisionNumber ? (
                      <RevisionSelector
                        currentRevisionId={selected.currentRevisionId}
                        currentRevisionNumber={selected.currentRevisionNumber}
                        selectedRevisionId={props.selectedRevisionId}
                        revisions={revisionViewer.revisions}
                        loading={revisionViewer.loading}
                        error={revisionViewer.error}
                        onSelectRevision={revisionViewer.selectRevision}
                      />
                    ) : null}
                    {!viewedRevision && (props.readOnly || !selected.canManage) ? (
                      <span className="rounded border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
                        Read only
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <p className="col-span-2 text-sm text-muted-foreground">
                  A skill is one markdown document with a slug name and one-line description.
                </p>
              </div>
              {viewedRevision ? (
                <p className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                  Viewing revision {viewedRevision.revisionNumber}. This historical skill definition is read-only.
                </p>
              ) : revisionViewer.requestedRevisionMissing ? (
                <p className="mt-4 rounded-md border border-border bg-muted/60 p-3 text-sm text-muted-foreground">
                  The requested revision is unavailable. Showing the current definition.
                </p>
              ) : null}
              {selectedArchived ? (
                <p className="mt-4 rounded-md border border-border bg-muted/60 p-3 text-sm text-muted-foreground">
                  This skill is archived. Restore it before editing or sharing it.
                </p>
              ) : null}
              <form
                className="mt-5 grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                {!selected ? (
                  <Field label="Owner" htmlFor="skill-owner">
                    <select
                      id="skill-owner"
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={form.ownerGroupId}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          ownerGroupId: event.target.value,
                          ...(!event.target.value ? { shareMode: 'none' as const, shareGroupIds: [] } : {}),
                        })
                      }
                    >
                      <option value="">My personal skills</option>
                      {props.creatableGroups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <Field label="Name" htmlFor="skill-name" hint="Lowercase letters, numbers, and single hyphens; max 64.">
                  <Input
                    id="skill-name"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    placeholder="review-pull-request"
                    disabled={!canEdit}
                    aria-invalid={Boolean(nameError)}
                  />
                  {nameError ? <p className="mt-1 text-xs text-destructive">{nameError}</p> : null}
                </Field>
                <Field label="Description" htmlFor="skill-description" hint={`${form.description.length}/1024`}>
                  <Input
                    id="skill-description"
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                    maxLength={1024}
                    placeholder="Review a pull request for correctness and maintainability."
                    disabled={!canEdit}
                  />
                </Field>
                <Field
                  label="Markdown body"
                  htmlFor="skill-body"
                  hint={`${bodySizeBytes.toLocaleString()}/65,536 bytes`}
                >
                  <Textarea
                    id="skill-body"
                    className="min-h-80 font-mono text-sm"
                    value={form.body}
                    onChange={(event) => setForm({ ...form, body: event.target.value })}
                    disabled={!canEdit}
                    placeholder="# Instructions\n\nFollow these steps..."
                  />
                </Field>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.autoLoad}
                      onChange={(event) => setForm({ ...form, autoLoad: event.target.checked })}
                      disabled={!canEdit}
                    />
                    Load automatically
                  </label>
                  {selected ? (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.enabled}
                        onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                        disabled={!canEdit}
                      />
                      Enabled
                    </label>
                  ) : null}
                </div>
                {groupOwned && !viewedRevision ? (
                  <div className="rounded-md border border-border bg-muted/20 p-4">
                    <div className="flex items-center gap-2">
                      <Share2 className="h-4 w-4 text-primary" />
                      <h3 className="text-sm font-semibold text-foreground">Sharing</h3>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Sharing grants read and invocation access. It never grants edit access.
                    </p>
                    {!props.readOnly && (!selected || selected.canManage) ? (
                      <>
                        <fieldset className="mt-4 grid gap-2 text-sm" disabled={!canEdit}>
                          {(['none', 'specific', 'all_groups'] as const).map((mode) => (
                            <label key={mode} className="flex items-center gap-2">
                              <input
                                type="radio"
                                name="skill-share-mode"
                                checked={form.shareMode === mode}
                                onChange={() => setForm({ ...form, shareMode: mode })}
                              />
                              {shareModeLabel(mode)}
                            </label>
                          ))}
                        </fieldset>
                        {form.shareMode === 'specific' ? (
                          <div className="mt-3">
                            <SharingGroupPicker
                              groups={props.groups}
                              ownerGroupId={selected?.ownerGroupId ?? form.ownerGroupId}
                              selectedGroupIds={form.shareGroupIds}
                              disabled={!canEdit}
                              onSelectedGroupIdsChange={(shareGroupIds) => setForm({ ...form, shareGroupIds })}
                            />
                          </div>
                        ) : null}
                      </>
                    ) : (
                      selected && (
                        <p className="mt-4 text-sm text-foreground">{readOnlyShareModeSummary(selected.shareMode)}</p>
                      )
                    )}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={!canEdit || !complete || !sharingComplete || !dirty || saving}>
                    <Save className="h-4 w-4" /> {selected ? 'Save skill' : 'Create skill'}
                  </Button>
                  {selected ? (
                    selected.archivedAt ? (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => props.onRestoreSkill(selected.id)}
                        disabled={props.readOnly || !selected.canManage || dirty || saving}
                      >
                        <RotateCcw className="h-4 w-4" /> Restore skill
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        className="border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10"
                        onClick={archiveSelectedSkill}
                        disabled={props.readOnly || !selected.canManage || saving}
                      >
                        <Archive className="h-4 w-4" /> Archive skill
                      </Button>
                    )
                  ) : null}
                </div>
              </form>
            </Card>

            {selected &&
            !props.readOnly &&
            !viewedRevision &&
            !selectedArchived &&
            selected.canManage &&
            !selectedGroupOwned ? (
              <PromoteCard
                groups={props.creatableGroups}
                saving={saving || dirty}
                onPromote={(groupId) => void promote(groupId)}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function PromoteCard(props: { groups: Group[]; saving: boolean; onPromote: (groupId: string) => void }) {
  const [groupId, setGroupId] = useState('');
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Share2 className="h-4 w-4 text-primary" />
        <h2 className="text-lg font-semibold">Move to access group</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        This permanently moves the personal skill into the selected group. It cannot be moved back.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <select
          className="h-10 min-w-52 rounded-md border border-input bg-background px-3 text-sm"
          value={groupId}
          onChange={(event) => setGroupId(event.target.value)}
        >
          <option value="">Select group...</option>
          {props.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <Button variant="secondary" disabled={!groupId || props.saving} onClick={() => props.onPromote(groupId)}>
          Move skill
        </Button>
      </div>
    </Card>
  );
}

function Field(props: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label
        className="mb-1 flex justify-between gap-2 text-xs font-medium text-muted-foreground"
        htmlFor={props.htmlFor}
      >
        <span>{props.label}</span>
        {props.hint ? <span>{props.hint}</span> : null}
      </label>
      {props.children}
    </div>
  );
}

export function skillNameValidationError(name: string): string {
  return slugNameValidationError(name);
}

function emptySkillForm(): SkillForm {
  return {
    id: '',
    ownerGroupId: '',
    name: '',
    description: '',
    body: '',
    autoLoad: true,
    enabled: true,
    shareMode: 'none',
    shareGroupIds: [],
  };
}

function skillFormFromSkill(skill: Skill): SkillForm {
  return {
    id: skill.id,
    ownerGroupId: skill.ownerGroupId ?? '',
    name: skill.name,
    description: skill.description,
    body: skill.body ?? '',
    autoLoad: skill.autoLoad,
    enabled: skill.enabled,
    shareMode: skill.shareMode,
    shareGroupIds: skill.shareGroupIds ?? [],
  };
}

function skillFieldsChanged(form: SkillForm, baseline: SkillForm): boolean {
  return (
    form.ownerGroupId !== baseline.ownerGroupId ||
    form.name !== baseline.name ||
    form.description !== baseline.description ||
    form.body !== baseline.body ||
    form.autoLoad !== baseline.autoLoad ||
    form.enabled !== baseline.enabled
  );
}

function sharingFieldsChanged(form: SkillForm, baseline: SkillForm): boolean {
  return (
    form.shareMode !== baseline.shareMode ||
    [...form.shareGroupIds].sort().join('\0') !== [...baseline.shareGroupIds].sort().join('\0')
  );
}

function shareModeLabel(mode: SkillShareMode): string {
  if (mode === 'all_groups') return 'All groups';
  if (mode === 'specific') return 'Specific groups';
  return 'Owner group only';
}

function readOnlyShareModeSummary(mode: SkillShareMode): string {
  if (mode === 'specific') return 'Shared with specific groups.';
  if (mode === 'all_groups') return 'Shared with all groups.';
  return 'Available only to the owner group.';
}
