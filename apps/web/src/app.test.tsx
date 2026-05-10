import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './app.js';

const { codeToHtmlMock } = vi.hoisted(() => ({
  codeToHtmlMock: vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`),
}));

vi.mock('shiki', () => ({ codeToHtml: codeToHtmlMock }));

const session = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'idle',
  title: 'Existing session',
  createdAt: '2026-05-05T12:00:00.000Z',
  updatedAt: '2026-05-05T12:00:00.000Z',
};

type StreamEventPusher = (event: unknown) => void;

type MockApiOptions = {
  submittedPrompts?: string[];
  messages?: unknown[];
  events?: unknown[];
  sessions?: unknown[];
  callbacks?: unknown[];
  sessionOverride?: Partial<typeof session>;
  onCancelRun?: () => void;
  onReplayCallback?: (callbackId: string) => void;
  onStreamOpen?: (push: StreamEventPusher) => void;
  onGlobalStreamOpen?: (push: StreamEventPusher) => void;
  onListSessions?: (count: number) => void;
  globalStreamStatus?: number;
  hangSessions?: boolean;
  hangSessionsAfterFirst?: boolean;
  authMode?: 'none' | 'bearer' | 'session';
  sandboxProvider?: string;
  currentUser?: { username: string } | null;
  logins?: Array<{ username: string; password: string }>;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  codeToHtmlMock.mockClear();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  setVisibilityState('visible');
});

it('submits composer text on Enter and preserves Shift Enter for newlines', async () => {
  const submittedPrompts: string[] = [];
  mockApi({ submittedPrompts });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');

  fireEvent.change(composer, { target: { value: 'follow up' } });
  fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
  expect(submittedPrompts).toEqual([]);

  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() => expect(submittedPrompts).toEqual(['follow up']));
});

it('keeps Enter available for newlines in mobile composer text', async () => {
  const submittedPrompts: string[] = [];
  mockMobileTextEntryViewport();
  mockApi({ submittedPrompts });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');

  fireEvent.change(composer, { target: { value: 'line one' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  expect(submittedPrompts).toEqual([]);

  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(submittedPrompts).toEqual(['line one']));
});

it('blurs the composer before clearing submitted text', async () => {
  const submittedPrompts: string[] = [];
  mockApi({ submittedPrompts });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  composer.focus();
  expect(document.activeElement).toBe(composer);

  fireEvent.change(composer, { target: { value: 'follow up' } });
  fireEvent.keyDown(composer, { key: 'Enter' });

  await waitFor(() => expect(submittedPrompts).toEqual(['follow up']));
  await waitFor(() => expect(composer).toHaveValue(''));
  expect(document.activeElement).not.toBe(composer);
});

it('keeps sidebar reachable after mobile open, hide, and reopen actions', async () => {
  mockApi();
  render(<App />);

  const mobileOpen = await screen.findByRole('button', { name: 'Open sessions' });
  fireEvent.click(mobileOpen);
  expect(screen.queryByRole('button', { name: 'Open sessions' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open sessions' }));

  expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeInTheDocument();
});

it('keeps fixed new-session action reachable from a selected session on mobile', async () => {
  mockApi();
  render(<App />);

  expect(await screen.findAllByRole('button', { name: 'New session' })).not.toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: 'Open sessions' }));
  fireEvent.click(screen.getByRole('button', { name: /Existing session/ }));
  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();

  fireEvent.click(screen.getAllByRole('button', { name: 'New session' })[0]!);

  expect(await screen.findByText('What needs doing?')).toBeInTheDocument();
});

it('refreshes sessions when the global event stream reports an external session', async () => {
  const externalSession = {
    id: '00000000-0000-4000-8000-000000000099',
    status: 'idle',
    title: 'Slack thread',
    createdAt: '2026-05-05T12:05:00.000Z',
    updatedAt: '2026-05-05T12:05:00.000Z',
  };
  const sessions = [session];
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    sessions,
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  expect(await screen.findAllByText('Existing session')).not.toHaveLength(0);
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());

  sessions.push(externalSession);
  pushGlobalEvent?.({
    id: 2,
    sessionId: externalSession.id,
    sequence: 1,
    type: 'session_created',
    payload: { title: externalSession.title },
    createdAt: externalSession.createdAt,
  });

  expect(await screen.findByText('Slack thread')).toBeInTheDocument();
});

it('coalesces rapid global session refresh events into one sessions request', async () => {
  const sessions = [session];
  let sessionsRequestCount = 0;
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    sessions,
    onListSessions: (count) => {
      sessionsRequestCount = count;
    },
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  expect(await screen.findAllByText('Existing session')).not.toHaveLength(0);
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());
  expect(sessionsRequestCount).toBe(1);

  sessions.push({ ...session, id: '00000000-0000-4000-8000-000000000098', title: 'Coalesced session' });
  pushGlobalEvent?.(eventFixture({ id: 2, sequence: 1, type: 'session_created', payload: {} }));
  pushGlobalEvent?.(eventFixture({ id: 3, sequence: 2, type: 'session_updated', payload: {} }));
  pushGlobalEvent?.(eventFixture({ id: 4, sequence: 3, type: 'message_completed', payload: {} }));

  await waitFor(() => expect(sessionsRequestCount).toBe(2));
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  expect(sessionsRequestCount).toBe(2);
  expect(await screen.findByText('Coalesced session')).toBeInTheDocument();
});

it('shows and calls cancel task on the active message', async () => {
  let cancelled = false;
  mockApi({
    sessionOverride: { status: 'active' },
    messages: [{
      id: '00000000-0000-4000-8000-000000000102',
      sessionId: session.id,
      sequence: 1,
      status: 'processing',
      prompt: 'running work',
      createdAt: '2026-05-05T12:01:00.000Z',
    }],
    onCancelRun: () => {
      cancelled = true;
    },
  });
  render(<App />);

  const messageCard = await screen.findByRole('article', { name: 'Message 1' });
  fireEvent.click(within(messageCard).getByRole('button', { name: 'Cancel task' }));

  await waitFor(() => expect(cancelled).toBe(true));
});

it('shows cancelling state on the active message cancel action', async () => {
  mockApi({
    sessionOverride: { status: 'active' },
    messages: [{
      id: '00000000-0000-4000-8000-000000000102',
      sessionId: session.id,
      sequence: 1,
      status: 'cancelling',
      prompt: 'stopping work',
      createdAt: '2026-05-05T12:01:00.000Z',
    }],
  });
  render(<App />);

  const messageCard = await screen.findByRole('article', { name: 'Message 1' });
  expect(within(messageCard).getByRole('button', { name: 'Cancelling...' })).toBeDisabled();
});

it('logs in with session auth before loading sessions', async () => {
  const logins: Array<{ username: string; password: string }> = [];
  mockApi({ authMode: 'session', currentUser: null, logins });
  render(<App />);

  fireEvent.change(await screen.findByPlaceholderText('Username'), { target: { value: 'dev' } });
  fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  await screen.findAllByText('Existing session');
  expect(logins).toEqual([{ username: 'dev', password: 'password' }]);
});

it('requires restoring archived sessions before sending messages', async () => {
  const submittedPrompts: string[] = [];
  mockApi({ sessionOverride: { status: 'archived' }, submittedPrompts });
  render(<App />);

  expect(await screen.findByText('This session is archived.')).toBeInTheDocument();
  const composer = screen.getByPlaceholderText('Restore this archived session before sending new work.');
  expect(composer).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  fireEvent.click(screen.getAllByRole('button', { name: 'Restore session' }).at(-1)!);

  await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  expect(submittedPrompts).toEqual([]);
});

it('keeps a cancelled middle message inline with its surrounding batch', async () => {
  mockApi({
    messages: [
      messageFixture({ id: '00000000-0000-4000-8000-000000000110', sequence: 10, status: 'completed', prompt: 'please sleep for 30 seconds' }),
      messageFixture({ id: '00000000-0000-4000-8000-000000000111', sequence: 11, status: 'completed', prompt: 'message 1' }),
      messageFixture({ id: '00000000-0000-4000-8000-000000000112', sequence: 12, status: 'cancelled', prompt: 'message 2' }),
      messageFixture({ id: '00000000-0000-4000-8000-000000000113', sequence: 13, status: 'completed', prompt: 'message 3' }),
    ],
    events: [
      eventFixture({ sequence: 1, type: 'message_started', runId: '00000000-0000-4000-8000-000000000210', messageId: '00000000-0000-4000-8000-000000000110', payload: { sequences: [10, 11, 13], batchSize: 3 } }),
      eventFixture({ sequence: 2, type: 'message_cancelled', messageId: '00000000-0000-4000-8000-000000000112', payload: { sequence: 12 } }),
      eventFixture({ sequence: 3, type: 'agent_text_delta', runId: '00000000-0000-4000-8000-000000000210', messageId: '00000000-0000-4000-8000-000000000110', payload: { text: 'batch response' } }),
    ],
  });
  render(<App />);

  await screen.findByText('batch response');
  const message12 = screen.getByText('message 2');
  const response = screen.getByText('Deputy response');

  expect(message12.compareDocumentPosition(response)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(screen.getAllByText(/Diagnostics/)).toHaveLength(1);
});

it('shows a jump control instead of autoscrolling after the user scrolls up', async () => {
  let pushGlobalEvent: StreamEventPusher = () => undefined;
  let globalStreamOpen = false;
  const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
  mockApi({
    messages: [messageFixture({ id: '00000000-0000-4000-8000-000000000130', sequence: 1, status: 'processing', prompt: 'long running work' })],
    onGlobalStreamOpen: (push) => {
      globalStreamOpen = true;
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  const messageLog = await screen.findByRole('log', { name: 'Session messages' });
  Object.defineProperties(messageLog, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 2000 },
    scrollTop: { configurable: true, value: 0 },
  });
  fireEvent.scroll(messageLog);
  scrollIntoView.mockClear();

  await waitFor(() => expect(globalStreamOpen).toBe(true));
  pushGlobalEvent(eventFixture({ id: 2, sequence: 1, type: 'agent_text_delta', messageId: '00000000-0000-4000-8000-000000000130', payload: { text: 'streaming diagnostics' } }));

  const jump = await screen.findByRole('button', { name: /Jump to latest/ });
  expect(scrollIntoView).not.toHaveBeenCalled();

  fireEvent.click(jump);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' });
});

it('scrolls session messages when wheeling outside nested scroll areas', async () => {
  mockApi({
    messages: [messageFixture({ id: '00000000-0000-4000-8000-000000000133', sequence: 1, status: 'completed', prompt: 'scrollable work' })],
  });
  render(<App />);

  const messageLog = setScrollMetrics(await screen.findByRole('log', { name: 'Session messages' }), {
    clientHeight: 500,
    scrollHeight: 2000,
  });

  fireEvent.wheel(screen.getByRole('heading', { name: 'Existing session' }), { deltaY: 180 });

  expect(messageLog.scrollTop).toBe(180);
});

it('does not redirect wheel events when the sessions area can scroll', async () => {
  mockApi({
    sessions: [
      session,
      { ...session, id: '00000000-0000-4000-8000-000000000002', title: 'Second session' },
    ],
    messages: [messageFixture({ id: '00000000-0000-4000-8000-000000000134', sequence: 1, status: 'completed', prompt: 'scrollable work' })],
  });
  render(<App />);

  const messageLog = setScrollMetrics(await screen.findByRole('log', { name: 'Session messages' }), {
    clientHeight: 500,
    scrollHeight: 2000,
  });

  setScrollMetrics(screen.getByText('Second session').closest('[data-thread-scroll-exclude="true"]'), {
    overflowY: 'auto',
    clientHeight: 100,
    scrollHeight: 400,
  });

  fireEvent.wheel(screen.getByText('Second session'), { deltaY: 180 });

  expect(messageLog.scrollTop).toBe(0);

  const sessionsPane = screen.getByText('Second session').closest('[data-thread-scroll-exclude="true"]') as HTMLElement;
  sessionsPane.scrollTop = 300;
  fireEvent.wheel(screen.getByText('Second session'), { deltaY: 180 });

  expect(messageLog.scrollTop).toBe(0);
});

it('scrolls session messages from the sessions area when it has no scrollbar', async () => {
  mockApi({
    sessions: [
      session,
      { ...session, id: '00000000-0000-4000-8000-000000000002', title: 'Second session' },
    ],
    messages: [messageFixture({ id: '00000000-0000-4000-8000-000000000136', sequence: 1, status: 'completed', prompt: 'scrollable work' })],
  });
  render(<App />);

  const messageLog = setScrollMetrics(await screen.findByRole('log', { name: 'Session messages' }), {
    clientHeight: 500,
    scrollHeight: 2000,
  });

  setScrollMetrics(screen.getByText('Second session').closest('[data-thread-scroll-exclude="true"]'), {
    overflowY: 'auto',
    clientHeight: 400,
    scrollHeight: 400,
  });

  fireEvent.wheel(screen.getByText('Second session'), { deltaY: 180 });

  expect(messageLog.scrollTop).toBe(180);
});

it('lets nested chat panes scroll first and releases wheel scroll at their edge', async () => {
  mockApi({
    messages: [messageFixture({ id: '00000000-0000-4000-8000-000000000135', sequence: 1, status: 'completed', prompt: 'nested scroll work' })],
  });
  render(<App />);

  const messageLog = setScrollMetrics(await screen.findByRole('log', { name: 'Session messages' }), {
    clientHeight: 500,
    scrollHeight: 2000,
  });

  const nestedPane = document.createElement('div');
  setScrollMetrics(nestedPane, {
    overflowY: 'auto',
    clientHeight: 100,
    scrollHeight: 400,
  });
  messageLog.append(nestedPane);

  fireEvent.wheel(nestedPane, { deltaY: 180 });
  expect(messageLog.scrollTop).toBe(0);

  nestedPane.scrollTop = 300;
  fireEvent.wheel(nestedPane, { deltaY: 180 });
  expect(messageLog.scrollTop).toBe(180);
});

it('opens only the global SSE stream for updates', async () => {
  let streamOpenCount = 0;
  let globalStreamOpenCount = 0;
  mockApi({
    onStreamOpen: () => {
      streamOpenCount += 1;
    },
    onGlobalStreamOpen: () => {
      globalStreamOpenCount += 1;
    },
  });
  render(<App />);

  await screen.findByRole('log', { name: 'Session messages' });
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  expect(streamOpenCount).toBe(0);
  expect(globalStreamOpenCount).toBe(1);
});

it('surfaces realtime connection failures with a multiple-window hint', async () => {
  mockApi({ globalStreamStatus: 503 });
  render(<App />);

  const banner = await screen.findByRole('status');
  expect(banner).toHaveTextContent(/Realtime updates are reconnecting|Connection delayed/);
  expect(banner).toHaveTextContent(/several windows/);
  expect(screen.getByText(/Delayed|Reconnecting/)).toBeInTheDocument();
});

it('shows startup connection guidance before request timeout', async () => {
  mockApi({ hangSessions: true });
  render(<App />);

  expect(await screen.findByText('Loading Deputies')).toBeInTheDocument();

  expect(await screen.findByText(/Still waiting for the API to respond/, undefined, { timeout: 4_000 })).toBeInTheDocument();
  expect(screen.getByText(/several windows/)).toBeInTheDocument();
});

it('uses a reconnecting wake state instead of generic slow request guidance after sleep', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockApi({ hangSessionsAfterFirst: true });
  render(<App />);

  expect(await screen.findByRole('log', { name: 'Session messages' })).toBeInTheDocument();

  setVisibilityState('hidden');
  fireEvent(document, new Event('visibilitychange'));
  vi.advanceTimersByTime(6_000);
  setVisibilityState('visible');
  fireEvent(document, new Event('visibilitychange'));
  fireEvent(window, new CustomEvent('deputies:api-connection-delayed', { detail: { message: 'Request timed out: /sessions' } }));

  const banner = (await screen.findByText('Reconnecting after sleep.')).closest('[role="status"]');
  expect(banner).toHaveTextContent('We will retry automatically');
  expect(banner).not.toHaveTextContent('several windows');
});

it('labels active streamed text as progress and separates obvious sentence boundaries', async () => {
  mockApi({
    messages: [messageFixture({ id: '00000000-0000-4000-8000-000000000131', sequence: 1, status: 'processing', prompt: 'inspect env' })],
    events: [
      eventFixture({ sequence: 1, type: 'agent_text_delta', runId: '00000000-0000-4000-8000-000000000231', messageId: '00000000-0000-4000-8000-000000000131', payload: { text: 'Checking environment.Found Node:System:Ready' } }),
    ],
  });
  render(<App />);

  expect(await screen.findByText('Deputy progress')).toBeInTheDocument();
  expect(screen.queryByText('Deputy response')).not.toBeInTheDocument();
  expect(screen.getByText('Checking environment. Found Node: System: Ready')).toBeInTheDocument();
});

it('labels completed assistant text as a response', async () => {
  mockApi({
    messages: [messageFixture({ id: '00000000-0000-4000-8000-000000000132', sequence: 1, status: 'completed', prompt: 'inspect env' })],
    events: [
      eventFixture({ sequence: 1, type: 'agent_text_delta', runId: '00000000-0000-4000-8000-000000000232', messageId: '00000000-0000-4000-8000-000000000132', payload: { text: 'Done.' } }),
    ],
  });
  render(<App />);

  expect(await screen.findByText('Deputy response')).toBeInTheDocument();
  expect(screen.queryByText('Deputy progress')).not.toBeInTheDocument();
});

it('shows run diagnostics for a single-message response', async () => {
  mockApi({
    messages: [messageFixture({ id: '00000000-0000-4000-8000-000000000120', sequence: 1, status: 'completed', prompt: 'single message' })],
    events: [
      eventFixture({ sequence: 1, type: 'message_started', runId: '00000000-0000-4000-8000-000000000220', messageId: '00000000-0000-4000-8000-000000000120', payload: { sequences: [1], batchSize: 1 } }),
      eventFixture({ sequence: 2, type: 'sandbox_ready', runId: '00000000-0000-4000-8000-000000000220', messageId: '00000000-0000-4000-8000-000000000120', payload: { provider: 'fake', created: true } }),
      eventFixture({ sequence: 3, type: 'agent_text_delta', runId: '00000000-0000-4000-8000-000000000220', messageId: '00000000-0000-4000-8000-000000000120', payload: { text: 'single response' } }),
    ],
  });
  render(<App />);

  await screen.findByText('single response');

  expect(screen.getByText(/Diagnostics · 2 events/)).toBeInTheDocument();
  expect(screen.getByText('sandbox_ready')).toBeInTheDocument();
});

it('prefers final assistant response over streamed deltas', async () => {
  mockApi({
    messages: [messageFixture({ id: '00000000-0000-4000-8000-000000000121', sequence: 1, status: 'completed', prompt: 'single message' })],
    events: [
      eventFixture({ sequence: 1, type: 'message_started', runId: '00000000-0000-4000-8000-000000000221', messageId: '00000000-0000-4000-8000-000000000121', payload: { sequences: [1], batchSize: 1 } }),
      eventFixture({ sequence: 2, type: 'agent_text_delta', runId: '00000000-0000-4000-8000-000000000221', messageId: '00000000-0000-4000-8000-000000000121', payload: { text: 'corrupted ' } }),
      eventFixture({ sequence: 3, type: 'agent_text_delta', runId: '00000000-0000-4000-8000-000000000221', messageId: '00000000-0000-4000-8000-000000000121', payload: { text: 'stream' } }),
      eventFixture({ sequence: 4, type: 'agent_response_final', runId: '00000000-0000-4000-8000-000000000221', messageId: '00000000-0000-4000-8000-000000000121', payload: { text: 'canonical final response' } }),
    ],
  });
  render(<App />);

  await screen.findByText('canonical final response');
  expect(screen.queryByText('corrupted stream')).not.toBeInTheDocument();
});

it('renders assistant markdown with copyable highlighted code blocks and without enabling raw html', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  mockApi({
    messages: [messageFixture({ id: '00000000-0000-4000-8000-000000000122', sequence: 1, status: 'completed', prompt: '**please summarize**' })],
    events: [
      eventFixture({ sequence: 1, type: 'message_started', runId: '00000000-0000-4000-8000-000000000222', messageId: '00000000-0000-4000-8000-000000000122', payload: { sequences: [1], batchSize: 1 } }),
      eventFixture({ sequence: 2, type: 'agent_response_final', runId: '00000000-0000-4000-8000-000000000222', messageId: '00000000-0000-4000-8000-000000000122', payload: { text: '# Summary\n\n- **Done**\n\n```ts\nconst ok = true;\n```\n\n[Docs](https://example.com)\n\n<script>alert(1)</script>' } }),
    ],
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Summary' })).toBeInTheDocument();
  expect(screen.getByText('Done')).toBeInTheDocument();
  expect(screen.getByText('const ok = true;')).toBeInTheDocument();
  expect(codeToHtmlMock).toHaveBeenCalledWith('const ok = true;', { lang: 'ts', theme: 'github-light-default' });
  expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', 'https://example.com');
  expect(document.querySelector('script')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('const ok = true;'));
});

it('renders user prompts as plain text so Slack author lines are visible', async () => {
  mockApi({
    messages: [messageFixture({
      id: '00000000-0000-4000-8000-000000000123',
      sequence: 1,
      status: 'completed',
      prompt: 'Current tagged Slack message:\n---\n[sid]: reply "hello"',
    })],
  });
  render(<App />);

  expect(await screen.findByText(/\[sid\]: reply "hello"/)).toBeInTheDocument();
});

it('labels transcript-only integration entries as not queued', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000124',
        sequence: 1,
        status: 'cancelled',
        source: 'github',
        context: { transcriptOnly: true },
        prompt: '@Deputies testing archived\n\n[Not queued: this Deputies session was archived.]',
      }),
      messageFixture({
        id: '00000000-0000-4000-8000-000000000125',
        sequence: 2,
        status: 'cancelled',
        source: 'github_notice',
        context: { transcriptOnly: true },
        prompt: 'This Deputies session is archived, so I did not queue your message. Reply `unarchive and proceed` to restore the session and queue your reply.',
      }),
    ],
  });
  render(<App />);

  expect(await screen.findByText('GitHub comment 1')).toBeInTheDocument();
  expect(screen.getByText('GitHub notice 2')).toBeInTheDocument();
  expect(screen.getAllByText('not queued')).toHaveLength(2);
  expect(screen.getByText(/unarchive and proceed/)).toBeInTheDocument();
});

it('shows callback delivery status and replays failed callbacks', async () => {
  const replays: string[] = [];
  mockApi({
    callbacks: [callbackFixture({ id: '00000000-0000-4000-8000-000000000301', status: 'failed', attempts: 5, maxAttempts: 5, lastError: 'HTTP callback returned 500' })],
    onReplayCallback: (callbackId) => replays.push(callbackId),
  });
  render(<App />);

  expect(await screen.findAllByText('Callbacks')).not.toHaveLength(0);
  expect(screen.getAllByText('Last error: HTTP callback returned 500')[1]).not.toBeVisible();
  fireEvent.click(screen.getAllByText(/http ·/)[1]!);
  expect(screen.getAllByText('Type: Completion reply')[1]).toBeVisible();
  expect(screen.getAllByText('Last error: HTTP callback returned 500')[1]).toBeVisible();
  fireEvent.click(screen.getAllByRole('button', { name: /Replay callback/ })[1]!);

  await waitFor(() => expect(replays).toEqual(['00000000-0000-4000-8000-000000000301']));
  expect(await screen.findAllByText('pending')).not.toHaveLength(0);
});

it('preserves selected archived session and archived section after refresh', async () => {
  const archivedSession = { ...session, status: 'archived', title: 'Archived chosen' };
  localStorage.setItem('deputies-selected-session-id', archivedSession.id);
  localStorage.setItem('deputies-archived-sessions-open', 'true');
  mockApi({
    sessionOverride: archivedSession,
    sessions: [
      { ...session, id: '00000000-0000-4000-8000-000000000002', title: 'Top active', updatedAt: '2026-05-05T12:05:00.000Z' },
      archivedSession,
    ],
  });
  render(<App />);

  expect(await screen.findByText('This session is archived.')).toBeInTheDocument();
  expect(screen.getAllByText('Archived chosen')).toHaveLength(2);
  expect(screen.getByText(/Archived · 1/).closest('details')).toHaveAttribute('open');
});

it('keeps the new-session page selected after archiving and refreshing', async () => {
  mockApi();
  const first = render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));

  expect(await screen.findByText('What needs doing?')).toBeInTheDocument();
  expect(localStorage.getItem('deputies-selected-session-id')).toBeNull();
  expect(localStorage.getItem('deputies-new-session-selected')).toBe('true');

  first.unmount();
  render(<App />);

  expect(await screen.findByText('What needs doing?')).toBeInTheDocument();
  expect(screen.queryByText('This session is archived.')).not.toBeInTheDocument();
});

it('warns when running in local sandbox mode', async () => {
  mockApi({ sandboxProvider: 'local' });
  render(<App />);

  expect(await screen.findByText('Local sandbox mode is not a security boundary.')).toBeInTheDocument();
  expect(screen.getByText(/Commands run on the API\/worker host runtime/)).toBeInTheDocument();
});

function mockApi(options: MockApiOptions = {}) {
  let currentSession = { ...session, ...options.sessionOverride };
  let currentUser = options.currentUser;
  let callbacks = options.callbacks ?? [];
  let sessionsRequestCount = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const method = init?.method ?? 'GET';

    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', runMode: 'all', apiAuthMode: options.authMode ?? 'none', sandboxProvider: options.sandboxProvider ?? 'fake' });
    }

    if (url.pathname === '/auth/me') {
      return currentUser ? jsonResponse({ user: currentUser }) : jsonResponse({ error: 'unauthorized', message: 'Missing or invalid session' }, 401);
    }

    if (url.pathname === '/auth/login' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { username: string; password: string };
      options.logins?.push(body);
      currentUser = { username: body.username };
      return jsonResponse({ user: currentUser });
    }

    if (url.pathname === '/auth/logout' && method === 'POST') {
      currentUser = null;
      return jsonResponse({ ok: true });
    }

    if (url.pathname === '/sessions' && method === 'GET') {
      sessionsRequestCount += 1;
      options.onListSessions?.(sessionsRequestCount);
      if (options.hangSessions) return new Promise<Response>(() => undefined);
      if (options.hangSessionsAfterFirst && sessionsRequestCount > 1) return new Promise<Response>(() => undefined);
      return jsonResponse({ sessions: options.sessions ?? [currentSession] });
    }

    if (url.pathname === `/sessions/${currentSession.id}/unarchive` && method === 'POST') {
      currentSession = { ...currentSession, status: 'idle' };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname === `/sessions/${currentSession.id}/archive` && method === 'POST') {
      currentSession = { ...currentSession, status: 'archived' };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname === `/sessions/${currentSession.id}/messages` && method === 'GET') {
      return jsonResponse({ messages: options.messages ?? [] });
    }

    if (url.pathname === `/sessions/${currentSession.id}/messages` && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { prompt: string };
      options.submittedPrompts?.push(body.prompt);
      return jsonResponse({
        message: {
          id: '00000000-0000-4000-8000-000000000101',
          sessionId: currentSession.id,
          sequence: 1,
          status: 'pending',
          prompt: body.prompt,
          createdAt: '2026-05-05T12:01:00.000Z',
        },
      }, 202);
    }

    if (url.pathname === `/sessions/${currentSession.id}/runs/current/cancel` && method === 'POST') {
      options.onCancelRun?.();
      return jsonResponse({ messages: (options.messages ?? []).map((message) => ({ ...(message as object), status: 'cancelling' })) });
    }

    if (url.pathname === `/sessions/${currentSession.id}/events`) {
      return jsonResponse({ events: filterEventsAfter(options.events ?? [], url.searchParams.get('after')) });
    }

    if (url.pathname === `/sessions/${currentSession.id}/artifacts`) {
      return jsonResponse({ artifacts: [] });
    }

    if (url.pathname === `/sessions/${currentSession.id}/callbacks` && method === 'GET') {
      return jsonResponse({ callbacks });
    }

    const replayMatch = url.pathname.match(new RegExp(`^/sessions/${currentSession.id}/callbacks/([^/]+)/replay$`));
    if (replayMatch && method === 'POST') {
      const callbackId = replayMatch[1]!;
      options.onReplayCallback?.(callbackId);
      callbacks = callbacks.map((callback) => ({ ...(callback as object), status: 'pending', maxAttempts: 6, updatedAt: '2026-05-05T12:04:00.000Z', nextAttemptAt: '2026-05-05T12:04:00.000Z' }));
      return jsonResponse({ callback: callbacks.find((callback) => (callback as { id?: string }).id === callbackId) });
    }

    if (url.pathname === `/sessions/${currentSession.id}/events/stream`) {
      return new Response(new ReadableStream({
        start(controller) {
          const pushStreamEvent: StreamEventPusher = (event) => {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          };
          options.onStreamOpen?.(pushStreamEvent);
        },
      }), { status: 200 });
    }

    if (url.pathname === '/events/stream') {
      if (options.globalStreamStatus) return new Response(null, { status: options.globalStreamStatus });
      return new Response(new ReadableStream({
        start(controller) {
          const pushStreamEvent: StreamEventPusher = (event) => {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          };
          options.onGlobalStreamOpen?.(pushStreamEvent);
        },
      }), { status: 200 });
    }

    return jsonResponse({ error: 'not_found', message: 'Not found' }, 404);
  });
}

type ScrollMetrics = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop?: number;
  overflowY?: string;
};

function setScrollMetrics(element: Element | null, metrics: ScrollMetrics): HTMLElement {
  if (!(element instanceof HTMLElement)) throw new Error('Expected an HTMLElement for scroll metrics');
  if (metrics.overflowY) element.style.overflowY = metrics.overflowY;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    scrollTop: { configurable: true, writable: true, value: metrics.scrollTop ?? 0 },
  });
  return element;
}

function messageFixture(input: { id: string; sequence: number; status: string; prompt: string; source?: string; context?: Record<string, unknown> }) {
  return {
    ...input,
    sessionId: session.id,
    createdAt: '2026-05-05T12:01:00.000Z',
  };
}

function mockMobileTextEntryViewport() {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(hover: none) and (pointer: coarse)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

function eventFixture(input: { sequence: number; type: string; payload: Record<string, unknown>; id?: number; runId?: string; messageId?: string }) {
  return {
    ...input,
    sessionId: session.id,
    createdAt: '2026-05-05T12:02:00.000Z',
  };
}

function filterEventsAfter(events: unknown[], after: string | null): unknown[] {
  const cursor = Number(after ?? 0);
  return events.filter((event) => {
    if (!event || typeof event !== 'object') return true;
    const record = event as { id?: unknown; sequence?: unknown };
    const eventCursor = typeof record.id === 'number' ? record.id : record.sequence;
    return typeof eventCursor !== 'number' || eventCursor > cursor;
  });
}

function callbackFixture(input: { id: string; status: string; attempts: number; maxAttempts: number; lastError?: string }) {
  return {
    ...input,
    sessionId: session.id,
    targetType: 'http',
    target: { url: 'https://example.com/callback' },
    eventType: 'message_completed',
    payload: { text: 'done' },
    createdAt: '2026-05-05T12:03:00.000Z',
    updatedAt: '2026-05-05T12:03:00.000Z',
  };
}

function setVisibilityState(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
