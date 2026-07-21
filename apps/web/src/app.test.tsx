import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { App } from './app.js';
import { listEvents, listIncrementalEvents, type ReasoningLevel } from './api.js';
import { request } from './api-request.js';

const { codeToHtmlMock } = vi.hoisted(() => ({
  codeToHtmlMock: vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`),
}));

vi.mock('shiki', () => ({ codeToHtml: codeToHtmlMock }));

const session = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'idle',
  spawnDepth: 0,
  title: 'Existing session',
  ownerGroupId: '00000000-0000-4000-8000-000000000010',
  visibility: 'organization',
  writePolicy: 'group_members',
  createdByUserId: '00000000-0000-4000-8000-000000000020',
  createdAt: '2026-05-05T12:00:00.000Z',
  updatedAt: '2026-05-05T12:00:00.000Z',
  lastActivityAt: '2026-05-05T12:00:00.000Z',
  tags: [] as string[],
  starred: false,
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
  requests?: string[];
  accessUpdates?: unknown[];
  repositories?: unknown[];
  branches?: unknown[];
  models?: string[];
  defaultReasoningLevel?: ReasoningLevel;
  messages?: unknown[];
  messagesBySession?: Record<string, unknown[]>;
  events?: unknown[];
  eventsBySession?: Record<string, unknown[]>;
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
  sessionTags?: unknown[];
  sessionsNextCursor?: string | null;
  onListSessionsRequest?: (request: { count: number; url: URL }) => Response | Promise<Response> | undefined;
  onGetSessionRequest?: (sessionId: string) => Response | Promise<Response> | undefined;
  onUpdateAccessRequest?: (body: Record<string, unknown>) => Response | Promise<Response>;
  onStarSessionRequest?: (request: { starred: boolean }) => Response | Promise<Response> | undefined;
  sessionDetailStatusById?: Record<string, number>;
  searchResults?: unknown[];
  searchNextCursor?: string | null;
  callbacks?: unknown[];
  sessionOverride?: Partial<typeof session> & {
    context?: Record<string, unknown>;
    displayStatus?: string;
    displayStatusTooltip?: string;
    directChildCount?: number;
    ownerGroupName?: string;
    queuePausedAt?: string;
    sandbox?: Record<string, unknown>;
  };
  onCancelRun?: () => void;
  onRetryMessage?: (messageId: string) => void;
  onReplayCallback?: (callbackId: string) => void;
  onMessageSubmitRequest?: (request: { count: number; body: Record<string, unknown> }) => Response | Promise<Response>;
  onStreamOpen?: (push: StreamEventPusher) => void;
  onGlobalStreamOpen?: (push: StreamEventPusher, close: () => void) => void;
  onGlobalStreamRequest?: (url: URL, count: number) => Response | Promise<Response> | void;
  onListEventsRequest?: (request: {
    count: number;
    sessionId: string;
    url: URL;
  }) => Response | Promise<Response> | undefined;
  onListSessions?: (count: number) => void;
  globalStreamStatus?: number;
  hangArchive?: boolean;
  archiveStatus?: number;
  hangMessagesForSessions?: string[];
  hangIncrementalEventsForSessions?: string[];
  hangArtifacts?: boolean;
  hangSessions?: boolean;
  hangUnarchive?: boolean;
  hangSessionsAfterFirst?: boolean;
  authMode?: 'none' | 'bearer' | 'session';
  sandboxProvider?: string;
  currentUser?: (typeof user & { memberships?: unknown[] }) | null;
  notices?: unknown[];
  environments?: unknown[];
  environmentRevisions?: Record<string, unknown[]>;
  skills?: unknown[];
  snippets?: unknown[];
  invocationSkills?: unknown[];
  invocationCandidateOwnerGroupIds?: string[];
  invocationCandidateStatus?: number;
  skillListStatusByScope?: Partial<Record<'personal' | 'group' | 'shared', number>>;
  onListSessionSkillsRequest?: (request: {
    count: number;
    sessionId: string;
  }) => Response | Promise<Response> | undefined;
  onListServicesRequest?: (count: number) => Response | Promise<Response> | undefined;
  workspaceToolResponse?: {
    tool: { id: 'ide' | 'diff'; label: string };
    service: { port: number; url: string; status?: 'available' | 'unavailable' | 'unknown' };
    session: typeof session & {
      sandbox?: { id: string; provider: string; providerSandboxId: string; status: string; updatedAt: string };
    };
  };
  archivedSkillIds?: string[];
  onSnippetMutationRequest?: (request: { path: string; method: string; body: unknown }) => Response | Promise<Response>;
  archivedSessionIds?: string[];
  messageSubmitError?: { status: number; body: unknown };
  logins?: Array<{ username: string; password: string }>;
  abortedRequests?: string[];
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

it('bounds incremental session event reconciliation to one page', async () => {
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    requests.push(`${url.pathname}${url.search}`);
    return jsonResponse({
      events: [eventFixture({ sequence: 8, type: 'message_completed', payload: { sequence: 1 } })],
      cursor: 8,
      hasMore: true,
    });
  });

  const events = await listIncrementalEvents(session.id, 'secret', 7);

  expect(events.map((event) => event.sequence)).toEqual([8]);
  expect(requests).toEqual([`/sessions/${session.id}/events?limit=1000&after=7`]);
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

it('aborts API response body reads after headers arrive', async () => {
  const abort = new AbortController();
  let bodyAborted = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    return new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            bodyAborted = true;
            controller.error(new DOMException('Aborted', 'AbortError'));
          });
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });

  const response = request('/slow', { signal: abort.signal });
  await Promise.resolve();
  abort.abort();

  await expect(response).rejects.toMatchObject({ name: 'AbortError' });
  expect(bodyAborted).toBe(true);
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

it('hides skills navigation and pickers when the skills API is disabled', async () => {
  mockApi();
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: '/' } });
  expect(screen.queryByRole('listbox', { name: 'Available skills' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Switch page, current page Sessions' }));
  expect(screen.queryByRole('menuitem', { name: /Skills/ })).not.toBeInTheDocument();
});

it('opens the skills admin panel and sidebar when the skills API is available', async () => {
  mockApi({ skills: [] });
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Switch page, current page Sessions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Skills/ }));
  expect(await screen.findByRole('heading', { name: 'Agent skills' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Search skills...')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'New skill' })).toBeInTheDocument();
});

it('loads an exact historical environment revision from the URL', async () => {
  window.history.replaceState({}, '', '/?environment=environment-1&revision=environment-revision-1');
  mockApi({
    environments: [environmentFixture()],
    repositories: [
      { fullName: 'owner/current-repo', owner: 'owner', name: 'current-repo' },
      { fullName: 'owner/historical-repo', owner: 'owner', name: 'historical-repo' },
    ],
    environmentRevisions: {
      'environment-1': [
        environmentRevisionFixture('environment-revision-2', 2, 'current-repo'),
        environmentRevisionFixture('environment-revision-1', 1, 'historical-repo'),
      ],
    },
  });

  render(<App />);

  expect(await screen.findByText(/Name, owner, and sharing reflect the current environment/)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText('Repository 1')).toHaveTextContent('owner/historical-repo'));
  expect(screen.getByLabelText('Name')).toHaveValue('Production');
  expect(screen.getByLabelText('Name')).toBeDisabled();
  expect(window.location.search).toBe('?environment=environment-1&revision=environment-revision-1');
});

it('guards revision changes from a dirty environment editor', async () => {
  window.history.replaceState({}, '', '/?environment=environment-1');
  mockApi({
    environments: [environmentFixture()],
    repositories: [
      { fullName: 'owner/current-repo', owner: 'owner', name: 'current-repo' },
      { fullName: 'owner/historical-repo', owner: 'owner', name: 'historical-repo' },
    ],
    environmentRevisions: {
      'environment-1': [
        environmentRevisionFixture('environment-revision-2', 2, 'current-repo'),
        environmentRevisionFixture('environment-revision-1', 1, 'historical-repo'),
      ],
    },
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<App />);

  const name = await screen.findByLabelText('Name');
  fireEvent.change(name, { target: { value: 'Unsaved environment' } });
  await screen.findByText('Unsaved changes');
  fireEvent.click(screen.getByLabelText('Revision'));
  fireEvent.click(screen.getByRole('option', { name: /Revision 1.*Historical/ }));

  expect(confirm).toHaveBeenCalledWith('Discard unsaved environment changes?');
  expect(name).toHaveValue('Unsaved environment');
  expect(window.location.search).toBe('?environment=environment-1');

  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByLabelText('Revision'));
  fireEvent.click(screen.getByRole('option', { name: /Revision 1.*Historical/ }));
  expect(await screen.findByText(/Viewing repository configuration from revision 1/)).toBeInTheDocument();
  expect(window.location.search).toBe('?environment=environment-1&revision=environment-revision-1');
});

it('does not prompt to discard changes after saving an environment', async () => {
  window.history.replaceState({}, '', '/?environment=environment-1');
  mockApi({
    environments: [environmentFixture()],
    repositories: [{ fullName: 'owner/current-repo', owner: 'owner', name: 'current-repo' }],
  });
  const confirm = vi.spyOn(window, 'confirm');
  render(<App />);

  const save = await screen.findByRole('button', { name: 'Save environment' });
  const name = await screen.findByLabelText('Name');
  fireEvent.change(name, { target: { value: 'Updated production' } });
  fireEvent.click(save);

  await waitFor(() => expect(name).toHaveValue('Updated production'));
  expect(confirm).not.toHaveBeenCalled();
});

it('keeps skills navigation available when one group skill list fails', async () => {
  mockApi({ skills: [], skillListStatusByScope: { group: 403 } });
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Switch page, current page Sessions' }));
  expect(screen.getByRole('menuitem', { name: /Skills/ })).toBeInTheDocument();
});

it('confirms before leaving a skill with unsaved changes', async () => {
  mockApi({
    skills: [
      {
        id: 'skill-1',
        name: 'review-change',
        description: 'Review a change carefully.',
        currentRevisionId: 'revision-2',
        currentRevisionNumber: 2,
        body: '# Review',
        ownerKind: 'user',
        autoLoad: true,
        enabled: true,
        shareMode: 'none',
        source: 'personal',
        canManage: true,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ],
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Switch page, current page Sessions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Skills/ }));
  fireEvent.click((await screen.findByText('review-change')).closest('button')!);
  fireEvent.change(await screen.findByLabelText(/^Description/), { target: { value: 'Unsaved edit.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Switch page, current page Skills' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Sessions/ }));

  expect(confirm).toHaveBeenCalledWith('Discard unsaved skill changes?');
  expect(screen.getByRole('heading', { name: 'Agent skills' })).toBeInTheDocument();

  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Switch page, current page Skills' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Sessions/ }));
  expect(
    await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...'),
  ).toBeVisible();
});

it('does not prompt to discard changes after saving a skill', async () => {
  mockApi({
    skills: [
      {
        id: 'skill-1',
        name: 'review-change',
        description: 'Review a change carefully.',
        currentRevisionId: 'revision-2',
        currentRevisionNumber: 2,
        body: '# Review',
        ownerKind: 'user',
        autoLoad: true,
        enabled: true,
        shareMode: 'none',
        source: 'personal',
        canManage: true,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ],
  });
  const confirm = vi.spyOn(window, 'confirm');
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Switch page, current page Sessions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Skills/ }));
  fireEvent.click((await screen.findByText('review-change')).closest('button')!);
  fireEvent.change(await screen.findByLabelText(/^Description/), { target: { value: 'Updated review guidance.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));

  await waitFor(() => expect(screen.getByLabelText(/^Description/)).toHaveValue('Updated review guidance.'));
  expect(confirm).not.toHaveBeenCalled();
});

it('does not prompt to discard changes after saving skill sharing', async () => {
  mockApi({
    skills: [
      {
        id: 'skill-1',
        name: 'review-change',
        description: 'Review a change carefully.',
        currentRevisionId: 'revision-2',
        currentRevisionNumber: 2,
        body: '# Review',
        ownerKind: 'group',
        ownerGroupId: group.id,
        autoLoad: true,
        enabled: true,
        shareMode: 'none',
        source: 'group',
        canManage: true,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ],
  });
  const confirm = vi.spyOn(window, 'confirm');
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Switch page, current page Sessions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Skills/ }));
  fireEvent.click((await screen.findByText('review-change')).closest('button')!);
  fireEvent.click(await screen.findByLabelText('All groups'));
  fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save skill' })).toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Switch page, current page Skills' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Sessions/ }));

  expect(confirm).not.toHaveBeenCalled();
});

it('protects dirty skill edits when archiving from the sidebar and allows restore after success', async () => {
  const archivedSkillIds: string[] = [];
  mockApi({
    archivedSkillIds,
    skills: [
      {
        id: 'skill-1',
        name: 'review-change',
        description: 'Review a change carefully.',
        body: '# Review',
        ownerKind: 'user',
        autoLoad: true,
        enabled: true,
        shareMode: 'none',
        source: 'personal',
        canManage: true,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ],
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Switch page, current page Sessions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Skills/ }));
  fireEvent.click((await screen.findByText('review-change')).closest('button')!);
  const description = await screen.findByLabelText(/^Description/);
  fireEvent.change(description, { target: { value: 'Unsaved edit.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Archive review-change skill' }));

  expect(confirm).toHaveBeenCalledWith('Discard unsaved changes and archive this skill?');
  expect(archivedSkillIds).toEqual([]);
  expect(description).toHaveValue('Unsaved edit.');

  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Archive review-change skill' }));

  await waitFor(() => expect(archivedSkillIds).toEqual(['skill-1']));
  await waitFor(() => expect(screen.getByLabelText(/^Description/)).toHaveValue('Review a change carefully.'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Restore skill' })).toBeEnabled());
});

it('converts an exact leading slash skill into message context and renders the sent chip', async () => {
  const submittedMessageBodies: unknown[] = [];
  mockApi({
    submittedMessageBodies,
    skills: [
      {
        id: 'skill-1',
        name: 'review-change',
        description: 'Review a change carefully.',
        currentRevisionId: 'revision-2',
        currentRevisionNumber: 2,
        autoLoad: false,
        enabled: true,
        shareMode: 'none',
        source: 'personal',
        provenance: { kind: 'personal' },
        canManage: true,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ],
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: '/review-change inspect this' } });
  fireEvent.keyDown(composer, { key: 'Enter' });

  await waitFor(() =>
    expect(submittedMessageBodies).toContainEqual({
      prompt: 'inspect this',
      model: 'anthropic/claude-sonnet',
      context: {
        skills: ['review-change'],
        skillRefs: [{ id: 'skill-1', name: 'review-change', revisionId: 'revision-2' }],
      },
    }),
  );
  expect(await screen.findByLabelText('Invoked skills')).toHaveTextContent('review-change');
  fireEvent.click(screen.getByRole('button', { name: 'Open invoked review-change skill revision' }));
  expect(await screen.findByRole('heading', { name: 'Agent skills' })).toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).get('revision')).toBe('revision-2');
});

it('loads new-session invocation candidates from the owner-group endpoint instead of the admin catalog', async () => {
  const requestedOwnerGroupIds: string[] = [];
  mockApi({
    invocationCandidateOwnerGroupIds: requestedOwnerGroupIds,
    skills: [
      {
        id: 'admin-only',
        name: 'admin-only',
        description: 'Visible in management only.',
        autoLoad: false,
        enabled: true,
        shareMode: 'none',
        source: 'personal',
        provenance: { kind: 'personal' },
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ],
    invocationSkills: [
      {
        id: 'candidate-only',
        name: 'candidate-only',
        description: 'Authorized for this new session.',
        currentRevisionId: 'revision-1',
        autoLoad: false,
        enabled: true,
        shareMode: 'none',
        source: 'shared',
        provenance: { kind: 'shared', ownerGroupId: group.id, ownerGroupName: group.name },
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ],
  });
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
  const composer = screen.getByPlaceholderText('Ask Deputies to investigate, change code, or answer a question...');
  fireEvent.change(composer, { target: { value: '/candidate' } });

  expect(await screen.findByRole('option', { name: /candidate-only/i })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /admin-only/i })).not.toBeInTheDocument();
  expect(requestedOwnerGroupIds).toContain(group.id);
});

it('shows an unknown_skill response inline and restores the composer selection', async () => {
  mockApi({
    skills: [
      {
        id: 'skill-1',
        name: 'review-change',
        description: 'Review a change carefully.',
        autoLoad: false,
        enabled: true,
        shareMode: 'none',
        source: 'personal',
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ],
    messageSubmitError: {
      status: 400,
      body: { error: 'unknown_skill', message: 'Unknown or inaccessible skill: review-change' },
    },
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: '/rev' } });
  fireEvent.click(screen.getByRole('option', { name: /review-change/i }));
  fireEvent.change(composer, { target: { value: 'inspect this' } });
  fireEvent.keyDown(composer, { key: 'Enter' });

  expect(await screen.findByText('Unknown or inaccessible skill: review-change')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Ask your deputy to investigate, change code, or follow up...')).toHaveValue(
    'inspect this',
  );
  expect(screen.getByRole('button', { name: 'Remove review-change skill' })).toBeInTheDocument();
});

it('does not classify other HTTP 400 responses as inline skill errors', async () => {
  mockApi({
    skills: [
      {
        id: 'skill-1',
        name: 'review-change',
        description: 'Review a change carefully.',
        autoLoad: false,
        enabled: true,
        shareMode: 'none',
        source: 'personal',
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ],
    messageSubmitError: {
      status: 400,
      body: { error: 'invalid_request', message: 'The request context is invalid' },
    },
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: '/rev' } });
  fireEvent.click(screen.getByRole('option', { name: /review-change/i }));
  fireEvent.change(composer, { target: { value: 'inspect this' } });
  fireEvent.keyDown(composer, { key: 'Enter' });

  expect(await screen.findByText('The request context is invalid')).toHaveClass('border-b');
  expect(screen.getByRole('button', { name: 'Remove review-change skill' })).toBeInTheDocument();
});

it('refreshes selected session skills once after a burst of skills_loaded events and ignores the stale response', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const staleResponse = deferred<Response>();
  const latestResponse = deferred<Response>();
  let pushGlobalEvent: StreamEventPusher | undefined;
  let sessionSkillsRequestCount = 0;
  const managedSkill = {
    id: 'skill-1',
    name: 'review-change',
    description: 'Review a change carefully.',
    autoLoad: false,
    enabled: true,
    shareMode: 'none',
    source: 'personal',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  const repoSkill = {
    ...managedSkill,
    id: 'repo:owner/repo:repo-review',
    name: 'repo-review',
    description: 'Review using repository guidance.',
    source: 'repo',
  };
  mockApi({
    skills: [managedSkill],
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
    onListSessionSkillsRequest: ({ count }) => {
      sessionSkillsRequestCount = count;
      if (count === 2) return staleResponse.promise;
      if (count === 3) return latestResponse.promise;
      return jsonResponse({ skills: [managedSkill] });
    },
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: '/' } });
  expect(await screen.findByRole('option', { name: /review-change/i })).toBeInTheDocument();
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());

  act(() => {
    pushGlobalEvent?.({
      id: 20,
      sessionId: session.id,
      sequence: 20,
      type: 'skills_loaded',
      messageId: 'message-0',
      payload: { skills: [] },
      createdAt: '2026-05-05T12:02:00.000Z',
    });
  });

  await waitFor(() => expect(sessionSkillsRequestCount).toBe(2));
  act(() => {
    for (let index = 1; index < 3; index += 1) {
      pushGlobalEvent?.({
        id: 20 + index,
        sessionId: session.id,
        sequence: 20 + index,
        type: 'skills_loaded',
        messageId: `message-${index}`,
        payload: { skills: [] },
        createdAt: '2026-05-05T12:02:00.000Z',
      });
    }
  });
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(sessionSkillsRequestCount).toBe(2);
  act(() => staleResponse.resolve(jsonResponse({ skills: [{ ...managedSkill, name: 'stale-review' }] })));
  await waitFor(() => expect(sessionSkillsRequestCount).toBe(3));
  expect(screen.queryByRole('option', { name: /stale-review/i })).not.toBeInTheDocument();

  act(() => latestResponse.resolve(jsonResponse({ skills: [managedSkill, repoSkill] })));
  expect(await screen.findByRole('option', { name: /repo-review/i })).toHaveTextContent('repo');
  expect(sessionSkillsRequestCount).toBe(3);
});

it('shows no repository skills when the session skills response contains managed skills only', async () => {
  mockApi({
    skills: [
      {
        id: 'skill-1',
        name: 'review-change',
        description: 'Managed skill only.',
        autoLoad: false,
        enabled: true,
        shareMode: 'none',
        source: 'personal',
        provenance: { kind: 'personal' },
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ],
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: '/' } });
  const picker = screen.getByRole('listbox', { name: 'Available skills' });
  expect(within(picker).getByRole('option', { name: /review-change/i })).toHaveTextContent('personal');
  expect(within(picker).queryByText('repo')).not.toBeInTheDocument();
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
        reasoningLevel: 'max',
      },
    },
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  expect(await screen.findByText('gpt 4.1 (OpenAI)')).toBeInTheDocument();
  fireEvent.change(composer, { target: { value: 'follow up' } });
  fireEvent.keyDown(composer, { key: 'Enter' });

  await waitFor(() => expect(submittedMessageBodies).toHaveLength(1));
  expect(submittedMessageBodies[0]).toEqual({
    prompt: 'follow up',
    model: 'openai/gpt-4.1',
    reasoningLevel: 'max',
  });
});

it('shows the configured default and submits a reasoning override when starting a session', async () => {
  const submittedMessageBodies: unknown[] = [];
  mockApi({ submittedMessageBodies, repositories: [], defaultReasoningLevel: 'high' });
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
  expect(screen.getByText('Default (High)')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }));
  fireEvent.click(screen.getByRole('option', { name: 'Max' }));
  fireEvent.change(screen.getByPlaceholderText('Ask Deputies to investigate, change code, or answer a question...'), {
    target: { value: 'think hard' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

  await waitFor(() => expect(submittedMessageBodies).toHaveLength(1));
  expect(submittedMessageBodies[0]).toMatchObject({ prompt: 'think hard', reasoningLevel: 'max' });
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
  expect(submittedMessageBodies[0]).toMatchObject({ prompt: 'start work', generateTitle: true });
  expect(submittedMessageBodies[0]).not.toHaveProperty('repository');
});

it('archives a newly-created session when its initial message cannot be enqueued', async () => {
  const archivedSessionIds: string[] = [];
  mockApi({
    archivedSessionIds,
    messageSubmitError: {
      status: 503,
      body: { error: 'unavailable', message: 'Queue unavailable' },
    },
  });
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
  const composer = screen.getByPlaceholderText('Ask Deputies to investigate, change code, or answer a question...');
  fireEvent.change(composer, { target: { value: 'start work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

  await waitFor(() => expect(archivedSessionIds).toEqual(['00000000-0000-4000-8000-000000000102']));
  expect(await screen.findByText('Queue unavailable')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Ask Deputies to investigate, change code, or answer a question...')).toHaveValue(
    'start work',
  );
});

it('clears previous session detail when creating a new session before detail refresh completes', async () => {
  sessionStorage.setItem('deputies-selected-session-id', session.id);
  mockApi({
    hangMessagesForSessions: ['00000000-0000-4000-8000-000000000102'],
    messages: [
      {
        id: '00000000-0000-4000-8000-000000000201',
        sessionId: session.id,
        sequence: 1,
        status: 'completed',
        prompt: 'old session prompt',
        createdAt: '2026-05-05T12:00:00.000Z',
      },
    ],
  });
  render(<App />);

  expect(await screen.findByText('old session prompt')).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
  fireEvent.change(screen.getByPlaceholderText('Ask Deputies to investigate, change code, or answer a question...'), {
    target: { value: 'start work' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

  expect(await screen.findAllByText('start work')).not.toHaveLength(0);
  expect(screen.queryByText('old session prompt')).not.toBeInTheDocument();
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

it('backfills fast responses for newly-created sessions when the global stream misses them', async () => {
  const requests: string[] = [];
  let createdIncrementalRequests = 0;
  mockApi({
    requests,
    messagesBySession: {
      '00000000-0000-4000-8000-000000000102': [
        {
          id: '00000000-0000-4000-8000-000000000101',
          sessionId: '00000000-0000-4000-8000-000000000102',
          sequence: 1,
          status: 'completed',
          prompt: 'start work',
          createdAt: '2026-05-05T12:01:00.000Z',
        },
      ],
    },
    eventsBySession: {
      '00000000-0000-4000-8000-000000000102': [
        {
          id: 9,
          sessionId: '00000000-0000-4000-8000-000000000102',
          sequence: 1,
          type: 'session_created',
          payload: { title: 'start work' },
          createdAt: '2026-05-05T12:01:00.000Z',
        },
        {
          id: 10,
          sessionId: '00000000-0000-4000-8000-000000000102',
          sequence: 2,
          type: 'agent_response_final',
          messageId: '00000000-0000-4000-8000-000000000101',
          payload: { text: 'missed fast provider response' },
          createdAt: '2026-05-05T12:02:00.000Z',
        },
      ],
    },
    onListEventsRequest: ({ sessionId, url }) => {
      if (sessionId !== '00000000-0000-4000-8000-000000000102' || !url.searchParams.has('after')) return;
      createdIncrementalRequests += 1;
      if (createdIncrementalRequests > 1) {
        return jsonResponse({ events: [], cursor: 2, hasMore: false });
      }
      return jsonResponse({
        events: [
          {
            id: 9,
            sessionId,
            sequence: 1,
            type: 'session_created',
            payload: { title: 'start work' },
            createdAt: '2026-05-05T12:01:00.000Z',
          },
          {
            id: 10,
            sessionId,
            sequence: 2,
            type: 'agent_response_final',
            messageId: '00000000-0000-4000-8000-000000000101',
            payload: { text: 'missed fast provider response' },
            createdAt: '2026-05-05T12:02:00.000Z',
          },
        ],
        cursor: 2,
        hasMore: true,
      });
    },
  });
  render(<App />);

  const newSessionButton = await screen.findByRole('button', { name: 'New session' });
  requests.length = 0;
  fireEvent.click(newSessionButton);
  fireEvent.change(screen.getByPlaceholderText('Ask Deputies to investigate, change code, or answer a question...'), {
    target: { value: 'start work' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

  expect(await screen.findAllByText('start work')).not.toHaveLength(0);
  await waitFor(() => expect(screen.getByText('missed fast provider response')).toBeInTheDocument());
  const createdSessionPath = '/sessions/00000000-0000-4000-8000-000000000102';
  expect(
    requests.some((request) => request.startsWith(`GET ${createdSessionPath}/events?`) && request.includes('after=')),
  ).toBe(true);
  for (const resource of ['artifacts', 'services', 'external-resources', 'callbacks']) {
    expect(requests.filter((request) => request === `GET ${createdSessionPath}/${resource}`)).toHaveLength(1);
  }
  expect(requests.filter((request) => request === 'GET /sessions?limit=50')).toHaveLength(0);
  expect(createdIncrementalRequests).toBe(1);
});

it('aborts newly-created session backfill when signing out', async () => {
  const newSessionId = '00000000-0000-4000-8000-000000000102';
  const abortedRequests: string[] = [];
  mockApi({
    abortedRequests,
    authMode: 'session',
    currentUser: user,
    hangIncrementalEventsForSessions: [newSessionId],
  });
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
  fireEvent.change(screen.getByPlaceholderText('Ask Deputies to investigate, change code, or answer a question...'), {
    target: { value: 'start work' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

  expect(await screen.findAllByText('start work')).not.toHaveLength(0);
  fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]!);

  await waitFor(() => expect(abortedRequests).toContain(`GET /sessions/${newSessionId}/events`));
  expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
});

it('performs one incremental submission fallback and then reconciles only messages and summary', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const requests: string[] = [];
  const incrementalAfterValues: string[] = [];
  mockApi({
    requests,
    onListEventsRequest: ({ url }) => {
      const after = url.searchParams.get('after');
      if (after === null) return undefined;
      incrementalAfterValues.push(after);
      return incrementalAfterValues.length === 1
        ? jsonResponse({
            events: [eventFixture({ sequence: 1, type: 'run_started', payload: {} })],
            cursor: 1,
            hasMore: true,
          })
        : jsonResponse({ events: [], cursor: 1, hasMore: false });
    },
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  requests.length = 0;
  fireEvent.change(composer, { target: { value: 'fallback please' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() => expect(requests).toContain(`POST /sessions/${session.id}/messages`));
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  await waitFor(() => expect(incrementalAfterValues).toHaveLength(1));
  await act(() => vi.advanceTimersByTimeAsync(125));

  expect(requests.filter((request) => request.includes(`/sessions/${session.id}/events?`))).toHaveLength(1);
  expect(requests.filter((request) => request === `GET /sessions/${session.id}/messages`)).toHaveLength(1);
  expect(requests.filter((request) => request === `GET /sessions/${session.id}`)).toHaveLength(1);
  expect(requests.filter((request) => request === 'GET /sessions?limit=50')).toHaveLength(0);
  expect(detailResourceRequests(requests)).toEqual([`GET /sessions/${session.id}/messages`]);
});

it('cancels submission fallback when the matching message_created event arrives', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const requests: string[] = [];
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    requests,
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());
  requests.length = 0;
  fireEvent.change(composer, { target: { value: 'streamed creation' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() => expect(requests).toContain(`POST /sessions/${session.id}/messages`));
  act(() => {
    pushGlobalEvent?.(
      eventFixture({
        id: 20,
        sequence: 1,
        type: 'message_created',
        messageId: '00000000-0000-4000-8000-000000000101',
        payload: { sequence: 1, source: null },
      }),
    );
  });
  await act(() => vi.advanceTimersByTimeAsync(1_000));

  expect(requests.filter((request) => request.includes(`/sessions/${session.id}/events?`))).toHaveLength(0);
});

it('recognizes a matching message_created event that arrives before the submission response', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const submitResponse = deferred<Response>();
  const requests: string[] = [];
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    requests,
    onMessageSubmitRequest: () => submitResponse.promise,
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());
  requests.length = 0;
  fireEvent.change(composer, { target: { value: 'event before response' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() => expect(requests).toContain(`POST /sessions/${session.id}/messages`));
  act(() => {
    pushGlobalEvent?.(
      eventFixture({
        id: 21,
        sequence: 1,
        type: 'message_created',
        messageId: '00000000-0000-4000-8000-000000000101',
        payload: { sequence: 1, source: null },
      }),
    );
  });
  await act(async () => {
    submitResponse.resolve(
      jsonResponse({
        message: messageFixture({
          id: '00000000-0000-4000-8000-000000000101',
          sequence: 1,
          status: 'pending',
          prompt: 'event before response',
        }),
      }),
    );
    await submitResponse.promise;
  });
  await act(() => vi.advanceTimersByTimeAsync(1_000));

  expect(requests.filter((request) => request.includes(`/sessions/${session.id}/events?`))).toHaveLength(0);
});

it('retains missing-event fallbacks for two rapid successful submissions', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const requests: string[] = [];
  mockApi({ requests });
  render(<App />);

  let composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  requests.length = 0;
  fireEvent.change(composer, { target: { value: 'first fallback' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: 'second fallback' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() =>
    expect(requests.filter((request) => request === `POST /sessions/${session.id}/messages`)).toHaveLength(2),
  );
  await act(() => vi.advanceTimersByTimeAsync(1_000));

  await waitFor(() =>
    expect(requests.filter((request) => request.includes(`/sessions/${session.id}/events?`))).toHaveLength(2),
  );
});

it('ignores a late submission fallback response after selection changes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fallbackEvents = deferred<Response>();
  const requests: string[] = [];
  const secondSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000099',
    title: 'Fallback target changed',
  };
  let fallbackStarted = false;
  mockApi({
    requests,
    sessions: [session, secondSession],
    onListEventsRequest: ({ sessionId, url }) => {
      if (sessionId === session.id && url.searchParams.has('after')) {
        fallbackStarted = true;
        return fallbackEvents.promise;
      }
      return undefined;
    },
  });
  render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: 'stale fallback' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  await waitFor(() => expect(fallbackStarted).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /Fallback target changed/ }));
  requests.length = 0;

  await act(async () => {
    fallbackEvents.resolve(jsonResponse({ events: [], cursor: 0, hasMore: false }));
    await fallbackEvents.promise;
  });
  await act(() => vi.advanceTimersByTimeAsync(125));

  expect(requests).not.toContain(`GET /sessions/${session.id}/messages`);
  expect(requests).not.toContain(`GET /sessions/${session.id}`);
});

it('aborts an in-flight submission fallback when the app unmounts', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const abortedRequests: string[] = [];
  const requests: string[] = [];
  mockApi({
    abortedRequests,
    requests,
    hangIncrementalEventsForSessions: [session.id],
  });
  const view = render(<App />);

  const composer = await screen.findByPlaceholderText('Ask your deputy to investigate, change code, or follow up...');
  fireEvent.change(composer, { target: { value: 'unmounted fallback' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  await waitFor(() =>
    expect(requests.some((request) => request.includes(`/sessions/${session.id}/events?`))).toBe(true),
  );
  view.unmount();

  await waitFor(() => expect(abortedRequests).toContain(`GET /sessions/${session.id}/events`));
});

it('confirms before signing out with dirty snippet changes', async () => {
  const snippet = {
    id: '00000000-0000-4000-8000-000000000401',
    ownerUserId: user.id,
    name: 'review',
    body: 'Review this',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  sessionStorage.setItem('deputies-sidebar-panel', 'snippets');
  window.history.replaceState({}, '', `/?snippet=${snippet.id}`);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  mockApi({ authMode: 'session', currentUser: user, snippets: [snippet] });
  render(<App />);

  fireEvent.change(await screen.findByLabelText('Body'), { target: { value: 'Unsaved review' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]!);

  expect(confirm).toHaveBeenCalledWith('Discard unsaved snippet changes?');
  expect(screen.getByLabelText('Body')).toHaveValue('Unsaved review');
  expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();

  fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]!);
  expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
});

it('keeps only one context picker open at a time', async () => {
  mockApi();
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));

  fireEvent.click(screen.getByRole('button', { name: 'Codebase' }));
  expect(screen.getByRole('option', { name: /owner\/repo/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  expect(screen.queryByRole('option', { name: /owner\/repo/i })).not.toBeInTheDocument();
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

it('keeps sidebar session actions exposed on mobile', async () => {
  mockApi();
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Open sessions' }));
  const sessionRow = screen.getByRole('button', { name: /Existing session/ }).closest('div');
  expect(sessionRow).toBeInTheDocument();

  const archiveButton = within(sessionRow as HTMLElement).getByRole('button', { name: 'Archive session' });
  expect(archiveButton).not.toHaveClass('opacity-0');
  expect(archiveButton).toHaveClass('md:opacity-0');

  fireEvent.click(archiveButton);
  expect(await screen.findByText('This session is archived.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
});

it('groups header session actions in a generic actions menu', async () => {
  mockApi();
  render(<App />);

  const heading = await screen.findByRole('heading', { name: 'Existing session' });
  const header = heading.closest('section');
  expect(header).toBeInTheDocument();

  const headerQueries = within(header as HTMLElement);
  expect(headerQueries.getByRole('img', { name: 'Session status: idle' })).toHaveClass('sm:hidden');
  expect(headerQueries.getByText('idle')).toHaveClass('hidden', 'sm:inline-flex');
  expect(headerQueries.getByTitle('Star session')).toHaveClass('hidden', 'sm:inline-flex');
  fireEvent.click(headerQueries.getByRole('button', { name: 'Session actions' }));

  expect(headerQueries.getByRole('menuitem', { name: 'Star session' })).toHaveClass('sm:hidden');
  expect(headerQueries.getByText('Workspace Tools')).toBeInTheDocument();
  expect(headerQueries.getByRole('menuitem', { name: 'Archive session' })).toBeInTheDocument();
});

it('reopens the sessions side panel when navigating back to sessions from the footer on desktop', async () => {
  sessionStorage.setItem('deputies-groups-panel-open', 'true');
  mockApi({ authMode: 'session', currentUser: user });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Access groups', level: 1 })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Switch page, current page Access' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Sessions/ }));

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Search sessions...')).toBeInTheDocument();
  expect(screen.getByText('Archived')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Search groups...')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Switch page, current page Sessions' }));
  expect(screen.getByRole('menuitem', { name: /Access/ })).toBeInTheDocument();
});

it('keeps page navigation collapsed until the page switcher is opened', async () => {
  mockApi({ authMode: 'session', currentUser: user });
  render(<App />);

  const switcher = await screen.findByRole('button', { name: 'Switch page, current page Sessions' });
  expect(screen.queryByRole('menu', { name: 'Pages' })).not.toBeInTheDocument();

  fireEvent.click(switcher);
  expect(screen.getByRole('menuitem', { name: /Sessions/ })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('menuitem', { name: /Automations/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /Access/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /Environments/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /Setup/ })).toBeInTheDocument();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('menu', { name: 'Pages' })).not.toBeInTheDocument();
  expect(switcher).toHaveFocus();
});

it('cycles the compact theme action through every theme preference', async () => {
  mockApi();
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Theme: System. Change theme' }));
  expect(localStorage.getItem('deputies-theme')).toBe('light');
  expect(screen.getByRole('button', { name: 'Theme: Light. Change theme' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Theme: Light. Change theme' }));
  expect(localStorage.getItem('deputies-theme')).toBe('dark');
  expect(screen.getByRole('button', { name: 'Theme: Dark. Change theme' })).toBeInTheDocument();
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
  fireEvent.click(screen.getByRole('button', { name: 'Switch page, current page Setup' }));
  expect(screen.getByRole('menuitem', { name: /Setup/ })).toHaveAttribute('aria-current', 'page');

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
  fireEvent.click(screen.getByRole('button', { name: 'Switch page, current page Setup' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Sessions/ }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Switch page, current page Setup' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Access/ }));
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

it('does not let a delayed access mutation response regress a newer selected-session summary', async () => {
  const accessResponse = deferred<Response>();
  let pushGlobalEvent: StreamEventPusher | undefined;
  const clientGroup = {
    ...group,
    id: '00000000-0000-4000-8000-000000000019',
    name: 'New owner',
  };
  const newerSession = {
    ...session,
    title: 'Newer authoritative title',
    updatedAt: '2026-05-05T12:05:00.000Z',
  };
  mockApi({
    authMode: 'session',
    currentUser: user,
    groups: [group, clientGroup],
    onUpdateAccessRequest: () => accessResponse.promise,
    onGetSessionRequest: () => jsonResponse({ session: newerSession }),
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  const contextPanel = within(await screen.findByLabelText('Desktop context'));
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());
  fireEvent.change(await contextPanel.findByLabelText('Access group'), { target: { value: clientGroup.id } });
  act(() => {
    pushGlobalEvent?.(
      eventFixture({
        id: 22,
        sequence: 1,
        type: 'session_updated',
        payload: { title: newerSession.title },
      }),
    );
  });
  expect(await screen.findByRole('heading', { name: newerSession.title })).toBeInTheDocument();

  await act(async () => {
    accessResponse.resolve(
      jsonResponse({
        session: {
          ...session,
          ownerGroupId: clientGroup.id,
          title: 'Stale access response title',
          updatedAt: '2026-05-05T12:03:00.000Z',
        },
      }),
    );
    await accessResponse.promise;
  });

  expect(screen.getByRole('heading', { name: newerSession.title })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Stale access response title' })).not.toBeInTheDocument();
});

it('does not let a delayed access response regress a newer first-page session snapshot', async () => {
  const accessResponse = deferred<Response>();
  const refreshedPage = deferred<Response>();
  const clientGroup = {
    ...group,
    id: '00000000-0000-4000-8000-000000000019',
    name: 'New owner',
  };
  const newerSession = {
    ...session,
    title: 'Newer first-page title',
    updatedAt: '2026-05-05T12:05:00.000Z',
  };
  mockApi({
    authMode: 'session',
    currentUser: user,
    groups: [group, clientGroup],
    onUpdateAccessRequest: () => accessResponse.promise,
    onListSessionsRequest: ({ count }) => (count === 2 ? refreshedPage.promise : undefined),
    onGetSessionRequest: () => jsonResponse({ session: newerSession }),
  });
  render(<App />);

  const contextPanel = within(await screen.findByLabelText('Desktop context'));
  fireEvent.change(await contextPanel.findByLabelText('Access group'), { target: { value: clientGroup.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await act(async () => {
    refreshedPage.resolve(jsonResponse({ sessions: [newerSession], nextCursor: null }));
    await refreshedPage.promise;
    accessResponse.resolve(
      jsonResponse({
        session: {
          ...session,
          ownerGroupId: clientGroup.id,
          title: 'Stale access response title',
          updatedAt: '2026-05-05T12:03:00.000Z',
        },
      }),
    );
    await accessResponse.promise;
  });

  expect(await screen.findByRole('heading', { name: newerSession.title })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Stale access response title' })).not.toBeInTheDocument();
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

it('archives the selected session in place before waiting for the archive request', async () => {
  mockApi({ hangArchive: true });
  render(<App />);

  const heading = await screen.findByRole('heading', { name: 'Existing session' });
  const header = heading.closest('section');
  fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Session actions' }));
  fireEvent.click(within(header as HTMLElement).getByRole('menuitem', { name: 'Archive session' }));

  expect(screen.getByText('This session is archived.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  expect(sessionStorage.getItem('deputies-selected-session-id')).toBe(session.id);
  expect(sessionStorage.getItem('deputies-new-session-selected')).toBeNull();
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

it('uses the latest filters for the first session refresh after a filter change', async () => {
  const requests: string[] = [];
  mockApi({
    onListSessionsRequest: ({ url }) => {
      requests.push(url.search);
      return jsonResponse({ sessions: [session], nextCursor: null });
    },
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  fireEvent.click(
    screen
      .getAllByRole('button', { name: 'Starred' })
      .find((button) => button.getAttribute('aria-pressed') === 'false')!,
  );

  await waitFor(() => {
    expect(requests.some((search) => new URLSearchParams(search).get('starred') === 'me')).toBe(true);
  });
});

it('keeps loaded archived rows when a filtered active refresh completes', async () => {
  const activeSession = { ...session, starred: true };
  const archivedSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000090',
    title: 'Archived session',
    status: 'archived',
    starred: true,
  };
  mockApi({
    sessionOverride: { starred: true },
    sessions: [activeSession, archivedSession],
    onListSessionsRequest: ({ url }) =>
      jsonResponse({
        sessions: url.searchParams.get('archived') === 'true' ? [archivedSession] : [activeSession],
        nextCursor: null,
      }),
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  fireEvent.click(
    screen
      .getAllByRole('button', { name: 'Starred' })
      .find((button) => button.getAttribute('aria-pressed') === 'false')!,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: /Existing session/ })).toBeInTheDocument());

  fireEvent.click(screen.getByText('Archived'));
  expect(await screen.findByRole('button', { name: /Archived session/ })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  await waitFor(() => expect(screen.getByRole('button', { name: /Archived session/ })).toBeInTheDocument());
});

it('keeps the selected session open after unstarring it with the starred filter active', async () => {
  mockApi({ sessionOverride: { starred: true } });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  fireEvent.click(
    screen
      .getAllByRole('button', { name: 'Starred' })
      .find((button) => button.getAttribute('aria-pressed') === 'false')!,
  );

  await waitFor(() => expect(screen.getAllByTitle('Unstar session').length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByTitle('Unstar session')[0]!);

  await waitFor(() => expect(screen.getByRole('heading', { name: 'Existing session' })).toBeInTheDocument());
  expect(screen.queryByText('What needs doing?')).not.toBeInTheDocument();
});

it('adds a session tag from the thread header tag picker', async () => {
  mockApi({ sessionTags: [{ tag: 'foo', sessionCount: 1 }] });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '+ Tag' }));
  fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'foo' }));

  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove foo' })).toBeInTheDocument());
});

it('rolls back a failed star mutation without reverting an interleaved tag edit', async () => {
  const starResponse = deferred<Response>();
  mockApi({
    sessionTags: [{ tag: 'foo', sessionCount: 1 }],
    onStarSessionRequest: () => starResponse.promise,
  });
  render(<App />);

  const heading = await screen.findByRole('heading', { name: 'Existing session' });
  const header = heading.closest('section');
  if (!header) throw new Error('Expected thread header');
  fireEvent.click(within(header).getByTitle('Star session'));
  await waitFor(() => expect(within(header).getByTitle('Unstar session')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: '+ Tag' }));
  fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'foo' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove foo' })).toBeInTheDocument());

  await act(async () => {
    starResponse.resolve(jsonResponse({ error: 'boom', message: 'Star failed' }, 500));
    await starResponse.promise;
  });

  await waitFor(() => expect(within(header).getByTitle('Star session')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Remove foo' })).toBeInTheDocument();
});

it('filters sessions with the searchable sidebar tag picker', async () => {
  const requests: string[] = [];
  mockApi({
    sessionTags: [
      { tag: 'alpha', sessionCount: 10 },
      { tag: 'beta', sessionCount: 9 },
      { tag: 'gamma', sessionCount: 8 },
      { tag: 'delta', sessionCount: 7 },
      { tag: 'epsilon', sessionCount: 6 },
      { tag: 'zeta', sessionCount: 5 },
      { tag: 'eta', sessionCount: 4 },
      { tag: 'theta', sessionCount: 3 },
      { tag: 'iota', sessionCount: 2 },
      { tag: 'kappa', sessionCount: 1 },
    ],
    onListSessionsRequest: ({ url }) => {
      requests.push(url.search);
      return jsonResponse({ sessions: [session], nextCursor: null });
    },
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Filter by tags' }));
  const listbox = await screen.findByRole('listbox');

  expect(within(listbox).getByRole('option', { name: 'alpha' })).toBeInTheDocument();
  expect(within(listbox).getByRole('option', { name: 'theta' })).toBeInTheDocument();
  expect(within(listbox).queryByRole('option', { name: 'iota' })).not.toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('Search tags...'), { target: { value: 'kap' } });
  fireEvent.click(within(listbox).getByRole('option', { name: 'kappa' }));

  await waitFor(() => {
    expect(requests.some((search) => new URLSearchParams(search).get('tags') === 'kappa')).toBe(true);
  });
});

it('omits session tag badges from sidebar rows', async () => {
  mockApi({ sessionOverride: { tags: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] } });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  const sessionRow = screen.getByRole('button', { name: /Existing session/ }).closest('div');
  expect(sessionRow).toBeInTheDocument();

  expect(within(sessionRow as HTMLElement).queryByText('alpha')).not.toBeInTheDocument();
  expect(within(sessionRow as HTMLElement).queryByText('beta')).not.toBeInTheDocument();
});

it('opens search results that are outside the loaded sessions page', async () => {
  const searchHit = {
    ...session,
    id: '00000000-0000-4000-8000-000000000088',
    title: 'Search-only session',
    updatedAt: '2026-05-05T12:10:00.000Z',
  };
  mockApi({
    sessions: [session],
    searchResults: [{ session: searchHit, snippet: 'matched prompt text', matchKind: 'prompt', score: 1 }],
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('Search sessions...'), { target: { value: 'matched' } });
  fireEvent.click(await screen.findByRole('button', { name: /Search-only session/ }));

  expect(await screen.findByRole('heading', { name: 'Search-only session' })).toBeInTheDocument();
});

it('reveals a filtered search result in its fetched ancestor tree and can return it to a detached row', async () => {
  const parentSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000077',
    title: 'Originating session',
    status: 'archived',
  };
  const searchHit = {
    ...session,
    id: '00000000-0000-4000-8000-000000000088',
    title: 'Deputy search result',
    parentSessionId: parentSession.id,
    spawnDepth: 1,
    updatedAt: '2026-05-05T12:10:00.000Z',
  };
  mockApi({
    sessions: [session, parentSession, searchHit],
    searchResults: [{ session: searchHit, snippet: 'matched deputy prompt', matchKind: 'prompt', score: 1 }],
    onListSessionsRequest: () => jsonResponse({ sessions: [session], nextCursor: null }),
  });
  render(<App />);

  await screen.findByRole('heading', { name: 'Sessions' });
  fireEvent.click(
    screen
      .getAllByRole('button', { name: 'Created' })
      .find((button) => button.getAttribute('aria-pressed') === 'false')!,
  );
  fireEvent.change(screen.getByPlaceholderText('Search sessions...'), { target: { value: 'matched' } });

  const sidebar = within((await screen.findByRole('heading', { name: 'Sessions' })).closest('aside')!);
  fireEvent.click(screen.getByRole('button', { name: 'Open sessions' }));
  const showInTree = await sidebar.findByRole('button', { name: 'Show in session tree' });
  expect(sidebar.queryByText('Sub-session')).not.toBeInTheDocument();
  fireEvent.click(showInTree);

  expect(await sidebar.findByText('Showing selected session lineage')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open sessions' })).not.toBeInTheDocument();
  expect(sidebar.getByText('Ancestors are included even when they do not match your search.')).toBeInTheDocument();
  expect(sidebar.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  expect(sidebar.getByRole('button', { name: 'Originating session' })).toBeInTheDocument();
  expect(sidebar.getByRole('button', { name: 'Deputy search result' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Search sessions...')).toHaveValue('');

  fireEvent.click(sidebar.getByRole('button', { name: 'Hide lineage' }));
  expect(sidebar.queryByText('Showing selected session lineage')).not.toBeInTheDocument();
  expect(sidebar.queryByRole('button', { name: 'Originating session' })).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('Search sessions...')).toHaveValue('matched');
  expect(await sidebar.findByRole('button', { name: 'Show in session tree' })).toBeInTheDocument();

  fireEvent.click(sidebar.getByRole('button', { name: 'Show in session tree' }));
  expect(await sidebar.findByText('Showing selected session lineage')).toBeInTheDocument();
  fireEvent.click(sidebar.getByRole('button', { name: 'Originating session' }));
  expect(await screen.findByRole('heading', { name: 'Originating session' })).toBeInTheDocument();
  fireEvent.click(sidebar.getByRole('button', { name: 'Clear filters' }));
  expect(sidebar.queryByText('Showing selected session lineage')).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('Search sessions...')).toHaveValue('matched');

  fireEvent.click(await sidebar.findByRole('button', { name: 'Show in session tree' }));
  expect(await sidebar.findByText('Showing selected session lineage')).toBeInTheDocument();
  fireEvent.click(sidebar.getByRole('button', { name: 'Clear search' }));
  expect(sidebar.queryByText('Showing selected session lineage')).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('Search sessions...')).toHaveValue('');
});

it('does not reveal stale lineage after the user clears search', async () => {
  const parentResponse = deferred<Response>();
  const searchHit = {
    ...session,
    id: '00000000-0000-4000-8000-000000000088',
    title: 'Deputy search result',
    parentSessionId: '00000000-0000-4000-8000-000000000077',
    spawnDepth: 1,
  };
  mockApi({
    sessions: [session],
    searchResults: [{ session: searchHit, snippet: 'matched deputy prompt', matchKind: 'prompt', score: 1 }],
    onGetSessionRequest: (sessionId) => (sessionId === searchHit.parentSessionId ? parentResponse.promise : undefined),
  });
  render(<App />);

  await screen.findByRole('heading', { name: 'Sessions' });
  const search = screen.getByPlaceholderText('Search sessions...');
  fireEvent.change(search, { target: { value: 'matched' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Show in session tree' }));
  fireEvent.change(search, { target: { value: '' } });
  parentResponse.resolve(jsonResponse({ session: { ...session, id: searchHit.parentSessionId } }));

  await waitFor(() => expect(search).toHaveValue(''));
  expect(screen.queryByText('Showing selected session lineage')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Existing session' })).toBeInTheDocument();
});

it('separates archived sidebar search results from active results', async () => {
  const activeHit = {
    ...session,
    id: '00000000-0000-4000-8000-000000000087',
    title: 'Active search hit',
  };
  const archivedHit = {
    ...session,
    id: '00000000-0000-4000-8000-000000000086',
    status: 'archived',
    title: 'Archived search hit',
  };
  mockApi({
    searchResults: [
      { session: archivedHit, snippet: 'matched archived text', matchKind: 'prompt', score: 2 },
      { session: activeHit, snippet: 'matched active text', matchKind: 'prompt', score: 1 },
    ],
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('Search sessions...'), { target: { value: 'matched' } });

  const activeButton = await screen.findByRole('button', { name: /Active search hit/ });
  const archivedDivider = screen.getByText('Archived');
  const archivedButton = screen.getByRole('button', { name: /Archived search hit/ });

  expect(activeButton.compareDocumentPosition(archivedDivider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(archivedDivider.compareDocumentPosition(archivedButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('updates sidebar search result archive controls after archive and restore', async () => {
  mockApi({
    searchResults: [{ session, snippet: 'matched prompt text', matchKind: 'prompt', score: 1 }],
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('Search sessions...'), { target: { value: 'matched' } });

  function getResultRow() {
    const resultSnippet = screen.getByText('matched prompt text');
    const resultRow = resultSnippet.closest('div');
    if (!resultRow) throw new Error('Expected search result row');
    return resultRow;
  }

  fireEvent.click(within(await waitFor(() => getResultRow())).getByRole('button', { name: 'Archive session' }));

  await waitFor(() => expect(within(getResultRow()).getByText('archived')).toBeInTheDocument());
  const archivedResultRow = getResultRow();
  expect(screen.getByText('Archived')).toBeInTheDocument();
  expect(within(archivedResultRow).queryByRole('button', { name: 'Archive session' })).not.toBeInTheDocument();
  expect(within(archivedResultRow).getByRole('button', { name: 'Restore session' })).toBeInTheDocument();

  fireEvent.click(within(archivedResultRow).getByRole('button', { name: 'Restore session' }));

  await waitFor(() => expect(within(getResultRow()).getByText('idle')).toBeInTheDocument());
  const activeResultRow = getResultRow();
  expect(within(activeResultRow).getByRole('button', { name: 'Archive session' })).toBeInTheDocument();
  expect(within(activeResultRow).queryByRole('button', { name: 'Restore session' })).not.toBeInTheDocument();
  expect(within(activeResultRow).getByText('idle')).toBeInTheDocument();
});

it('preserves load-more sessions when a refresh resolves later', async () => {
  const refreshPage = deferred<Response>();
  const secondPageSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000089',
    title: 'Loaded later',
    createdAt: '2026-05-05T11:59:00.000Z',
    updatedAt: '2026-05-05T11:59:00.000Z',
  };
  let refreshStarted = false;
  mockApi({
    onListSessionsRequest: ({ count, url }) => {
      const cursor = url.searchParams.get('cursor');
      if (count === 1) return jsonResponse({ sessions: [session], nextCursor: 'page-2' });
      if (cursor === 'page-2') return jsonResponse({ sessions: [secondPageSession], nextCursor: null });
      refreshStarted = true;
      return refreshPage.promise;
    },
  });
  render(<App />);

  expect(await screen.findByRole('button', { name: 'Load more sessions' })).toBeInTheDocument();

  setVisibilityState('hidden');
  fireEvent(document, new Event('visibilitychange'));
  setVisibilityState('visible');
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(refreshStarted).toBe(true));

  fireEvent.click(screen.getByRole('button', { name: 'Load more sessions' }));
  expect(await screen.findByText('Loaded later')).toBeInTheDocument();

  await act(async () => {
    refreshPage.resolve(
      jsonResponse({ sessions: [{ ...session, title: 'Refreshed first page' }], nextCursor: 'page-2' }),
    );
    await refreshPage.promise;
  });

  expect(screen.getByText('Loaded later')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more sessions' })).not.toBeInTheDocument();
});

it('shows a loaded session when the sidebar becomes hovered before the page resolves', async () => {
  const secondPage = deferred<Response>();
  const secondPageSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000088',
    title: 'Loaded while hovered',
    createdAt: '2026-05-05T11:59:00.000Z',
    updatedAt: '2026-05-05T11:59:00.000Z',
  };
  let secondPageRequested = false;
  mockApi({
    onListSessionsRequest: ({ count, url }) => {
      if (count === 1) return jsonResponse({ sessions: [session], nextCursor: 'page-2' });
      if (url.searchParams.get('cursor') === 'page-2') {
        secondPageRequested = true;
        return secondPage.promise;
      }
      return undefined;
    },
  });
  render(<App />);

  const loadMore = await screen.findByRole('button', { name: 'Load more sessions' });
  fireEvent.click(loadMore);
  await waitFor(() => expect(secondPageRequested).toBe(true));
  fireEvent.pointerEnter(loadMore);

  await act(async () => {
    secondPage.resolve(jsonResponse({ sessions: [secondPageSession], nextCursor: null }));
    await secondPage.promise;
  });

  expect(screen.getByRole('button', { name: /Loaded while hovered/ })).toBeInTheDocument();
});

it('preserves filtered load-more sessions when a refresh resolves later', async () => {
  const refreshPage = deferred<Response>();
  const firstPageSession = { ...session, starred: true, title: 'Filtered first page' };
  const secondPageSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000098',
    starred: true,
    title: 'Filtered loaded later',
    createdAt: '2026-05-05T11:59:00.000Z',
    updatedAt: '2026-05-05T11:59:00.000Z',
  };
  let filteredFirstPageRequests = 0;
  let refreshStarted = false;
  mockApi({
    sessionOverride: { starred: true, title: firstPageSession.title },
    onListSessionsRequest: ({ url }) => {
      const starred = url.searchParams.get('starred') === 'me';
      const cursor = url.searchParams.get('cursor');
      if (!starred) return jsonResponse({ sessions: [firstPageSession], nextCursor: null });
      if (cursor === 'page-2') return jsonResponse({ sessions: [secondPageSession], nextCursor: 'page-3' });
      filteredFirstPageRequests += 1;
      if (filteredFirstPageRequests === 1) {
        return jsonResponse({ sessions: [firstPageSession], nextCursor: 'page-2' });
      }
      refreshStarted = true;
      return refreshPage.promise;
    },
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Filtered first page' })).toBeInTheDocument();
  fireEvent.click(
    screen
      .getAllByRole('button', { name: 'Starred' })
      .find((button) => button.getAttribute('aria-pressed') === 'false')!,
  );
  expect(await screen.findByRole('button', { name: 'Load more sessions' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(refreshStarted).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Load more sessions' }));
  expect(await screen.findByText('Filtered loaded later')).toBeInTheDocument();

  await act(async () => {
    refreshPage.resolve(
      jsonResponse({
        sessions: [{ ...firstPageSession, title: 'Filtered refreshed first page' }],
        nextCursor: 'page-2',
      }),
    );
    await refreshPage.promise;
  });

  expect(screen.getByText('Filtered loaded later')).toBeInTheDocument();
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

it('coalesces simultaneous wake, visibility, and online recovery signals', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
  const recoveryPage = deferred<Response>();
  const requests: string[] = [];
  let streamRequestCount = 0;
  let sessionsRequestCount = 0;
  let incrementalEventRequests = 0;
  mockApi({
    requests,
    events: [eventFixture({ sequence: 4, type: 'run_started', payload: {} })],
    onListSessions: (count) => {
      sessionsRequestCount = count;
    },
    onListSessionsRequest: ({ count }) => (count === 2 ? recoveryPage.promise : undefined),
    onGlobalStreamRequest: (_url, count) => {
      streamRequestCount = count;
      return undefined;
    },
    onListEventsRequest: ({ url }) => {
      if (!url.searchParams.has('after')) return undefined;
      incrementalEventRequests += 1;
      return incrementalEventRequests === 1
        ? jsonResponse({
            events: [eventFixture({ sequence: 5, type: 'message_updated', payload: { sequence: 1 } })],
            cursor: 5,
            hasMore: true,
          })
        : jsonResponse({ events: [], cursor: 5, hasMore: false });
    },
  });
  render(<App />);

  expect(await screen.findByRole('log', { name: 'Session messages' })).toBeInTheDocument();
  await waitFor(() => expect(streamRequestCount).toBe(1));
  requests.length = 0;

  setVisibilityState('hidden');
  fireEvent(document, new Event('visibilitychange'));
  vi.setSystemTime(new Date('2026-05-05T12:00:06.000Z'));
  setVisibilityState('visible');
  fireEvent(document, new Event('visibilitychange'));
  fireEvent(window, new Event('online'));
  await act(() => vi.advanceTimersByTimeAsync(1_000));

  await waitFor(() => expect(sessionsRequestCount).toBe(2));
  expect(streamRequestCount).toBe(2);
  fireEvent(window, new Event('online'));

  await act(async () => {
    recoveryPage.resolve(jsonResponse({ sessions: [session], nextCursor: null }));
    await recoveryPage.promise;
  });

  await waitFor(() =>
    expect(requests.filter((request) => request.includes(`/sessions/${session.id}/events?`))).toHaveLength(1),
  );
  await act(() => vi.advanceTimersByTimeAsync(125));
  expect(requests.filter((request) => request === 'GET /sessions?limit=50')).toHaveLength(1);
  expect(requests.filter((request) => request === `GET /sessions/${session.id}/messages`)).toHaveLength(1);
  expect(detailResourceRequests(requests)).toEqual([`GET /sessions/${session.id}/messages`]);
  expect(incrementalEventRequests).toBe(1);
});

it('waits for a successful stream reopen before recovering after repeated reconnect failures', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let streamRequestCount = 0;
  let sessionsRequestCount = 0;
  const recoveryEventUrls: URL[] = [];
  mockApi({
    events: [eventFixture({ sequence: 3, type: 'run_started', payload: {} })],
    onListSessions: (count) => {
      sessionsRequestCount = count;
    },
    onGlobalStreamRequest: (_url, count) => {
      streamRequestCount = count;
      if (count === 2 || count === 3) return new Response(null, { status: 503 });
      return undefined;
    },
    onListEventsRequest: ({ url }) => {
      if (url.searchParams.has('after')) recoveryEventUrls.push(url);
      return undefined;
    },
  });
  render(<App />);

  expect(await screen.findByRole('log', { name: 'Session messages' })).toBeInTheDocument();
  await waitFor(() => expect(streamRequestCount).toBe(1));
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(streamRequestCount).toBe(2));
  expect(sessionsRequestCount).toBe(1);

  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(streamRequestCount).toBe(3);
  expect(sessionsRequestCount).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1_000));

  await waitFor(() => expect(streamRequestCount).toBe(4));
  await waitFor(() => expect(sessionsRequestCount).toBe(2));
  await waitFor(() => expect(recoveryEventUrls).toHaveLength(1));
  expect(recoveryEventUrls[0]!.searchParams.get('after')).toBe('3');
});

it('recovers after a global stream closes cleanly', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let closeStream: (() => void) | undefined;
  let streamOpenCount = 0;
  let sessionsRequestCount = 0;
  const recoveryAfterValues: string[] = [];
  mockApi({
    events: [eventFixture({ sequence: 2, type: 'run_started', payload: {} })],
    onListSessions: (count) => {
      sessionsRequestCount = count;
    },
    onGlobalStreamOpen: (_push, close) => {
      streamOpenCount += 1;
      closeStream = close;
    },
    onListEventsRequest: ({ url }) => {
      const after = url.searchParams.get('after');
      if (after !== null) recoveryAfterValues.push(after);
      return undefined;
    },
  });
  render(<App />);

  expect(await screen.findByRole('log', { name: 'Session messages' })).toBeInTheDocument();
  await waitFor(() => expect(streamOpenCount).toBe(1));
  act(() => closeStream?.());
  await act(() => vi.advanceTimersByTimeAsync(500));

  await waitFor(() => expect(streamOpenCount).toBe(2));
  await waitFor(() => expect(sessionsRequestCount).toBe(2));
  await waitFor(() => expect(recoveryAfterValues).toEqual(['2']));
});

it('waits for the coalesced first-page generation before reading recovery events', async () => {
  const firstRefresh = deferred<Response>();
  const recoveryRefresh = deferred<Response>();
  let sessionsRequestCount = 0;
  let recoveryEventReadCount = 0;
  mockApi({
    onListSessions: (count) => {
      sessionsRequestCount = count;
    },
    onListSessionsRequest: ({ count }) => {
      if (count === 2) return firstRefresh.promise;
      if (count === 3) return recoveryRefresh.promise;
      return undefined;
    },
    onListEventsRequest: ({ url }) => {
      if (url.searchParams.has('after')) recoveryEventReadCount += 1;
      return undefined;
    },
  });
  render(<App />);

  expect(await screen.findByRole('log', { name: 'Session messages' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(sessionsRequestCount).toBe(2));
  fireEvent(window, new Event('online'));
  expect(recoveryEventReadCount).toBe(0);

  await act(async () => {
    firstRefresh.resolve(jsonResponse({ sessions: [session], nextCursor: null }));
    await firstRefresh.promise;
  });
  await waitFor(() => expect(sessionsRequestCount).toBe(3));
  expect(recoveryEventReadCount).toBe(0);

  await act(async () => {
    recoveryRefresh.resolve(jsonResponse({ sessions: [session], nextCursor: null }));
    await recoveryRefresh.promise;
  });
  await waitFor(() => expect(recoveryEventReadCount).toBe(1));
});

it('deduplicates planner effects shared by stream replay and REST recovery', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const requests: string[] = [];
  let streamOpenCount = 0;
  const duplicateEvent = eventFixture({ sequence: 5, type: 'message_updated', payload: { sequence: 1 } });
  mockApi({
    requests,
    events: [eventFixture({ sequence: 4, type: 'run_started', payload: {} })],
    onGlobalStreamOpen: (push) => {
      streamOpenCount += 1;
      if (streamOpenCount === 2) push(duplicateEvent);
    },
    onListEventsRequest: ({ url }) =>
      url.searchParams.has('after') ? jsonResponse({ events: [duplicateEvent], cursor: 5, hasMore: false }) : undefined,
  });
  render(<App />);

  expect(await screen.findByRole('log', { name: 'Session messages' })).toBeInTheDocument();
  requests.length = 0;
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(streamOpenCount).toBe(2));
  await act(() => vi.advanceTimersByTimeAsync(125));

  await waitFor(() => expect(requests).toContain(`GET /sessions/${session.id}/messages`));
  expect(requests.filter((request) => request === `GET /sessions/${session.id}/messages`)).toHaveLength(1);
  expect(requests.filter((request) => request === 'GET /sessions?limit=50')).toHaveLength(1);
  expect(requests.filter((request) => request === `GET /sessions/${session.id}`)).toHaveLength(0);
});

it('reconciles stream presentation events after the recovery list authority settles', async () => {
  const recoveredEvents = deferred<Response>();
  const requests: string[] = [];
  let pushGlobalEvent: StreamEventPusher | undefined;
  let recoveryReadStarted = false;
  mockApi({
    requests,
    events: [eventFixture({ sequence: 2, type: 'run_started', payload: {} })],
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
    onListEventsRequest: ({ url }) => {
      if (url.searchParams.has('after')) {
        recoveryReadStarted = true;
        return recoveredEvents.promise;
      }
      return undefined;
    },
  });
  render(<App />);

  expect(await screen.findByRole('log', { name: 'Session messages' })).toBeInTheDocument();
  requests.length = 0;
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(recoveryReadStarted).toBe(true));
  act(() => {
    pushGlobalEvent?.(
      eventFixture({
        id: 30,
        sequence: 3,
        type: 'message_completed',
        messageId: '00000000-0000-4000-8000-000000000130',
        payload: { sequence: 1 },
      }),
    );
  });

  await waitFor(() => expect(requests).toContain(`GET /sessions/${session.id}`));
  await act(async () => {
    recoveredEvents.resolve(jsonResponse({ events: [], cursor: 3, hasMore: false }));
    await recoveredEvents.promise;
  });
});

it('defers stream presentation effects that arrive during the recovery list request', async () => {
  const recoveryPage = deferred<Response>();
  const requests: string[] = [];
  let pushGlobalEvent: StreamEventPusher | undefined;
  let recoveryListStarted = false;
  mockApi({
    requests,
    events: [eventFixture({ sequence: 2, type: 'run_started', payload: {} })],
    onListSessionsRequest: ({ count }) => {
      if (count !== 2) return undefined;
      recoveryListStarted = true;
      return recoveryPage.promise;
    },
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  expect(await screen.findByRole('log', { name: 'Session messages' })).toBeInTheDocument();
  requests.length = 0;
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(recoveryListStarted).toBe(true));
  act(() => {
    pushGlobalEvent?.(
      eventFixture({
        id: 31,
        sequence: 3,
        type: 'message_completed',
        messageId: '00000000-0000-4000-8000-000000000131',
        payload: { sequence: 1 },
      }),
    );
  });
  expect(requests).not.toContain(`GET /sessions/${session.id}`);

  await act(async () => {
    recoveryPage.resolve(jsonResponse({ sessions: [session], nextCursor: null }));
    await recoveryPage.promise;
  });
  await waitFor(() => expect(requests).toContain(`GET /sessions/${session.id}`));
});

it('ignores a stale incremental recovery response after selection changes', async () => {
  const recoveredEvents = deferred<Response>();
  const secondSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000099',
    title: 'Second recovery session',
  };
  let recoveryReadStarted = false;
  mockApi({
    sessions: [session, secondSession],
    eventsBySession: {
      [session.id]: [eventFixture({ sequence: 2, type: 'run_started', payload: {} })],
      [secondSession.id]: [],
    },
    onListEventsRequest: ({ sessionId, url }) => {
      if (sessionId === session.id && url.searchParams.has('after')) {
        recoveryReadStarted = true;
        return recoveredEvents.promise;
      }
      return undefined;
    },
  });
  render(<App />);

  expect(await screen.findByRole('log', { name: 'Session messages' })).toBeInTheDocument();
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(recoveryReadStarted).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /Second recovery session/ }));
  expect(await screen.findByRole('heading', { name: 'Second recovery session' })).toBeInTheDocument();

  await act(async () => {
    recoveredEvents.resolve(
      jsonResponse({
        events: [
          eventFixture({
            sequence: 3,
            type: 'agent_text_delta',
            messageId: '00000000-0000-4000-8000-000000000299',
            payload: { text: 'stale recovered text' },
          }),
        ],
        cursor: 3,
        hasMore: false,
      }),
    );
    await recoveredEvents.promise;
  });

  expect(screen.queryByText('stale recovered text')).not.toBeInTheDocument();
});

it('uses only per-session after cursors for repeated post-selection recovery reads', async () => {
  const recoveryAfterValues: string[] = [];
  mockApi({
    events: [eventFixture({ sequence: 7, type: 'run_started', payload: {} })],
    onListEventsRequest: ({ url }) => {
      const after = url.searchParams.get('after');
      if (after !== null) {
        recoveryAfterValues.push(after);
        const sequence = Number(after) + 1;
        return jsonResponse({
          events: [eventFixture({ sequence, type: 'run_completed', payload: {} })],
          cursor: sequence,
          hasMore: false,
        });
      }
      return undefined;
    },
  });
  render(<App />);

  expect(await screen.findByRole('log', { name: 'Session messages' })).toBeInTheDocument();
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(recoveryAfterValues).toEqual(['7']));
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(recoveryAfterValues).toEqual(['7', '8']));
});

it('clears a selected session when refresh fallback loses read access', async () => {
  const sessions = [{ ...session }];
  mockApi({ sessions, sessionDetailStatusById: { [session.id]: 403 } });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();

  setVisibilityState('hidden');
  fireEvent(document, new Event('visibilitychange'));
  sessions.length = 0;

  setVisibilityState('visible');
  fireEvent(document, new Event('visibilitychange'));

  expect(await screen.findByText('What needs doing?')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Existing session' })).not.toBeInTheDocument();
  expect(sessionStorage.getItem('deputies-selected-session-id')).toBeNull();
});

it('refreshes sessions when a queued message starts processing', async () => {
  const sessions = [{ ...session, status: 'queued' }];
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    sessions,
    onGetSessionRequest: () => jsonResponse({ session: sessions[0] }),
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
    onGetSessionRequest: () => jsonResponse({ session: sessions[0] }),
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
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

  await act(() => vi.advanceTimersByTimeAsync(300));
  await waitFor(() => expect(sessionsRequestCount).toBe(2));
  await act(() => vi.advanceTimersByTimeAsync(350));
  expect(sessionsRequestCount).toBe(2);
  expect(await screen.findByText('Coalesced session')).toBeInTheDocument();
});

it('reconciles messages and summary without refreshing the list for a selected-session lifecycle event', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const requests: string[] = [];
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    requests,
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  await waitFor(() => expect(pushGlobalEvent).toBeDefined());
  await screen.findByText('No messages yet.');
  await waitFor(() => expect(requests).toContain(`GET /sessions/${session.id}/callbacks`));
  requests.length = 0;
  pushGlobalEvent?.(eventFixture({ id: 2, sequence: 1, type: 'message_completed', payload: { sequence: 1 } }));
  await act(() => vi.advanceTimersByTimeAsync(350));

  await waitFor(() => expect(requests).toContain(`GET /sessions/${session.id}/messages`));
  expect(detailResourceRequests(requests)).toEqual([`GET /sessions/${session.id}/messages`]);
  expect(requests).toContain(`GET /sessions/${session.id}`);
  expect(requests.some((request) => request.startsWith('GET /sessions?'))).toBe(false);
});

it('coalesces callback event bursts without refreshing sibling resources', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const requests: string[] = [];
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    requests,
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  await waitFor(() => expect(pushGlobalEvent).toBeDefined());
  await screen.findByText('No messages yet.');
  await waitFor(() => expect(requests).toContain(`GET /sessions/${session.id}/callbacks`));
  requests.length = 0;
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    pushGlobalEvent?.(eventFixture({ id: sequence + 1, sequence, type: 'callback_retry_scheduled', payload: {} }));
  }
  await act(() => vi.advanceTimersByTimeAsync(125));

  await waitFor(() => expect(requests).toContain(`GET /sessions/${session.id}/callbacks`));
  expect(detailResourceRequests(requests)).toEqual([`GET /sessions/${session.id}/callbacks`]);
});

it('does not read detail resources when a sandbox stops', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const requests: string[] = [];
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    requests,
    services: [{ port: 3000, url: 'https://service.example.com' }],
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  await waitFor(() => expect(pushGlobalEvent).toBeDefined());
  await screen.findByText('No messages yet.');
  await waitFor(() => expect(requests).toContain(`GET /sessions/${session.id}/services`));
  requests.length = 0;
  pushGlobalEvent?.(eventFixture({ id: 2, sequence: 1, type: 'sandbox_stopped', payload: {} }));
  await act(() => vi.advanceTimersByTimeAsync(150));

  expect(detailResourceRequests(requests)).toEqual([]);
});

it('does not let a stale services response repopulate services after sandbox stop', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const staleServices = deferred<Response>();
  let servicesRequestCount = 0;
  let pushGlobalEvent: StreamEventPusher | undefined;
  mockApi({
    services: [{ port: 3000, url: 'https://service.example.com' }],
    onListServicesRequest: (count) => {
      servicesRequestCount = count;
      return count === 1 ? undefined : staleServices.promise;
    },
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  render(<App />);

  expect(await screen.findAllByText(':3000')).not.toHaveLength(0);
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());
  pushGlobalEvent?.(eventFixture({ id: 2, sequence: 1, type: 'sandbox_keepalive_extended', payload: {} }));
  await act(() => vi.advanceTimersByTimeAsync(125));
  await waitFor(() => expect(servicesRequestCount).toBe(2));

  pushGlobalEvent?.(eventFixture({ id: 3, sequence: 2, type: 'sandbox_stopped', payload: {} }));
  await waitFor(() => expect(screen.queryAllByText(':3000')).toHaveLength(0));
  staleServices.resolve(jsonResponse({ services: [{ port: 3000, url: 'https://stale.example.com' }] }));
  await act(async () => Promise.resolve());

  expect(screen.queryAllByText(':3000')).toHaveLength(0);
});

it('preserves displaced services reconciliation after applying a workspace-tool response', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const staleServices = deferred<Response>();
  let pushGlobalEvent: StreamEventPusher | undefined;
  let servicesRequestCount = 0;
  const toolService = { port: 3000, url: 'https://tool.example', status: 'available' as const };
  const authoritativeService = { port: 4000, url: 'https://authoritative.example', status: 'available' as const };
  const sandbox = {
    id: '00000000-0000-4000-8000-000000000501',
    provider: 'fake',
    providerSandboxId: 'sandbox-1',
    status: 'running',
    updatedAt: session.updatedAt,
  };
  mockApi({
    sessionOverride: { sandbox },
    workspaceToolResponse: {
      tool: { id: 'ide', label: 'VS Code' },
      service: toolService,
      session: { ...session, sandbox },
    },
    onListServicesRequest: (count) => {
      servicesRequestCount = count;
      if (count === 2) return staleServices.promise;
      if (count === 3) return jsonResponse({ services: [authoritativeService] });
      return undefined;
    },
    onGlobalStreamOpen: (push) => {
      pushGlobalEvent = push;
    },
  });
  const toolTab = {
    document: document.implementation.createHTMLDocument(''),
    location: { href: '' },
    opener: window,
    close: vi.fn(),
  } as unknown as Window;
  vi.spyOn(window, 'open').mockReturnValue(toolTab);
  render(<App />);

  await screen.findByRole('log', { name: 'Session messages' });
  await waitFor(() => expect(pushGlobalEvent).toBeDefined());
  act(() => {
    pushGlobalEvent?.(
      eventFixture({
        id: 23,
        sequence: 1,
        type: 'session_updated',
        payload: { context: { services: [] } },
      }),
    );
  });
  await act(() => vi.advanceTimersByTimeAsync(125));
  await waitFor(() => expect(servicesRequestCount).toBe(2));

  const header = screen.getByRole('heading', { name: 'Existing session' }).closest('section')!;
  fireEvent.click(within(header).getByRole('button', { name: 'Session actions' }));
  fireEvent.click(within(header).getByRole('menuitem', { name: /VS Code/ }));
  await waitFor(() => expect(toolTab.location.href).toBe(toolService.url));
  await act(async () => {
    staleServices.resolve(jsonResponse({ services: [{ port: 2000, url: 'https://stale.example' }] }));
    await staleServices.promise;
  });
  await act(() => vi.advanceTimersByTimeAsync(0));

  await waitFor(() => expect(servicesRequestCount).toBe(3));
  expect(await screen.findAllByText(':4000')).not.toHaveLength(0);
  expect(screen.queryAllByText(':2000')).toHaveLength(0);
});

it('shows and calls cancel task on the active message', async () => {
  let cancelled = false;
  const requests: string[] = [];
  mockApi({
    requests,
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
  requests.length = 0;
  fireEvent.click(within(messageCard).getByRole('button', { name: 'Cancel task' }));

  await waitFor(() => expect(cancelled).toBe(true));
  await waitFor(() => expect(requests).toContain(`GET /sessions/${session.id}`));
  expect(requests.filter((request) => request === 'GET /sessions?limit=50')).toHaveLength(0);
});

it('applies queue pause and resume Session responses without broad reconciliation', async () => {
  const requests: string[] = [];
  mockApi({
    requests,
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000102',
        sequence: 1,
        status: 'pending',
        prompt: 'edit queued work',
      }),
    ],
  });
  render(<App />);

  const messageCard = await screen.findByRole('article', { name: 'Message 1' });
  requests.length = 0;
  fireEvent.click(within(messageCard).getByRole('button', { name: 'Edit' }));
  await waitFor(() => expect(requests).toContain(`POST /sessions/${session.id}/queue/pause`));
  fireEvent.click(within(messageCard).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(requests).toContain(`POST /sessions/${session.id}/queue/resume`));

  expect(requests.filter((request) => request.startsWith('GET /sessions'))).toHaveLength(0);
  expect(detailResourceRequests(requests)).toEqual([]);
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

  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'dev' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockApi({ hangSessions: true });
  render(<App />);

  expect(await screen.findByText('Loading Deputies')).toBeInTheDocument();

  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(await screen.findByText(/Still waiting for the API to respond/)).toBeInTheDocument();
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

it('shows session lineage and labels deputy-authored messages', async () => {
  const childSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000302',
    title: 'Child investigation',
    parentSessionId: session.id,
    spawnDepth: 1,
    status: 'queued',
  };
  mockApi({
    sessions: [session, childSession],
    messages: [
      messageFixture({
        id: '00000000-0000-4000-8000-000000000303',
        sequence: 1,
        status: 'pending',
        source: 'deputy',
        prompt: 'Child session completed with a summary.',
      }),
    ],
    messagesBySession: { [childSession.id]: [] },
  });
  render(<App />);

  expect(await screen.findByText('Deputy message 1')).toBeInTheDocument();
  const contextPanel = within(await screen.findByLabelText('Desktop context'));
  expect(contextPanel.getByText('Session lineage')).toBeInTheDocument();
  expect(contextPanel.getByText('Children (1)')).toBeInTheDocument();
  fireEvent.click(contextPanel.getByRole('button', { name: /Child investigation/ }));

  await waitFor(() => expect(sessionStorage.getItem('deputies-selected-session-id')).toBe(childSession.id));
});

it('shows a selected session parent in context when filters exclude it from the sidebar', async () => {
  const childSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000302',
    title: 'Child investigation',
    parentSessionId: session.id,
    spawnDepth: 1,
  };
  sessionStorage.setItem('deputies-selected-session-id', childSession.id);
  sessionStorage.setItem(
    'deputies-session-filters',
    JSON.stringify({ tags: [], createdByMe: true, participatedByMe: false, starredByMe: false }),
  );
  mockApi({
    sessions: [childSession],
    onGetSessionRequest: (sessionId) => (sessionId === session.id ? jsonResponse({ session }) : undefined),
  });
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Child investigation' })).toBeInTheDocument();
  const contextPanel = within(await screen.findByLabelText('Desktop context'));
  fireEvent.click(await contextPanel.findByRole('button', { name: /Existing session/ }));
  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  const sidebar = within(screen.getByRole('heading', { name: 'Sessions' }).closest('aside')!);
  expect(sidebar.queryByRole('button', { name: 'Existing session' })).not.toBeInTheDocument();

  const header = screen.getByRole('heading', { name: 'Existing session' }).closest('section');
  fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Session actions' }));
  fireEvent.click(within(header as HTMLElement).getByRole('menuitem', { name: 'Archive session' }));

  expect(await screen.findByText('This session is archived.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  expect(sidebar.queryByRole('button', { name: 'Existing session' })).not.toBeInTheDocument();
});

it('nests deputy sub-sessions under their originating session in the sidebar', async () => {
  const childSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000302',
    title: 'Investigate flaky tests',
    parentSessionId: session.id,
    spawnDepth: 1,
    status: 'running',
  };
  mockApi({ sessions: [childSession, session], messagesBySession: { [childSession.id]: [] } });
  render(<App />);

  const sidebar = within((await screen.findByRole('heading', { name: 'Sessions' })).closest('aside')!);
  const parent = sidebar.getByRole('button', { name: 'Existing session' });
  const child = sidebar.getByRole('button', { name: 'Investigate flaky tests' });
  expect(parent).not.toHaveClass('pl-6');
  expect(child).not.toHaveClass('pl-6');
  expect(child.closest('.ml-2')).toBeInTheDocument();
});

it('loads direct sub-sessions that were not included in the current session page', async () => {
  const parentSession = { ...session, directChildCount: 2 };
  const childSessions = [
    {
      ...session,
      id: '00000000-0000-4000-8000-000000000302',
      title: 'First unloaded child',
      parentSessionId: session.id,
      spawnDepth: 1,
      directChildCount: 0,
    },
    {
      ...session,
      id: '00000000-0000-4000-8000-000000000303',
      title: 'Second unloaded child',
      parentSessionId: session.id,
      spawnDepth: 1,
      directChildCount: 0,
    },
  ];
  mockApi({
    onListSessionsRequest: ({ url }) =>
      url.searchParams.get('parentSessionId') === session.id
        ? jsonResponse({ sessions: childSessions, nextCursor: null })
        : jsonResponse({ sessions: [parentSession], nextCursor: null }),
  });
  render(<App />);

  const sidebar = within((await screen.findByRole('heading', { name: 'Sessions' })).closest('aside')!);
  fireEvent.click(sidebar.getByRole('button', { name: 'Load 2 more sub-sessions' }));

  const firstChild = await sidebar.findByRole('button', { name: 'First unloaded child' });
  const secondChild = sidebar.getByRole('button', { name: 'Second unloaded child' });
  expect(firstChild.closest('.ml-2')).toBeInTheDocument();
  expect(secondChild.closest('.ml-2')).toBeInTheDocument();
  expect(sidebar.queryByRole('button', { name: /Load .* sub-sessions/ })).not.toBeInTheDocument();
});

it('shows loaded sub-sessions when the sidebar becomes hovered before the page resolves', async () => {
  const childPage = deferred<Response>();
  const parentSession = { ...session, directChildCount: 1 };
  const childSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000304',
    title: 'Child loaded while hovered',
    parentSessionId: session.id,
    spawnDepth: 1,
    directChildCount: 0,
  };
  let childPageRequested = false;
  mockApi({
    onListSessionsRequest: ({ url }) => {
      if (url.searchParams.get('parentSessionId') === session.id) {
        childPageRequested = true;
        return childPage.promise;
      }
      return jsonResponse({ sessions: [parentSession], nextCursor: null });
    },
  });
  render(<App />);

  const sidebar = within((await screen.findByRole('heading', { name: 'Sessions' })).closest('aside')!);
  const loadChildren = sidebar.getByRole('button', { name: 'Load 1 more sub-session' });
  fireEvent.click(loadChildren);
  await waitFor(() => expect(childPageRequested).toBe(true));
  fireEvent.pointerEnter(loadChildren);

  await act(async () => {
    childPage.resolve(jsonResponse({ sessions: [childSession], nextCursor: null }));
    await childPage.promise;
  });

  expect(sidebar.getByRole('button', { name: 'Child loaded while hovered' })).toBeInTheDocument();
});

it('ignores a child page that resolves after the session list refreshes', async () => {
  const childPage = deferred<Response>();
  const parentSession = { ...session, directChildCount: 1 };
  const childSession = {
    ...session,
    id: '00000000-0000-4000-8000-000000000302',
    title: 'Stale unloaded child',
    parentSessionId: session.id,
    spawnDepth: 1,
  };
  mockApi({
    onListSessionsRequest: ({ url }) =>
      url.searchParams.get('parentSessionId') === session.id
        ? childPage.promise
        : jsonResponse({ sessions: [parentSession], nextCursor: null }),
  });
  render(<App />);

  const sidebar = within((await screen.findByRole('heading', { name: 'Sessions' })).closest('aside')!);
  fireEvent.click(sidebar.getByRole('button', { name: 'Load 1 more sub-session' }));
  expect(await sidebar.findByRole('button', { name: 'Loading sub-sessions...' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(sidebar.getByRole('button', { name: 'Load 1 more sub-session' })).toBeEnabled());

  await act(async () => {
    childPage.resolve(jsonResponse({ sessions: [childSession], nextCursor: null }));
    await childPage.promise;
  });

  expect(sidebar.queryByText('Stale unloaded child')).not.toBeInTheDocument();
  expect(sidebar.getByRole('button', { name: 'Load 1 more sub-session' })).toBeInTheDocument();
});

it('restores the child count when archiving a parent fails', async () => {
  mockApi({ sessionOverride: { directChildCount: 2 }, archiveStatus: 500 });
  render(<App />);

  const heading = await screen.findByRole('heading', { name: 'Existing session' });
  const header = heading.closest('section');
  fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Session actions' }));
  fireEvent.click(within(header as HTMLElement).getByRole('menuitem', { name: 'Archive session' }));

  expect(await screen.findByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Load 2 more sub-sessions' })).toBeInTheDocument();
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
  expect(screen.getByText('Archived').closest('details')).toHaveAttribute('open');
});

it('keeps the archived session selected after archiving and refreshing', async () => {
  mockApi();
  const first = render(<App />);

  const sessionRow = (await screen.findByRole('button', { name: /Existing session/ })).closest('div');
  if (!sessionRow) throw new Error('Expected session row');
  fireEvent.click(within(sessionRow).getByRole('button', { name: 'Archive session' }));

  expect(await screen.findByText('This session is archived.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
  expect(sessionStorage.getItem('deputies-selected-session-id')).toBe(session.id);
  expect(sessionStorage.getItem('deputies-new-session-selected')).toBeNull();

  first.unmount();
  render(<App />);

  expect(await screen.findByText('This session is archived.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Existing session' })).toBeInTheDocument();
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
  let sessionSkillsRequestCount = 0;
  let servicesRequestCount = 0;
  let eventsRequestCount = 0;
  let globalStreamRequestCount = 0;
  let messageSubmitCount = 0;
  let skills = options.skills;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const method = init?.method ?? 'GET';
    options.requests?.push(`${method} ${url.pathname}${url.search}`);

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
      if (options.hangSessions) return hangingResponse(init);
      if (options.hangSessionsAfterFirst && sessionsRequestCount > 1) return hangingResponse(init);
      const customResponse = options.onListSessionsRequest?.({ count: sessionsRequestCount, url });
      if (customResponse) return customResponse;
      return jsonResponse({
        sessions: options.sessions ?? [currentSession],
        nextCursor: options.sessionsNextCursor ?? null,
      });
    }

    if (url.pathname === '/sessions/tags' && method === 'GET') {
      return jsonResponse({ tags: options.sessionTags ?? [] });
    }

    if (url.pathname === '/sessions/search' && method === 'GET') {
      return jsonResponse({ results: options.searchResults ?? [], nextCursor: options.searchNextCursor ?? null });
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

    const sessionDetailMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (sessionDetailMatch && method === 'GET') {
      const sessionId = sessionDetailMatch[1]!;
      const customResponse = options.onGetSessionRequest?.(sessionId);
      if (customResponse) return customResponse;
      const status = options.sessionDetailStatusById?.[sessionId];
      if (status)
        return jsonResponse(
          { error: status === 403 ? 'forbidden' : 'not_found', message: 'Session unavailable' },
          status,
        );
    }

    if (url.pathname === `/sessions/${currentSession.id}` && method === 'GET') {
      return jsonResponse({ session: currentSession });
    }

    const requestedSession = (options.sessions ?? [currentSession]).find(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'id' in candidate &&
        candidate.id === url.pathname.slice('/sessions/'.length),
    );
    if (url.pathname.match(/^\/sessions\/[^/]+$/) && method === 'GET' && requestedSession) {
      return jsonResponse({ session: requestedSession });
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
      return jsonResponse({
        models,
        defaultModel: models[0] ?? null,
        defaultReasoningLevel: options.defaultReasoningLevel ?? null,
      });
    }

    if (url.pathname === '/setup/status' && method === 'GET') {
      return jsonResponse({ checkedAt: session.updatedAt, items: [] });
    }

    if (url.pathname === '/groups' && method === 'GET') {
      return jsonResponse({ groups: options.groups ?? [group] });
    }

    if (url.pathname === '/environments' && method === 'GET') {
      return jsonResponse({ environments: options.environments ?? [] });
    }

    if (url.pathname === '/snippets' && method === 'GET') {
      if (options.snippets === undefined) return jsonResponse({ error: 'not_found', message: 'Not found' }, 404);
      return jsonResponse({ snippets: options.snippets });
    }

    if (/^\/snippets(?:\/[^/]+)?(?:\/(?:archive|restore))?$/.test(url.pathname) && method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const custom = options.onSnippetMutationRequest?.({ path: url.pathname, method, body });
      if (custom) return custom;
    }

    const updateEnvironmentMatch = url.pathname.match(/^\/environments\/([^/]+)$/);
    if (updateEnvironmentMatch && method === 'PATCH') {
      const environmentId = updateEnvironmentMatch[1]!;
      const environments = options.environments as Array<Record<string, unknown>> | undefined;
      const current = environments?.find((environment) => environment.id === environmentId);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const repositories = Array.isArray(body.repositories)
        ? body.repositories.map((repository, index) => ({
            ...(repository as Record<string, unknown>),
            id: `repository-${index + 1}`,
            position: index,
          }))
        : Array.isArray(current?.repositories)
          ? current.repositories
          : [];
      return jsonResponse({
        environment: {
          ...(current ?? {}),
          ...body,
          id: environmentId,
          repositories,
          currentRevisionId: `${String(current?.currentRevisionId ?? 'revision')}-saved`,
          currentRevisionNumber: Number(current?.currentRevisionNumber ?? 0) + 1,
          updatedAt: session.updatedAt,
        },
      });
    }

    const environmentRevisionsMatch = url.pathname.match(/^\/environments\/([^/]+)\/revisions$/);
    if (environmentRevisionsMatch && method === 'GET') {
      return jsonResponse({ revisions: options.environmentRevisions?.[environmentRevisionsMatch[1]!] ?? [] });
    }

    if (url.pathname === '/skills' && method === 'GET') {
      if (skills === undefined) return jsonResponse({ error: 'not_found', message: 'Not found' }, 404);
      const scope = url.searchParams.get('scope') as 'personal' | 'group' | 'shared' | null;
      const status = scope ? options.skillListStatusByScope?.[scope] : undefined;
      if (status) return jsonResponse({ error: 'forbidden', message: 'Skill list unavailable' }, status);
      return jsonResponse({ skills });
    }

    if (url.pathname === '/skills/invocation-candidates' && method === 'GET') {
      options.invocationCandidateOwnerGroupIds?.push(url.searchParams.get('ownerGroupId') ?? '');
      if (options.invocationCandidateStatus) {
        return jsonResponse(
          { error: 'forbidden', message: 'Invocation candidates unavailable' },
          options.invocationCandidateStatus,
        );
      }
      if (skills === undefined) return jsonResponse({ error: 'not_found', message: 'Not found' }, 404);
      return jsonResponse({ skills: options.invocationSkills ?? skills });
    }

    const updateSkillMatch = url.pathname.match(/^\/skills\/([^/]+)$/);
    if (updateSkillMatch && method === 'PATCH' && skills) {
      const skillId = updateSkillMatch[1]!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      skills = skills.map((candidate) => {
        if (typeof candidate !== 'object' || candidate === null || !('id' in candidate) || candidate.id !== skillId) {
          return candidate;
        }
        const current = candidate as Record<string, unknown>;
        const contentChanged = ['name', 'description', 'body'].some(
          (field) => body[field] !== undefined && body[field] !== current[field],
        );
        const { groupIds, expectedCurrentRevisionId: _expectedCurrentRevisionId, ...updates } = body;
        return {
          ...current,
          ...updates,
          ...(Array.isArray(groupIds) ? { shareGroupIds: groupIds } : {}),
          ...(contentChanged
            ? {
                currentRevisionId: `${String(current.currentRevisionId ?? 'revision')}-saved`,
                currentRevisionNumber: Number(current.currentRevisionNumber ?? 0) + 1,
              }
            : {}),
          updatedAt: session.updatedAt,
        };
      });
      return jsonResponse({
        skill: skills.find(
          (candidate) =>
            typeof candidate === 'object' && candidate !== null && 'id' in candidate && candidate.id === skillId,
        ),
      });
    }

    const updateSkillSharesMatch = url.pathname.match(/^\/skills\/([^/]+)\/shares$/);
    if (updateSkillSharesMatch && method === 'PUT' && skills) {
      const skillId = updateSkillSharesMatch[1]!;
      const body = JSON.parse(String(init?.body)) as { shareMode: string; groupIds?: string[] };
      skills = skills.map((candidate) =>
        typeof candidate === 'object' && candidate !== null && 'id' in candidate && candidate.id === skillId
          ? { ...candidate, shareMode: body.shareMode, shareGroupIds: body.groupIds ?? [] }
          : candidate,
      );
      return jsonResponse({
        skill: skills.find(
          (candidate) =>
            typeof candidate === 'object' && candidate !== null && 'id' in candidate && candidate.id === skillId,
        ),
      });
    }

    const skillRevisionsMatch = url.pathname.match(/^\/skills\/([^/]+)\/revisions$/);
    if (skillRevisionsMatch && method === 'GET') {
      const skill = skills?.find(
        (candidate) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          'id' in candidate &&
          candidate.id === skillRevisionsMatch[1],
      ) as Record<string, unknown> | undefined;
      return jsonResponse({
        revisions:
          typeof skill?.currentRevisionId === 'string'
            ? [
                {
                  id: skill.currentRevisionId,
                  skillId: skill.id,
                  revisionNumber: skill.currentRevisionNumber,
                  name: skill.name,
                  description: skill.description,
                  body: skill.body ?? '',
                  actorType: 'user',
                  createdAt: skill.updatedAt,
                },
              ]
            : [],
      });
    }

    const sessionSkillsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/skills$/);
    if (sessionSkillsMatch && method === 'GET') {
      if (skills === undefined) return jsonResponse({ error: 'not_found', message: 'Not found' }, 404);
      sessionSkillsRequestCount += 1;
      const customResponse = options.onListSessionSkillsRequest?.({
        count: sessionSkillsRequestCount,
        sessionId: sessionSkillsMatch[1]!,
      });
      if (customResponse) return customResponse;
      return jsonResponse({ skills });
    }

    const archiveSkillMatch = url.pathname.match(/^\/skills\/([^/]+)\/archive$/);
    if (archiveSkillMatch && method === 'POST' && skills) {
      const skillId = archiveSkillMatch[1]!;
      options.archivedSkillIds?.push(skillId);
      skills = skills.map((candidate) =>
        typeof candidate === 'object' && candidate !== null && 'id' in candidate && candidate.id === skillId
          ? { ...candidate, archivedAt: session.updatedAt }
          : candidate,
      );
      return jsonResponse({
        skill: skills.find(
          (candidate) =>
            typeof candidate === 'object' && candidate !== null && 'id' in candidate && candidate.id === skillId,
        ),
      });
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
      if (options.hangUnarchive) return hangingResponse(init);
      currentSession = { ...currentSession, status: 'idle' };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname === `/sessions/${currentSession.id}/archive` && method === 'POST') {
      if (options.hangArchive) return hangingResponse(init);
      if (options.archiveStatus) {
        return jsonResponse({ error: 'archive_failed', message: 'Archive failed' }, options.archiveStatus);
      }
      options.archivedSessionIds?.push(currentSession.id);
      currentSession = { ...currentSession, status: 'archived' };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname === `/sessions/${currentSession.id}` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { title?: string; tags?: string[] };
      currentSession = {
        ...currentSession,
        ...(body.title ? { title: body.title } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
      };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname === `/sessions/${currentSession.id}/star` && (method === 'PUT' || method === 'DELETE')) {
      const starred = method === 'PUT';
      const customResponse = options.onStarSessionRequest?.({ starred });
      if (customResponse) return customResponse;
      currentSession = { ...currentSession, starred };
      return jsonResponse({ starred });
    }

    if (url.pathname === `/sessions/${currentSession.id}/access` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as Partial<typeof session>;
      options.accessUpdates?.push(body);
      const customResponse = options.onUpdateAccessRequest?.(body);
      if (customResponse) return customResponse;
      currentSession = { ...currentSession, ...body };
      return jsonResponse({ session: currentSession });
    }

    const messagesListMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
    if (messagesListMatch && method === 'GET') {
      const sessionId = messagesListMatch[1]!;
      if (options.hangMessagesForSessions?.includes(sessionId)) {
        return hangingResponse(init, () => options.abortedRequests?.push(`${method} ${url.pathname}`));
      }
      return jsonResponse({ messages: options.messagesBySession?.[sessionId] ?? messages });
    }

    if (url.pathname === `/sessions/${currentSession.id}/messages` && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { prompt: string } & Record<string, unknown>;
      messageSubmitCount += 1;
      if (options.messageSubmitError) {
        return jsonResponse(options.messageSubmitError.body, options.messageSubmitError.status);
      }
      options.submittedPrompts?.push(body.prompt);
      options.submittedMessageBodies?.push(body);
      const customResponse = options.onMessageSubmitRequest?.({ count: messageSubmitCount, body });
      if (customResponse) return customResponse;
      const message = {
        id: `00000000-0000-4000-8000-${String(100 + messageSubmitCount).padStart(12, '0')}`,
        sessionId: currentSession.id,
        sequence: 1,
        status: 'pending',
        prompt: body.prompt,
        ...('context' in body ? { context: body.context } : {}),
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

    if (url.pathname === `/sessions/${currentSession.id}/queue/pause` && method === 'POST') {
      currentSession = {
        ...currentSession,
        queuePausedAt: '2026-05-05T12:03:00.000Z',
        updatedAt: '2026-05-05T12:03:00.000Z',
      };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname === `/sessions/${currentSession.id}/queue/resume` && method === 'POST') {
      const { queuePausedAt: _queuePausedAt, ...resumedSession } = currentSession;
      currentSession = { ...resumedSession, updatedAt: '2026-05-05T12:04:00.000Z' };
      return jsonResponse({ session: currentSession });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/events$/)) {
      const sessionId = url.pathname.split('/')[2]!;
      eventsRequestCount += 1;
      if (url.searchParams.has('after') && options.hangIncrementalEventsForSessions?.includes(sessionId)) {
        return hangingResponse(init, () => options.abortedRequests?.push(`${method} ${url.pathname}`));
      }
      const customResponse = options.onListEventsRequest?.({ count: eventsRequestCount, sessionId, url });
      if (customResponse) return customResponse;
      return jsonResponse({
        events: filterEventsAfter(
          options.eventsBySession?.[sessionId] ?? options.events ?? [],
          url.searchParams.get('after'),
        ),
      });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/artifacts$/)) {
      if (options.hangArtifacts) return hangingResponse(init);
      return jsonResponse({ artifacts: options.artifacts ?? [] });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/services$/)) {
      servicesRequestCount += 1;
      const customResponse = options.onListServicesRequest?.(servicesRequestCount);
      if (customResponse) return customResponse;
      return jsonResponse({ services: options.services ?? [] });
    }

    if (url.pathname.match(/^\/sessions\/[^/]+\/workspace-tools\/(ide|diff)\/open$/) && method === 'POST') {
      return options.workspaceToolResponse
        ? jsonResponse(options.workspaceToolResponse)
        : jsonResponse({ error: 'not_found', message: 'Workspace tool unavailable' }, 404);
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
      globalStreamRequestCount += 1;
      const customResponse = options.onGlobalStreamRequest?.(url, globalStreamRequestCount);
      if (customResponse) return customResponse;
      if (options.globalStreamStatus) return new Response(null, { status: options.globalStreamStatus });
      return new Response(
        new ReadableStream({
          start(controller) {
            const pushStreamEvent: StreamEventPusher = (event) => {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            options.onGlobalStreamOpen?.(pushStreamEvent, () => controller.close());
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
    const eventCursor = (event as { sequence?: unknown }).sequence;
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

function environmentFixture() {
  return {
    id: 'environment-1',
    name: 'Production',
    ownerGroupId: group.id,
    ownerGroupName: group.name,
    shareMode: 'private',
    currentRevisionId: 'environment-revision-2',
    currentRevisionNumber: 2,
    sharedGroupIds: [],
    repositories: [
      {
        id: 'repository-current',
        provider: 'github',
        owner: 'owner',
        repo: 'current-repo',
        primary: true,
        position: 0,
      },
    ],
    canManage: true,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function environmentRevisionFixture(id: string, revisionNumber: number, repo: string) {
  return {
    id,
    environmentId: 'environment-1',
    revisionNumber,
    actorType: 'user',
    createdAt: session.updatedAt,
    repositories: [{ provider: 'github', owner: 'owner', repo, primary: true, position: 0 }],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function hangingResponse(init: RequestInit | undefined, onAbort?: () => void): Promise<Response> {
  return new Promise((_, reject) => {
    if (init?.signal?.aborted) {
      onAbort?.();
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    init?.signal?.addEventListener(
      'abort',
      () => {
        onAbort?.();
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function detailResourceRequests(requests: string[]): string[] {
  return requests.filter((request) =>
    ['/messages', '/artifacts', '/services', '/external-resources', '/callbacks'].some((suffix) =>
      request.startsWith(`GET /sessions/${session.id}${suffix}`),
    ),
  );
}
