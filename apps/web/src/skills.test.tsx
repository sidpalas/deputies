import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Group, Skill } from './api.js';
import { MessageComposer } from './components/app-panels/message-composer.js';
import { NewThreadPanel } from './components/app-panels/new-thread-panel.js';
import { prepareSkillSubmission, useSkillInvocationDraft } from './components/app-panels/skill-invocation-draft.js';
import { SkillPicker } from './components/app-panels/skill-picker.js';
import { SkillsPanel } from './components/app-panels/skills-panel.js';
import { SkillsSidebar } from './components/app-panels/skills-sidebar.js';
import { ChatPanel } from './components/thread/thread-content.js';
import {
  MessageSkillChips,
  parsePersistedMessageSkillInvocations,
} from './components/thread/content/message-skill-chips.js';

const skill: Skill = {
  id: 'skill-1',
  name: 'review-change',
  description: 'Review a change carefully.',
  body: '# Review',
  ownerKind: 'user',
  autoLoad: false,
  enabled: true,
  shareMode: 'none',
  source: 'personal',
  provenance: { kind: 'personal' },
  canManage: true,
  createdAt: '2026-07-15T10:00:00.000Z',
  updatedAt: '2026-07-15T10:00:00.000Z',
};

const revisionedSkill: Skill = {
  ...skill,
  currentRevisionId: 'revision-2',
  currentRevisionNumber: 2,
};

const group: Group = {
  id: 'group-1',
  name: 'Platform',
  defaultVisibility: 'organization',
  defaultWritePolicy: 'group_members',
  automationCreateRequiredRole: 'member',
  membershipRole: 'admin',
  canCreateSessions: true,
  canCreateAutomations: true,
  canManage: true,
  createdAt: '2026-07-15T10:00:00.000Z',
  updatedAt: '2026-07-15T10:00:00.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

it('opens the picker from a slash at position zero and supports chip removal', () => {
  function Harness() {
    const [prompt, setPrompt] = useState('/rev');
    const draft = useSkillInvocationDraft({ available: [skill], enabled: true, prompt, onPromptChange: setPrompt });
    return (
      <SkillPicker
        availableCount={1}
        selected={draft.selectedSkills}
        options={draft.options}
        open={draft.pickerOpen}
        onRemoveSkill={draft.removeSkill}
        onSelectSkill={draft.selectSkill}
      />
    );
  }

  render(<Harness />);
  const list = screen.getByRole('listbox', { name: 'Available skills' });
  expect(list.parentElement).not.toHaveClass('absolute');
  expect(list).toHaveClass('h-[clamp(8rem,35dvh,16rem)]', 'overflow-auto');
  const firstOption = screen.getByRole('option', { name: /review-change/i });
  expect(firstOption).toHaveClass('bg-accent');
  expect(firstOption).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(firstOption);
  expect(screen.getByText('review-change')).toHaveClass('truncate');
  fireEvent.click(screen.getByRole('button', { name: 'Remove review-change skill' }));
  expect(screen.queryByText('review-change')).not.toBeInTheDocument();
});

it('selects the first slash match on Enter without sending the message', () => {
  const onSubmit = vi.fn(async () => true);
  render(<MessageComposer {...messageComposerProps(onSubmit)} />);

  const textarea = screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(textarea, { target: { value: '/rev' } });
  fireEvent.keyDown(textarea, { key: 'Enter' });

  expect(onSubmit).not.toHaveBeenCalled();
  expect(textarea).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Remove review-change skill' })).toBeInTheDocument();
});

it('navigates slash matches with the keyboard before selecting', () => {
  const secondSkill = { ...skill, id: 'skill-2', name: 'review-security', description: 'Review security.' };
  const onSubmit = vi.fn(async () => true);
  render(<MessageComposer {...messageComposerProps(onSubmit)} skills={[skill, secondSkill]} />);

  const textarea = screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(textarea, { target: { value: '/rev' } });
  fireEvent.keyDown(textarea, { key: 'ArrowDown' });

  expect(screen.getByRole('option', { name: /review-security/i })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(textarea, { key: 'Enter' });

  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Remove review-security skill' })).toBeInTheDocument();
});

it('submits selected skills without requiring additional text', async () => {
  const onSubmit = vi.fn(async () => true);
  render(<MessageComposer {...messageComposerProps(onSubmit)} />);

  const textarea = screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(textarea, { target: { value: '/rev' } });
  fireEvent.keyDown(textarea, { key: 'Enter' });
  fireEvent.keyDown(textarea, { key: 'Enter' });

  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      prompt: '',
      skills: ['review-change'],
      skillRefs: [{ id: 'skill-1', name: 'review-change', revisionId: 'revision-2' }],
    }),
  );
});

