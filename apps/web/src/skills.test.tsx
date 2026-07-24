import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Skill, Snippet } from './api.js';
import { MessageComposer } from './components/app-panels/message-composer.js';
import { NewThreadPanel } from './components/app-panels/new-thread-panel.js';
import {
  matchingSkills,
  prepareSkillSubmission,
  skillInvocationQueryAtCaret,
  useSkillInvocationDraft,
} from './components/app-panels/skill-invocation-draft.js';
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
  autoLoad: false,
  enabled: true,
  source: 'managed',
  provenance: { kind: 'managed' },
  canManage: true,
  createdAt: '2026-07-15T10:00:00.000Z',
  updatedAt: '2026-07-15T10:00:00.000Z',
};

const revisionedSkill: Skill = {
  ...skill,
  currentRevisionId: 'revision-2',
  currentRevisionNumber: 2,
};

const snippet: Snippet = {
  id: 'snippet-1',
  createdByUserId: 'user-1',
  name: 'review-pr',
  body: 'Review this pull request',
  createdAt: '2026-07-15T10:00:00.000Z',
  updatedAt: '2026-07-15T10:00:00.000Z',
};

const group = { id: 'group-1', name: 'Platform' };

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

it('matches standalone skill queries at the caret but rejects snippets, paths, and URLs', () => {
  expect(matchingSkills([skill], [], '/rev')).toEqual([skill]);
  expect(matchingSkills([skill], [], 'Please /rev')).toEqual([skill]);
  expect(matchingSkills([skill], [], 'First paragraph\n\n/rev')).toEqual([skill]);
  expect(skillInvocationQueryAtCaret('Before /review-change after', 11)).toEqual({
    start: 7,
    end: 21,
    query: 'rev',
  });

  for (const prompt of ['//review', 'https://example.com', 'path/review', 'some/review']) {
    expect(skillInvocationQueryAtCaret(prompt, prompt.length)).toBeNull();
  }
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
  expect(list.parentElement).toHaveClass(
    'absolute',
    'bottom-full',
    'left-0',
    'right-0',
    'rounded-t-md',
    'border',
    'p-2',
    'shadow-2xl',
    'ring-1',
    'ring-foreground/20',
  );
  expect(list.parentElement).not.toHaveClass('left-3', 'right-3');
  expect(list).toHaveClass('max-h-[clamp(8rem,35dvh,16rem)]', 'overflow-auto');
  const firstOption = screen.getByRole('option', { name: /review-change/i });
  expect(firstOption).toHaveClass('bg-accent');
  expect(firstOption).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(firstOption);
  expect(screen.getByText('review-change')).toHaveClass('truncate');
  fireEvent.click(screen.getByRole('button', { name: 'Remove review-change skill' }));
  expect(screen.queryByText('review-change')).not.toBeInTheDocument();
});

it('does not treat a Promise-returning picker scroll as an effect cleanup', () => {
  const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  const scrollIntoView = vi.fn(() => Promise.resolve());
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });

  try {
    const secondSkill = { ...skill, id: 'skill-2', name: 'review-security', description: 'Review security.' };
    const composer = render(
      <MessageComposer {...messageComposerProps(vi.fn(async () => true))} skills={[revisionedSkill, secondSkill]} />,
    );
    const textarea = screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
    fireEvent.change(textarea, { target: { value: '/rev' } });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });

    expect(scrollIntoView).toHaveBeenCalled();
    composer.unmount();
  } finally {
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
    } else {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  }
});

it('positions the mobile picker from the complete visual viewport rectangle', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const viewport = new EventTarget();
  Object.assign(viewport, { height: 420, offsetLeft: 18, offsetTop: 24, width: 350 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });

  try {
    render(
      <SkillPicker
        availableCount={1}
        selected={[]}
        options={[skill]}
        open
        onRemoveSkill={() => undefined}
        onSelectSkill={() => undefined}
      />,
    );

    const overlay = screen.getByRole('listbox', { name: 'Available skills' }).parentElement;
    expect(overlay).toHaveStyle({
      '--composer-picker-viewport-height': '420px',
      '--composer-picker-viewport-left': '18px',
      '--composer-picker-viewport-top': '24px',
      '--composer-picker-viewport-width': '350px',
    });
  } finally {
    if (originalDescriptor) Object.defineProperty(window, 'visualViewport', originalDescriptor);
    else Reflect.deleteProperty(window, 'visualViewport');
  }
});

it('selects the first slash match on Enter without sending the message', () => {
  const onSubmit = vi.fn(async () => true);
  render(<MessageComposer {...messageComposerProps(onSubmit)} />);

  const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(
    'Ask your deputy to investigate, change code, or follow up...',
  );
  fireEvent.change(textarea, { target: { value: '/rev' } });
  fireEvent.keyDown(textarea, { key: 'Enter' });

  expect(onSubmit).not.toHaveBeenCalled();
  expect(textarea).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Remove review-change skill' })).toBeInTheDocument();
});

