import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkspaceChangesPanel, parseDiff } from './workspace-changes-panel.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('shows all configured repositories and lazily loads the selected file patch', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), window.location.href);
    if (url.pathname.endsWith('/workspace-changes')) {
      return json({
        source: 'live',
        sandboxRuntimeId: 'runtime-1',
        observedAt: '2026-07-29T10:00:00Z',
        repositories: [
          {
            id: 'api',
            owner: 'acme',
            name: 'api',
            isPrimary: true,
            branch: 'main',
            headOid: 'abc',
            status: 'ready',
            complete: true,
            truncated: false,
            files: [
              { id: 'session-file', path: 'src/session.ts', indexChange: 'modified', worktreeChange: 'modified' },
            ],
          },
          {
            id: 'web',
            owner: 'acme',
            name: 'web',
            isPrimary: false,
            branch: 'feature/native-diff',
            headOid: 'def',
            status: 'ready',
            complete: true,
            truncated: false,
            files: [{ id: 'page-file', path: 'src/page.tsx', worktreeChange: 'untracked' }],
          },
        ],
      });
    }
    if (url.pathname.endsWith('/workspace-changes/patch')) {
      const fileId = url.searchParams.get('file');
      return json({
        repositoryId: url.searchParams.get('repository'),
        fileId,
        path: fileId === 'page-file' ? 'src/page.tsx' : 'src/session.ts',
        layer: url.searchParams.get('layer'),
        patch: fileId === 'page-file' ? '@@ -0,0 +1 @@\n+new page\n' : '@@ -1 +1 @@\n-old\n+new\n',
        truncated: false,
        binary: false,
        observedAt: '2026-07-29T10:00:01Z',
      });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });

  render(<WorkspaceChangesPanel sessionId="session-1" token="token" active={false} />);

  expect(await screen.findByText('2 changed files across 2 repositories')).toBeInTheDocument();
  expect(screen.getAllByText('acme/api').length).toBeGreaterThan(0);
  expect(screen.getByText('acme/web')).toBeInTheDocument();
  expect(await screen.findByText('+new')).toBeInTheDocument();

  const webRepository = screen.getByText('acme/web').closest('details')!;
  fireEvent.click(within(webRepository).getByText('acme/web'));
  expect(webRepository).toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: /src\/page\.tsx/ }));
  expect(await screen.findByText('+new page')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /src\/session\.ts/ }));
  expect(await screen.findByText('+new')).toBeInTheDocument();
  expect(webRepository).toHaveAttribute('open');
  expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([request]) => {
        const url = new URL(String(request), window.location.href);
        return url.searchParams.get('repository') === 'web' && url.searchParams.get('file') === 'page-file';
      }),
    ).toBe(true),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Files' }));
  expect(screen.getByRole('navigation', { name: 'Changed files' })).not.toHaveClass('hidden');
});

it('keeps staged and unstaged comparisons independently selectable', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), window.location.href);
    if (url.pathname.endsWith('/workspace-changes'))
      return json({
        source: 'live',
        sandboxRuntimeId: 'runtime-1',
        observedAt: '2026-07-29T10:00:00Z',
        repositories: [
          {
            id: 'api',
            owner: 'acme',
            name: 'api',
            isPrimary: true,
            branch: 'main',
            headOid: 'abc',
            status: 'ready',
            complete: true,
            truncated: false,
            files: [{ id: 'file', path: 'both.ts', indexChange: 'modified', worktreeChange: 'modified' }],
          },
        ],
      });
    return json({
      repositoryId: 'api',
      fileId: 'file',
      path: 'both.ts',
      layer: url.searchParams.get('layer'),
      patch: `@@ -1 +1 @@\n-${url.searchParams.get('layer')} old\n+${url.searchParams.get('layer')} new\n`,
      truncated: false,
      binary: false,
      observedAt: '2026-07-29T10:00:01Z',
    });
  });

  render(<WorkspaceChangesPanel sessionId="session-1" token="token" active={false} />);
  const comparison = await screen.findByRole('group', { name: 'Diff comparison' });
  fireEvent.click(within(comparison).getByRole('button', { name: 'Staged' }));
  expect(await screen.findByText('+index new')).toBeInTheDocument();
  fireEvent.click(within(comparison).getByRole('button', { name: 'Unstaged' }));
  expect(await screen.findByText('+worktree new')).toBeInTheDocument();
});

it('hides the comparison picker when a file only has unstaged changes', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), window.location.href);
    if (url.pathname.endsWith('/workspace-changes')) return summaryWithFile('file.ts', 'file');
    return json({
      repositoryId: 'repo',
      fileId: 'file',
      path: 'file.ts',
      layer: 'worktree',
      patch: '@@ -1 +1 @@\n-old\n+new\n',
      truncated: false,
      binary: false,
      observedAt: '2026-07-29T10:00:01Z',
    });
  });

  render(<WorkspaceChangesPanel sessionId="session-1" token="token" active={false} />);
  expect(await screen.findByText('+new')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Diff comparison' })).not.toBeInTheDocument();
});