it('pins a managed selection while leaving repository selections revisionless', async () => {
  const repositorySkill = {
    ...skill,
    id: 'repo:acme/widgets:repo-review',
    name: 'repo-review',
    source: 'repo' as const,
    provenance: { kind: 'repo' as const, repo: 'acme/widgets' },
  };
  const onSubmit = vi.fn(async () => true);
  render(<MessageComposer {...messageComposerProps(onSubmit)} skills={[revisionedSkill, repositorySkill]} />);

  const textarea = screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(textarea, { target: { value: '/rev' } });
  fireEvent.keyDown(textarea, { key: 'Enter' });
  fireEvent.change(textarea, { target: { value: '/repo' } });
  fireEvent.keyDown(textarea, { key: 'Enter' });
  fireEvent.keyDown(textarea, { key: 'Enter' });

  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      prompt: '',
      skills: ['review-change', 'repo-review'],
      skillRefs: [
        { id: 'skill-1', name: 'review-change', revisionId: 'revision-2' },
        { id: 'repo:acme/widgets:repo-review', name: 'repo-review' },
      ],
    }),
  );
});

it('pins the managed revision from the new-thread composer', async () => {
  const onSubmit = vi.fn(async () => true);
  function Harness() {
    const [prompt, setPrompt] = useState('/rev');
    return (
      <NewThreadPanel
        {...newThreadPanelProps([revisionedSkill], onSubmit)}
        prompt={prompt}
        onPromptChange={setPrompt}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('option', { name: /review-change/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      prompt: '',
      skills: ['review-change'],
      skillRefs: [{ id: 'skill-1', name: 'review-change', revisionId: 'revision-2' }],
    }),
  );
});

it('only applies exact leading slash fallbacks and caps invocations at eight', () => {
  const eightSkills = Array.from({ length: 8 }, (_, index) => ({
    ...skill,
    id: `skill-${index + 1}`,
    name: index === 0 ? skill.name : `skill-${index + 1}`,
  }));
  expect(prepareSkillSubmission('/review-change inspect this', [], [skill])).toEqual({
    prompt: 'inspect this',
    skills: [skill],
  });
  expect(prepareSkillSubmission(' /review-change inspect this', [], [skill])).toEqual({
    prompt: ' /review-change inspect this',
    skills: [],
  });
  expect(prepareSkillSubmission('/review inspect this', [], [skill]).skills).toEqual([]);
  expect(prepareSkillSubmission('/review-change inspect this', eightSkills, eightSkills).skills).toHaveLength(8);
});

it('drops a stale selected skill instead of substituting an available skill with the same name', () => {
  const replacement = { ...skill, id: 'skill-2', ownerKind: 'group' as const, ownerGroupId: 'group-2' };

  expect(prepareSkillSubmission('inspect this', [skill], [replacement])).toEqual({
    prompt: 'inspect this',
    skills: [],
  });
});

it('does not submit an empty new thread after the selected catalog entry disappears', async () => {
  const replacement = { ...skill, id: 'skill-2', ownerKind: 'group' as const, ownerGroupId: 'group-2' };
  const onSubmit = vi.fn(async () => true);

  function Harness(props: { skills: Skill[] }) {
    const [prompt, setPrompt] = useState('/rev');
    return (
      <NewThreadPanel {...newThreadPanelProps(props.skills, onSubmit)} prompt={prompt} onPromptChange={setPrompt} />
    );
  }

  const view = render(<Harness skills={[skill]} />);
  fireEvent.click(screen.getByRole('option', { name: /review-change/i }));
  view.rerender(<Harness skills={[replacement]} />);

  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Remove review-change skill' })).not.toBeInTheDocument(),
  );
  fireEvent.submit(screen.getByRole('button', { name: 'Start session' }).closest('form')!);
  expect(onSubmit).not.toHaveBeenCalled();
});

