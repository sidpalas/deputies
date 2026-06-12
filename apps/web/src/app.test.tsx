import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './app.js';
import { listEvents } from './api.js';

const { codeToHtmlMock } = vi.hoisted(() => ({
  codeToHtmlMock: vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`),
}));

vi.mock('shiki', () => ({ codeToHtml: codeToHtmlMock }));

const session = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'idle',
  title: 'Existing session',
  ownerGroupId: '00000000-0000-4000-8000-000000000010',
  visibility: 'organization',
  writePolicy: 'group_members',
  createdByUserId: '00000000-0000-4000-8000-000000000020',
  createdAt: '2026-05-05T12:00:00.000Z',
  updatedAt: '2026-05-05T12:00:00.000Z',
};

const group = {
  id: '00000000-0000-4000-8000-000000000010',
  name: 'Default group',
  defaultVisibility: 'organization',
  defaultWritePolicy: 'group_members',
  automationCreateRequiredRole: 'member',
  membershipRole: 'admin',
  canCreateSessions: true,
  canCreateAutomations: true,
  canManage: true,
  createdAt: '2026-05-05T12:00:00.000Z',
  updatedAt: '2026-05-05T12:00:00.000Z',
};

const user = {
  id: '00000000-0000-4000-8000-000000000020',
  username: 'dev',
  role: 'super_admin',
};

type StreamEventPusher = (event: unknown) => void;

type MockApiOptions = {
  submittedPrompts?: string[];
  submittedMessageBodies?: unknown[];
  accessUpdates?: unknown[];
  repositories?: unknown[];
  branches?: unknown[];
  models?: string[];
  messages?: unknown[];
  messagesBySession?: Record<string, unknown[]>;
  events?: unknown[];
  artifacts?: unknown[];
  services?: unknown[];
  externalResources?: unknown[];
  groups?: unknown[];
  createdGroups?: unknown[];
  groupUpdates?: unknown[];
  groupMemberUpdates?: unknown[];
  removedGroupMembers?: string[];
  groupUpdateStatus?: number;
  groupUpdateError?: unknown;
  groupMembers?: unknown[];
  users?: unknown[];
  userRoleUpdates?: unknown[];
  artifactPreview?: unknown;
  artifactPreviewStatus?: number;
  sessions?: unknown[];
  callbacks?: unknown[];
  sessionOverride?: Partial<typeof session> & {
    context?: Record<string, unknown>;
    displayStatus?: string;
    displayStatusTooltip?: string;
    ownerGroupName?: string;
    sandbox?: Record<string, unknown>;
  };
  onCancelRun?: () => void;
  onRetryMessage?: (messageId: string) => void;
  onReplayCallback?: (callbackId: string) => void;
  onStreamOpen?: (push: StreamEventPusher) => void;
  onGlobalStreamOpen?: (push: StreamEventPusher) => void;
  onGlobalStreamRequest?: (url: URL) => void;
  onListSessions?: (count: number) => void;
  globalStreamStatus?: number;
  hangArchive?: boolean;
  hangMessagesForSessions?: string[];
  hangArtifacts?: boolean;
  hangSessions?: boolean;
  hangUnarchive?: boolean;
  hangSessionsAfterFirst?: boolean;
  authMode?: 'none' | 'bearer' | 'session';
  sandboxProvider?: string;
  currentUser?: (typeof user & { memberships?: unknown[] }) | null;
  notices?: unknown[];
  logins?: Array<{ username: string; password: string }>;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  codeToHtmlMock.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  document.documentElement.classList.remove('dark');
  setVisibilityState('visible');
});

it('pages session event replay in the API client', async () => {
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    requests.push(`${url.pathname}${url.search}`);

    if (url.searchParams.get('after') === '2') {
      return jsonResponse({
        events: [eventFixture({ sequence: 3, type: 'message_completed', payload: { sequence: 1 } })],
        cursor: 3,
        hasMore: false,
      });
    }

    return jsonResponse({
      events: [
        eventFixture({ sequence: 1, type: 'session_created', payload: { title: 'Existing session' } }),
        eventFixture({ sequence: 2, type: 'message_created', payload: { sequence: 1, source: null } }),
      ],
      cursor: 2,
      hasMore: true,
    });
  });

  const events = await listEvents(session.id, 'secret');

  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  expect(requests).toEqual([
    `/sessions/${session.id}/events?limit=1000`,
    `/sessions/${session.id}/events?limit=1000&after=2`,
  ]);
});

it('stops API client event paging when a hasMore page has no events', async () => {
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    requests.push(`${url.pathname}${url.search}`);

    if (requests.length === 1) {
      return jsonResponse({
        events: [eventFixture({ sequence: 1, type: 'session_created', payload: { title: 'Existing session' } })],
        cursor: 1,
        hasMore: true,
      });
    }

    return jsonResponse({ events: [], cursor: 1, hasMore: true });
  });

  const events = await listEvents(session.id, 'secret');

  expect(events.map((event) => event.sequence)).toEqual([1]);
  expect(requests).toEqual([
    `/sessions/${session.id}/events?limit=1000`,
    `/sessions/${session.id}/events?limit=1000&after=1`,
  ]);
});

it('stops API client event paging when a hasMore cursor does not advance', async () => {
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    requests.push(`${url.pathname}${url.search}`);

    if (requests.length === 1) {
      return jsonResponse({
        events: [eventFixture({ sequence: 1, type: 'session_created', payload: { title: 'Existing session' } })],
        cursor: 1,
        hasMore: true,
      });
    }

    return jsonResponse({
      events: [eventFixture({ sequence: 2, type: 'message_created', payload: { sequence: 1, source: null } })],
      cursor: 1,
      hasMore: true,
    });
  });

  const events = await listEvents(session.id, 'secret');

  expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(requests).toEqual([
    `/sessions/${session.id}/events?limit=1000`,
    `/sessions/${session.id}/events?limit=1000&after=1`,
  ]);
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

it('submits the selected model without inherited repo or branch overrides', async () => {
  const submittedMessageBodies: unknown[] = [];
  mockApi({
    submittedMessageBodies,
    sessionOverride: {
      context: {
        repository: { provider: 'github', owner: 'owner', repo: 'repo' },
        branch: 'feature',
        model: 'openai/gpt-4.1',
      },
    },
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  expect(await screen.findByText('gpt 4.1 (OpenAI)')).toBeInTheDocument();
  fireEvent.change(composer, { target: { value: 'follow up' } });
  fireEvent.keyDown(composer, { key: 'Enter' });

  await waitFor(() => expect(submittedMessageBodies).toHaveLength(1));
  expect(submittedMessageBodies[0]).toEqual({ prompt: 'follow up', model: 'openai/gpt-4.1' });
});

it('allows starting a session without repository options', async () => {
  const submittedMessageBodies: unknown[] = [];
  mockApi({ submittedMessageBodies, repositories: [] });
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
  fireEvent.change(screen.getByPlaceholderText('Ask Deputies to investigate, change code, or answer a question...'), {
    target: { value: 'start work' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

  await waitFor(() => expect(submittedMessageBodies).toHaveLength(1));
  expect(submittedMessageBodies[0]).toMatchObject({ prompt: 'start work' });
  expect(submittedMessageBodies[0]).not.toHaveProperty('repository');
});

it('shows fast streamed responses for newly-created sessions before detail refresh completes', async () => {
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    hangMessagesForSessions: ['00000000-0000-4000-8000-000000000102'],
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  await waitFor(() => expect(pushGlobalEvent).toBeDefined());
  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
  fireEvent.change(screen.getByPlaceholderText('Ask Deputies to investigate, change code, or answer a question...'), {
    target: { value: 'start work' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

  expect(await screen.findAllByText('start work')).not.toHaveLength(0);
  act(() => {
    pushGlobalEvent?.({
      id: 10,
      sessionId: '00000000-0000-4000-8000-000000000102',
      sequence: 2,
      type: 'agent_response_final',
      messageId: '00000000-0000-4000-8000-000000000101',
      payload: { text: 'fast fake provider response' },
      createdAt: '2026-05-05T12:02:00.000Z',
    });
  });

  expect(await screen.findByText('fast fake provider response')).toBeInTheDocument();
  expect(screen.queryByText('Loading session')).not.toBeInTheDocument();
});

it('keeps only one context picker open at a time', async () => {
  mockApi();
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));

  fireEvent.click(screen.getByRole('button', { name: 'Repository' }));
  expect(screen.getByRole('option', { name: 'owner/repo' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  expect(screen.queryByRole('option', { name: 'owner/repo' })).not.toBeInTheDocument();
  expect(screen.getByRole('option', { name: /gpt 4\.1 \(OpenAI\)/i })).toBeInTheDocument();
});

it('shows providers for models with the same model name', async () => {
  mockApi({ models: ['openai/gpt-5.5', 'opencode/gpt-5.5'] });
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));

  expect(screen.getByRole('option', { name: 'gpt 5.5 (OpenAI)' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'gpt 5.5 (OpenCode Zen)' })).toBeInTheDocument();
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

  const sendButton = screen.getByRole('button', { name: 'Send message' });
  expect(sendButton).toHaveClass('ml-auto');
  expect(sendButton).not.toHaveClass('h-11', 'w-full');
  await act(async () => {
    fireEvent.touchStart(sendButton, { changedTouches: [{ clientX: 20, clientY: 20 }] });
    fireEvent.touchEnd(sendButton, { changedTouches: [{ clientX: 20, clientY: 20 }] });
  });
  expect(composer).not.toBeInTheDocument();
  await waitFor(() => expect(submittedPrompts).toEqual(['line one']));
});

it('does not submit the mobile composer when a touch turns into a scroll', async () => {
  const submittedPrompts: string[] = [];
  mockMobileTextEntryViewport();
  mockApi({ submittedPrompts });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: 'line one' } });

  const sendButton = screen.getByRole('button', { name: 'Send message' });
  fireEvent.touchStart(sendButton, { changedTouches: [{ clientX: 20, clientY: 20 }] });
  fireEvent.touchMove(sendButton, { changedTouches: [{ clientX: 20, clientY: 42 }] });
  fireEvent.touchEnd(sendButton, { changedTouches: [{ clientX: 20, clientY: 42 }] });

  expect(submittedPrompts).toEqual([]);
  expect(composer).toHaveValue('line one');
});

it('blurs and clears the composer before waiting for post-submit refreshes', async () => {
  const submittedPrompts: string[] = [];
  mockApi({ submittedPrompts, hangSessionsAfterFirst: true });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  act(() => composer.focus());
  expect(document.activeElement).toBe(composer);

  fireEvent.change(composer, { target: { value: 'follow up' } });
  fireEvent.keyDown(composer, { key: 'Enter' });

  await waitFor(() => expect(submittedPrompts).toEqual(['follow up']));
  expect(composer).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...')).toHaveValue('');
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

it('shows a session loading state instead of stale messages while selected details load', async () => {
  const firstSession = { ...session, title: 'First session' };
  const secondSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000002',
    title: 'Second session',
    updatedAt: '2026-05-05T11:00:00.000Z',
  };
  mockApi({
    sessions: [firstSession, secondSession],
    messagesBySession: {
      [firstSession.id]: [
        {
          id: '00000000-0000-4000-8000-000000000011',
          sessionId: firstSession.id,
          sequence: 1,
          status: 'completed',
          prompt: 'stale first session message',
          createdAt: '2026-05-05T12:00:00.000Z',
        },
      ],
    },
    hangMessagesForSessions: [secondSession.id],
  });
  render(<App />);

  expect(await screen.findByText('stale first session message')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Second session/ }));

  expect(await screen.findByRole('heading', { name: 'Second session' })).toBeInTheDocument();
  expect(screen.getByText('Loading session')).toBeInTheDocument();
  expect(screen.queryByText('stale first session message')).not.toBeInTheDocument();
});

it('renders the selected session before artifacts finish loading', async () => {
  mockApi({
    hangArtifacts: true,
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000011',
        sequence: 1,
        status: 'completed',
        prompt: 'artifact-independent message',
      }),
    ],
  });
  render(<App />);

  expect(await screen.findByText('artifact-independent message')).toBeInTheDocument();
  expect(screen.queryByText('Loading session')).not.toBeInTheDocument();
  expect(
    screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...'),
  ).toBeInTheDocument();
});

it('keeps new-session action available from the sidebar on mobile', async () => {
  mockApi();
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Open sessions' }));
  fireEvent.click(screen.getByRole('button', { name: /Existing session/ }));
  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Open sessions' }));
  fireEvent.click(screen.getByRole('button', { name: 'New session' }));

  expect(await screen.findByText('What needs doing?')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open sessions' }));
  expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeInTheDocument();
});

it('keeps the sidebar archive action exposed on mobile', async () => {
  mockApi();
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Open sessions' }));
  const sessionRow = screen.getByRole('button', { name: /Existing session/ }).closest('div');
  expect(sessionRow).toBeInTheDocument();

  const archiveButton = within(sessionRow as HTMLElement).getByRole('button', { name: 'Archive session' });
  expect(archiveButton).not.toHaveClass('opacity-0');
  expect(archiveButton).toHaveClass('md:opacity-0');

  fireEvent.click(archiveButton);
  expect(await screen.findByText('What needs doing?')).toBeInTheDocument();
});

it('groups header session actions in a tools menu', async () => {
  mockApi();
  render(<App />);

  const heading = await screen.findByRole('heading', { name: 'Existing session' });
  const header = heading.closest('section');
  expect(header).toBeInTheDocument();

  fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Tools' }));

  expect(within(header as HTMLElement).getByText('Workspace Tools')).toBeInTheDocument();
  expect(within(header as HTMLElement).getByRole('menuitem', { name: 'Archive session' })).toBeInTheDocument();
});

it('reopens the sessions side panel when navigating back to sessions from the footer on desktop', async () => {
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Search sessions...')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Search groups...')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Access' })).toBeInTheDocument();
});

it('keeps the groups page open until a session is selected', async () => {
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({
    authMode: 'session',
    currentUser: {
      ...user,
      memberships: [
        {
          groupId: group.id,
          userId: user.id,
          role: 'admin',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      ],
    },
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  expect(screen.queryByText('Your access')).not.toBeInTheDocument();
  expect(screen.getByText('Manage super admins (you are one)')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Search sessions...')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));
  fireEvent.click(screen.getByRole('button', { name: /Existing session/ }));

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  expect(sessionStorage.getItem('deputies-groups-panel-open')).toBeNull();
});

it('persists and restores the selected access group on groups page refresh', async () => {
  const clientGroup = {
    ...group,
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Client access',
  };
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user, groups: [group, clientGroup] });

  const rendered = render(<App />);
  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Client access/ }));
  expect(sessionStorage.getItem('deputies-groups-panel-selected-group-id')).toBe(clientGroup.id);

  rendered.unmount();
  render(<App />);

  expect(await screen.findByDisplayValue('Client access')).toBeInTheDocument();
});

it('persists and restores the super admins groups page view on refresh', async () => {
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user });

  const rendered = render(<App />);
  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Manage super admins/ }));
  expect(sessionStorage.getItem('deputies-groups-panel-view')).toBe('super_admins');

  rendered.unmount();
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Super admins' })).toBeInTheDocument();
});

it('persists and restores the setup page view on refresh', async () => {
  sessionStorage.setItem('deputies-setup-guide-open', 'true');
  mockApi({ authMode: 'session', currentUser: user });

  const rendered = render(<App />);
  expect(await screen.findByRole('heading', { name: 'Setup guide' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Setup' })).toHaveAttribute('aria-current', 'page');

  rendered.unmount();
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Setup guide' })).toBeInTheDocument();
});

it('opens the sessions sidebar from the setup page', async () => {
  sessionStorage.setItem('deputies-setup-guide-open', 'true');
  mockApi({ authMode: 'session', currentUser: user });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Setup guide' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open sessions' }));

  expect(screen.getByPlaceholderText('Search sessions...')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
});

it('opens the access sidebar from the setup page when access is the active sidebar', async () => {
  sessionStorage.setItem('deputies-setup-guide-open', 'true');
  sessionStorage.setItem('deputies-sidebar-panel', 'groups');
  mockApi({ authMode: 'session', currentUser: user });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Setup guide' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open access' }));

  expect(screen.getByPlaceholderText('Search groups...')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Access' }));
  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
});

it('opens the groups page when selecting an access group from setup', async () => {
  sessionStorage.setItem('deputies-setup-guide-open', 'true');
  sessionStorage.setItem('deputies-sidebar-panel', 'groups');
  mockApi({ authMode: 'session', currentUser: user });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Setup guide' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open access' }));
  fireEvent.click(screen.getByRole('button', { name: /Default group/ }));

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  expect(sessionStorage.getItem('deputies-setup-guide-open')).toBeNull();
  expect(sessionStorage.getItem('deputies-groups-panel-open')).toBe('true');
  expect(sessionStorage.getItem('deputies-groups-panel-selected-group-id')).toBe(group.id);
});

it('collapses member search results after selecting a user', async () => {
  const teammate = {
    id: '00000000-0000-4000-8000-000000000030',
    username: 'teammate',
    displayName: 'Teammate',
    role: 'user',
  };
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user, users: [teammate] });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  const search = screen.getByPlaceholderText('Search by username, display name, or exact user ID');
  fireEvent.change(search, { target: { value: 'team' } });
  fireEvent.click(await screen.findByRole('button', { name: /Teammate/ }));

  expect(screen.getByPlaceholderText('Select a user or paste user ID')).toHaveValue(teammate.id);
  expect(screen.getByText('Selected user: Teammate')).toBeInTheDocument();
  expect(search).toHaveValue('');
  expect(screen.queryByRole('button', { name: /Teammate/ })).not.toBeInTheDocument();
});

it('adds, updates, and removes group members', async () => {
  const teammate = {
    id: '00000000-0000-4000-8000-000000000030',
    username: 'teammate',
    displayName: 'Teammate',
    role: 'user',
  };
  const existingMember = {
    groupId: group.id,
    userId: '00000000-0000-4000-8000-000000000031',
    role: 'viewer',
    user: { id: '00000000-0000-4000-8000-000000000031', username: 'member', displayName: 'Existing member' },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  const groupMemberUpdates: unknown[] = [];
  const removedGroupMembers: string[] = [];
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({
    authMode: 'session',
    currentUser: user,
    groupMembers: [existingMember],
    groupMemberUpdates,
    removedGroupMembers,
    users: [teammate],
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  const memberSearch = screen.getByPlaceholderText('Search by username, display name, or exact user ID');
  fireEvent.change(memberSearch, { target: { value: 'team' } });
  fireEvent.click(await screen.findByRole('button', { name: /Teammate/ }));
  const addMemberRole = screen.getByText('Role').closest('label')?.querySelector('select');
  if (!addMemberRole) throw new Error('Expected add-member role select');
  fireEvent.change(addMemberRole, { target: { value: 'member' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add member' }));

  await waitFor(() => expect(groupMemberUpdates).toContainEqual({ userId: teammate.id, role: 'member' }));
  expect(await screen.findByText('Teammate')).toBeInTheDocument();

  const existingMemberRow = screen.getByText('Existing member').closest('div')?.parentElement;
  if (!existingMemberRow) throw new Error('Expected existing member row');
  fireEvent.change(within(existingMemberRow).getByRole('combobox'), { target: { value: 'admin' } });

  await waitFor(() => expect(groupMemberUpdates).toContainEqual({ userId: existingMember.userId, role: 'admin' }));
  fireEvent.click(within(existingMemberRow).getByRole('button', { name: 'Remove' }));

  await waitFor(() => expect(removedGroupMembers).toEqual([existingMember.userId]));
  expect(screen.queryByText('Existing member')).not.toBeInTheDocument();
});

it('promotes and removes super admins', async () => {
  const candidate = {
    id: '00000000-0000-4000-8000-000000000040',
    username: 'candidate',
    displayName: 'Candidate Admin',
    role: 'user',
  };
  const existingSuperAdmin = {
    id: '00000000-0000-4000-8000-000000000041',
    username: 'boss',
    displayName: 'Boss Admin',
    role: 'super_admin',
  };
  const userRoleUpdates: unknown[] = [];
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user, users: [candidate, existingSuperAdmin], userRoleUpdates });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Manage super admins/ }));
  expect(await screen.findByRole('heading', { name: 'Super admins' })).toBeInTheDocument();

  const search = screen.getByPlaceholderText('Search by username, display name, or exact user ID');
  fireEvent.change(search, { target: { value: 'cand' } });
  fireEvent.click(await screen.findByRole('button', { name: /Candidate Admin/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Promote' }));

  await waitFor(() => expect(userRoleUpdates).toContainEqual({ userId: candidate.id, role: 'super_admin' }));
  expect(await screen.findByText('Candidate Admin')).toBeInTheDocument();

  const bossRow = screen.getByText('Boss Admin').closest('div')?.parentElement;
  if (!bossRow) throw new Error('Expected existing super-admin row');
  fireEvent.click(within(bossRow).getByRole('button', { name: 'Remove' }));

  await waitFor(() => expect(userRoleUpdates).toContainEqual({ userId: existingSuperAdmin.id, role: 'user' }));
});

it('moves archived groups below the archived groups toggle', async () => {
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  const archiveButton = screen.getByText('Archive group').closest('button');
  if (!archiveButton) throw new Error('Expected archive group button');
  fireEvent.click(archiveButton);

  const archivedSummary = await screen.findByText('Archived groups · 1');
  const archivedDetails = archivedSummary.closest('details')!;
  archivedDetails.open = true;
  fireEvent(archivedDetails, new Event('toggle', { bubbles: true }));

  expect(archivedDetails).toHaveAttribute('open');
  expect(sessionStorage.getItem('deputies-archived-groups-open')).toBe('true');
});

it('restores the archived groups toggle after refresh', async () => {
  const archivedGroup = { ...group, archivedAt: session.updatedAt };
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  sessionStorage.setItem('deputies-archived-groups-open', 'true');
  mockApi({ authMode: 'session', currentUser: user, groups: [archivedGroup] });
  render(<App />);

  const archivedSummary = await screen.findByText('Archived groups · 1');
  expect(archivedSummary.closest('details')).toHaveAttribute('open');
});

it('filters groups in the groups sidebar search', async () => {
  const clientGroup = {
    ...group,
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Client access',
  };
  const archivedGroup = {
    ...group,
    id: '00000000-0000-4000-8000-000000000012',
    name: 'Legacy access',
    archivedAt: session.updatedAt,
  };
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user, groups: [group, clientGroup, archivedGroup] });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  const search = screen.getByPlaceholderText('Search groups...');
  const sidebar = search.closest('aside')!;

  fireEvent.change(search, { target: { value: 'legacy' } });

  expect(within(sidebar).getByRole('button', { name: /Manage super admins/ })).toBeInTheDocument();
  expect(within(sidebar).queryByRole('button', { name: /Default group/ })).not.toBeInTheDocument();
  expect(within(sidebar).queryByRole('button', { name: /Client access/ })).not.toBeInTheDocument();
  expect(within(sidebar).getByText('Archived groups · 1').closest('details')).toHaveAttribute('open');
  expect(within(sidebar).getByRole('button', { name: /Legacy access/ })).toBeInTheDocument();

  fireEvent.change(search, { target: { value: 'missing' } });
  expect(within(sidebar).getByText('No matching groups.')).toBeInTheDocument();
});

it('uses the next available default name when creating access groups', async () => {
  const createdGroups: unknown[] = [];
  const newGroup = { ...group, name: 'New access group' };
  const newGroupTwo = {
    ...group,
    id: '00000000-0000-4000-8000-000000000011',
    name: 'New access group 2',
  };
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user, groups: [newGroup, newGroupTwo], createdGroups });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New group' }));

  expect(createdGroups).toHaveLength(0);
  expect(await screen.findByRole('heading', { name: 'New access group' })).toBeInTheDocument();
  expect(screen.getByLabelText('Name')).toHaveValue('New access group 3');
  fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

  await waitFor(() => expect(createdGroups).toHaveLength(1));
  expect(createdGroups[0]).toMatchObject({ name: 'New access group 3' });
});

it('archives access groups from the sidebar', async () => {
  const groupUpdates: unknown[] = [];
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user, groupUpdates });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  const sidebar = screen.getByPlaceholderText('Search groups...').closest('aside')!;
  fireEvent.click(within(sidebar).getByRole('button', { name: 'Archive group' }));

  await waitFor(() => expect(groupUpdates).toHaveLength(1));
  expect(groupUpdates[0]).toMatchObject({ archived: true });
});

it('shows an inline error for duplicate access group names before saving', async () => {
  const clientGroup = {
    ...group,
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Client access',
  };
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user, groups: [group, clientGroup] });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' client ACCESS ' } });

  expect(screen.getByText('An access group with this name already exists.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save group' })).toBeDisabled();
});

it('shows an inline error when the server rejects a duplicate access group name', async () => {
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({
    authMode: 'session',
    currentUser: user,
    groupUpdateStatus: 409,
    groupUpdateError: { error: 'group_name_exists', message: 'Group name already exists' },
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Race access' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }));

  expect(await screen.findByText('An access group with this name already exists.')).toBeInTheDocument();
});

it('saves the group automation creation policy', async () => {
  const groupUpdates: unknown[] = [];
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user, groupUpdates });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  const policyHelp = await screen.findByText('Controls who can create new scheduled automations in this group.');
  const policySelect = policyHelp.closest('label')?.querySelector('select');
  if (!policySelect) throw new Error('Expected automation creation policy select');
  fireEvent.change(policySelect, { target: { value: 'admin' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }));

  await waitFor(() => expect(groupUpdates).toHaveLength(1));
  expect(groupUpdates[0]).toMatchObject({ automationCreateRequiredRole: 'admin' });
});

it('saves session access group when selected', async () => {
  const accessUpdates: unknown[] = [];
  const clientGroup = {
    ...group,
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Client access',
  };
  mockApi({ accessUpdates, authMode: 'session', currentUser: user, groups: [group, clientGroup] });
  render(<App />);

  const contextPanel = within(await screen.findByLabelText('Desktop context'));
  const accessGroup = await contextPanel.findByLabelText('Access group');
  expect(contextPanel.queryByRole('button', { name: 'Save group' })).not.toBeInTheDocument();

  fireEvent.change(accessGroup, { target: { value: clientGroup.id } });

  await waitFor(() => expect(accessGroup).toHaveValue(clientGroup.id));
  await waitFor(() => expect(accessUpdates).toEqual([{ ownerGroupId: clientGroup.id }]));
});

it('shows an organization-visible session owner group name for non-members', async () => {
  const clientGroupId = '00000000-0000-4000-8000-000000000011';
  mockApi({
    authMode: 'session',
    currentUser: { ...user, role: 'user', memberships: [] },
    groups: [],
    sessionOverride: {
      ownerGroupId: clientGroupId,
      ownerGroupName: 'Client access',
      visibility: 'organization',
    },
  });
  render(<App />);

  const contextPanel = within(await screen.findByLabelText('Desktop context'));
  expect(await contextPanel.findByText('Client access')).toBeInTheDocument();
  expect(contextPanel.queryByText(clientGroupId)).not.toBeInTheDocument();
});

it('persists the mobile context panel after refresh', async () => {
  mockApi();

  const rendered = render(<App />);
  await screen.findByRole('heading', { name: 'Existing session' });
  const contextSummary = (await screen.findAllByText('Context')).find((element) => element.tagName === 'SUMMARY');
  expect(contextSummary).toBeDefined();

  const contextDetails = contextSummary!.closest('details')!;
  contextDetails.open = true;
  fireEvent(contextDetails, new Event('toggle', { bubbles: true }));
  expect(sessionStorage.getItem('deputies-mobile-context-open')).toBe('true');

  rendered.unmount();
  render(<App />);

  await screen.findByRole('heading', { name: 'Existing session' });
  const restoredSummary = (await screen.findAllByText('Context')).find((element) => element.tagName === 'SUMMARY');
  expect(restoredSummary?.closest('details')).toHaveAttribute('open');
});

it('archives the selected session before waiting for the archive request', async () => {
  mockApi({ hangArchive: true });
  render(<App />);

  const heading = await screen.findByRole('heading', { name: 'Existing session' });
  const header = heading.closest('section');
  fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Tools' }));
  fireEvent.click(within(header as HTMLElement).getByRole('menuitem', { name: 'Archive session' }));

  expect(screen.getByText('What needs doing?')).toBeInTheDocument();
  expect(sessionStorage.getItem('deputies-selected-session-id')).toBeNull();
  expect(sessionStorage.getItem('deputies-new-session-selected')).toBe('true');
});

it('refreshes sessions when the global event stream reports an external session', async () => {
  const externalSession = {
    ...session,
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

it('keeps initial global event stream replay disabled to avoid loading old events', async () => {
  let streamUrl: URL | undefined;
  mockApi({
    onGlobalStreamRequest: (url) => {
      streamUrl = url;
    },
  });
  render(<App />);

  expect(await screen.findAllByText('Existing session')).not.toHaveLength(0);
  await waitFor(() => expect(streamUrl).toBeDefined());

  expect(streamUrl?.searchParams.get('include')).toBe('all');
  expect(streamUrl?.searchParams.get('replay')).toBe('false');
});

it('refreshes sessions after returning from a hidden tab to catch phone updates', async () => {
  const sessions = [{ ...session }];
  mockApi({ sessions });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();

  setVisibilityState('hidden');
  fireEvent(document, new Event('visibilitychange'));
  sessions[0] = { ...session, status: 'archived' };

  setVisibilityState('visible');
  fireEvent(document, new Event('visibilitychange'));

  expect(await screen.findByText('This session is archived.')).toBeInTheDocument();
});

it('refreshes sessions when a queued message starts processing', async () => {
  const sessions = [{ ...session, status: 'queued' }];
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    sessions,
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  expect(await screen.findAllByText('queued')).not.toHaveLength(0);
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());

  sessions[0] = { ...session, status: 'active' };
  pushGlobalEvent?.(
    eventFixture({ id: 2, sequence: 1, type: 'message_started', payload: { sequences: [1], batchSize: 1 } }),
  );

  expect(await screen.findAllByText('active')).not.toHaveLength(0);
});

it('shows derived session display statuses', async () => {
  const sandboxSession = {
    ...session,
    displayStatus: 'ready',
    displayStatusTooltip: 'Sandbox is active. Filesystem state and exposed services are available.',
    sandbox: {
      id: 'sandbox-1',
      provider: 'fake',
      providerSandboxId: 'fake-1',
      status: 'ready',
      updatedAt: '2026-05-05T12:10:00.000Z',
    },
  };
  const sessions = [sandboxSession];
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    sessions,
    sessionOverride: sandboxSession,
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  expect(await screen.findAllByText('ready')).not.toHaveLength(0);
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());

  sessions[0] = {
    ...sessions[0]!,
    displayStatus: 'stopped',
    displayStatusTooltip: 'Sandbox stopped to control costs. Exposed services are not running.',
    sandbox: { ...sessions[0]!.sandbox, status: 'stopped' },
  };
  pushGlobalEvent?.(eventFixture({ id: 2, sequence: 2, type: 'sandbox_stopped', payload: {} }));

  expect(await screen.findAllByText('stopped')).not.toHaveLength(0);

  sessions[0] = {
    ...sessions[0],
    displayStatus: 'expired',
    displayStatusTooltip: 'Sandbox expired to control costs. Filesystem state was not preserved.',
    sandbox: { ...sessions[0].sandbox, status: 'destroyed' },
  };
  pushGlobalEvent?.(eventFixture({ id: 3, sequence: 3, type: 'sandbox_destroyed', payload: {} }));

  expect(await screen.findAllByText('expired')).not.toHaveLength(0);
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
    messages: [
      {
        id: '00000000-0000-4000-8000-000000000102',
        sessionId: session.id,
        sequence: 1,
        status: 'processing',
        prompt: 'running work',
        createdAt: '2026-05-05T12:01:00.000Z',
      },
    ],
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
    messages: [
      {
        id: '00000000-0000-4000-8000-000000000102',
        sessionId: session.id,
        sequence: 1,
        status: 'cancelling',
        prompt: 'stopping work',
        createdAt: '2026-05-05T12:01:00.000Z',
      },
    ],
  });
  render(<App />);

  const messageCard = await screen.findByRole('article', { name: 'Message 1' });
  expect(within(messageCard).getByRole('button', { name: 'Cancelling...' })).toBeDisabled();
});

it('renders active deputy progress without markdown code chrome', async () => {
  mockApi({
    sessionOverride: { status: 'active' },
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000130',
        sequence: 1,
        status: 'processing',
        prompt: 'stream code',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'agent_text_delta',
        messageId: '00000000-0000-4000-8000-000000000130',
        payload: { sequence: 1, text: 'Working...\n\n```ts\nconst mobile = true;\n```' },
      }),
    ],
  });
  render(<App />);

  expect(await screen.findByText('Deputy progress')).toBeInTheDocument();
  expect(screen.getByLabelText('Deputy progress')).toHaveTextContent('const mobile = true;');
  expect(screen.queryByRole('button', { name: 'Copy code' })).not.toBeInTheDocument();
  expect(codeToHtmlMock).not.toHaveBeenCalled();
});

it('keeps large live deputy progress bounded while streaming', async () => {
  const messageId = '00000000-0000-4000-8000-000000000131';
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    sessionOverride: { status: 'active' },
    messages: [
      messageFixture({
        id: messageId,
        sequence: 1,
        status: 'processing',
        prompt: 'stream a large preview',
      }),
    ],
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  expect(await screen.findByText('stream a large preview')).toBeInTheDocument();
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());

  const deltaCount = 10_000;
  const deltaText = `${'x'.repeat(800)}\n`;
  await act(async () => {
    for (let index = 1; index <= deltaCount; index += 1) {
      pushGlobalEvent?.(
        eventFixture({
          id: index,
          sequence: index,
          type: 'agent_text_delta',
          messageId,
          payload: { sequence: 1, text: deltaText },
        }),
      );
    }
  });

  await waitFor(() => {
    expect(screen.getByLabelText('Deputy progress')).toHaveTextContent('earlier characters hidden');
  });
  expect(screen.getByLabelText('Deputy progress').textContent?.length).toBeLessThan(25_000);
});

it('batches active deputy progress deltas and applies them in sequence order', async () => {
  const messageId = '00000000-0000-4000-8000-000000000132';
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    sessionOverride: { status: 'active' },
    messages: [
      messageFixture({
        id: messageId,
        sequence: 1,
        status: 'processing',
        prompt: 'stream ordered progress',
      }),
    ],
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  expect(await screen.findByText('stream ordered progress')).toBeInTheDocument();
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());

  await act(async () => {
    pushGlobalEvent?.(
      eventFixture({
        id: 3,
        sequence: 3,
        type: 'agent_text_delta',
        messageId,
        payload: { text: 'world' },
      }),
    );
    pushGlobalEvent?.(
      eventFixture({
        id: 2,
        sequence: 2,
        type: 'agent_text_delta',
        messageId,
        payload: { text: 'hello ' },
      }),
    );
  });

  await waitFor(() => {
    expect(screen.getByLabelText('Deputy progress')).toHaveTextContent('hello world');
  });
  expect(screen.getByLabelText('Deputy progress')).not.toHaveTextContent('worldhello');
});

it('retries a failed message from its message card', async () => {
  const retriedMessageIds: string[] = [];
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000120',
        sequence: 1,
        status: 'failed',
        prompt: 'try this again',
      }),
    ],
    onRetryMessage: (messageId) => retriedMessageIds.push(messageId),
  });
  render(<App />);

  const messageCard = await screen.findByRole('article', { name: 'Message 1' });
  fireEvent.click(within(messageCard).getByRole('button', { name: 'Retry' }));

  await waitFor(() => expect(retriedMessageIds).toEqual(['00000000-0000-4000-8000-000000000120']));
  expect(await screen.findByRole('article', { name: 'Message 2' })).toHaveTextContent('try this again');
});

it('retries all failed messages in a failed message group', async () => {
  const retriedMessageIds: string[] = [];
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000121',
        sequence: 1,
        status: 'failed',
        prompt: 'first failed task',
      }),
      messageFixture({
        id: '00000000-0000-4000-8000-000000000122',
        sequence: 2,
        status: 'failed',
        prompt: 'second failed task',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000220',
        messageId: '00000000-0000-4000-8000-000000000121',
        payload: { sequences: [1, 2], batchSize: 2 },
      }),
    ],
    onRetryMessage: (messageId) => retriedMessageIds.push(messageId),
  });
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Retry 2 failed' }));

  await waitFor(() =>
    expect(retriedMessageIds).toEqual(['00000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-000000000122']),
  );
  expect(await screen.findByRole('article', { name: 'Message 3' })).toHaveTextContent('first failed task');
  expect(await screen.findByRole('article', { name: 'Message 4' })).toHaveTextContent('second failed task');
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
  const restoreButton = screen.getAllByRole('button', { name: 'Restore session' }).at(-1);
  if (!restoreButton) throw new Error('Expected restore session button');
  fireEvent.click(restoreButton);

  await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  expect(submittedPrompts).toEqual([]);
});

it('keeps a cancelled middle message inline with its surrounding batch', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000110',
        sequence: 10,
        status: 'completed',
        prompt: 'please sleep for 30 seconds',
      }),
      messageFixture({
        id: '00000000-0000-4000-8000-000000000111',
        sequence: 11,
        status: 'completed',
        prompt: 'message 1',
      }),
      messageFixture({
        id: '00000000-0000-4000-8000-000000000112',
        sequence: 12,
        status: 'cancelled',
        prompt: 'message 2',
      }),
      messageFixture({
        id: '00000000-0000-4000-8000-000000000113',
        sequence: 13,
        status: 'completed',
        prompt: 'message 3',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000210',
        messageId: '00000000-0000-4000-8000-000000000110',
        payload: { sequences: [10, 11, 13], batchSize: 3 },
      }),
      eventFixture({
        sequence: 2,
        type: 'message_cancelled',
        messageId: '00000000-0000-4000-8000-000000000112',
        payload: { sequence: 12 },
      }),
      eventFixture({
        sequence: 3,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000210',
        messageId: '00000000-0000-4000-8000-000000000110',
        payload: { text: 'batch response' },
      }),
    ],
  });
  render(<App />);

  await screen.findByText('batch response');
  const message12 = screen.getByText('message 2');
  const response = screen.getByText('Deputy response');

  expect(message12.compareDocumentPosition(response)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(screen.getAllByText(/Activity/)).toHaveLength(1);
});

it('renders stored image artifacts inline and in the artifacts pane', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000120',
        sequence: 1,
        status: 'completed',
        prompt: 'make an image',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000220',
        messageId: '00000000-0000-4000-8000-000000000120',
        payload: { text: 'Here is the image.' },
      }),
      eventFixture({
        sequence: 2,
        type: 'artifact_created',
        runId: '00000000-0000-4000-8000-000000000220',
        messageId: '00000000-0000-4000-8000-000000000120',
        payload: { artifact: { id: 'artifact-1' } },
      }),
    ],
    artifacts: [
      {
        id: 'artifact-1',
        sessionId: session.id,
        runId: '00000000-0000-4000-8000-000000000220',
        messageId: '00000000-0000-4000-8000-000000000120',
        type: 'image',
        title: 'Generated image',
        storageKey: 'sessions/session/artifacts/artifact-1',
        payload: { contentType: 'image/png', fileName: 'generated.png', sizeBytes: 1234 },
        createdAt: '2026-05-05T12:02:00.000Z',
      },
    ],
  });
  render(<App />);

  expect(await screen.findByText('Here is the image.')).toBeInTheDocument();
  const images = await screen.findAllByRole('img', { name: 'Generated image' });
  expect(images[0]).toHaveAttribute(
    'src',
    `${window.location.origin}/sessions/${session.id}/artifacts/artifact-1/download`,
  );
  expect(screen.getAllByText('image · Generated image').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Download image')).toHaveLength(1);
});

it('renders video artifacts as click-to-load inline players', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  mockApi({
    messages: [
      messageFixture({ id: '00000000-0000-4000-8000-000000000124', sequence: 1, status: 'completed', prompt: 'video' }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000224',
        messageId: '00000000-0000-4000-8000-000000000124',
        payload: { text: 'Video created.' },
      }),
    ],
    artifacts: [
      {
        id: 'video-artifact',
        sessionId: session.id,
        runId: '00000000-0000-4000-8000-000000000224',
        messageId: '00000000-0000-4000-8000-000000000124',
        type: 'file',
        title: 'Demo video',
        storageKey: 'video-key',
        payload: { contentType: 'video/mp4', fileName: 'demo.mp4', sizeBytes: 2048 },
        createdAt: '2026-05-05T12:02:00.000Z',
      },
    ],
  });
  render(<App />);

  expect(await screen.findByText('Video created.')).toBeInTheDocument();
  expect(screen.getByText('Video streams from artifact storage after you press play.')).toBeInTheDocument();
  expect(screen.queryByRole('application')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Play video/ }));

  const video = await waitFor(() => document.querySelector('video'));
  expect(video).toHaveAttribute(
    'src',
    `${window.location.origin}/sessions/${session.id}/artifacts/video-artifact/download?disposition=inline`,
  );
  expect(video).toHaveAttribute('playsinline');
});

it('downloads markdown artifact links through the blob downloader', async () => {
  const createObjectUrl = vi.fn(() => 'blob:markdown-artifact');
  const append = vi.spyOn(document.body, 'append');
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  mockApi({
    messages: [
      messageFixture({ id: '00000000-0000-4000-8000-000000000125', sequence: 1, status: 'completed', prompt: 'link' }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000225',
        messageId: '00000000-0000-4000-8000-000000000125',
        payload: { text: `[download](/sessions/${session.id}/artifacts/video-artifact/download)` },
      }),
    ],
  });
  render(<App />);

  fireEvent.click(await screen.findByRole('link', { name: 'download' }));

  await waitFor(() => expect(createObjectUrl).toHaveBeenCalled());
  const link = append.mock.calls.at(-1)?.[0] as HTMLAnchorElement;
  expect(link.download).toBe('demo.mp4');
  expect(link.href).toBe('blob:markdown-artifact');
});

it('skips large inline image autoload and lazy-loads text previews', async () => {
  mockApi({
    messages: [
      messageFixture({ id: '00000000-0000-4000-8000-000000000121', sequence: 1, status: 'completed', prompt: 'logs' }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000221',
        messageId: '00000000-0000-4000-8000-000000000121',
        payload: { text: 'Artifacts created.' },
      }),
    ],
    artifacts: [
      {
        id: 'large-image',
        sessionId: session.id,
        runId: '00000000-0000-4000-8000-000000000221',
        messageId: '00000000-0000-4000-8000-000000000121',
        type: 'image',
        title: 'Large image',
        storageKey: 'large-image-key',
        payload: { contentType: 'image/png', fileName: 'large.png', sizeBytes: 2_000_000 },
        createdAt: '2026-05-05T12:02:00.000Z',
      },
      {
        id: 'log-artifact',
        sessionId: session.id,
        runId: '00000000-0000-4000-8000-000000000221',
        messageId: '00000000-0000-4000-8000-000000000121',
        type: 'log',
        title: 'Run log',
        storageKey: 'log-key',
        payload: { contentType: 'text/plain', fileName: 'run.log', sizeBytes: 100 },
        createdAt: '2026-05-05T12:02:00.000Z',
      },
    ],
    artifactPreview: { text: 'hello from log', contentType: 'text/plain', truncated: true, sizeBytes: 100 },
  });
  render(<App />);

  expect((await screen.findAllByText('Large image')).length).toBeGreaterThan(0);
  expect(screen.getByText('Large image preview skipped. Open the image to view it.')).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'Large image' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByText('Preview Run log'));
  expect(await screen.findByText('hello from log')).toBeInTheDocument();
  expect(screen.getByText('Preview truncated.')).toBeInTheDocument();
});

it('shows text preview load failures inline', async () => {
  mockApi({
    messages: [
      messageFixture({ id: '00000000-0000-4000-8000-000000000122', sequence: 1, status: 'completed', prompt: 'logs' }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000222',
        messageId: '00000000-0000-4000-8000-000000000122',
        payload: { text: 'Log created.' },
      }),
    ],
    artifacts: [
      {
        id: 'missing-log',
        sessionId: session.id,
        runId: '00000000-0000-4000-8000-000000000222',
        messageId: '00000000-0000-4000-8000-000000000122',
        type: 'log',
        title: 'Missing log',
        storageKey: 'missing-log-key',
        payload: { contentType: 'text/plain', fileName: 'missing.log', sizeBytes: 100 },
        createdAt: '2026-05-05T12:02:00.000Z',
      },
    ],
    artifactPreviewStatus: 404,
  });
  render(<App />);

  fireEvent.click(await screen.findByText('Preview Missing log'));
  expect(await screen.findByText('Request failed with 404')).toBeInTheDocument();
});

it('does not offer text preview for text MIME with binary-looking extension', async () => {
  mockApi({
    messages: [
      messageFixture({ id: '00000000-0000-4000-8000-000000000123', sequence: 1, status: 'completed', prompt: 'file' }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000223',
        messageId: '00000000-0000-4000-8000-000000000123',
        payload: { text: 'File created.' },
      }),
    ],
    artifacts: [
      {
        id: 'wrong-extension',
        sessionId: session.id,
        runId: '00000000-0000-4000-8000-000000000223',
        messageId: '00000000-0000-4000-8000-000000000123',
        type: 'file',
        title: 'Wrong extension',
        storageKey: 'wrong-extension-key',
        payload: { contentType: 'text/plain', fileName: 'wrong-extension.png', sizeBytes: 100 },
        createdAt: '2026-05-05T12:02:00.000Z',
      },
    ],
  });
  render(<App />);

  expect((await screen.findAllByText('file · Wrong extension')).length).toBeGreaterThan(0);
  expect(screen.queryByText('Preview Wrong extension')).not.toBeInTheDocument();
});

it('shows a jump control instead of autoscrolling after the user scrolls up', async () => {
  let pushGlobalEvent: StreamEventPusher = () => undefined;
  let globalStreamOpen = false;
  const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000130',
        sequence: 1,
        status: 'processing',
        prompt: 'long running work',
      }),
    ],
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
  pushGlobalEvent(
    eventFixture({
      id: 2,
      sequence: 1,
      type: 'agent_text_delta',
      messageId: '00000000-0000-4000-8000-000000000130',
      payload: { text: 'streaming diagnostics' },
    }),
  );

  const jump = await screen.findByRole('button', { name: /Jump to latest/ });
  expect(scrollIntoView).not.toHaveBeenCalled();

  fireEvent.click(jump);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' });
});

it('pauses autoscroll while the message composer has focus', async () => {
  let pushGlobalEvent: StreamEventPusher = () => undefined;
  let globalStreamOpen = false;
  const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000137',
        sequence: 1,
        status: 'processing',
        prompt: 'long running work',
      }),
    ],
    onGlobalStreamOpen: (push) => {
      globalStreamOpen = true;
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  const messageLog = setScrollMetrics(await screen.findByRole('log', { name: 'Session messages' }), {
    clientHeight: 500,
    scrollHeight: 2000,
    scrollTop: 1500,
  });
  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  act(() => composer.focus());
  expect(document.activeElement).toBe(composer);
  scrollIntoView.mockClear();

  await waitFor(() => expect(globalStreamOpen).toBe(true));
  pushGlobalEvent(
    eventFixture({
      id: 2,
      sequence: 1,
      type: 'agent_text_delta',
      messageId: '00000000-0000-4000-8000-000000000137',
      payload: { text: 'streaming while typing' },
    }),
  );

  expect(await screen.findByText('streaming while typing')).toBeInTheDocument();
  expect(scrollIntoView).not.toHaveBeenCalled();
  expect(messageLog.scrollTop).toBe(1500);
  await waitFor(() => expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument());
});

it('uses the session message log as the only vertical thread scroller', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000133',
        sequence: 1,
        status: 'completed',
        prompt: 'inspect scroll ownership',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000233',
        messageId: '00000000-0000-4000-8000-000000000133',
        payload: { sequences: [1], batchSize: 1 },
      }),
      eventFixture({
        sequence: 2,
        type: 'tool_started',
        runId: '00000000-0000-4000-8000-000000000233',
        messageId: '00000000-0000-4000-8000-000000000133',
        payload: { toolName: 'shell', toolCallId: 'tool-1', args: { command: 'npm test' } },
      }),
      eventFixture({
        sequence: 3,
        type: 'tool_finished',
        runId: '00000000-0000-4000-8000-000000000233',
        messageId: '00000000-0000-4000-8000-000000000133',
        payload: { toolName: 'shell', toolCallId: 'tool-1', result: 'long output\n'.repeat(100) },
      }),
    ],
  });
  render(<App />);

  const messageLog = await screen.findByRole('log', { name: 'Session messages' });

  expect(messageLog).toHaveClass('overflow-auto');
  expect(messageLog.querySelector('.overflow-auto')).toBeNull();
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
  expect(banner).toHaveClass('fixed');
  expect(banner).toHaveTextContent(/Realtime updates are reconnecting|Connection delayed/);
  expect(banner).toHaveTextContent(/several windows/);
});

it('shows startup connection guidance before request timeout', async () => {
  mockApi({ hangSessions: true });
  render(<App />);

  expect(await screen.findByText('Loading Deputies')).toBeInTheDocument();

  expect(
    await screen.findByText(/Still waiting for the API to respond/, undefined, { timeout: 4_000 }),
  ).toBeInTheDocument();
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
  fireEvent(
    window,
    new CustomEvent('deputies:api-connection-delayed', { detail: { message: 'Request timed out: /sessions' } }),
  );

  const banner = (await screen.findByText('Reconnecting after sleep.')).closest('[role="status"]');
  expect(banner).toHaveTextContent('We will retry automatically');
  expect(banner).not.toHaveTextContent('several windows');
});

it('labels active streamed text as progress and separates obvious sentence boundaries', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000131',
        sequence: 1,
        status: 'processing',
        prompt: 'inspect env',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000231',
        messageId: '00000000-0000-4000-8000-000000000131',
        payload: { text: 'Checking environment.Found Node:System:Ready' },
      }),
    ],
  });
  render(<App />);

  expect(await screen.findByText('Deputy progress')).toBeInTheDocument();
  expect(screen.queryByText('Deputy response')).not.toBeInTheDocument();
  expect(screen.getByText('Checking environment. Found Node: System: Ready')).toBeInTheDocument();
});

it('labels completed assistant text as a response', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000132',
        sequence: 1,
        status: 'completed',
        prompt: 'inspect env',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000232',
        messageId: '00000000-0000-4000-8000-000000000132',
        payload: { text: 'Done.' },
      }),
    ],
  });
  render(<App />);

  expect(await screen.findByText('Deputy response')).toBeInTheDocument();
  expect(screen.queryByText('Deputy progress')).not.toBeInTheDocument();
});

it('shows run diagnostics for a single-message response', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000120',
        sequence: 1,
        status: 'completed',
        prompt: 'single message',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000220',
        messageId: '00000000-0000-4000-8000-000000000120',
        payload: { sequences: [1], batchSize: 1 },
      }),
      eventFixture({
        sequence: 2,
        type: 'sandbox_ready',
        runId: '00000000-0000-4000-8000-000000000220',
        messageId: '00000000-0000-4000-8000-000000000120',
        payload: { provider: 'fake', created: true },
      }),
      eventFixture({
        sequence: 3,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000220',
        messageId: '00000000-0000-4000-8000-000000000120',
        payload: { text: 'single response' },
      }),
    ],
  });
  render(<App />);

  await screen.findByText('single response');

  fireEvent.click(screen.getByText(/Activity · 2 events/));

  expect(await screen.findByText('fake sandbox ready')).toBeInTheDocument();
});

it('renders tool diagnostics as readable activity with raw details collapsed', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000124',
        sequence: 1,
        status: 'completed',
        prompt: 'inspect env',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000224',
        messageId: '00000000-0000-4000-8000-000000000124',
        payload: { sequences: [1], batchSize: 1 },
      }),
      eventFixture({
        sequence: 2,
        type: 'tool_started',
        runId: '00000000-0000-4000-8000-000000000224',
        messageId: '00000000-0000-4000-8000-000000000124',
        payload: { toolName: 'shell', toolCallId: 'tool-1', args: { command: 'pnpm test' } },
      }),
      eventFixture({
        sequence: 3,
        type: 'tool_finished',
        runId: '00000000-0000-4000-8000-000000000224',
        messageId: '00000000-0000-4000-8000-000000000124',
        payload: { toolName: 'shell', toolCallId: 'tool-1', isError: true, result: 'Tests failed' },
      }),
      eventFixture({
        sequence: 4,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000224',
        messageId: '00000000-0000-4000-8000-000000000124',
        payload: { text: 'I ran the tests.' },
      }),
    ],
  });
  render(<App />);

  await screen.findByText('I ran the tests.');
  fireEvent.click(screen.getByText(/Activity · 3 events/));

  expect(await screen.findByText('Command failed: pnpm test')).toBeInTheDocument();
  expect(await screen.findByText(codeTextMatcher('pnpm test'))).toBeInTheDocument();
  expect(screen.getByText('Tests failed')).toBeInTheDocument();
  expect(screen.getAllByText('Debug details')).toHaveLength(2);
  const failedToolCard = screen.getByText('Command failed: pnpm test').closest('article')!;
  expect(within(failedToolCard).queryByText(/#2 · tool_started/)).not.toBeInTheDocument();

  fireEvent.click(within(failedToolCard).getByText('Debug details'));

  expect(await within(failedToolCard).findByText(/#2 · tool_started/)).toBeInTheDocument();
  await waitForHighlightedCodeCount(failedToolCard, 3);
});

it('labels unmatched tool start diagnostics as started instead of running', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000127',
        sequence: 1,
        status: 'completed',
        prompt: 'inspect env',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000227',
        messageId: '00000000-0000-4000-8000-000000000127',
        payload: { sequences: [1], batchSize: 1 },
      }),
      eventFixture({
        sequence: 2,
        type: 'tool_started',
        runId: '00000000-0000-4000-8000-000000000227',
        messageId: '00000000-0000-4000-8000-000000000127',
        payload: { toolName: 'shell', toolCallId: 'tool-1', args: { command: 'pnpm test' } },
      }),
    ],
  });
  render(<App />);

  fireEvent.click(await screen.findByText(/Activity · 2 events/));

  expect(screen.getByText('Command started: pnpm test')).toBeInTheDocument();
  expect(screen.getByText('started')).toBeInTheDocument();
  expect(screen.queryByText('running')).not.toBeInTheDocument();
});

it('renders custom tool text content without exposing the result envelope', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000125',
        sequence: 1,
        status: 'completed',
        prompt: 'push branch',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000225',
        messageId: '00000000-0000-4000-8000-000000000125',
        payload: { sequences: [1], batchSize: 1 },
      }),
      eventFixture({
        sequence: 2,
        type: 'tool_started',
        runId: '00000000-0000-4000-8000-000000000225',
        messageId: '00000000-0000-4000-8000-000000000125',
        payload: { toolName: 'git', toolCallId: 'tool-1' },
      }),
      eventFixture({
        sequence: 3,
        type: 'tool_finished',
        runId: '00000000-0000-4000-8000-000000000225',
        messageId: '00000000-0000-4000-8000-000000000125',
        payload: {
          toolName: 'git',
          toolCallId: 'tool-1',
          isError: false,
          result: {
            content: [{ text: 'exitCode: 0\nstderr:\nremote: Create a pull request', type: 'text' }],
            details: { customTool: 'git' },
          },
        },
      }),
    ],
  });
  render(<App />);

  fireEvent.click(await screen.findByText(/Activity · 3 events/));

  expect(screen.getByText('Git custom tool completed')).toBeInTheDocument();
  const visibleToolOutput = screen.getByText(/remote: Create a pull request/, { selector: 'p' });
  expect(visibleToolOutput).toBeInTheDocument();
  expect(visibleToolOutput).not.toHaveTextContent('customTool');
});

it('renders long diagnostic output inline without a nested scroller', async () => {
  const longOutput = Array.from(
    { length: 12 },
    (_, index) => `line ${index + 1}: expect(messageLogHeight).toBeGreaterThan(300);`,
  ).join('\n');
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000127',
        sequence: 1,
        status: 'completed',
        prompt: 'read a large file',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000227',
        messageId: '00000000-0000-4000-8000-000000000127',
        payload: { sequences: [1], batchSize: 1 },
      }),
      eventFixture({
        sequence: 2,
        type: 'tool_started',
        runId: '00000000-0000-4000-8000-000000000227',
        messageId: '00000000-0000-4000-8000-000000000127',
        payload: { toolName: 'read', toolCallId: 'tool-1' },
      }),
      eventFixture({
        sequence: 3,
        type: 'tool_finished',
        runId: '00000000-0000-4000-8000-000000000227',
        messageId: '00000000-0000-4000-8000-000000000127',
        payload: { toolName: 'read', toolCallId: 'tool-1', result: longOutput },
      }),
    ],
  });
  render(<App />);

  fireEvent.click(await screen.findByText(/Activity · 3 events/));

  const panel = screen.getByRole('region', { name: 'Diagnostic output' });
  expect(panel).not.toHaveClass('max-h-56');
  expect(panel).not.toHaveClass('overflow-auto');
  expect(panel).toHaveTextContent('line 12:');
});

it('renders long diagnostic commands inline without a nested scroller', async () => {
  const longCommand = `python3 - <<'PY'\n${'print("synthetic sunset")\n'.repeat(180)}PY`;
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000128',
        sequence: 1,
        status: 'failed',
        prompt: 'generate an image',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000228',
        messageId: '00000000-0000-4000-8000-000000000128',
        payload: { sequences: [1], batchSize: 1 },
      }),
      eventFixture({
        sequence: 2,
        type: 'tool_started',
        runId: '00000000-0000-4000-8000-000000000228',
        messageId: '00000000-0000-4000-8000-000000000128',
        payload: { toolName: 'shell', toolCallId: 'tool-1', args: { command: longCommand } },
      }),
      eventFixture({
        sequence: 3,
        type: 'tool_finished',
        runId: '00000000-0000-4000-8000-000000000228',
        messageId: '00000000-0000-4000-8000-000000000128',
        payload: {
          toolName: 'shell',
          toolCallId: 'tool-1',
          isError: true,
          result: 'ModuleNotFoundError: No module named PIL',
        },
      }),
    ],
  });
  render(<App />);

  fireEvent.click(await screen.findByText(/Activity · 3 events/));

  const panel = screen.getByRole('region', { name: 'Diagnostic command' });
  expect(panel).not.toHaveClass('max-h-56');
  expect(panel).not.toHaveClass('overflow-auto');
  expect(panel).toHaveTextContent('python3 - <<');
  expect(panel).toHaveTextContent('truncated');
  expect(panel.textContent.length).toBeLessThan(longCommand.length);
  await waitForHighlightedCodeCount(panel, 1);
});

it('identifies upstream sandbox provider failures during sandbox startup', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000123',
        sequence: 7,
        status: 'failed',
        prompt: 'please create a PR with these changes',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000223',
        messageId: '00000000-0000-4000-8000-000000000123',
        payload: { sequences: [7], batchSize: 1 },
      }),
      eventFixture({
        sequence: 2,
        type: 'sandbox_starting',
        runId: '00000000-0000-4000-8000-000000000223',
        messageId: '00000000-0000-4000-8000-000000000123',
        payload: { provider: 'daytona' },
      }),
      eventFixture({
        sequence: 3,
        type: 'run_failed',
        runId: '00000000-0000-4000-8000-000000000223',
        messageId: '00000000-0000-4000-8000-000000000123',
        payload: {
          error: '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>',
        },
      }),
      eventFixture({
        sequence: 4,
        type: 'message_failed',
        runId: '00000000-0000-4000-8000-000000000223',
        messageId: '00000000-0000-4000-8000-000000000123',
        payload: {
          error: '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>',
        },
      }),
    ],
  });
  render(<App />);

  fireEvent.click(await screen.findByText(/Activity · 4 events/));

  expect(screen.getByText('Likely sandbox provider issue')).toBeInTheDocument();
  expect(screen.getByText(/starting a daytona sandbox/)).toBeInTheDocument();
  expect(screen.getByText(/upstream sandbox\/API availability issue/)).toBeInTheDocument();
});

it('prefers final assistant response over streamed deltas', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000121',
        sequence: 1,
        status: 'completed',
        prompt: 'single message',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000221',
        messageId: '00000000-0000-4000-8000-000000000121',
        payload: { sequences: [1], batchSize: 1 },
      }),
      eventFixture({
        sequence: 2,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000221',
        messageId: '00000000-0000-4000-8000-000000000121',
        payload: { text: 'corrupted ' },
      }),
      eventFixture({
        sequence: 3,
        type: 'agent_text_delta',
        runId: '00000000-0000-4000-8000-000000000221',
        messageId: '00000000-0000-4000-8000-000000000121',
        payload: { text: 'stream' },
      }),
      eventFixture({
        sequence: 4,
        type: 'agent_response_final',
        runId: '00000000-0000-4000-8000-000000000221',
        messageId: '00000000-0000-4000-8000-000000000121',
        payload: { text: 'canonical final response' },
      }),
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
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000122',
        sequence: 1,
        status: 'completed',
        prompt: '**please summarize**',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'message_started',
        runId: '00000000-0000-4000-8000-000000000222',
        messageId: '00000000-0000-4000-8000-000000000122',
        payload: { sequences: [1], batchSize: 1 },
      }),
      eventFixture({
        sequence: 2,
        type: 'agent_response_final',
        runId: '00000000-0000-4000-8000-000000000222',
        messageId: '00000000-0000-4000-8000-000000000122',
        payload: {
          text: '# Summary\n\n- **Done**\n\n```ts\nconst ok = true;\n```\n\n| Alpha | Beta | Gamma | Delta |\n| --- | --- | --- | --- |\n| one | two | three | four |\n\n[Docs](https://example.com)\n\n<script>alert(1)</script>',
        },
      }),
    ],
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Summary' })).toBeInTheDocument();
  expect(screen.getByText('Done')).toBeInTheDocument();
  expect(screen.getByText('const ok = true;')).toBeInTheDocument();
  await waitFor(() => expect(document.querySelector('.highlighted-code')).toBeInTheDocument());
  const highlightedCode = document.querySelector('.highlighted-code');
  expect(highlightedCode).not.toHaveClass('highlighted-code-wrap');
  expect(highlightedCode).toHaveClass('overflow-x-auto');
  expect(codeToHtmlMock).toHaveBeenCalledWith('const ok = true;', { lang: 'ts', theme: 'github-light-default' });
  const markdownTable = screen.getByRole('table');
  const tableWrapper = markdownTable.closest('[data-markdown-table-wrapper="true"]');
  expect(tableWrapper).toHaveClass('max-w-full', 'overflow-x-auto', 'touch-pan-x');
  expect(markdownTable).toHaveClass('min-w-full', 'w-max');
  expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', 'https://example.com');
  expect(document.querySelector('script')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('const ok = true;'));
});

it('does not re-highlight assistant code while editing the session title', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000126',
        sequence: 1,
        status: 'completed',
        prompt: 'show code',
      }),
    ],
    events: [
      eventFixture({
        sequence: 1,
        type: 'agent_response_final',
        runId: '00000000-0000-4000-8000-000000000226',
        messageId: '00000000-0000-4000-8000-000000000126',
        payload: { text: '```ts\nconst ok = true;\n```' },
      }),
    ],
  });
  render(<App />);

  await waitFor(() => expect(document.querySelector('.highlighted-code')).toBeInTheDocument());
  codeToHtmlMock.mockClear();

  fireEvent.click(screen.getByRole('button', { name: 'Edit title' }));
  fireEvent.change(screen.getByDisplayValue('Existing session'), { target: { value: 'Existing session updated' } });
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  expect(codeToHtmlMock).not.toHaveBeenCalled();
});

it('renders user prompts as plain text so Slack author lines are visible', async () => {
  mockApi({
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000123',
        sequence: 1,
        status: 'completed',
        prompt: 'Current tagged Slack message:\n---\n[sid]: reply "hello"',
      }),
    ],
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
        prompt:
          'This Deputies session is archived, so I did not queue your message. Reply `unarchive and proceed` to restore the session and queue your reply.',
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
    callbacks: [
      callbackFixture({
        id: '00000000-0000-4000-8000-000000000301',
        status: 'failed',
        attempts: 5,
        maxAttempts: 5,
        lastError: 'HTTP callback returned 500',
      }),
    ],
    onReplayCallback: (callbackId) => replays.push(callbackId),
  });
  render(<App />);

  const contextPanel = within(await screen.findByLabelText('Desktop context'));
  fireEvent.click(await contextPanel.findByLabelText('http callback failed'));
  expect(contextPanel.getByText('Type: Completion reply')).toBeVisible();
  expect(contextPanel.getByText('Last error: HTTP callback returned 500')).toBeVisible();
  fireEvent.click(contextPanel.getByRole('button', { name: /Replay callback/ }));

  await waitFor(() => expect(replays).toEqual(['00000000-0000-4000-8000-000000000301']));
  expect(await screen.findAllByText('pending')).not.toHaveLength(0);
});

it('preserves selected archived session and archived section after refresh', async () => {
  const archivedSession = { ...session, status: 'archived', title: 'Archived chosen' };
  sessionStorage.setItem('deputies-selected-session-id', archivedSession.id);
  sessionStorage.setItem('deputies-archived-sessions-open', 'true');
  mockApi({
    sessionOverride: archivedSession,
    sessions: [
      {
        ...session,
        id: '00000000-0000-4000-8000-000000000002',
        title: 'Top active',
        updatedAt: '2026-05-05T12:05:00.000Z',
      },
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

  const archiveButton = (await screen.findAllByRole('button', { name: 'Archive session' }))[0];
  if (!archiveButton) throw new Error('Expected archive session button');
  fireEvent.click(archiveButton);

  expect(await screen.findByText('What needs doing?')).toBeInTheDocument();
  expect(sessionStorage.getItem('deputies-selected-session-id')).toBeNull();
  expect(sessionStorage.getItem('deputies-new-session-selected')).toBe('true');

  first.unmount();
  render(<App />);

  expect(await screen.findByText('What needs doing?')).toBeInTheDocument();
  expect(screen.queryByText('This session is archived.')).not.toBeInTheDocument();
});

it('opens a session link over the persisted new-session page', async () => {
  sessionStorage.setItem('deputies-new-session-selected', 'true');
  window.history.replaceState({}, '', `/?session=${session.id}`);
  mockApi();
  render(<App />);

  expect(
    await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...'),
  ).toBeInTheDocument();
  expect(screen.queryByText('What needs doing?')).not.toBeInTheDocument();
});

it('restores the selected session before waiting for the restore request', async () => {
  const archivedSession = { ...session, status: 'archived', title: 'Archived chosen' };
  sessionStorage.setItem('deputies-selected-session-id', archivedSession.id);
  mockApi({ sessionOverride: archivedSession, sessions: [archivedSession], hangUnarchive: true });
  render(<App />);

  expect(await screen.findByText('This session is archived.')).toBeInTheDocument();
  const restoreButton = screen
    .getAllByRole('button', { name: 'Restore session' })
    .find((button) => button.textContent?.includes('Restore session'));
  if (!restoreButton) throw new Error('Expected restore session button');
  fireEvent.click(restoreButton);

  expect(screen.queryByText('This session is archived.')).not.toBeInTheDocument();
  expect(
    screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...'),
  ).not.toBeDisabled();
});

it('warns when running in unsafe local sandbox mode', async () => {
  mockApi({ sandboxProvider: 'unsafe-local' });
  render(<App />);

  expect(await screen.findByText('Unsafe local sandbox mode is not a security boundary.')).toBeInTheDocument();
  expect(screen.getByText(/Commands run on the API\/worker host runtime/)).toBeInTheDocument();
});

it('shows health notices from the API', async () => {
  mockApi({
    notices: [
      {
        severity: 'warning',
        code: 'openai_codex_auth_unavailable',
        message: 'Codex auth is unavailable.',
        action: 'Re-authenticate Codex, then refresh this page.',
      },
    ],
  });
  render(<App />);

  expect(await screen.findByText('Codex auth is unavailable.')).toBeInTheDocument();
  expect(screen.getByText(/Re-authenticate Codex/)).toBeInTheDocument();
});

function mockApi(options: MockApiOptions = {}) {
  let currentSession = { ...session, ...options.sessionOverride };
  let currentUser = options.currentUser;
  let callbacks = options.callbacks ?? [];
  let messages = options.messages ?? [];
  let groupMembers = options.groupMembers ?? [];
  let sessionsRequestCount = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const method = init?.method ?? 'GET';

    if (url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        runMode: 'combined',
        apiAuthMode: options.authMode ?? 'none',
        sandboxProvider: options.sandboxProvider ?? 'fake',
        hideSetupPage: true,
        ...(options.notices ? { notices: options.notices } : {}),
      });
    }

    if (url.pathname === '/auth/me') {
      return currentUser
        ? jsonResponse({ user: currentUser })
        : jsonResponse({ error: 'unauthorized', message: 'Missing or invalid session' }, 401);
    }

    if (url.pathname === '/auth/login' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { username: string; password: string };
      options.logins?.push(body);
      currentUser = { ...user, username: body.username };
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

    if (url.pathname === '/sessions' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Partial<typeof session>;
      currentSession = {
        ...currentSession,
        ...body,
        id: '00000000-0000-4000-8000-000000000102',
        title: 'start work',
        createdAt: '2026-05-05T12:01:00.000Z',
        updatedAt: '2026-05-05T12:01:00.000Z',
      };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname === '/repositories' && method === 'GET') {
      return jsonResponse({
        repositories: options.repositories ?? [
          { fullName: 'owner/repo', owner: 'owner', name: 'repo', defaultBranch: 'main' },
        ],
      });
    }

    if (url.pathname === '/repositories/owner/repo/branches' && method === 'GET') {
      return jsonResponse({ branches: options.branches ?? [{ name: 'main' }, { name: 'feature' }] });
    }

    if (url.pathname === '/models' && method === 'GET') {
      const models = options.models ?? ['anthropic/claude-sonnet', 'openai/gpt-4.1'];
      return jsonResponse({ models, defaultModel: models[0] ?? null });
    }

    if (url.pathname === '/setup/status' && method === 'GET') {
      return jsonResponse({ checkedAt: session.updatedAt, items: [] });
    }

    if (url.pathname === '/groups' && method === 'GET') {
      return jsonResponse({ groups: options.groups ?? [group] });
    }

    if (url.pathname === '/groups' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      options.createdGroups?.push(body);
      return jsonResponse({ group: { ...group, id: '00000000-0000-4000-8000-000000000011', name: body.name } }, 201);
    }

    if (url.pathname.match(/^\/groups\/[^/]+$/) && method === 'PATCH') {
      if (options.groupUpdateStatus) {
        return jsonResponse(
          options.groupUpdateError ?? { error: 'group_name_exists', message: 'Group name already exists' },
          options.groupUpdateStatus,
        );
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      options.groupUpdates?.push(body);
      const archivedAt = body.archived === true ? session.updatedAt : undefined;
      const archivedPatch = body.archived === undefined ? {} : archivedAt ? { archivedAt } : { archivedAt: undefined };
      return jsonResponse({ group: { ...group, ...body, ...archivedPatch } });
    }

    if (url.pathname.match(/^\/groups\/[^/]+\/members$/) && method === 'GET') {
      return jsonResponse({ members: groupMembers });
    }

    if (url.pathname.match(/^\/groups\/[^/]+\/members$/) && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { userId: string; role: string };
      options.groupMemberUpdates?.push(body);
      const selectedUser = options.users?.find(
        (candidate): candidate is typeof user =>
          Boolean(candidate) && typeof candidate === 'object' && (candidate as { id?: unknown }).id === body.userId,
      );
      const member = {
        groupId: group.id,
        userId: body.userId,
        role: body.role,
        ...(selectedUser ? { user: selectedUser } : {}),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
      groupMembers = [
        member,
        ...groupMembers.filter((candidate) => (candidate as { userId?: string }).userId !== body.userId),
      ];
      return jsonResponse({ member });
    }

    if (url.pathname.match(/^\/groups\/[^/]+\/members\/[^/]+$/) && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { role: string };
      const userId = url.pathname.split('/').pop()!;
      options.groupMemberUpdates?.push({ userId, role: body.role });
      const selectedUser = options.users?.find(
        (candidate): candidate is typeof user =>
          Boolean(candidate) && typeof candidate === 'object' && (candidate as { id?: unknown }).id === userId,
      );
      const member = {
        groupId: group.id,
        userId,
        role: body.role,
        ...(selectedUser ? { user: selectedUser } : {}),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
      groupMembers = groupMembers.map((candidate) =>
        (candidate as { userId?: string }).userId === userId ? member : candidate,
      );
      return jsonResponse({ member });
    }

    if (url.pathname.match(/^\/groups\/[^/]+\/members\/[^/]+$/) && method === 'DELETE') {
      const userId = url.pathname.split('/').pop()!;
      options.removedGroupMembers?.push(userId);
      groupMembers = groupMembers.filter((candidate) => (candidate as { userId?: string }).userId !== userId);
      return jsonResponse({ ok: true });
    }

    if (url.pathname === '/users' && method === 'GET') {
      return jsonResponse({ users: options.users ?? [user] });
    }

    if (url.pathname.match(/^\/users\/[^/]+$/) && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { role: string };
      const userId = url.pathname.split('/').pop()!;
      options.userRoleUpdates?.push({ userId, role: body.role });
      const selectedUser =
        (options.users?.find(
          (candidate) =>
            Boolean(candidate) && typeof candidate === 'object' && (candidate as { id?: unknown }).id === userId,
        ) as Record<string, unknown> | undefined) ?? user;
      return jsonResponse({ user: { ...selectedUser, id: userId, role: body.role } });
    }

    if (url.pathname === `/sessions/${currentSession.id}/unarchive` && method === 'POST') {
      if (options.hangUnarchive) return new Promise<Response>(() => undefined);
      currentSession = { ...currentSession, status: 'idle' };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname === `/sessions/${currentSession.id}/archive` && method === 'POST') {
      if (options.hangArchive) return new Promise<Response>(() => undefined);
      currentSession = { ...currentSession, status: 'archived' };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname === `/sessions/${currentSession.id}` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { title?: string };
      currentSession = { ...currentSession, ...(body.title ? { title: body.title } : {}) };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname === `/sessions/${currentSession.id}/access` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as Partial<typeof session>;
      options.accessUpdates?.push(body);
      currentSession = { ...currentSession, ...body };
      return jsonResponse({ session: currentSession });
    }

    const messagesListMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
    if (messagesListMatch && method === 'GET') {
      const sessionId = messagesListMatch[1]!;
      if (options.hangMessagesForSessions?.includes(sessionId)) return new Promise<Response>(() => undefined);
      return jsonResponse({ messages: options.messagesBySession?.[sessionId] ?? messages });
    }

    if (url.pathname === `/sessions/${currentSession.id}/messages` && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { prompt: string };
      options.submittedPrompts?.push(body.prompt);
      options.submittedMessageBodies?.push(body);
      const message = {
        id: '00000000-0000-4000-8000-000000000101',
        sessionId: currentSession.id,
        sequence: 1,
        status: 'pending',
        prompt: body.prompt,
        createdAt: '2026-05-05T12:01:00.000Z',
      };
      messages = [...messages, message];
      return jsonResponse({ message }, 202);
    }

    const retryMessageMatch = url.pathname.match(new RegExp(`^/sessions/${currentSession.id}/messages/([^/]+)/retry$`));
    if (retryMessageMatch && method === 'POST') {
      const messageId = retryMessageMatch[1]!;
      options.onRetryMessage?.(messageId);
      const failedMessage = messages.find((message) => (message as { id?: string }).id === messageId) as
        | { prompt?: string; source?: string; context?: Record<string, unknown> }
        | undefined;
      const retriedMessage = {
        id: `00000000-0000-4000-8000-0000000009${messages.length + 1}`,
        sessionId: currentSession.id,
        sequence: messages.length + 1,
        status: 'pending',
        prompt: failedMessage?.prompt ?? 'retried message',
        ...(failedMessage?.source ? { source: failedMessage.source } : {}),
        ...(failedMessage?.context ? { context: failedMessage.context } : {}),
        createdAt: '2026-05-05T12:05:00.000Z',
      };
      messages = [...messages, retriedMessage];
      return jsonResponse({ message: retriedMessage }, 202);
    }

    if (url.pathname === `/sessions/${currentSession.id}/runs/current/cancel` && method === 'POST') {
      options.onCancelRun?.();
      return jsonResponse({ messages: messages.map((message) => ({ ...(message as object), status: 'cancelling' })) });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/events$/)) {
      return jsonResponse({ events: filterEventsAfter(options.events ?? [], url.searchParams.get('after')) });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/artifacts$/)) {
      if (options.hangArtifacts) return new Promise<Response>(() => undefined);
      return jsonResponse({ artifacts: options.artifacts ?? [] });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/services$/)) {
      return jsonResponse({ services: options.services ?? [] });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/external-resources$/)) {
      return jsonResponse({ externalResources: options.externalResources ?? [] });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/artifacts\/[^/]+\/preview$/)) {
      if (options.artifactPreviewStatus)
        return jsonResponse({ error: 'not_found', message: 'Request failed with 404' }, options.artifactPreviewStatus);
      return jsonResponse({
        preview: options.artifactPreview ?? {
          text: 'preview text',
          contentType: 'text/plain',
          truncated: false,
          sizeBytes: 12,
        },
      });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/artifacts\/[^/]+\/download$/)) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          'content-type': 'video/mp4',
          'content-disposition': 'attachment; filename="demo.mp4"; filename*=UTF-8\'\'demo.mp4',
        },
      });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/callbacks$/) && method === 'GET') {
      return jsonResponse({ callbacks });
    }

    const replayMatch = url.pathname.match(new RegExp(`^/sessions/${currentSession.id}/callbacks/([^/]+)/replay$`));
    if (replayMatch && method === 'POST') {
      const callbackId = replayMatch[1]!;
      options.onReplayCallback?.(callbackId);
      callbacks = callbacks.map((callback) => ({
        ...(callback as object),
        status: 'pending',
        maxAttempts: 6,
        updatedAt: '2026-05-05T12:04:00.000Z',
        nextAttemptAt: '2026-05-05T12:04:00.000Z',
      }));
      return jsonResponse({ callback: callbacks.find((callback) => (callback as { id?: string }).id === callbackId) });
    }

    if (url.pathname === `/sessions/${currentSession.id}/events/stream`) {
      return new Response(
        new ReadableStream({
          start(controller) {
            const pushStreamEvent: StreamEventPusher = (event) => {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            options.onStreamOpen?.(pushStreamEvent);
          },
        }),
        { status: 200 },
      );
    }

    if (url.pathname === '/events/stream') {
      options.onGlobalStreamRequest?.(url);
      if (options.globalStreamStatus) return new Response(null, { status: options.globalStreamStatus });
      return new Response(
        new ReadableStream({
          start(controller) {
            const pushStreamEvent: StreamEventPusher = (event) => {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            options.onGlobalStreamOpen?.(pushStreamEvent);
          },
        }),
        { status: 200 },
      );
    }

    return jsonResponse({ error: 'not_found', message: 'Not found' }, 404);
  });
}

type ScrollMetrics = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop?: number;
};

function setScrollMetrics(element: Element | null, metrics: ScrollMetrics): HTMLElement {
  if (!(element instanceof HTMLElement)) throw new Error('Expected an HTMLElement for scroll metrics');
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    scrollTop: { configurable: true, writable: true, value: metrics.scrollTop ?? 0 },
  });
  return element;
}

function messageFixture(input: {
  id: string;
  sequence: number;
  status: string;
  prompt: string;
  source?: string;
  context?: Record<string, unknown>;
}) {
  return {
    ...input,
    sessionId: session.id,
    createdAt: '2026-05-05T12:01:00.000Z',
  };
}

function mockMobileTextEntryViewport() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(hover: none) and (pointer: coarse)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function eventFixture(input: {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  id?: number;
  runId?: string;
  messageId?: string;
}) {
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

function codeTextMatcher(text: string): (_: string, element: Element | null) => boolean {
  return (_, element) => element?.tagName.toLowerCase() === 'code' && element.textContent === text;
}

async function waitForHighlightedCodeCount(container: ParentNode, count: number): Promise<void> {
  await waitFor(() => expect(container.querySelectorAll('.highlighted-code')).toHaveLength(count));
}

function callbackFixture(input: {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
}) {
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
