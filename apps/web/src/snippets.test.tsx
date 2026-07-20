import { readFileSync } from 'node:fs';
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import type { Snippet } from './api.js';
import { SnippetsPanel } from './components/app-panels/snippets-panel.js';
import { SnippetsSidebar } from './components/app-panels/snippets-sidebar.js';

const active: Snippet = {
  id: 'one',
  ownerUserId: 'u',
  name: 'review-pr',
  body: 'Review pull request',
  createdAt: 'now',
  updatedAt: 'now',
};
const archived: Snippet = {
  id: 'two',
  ownerUserId: 'u',
  name: 'old-deploy',
  body: 'Deploy old app',
  archivedAt: 'then',
  createdAt: 'now',
  updatedAt: 'then',
};
const second: Snippet = { ...active, id: 'two', name: 'second', body: 'Second body' };

afterEach(() => vi.restoreAllMocks());

it('renders active/archived filtering and search in SnippetsSidebar', () => {
  const onSelect = vi.fn();
  const onArchive = vi.fn();
  const onRestore = vi.fn();
  render(
    <SnippetsSidebar
      snippets={[active, archived]}
      selectedId=""
      loading={false}
      mutationPending={false}
      footerProps={{} as never}
      onSelect={onSelect}
      onCreate={() => undefined}
      onBack={() => undefined}
      onCollapse={() => undefined}
      onArchive={onArchive}
      onRestore={onRestore}
    />,
  );
  expect(screen.getByText('review-pr')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Archive review-pr snippet' }));
  expect(onArchive).toHaveBeenCalledWith('one');
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.getByText('Archived · 1')).toBeInTheDocument();
  expect(screen.getByText('old-deploy')).not.toBeVisible();
  fireEvent.click(screen.getByText('Archived · 1'));
  expect(screen.getByText('old-deploy')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Restore old-deploy snippet' }));
  expect(onRestore).toHaveBeenCalledWith('two');
  fireEvent.change(screen.getByPlaceholderText('Search snippets...'), { target: { value: 'deploy' } });
  expect(screen.queryByText('review-pr')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('old-deploy'));
  expect(onSelect).toHaveBeenCalledWith('two');
});

it('creates and edits snippets and reports dirty navigation state', async () => {
  const save = vi
    .fn()
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce({ ...active, body: 'Edited' });
  const changed = vi.fn();
  const dirty = vi.fn();
  const props = {
    selectedId: '',
    loading: false,
    mutationPending: false,
    showOpenSidebar: false,
    onOpenSidebar: () => undefined,
    onSave: save,
    onChanged: changed,
    onArchive: () => undefined,
    onRestore: () => undefined,
    onDirtyChange: dirty,
    onError: (error: unknown) => {
      throw error;
    },
  };
  const view = render(<SnippetsPanel {...props} snippet={null} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'review-pr' } });
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Review pull request' } });
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('button', { name: 'Create snippet' }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(active));
  expect(save).toHaveBeenLastCalledWith({ name: 'review-pr', body: 'Review pull request' });
  view.rerender(<SnippetsPanel {...props} selectedId="one" snippet={active} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Edited' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save snippet' }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith({ ...active, body: 'Edited' }));
  expect(save).toHaveBeenLastCalledWith({ snippetId: 'one', body: 'Edited' });
});

it('accepts a created snippet when mounted under StrictMode', async () => {
  const changed = vi.fn();
  render(
    <StrictMode>
      <SnippetsPanel
        {...panelProps(vi.fn().mockResolvedValue(active))}
        selectedId=""
        snippet={null}
        onChanged={changed}
      />
    </StrictMode>,
  );
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: active.name } });
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: active.body } });
  fireEvent.click(screen.getByRole('button', { name: 'Create snippet' }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(active));
});