it('removes selected chips when the available skill identity changes', async () => {
  const replacement = {
    ...skill,
    id: 'skill-2',
    description: 'Replacement from another group.',
    ownerKind: 'group' as const,
    ownerGroupId: 'group-2',
    source: 'group' as const,
  };

  function Harness(props: { available: Skill[] }) {
    const [prompt, setPrompt] = useState('/rev');
    const draft = useSkillInvocationDraft({
      available: props.available,
      enabled: true,
      prompt,
      onPromptChange: setPrompt,
    });
    return (
      <SkillPicker
        availableCount={props.available.length}
        selected={draft.selectedSkills}
        options={draft.options}
        open={draft.pickerOpen}
        onRemoveSkill={draft.removeSkill}
        onSelectSkill={draft.selectSkill}
      />
    );
  }

  const view = render(<Harness available={[skill]} />);
  fireEvent.click(screen.getByRole('option', { name: /review-change/i }));
  expect(screen.getByRole('button', { name: 'Remove review-change skill' })).toBeInTheDocument();

  view.rerender(<Harness available={[replacement]} />);

  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Remove review-change skill' })).not.toBeInTheDocument(),
  );
});

it('retains the pinned managed revision when the catalog refreshes to a newer definition', async () => {
  function Harness() {
    const [available, setAvailable] = useState([revisionedSkill]);
    const [prompt, setPrompt] = useState('/rev');
    const draft = useSkillInvocationDraft({ available, enabled: true, prompt, onPromptChange: setPrompt });
    return (
      <>
        <button
          type="button"
          onClick={() =>
            setAvailable([
              {
                ...revisionedSkill,
                name: 'review-change-updated',
                currentRevisionId: 'revision-3',
                currentRevisionNumber: 3,
              },
            ])
          }
        >
          Refresh catalog
        </button>
        <span data-testid="pinned-revision">{draft.selectedSkills[0]?.currentRevisionId}</span>
        <SkillPicker
          availableCount={available.length}
          selected={draft.selectedSkills}
          options={draft.options}
          open={draft.pickerOpen}
          onRemoveSkill={draft.removeSkill}
          onSelectSkill={draft.selectSkill}
        />
      </>
    );
  }

  render(<Harness />);
  fireEvent.click(screen.getByRole('option', { name: /review-change/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' }));

  await waitFor(() => expect(screen.getByTestId('pinned-revision')).toHaveTextContent('revision-2'));
  expect(screen.getByRole('button', { name: 'Remove review-change skill' })).toBeInTheDocument();
});

it('shows every available candidate for a duplicate name with provenance', () => {
  render(
    <SkillPicker
      availableCount={2}
      options={[
        {
          ...skill,
          description: 'Managed skill takes precedence.',
          ownerKind: 'group',
          ownerGroupId: 'group-1',
          ownerGroupName: 'Platform',
          source: 'group',
          provenance: { kind: 'group', ownerGroupId: 'group-1', ownerGroupName: 'Platform' },
        },
        {
          ...skill,
          id: 'repo:owner/repo:review-change',
          description: 'Repository duplicate.',
          source: 'repo',
          repo: 'owner/repo',
          provenance: { kind: 'repo', repo: 'owner/repo' },
        },
      ]}
      selected={[]}
      open
      onRemoveSkill={() => undefined}
      onSelectSkill={() => undefined}
    />,
  );

  expect(screen.getAllByRole('option', { name: /review-change/i })).toHaveLength(2);
  expect(screen.getByText('Managed skill takes precedence.')).toBeInTheDocument();
  expect(screen.getByText('group · Platform')).toBeInTheDocument();
  expect(screen.getByText('Repository duplicate.')).toBeInTheDocument();
  expect(screen.getByText('owner/repo')).toBeInTheDocument();
});

it('allows selecting distinct same-name candidates by identity', () => {
  const repositorySkill = {
    ...skill,
    id: 'repo:owner/repo:review-change',
    description: 'Repository duplicate.',
    source: 'repo' as const,
    repo: 'owner/repo',
    provenance: { kind: 'repo' as const, repo: 'owner/repo' },
  };

  function Harness() {
    const [prompt, setPrompt] = useState('/rev');
    const draft = useSkillInvocationDraft({
      available: [skill, repositorySkill],
      enabled: true,
      prompt,
      onPromptChange: setPrompt,
    });
    return (
      <>
        <button type="button" onClick={() => setPrompt('/rev')}>
          Open skills
        </button>
        <SkillPicker
          availableCount={2}
          selected={draft.selectedSkills}
          options={draft.options}
          open={draft.pickerOpen}
          onRemoveSkill={draft.removeSkill}
          onSelectSkill={draft.selectSkill}
        />
      </>
    );
  }

  render(<Harness />);
  fireEvent.click(screen.getByText('Review a change carefully.').closest('button')!);
  fireEvent.click(screen.getByRole('button', { name: 'Open skills' }));
  fireEvent.click(screen.getByText('Repository duplicate.').closest('button')!);

  expect(screen.getAllByText('review-change')).toHaveLength(2);
  expect(screen.getByText('personal')).toBeInTheDocument();
  expect(screen.getByText('owner/repo')).toBeInTheDocument();
});

it('restores composer text and chips after a failed send', async () => {
  const onSubmit = vi.fn(async () => false);
  render(<MessageComposer {...messageComposerProps(onSubmit)} />);

  const composer = screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: '/review-change inspect this' } });
  fireEvent.keyDown(composer, { key: 'Enter' });

  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      prompt: 'inspect this',
      skills: ['review-change'],
      skillRefs: [{ id: 'skill-1', name: 'review-change', revisionId: 'revision-2' }],
    }),
  );
  expect(screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...')).toHaveValue(
    '/review-change inspect this',
  );
});

