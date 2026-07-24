import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ExplicitNotepad, Session, SessionNotepad } from '../../api.js';
import { NotepadsPanel, ResponsiveNotepadsPanel } from './notepads-panel.js';

const session: Session = {
  id: 's1',
  status: 'idle',
  spawnDepth: 0,
  createdAt: '2026-07-21T10:00:00Z',
  updatedAt: '2026-07-21T10:00:00Z',
  lastActivityAt: '2026-07-21T10:00:00Z',
  tags: [],
};
const empty: SessionNotepad = {
  sessionId: 's1',
  revision: 0,
  content: '',
  sizeBytes: 0,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
};
const pad: ExplicitNotepad = {
  id: 'p1',
  title: 'Launch notes',
  revision: 3,
  content: 'Linked content',
  sizeBytes: 14,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
};
const originalMoveBefore = Object.getOwnPropertyDescriptor(Element.prototype, 'moveBefore');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalMoveBefore) Object.defineProperty(Element.prototype, 'moveBefore', originalMoveBefore);
  else delete (Element.prototype as Element & { moveBefore?: unknown }).moveBefore;
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function mockFetch(handler?: (path: string, init: RequestInit, url: URL) => Response | Promise<Response> | undefined) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    const parsedUrl = new URL(String(url), window.location.href);
    const path = parsedUrl.pathname;
    const result = await handler?.(path, init, parsedUrl);
    if (result) return result;
    if (path.endsWith('/notepad-associations'))
      return json({ associations: { items: [], hasMore: false, nextCursor: null } });
    if (path.endsWith('/notepad')) return json({ notepad: empty });
    throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${path}`);
  });
}
const panel = (overrides: Partial<Parameters<typeof NotepadsPanel>[0]> = {}) => (
  <NotepadsPanel session={session} token="token" canWrite {...overrides} />
);
async function openSessionNotepad() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open Session Notepad in expanded view' }));
  return screen.findByRole('dialog', { name: 'Session Notepad expanded editor' });
}
async function editSessionNotepad() {
  const dialog = await openSessionNotepad();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
  return dialog;
}

it('lazily loads the virtual empty notepad', async () => {
  let resolve!: (value: Response) => void;
  mockFetch((path) =>
    path.endsWith('/notepad')
      ? new Promise<Response>((done) => {
          resolve = done;
        })
      : undefined,
  );
  render(panel());
  expect(screen.getByText('Loading notepads…')).toBeInTheDocument();
  resolve(json({ notepad: empty }));
  expect(await screen.findByText(/^Updated /)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('Loading notepads…')).not.toBeInTheDocument());
});

it('handles an empty paginated associations response', async () => {
  mockFetch();
  render(panel());
  await waitFor(() => expect(screen.queryByText('Loading notepads…')).not.toBeInTheDocument());
  expect(screen.getByText('Notepads')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});

it('refreshes association metadata when its realtime version changes', async () => {
  let associationRequests = 0;
  const fetchMock = mockFetch((path) => {
    if (!path.endsWith('/notepad-associations')) return undefined;
    associationRequests += 1;
    return json({
      associations: {
        items: associationRequests === 1 ? [] : [{ notepadId: pad.id, sessionId: session.id, notepad: pad }],
        hasMore: false,
        nextCursor: null,
      },
    });
  });
  const view = render(panel({ associationVersion: 0 }));
  await waitFor(() => expect(associationRequests).toBe(1));

  view.rerender(panel({ associationVersion: 8 }));

  expect(await screen.findByText('Launch notes')).toBeInTheDocument();
  expect(associationRequests).toBe(2);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/notepads/${pad.id}`))).toBe(false);
});