it('PATCHes only changed snippet fields and does not submit a no-op', async () => {
  const save = vi.fn().mockImplementation(async (input: { name?: string; body?: string }) => ({
    ...active,
    ...input,
  }));
  const props = panelProps(save);
  const view = render(<SnippetsPanel {...props} snippet={active} />);

  expect(screen.getByRole('button', { name: 'Save snippet' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('button', { name: 'Save snippet' }).closest('form')!);
  expect(save).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Body only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save snippet' }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ snippetId: 'one', body: 'Body only' }));

  view.rerender(<SnippetsPanel {...props} snippet={{ ...active, body: 'Body only', updatedAt: 'later' }} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save snippet' }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ snippetId: 'one', name: 'renamed' }));
});

it('explains invalid snippet names instead of only disabling save', () => {
  render(<SnippetsPanel {...panelProps(vi.fn())} snippet={active} />);
  const name = screen.getByLabelText('Name');

  fireEvent.change(name, { target: { value: 'Invalid Name' } });
  expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Use lowercase letters, numbers, and single hyphens only.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save snippet' })).toBeDisabled();

  fireEvent.change(name, { target: { value: 'valid-name' } });
  expect(name).toHaveAttribute('aria-invalid', 'false');
  expect(screen.queryByText('Use lowercase letters, numbers, and single hyphens only.')).not.toBeInTheDocument();
  expect(screen.getByText('//valid-name')).toBeVisible();
});

it('does not apply a delayed save to a different editor and keeps the new editor dirty', async () => {
  let resolveSave!: (snippet: Snippet) => void;
  const save = vi.fn(() => new Promise<Snippet>((resolve) => (resolveSave = resolve)));
  const changed = vi.fn();
  const dirty = vi.fn();
  const props = { ...panelProps(save), onChanged: changed, onDirtyChange: dirty };
  const view = render(<SnippetsPanel {...props} snippet={active} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Saving' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save snippet' }));

  view.rerender(<SnippetsPanel {...props} selectedId="two" snippet={second} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'New editor draft' } });
  resolveSave({ ...active, body: 'Saving' });

  await waitFor(() => expect(screen.getByLabelText('Body')).toHaveValue('New editor draft'));
  expect(changed).not.toHaveBeenCalled();
  expect(dirty).toHaveBeenLastCalledWith(true);
});

it('does not apply a delayed create after navigating away', async () => {
  let resolveSave!: (snippet: Snippet) => void;
  const save = vi.fn(() => new Promise<Snippet>((resolve) => (resolveSave = resolve)));
  const changed = vi.fn();
  const props = { ...panelProps(save), selectedId: '', onChanged: changed };
  const view = render(<SnippetsPanel {...props} snippet={null} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'created' } });
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Created body' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create snippet' }));

  view.rerender(<SnippetsPanel {...props} selectedId="one" snippet={active} />);
  resolveSave({ ...active, name: 'created', body: 'Created body' });

  await waitFor(() => expect(screen.getByLabelText('Body')).toHaveValue(active.body));
  expect(changed).not.toHaveBeenCalled();
});

it('warns before unloading a dirty snippet editor', async () => {
  render(<SnippetsPanel {...panelProps(vi.fn())} snippet={active} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Unsaved' } });
  await waitFor(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

it('offers archive and restore actions', () => {
  const onArchive = vi.fn();
  const onRestore = vi.fn();
  const common = {
    selectedId: 'one',
    loading: false,
    mutationPending: false,
    showOpenSidebar: false,
    onOpenSidebar: () => undefined,
    onSave: async () => null,
    onChanged: () => undefined,
    onArchive,
    onRestore,
    onDirtyChange: () => undefined,
    onError: () => undefined,
  };
  const view = render(<SnippetsPanel {...common} snippet={active} />);
  fireEvent.click(screen.getByRole('button', { name: 'Archive snippet' }));
  expect(onArchive).toHaveBeenCalledWith('one');
  view.rerender(<SnippetsPanel {...common} selectedId="two" snippet={archived} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore snippet' }));
  expect(onRestore).toHaveBeenCalledWith('two');
});

it('keeps browser API proxy prefixes aligned across Vite, Caddy, and Helm', () => {
  const vite = readFileSync('vite.config.ts', 'utf8');
  const expected = [...vite.matchAll(/^\s+'(\/[^']+)': apiProxy,/gm)].map((match) => match[1]).sort();
  const files = [
    'Caddyfile',
    'Caddyfile.local',
    '../../deploy/kubernetes/charts/deputies/templates/web-caddyfile.configmap.yaml',
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const matcher = source.match(/@api path ([^\n]+)/)?.[1];
    expect(matcher, file).toBeTruthy();
    expect(
      matcher!
        .trim()
        .split(/\s+/)
        .map((path) => path.replace(/\*$/, ''))
        .sort(),
      file,
    ).toEqual(expected);
  }
});

function panelProps(onSave: (input: { snippetId?: string; name?: string; body?: string }) => Promise<Snippet | null>) {
  return {
    selectedId: 'one',
    loading: false,
    mutationPending: false,
    showOpenSidebar: false,
    onOpenSidebar: () => undefined,
    onSave,
    onChanged: () => undefined,
    onArchive: () => undefined,
    onRestore: () => undefined,
    onDirtyChange: () => undefined,
    onError: (error: unknown) => {
      throw error;
    },
  };
}