it('renders selected skills inside the composer input surface', () => {
  render(<MessageComposer {...messageComposerProps(vi.fn(async () => true))} />);

  const textarea = screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(textarea, { target: { value: '/rev' } });
  expect(textarea).toHaveClass('min-h-12');
  fireEvent.click(screen.getByRole('option', { name: /review-change/i }));

  const chip = screen.getByRole('button', { name: 'Remove review-change skill' });
  expect(chip.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('renders sent skill chips and keeps skill load and invocation details in activity', () => {
  const onOpenSkill = vi.fn();
  render(
    <ChatPanel
      activeProgress={{}}
      artifacts={[]}
      canWriteSession
      services={[]}
      canRetryMessages
      editingMessageId=""
      events={[
        {
          sessionId: 'session-1',
          sequence: 2,
          type: 'skills_loaded',
          messageId: 'message-1',
          runId: 'run-1',
          createdAt: '2026-07-15T10:01:00.000Z',
          payload: {
            skills: [{ name: 'review-change', source: 'personal' }],
            shadowed: [
              { name: 'group-review', source: 'shared', ownerGroupId: 'group-2', ownerGroupName: 'Product' },
              { name: 'repo-review', source: 'repo', repo: 'acme/widgets' },
            ],
            diagnostics: ['One repo skill could not be read.'],
          },
        },
        {
          sessionId: 'session-1',
          sequence: 3,
          type: 'skill_invoked',
          messageId: 'message-1',
          runId: 'run-1',
          createdAt: '2026-07-15T10:01:01.000Z',
          payload: {
            name: 'review-change',
            source: 'personal',
            trigger: 'user',
            ref: 'skill-1',
            filePath: '/workspace/.deputies-skills/personal/skill-1/review-change/SKILL.md',
          },
        },
        {
          sessionId: 'session-1',
          sequence: 4,
          type: 'skill_invoked',
          messageId: 'message-1',
          runId: 'run-1',
          createdAt: '2026-07-15T10:01:02.000Z',
          payload: {
            name: 'review-change',
            source: 'personal',
            trigger: 'model',
            ref: 'skill-1',
            filePath: '/workspace/.deputies-skills/personal/skill-1/review-change/SKILL.md',
          },
        },
      ]}
      messageDraft=""
      messages={[
        {
          id: 'message-1',
          sessionId: 'session-1',
          sequence: 1,
          status: 'completed',
          prompt: 'Inspect this',
          context: {
            skills: ['review-change'],
            skillRefs: [{ id: 'skill-1', name: 'review-change', revisionId: 'revision-1' }],
          },
          createdAt: '2026-07-15T10:00:00.000Z',
        },
      ]}
      onCancelEdit={() => undefined}
      onCancelQueuedMessage={() => undefined}
      onCancelRun={() => undefined}
      onEditMessage={() => undefined}
      onMessageDraftChange={() => undefined}
      openableManagedSkillIds={new Set(['skill-1'])}
      onOpenSkill={onOpenSkill}
      onRetryFailedMessages={() => undefined}
      onSaveEdit={() => undefined}
      onExtendSandbox={() => undefined}
      onLoadArtifactPreview={async () => ({ text: '', contentType: 'text/plain', truncated: false, sizeBytes: 0 })}
    />,
  );

  expect(screen.getByLabelText('Invoked skills')).toHaveTextContent('review-change');
  fireEvent.click(screen.getByRole('button', { name: 'Open invoked review-change skill revision' }));
  expect(onOpenSkill).toHaveBeenCalledWith('skill-1', 'revision-1');
  expect(screen.queryByText('Skills loaded')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Activity · 3 events'));
  expect(screen.getByText('Skills loaded')).toBeInTheDocument();
  expect(screen.getByText('User invoked review-change')).toBeInTheDocument();
  expect(screen.getByText('Model invoked review-change')).toBeInTheDocument();
  expect(screen.getAllByText(/Definition: \/workspace\/\.deputies-skills/)).toHaveLength(2);
  expect(screen.getByText(/Loaded: review-change/)).toBeInTheDocument();
  expect(screen.getByText(/Shadowed: group-review \(Product\), repo-review \(acme\/widgets\)/)).toBeInTheDocument();
});

it('keeps persisted skill refs aligned with their original skill positions', () => {
  expect(
    parsePersistedMessageSkillInvocations({
      context: {
        skills: [null, 'review-change'],
        skillRefs: [
          { id: 'wrong-position', name: 'review-change' },
          { id: 'skill-1', name: 'review-change', revisionId: 'revision-1' },
        ],
      },
    }),
  ).toEqual([{ name: 'review-change', managedSkillId: 'skill-1', revisionId: 'revision-1' }]);
});

it('renders an inaccessible managed skill invocation as non-openable', () => {
  const onOpenSkill = vi.fn();
  render(
    <MessageSkillChips
      message={{
        context: {
          skills: ['review-change'],
          skillRefs: [{ id: 'skill-1', name: 'review-change', revisionId: 'revision-1' }],
        },
      }}
      onOpenSkill={onOpenSkill}
    />,
  );

  expect(screen.queryByRole('button', { name: 'Open invoked review-change skill revision' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Invoked skills')).toHaveTextContent('review-change');
});

it('keeps repository and legacy managed skill chips non-linking', () => {
  render(
    <MessageSkillChips
      message={{
        context: {
          skills: ['repo-review', 'legacy-review'],
          skillRefs: [
            { id: 'repo:acme/widgets:repo-review', name: 'repo-review' },
            { id: 'skill-legacy', name: 'legacy-review' },
          ],
        },
      }}
      openableManagedSkillIds={new Set(['skill-legacy'])}
      onOpenSkill={() => undefined}
    />,
  );

  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.getByLabelText('Invoked skills')).toHaveTextContent('repo-review');
  expect(screen.getByLabelText('Invoked skills')).toHaveTextContent('legacy-review');
  expect(
    screen.getByTitle(
      'Repository skill from acme/widgets. It is not clickable because repository skills do not have a managed skill page.',
    ),
  ).toHaveTextContent('repo-review');
});

it('opens an invoked historical revision and returns to the current definition', async () => {
  window.history.replaceState({}, '', '/?skill=skill-1&revision=revision-1');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      revisions: [
        {
          id: 'revision-2',
          skillId: 'skill-1',
          revisionNumber: 2,
          name: 'review-change',
          description: 'Current definition.',
          body: '# Current',
          actorType: 'user',
          createdAt: '2026-07-16T10:00:00.000Z',
        },
        {
          id: 'revision-1',
          skillId: 'skill-1',
          revisionNumber: 1,
          name: 'review-change-old',
          description: 'Invoked definition.',
          body: '# Invoked',
          actorType: 'user',
          createdAt: '2026-07-15T10:00:00.000Z',
        },
      ],
    }),
  );
  function Harness() {
    const [selectedRevisionId, setSelectedRevisionId] = useState('revision-1');
    return (
      <SkillsPanel
        {...skillsPanelProps(revisionedSkill, () => undefined)}
        selectedRevisionId={selectedRevisionId}
        onSelectRevision={(revisionId) => {
          const url = new URL(window.location.href);
          if (revisionId) url.searchParams.set('revision', revisionId);
          else url.searchParams.delete('revision');
          window.history.replaceState({}, '', url);
          setSelectedRevisionId(revisionId);
        }}
      />
    );
  }
  render(<Harness />);

  expect(await screen.findByText(/Viewing revision 1.*historical skill definition is read-only/i)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue('review-change-old'));
  expect(screen.getByLabelText(/^Markdown body/)).toHaveValue('# Invoked');
  expect(screen.getByLabelText(/^Name/)).toBeDisabled();

  fireEvent.click(screen.getByLabelText('Revision'));
  fireEvent.click(screen.getByTitle('Revision 2'));

  await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue('review-change'));
  expect(screen.getByLabelText('Revision')).toHaveTextContent('Revision 2');
  expect(new URLSearchParams(window.location.search).has('revision')).toBe(false);
});

it('shows a read-only current body without requesting revision history', () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  render(
    <SkillsPanel
      {...skillsPanelProps({ ...revisionedSkill, canManage: false, body: '# Shared body' }, () => undefined)}
      selectedRevisionId="revision-1"
    />,
  );

  expect(screen.getByLabelText(/^Markdown body/)).toHaveValue('# Shared body');
  expect(screen.getByLabelText(/^Markdown body/)).toBeDisabled();
  expect(screen.queryByRole('heading', { name: 'Revision history' })).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('contains a revision-history 403 instead of escalating it to the app error handler', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ error: 'forbidden', message: 'Skill management access is required' }, 403),
  );
  const onError = vi.fn();
  render(<SkillsPanel {...skillsPanelProps(revisionedSkill, () => undefined)} onError={onError} />);

  await waitFor(() => expect(screen.getByText('Revision history is unavailable.')).toBeInTheDocument());
  expect(onError).not.toHaveBeenCalled();
});