it('parses unified diff line numbers without treating file headers as additions', () => {
  expect(parseDiff('--- a/file\n+++ b/file\n@@ -4,2 +8,2 @@\n same\n-old\n+new\n')).toEqual([
    { text: '--- a/file', oldLine: null, newLine: null, kind: 'meta' },
    { text: '+++ b/file', oldLine: null, newLine: null, kind: 'meta' },
    { text: '@@ -4,2 +8,2 @@', oldLine: null, newLine: null, kind: 'hunk' },
    { text: ' same', oldLine: 4, newLine: 8, kind: 'context' },
    { text: '-old', oldLine: 5, newLine: null, kind: 'delete' },
    { text: '+new', oldLine: null, newLine: 9, kind: 'add' },
  ]);
});

it('treats header-like source lines inside a hunk as additions and deletions', () => {
  expect(parseDiff('--- a/file\n+++ b/file\n@@ -1 +1 @@\n--- source text\n+++ replacement text\n')).toEqual([
    { text: '--- a/file', oldLine: null, newLine: null, kind: 'meta' },
    { text: '+++ b/file', oldLine: null, newLine: null, kind: 'meta' },
    { text: '@@ -1 +1 @@', oldLine: null, newLine: null, kind: 'hunk' },
    { text: '--- source text', oldLine: 1, newLine: null, kind: 'delete' },
    { text: '+++ replacement text', oldLine: null, newLine: 1, kind: 'add' },
  ]);
});

it('resets hunk parsing when a patch contains another file section', () => {
  const lines = parseDiff(
    'diff --git a/one b/one\n--- a/one\n+++ b/one\n@@ -1 +1 @@\n-old one\n+new one\ndiff --git a/two b/two\n--- a/two\n+++ b/two\n@@ -2 +2 @@\n-old two\n+new two\n',
  );
  expect(lines.find((line) => line.text === '--- a/two')).toMatchObject({ kind: 'meta', oldLine: null, newLine: null });
  expect(lines.find((line) => line.text === '+++ b/two')).toMatchObject({ kind: 'meta', oldLine: null, newLine: null });
  expect(lines.find((line) => line.text === '-old two')).toMatchObject({ kind: 'delete', oldLine: 2 });
  expect(lines.find((line) => line.text === '+new two')).toMatchObject({ kind: 'add', newLine: 2 });
});

it('switches to the available comparison when a refreshed file moves from unstaged to staged', async () => {
  let summaries = 0;
  const requestedLayers: Array<string | null> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), window.location.href);
    if (url.pathname.endsWith('/workspace-changes')) {
      summaries += 1;
      return json({
        source: 'live',
        sandboxRuntimeId: 'runtime-1',
        observedAt: '2026-07-29T10:00:00Z',
        repositories: [
          {
            id: 'repo',
            owner: 'acme',
            name: 'api',
            isPrimary: true,
            branch: 'main',
            headOid: 'abc',
            status: 'ready',
            complete: true,
            truncated: false,
            files: [
              summaries === 1
                ? { id: 'file', path: 'file.ts', worktreeChange: 'modified' }
                : { id: 'file', path: 'file.ts', indexChange: 'modified' },
            ],
          },
        ],
      });
    }
    const requestedLayer = url.searchParams.get('layer');
    requestedLayers.push(requestedLayer);
    return json({
      repositoryId: 'repo',
      fileId: 'file',
      path: 'file.ts',
      layer: requestedLayer,
      patch: `@@ -1 +1 @@\n-old\n+${requestedLayer}\n`,
      truncated: false,
      binary: false,
      observedAt: '2026-07-29T10:00:01Z',
    });
  });

  render(<WorkspaceChangesPanel sessionId="session-1" token="token" active={false} />);
  expect(await screen.findByText('+worktree')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
  expect(await screen.findByText('+index')).toBeInTheDocument();
  expect(requestedLayers).toEqual(expect.arrayContaining(['worktree', 'index']));
});

it('discards an older summary response after a final active-run refresh supersedes it', async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  let summaries = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), window.location.href);
    if (url.pathname.endsWith('/workspace-changes/patch'))
      return json({
        repositoryId: 'repo',
        fileId: 'fresh',
        path: 'fresh.ts',
        layer: 'worktree',
        patch: '',
        truncated: false,
        binary: false,
        observedAt: '2026-07-29T10:00:01Z',
      });
    summaries += 1;
    return summaries === 1 ? first.promise : second.promise;
  });

  const view = render(<WorkspaceChangesPanel sessionId="session-1" token="token" active />);
  await waitFor(() => expect(summaries).toBe(1));
  view.rerender(<WorkspaceChangesPanel sessionId="session-1" token="token" active={false} />);
  await waitFor(() => expect(summaries).toBe(2));
  second.resolve(summaryWithFile('fresh.ts', 'fresh'));
  expect(await screen.findByText('fresh.ts')).toBeInTheDocument();
  first.resolve(summaryWithFile('stale.ts', 'stale'));
  await Promise.resolve();
  expect(screen.queryByText('stale.ts')).not.toBeInTheDocument();
});