it('loads and deduplicates a second association page only when requested', async () => {
  const secondPad = { ...pad, id: 'p2', title: 'Second page notes' };
  const fetchMock = mockFetch((path) => {
    if (!path.endsWith('/notepad-associations')) return undefined;
    const url = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), window.location.href);
    return url.searchParams.get('cursor') === 'next-page'
      ? json({
          associations: {
            items: [
              { notepadId: 'p1', sessionId: 's1', notepad: pad },
              { notepadId: 'p2', sessionId: 's1', notepad: secondPad },
            ],
            hasMore: false,
            nextCursor: null,
          },
        })
      : json({
          associations: {
            items: [{ notepadId: 'p1', sessionId: 's1', notepad: pad }],
            hasMore: true,
            nextCursor: 'next-page',
          },
        });
  });
  render(panel());
  expect(await screen.findByText('Launch notes')).toBeInTheDocument();
  expect(screen.queryByText('Second page notes')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Second page notes')).toBeInTheDocument();
  expect(screen.getAllByText('Launch notes')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/notepad-associations'));
  expect(new URL(String(calls[1]![0]), window.location.href).searchParams.get('cursor')).toBe('next-page');
});

it('renders Markdown and sanitizes scripts and javascript links', async () => {
  mockFetch((path) =>
    path.endsWith('/notepad')
      ? json({
          notepad: { ...empty, revision: 1, content: '# Safe\n<script>evil()</script>\n[x](javascript:alert(1))' },
        })
      : undefined,
  );
  const { container } = render(panel());
  expect(screen.queryByRole('heading', { name: 'Safe' })).not.toBeInTheDocument();
  await openSessionNotepad();
  expect(screen.getByRole('heading', { name: 'Safe' })).toBeInTheDocument();
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
});

it('opens a viewport-sized editor and preserves its draft when closed', async () => {
  mockFetch((path) =>
    path.endsWith('/notepad') ? json({ notepad: { ...empty, revision: 4, content: 'Compact content' } }) : undefined,
  );
  render(panel());
  const expand = await screen.findByRole('button', { name: 'Open Session Notepad in expanded view' });
  fireEvent.click(expand);

  const expanded = await screen.findByRole('dialog', { name: 'Session Notepad expanded editor' });
  expect(expanded).toHaveClass('h-[calc(100dvh-1rem)]');
  expect(document.body.style.overflow).toBe('hidden');
  expect(within(expanded).getByRole('button', { name: 'Close' })).toHaveFocus();

  fireEvent.click(within(expanded).getByRole('button', { name: 'Edit' }));
  const textarea = within(expanded).getByLabelText('Session Notepad Markdown');
  expect(textarea).toHaveClass('flex-1');
  fireEvent.change(textarea, { target: { value: 'Large unsaved draft' } });
  fireEvent.keyDown(document, { key: 'Escape' });

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.body.style.overflow).toBe('');
  expect(screen.getByRole('button', { name: 'Open Session Notepad in expanded view' })).toHaveFocus();
  await openSessionNotepad();
  expect(screen.getByLabelText('Session Notepad Markdown')).toHaveValue('Large unsaved draft');
});

it('marks a newer revision without fetching until the Notepad is opened', async () => {
  const fetchMock = mockFetch((path, init, url) => {
    if (!path.endsWith('/notepad')) return undefined;
    return json({
      notepad: {
        ...empty,
        revision: url.searchParams.get('metadata') === 'true' ? 4 : 5,
        content: 'Fetched only after confirmation',
      },
    });
  });
  const view = render(panel());
  expect(await screen.findByText(/^Updated /)).toBeInTheDocument();
  expect(screen.queryByLabelText('Newer revision available')).not.toBeInTheDocument();

  view.rerender(panel({ changeRevisions: new Map([['session:s1', 5]]) }));
  expect(screen.getByLabelText('Newer revision available')).toHaveClass('h-2', 'w-2', 'rounded-full', 'bg-warning');
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/notepad'))).toHaveLength(0);

  const dialog = await openSessionNotepad();
  expect(await within(dialog).findByText('Fetched only after confirmation')).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/notepad'))).toHaveLength(1);
});

