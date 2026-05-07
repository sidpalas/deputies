import { FormEvent, KeyboardEvent, SyntheticEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Archive, Check, ChevronDown, Copy, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, RotateCcw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ApiError,
  AgentEvent,
  Artifact,
  CallbackDelivery,
  Message,
  Session,
  archiveSession,
  cancelCurrentRun,
  cancelMessage,
  createSession,
  enqueueMessage,
  getApiBaseUrl,
  getCurrentUser,
  getHealth,
  login,
  listArtifacts,
  listCallbacks,
  listEvents,
  listMessages,
  listSessions,
  logout,
  pauseQueue,
  replayCallback,
  resumeQueue,
  streamEvents,
  unarchiveSession,
  updateMessage,
  updateSession,
  type Health,
  type AuthUser,
} from './api.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { Textarea } from './components/ui/textarea.js';
import { cn } from './lib/utils.js';

const tokenStorageKey = 'dev-deputies-api-token';
const selectedSessionStorageKey = 'dev-deputies-selected-session-id';
const newSessionSelectedStorageKey = 'dev-deputies-new-session-selected';
const archivedSessionsOpenStorageKey = 'dev-deputies-archived-sessions-open';
const threadAutoFollowThreshold = 160;

function loadStoredToken(): string {
  return localStorage.getItem(tokenStorageKey) ?? '';
}