it('creates a managed skill and moves a personal skill with confirmation', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (path === '/skills') return jsonResponse({ skill: { ...skill, ...body } }, 201);
    if (path === '/skills/skill-1/promote') {
      return jsonResponse({ skill: { ...skill, ownerKind: 'group', ownerGroupId: body.groupId, source: 'group' } });
    }
    return jsonResponse({}, 404);
  });
  const onSaved = vi.fn();
  const panel = render(<SkillsPanel {...skillsPanelProps(null, onSaved)} />);
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'test-skill' } });
  fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Test the implementation.' } });
  fireEvent.change(screen.getByLabelText(/^Markdown body/), { target: { value: '# Test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
    name: 'test-skill',
    description: 'Test the implementation.',
    body: '# Test',
    autoLoad: true,
  });

  panel.rerender(<SkillsPanel {...skillsPanelProps(skill, onSaved)} />);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const promoteSelect = await screen.findByRole('combobox');
  fireEvent.change(promoteSelect, { target: { value: group.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Move skill' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(window.confirm).toHaveBeenCalledWith(
    'Move this skill to Platform? It will stop loading as a personal skill and cannot be moved back.',
  );
  expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({ groupId: group.id });
});

it('includes sharing in the create form only for group-owned skills', async () => {
  const onSaved = vi.fn();
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      skill: {
        ...skill,
        ownerKind: 'group',
        ownerGroupId: group.id,
        source: 'group',
        shareMode: 'all_groups',
      },
    }),
  );
  render(<SkillsPanel {...skillsPanelProps(null, onSaved)} />);

  expect(screen.queryByRole('heading', { name: 'Sharing' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Owner'), { target: { value: group.id } });
  expect(screen.getByRole('heading', { name: 'Sharing' })).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('All groups'));
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'shared-skill' } });
  fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Share this skill.' } });
  fireEvent.change(screen.getByLabelText(/^Markdown body/), { target: { value: '# Shared' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
    ownerGroupId: group.id,
    shareMode: 'all_groups',
  });
});