it('attaches a skill from the middle of a follow-up and removes only its token', () => {
  const onSubmit = vi.fn(async () => true);
  render(<MessageComposer {...messageComposerProps(onSubmit)} />);

  const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(
    'Ask your deputy to investigate, change code, or follow up...',
  );
  fireEvent.change(textarea, { target: { value: 'Please /rev carefully.' } });
  textarea.setSelectionRange(11, 11);
  fireEvent.select(textarea);

  expect(screen.getByRole('listbox', { name: 'Available skills' })).toBeInTheDocument();
  fireEvent.keyDown(textarea, { key: 'Enter' });

  expect(onSubmit).not.toHaveBeenCalled();
  expect(textarea).toHaveValue('Please  carefully.');
  expect(textarea).toHaveFocus();
  expect(textarea.selectionStart).toBe(7);
  expect(screen.getByRole('button', { name: 'Remove review-change skill' })).toBeInTheDocument();
});

it('attaches a mid-input skill in the new-thread composer and preserves text after the caret', () => {
  const onSubmit = vi.fn(async () => true);
  function Harness() {
    const [prompt, setPrompt] = useState('Before /review-change after');
    return (
      <NewThreadPanel
        {...newThreadPanelProps([revisionedSkill], onSubmit)}
        prompt={prompt}
        onPromptChange={setPrompt}
      />
    );
  }
  render(<Harness />);
  const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(
    'Ask Deputies to investigate, change code, or answer a question...',
  );
  expect(textarea).toHaveClass('min-h-40');
  textarea.setSelectionRange(11, 11);
  fireEvent.select(textarea);
  expect(textarea).toHaveClass('min-h-40');
  fireEvent.click(screen.getByRole('option', { name: /review-change/i }));

  expect(textarea).toHaveValue('Before  after');
  expect(textarea).toHaveClass('min-h-40');
  expect(textarea).toHaveFocus();
  expect(textarea.selectionStart).toBe(7);
  expect(screen.getByRole('button', { name: 'Remove review-change skill' })).toBeInTheDocument();
});

it('submits an unselected mid-message skill token as ordinary text', async () => {
  const onSubmit = vi.fn(async () => true);
  render(<MessageComposer {...messageComposerProps(onSubmit)} />);
  const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(
    'Ask your deputy to investigate, change code, or follow up...',
  );
  fireEvent.change(textarea, { target: { value: 'Please /review-change carefully.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      prompt: 'Please /review-change carefully.',
      skills: [],
      skillRefs: [],
    }),
  );
});

it('expands filtered snippets by keyboard in MessageComposer and submits no snippet metadata', async () => {
  const onSubmit = vi.fn(async () => true);
  render(<MessageComposer {...messageComposerProps(onSubmit)} snippets={[snippet]} snippetsEnabled />);
  const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(
    'Ask your deputy to investigate, change code, or follow up...',
  );
  fireEvent.change(textarea, { target: { value: 'Please //rev carefully' } });
  textarea.setSelectionRange(12, 12);
  fireEvent.select(textarea);
  const snippetList = screen.getByRole('listbox', { name: 'Personal snippets' });
  expect(snippetList).toHaveClass('max-h-[clamp(8rem,35dvh,16rem)]', 'overflow-auto');
  expect(snippetList.parentElement).toHaveClass('absolute', 'bottom-full', 'left-0', 'right-0');
  fireEvent.keyDown(textarea, { key: 'ArrowDown' });
  fireEvent.keyDown(textarea, { key: 'Enter' });
  expect(textarea).toHaveValue(`Please ${snippet.body} carefully`);
  fireEvent.change(textarea, { target: { value: `Please ${snippet.body} carefully now` } });
  fireEvent.keyDown(textarea, { key: 'Enter' });
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      prompt: `Please ${snippet.body} carefully now`,
      skills: [],
      skillRefs: [],
    }),
  );
});

it('expands snippets by mouse in NewThreadPanel while a single slash remains the skills picker', async () => {
  const onSubmit = vi.fn(async () => true);
  function Harness() {
    const [prompt, setPrompt] = useState('Context\n\n//pull\nThanks');
    return (
      <NewThreadPanel
        {...newThreadPanelProps([skill], onSubmit)}
        snippets={[snippet]}
        snippetsEnabled
        prompt={prompt}
        onPromptChange={setPrompt}
      />
    );
  }
  render(<Harness />);
  const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(
    'Ask Deputies to investigate, change code, or answer a question...',
  );
  textarea.setSelectionRange(15, 15);
  fireEvent.select(textarea);
  fireEvent.click(screen.getByRole('option', { name: /review-pr/i }));
  expect(textarea).toHaveValue(`Context\n\n${snippet.body}\nThanks`);
  fireEvent.change(textarea, { target: { value: '/rev' } });
  expect(screen.queryByRole('listbox', { name: 'Personal snippets' })).not.toBeInTheDocument();
  expect(screen.getByRole('listbox', { name: 'Available skills' })).toBeInTheDocument();
  fireEvent.change(textarea, { target: { value: `${snippet.body} edited` } });
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      prompt: `${snippet.body} edited`,
      skills: [],
      skillRefs: [],
      visibility: 'tenant',
    }),
  );
});