it('ignores an older Session Notepad open response that resolves last', async () => {
  const reads: Array<(response: Response) => void> = [];
  mockFetch((path, init, url) => {
    if (!path.endsWith('/notepad')) return undefined;
    if (url.searchParams.get('metadata') === 'true') return json({ notepad: { ...empty, revision: 3 } });
    return new Promise<Response>((resolve) => reads.push(resolve));
  });
  render(panel());
  const opener = await screen.findByRole('button', { name: 'Open Session Notepad in expanded view' });
  fireEvent.click(opener);
  fireEvent.click(opener);
  expect(reads).toHaveLength(2);
  reads[1]!(json({ notepad: { ...empty, revision: 5, content: 'Newest response' } }));
  expect(await screen.findByText('Newest response')).toBeInTheDocument();
  reads[0]!(json({ notepad: { ...empty, revision: 4, content: 'Older response' } }));
  await waitFor(() => expect(screen.queryByText('Older response')).not.toBeInTheDocument());
  expect(screen.getByText('Newest response')).toBeInTheDocument();
});

it('shares response ordering between editor refresh and row reopen', async () => {
  const delayedReads: Array<(response: Response) => void> = [];
  let fullReads = 0;
  mockFetch((path, init, url) => {
    if (!path.endsWith('/notepad')) return undefined;
    if (url.searchParams.get('metadata') === 'true') return json({ notepad: { ...empty, revision: 4 } });
    fullReads++;
    if (fullReads === 1) return json({ notepad: { ...empty, revision: 4, content: 'Initially loaded' } });
    return new Promise<Response>((resolve) => delayedReads.push(resolve));
  });
  const view = render(panel());
  let dialog = await openSessionNotepad();
  view.rerender(panel({ changeRevisions: new Map([['session:s1', 5]]) }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Session Notepad in expanded view' }));
  expect(delayedReads).toHaveLength(2);

  delayedReads[1]!(json({ notepad: { ...empty, revision: 6, content: 'Newest row response' } }));
  dialog = await screen.findByRole('dialog', { name: 'Session Notepad expanded editor' });
  expect(await within(dialog).findByText('Newest row response')).toBeInTheDocument();
  delayedReads[0]!(json({ notepad: { ...empty, revision: 5, content: 'Older refresh response' } }));
  await waitFor(() => expect(screen.queryByText('Older refresh response')).not.toBeInTheDocument());
  expect(within(dialog).getByText('Newest row response')).toBeInTheDocument();
});

it('preserves an active draft when a realtime revision arrives', async () => {
  let gets = 0;
  mockFetch((path, init, url) => {
    if (!path.endsWith('/notepad')) return undefined;
    if (url.searchParams.get('metadata') === 'true')
      return json({ notepad: { ...empty, revision: 4, content: 'Old' } });
    gets++;
    return json({ notepad: { ...empty, revision: gets === 1 ? 4 : 5, content: gets === 1 ? 'Old' : 'Latest' } });
  });
  const view = render(panel());
  await editSessionNotepad();
  fireEvent.change(screen.getByLabelText('Session Notepad Markdown'), { target: { value: 'Unsaved draft' } });

  view.rerender(panel({ changeRevisions: new Map([['session:s1', 5]]) }));
  expect(screen.getByText(/changed elsewhere/)).toBeInTheDocument();
  expect(screen.getByLabelText('Session Notepad Markdown')).toHaveValue('Unsaved draft');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
  expect(await screen.findByText('Latest')).toBeInTheDocument();
  expect(screen.getByLabelText('Session Notepad Markdown')).toHaveValue('Unsaved draft');
});

it('keeps Markdown links inside the expanded read-only viewer focus cycle', async () => {
  mockFetch((path) =>
    path.endsWith('/notepad')
      ? json({ notepad: { ...empty, revision: 1, content: '[Project notes](https://example.com/notes)' } })
      : undefined,
  );
  render(panel({ canWrite: false }));
  const dialog = await openSessionNotepad();
  const close = within(dialog).getByRole('button', { name: 'Close' });
  const link = within(dialog).getByRole('link', { name: 'Project notes' });

  link.focus();
  fireEvent.keyDown(link, { key: 'Tab', shiftKey: true });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Tab' });
  expect(link).toHaveFocus();

  const backdrop = dialog.parentElement!;
  fireEvent.mouseDown(backdrop, { button: 2 });
  expect(dialog).toBeInTheDocument();
  fireEvent.mouseDown(backdrop, { button: 0 });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('moves one responsive editor between viewport hosts without losing its draft', async () => {
  let desktop = false;
  let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
  const moveBefore = vi.fn(function (this: Element, node: Node) {
    this.append(node);
  });
  Object.defineProperty(Element.prototype, 'moveBefore', { configurable: true, value: moveBefore });
  vi.stubGlobal(
    'matchMedia',
    vi.fn(
      () =>
        ({
          get matches() {
            return desktop;
          },
          media: '(min-width: 1280px)',
          onchange: null,
          addEventListener: (_type: 'change', listener: (event: MediaQueryListEvent) => void) => {
            changeListener = listener;
          },
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    ),
  );
  mockFetch((path) =>
    path.endsWith('/notepad') ? json({ notepad: { ...empty, revision: 1, content: 'Original' } }) : undefined,
  );
  const mobileHost = createRef<HTMLDivElement>();
  const desktopHost = createRef<HTMLDivElement>();
  render(
    <>
      <details data-testid="mobile-details" open>
        <div data-testid="mobile-notepads" ref={mobileHost} />
      </details>
      <div data-testid="desktop-notepads" ref={desktopHost} />
      <ResponsiveNotepadsPanel
        session={session}
        token="token"
        canWrite
        mobileHost={mobileHost}
        desktopHost={desktopHost}
      />
    </>,
  );

  const mobile = screen.getByTestId('mobile-notepads');
  const desktopHostElement = screen.getByTestId('desktop-notepads');
  expect(moveBefore).not.toHaveBeenCalled();
  fireEvent.click(await within(mobile).findByRole('button', { name: 'Open Session Notepad in expanded view' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Session Notepad Markdown'), {
    target: { value: 'Draft survives resize' },
  });
  const mobileTextarea = screen.getByLabelText<HTMLTextAreaElement>('Session Notepad Markdown');
  mobileTextarea.focus();
  mobileTextarea.setSelectionRange(6, 14);

  desktop = true;
  changeListener?.({ matches: true } as MediaQueryListEvent);
  expect(moveBefore).toHaveBeenCalledWith(expect.any(HTMLDivElement), null);
  expect(within(mobile).queryByRole('region', { name: 'Notepads' })).not.toBeInTheDocument();
  expect(within(desktopHostElement).getByRole('region', { name: 'Notepads' })).toBeInTheDocument();
  const desktopTextarea = screen.getByLabelText<HTMLTextAreaElement>('Session Notepad Markdown');
  expect(desktopTextarea).toHaveValue('Draft survives resize');
  expect(desktopTextarea).toHaveFocus();
  expect([desktopTextarea.selectionStart, desktopTextarea.selectionEnd]).toEqual([6, 14]);

  const mobileDetails = screen.getByTestId<HTMLDetailsElement>('mobile-details');
  mobileDetails.open = false;
  desktop = false;
  changeListener?.({ matches: false } as MediaQueryListEvent);
  expect(mobileDetails.open).toBe(true);
  expect(mobileTextarea).toHaveFocus();
  expect([mobileTextarea.selectionStart, mobileTextarea.selectionEnd]).toEqual([6, 14]);
});

it('saves content with the expected revision', async () => {
  const fetchMock = mockFetch((path, init) => {
    if (path.endsWith('/notepad') && init.method === 'PUT')
      return json({ notepad: { ...empty, revision: 5, content: 'New draft' } });
    if (path.endsWith('/notepad')) return json({ notepad: { ...empty, revision: 4, content: 'Old' } });
  });
  render(panel());
  await editSessionNotepad();
  fireEvent.change(screen.getByLabelText('Session Notepad Markdown'), { target: { value: 'New draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('New draft');
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(call?.[1]?.body as string)).toEqual({ content: 'New draft', expectedRevision: 4 });
});

it('keeps the edit base revision when parent data refreshes and resets it after a successful save', async () => {
  let revision = 4;
  const fetchMock = mockFetch((path, init) => {
    if (path.endsWith('/notepad') && init.method === 'PUT') {
      const body = JSON.parse(init.body as string) as { content: string; expectedRevision: number };
      if (body.expectedRevision === 4) return json({ error: 'stale_revision', message: 'stale' }, 409);
      return json({ notepad: { ...empty, revision: 6, content: body.content } });
    }
    if (path.endsWith('/notepad'))
      return json({ notepad: { ...empty, revision, content: revision === 4 ? 'Revision four' : 'Revision five' } });
  });
  const view = render(panel());
  await editSessionNotepad();
  fireEvent.change(screen.getByLabelText('Session Notepad Markdown'), { target: { value: 'My rev4 draft' } });

  revision = 5;
  view.rerender(panel({ token: 'refreshed-token' }));
  expect(await screen.findByText(/changed elsewhere/)).toBeInTheDocument();
  expect(screen.getByLabelText('Session Notepad Markdown')).toHaveValue('My rev4 draft');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
  await screen.findByRole('button', { name: 'Use latest' });
  fireEvent.click(screen.getByRole('button', { name: 'Use latest' }));
  fireEvent.change(screen.getByLabelText('Session Notepad Markdown'), { target: { value: 'Saved from rev5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Saved from rev5');
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(put?.[1]?.body as string).expectedRevision).toBe(5);
});

it('preserves a stale-conflict draft while reloading the newest revision', async () => {
  let gets = 0;
  mockFetch((path, init, url) => {
    if (path.endsWith('/notepad') && init.method === 'PUT')
      return json({ error: 'stale_revision', message: 'stale' }, 409);
    if (path.endsWith('/notepad')) {
      if (url.searchParams.get('metadata') === 'true')
        return json({ notepad: { ...empty, revision: 2, content: 'Old' } });
      gets++;
      return json({ notepad: { ...empty, revision: gets + 1, content: gets === 1 ? 'Old' : 'Latest' } });
    }
  });
  render(panel());
  await editSessionNotepad();
  fireEvent.change(screen.getByLabelText('Session Notepad Markdown'), { target: { value: 'My draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText(/changed elsewhere/)).toBeInTheDocument();
  expect(screen.getByLabelText('Session Notepad Markdown')).toHaveValue('My draft');
  fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
  expect(await screen.findByText(/Latest revision loaded/)).toBeInTheDocument();
  expect(screen.getByLabelText('Session Notepad Markdown')).toHaveValue('My draft');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.getByText('Latest')).toBeInTheDocument();
  expect(screen.getByText('My draft', { selector: 'pre' })).toBeInTheDocument();
});

it('does not classify another 409 error as a stale conflict', async () => {
  mockFetch((path, init) => {
    if (path.endsWith('/notepad') && init.method === 'PUT')
      return json({ error: 'archived', message: 'Archived sessions are read-only' }, 409);
    if (path.endsWith('/notepad')) return json({ notepad: { ...empty, revision: 1, content: 'Old' } });
  });
  render(panel());
  await editSessionNotepad();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Archived sessions are read-only')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reload latest' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});

it('requires confirmation before overwriting the latest revision', async () => {
  let gets = 0;
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const fetchMock = mockFetch((path, init, url) => {
    if (path.endsWith('/notepad') && init.method === 'PUT') {
      const body = JSON.parse(init.body as string) as { expectedRevision: number };
      if (body.expectedRevision === 1) return json({ error: 'stale_revision', message: 'stale' }, 409);
      return json({ notepad: { ...empty, revision: 3, content: 'My draft' } });
    }
    if (path.endsWith('/notepad')) {
      if (url.searchParams.get('metadata') === 'true')
        return json({ notepad: { ...empty, revision: 1, content: 'Old' } });
      gets++;
      return json({ notepad: { ...empty, revision: gets, content: gets === 1 ? 'Old' : 'Latest' } });
    }
  });
  render(panel());
  await editSessionNotepad();
  fireEvent.change(screen.getByLabelText('Session Notepad Markdown'), { target: { value: 'My draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Reload latest' }));
  await screen.findByText('Latest');
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Overwrite latest' }));
  await screen.findByText('My draft');
  expect(confirm).toHaveBeenCalledWith('Overwrite the latest server revision with your stale draft?');
  const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(puts[1]![1]!.body as string).expectedRevision).toBe(2);
});

it('has no editor or creator for an archived Session', async () => {
  mockFetch((path) => (path.endsWith('/notepad') ? json({ notepad: { ...empty, content: 'Read only' } }) : undefined));
  render(panel({ session: { ...session, status: 'archived' } }));
  const dialog = await openSessionNotepad();
  expect(within(dialog).getByText('Read only')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Notepad title')).not.toBeInTheDocument();
});

it('preserves but freezes an active draft when the Session becomes archived', async () => {
  const fetchMock = mockFetch((path) =>
    path.endsWith('/notepad') ? json({ notepad: { ...empty, revision: 1, content: 'Original' } }) : undefined,
  );
  const view = render(panel());
  const dialog = await editSessionNotepad();
  const editor = within(dialog).getByLabelText('Session Notepad Markdown');
  fireEvent.change(editor, { target: { value: 'Unsaved draft' } });

  view.rerender(panel({ session: { ...session, status: 'archived' } }));

  expect(editor).toHaveValue('Unsaved draft');
  expect(editor).toHaveAttribute('readonly');
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(within(dialog).getByText('This Notepad is now read-only. Your draft is preserved.')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
});

it('shows normal row title/access metadata and loads selected content', async () => {
  const fetchMock = mockFetch((path) => {
    if (path.endsWith('/notepad-associations'))
      return json({
        associations: {
          items: [{ notepadId: 'p1', sessionId: 's1', notepad: pad }],
          hasMore: false,
          nextCursor: null,
        },
      });
    if (path === '/notepads/p1') return json({ notepad: pad });
  });
  render(panel());
  const row = await screen.findByRole('button', { name: 'Open Launch notes in expanded view' });
  expect(within(row).getByText('Editable')).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/notepads/p1'))).toBe(false);
  fireEvent.click(row);
  expect(await screen.findByText('Linked content')).toBeInTheDocument();
});

it('refreshes an Explicit Notepad while reopening without discarding a closed draft', async () => {
  let revision = 1;
  const fetchMock = mockFetch((path) => {
    if (path.endsWith('/notepad-associations'))
      return json({
        associations: {
          items: [{ notepadId: 'p1', sessionId: 's1', notepad: pad }],
          hasMore: false,
          nextCursor: null,
        },
      });
    if (path === '/notepads/p1')
      return json({ notepad: { ...pad, revision, content: revision === 1 ? 'Revision one' : 'Revision two' } });
  });
  render(panel());
  const opener = await screen.findByRole('button', { name: 'Open Launch notes in expanded view' });
  fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Launch notes expanded editor' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Launch notes Markdown'), { target: { value: 'Unsaved draft' } });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(opener).toHaveFocus();

  revision = 2;
  fireEvent.click(opener);
  await screen.findByRole('dialog', { name: 'Launch notes expanded editor' });
  expect(screen.getByLabelText('Launch notes Markdown')).toHaveValue('Unsaved draft');
  expect(await screen.findByText('Revision two')).toBeInTheDocument();
  const reads = fetchMock.mock.calls.filter(([url]) => String(url).includes('/notepads/p1?sessionId=s1'));
  expect(reads).toHaveLength(2);
});

it('makes the compact associated metadata card clickable without allowing horizontal growth', async () => {
  mockFetch((path) =>
    path.endsWith('/notepad-associations')
      ? json({
          associations: {
            items: [{ notepadId: 'p1', sessionId: 's1', notepad: pad }],
            hasMore: false,
            nextCursor: null,
          },
        })
      : undefined,
  );
  render(panel());

  const card = await screen.findByRole('button', { name: 'Open Launch notes in expanded view' });
  const sessionCard = screen.getByRole('button', { name: 'Open Session Notepad in expanded view' });
  expect(card).toHaveClass('cursor-pointer', 'overflow-hidden', 'hover:bg-accent');
  expect(within(card).getByText(/^Updated /)).toBeInTheDocument();
  expect(sessionCard.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText('Associated Notepads')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Notepads' })).toHaveClass('min-w-0', 'overflow-hidden');
});

it('ignores an older Explicit Notepad open response that resolves last', async () => {
  const reads: Array<(response: Response) => void> = [];
  mockFetch((path) => {
    if (path.endsWith('/notepad-associations'))
      return json({
        associations: {
          items: [{ notepadId: 'p1', sessionId: 's1', notepad: pad }],
          hasMore: false,
          nextCursor: null,
        },
      });
    if (path === '/notepads/p1') return new Promise<Response>((resolve) => reads.push(resolve));
  });
  render(panel());
  const opener = await screen.findByRole('button', { name: 'Open Launch notes in expanded view' });
  fireEvent.click(opener);
  fireEvent.click(opener);
  expect(reads).toHaveLength(2);
  reads[1]!(json({ notepad: { ...pad, revision: 5, content: 'Newest explicit response' } }));
  expect(await screen.findByText('Newest explicit response')).toBeInTheDocument();
  reads[0]!(json({ notepad: { ...pad, revision: 4, content: 'Older explicit response' } }));
  await waitFor(() => expect(screen.queryByText('Older explicit response')).not.toBeInTheDocument());
});

it('submits only one mutation when Save is clicked twice', async () => {
  let resolveSave!: (response: Response) => void;
  const fetchMock = mockFetch((path, init) => {
    if (path.endsWith('/notepad') && init.method === 'PUT')
      return new Promise<Response>((resolve) => {
        resolveSave = resolve;
      });
    if (path.endsWith('/notepad')) return json({ notepad: { ...empty, revision: 1, content: 'Old' } });
  });
  render(panel());
  await editSessionNotepad();
  fireEvent.change(screen.getByLabelText('Session Notepad Markdown'), { target: { value: 'Once' } });
  const save = screen.getByRole('button', { name: 'Save' });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  await act(async () => {
    resolveSave(json({ notepad: { ...empty, revision: 2, content: 'Once' } }));
  });
  expect(await screen.findByText('Once')).toBeInTheDocument();
});

it('keeps revision history out of the default Notepad view', async () => {
  const fetchMock = mockFetch((path) => {
    if (path.endsWith('/notepad-associations'))
      return json({
        associations: {
          items: [{ notepadId: 'p1', sessionId: 's1', notepad: pad }],
          hasMore: false,
          nextCursor: null,
        },
      });
    if (path === '/notepads/p1') return json({ notepad: pad });
  });
  render(panel());
  fireEvent.click(await screen.findByRole('button', { name: /Launch notes/ }));
  expect(await screen.findByText('Linked content')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/history'))).toBe(false);
});

it('does not offer human-facing Explicit Notepad creation', async () => {
  mockFetch();
  render(panel());
  await waitFor(() => expect(screen.queryByText('Loading notepads…')).not.toBeInTheDocument());
  expect(screen.queryByText('Create and associate')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Notepad title')).not.toBeInTheDocument();
});

it('ignores stale responses after a rapid Session prop change', async () => {
  let resolveOld!: (value: Response) => void;
  mockFetch((path) => {
    if (path === '/sessions/s1/notepad')
      return new Promise<Response>((done) => {
        resolveOld = done;
      });
    if (path === '/sessions/s2/notepad')
      return json({ notepad: { ...empty, sessionId: 's2', content: 'New session' } });
  });
  const view = render(panel());
  view.rerender(panel({ session: { ...session, id: 's2' } }));
  await openSessionNotepad();
  expect(screen.getByText('New session')).toBeInTheDocument();
  resolveOld(json({ notepad: { ...empty, content: 'Stale old session' } }));
  await waitFor(() => expect(screen.queryByText('Stale old session')).not.toBeInTheDocument());
});