it('saves group sharing with the skill and keeps shared-in skills read only', async () => {
  const groupSkill: Skill = {
    ...skill,
    ownerKind: 'group',
    ownerGroupId: group.id,
    source: 'group',
    shareMode: 'none',
  };
  const onSaved = vi.fn();
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ skill: { ...groupSkill, ...body } });
  });
  const panel = render(<SkillsPanel {...skillsPanelProps(groupSkill, onSaved)} />);

  fireEvent.click(screen.getByLabelText('Specific groups'));
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Platform (owner)' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Platform (owner)' })).toBeDisabled();
  expect(screen.getByText('1 selected')).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText('All groups'));
  fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({ shareMode: 'all_groups' });

  panel.rerender(
    <SkillsPanel
      {...skillsPanelProps(
        { ...groupSkill, source: 'shared', shareMode: 'specific', canManage: false },
        () => undefined,
      )}
    />,
  );
  expect(await screen.findByText('Read only')).toBeInTheDocument();
  expect(screen.getByLabelText(/^Name/)).toBeDisabled();
  expect(screen.getByText('Shared with specific groups.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save skill' })).toBeDisabled();
});

it('retains an inaccessible existing share when adding a visible group', async () => {
  const inaccessibleGroupId = 'inaccessible-group';
  const visibleTarget = { ...group, id: 'group-2', name: 'Product' };
  const groupSkill: Skill = {
    ...skill,
    ownerKind: 'group',
    ownerGroupId: group.id,
    source: 'group',
    shareMode: 'specific',
    shareGroupIds: [inaccessibleGroupId],
  };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      skill: { ...groupSkill, shareGroupIds: [inaccessibleGroupId, visibleTarget.id] },
    }),
  );
  render(<SkillsPanel {...skillsPanelProps(groupSkill, () => undefined)} groups={[group, visibleTarget]} />);

  expect(screen.getByRole('checkbox', { name: /Unavailable group/ })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Product' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
    shareMode: 'specific',
    groupIds: [inaccessibleGroupId, visibleTarget.id],
  });
});