it('never interprets the double-slash snippet namespace as a skill on submit', () => {
  const invalidRepositorySkill = {
    ...skill,
    id: 'repo:acme/widgets:/review',
    name: '/review',
    source: 'repo' as const,
  };
  expect(prepareSkillSubmission('//review', [], [invalidRepositorySkill])).toEqual({ prompt: '//review', skills: [] });
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
      visibility: 'tenant',
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
    source: 'managed' as const,
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

it('shows every available managed and repository candidate for a duplicate name with provenance', () => {
  render(
    <SkillPicker
      availableCount={2}
      options={[
        {
          ...skill,
          description: 'Managed skill takes precedence.',
          source: 'managed',
          provenance: { kind: 'managed' },
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
  expect(screen.getByText('managed')).toBeInTheDocument();
  expect(screen.getByText('Repository duplicate.')).toBeInTheDocument();
  expect(screen.getByText('owner/repo')).toBeInTheDocument();
});

it('allows selecting distinct same-name managed and repository candidates by identity', () => {
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
  expect(screen.getByText('managed')).toBeInTheDocument();
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

it('overlays the skill picker without resizing the composer input surface', () => {
  render(<MessageComposer {...messageComposerProps(vi.fn(async () => true))} />);

  const textarea = screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  expect(textarea).toHaveClass('min-h-28');
  fireEvent.change(textarea, { target: { value: '/rev' } });
  expect(textarea).toHaveClass('min-h-28');
  expect(screen.getByRole('listbox', { name: 'Available skills' }).parentElement).toHaveClass('absolute');
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
          steering: false,
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
      onToggleSteering={() => undefined}
      steeringMessageIds={new Set()}
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

it('lets a viewer browse revision history while keeping the skill read-only', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      revisions: [
        {
          id: 'revision-2',
          skillId: 'skill-1',
          revisionNumber: 2,
          name: 'review-change',
          description: 'Current definition.',
          body: '# Shared body',
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
  const panel = render(
    <SkillsPanel
      {...skillsPanelProps({ ...revisionedSkill, canManage: false, body: '# Shared body' }, () => undefined)}
      selectedRevisionId="revision-1"
    />,
  );

  expect(screen.getByLabelText(/^Markdown body/)).toHaveValue('# Shared body');
  expect(screen.getByLabelText(/^Markdown body/)).toBeDisabled();
  expect(await screen.findByLabelText('Revision')).toHaveTextContent('Revision 1');
  expect(fetchMock).toHaveBeenCalledOnce();
  panel.unmount();
  await Promise.resolve();
});

it('contains a revision-history 403 instead of escalating it to the app error handler', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ error: 'forbidden', message: 'Skill management access is required' }, 403),
  );
  const onError = vi.fn();
  const panel = render(<SkillsPanel {...skillsPanelProps(revisionedSkill, () => undefined)} onError={onError} />);

  await waitFor(() => expect(screen.getByText('Revision history is unavailable.')).toBeInTheDocument());
  expect(onError).not.toHaveBeenCalled();
  panel.unmount();
  await Promise.resolve();
});

it('lets a member edit managed skills regardless of creator and creates without ownership fields', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return jsonResponse({ skill: { ...skill, ...body, id: path === '/skills' ? 'skill-new' : skill.id } });
  });
  const onSaved = vi.fn();
  const memberEditableSkill = { ...skill, createdByUserId: 'another-member', canManage: true };
  const panel = render(<SkillsPanel {...skillsPanelProps(memberEditableSkill, onSaved)} />);

  fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Edited by another member.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const updateInput = fetchMock.mock.calls[0]![0];
  const updatePath = new URL(
    updateInput instanceof Request ? updateInput.url : String(updateInput),
    window.location.href,
  ).pathname;
  expect(updatePath).toBe('/skills/skill-1');

  panel.rerender(<SkillsPanel {...skillsPanelProps(null, onSaved)} />);
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'tenant-skill' } });
  fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Available to the tenant.' } });
  fireEvent.change(screen.getByLabelText(/^Markdown body/), { target: { value: '# Tenant skill' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));

  const createPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
  expect(createPayload).toMatchObject({
    name: 'tenant-skill',
    description: 'Available to the tenant.',
    body: '# Tenant skill',
    autoLoad: true,
  });
  expect(Object.keys(createPayload)).not.toEqual(
    expect.arrayContaining(['ownerKind', 'ownerGroupId', 'shareMode', 'groupIds']),
  );
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