function isThreadNearBottom(container: HTMLElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threadAutoFollowThreshold;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState(loadStoredToken);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(() => localStorage.getItem(selectedSessionStorageKey) ?? '');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isCreatingThread, setIsCreatingThread] = useState(() => localStorage.getItem(newSessionSelectedStorageKey) === 'true');
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [callbacks, setCallbacks] = useState<CallbackDelivery[]>([]);
  const [newThreadPrompt, setNewThreadPrompt] = useState('');
  const [newThreadRepository, setNewThreadRepository] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [prompt, setPrompt] = useState('');
  const [repository, setRepository] = useState('');
  const [editingMessageId, setEditingMessageId] = useState('');
  const [messageDraft, setMessageDraft] = useState('');
  const [draftToken, setDraftToken] = useState(token);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [threadSearch, setThreadSearch] = useState('');
  const [archivedSessionsOpen, setArchivedSessionsOpen] = useState(() => localStorage.getItem(archivedSessionsOpenStorageKey) === 'true');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const eventCursor = useRef(0);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const threadAutoFollowRef = useRef(true);
  const autoScrolledSessionId = useRef('');

  const bearerAuthRequired = health?.apiAuthMode === 'bearer';
  const sessionAuthRequired = health?.apiAuthMode === 'session';
  const waitingForAuth = !health || (sessionAuthRequired && !authChecked);
  const canCallApi = Boolean(health) && (!bearerAuthRequired || Boolean(token)) && (!sessionAuthRequired || Boolean(currentUser));
  const startupLoading = waitingForAuth || (canCallApi && !sessionsLoaded);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedRepository = repositoryLabel(selectedSession?.context?.repository);
  const selectedSessionArchived = selectedSession?.status === 'archived';
  const filteredSessions = filterSessions(sortSessionsByLastActivity(sessions), threadSearch);
  const activeSessions = filteredSessions.filter((session) => session.status !== 'archived');
  const archivedSessions = filteredSessions.filter((session) => session.status === 'archived');

  useEffect(() => {
    setTitleDraft(selectedSession?.title ?? '');
    setEditingTitle(false);
  }, [selectedSession?.id, selectedSession?.title]);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (!health) return;
    if (health.apiAuthMode !== 'session') {
      setCurrentUser(null);
      setAuthChecked(true);
      return;
    }
    setAuthChecked(false);
    getCurrentUser()
      .then(setCurrentUser)
      .catch(() => setCurrentUser(null))
      .finally(() => setAuthChecked(true));
  }, [health?.apiAuthMode]);

  useEffect(() => {
    if (!canCallApi) return;
    refreshSessions();
  }, [canCallApi, token]);

  useEffect(() => {
    if (!selectedSessionId || !canCallApi) return;
    refreshSessionDetail(selectedSessionId);
  }, [selectedSessionId, canCallApi, token]);

  useLayoutEffect(() => {
    const container = threadScrollRef.current;
    if (!container || !selectedSessionId) return;

    if (autoScrolledSessionId.current !== selectedSessionId) {
      autoScrolledSessionId.current = selectedSessionId;
      setThreadAutoFollowEnabled(true);
      scrollThreadToBottom();
      return;
    }

    if (threadAutoFollowRef.current || isThreadNearBottom(container)) {
      scrollThreadToBottom();
      return;
    }

    setShowJumpToLatest(true);
  }, [selectedSessionId, messages.length, events.length]);

  useEffect(() => {
    if (!selectedSessionId || !canCallApi) return;

    const abort = new AbortController();
    streamEvents({
      sessionId: selectedSessionId,
      after: eventCursor.current,
      token,
      signal: abort.signal,
      onEvent: (event) => {
        eventCursor.current = Math.max(eventCursor.current, event.sequence);
        setEvents((current) => upsertEvent(current, event));
        if (shouldRefreshSessionDetail(event.type)) {
          refreshMessagesArtifactsAndCallbacks(selectedSessionId).catch(() => undefined);
          refreshSessions().catch(() => undefined);
        }
      },
    }).catch((err: unknown) => {
      if (!abort.signal.aborted) {
        refreshSessionDetail(selectedSessionId).catch(() => undefined);
        refreshSessions().catch(() => undefined);
        setError(errorMessage(err));
      }
    });

    return () => abort.abort();
  }, [selectedSessionId, canCallApi, token]);

  async function refreshSessions() {
    setLoading(true);
    setError('');
    try {
      const nextSessions = await listSessions(token);
      setSessions(nextSessions);
      setSessionsLoaded(true);
      setSelectedSessionId((current) => {
        if (current && nextSessions.some((session) => session.id === current)) return current;
        if (localStorage.getItem(newSessionSelectedStorageKey) === 'true') return '';
        const next = nextSessions[0]?.id ?? '';
        if (next) localStorage.setItem(selectedSessionStorageKey, next);
        else localStorage.removeItem(selectedSessionStorageKey);
        return next;
      });
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  async function refreshSessionDetail(sessionId: string) {
    setError('');
    try {
      const [nextMessages, nextEvents, nextArtifacts, nextCallbacks] = await Promise.all([
        listMessages(sessionId, token),
        listEvents(sessionId, token),
        listArtifacts(sessionId, token),
        listCallbacks(sessionId, token),
      ]);
      eventCursor.current = nextEvents.at(-1)?.sequence ?? 0;
      setMessages(nextMessages);
      setEvents(nextEvents);
      setArtifacts(nextArtifacts);
      setCallbacks(nextCallbacks);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function refreshMessagesArtifactsAndCallbacks(sessionId: string) {
    const [nextMessages, nextArtifacts, nextCallbacks] = await Promise.all([
      listMessages(sessionId, token),
      listArtifacts(sessionId, token),
      listCallbacks(sessionId, token),
    ]);
    setMessages(nextMessages);
    setArtifacts(nextArtifacts);
    setCallbacks(nextCallbacks);
  }

  async function handleCreateThread(event: FormEvent) {
    event.preventDefault();
    const firstPrompt = newThreadPrompt.trim();
    if (!firstPrompt) return;
    setLoading(true);
    setError('');
    try {
      const session = await createSession({ title: titleFromPrompt(firstPrompt), token });
      const firstRepository = newThreadRepository.trim();
      const message = await enqueueMessage({
        sessionId: session.id,
        prompt: firstPrompt,
        token,
        ...(firstRepository ? { repository: firstRepository } : {}),
      });
      setSessions((current) => [session, ...current]);
      selectSession(session.id);
      setMessages([message]);
      setEvents([]);
      setArtifacts([]);
      setCallbacks([]);
      eventCursor.current = 0;
      setNewThreadPrompt('');
      setNewThreadRepository('');
      setIsCreatingThread(false);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSendMessage(event: FormEvent) {
    event.preventDefault();
    if (!selectedSessionId || selectedSessionArchived || !prompt.trim()) return;
    setError('');
    try {
      const repositoryInput = repository.trim();
      const message = await enqueueMessage({
        sessionId: selectedSessionId,
        prompt: prompt.trim(),
        token,
        ...(repositoryInput ? { repository: repositoryInput } : {}),
      });
      setMessages((current) => [...current, message]);
      setThreadAutoFollowEnabled(true);
      setPrompt('');
      await refreshSessions();
      await refreshSessionDetail(selectedSessionId);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleUpdateTitle(event: FormEvent) {
    event.preventDefault();
    if (!selectedSessionId || !titleDraft.trim()) return;
    setError('');
    try {
      const session = await updateSession({ sessionId: selectedSessionId, title: titleDraft.trim(), token });
      setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
      setEditingTitle(false);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleArchiveSession() {
    if (!selectedSessionId) return;
    setError('');
    try {
      const session = await archiveSession({ sessionId: selectedSessionId, token });
      applyArchivedSession(session);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function startEditingMessage(message: Message) {
    if (!selectedSessionId || message.status !== 'pending') return;
    setError('');
    try {
      const session = await pauseQueue({ sessionId: selectedSessionId, token });
      setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
      setEditingMessageId(message.id);
      setMessageDraft(message.prompt);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function finishEditingMessage(resume: boolean) {
    if (!selectedSessionId || !editingMessageId) return;
    setError('');
    try {
      if (resume) {
        const session = await resumeQueue({ sessionId: selectedSessionId, token });
        setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
      }
      setEditingMessageId('');
      setMessageDraft('');
    } catch (err) {
      handleApiError(err);
    }
  }

  async function saveMessageEdit() {
    if (!selectedSessionId || !editingMessageId || !messageDraft.trim()) return;
    setError('');
    try {
      const message = await updateMessage({ sessionId: selectedSessionId, messageId: editingMessageId, prompt: messageDraft.trim(), token });
      setMessages((current) => current.map((candidate) => (candidate.id === message.id ? message : candidate)));
      await finishEditingMessage(true);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function cancelQueuedMessage(messageId: string) {
    if (!selectedSessionId) return;
    setError('');
    try {
      const message = await cancelMessage({ sessionId: selectedSessionId, messageId, token });
      setMessages((current) => current.map((candidate) => (candidate.id === message.id ? message : candidate)));
    } catch (err) {
      handleApiError(err);
    }
  }

  async function cancelRun() {
    if (!selectedSessionId) return;
    setError('');
    try {
      const cancelledMessages = await cancelCurrentRun({ sessionId: selectedSessionId, token });
      setMessages((current) => current.map((candidate) => cancelledMessages.find((message) => message.id === candidate.id) ?? candidate));
      await refreshSessions();
    } catch (err) {
      handleApiError(err);
    }
  }

  function saveToken(event: FormEvent) {
    event.preventDefault();
    const nextToken = draftToken.trim();
    localStorage.setItem(tokenStorageKey, nextToken);
    setToken(nextToken);
    setError('');
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const user = await login({ username: loginUsername.trim(), password: loginPassword });
      setCurrentUser(user);
      setAuthChecked(true);
      setLoginPassword('');
    } catch (err) {
      handleApiError(err);
    }
  }

  function signOut() {
    if (sessionAuthRequired) {
      void logout().catch(() => undefined);
      setCurrentUser(null);
      setAuthChecked(true);
      setLoginPassword('');
    }
    localStorage.removeItem(tokenStorageKey);
    setToken('');
    setDraftToken('');
    localStorage.removeItem(selectedSessionStorageKey);
    localStorage.removeItem(newSessionSelectedStorageKey);
    setSessions([]);
    setSessionsLoaded(false);
    setSelectedSessionId('');
    setIsCreatingThread(false);
    setMessages([]);
    setEvents([]);
    setArtifacts([]);
    setCallbacks([]);
  }

  function startNewThread() {
    setSidebarCollapsed(false);
    localStorage.removeItem(selectedSessionStorageKey);
    localStorage.setItem(newSessionSelectedStorageKey, 'true');
    setSelectedSessionId('');
    setIsCreatingThread(true);
    setMessages([]);
    setEvents([]);
    setArtifacts([]);
    setCallbacks([]);
    setPrompt('');
    setRepository('');
    eventCursor.current = 0;
  }

  function selectSession(sessionId: string) {
    autoScrolledSessionId.current = '';
    localStorage.setItem(selectedSessionStorageKey, sessionId);
    localStorage.removeItem(newSessionSelectedStorageKey);
    setSelectedSessionId(sessionId);
    setIsCreatingThread(false);
    setSidebarOpen(false);
  }

  function setThreadAutoFollowEnabled(enabled: boolean) {
    threadAutoFollowRef.current = enabled;
    if (enabled) setShowJumpToLatest(false);
  }

  function handleThreadScroll() {
    const container = threadScrollRef.current;
    if (!container) return;
    setThreadAutoFollowEnabled(isThreadNearBottom(container));
  }

  function jumpToLatestThreadActivity() {
    setThreadAutoFollowEnabled(true);
    scrollThreadToBottom('smooth');
  }

  function scrollThreadToBottom(behavior: ScrollBehavior = 'auto') {
    threadEndRef.current?.scrollIntoView({ block: 'end', behavior });
  }

  function toggleSidebar() {
    setSidebarOpen((open) => !open);
    setSidebarCollapsed((collapsed) => !collapsed);
  }

  function applyArchivedSession(session: Session) {
    setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
    if (selectedSessionId === session.id) {
      localStorage.removeItem(selectedSessionStorageKey);
      localStorage.setItem(newSessionSelectedStorageKey, 'true');
      setSelectedSessionId('');
      setIsCreatingThread(true);
      setMessages([]);
      setEvents([]);
      setArtifacts([]);
      setCallbacks([]);
      eventCursor.current = 0;
    }
  }

  async function archiveFromList(sessionId: string) {
    setError('');
    try {
      const session = await archiveSession({ sessionId, token });
      applyArchivedSession(session);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function unarchiveFromList(sessionId: string) {
    setError('');
    try {
      const session = await unarchiveSession({ sessionId, token });
      setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
    } catch (err) {
      handleApiError(err);
    }
  }

  async function restoreSelectedSession() {
    if (!selectedSessionId) return;
    setError('');
    try {
      const session = await unarchiveSession({ sessionId: selectedSessionId, token });
      setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleReplayCallback(callbackId: string) {
    if (!selectedSessionId) return;
    setError('');
    try {
      const callback = await replayCallback({ sessionId: selectedSessionId, callbackId, token });
      setCallbacks((current) => current.map((candidate) => (candidate.id === callback.id ? callback : candidate)));
      await refreshSessionDetail(selectedSessionId);
    } catch (err) {
      handleApiError(err);
    }
  }

  function handleApiError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) signOut();
    setError(errorMessage(err));
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      {error ? <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-2 text-sm text-red-200">{error}</div> : null}

      {startupLoading ? <StartupLoadingPanel /> : bearerAuthRequired && !token ? <BearerAuthPanel draftToken={draftToken} setDraftToken={setDraftToken} saveToken={saveToken} /> : sessionAuthRequired && !currentUser ? <SessionAuthPanel password={loginPassword} username={loginUsername} onPasswordChange={setLoginPassword} onSubmit={handleLogin} onUsernameChange={setLoginUsername} /> : (
        <>

      {!sidebarCollapsed && !sidebarOpen ? (
        <Button className="fixed left-3 top-3 z-30 h-9 w-9 p-0 shadow-xl md:hidden" variant="secondary" size="icon" onClick={() => setSidebarOpen(true)} aria-label="Open sessions" title="Open sessions">
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
      ) : null}

      <section className={cn('grid min-h-0 flex-1', sidebarCollapsed ? 'grid-cols-[3.75rem_minmax(0,1fr)]' : 'grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)]')}>
        {sidebarCollapsed ? (
          <aside className="flex min-h-0 border-r border-slate-800 bg-slate-950/95 p-3">
            <Button className="h-9 w-9 p-0 text-slate-400 hover:text-slate-100" variant="ghost" size="icon" onClick={toggleSidebar} aria-label="Open sessions" title="Open sessions">
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          </aside>
        ) : (
          <aside
            className={cn(
              'fixed left-2 top-2 z-40 hidden h-[calc(100vh-1rem)] min-h-0 w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-slate-800 bg-slate-950 p-3 shadow-2xl md:static md:z-auto md:block md:h-full md:w-auto md:rounded-none md:border-y-0 md:border-l-0 md:shadow-none',
              sidebarOpen && 'block',
            )}
          >
            <ThreadSidebar
              activeSessions={activeSessions}
              archivedSessions={archivedSessions}
              archivedSessionsOpen={archivedSessionsOpen || Boolean(selectedSessionArchived)}
              authRequired={bearerAuthRequired || sessionAuthRequired}
              canCallApi={canCallApi}
              health={health}
              loading={loading}
              search={threadSearch}
              selectedSessionId={selectedSessionId}
              token={token}
              onArchive={archiveFromList}
              onArchivedSessionsOpenChange={setArchivedSessionsOpen}
              onCollapse={toggleSidebar}
              onNewThread={startNewThread}
              onRefresh={refreshSessions}
              onSearch={setThreadSearch}
              onSelect={selectSession}
              onSignOut={signOut}
              onUnarchive={unarchiveFromList}
            />
          </aside>
        )}

        <section className="min-h-0 min-w-0 overflow-hidden">
          {health?.sandboxProvider === 'local' ? <LocalSandboxWarning /> : null}
          {isCreatingThread || !selectedSession ? (
              <NewThreadPanel
                canCallApi={canCallApi}
                loading={loading}
                prompt={newThreadPrompt}
                repository={newThreadRepository}
                onPromptChange={setNewThreadPrompt}
                onRepositoryChange={setNewThreadRepository}
                onSubmit={handleCreateThread}
              />
          ) : (
            <section className="flex h-full min-h-0 flex-col">
              <ThreadHeader
                editingTitle={editingTitle}
                selectedSession={selectedSession}
                titleDraft={titleDraft}
                onArchive={handleArchiveSession}
                onCancelTitle={() => setEditingTitle(false)}
                onEditTitle={() => setEditingTitle(true)}
                onTitleDraftChange={setTitleDraft}
                onUpdateTitle={handleUpdateTitle}
              />
              <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <section className="flex min-h-0 min-w-0 flex-col px-3 pt-4 md:px-8 xl:px-20">
                  <div className="relative min-h-0 flex-1">
                    <div className="h-full overflow-auto pb-4" ref={threadScrollRef} onScroll={handleThreadScroll} role="log" aria-label="Session messages">
                      <ChatPanel
                        editingMessageId={editingMessageId}
                        events={events}
                        messageDraft={messageDraft}
                        messages={messages}
                        onCancelEdit={() => finishEditingMessage(true)}
                        onCancelQueuedMessage={cancelQueuedMessage}
                        onCancelRun={cancelRun}
                        onEditMessage={startEditingMessage}
                        onMessageDraftChange={setMessageDraft}
                        onSaveEdit={saveMessageEdit}
                      />
                      <div ref={threadEndRef} />
                    </div>
                    {showJumpToLatest ? (
                      <Button className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 shadow-xl" type="button" variant="secondary" onClick={jumpToLatestThreadActivity}>
                        <ChevronDown className="h-4 w-4" /> Jump to latest
                      </Button>
                    ) : null}
                  </div>
                  {selectedSessionArchived ? <ArchivedSessionNotice onRestore={restoreSelectedSession} /> : null}
                  <form className="shrink-0 bg-slate-950/95 py-3" onSubmit={handleSendMessage}>
                    <Card className="overflow-hidden border-slate-700 bg-slate-900/70">
                      <Textarea
                        className="min-h-28 border-0 bg-transparent focus:ring-0"
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        onKeyDown={(event) => submitOnEnter(event)}
                        placeholder={selectedSessionArchived ? 'Restore this archived session before sending new work.' : 'Ask your deputy to investigate, change code, or follow up...'}
                        disabled={selectedSessionArchived}
                      />
                      <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 px-3 py-2 text-xs text-slate-500">
                        <Input
                          className="h-8 min-w-0 flex-1 border-slate-800 bg-slate-950/70 text-xs min-[480px]:max-w-80"
                          value={repository}
                          onChange={(event) => setRepository(event.target.value)}
                          placeholder={selectedRepository ? 'Override repo...' : 'GitHub repo, e.g. owner/repo'}
                          disabled={selectedSessionArchived}
                        />
                        {selectedSessionArchived ? <span className="min-w-full text-center sm:min-w-0 sm:flex-1 sm:text-left">Archived sessions are read-only until restored.</span> : null}
                        <Button className="ml-auto shrink-0 whitespace-nowrap" type="submit" disabled={selectedSessionArchived || !prompt.trim()}>Send message</Button>
                      </div>
                    </Card>
                  </form>
                </section>
                <ContextPanel repository={selectedRepository} artifacts={artifacts} callbacks={callbacks} onReplayCallback={handleReplayCallback} />
              </div>
            </section>
          )}
        </section>
      </section>
        </>
      )}
    </main>
  );
}

function LocalSandboxWarning() {
  return (
    <div className="border-b border-amber-700/70 bg-amber-950/35 px-3 py-2 text-sm text-amber-100 md:px-8 xl:px-20" role="alert">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <p>
          <strong>Local sandbox mode is not a security boundary.</strong> Commands run on this machine in a temporary workspace. Use it only for trusted local development.
        </p>
      </div>
    </div>
  );
}

function ThreadSidebar(props: {
  activeSessions: Session[];
  archivedSessions: Session[];
  archivedSessionsOpen: boolean;
  authRequired: boolean;
  canCallApi: boolean;
  health: Health | null;
  loading: boolean;
  search: string;
  selectedSessionId: string;
  token: string;
  onArchive: (sessionId: string) => void;
  onArchivedSessionsOpenChange: (open: boolean) => void;
  onCollapse: () => void;
  onNewThread: () => void;
  onRefresh: () => void;
  onSearch: (value: string) => void;
  onSelect: (sessionId: string) => void;
  onSignOut: () => void;
  onUnarchive: (sessionId: string) => void;
}) {
  const searching = Boolean(props.search.trim());

  function handleArchivedToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (searching) return;
    const open = event.currentTarget.open;
    localStorage.setItem(archivedSessionsOpenStorageKey, String(open));
    props.onArchivedSessionsOpenChange(open);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <Button className="shrink-0" variant="ghost" size="icon" onClick={props.onCollapse} aria-label="Hide sidebar" title="Hide sidebar"><PanelLeftClose className="h-4 w-4" /></Button>
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Sessions</h2>
        <div className="flex shrink-0 gap-2">
          <Button size="icon" onClick={props.onNewThread} disabled={!props.canCallApi} aria-label="New session"><Plus className="h-4 w-4" /></Button>
          <Button variant="secondary" size="icon" onClick={props.onRefresh} disabled={!props.canCallApi || props.loading} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>
      <div className="relative mb-3 shrink-0">
        <Input className="pr-9" value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="Search sessions..." />
        {props.search ? (
          <Button className="absolute right-1 top-1 h-8 w-8 p-0" variant="ghost" size="icon" onClick={() => props.onSearch('')} aria-label="Clear search" title="Clear search">
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="grid min-w-0 gap-1">
          {props.activeSessions.map((session) => (
            <SessionButton key={session.id} session={session} selected={session.id === props.selectedSessionId} onArchive={props.onArchive} onSelect={props.onSelect} />
          ))}
          {!props.activeSessions.length ? <p className="px-2 py-3 text-sm text-slate-500">{props.search ? 'No matching active sessions.' : 'No active sessions.'}</p> : null}
        </div>
        {props.archivedSessions.length || searching ? (
          <details className="mt-4 border-t border-slate-800 pt-3" open={searching || props.archivedSessionsOpen} onToggle={handleArchivedToggle}>
            <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-slate-400"><ChevronDown className="h-4 w-4" /> Archived · {props.archivedSessions.length}</summary>
            {props.archivedSessions.length ? (
              <div className="mt-2 grid min-w-0 gap-1 opacity-80">
                {props.archivedSessions.map((session) => <SessionButton key={session.id} session={session} selected={session.id === props.selectedSessionId} onSelect={props.onSelect} onUnarchive={props.onUnarchive} />)}
              </div>
            ) : <p className="px-2 py-3 text-sm text-slate-500">No matching archived sessions.</p>}
          </details>
        ) : null}
      </div>
      <ApiStatusFooter authRequired={props.authRequired} health={props.health} token={props.token} onSignOut={props.onSignOut} />
    </div>
  );
}

function StartupLoadingPanel() {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="max-w-lg p-6 text-center">
        <h2 className="text-lg font-semibold">Loading Deputies</h2>
        <p className="mt-2 text-sm text-slate-400">Restoring your session and workspace.</p>
      </Card>
    </section>
  );
}

function ApiStatusFooter(props: { authRequired: boolean; health: Health | null; token: string; onSignOut: () => void }) {
  return (
    <div className="mt-3 shrink-0 border-t border-slate-800 pt-3 text-left text-xs text-slate-500">
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', props.health?.status === 'ok' ? 'bg-emerald-400' : 'bg-orange-400')} />
        <strong className="text-slate-300">{props.health ? `API ${props.health.status}` : 'Checking API'}</strong>
      </div>
      <p className="mt-1 truncate">{getApiBaseUrl()}</p>
      {props.health ? <p>{props.health.runMode} mode · auth {props.health.apiAuthMode}</p> : null}
      {props.authRequired && (props.token || props.health?.apiAuthMode === 'session') ? <Button className="mt-2" variant="secondary" size="sm" onClick={props.onSignOut}>{props.health?.apiAuthMode === 'session' ? 'Sign out' : 'Clear token'}</Button> : null}
    </div>
  );
}

function SessionButton(props: {
  session: Session;
  selected: boolean;
  onSelect: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onUnarchive?: (sessionId: string) => void;
}) {
  return (
    <div className={cn('group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-transparent p-2 hover:bg-slate-900', props.selected && 'border-sky-400 bg-sky-950/30')}>
      <button className="block min-w-0 flex-1 overflow-hidden bg-transparent p-0 text-left" type="button" onClick={() => props.onSelect(props.session.id)}>
        <strong className="block w-full truncate text-sm font-medium text-slate-100">{props.session.title || 'Untitled session'}</strong>
        <span className="block w-full truncate text-xs text-slate-500"><span className={statusTextClass(props.session.status)}>{props.session.status}</span> · {formatDate(props.session.updatedAt)}</span>
      </button>
      {props.onArchive ? <Button className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" variant="ghost" size="sm" onClick={() => props.onArchive?.(props.session.id)} aria-label="Archive session" title="Archive session"><Archive className="h-3.5 w-3.5" /></Button> : null}
      {props.onUnarchive ? <Button className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" variant="ghost" size="sm" onClick={() => props.onUnarchive?.(props.session.id)} aria-label="Restore session" title="Restore session"><RotateCcw className="h-3.5 w-3.5" /></Button> : null}
    </div>
  );
}

function ArchivedSessionNotice(props: { onRestore: () => void }) {
  return (
    <Card className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3 border-amber-700/60 bg-amber-950/20 p-3">
      <div>
        <p className="text-sm font-medium text-amber-100">This session is archived.</p>
        <p className="text-xs text-amber-200/70">Restore it before sending a new message.</p>
      </div>
      <Button type="button" variant="secondary" onClick={props.onRestore}><RotateCcw className="h-4 w-4" /> Restore session</Button>
    </Card>
  );
}

function BearerAuthPanel(props: { draftToken: string; setDraftToken: (value: string) => void; saveToken: (event: FormEvent) => void }) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-sky-300">Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-50">Engineering agents for delegated work.</h1>
        <p className="mt-2 text-sm text-slate-400">Assign follow-ups, watch the work trail, and inspect the results.</p>
        <form className="mt-6 grid gap-3" onSubmit={props.saveToken}>
          <div>
            <strong>API token required</strong>
            <p className="text-sm text-slate-400">Enter the backend bearer token. It stays in this browser's local storage.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input type="password" value={props.draftToken} onChange={(event) => props.setDraftToken(event.target.value)} placeholder="Bearer token" />
            <Button type="submit">Use token</Button>
          </div>
        </form>
      </Card>
    </section>
  );
}

function SessionAuthPanel(props: { username: string; password: string; onUsernameChange: (value: string) => void; onPasswordChange: (value: string) => void; onSubmit: (event: FormEvent) => void }) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-sky-300">Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-50">Sign in to Deputies.</h1>
        <p className="mt-2 text-sm text-slate-400">Use your operator credentials. OAuth providers can plug into this same session flow later.</p>
        <form className="mt-6 grid gap-3" onSubmit={props.onSubmit}>
          <div>
            <strong>Operator login</strong>
            <p className="text-sm text-slate-400">The API will set an HTTP-only session cookie after login.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input value={props.username} onChange={(event) => props.onUsernameChange(event.target.value)} placeholder="Username" autoComplete="username" />
            <Input type="password" value={props.password} onChange={(event) => props.onPasswordChange(event.target.value)} placeholder="Password" autoComplete="current-password" />
          </div>
          <Button className="justify-self-end" type="submit" disabled={!props.username.trim() || !props.password}>Sign in</Button>
        </form>
      </Card>
    </section>
  );
}

function NewThreadPanel(props: {
  canCallApi: boolean;
  loading: boolean;
  prompt: string;
  repository: string;
  onPromptChange: (value: string) => void;
  onRepositoryChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-sky-300">Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-50">Engineering agents for delegated work.</h1>
        <p className="mt-2 text-sm text-slate-400">Assign follow-ups, watch the work trail, and inspect the results.</p>
        <h2 className="mt-6 text-xl font-semibold">What needs doing?</h2>
        <form className="mt-4 grid gap-3" onSubmit={props.onSubmit}>
          <Input value={props.repository} onChange={(event) => props.onRepositoryChange(event.target.value)} placeholder="GitHub repository, e.g. owner/repo or https://github.com/owner/repo" disabled={!props.canCallApi} />
          <Textarea className="min-h-40" value={props.prompt} onChange={(event) => props.onPromptChange(event.target.value)} onKeyDown={(event) => submitOnEnter(event)} placeholder="Ask Deputies to investigate, change code, or answer a question..." disabled={!props.canCallApi} autoFocus />
          <Button className="justify-self-end" type="submit" disabled={!props.canCallApi || props.loading || !props.prompt.trim()}>Start session</Button>
        </form>
      </Card>
    </section>
  );
}

function ThreadHeader(props: {
  editingTitle: boolean;
  selectedSession: Session;
  titleDraft: string;
  onArchive: () => void;
  onCancelTitle: () => void;
  onEditTitle: () => void;
  onTitleDraftChange: (value: string) => void;
  onUpdateTitle: (event: FormEvent) => void;
}) {
  return (
    <section className="sticky top-0 z-20 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
      <div className="min-w-0 overflow-hidden">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Session</p>
        {props.editingTitle ? (
          <form className="mt-1 flex flex-wrap items-center gap-2" onSubmit={props.onUpdateTitle}>
            <Input className="max-w-xl" value={props.titleDraft} onChange={(event) => props.onTitleDraftChange(event.target.value)} autoFocus />
            <Button type="submit" disabled={!props.titleDraft.trim()}>Save</Button>
            <Button type="button" variant="secondary" onClick={props.onCancelTitle}>Cancel</Button>
          </form>
        ) : (
          <div className="mt-1 flex min-w-0 items-center gap-1">
            <h2 className="min-w-0 truncate text-base font-semibold text-slate-50">{props.selectedSession.title || 'Untitled session'}</h2>
            <Button className="h-7 w-7 shrink-0 p-0" type="button" variant="ghost" size="icon" onClick={props.onEditTitle} aria-label="Edit title" title="Edit title"><Pencil className="h-3.5 w-3.5" /></Button>
          </div>
        )}
        <p className="mt-1 hidden truncate text-xs text-slate-500 sm:block">{props.selectedSession.id}</p>
      </div>
      <div className="grid min-h-9 shrink-0 grid-cols-[auto_auto] items-center justify-items-end gap-2 justify-self-end">
        <Badge className={cn('col-start-1', statusTextClass(props.selectedSession.status))}>{props.selectedSession.status}</Badge>
        <div className="col-start-2 flex min-w-28 justify-end gap-2">
          {props.selectedSession.status !== 'archived' ? <Button type="button" variant="secondary" onClick={props.onArchive}><Archive className="h-4 w-4" /> Archive</Button> : null}
        </div>
      </div>
    </section>
  );
}

function ChatPanel(props: {
  editingMessageId: string;
  events: AgentEvent[];
  messageDraft: string;
  messages: Message[];
  onCancelEdit: () => void;
  onCancelQueuedMessage: (messageId: string) => void;
  onCancelRun: () => void;
  onEditMessage: (message: Message) => void;
  onMessageDraftChange: (value: string) => void;
  onSaveEdit: () => void;
}) {
  const assistantText = buildAssistantText(props.events);
  const diagnostics = groupDiagnosticsByRun(props.events);
  const groups = groupMessagesByRun(props.messages, props.events);

  return (
    <section className="grid gap-3">
      {groups.map((group) => {
        const response = assistantText[group.responseMessageId];
        const groupDiagnostics = diagnostics[group.runId ?? group.responseMessageId] ?? [];
        const activeRun = isActiveRunGroup(group.messages);
        const cancellingRun = isCancellingRunGroup(group.messages);
        return (
          <div className="grid gap-2" key={group.key}>
            {group.messages.length > 1 ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-widest text-slate-500">Queued batch · {group.messages.filter((message) => message.status !== 'cancelled').length} active messages</p>
                {activeRun ? <CancelRunButton cancelling={cancellingRun} onCancelRun={props.onCancelRun} /> : null}
              </div>
            ) : null}
            {group.messages.map((message) => (
              <UserMessageCard
                editingMessageId={props.editingMessageId}
                key={message.id}
                message={message}
                messageDraft={props.messageDraft}
                showRunCancel={group.messages.length === 1 && activeRun}
                runCancelling={cancellingRun}
                onCancelEdit={props.onCancelEdit}
                onCancelQueuedMessage={props.onCancelQueuedMessage}
                onCancelRun={props.onCancelRun}
                onEditMessage={props.onEditMessage}
                onMessageDraftChange={props.onMessageDraftChange}
                onSaveEdit={props.onSaveEdit}
              />
            ))}
            {response ? (
            <Card className="p-3">
              <h3 className="mb-1 text-xs font-medium text-slate-400">{activeRun ? 'Deputy progress' : 'Deputy response'}</h3>
              <MarkdownText text={formatAssistantDisplayText(response)} />
            </Card>
          ) : null}
            <Diagnostics events={groupDiagnostics} />
          </div>
        );
      })}
      {!props.messages.length ? <p className="text-sm text-slate-500">No messages yet.</p> : null}
    </section>
  );
}

function UserMessageCard(props: {
  editingMessageId: string;
  message: Message;
  messageDraft: string;
  showRunCancel: boolean;
  runCancelling: boolean;
  onCancelEdit: () => void;
  onCancelQueuedMessage: (messageId: string) => void;
  onCancelRun: () => void;
  onEditMessage: (message: Message) => void;
  onMessageDraftChange: (value: string) => void;
  onSaveEdit: () => void;
}) {
  const { message } = props;
  return (
    <Card className="border-sky-500/70 bg-sky-950/30 p-3" role="article" aria-label={`Message ${message.sequence}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-slate-400">Message {message.sequence} <Badge className={statusTextClass(message.status)}>{message.status === 'pending' ? 'queued' : message.status}</Badge></h3>
        {message.status === 'pending' && props.editingMessageId !== message.id ? (
          <div className="flex gap-1">
            <Button className="h-7 px-2" variant="ghost" size="sm" onClick={() => props.onEditMessage(message)}>Edit</Button>
            <Button className="h-7 px-2" variant="ghost" size="sm" onClick={() => props.onCancelQueuedMessage(message.id)}>Cancel</Button>
          </div>
        ) : null}
        {props.showRunCancel ? <CancelRunButton cancelling={props.runCancelling} onCancelRun={props.onCancelRun} /> : null}
      </div>
      {props.editingMessageId === message.id ? (
        <div className="grid gap-2">
          <Textarea className="min-h-24" value={props.messageDraft} onChange={(event) => props.onMessageDraftChange(event.target.value)} autoFocus />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={props.onCancelEdit}>Cancel</Button>
            <Button size="sm" onClick={props.onSaveEdit} disabled={!props.messageDraft.trim()}>Save</Button>
          </div>
        </div>
      ) : <PlainText text={message.prompt} />}
    </Card>
  );
}

function PlainText(props: { text: string }) {
  return <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-100">{props.text}</p>;
}

function MarkdownText(props: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ className, ...props }) => <a className={cn('text-sky-300 underline decoration-sky-500/60 underline-offset-2 hover:text-sky-200', className)} target="_blank" rel="noreferrer" {...props} />,
        blockquote: ({ className, ...props }) => <blockquote className={cn('border-l-2 border-slate-700 pl-3 text-slate-300', className)} {...props} />,
        code: ({ children, className, ...props }) => {
          const code = String(children).replace(/\n$/, '');
          const language = className?.match(/language-(\S+)/)?.[1];
          if (language || String(children).includes('\n')) return <HighlightedCode code={code} {...(language ? { language } : {})} />;
          return <code className={cn('rounded border border-slate-700/70 bg-slate-950 px-1.5 py-0.5 font-mono text-[0.85em] text-cyan-100 shadow-sm', className)} {...props}>{children}</code>;
        },
        h1: ({ className, ...props }) => <h1 className={cn('mt-4 text-xl font-semibold text-slate-50 first:mt-0', className)} {...props} />,
        h2: ({ className, ...props }) => <h2 className={cn('mt-4 text-lg font-semibold text-slate-50 first:mt-0', className)} {...props} />,
        h3: ({ className, ...props }) => <h3 className={cn('mt-3 text-base font-semibold text-slate-50 first:mt-0', className)} {...props} />,
        hr: ({ className, ...props }) => <hr className={cn('border-slate-800', className)} {...props} />,
        li: ({ className, ...props }) => <li className={cn('pl-1', className)} {...props} />,
        ol: ({ className, ...props }) => <ol className={cn('list-decimal space-y-1 pl-5', className)} {...props} />,
        p: ({ className, ...props }) => <p className={cn('whitespace-pre-wrap text-sm leading-6 text-slate-100', className)} {...props} />,
        pre: ({ children }) => <>{children}</>,
        table: ({ className, ...props }) => <table className={cn('w-full border-collapse text-sm', className)} {...props} />,
        tbody: ({ className, ...props }) => <tbody className={cn('divide-y divide-slate-800', className)} {...props} />,
        td: ({ className, ...props }) => <td className={cn('border border-slate-800 px-2 py-1 align-top text-slate-100', className)} {...props} />,
        th: ({ className, ...props }) => <th className={cn('border border-slate-800 px-2 py-1 text-left font-medium text-slate-200', className)} {...props} />,
        thead: ({ className, ...props }) => <thead className={cn('bg-slate-900/80', className)} {...props} />,
        ul: ({ className, ...props }) => <ul className={cn('list-disc space-y-1 pl-5', className)} {...props} />,
      }}
    >
      {props.text}
    </ReactMarkdown>
  );
}

function HighlightedCode(props: { code: string; language?: string }) {
  const [html, setHtml] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import('shiki')
      .then(({ codeToHtml }) => codeToHtml(props.code, { lang: props.language ?? 'text', theme: 'github-dark-default' }))
      .then((nextHtml) => {
        if (!cancelled) setHtml(nextHtml);
      })
      .catch(() => {
        if (!cancelled) setHtml('');
      });
    return () => {
      cancelled = true;
    };
  }, [props.code, props.language]);

  async function copyCode() {
    await navigator.clipboard.writeText(props.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <figure className="my-3 overflow-hidden rounded-lg border border-slate-700/80 bg-slate-950 shadow-[0_12px_32px_rgba(2,6,23,0.35)]">
      <figcaption className="flex items-center justify-between border-b border-slate-800 bg-slate-900/90 px-3 py-1.5 text-[0.7rem] font-medium uppercase tracking-widest text-slate-400">
        <span>{props.language ?? 'text'}</span>
        <button className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[0.65rem] text-slate-300 transition hover:border-slate-500 hover:text-slate-100" type="button" onClick={copyCode} aria-label="Copy code">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      {html ? (
        <div className="highlighted-code overflow-auto text-sm leading-6" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-auto p-3 text-sm leading-6 text-slate-100"><code>{props.code}</code></pre>
      )}
    </figure>
  );
}

function CancelRunButton(props: { cancelling: boolean; onCancelRun: () => void }) {
  return (
    <Button className="h-7 px-2" type="button" variant="secondary" size="sm" onClick={props.onCancelRun} disabled={props.cancelling}>
      <X className="h-3.5 w-3.5" /> {props.cancelling ? 'Cancelling...' : 'Cancel task'}
    </Button>
  );
}

function Diagnostics(props: { events: AgentEvent[] }) {
  if (!props.events.length) return null;

  return (
    <details className="rounded-md border border-slate-800 bg-slate-950/30 p-2">
      <summary className="cursor-pointer text-sm text-slate-400">Diagnostics · {props.events.length} events</summary>
      <div className="mt-2 grid gap-2">
        {props.events.map((event) => (
          <article className="rounded-md border border-slate-800 bg-slate-950/60 p-2" key={`${event.sessionId}-${event.sequence}`}>
            <span className="text-xs text-slate-500">#{event.sequence} · {formatDate(event.createdAt)}</span>
            <strong className="mt-1 block text-sm font-medium text-slate-200">{event.type}</strong>
            <pre className="mt-2 max-h-44 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-300">{JSON.stringify(event.payload, null, 2)}</pre>
          </article>
        ))}
      </div>
    </details>
  );
}

function ContextPanel(props: { repository: string | null; artifacts: Artifact[]; callbacks: CallbackDelivery[]; onReplayCallback: (callbackId: string) => void }) {
  return (
    <>
      <details className="border-t border-slate-800 bg-slate-950/70 lg:hidden">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-200">Context</summary>
        <ContextPanelContent {...props} />
      </details>
      <aside className="hidden min-h-0 overflow-auto border-l border-slate-800 bg-slate-950/40 p-4 lg:block">
        <h2 className="text-sm font-semibold">Context</h2>
        <ContextPanelContent {...props} />
      </aside>
    </>
  );
}

function ContextPanelContent(props: { repository: string | null; artifacts: Artifact[]; callbacks: CallbackDelivery[]; onReplayCallback: (callbackId: string) => void }) {
  return (
    <div className="p-4 pt-0 lg:p-0 lg:pt-0">
      <div className="mt-3 border-b border-slate-800 pb-3 text-sm text-slate-400">
        <strong className="block font-medium text-slate-200">Repository</strong>
        {props.repository ? (
          <>
            <a className="mt-1 block break-all text-sky-300" href={`https://github.com/${props.repository}`} target="_blank" rel="noreferrer">{props.repository}</a>
            <span className="mt-1 block text-xs">Follow-ups inherit this repo. Enter another repo in the composer to switch.</span>
          </>
        ) : (
          <span className="mt-1 block">No repository selected.</span>
        )}
      </div>
      <div className="mt-3 border-b border-slate-800 pb-3 text-sm text-slate-400">
        <strong className="block font-medium text-slate-200">Artifacts</strong>
        <span>Outputs and links created by the deputy appear here.</span>
      </div>
      <div className="mt-3 grid gap-2">
        {props.artifacts.map((artifact) => (
          <Card className="p-3" key={artifact.id}>
            <span className="text-xs text-slate-500">{artifact.type} · {formatDate(artifact.createdAt)}</span>
            <strong className="mt-1 block text-sm font-medium">{artifact.title || artifact.url || artifact.id}</strong>
            {artifact.url ? <a className="mt-1 block text-sm text-sky-300" href={artifact.url} target="_blank" rel="noreferrer">Open artifact</a> : null}
            <pre className="mt-2 max-h-44 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-300">{JSON.stringify(artifact.payload, null, 2)}</pre>
          </Card>
        ))}
        {!props.artifacts.length ? <p className="text-sm text-slate-500">No artifacts yet.</p> : null}
      </div>
      <div className="mt-6 border-b border-slate-800 pb-3 text-sm text-slate-400">
        <strong className="block font-medium text-slate-200">Callbacks</strong>
        <span>Delivery status for Slack and webhook completion replies.</span>
      </div>
      <div className="mt-3 grid gap-2">
        {props.callbacks.map((callback) => (
          <Card className="p-3" key={callback.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="text-xs text-slate-500">{callback.targetType} · {formatDate(callback.updatedAt)}</span>
                <strong className="mt-1 block truncate text-sm font-medium">{callbackEventLabel(callback.eventType)}</strong>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Badge className={statusTextClass(callback.status)}>{callback.status}</Badge>
                {callback.status === 'failed' ? (
                  <Button className="h-7 w-7 p-0" size="icon" variant="ghost" onClick={() => props.onReplayCallback(callback.id)} aria-label="Replay callback" title="Replay callback">
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
            <details className="mt-2 text-xs text-slate-400">
              <summary className="cursor-pointer text-slate-500">Details</summary>
              <dl className="mt-2 grid gap-1">
                <div>Attempts: {callback.attempts}/{callback.maxAttempts}</div>
                {callback.nextAttemptAt ? <div>Next retry: {formatDate(callback.nextAttemptAt)}</div> : null}
                {callback.lastAttemptAt ? <div>Last attempt: {formatDate(callback.lastAttemptAt)}</div> : null}
                {callback.deliveredAt ? <div>Delivered: {formatDate(callback.deliveredAt)}</div> : null}
                {callback.lastError ? <div className="text-red-300">Last error: {callback.lastError}</div> : null}
                <div className="truncate">ID: {callback.id}</div>
              </dl>
            </details>
          </Card>
        ))}
        {!props.callbacks.length ? <p className="text-sm text-slate-500">No callbacks yet.</p> : null}
      </div>
    </div>
  );
}

function upsertEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (events.some((current) => current.sequence === event.sequence)) return events;
  return [...events, event].sort((a, b) => a.sequence - b.sequence);
}

function shouldRefreshSessionDetail(eventType: string): boolean {
  return new Set(['message_created', 'message_started', 'message_completed', 'message_failed', 'message_cancelled', 'run_cancel_requested', 'run_cancelled', 'artifact_created', 'callback_sent', 'callback_retry_scheduled', 'callback_failed', 'callback_replay_requested']).has(eventType);
}

function callbackEventLabel(eventType: string): string {
  if (eventType === 'message_completed') return 'Completion reply';
  return eventType.replace(/_/g, ' ');
}

function repositoryLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const repository = value as Record<string, unknown>;
  if (repository.provider !== 'github') return null;
  const owner = typeof repository.owner === 'string' ? repository.owner : '';
  const repo = typeof repository.repo === 'string' ? repository.repo : '';
  return owner && repo ? `${owner}/${repo}` : null;
}

function buildAssistantText(events: AgentEvent[]): Record<string, string> {
  const messageIdsBySequence: Record<number, string> = {};
  const outputByMessageId: Record<string, string> = {};
  let currentSequence = 0;
  let currentMessageId = '';

  for (const event of events) {
    const maybeSequence = event.payload.sequence;
    if (typeof maybeSequence === 'number') {
      currentSequence = maybeSequence;
      if (event.messageId) messageIdsBySequence[maybeSequence] = event.messageId;
    }
    if (event.messageId) currentMessageId = event.messageId;
    const messageId = event.messageId || currentMessageId || messageIdsBySequence[currentSequence];
    if (!messageId) continue;
    const text = event.payload.text;
    if (typeof text !== 'string') continue;
    if (event.type === 'agent_response_final') {
      outputByMessageId[messageId] = text;
    } else if (event.type === 'agent_text_delta') {
      outputByMessageId[messageId] = `${outputByMessageId[messageId] ?? ''}${text}`;
    }
  }

  return outputByMessageId;
}

function formatAssistantDisplayText(text: string): string {
  return text
    .replace(/([.!?])(?=[A-Z])/g, '$1 ')
    .replace(/:(?=[A-Z][a-z])/g, ': ');
}

type MessageGroup = {
  key: string;
  messages: Message[];
  responseMessageId: string;
  runId?: string;
};

function groupMessagesByRun(messages: Message[], events: AgentEvent[]): MessageGroup[] {
  const batchBySequence = new Map<number, { runId: string; sequences: number[] }>();
  for (const event of events) {
    if (event.type !== 'message_started' || !event.runId) continue;
    const sequences = Array.isArray(event.payload.sequences) ? event.payload.sequences.filter((value): value is number => typeof value === 'number') : [];
    if (sequences.length <= 1) continue;
    for (const sequence of sequences) batchBySequence.set(sequence, { runId: event.runId, sequences });
  }

  const groups: MessageGroup[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (seen.has(message.id)) continue;
    const batch = batchBySequence.get(message.sequence);
    if (!batch) {
      groups.push({ key: message.id, messages: [message], responseMessageId: message.id });
      seen.add(message.id);
      continue;
    }

    const minSequence = Math.min(...batch.sequences);
    const maxSequence = Math.max(...batch.sequences);
    const batchSequenceSet = new Set(batch.sequences);
    const batchMessages = messages.filter((candidate) => {
      if (batchSequenceSet.has(candidate.sequence)) return true;
      return candidate.status === 'cancelled' && candidate.sequence > minSequence && candidate.sequence < maxSequence;
    });
    for (const item of batchMessages) seen.add(item.id);
    groups.push({ key: batch.runId, messages: batchMessages, responseMessageId: batchMessages[0]?.id ?? message.id, runId: batch.runId });
  }

  return groups;
}

function isActiveRunGroup(messages: Message[]): boolean {
  return messages.some((message) => message.status === 'processing' || message.status === 'cancelling');
}

function isCancellingRunGroup(messages: Message[]): boolean {
  return messages.some((message) => message.status === 'cancelling');
}

function groupDiagnosticsByRun(events: AgentEvent[]): Record<string, AgentEvent[]> {
  const grouped: Record<string, AgentEvent[]> = {};
  for (const event of events) {
    if (event.type === 'message_created' || event.type === 'agent_text_delta' || event.type === 'agent_response_final') continue;
    for (const key of diagnosticGroupKeys(event)) {
      grouped[key] = [...(grouped[key] ?? []), event];
    }
  }
  return grouped;
}

function diagnosticGroupKeys(event: AgentEvent): string[] {
  const keys = [event.runId, event.messageId].filter((key): key is string => Boolean(key));
  return Array.from(new Set(keys));
}

function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 61)}...`;
}

function sortSessionsByLastActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function filterSessions(sessions: Session[], search: string): Session[] {
  const query = search.trim().toLowerCase();
  if (!query) return sessions;
  return sessions
    .map((session) => ({ session, score: fuzzyScore(`${session.title ?? ''} ${session.status} ${session.id}`, query) }))
    .filter((match) => match.score !== null)
    .sort((a, b) => a.score! - b.score!)
    .map((match) => match.session);
}

function fuzzyScore(value: string, query: string): number | null {
  const haystack = value.toLowerCase();
  let score = 0;
  let lastIndex = -1;

  for (const char of query) {
    if (char === ' ') continue;
    const index = haystack.indexOf(char, lastIndex + 1);
    if (index === -1) return null;
    score += index - lastIndex - 1;
    lastIndex = index;
  }

  if (haystack.includes(query)) score -= query.length;
  if (haystack.startsWith(query)) score -= query.length * 2;
  return score;
}

function statusTextClass(status: string): string {
  if (['completed', 'ready', 'ok'].includes(status)) return 'text-emerald-300';
  if (['active', 'processing', 'running', 'starting', 'cancelling'].includes(status)) return 'text-cyan-300';
  if (['pending', 'queued', 'created', 'stopped'].includes(status)) return 'text-amber-300';
  if (['failed', 'cancelled', 'unhealthy', 'destroyed', 'missing'].includes(status)) return 'text-red-300';
  if (status === 'idle' || status === 'archived') return 'text-slate-400';
  return 'text-slate-300';
}

function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }).format(new Date(value));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}