it('validates and counts skill bodies using UTF-8 bytes', () => {
  render(<SkillsPanel {...skillsPanelProps(null, () => undefined)} />);
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'utf8-skill' } });
  fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Uses a multibyte body.' } });
  fireEvent.change(screen.getByLabelText(/^Markdown body/), { target: { value: '😀'.repeat(16_385) } });

  expect(screen.getByText('65,540/65,536 bytes')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create skill' })).toBeDisabled();
});

it('confirms before archiving a skill with unsaved changes', () => {
  const onArchiveSkill = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<SkillsPanel {...skillsPanelProps(skill, () => undefined)} onArchiveSkill={onArchiveSkill} />);

  fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Unsaved edit.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Archive skill' }));

  expect(confirm).toHaveBeenCalledWith('Discard unsaved changes and archive this skill?');
  expect(onArchiveSkill).not.toHaveBeenCalled();
});

it('resets discarded edits when an archived skill response arrives so restore stays available', async () => {
  const panel = render(<SkillsPanel {...skillsPanelProps(skill, () => undefined)} />);

  fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Unsaved edit.' } });
  panel.rerender(
    <SkillsPanel {...skillsPanelProps({ ...skill, archivedAt: '2026-07-16T10:00:00.000Z' }, () => undefined)} />,
  );

  await waitFor(() => expect(screen.getByLabelText(/^Description/)).toHaveValue(skill.description));
  expect(screen.getByRole('button', { name: 'Restore skill' })).toBeEnabled();
});

it('shows the inline sidebar control only below the desktop breakpoint', () => {
  render(<SkillsPanel {...skillsPanelProps(null, () => undefined)} showOpenSidebar />);

  expect(screen.getByRole('button', { name: 'Open skills' })).toHaveClass('md:hidden');
});