it('aborts an in-flight summary when the panel unmounts', async () => {
  const signal = { current: null as AbortSignal | null };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    signal.current = init?.signal ?? null;
    return new Promise<Response>(() => undefined);
  });
  const view = render(<WorkspaceChangesPanel sessionId="session-1" token="token" active={false} />);
  await waitFor(() => expect(signal.current).not.toBeNull());
  view.unmount();
  expect(signal.current?.aborted).toBe(true);
});

it('notifies its owner after user-triggered workspace connections', async () => {
  const onWorkspaceConnected = vi.fn();
  let summaryRequests = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/patch')) {
      return json({
        repositoryId: 'repo',
        fileId: 'file',
        path: 'file.ts',
        layer: 'worktree',
        patch: '@@ -1 +1 @@\n-old\n+new\n',
        truncated: false,
        binary: false,
        observedAt: '2026-07-29T10:00:01Z',
      });
    }
    summaryRequests += 1;
    return summaryWithFile('file.ts', 'file', [{ id: 'other', path: 'other.ts', worktreeChange: 'modified' }]);
  });

  render(
    <WorkspaceChangesPanel
      sessionId="session-1"
      token="token"
      active={false}
      onWorkspaceConnected={onWorkspaceConnected}
    />,
  );

  await screen.findByText('file.ts');
  expect(onWorkspaceConnected).toHaveBeenCalledOnce();
  await screen.findByText('+new');

  fireEvent.click(screen.getByRole('button', { name: /other\.ts/ }));
  await waitFor(() => expect(onWorkspaceConnected).toHaveBeenCalledTimes(2));

  fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
  await waitFor(() => expect(summaryRequests).toBe(2));
  await waitFor(() => expect(onWorkspaceConnected).toHaveBeenCalledTimes(3));
});

it('preserves user patch reconciliation across a silent polling refresh', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const delayedPatch = deferred<Response>();
  const onWorkspaceConnected = vi.fn();
  let summaries = 0;
  let otherPatches = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/workspace-changes')) {
      summaries += 1;
      return summaryWithFile('file.ts', 'file', [{ id: 'other', path: 'other.ts', worktreeChange: 'modified' }]);
    }
    const file = url.searchParams.get('file');
    if (file === 'other') {
      otherPatches += 1;
      if (otherPatches === 1) return delayedPatch.promise;
    }
    return patchResponse(file ?? 'file');
  });

  render(
    <WorkspaceChangesPanel sessionId="session-1" token="token" active onWorkspaceConnected={onWorkspaceConnected} />,
  );
  await screen.findByText('+file');
  expect(onWorkspaceConnected).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole('button', { name: /other\.ts/ }));
  await waitFor(() => expect(otherPatches).toBe(1));
  await act(() => vi.advanceTimersByTimeAsync(5_000));

  await waitFor(() => expect(summaries).toBe(2));
  await waitFor(() => expect(otherPatches).toBe(2));
  expect(await screen.findByText('+other')).toBeInTheDocument();
  expect(onWorkspaceConnected).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole('button', { name: /other\.ts/ }));
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  await waitFor(() => expect(summaries).toBe(3));
  expect(onWorkspaceConnected).toHaveBeenCalledTimes(2);
  await act(async () => delayedPatch.resolve(patchResponse('other')));
});

it('limits the number of rendered diff rows', async () => {
  const patch = `@@ -0,0 +1,3001 @@\n${Array.from({ length: 3_001 }, (_, index) => `+line ${index}`).join('\n')}\n`;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    return url.pathname.endsWith('/workspace-changes')
      ? summaryWithFile('file.ts', 'file')
      : patchResponse('file', patch);
  });

  render(<WorkspaceChangesPanel sessionId="session-1" token="token" active={false} />);

  expect(await screen.findByText('Rendering the first 3,000 lines of this patch.')).toBeInTheDocument();
  expect(within(screen.getByRole('table', { name: 'Unified diff' })).getAllByRole('row')).toHaveLength(3_000);
});

function summaryWithFile(
  path: string,
  id: string,
  additionalFiles: Array<{ id: string; path: string; worktreeChange: 'modified' }> = [],
): Response {
  return json({
    source: 'live',
    sandboxRuntimeId: 'runtime-1',
    observedAt: '2026-07-29T10:00:00Z',
    repositories: [
      {
        id: 'repo',
        owner: 'acme',
        name: 'api',
        isPrimary: true,
        branch: 'main',
        headOid: 'abc',
        status: 'ready',
        complete: true,
        truncated: false,
        files: [{ id, path, worktreeChange: 'modified' }, ...additionalFiles],
      },
    ],
  });
}

function patchResponse(fileId: string, patch = `@@ -1 +1 @@\n-old\n+${fileId}\n`): Response {
  return json({
    repositoryId: 'repo',
    fileId,
    path: `${fileId}.ts`,
    layer: 'worktree',
    patch,
    truncated: false,
    binary: false,
    observedAt: '2026-07-29T10:00:01Z',
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