it('separates archived skills into a collapsible sidebar section', () => {
  const onArchiveSkill = vi.fn();
  const onRestoreSkill = vi.fn();
  const archived = {
    ...skill,
    id: 'skill-archived',
    name: 'old-review',
    archivedAt: '2026-07-16T10:00:00.000Z',
  };
  render(
    <SkillsSidebar
      canCallApi
      canCreateSkills
      footerProps={{
        authRequired: true,
        canViewGroups: true,
        canViewAutomations: true,
        canViewEnvironments: true,
        canViewSkills: true,
        canViewSetup: true,
        health: null,
        navPage: 'skills',
        themePreference: 'system',
        token: '',
        onOpenGroups: () => undefined,
        onOpenAutomations: () => undefined,
        onOpenEnvironments: () => undefined,
        onOpenSkills: () => undefined,
        onOpenSessions: () => undefined,
        onOpenSetup: () => undefined,
        onSignOut: () => undefined,
        onThemeChange: () => undefined,
      }}
      groups={[group]}
      loading={false}
      skills={[skill, archived]}
      selectedSkillId=""
      onBackToSessions={() => undefined}
      onArchiveSkill={onArchiveSkill}
      onCollapse={() => undefined}
      onCreateSkill={() => undefined}
      onRestoreSkill={onRestoreSkill}
      onSelectSkill={() => undefined}
    />,
  );

  expect(screen.getByText('Archived · 1')).toBeInTheDocument();
  expect(screen.getByText('review-change')).toBeVisible();
  expect(screen.getByLabelText('Manual invocation only')).toBeInTheDocument();
  const archiveButton = screen.getByRole('button', { name: 'Archive review-change skill' });
  expect(archiveButton).toHaveClass('absolute', 'top-0.5');
  fireEvent.click(archiveButton);
  expect(onArchiveSkill).toHaveBeenCalledWith(skill.id);
  expect(screen.getByText('old-review')).not.toBeVisible();
  fireEvent.click(screen.getByText('Archived · 1'));
  expect(screen.getByText('old-review')).toBeVisible();
  expect(screen.queryByLabelText('Archived')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Restore old-review skill' }));
  expect(onRestoreSkill).toHaveBeenCalledWith(archived.id);
});

function messageComposerProps(onSubmit: (input: { prompt: string; skills: string[] }) => Promise<boolean>) {
  return {
    archived: false,
    readOnly: false,
    environmentId: '',
    environmentBranchOverrides: {},
    environmentOptions: [],
    environmentOptionsLoading: false,
    environmentOptionsError: '',
    repository: '',
    inheritedEnvironment: null,
    inheritedCodebaseLabel: '',
    inheritedRepository: '',
    repositoryOptions: [],
    repositoryOptionsLoading: false,
    repositoryOptionsError: '',
    branch: '',
    inheritedBranch: '',
    branchOptions: [],
    branchOptionsLoading: false,
    branchOptionsError: '',
    model: '',
    inheritedModel: '',
    modelChoices: [],
    modelUnavailableReason: '',
    reasoningLevel: '' as const,
    inheritedReasoningLevel: '' as const,
    defaultReasoningLevel: '' as const,
    skills: [revisionedSkill],
    skillsEnabled: true,
    onCodebaseChange: () => undefined,
    onEnvironmentBranchOverridesChange: () => undefined,
    onEnvironmentRepositoryBranchesLoad: async () => [],
    onBranchChange: () => undefined,
    onModelChange: () => undefined,
    onReasoningLevelChange: () => undefined,
    onFocusChange: () => undefined,
    onSubmit,
  };
}

function newThreadPanelProps(
  skills: Skill[],
  onSubmit: (input: { prompt: string; skills: string[] }) => Promise<boolean>,
) {
  return {
    canCallApi: true,
    readOnly: false,
    loading: false,
    groupId: group.id,
    groups: [group],
    prompt: 'Inspect this',
    environmentId: '',
    environmentBranchOverrides: {},
    environmentOptions: [],
    environmentOptionsLoading: false,
    environmentOptionsError: '',
    repository: '',
    repositoryOptions: [],
    repositoryOptionsLoading: false,
    repositoryOptionsError: '',
    branch: '',
    branchOptions: [],
    branchOptionsLoading: false,
    branchOptionsError: '',
    model: '',
    modelChoices: [],
    modelUnavailableReason: '',
    reasoningLevel: '' as const,
    defaultReasoningLevel: '' as const,
    skills,
    skillsEnabled: true,
    showOpenSidebar: false,
    onOpenSidebar: () => undefined,
    onGroupChange: () => undefined,
    onPromptChange: () => undefined,
    onCodebaseChange: () => undefined,
    onEnvironmentBranchOverridesChange: () => undefined,
    onEnvironmentRepositoryBranchesLoad: async () => [],
    onBranchChange: () => undefined,
    onModelChange: () => undefined,
    onReasoningLevelChange: () => undefined,
    onSubmit,
  };
}

function skillsPanelProps(selected: Skill | null, onSkillSaved: (saved: Skill) => void) {
  return {
    skill: selected,
    selectedSkillId: selected?.id ?? '',
    selectedRevisionId: new URLSearchParams(window.location.search).get('revision') ?? '',
    loaded: true,
    loading: false,
    token: 'test-token',
    groups: [group],
    creatableGroups: [group],
    showOpenSidebar: false,
    onOpenSidebar: () => undefined,
    onSkillChanged: () => undefined,
    onSkillSaved,
    onArchiveSkill: () => undefined,
    onDirtyChange: () => undefined,
    onRestoreSkill: () => undefined,
    onSelectRevision: () => undefined,
    onError: (error: unknown) => {
      throw error;
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
