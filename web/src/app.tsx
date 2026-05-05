import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Archive, ChevronDown, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import {
  ApiError,
  AgentEvent,
  Artifact,
  Message,
  Session,
  archiveSession,
  createSession,
  enqueueMessage,
  getApiBaseUrl,
  getHealth,
  listArtifacts,
  listEvents,
  listMessages,
  listSessions,
  streamEvents,
  unarchiveSession,
  updateSession,
  type Health,
} from './api.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { Textarea } from './components/ui/textarea.js';
import { cn } from './lib/utils.js';

const tokenStorageKey = 'devops-deputies-api-token';

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [token, setToken] = useState(() => localStorage.getItem(tokenStorageKey) ?? '');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [newThreadPrompt, setNewThreadPrompt] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [prompt, setPrompt] = useState('');
  const [draftToken, setDraftToken] = useState(token);
  const [threadSearch, setThreadSearch] = useState('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const eventCursor = useRef(0);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const authRequired = health?.apiAuthMode === 'bearer';
  const canCallApi = Boolean(health) && (!authRequired || Boolean(token));
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
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
    if (!canCallApi) return;
    refreshSessions();
  }, [canCallApi, token]);

  useEffect(() => {
    if (!selectedSessionId || !canCallApi) return;
    refreshSessionDetail(selectedSessionId);
  }, [selectedSessionId, canCallApi, token]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' });
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
          refreshMessagesAndArtifacts(selectedSessionId).catch(() => undefined);
          refreshSessions().catch(() => undefined);
        }
      },
    }).catch((err: unknown) => {
      if (!abort.signal.aborted) setError(errorMessage(err));
    });

    return () => abort.abort();
  }, [selectedSessionId, canCallApi, token]);

  async function refreshSessions() {
    setLoading(true);
    setError('');
    try {
      const nextSessions = await listSessions(token);
      setSessions(nextSessions);
      if (!selectedSessionId && nextSessions[0]) setSelectedSessionId(nextSessions[0].id);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  async function refreshSessionDetail(sessionId: string) {
    setError('');
    try {
      const [nextMessages, nextEvents, nextArtifacts] = await Promise.all([
        listMessages(sessionId, token),
        listEvents(sessionId, token),
        listArtifacts(sessionId, token),
      ]);
      eventCursor.current = nextEvents.at(-1)?.sequence ?? 0;
      setMessages(nextMessages);
      setEvents(nextEvents);
      setArtifacts(nextArtifacts);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function refreshMessagesAndArtifacts(sessionId: string) {
    const [nextMessages, nextArtifacts] = await Promise.all([
      listMessages(sessionId, token),
      listArtifacts(sessionId, token),
    ]);
    setMessages(nextMessages);
    setArtifacts(nextArtifacts);
  }

  async function handleCreateThread(event: FormEvent) {
    event.preventDefault();
    const firstPrompt = newThreadPrompt.trim();
    if (!firstPrompt) return;
    setLoading(true);
    setError('');
    try {
      const session = await createSession({ title: titleFromPrompt(firstPrompt), token });
      const message = await enqueueMessage({ sessionId: session.id, prompt: firstPrompt, token });
      setSessions((current) => [session, ...current]);
      selectSession(session.id);
      setMessages([message]);
      setEvents([]);
      setArtifacts([]);
      eventCursor.current = 0;
      setNewThreadPrompt('');
      setIsCreatingThread(false);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSendMessage(event: FormEvent) {
    event.preventDefault();
    if (!selectedSessionId || !prompt.trim()) return;
    setError('');
    try {
      const message = await enqueueMessage({ sessionId: selectedSessionId, prompt: prompt.trim(), token });
      setMessages((current) => [...current, message]);
      setPrompt('');
      await refreshSessions();
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

  function saveToken(event: FormEvent) {
    event.preventDefault();
    const nextToken = draftToken.trim();
    localStorage.setItem(tokenStorageKey, nextToken);
    setToken(nextToken);
    setError('');
  }

  function signOut() {
    localStorage.removeItem(tokenStorageKey);
    setToken('');
    setDraftToken('');
    setSessions([]);
    setSelectedSessionId('');
    setIsCreatingThread(false);
  }

  function startNewThread() {
    setSidebarCollapsed(false);
    setSelectedSessionId('');
    setIsCreatingThread(true);
    setMessages([]);
    setEvents([]);
    setArtifacts([]);
    setPrompt('');
    eventCursor.current = 0;
  }

  function selectSession(sessionId: string) {
    setSelectedSessionId(sessionId);
    setIsCreatingThread(false);
    setSidebarOpen(false);
  }

  function toggleSidebar() {
    setSidebarOpen((open) => !open);
    setSidebarCollapsed((collapsed) => !collapsed);
  }

  function applyArchivedSession(session: Session) {
    setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
    if (selectedSessionId === session.id) {
      setSelectedSessionId('');
      setMessages([]);
      setEvents([]);
      setArtifacts([]);
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

  function handleApiError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) signOut();
    setError(errorMessage(err));
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      {authRequired && !token ? <AuthPanel draftToken={draftToken} setDraftToken={setDraftToken} saveToken={saveToken} /> : null}
      {error ? <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-2 text-sm text-red-200">{error}</div> : null}

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
              'fixed left-2 top-2 z-40 hidden h-[calc(100vh-1rem)] w-[min(22rem,calc(100vw-1rem))] rounded-lg border border-slate-800 bg-slate-950 p-3 shadow-2xl md:static md:z-auto md:block md:h-full md:w-auto md:rounded-none md:border-y-0 md:border-l-0 md:shadow-none',
              sidebarOpen && 'block',
            )}
          >
            <ThreadSidebar
              activeSessions={activeSessions}
              archivedSessions={archivedSessions}
              authRequired={authRequired}
              canCallApi={canCallApi}
              health={health}
              loading={loading}
              search={threadSearch}
              selectedSessionId={selectedSessionId}
              token={token}
              onArchive={archiveFromList}
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

        <section className="min-h-0 min-w-0 overflow-auto">
          {isCreatingThread ? (
            <NewThreadPanel
              canCallApi={canCallApi}
              loading={loading}
              prompt={newThreadPrompt}
              onPromptChange={setNewThreadPrompt}
              onSubmit={handleCreateThread}
            />
          ) : selectedSession ? (
            <>
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
              <div className="grid min-h-[calc(100vh-4.5rem)] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <section className="min-w-0 px-3 py-4 md:px-8 xl:px-20">
                  <ChatPanel events={events} messages={messages} />
                  <form className="mt-4" onSubmit={handleSendMessage}>
                    <Card className="overflow-hidden border-slate-700 bg-slate-900/70">
                      <Textarea
                        className="min-h-28 border-0 bg-transparent focus:ring-0"
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        onKeyDown={(event) => submitOnEnter(event)}
                        placeholder="Ask your deputy to investigate, change code, or follow up..."
                      />
                      <div className="flex items-center justify-between border-t border-slate-800 px-3 py-2 text-xs text-slate-500">
                        <span>Enter to send · Shift Enter for newline</span>
                        <Button type="submit" disabled={!prompt.trim()}>Send message</Button>
                      </div>
                    </Card>
                  </form>
                  <div ref={threadEndRef} />
                </section>
                <Artifacts artifacts={artifacts} />
              </div>
            </>
          ) : (
            <section className="grid min-h-screen place-items-center px-4">
              <Card className="max-w-lg p-6 text-center">
                <h2 className="text-lg font-semibold">Select a session or start a new one</h2>
                <p className="mt-2 text-sm text-slate-400">The work trail will stream once a session is active.</p>
                <Button className="mt-4" onClick={startNewThread} disabled={!canCallApi}><Plus className="h-4 w-4" /> New session</Button>
              </Card>
            </section>
          )}
        </section>
      </section>
    </main>
  );
}

function ThreadSidebar(props: {
  activeSessions: Session[];
  archivedSessions: Session[];
  authRequired: boolean;
  canCallApi: boolean;
  health: Health | null;
  loading: boolean;
  search: string;
  selectedSessionId: string;
  token: string;
  onArchive: (sessionId: string) => void;
  onCollapse: () => void;
  onNewThread: () => void;
  onRefresh: () => void;
  onSearch: (value: string) => void;
  onSelect: (sessionId: string) => void;
  onSignOut: () => void;
  onUnarchive: (sessionId: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="mb-3 flex items-center gap-2">
        <Button className="shrink-0" variant="ghost" size="icon" onClick={props.onCollapse} aria-label="Hide sidebar" title="Hide sidebar"><PanelLeftClose className="h-4 w-4" /></Button>
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Sessions</h2>
        <div className="flex shrink-0 gap-2">
          <Button size="icon" onClick={props.onNewThread} disabled={!props.canCallApi} aria-label="New session"><Plus className="h-4 w-4" /></Button>
          <Button variant="secondary" size="icon" onClick={props.onRefresh} disabled={!props.canCallApi || props.loading} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>
      <Input className="mb-3" value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="Search sessions..." />
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="grid min-w-0 gap-1">
          {props.activeSessions.map((session) => (
            <SessionButton key={session.id} session={session} selected={session.id === props.selectedSessionId} onArchive={props.onArchive} onSelect={props.onSelect} />
          ))}
          {!props.activeSessions.length ? <p className="px-2 py-3 text-sm text-slate-500">{props.search ? 'No matching active sessions.' : 'No active sessions.'}</p> : null}
        </div>
        {props.archivedSessions.length ? (
          <details className="mt-4 border-t border-slate-800 pt-3">
            <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-slate-400"><ChevronDown className="h-4 w-4" /> Archived · {props.archivedSessions.length}</summary>
            <div className="mt-2 grid min-w-0 gap-1 opacity-80">
              {props.archivedSessions.map((session) => <SessionButton key={session.id} session={session} selected={session.id === props.selectedSessionId} onSelect={props.onSelect} onUnarchive={props.onUnarchive} />)}
            </div>
          </details>
        ) : null}
      </div>
      <ApiStatusFooter authRequired={props.authRequired} health={props.health} token={props.token} onSignOut={props.onSignOut} />
    </div>
  );
}

function ApiStatusFooter(props: { authRequired: boolean; health: Health | null; token: string; onSignOut: () => void }) {
  return (
    <div className="mt-3 border-t border-slate-800 pt-3 text-left text-xs text-slate-500">
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', props.health?.status === 'ok' ? 'bg-emerald-400' : 'bg-orange-400')} />
        <strong className="text-slate-300">{props.health ? `API ${props.health.status}` : 'Checking API'}</strong>
      </div>
      <p className="mt-1 truncate">{getApiBaseUrl()}</p>
      {props.health ? <p>{props.health.runMode} mode · auth {props.health.apiAuthMode}</p> : null}
      {props.authRequired && props.token ? <Button className="mt-2" variant="secondary" size="sm" onClick={props.onSignOut}>Clear token</Button> : null}
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
        <span className="block w-full truncate text-xs text-slate-500">{props.session.status} · {formatDate(props.session.updatedAt)}</span>
      </button>
      {props.onArchive ? <Button className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" variant="ghost" size="sm" onClick={() => props.onArchive?.(props.session.id)} aria-label="Archive session" title="Archive session"><Archive className="h-3.5 w-3.5" /></Button> : null}
      {props.onUnarchive ? <Button className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" variant="ghost" size="sm" onClick={() => props.onUnarchive?.(props.session.id)} aria-label="Restore session" title="Restore session"><RotateCcw className="h-3.5 w-3.5" /></Button> : null}
    </div>
  );
}

function AuthPanel(props: { draftToken: string; setDraftToken: (value: string) => void; saveToken: (event: FormEvent) => void }) {
  return (
    <form className="grid gap-3 border-b border-slate-800 bg-slate-900/80 p-4 md:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)_auto] md:items-center" onSubmit={props.saveToken}>
      <div>
        <strong>API token required</strong>
        <p className="text-sm text-slate-400">Enter the backend bearer token. It stays in this browser's local storage.</p>
      </div>
      <Input type="password" value={props.draftToken} onChange={(event) => props.setDraftToken(event.target.value)} placeholder="Bearer token" />
      <Button type="submit">Use token</Button>
    </form>
  );
}

function NewThreadPanel(props: {
  canCallApi: boolean;
  loading: boolean;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <section className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-sky-300">DevOps Deputies</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-50">Your async engineering deputies.</h1>
        <p className="mt-2 text-sm text-slate-400">Delegate follow-ups, watch the work trail, and inspect the results.</p>
        <h2 className="mt-6 text-xl font-semibold">What should your deputy do?</h2>
        <form className="mt-4 grid gap-3" onSubmit={props.onSubmit}>
          <Textarea className="min-h-40" value={props.prompt} onChange={(event) => props.onPromptChange(event.target.value)} onKeyDown={(event) => submitOnEnter(event)} placeholder="Ask your deputy to investigate, change code, or answer a question..." disabled={!props.canCallApi} autoFocus />
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
      <div className="flex shrink-0 items-center gap-2 justify-self-end">
        <Badge>{props.selectedSession.status}</Badge>
        {props.selectedSession.status !== 'archived' ? <Button type="button" variant="secondary" onClick={props.onArchive}>Archive</Button> : null}
      </div>
    </section>
  );
}

function ChatPanel(props: { events: AgentEvent[]; messages: Message[] }) {
  const assistantText = buildAssistantText(props.events);
  const diagnostics = groupDiagnosticsByMessage(props.events);

  return (
    <section className="grid gap-3">
      {props.messages.map((message) => (
        <div className="grid gap-2" key={message.id}>
          <Card className="border-sky-500/70 bg-sky-950/30 p-3">
            <h3 className="mb-1 text-xs font-medium text-slate-400">Message {message.sequence} <Badge>{message.status}</Badge></h3>
            <p className="whitespace-pre-wrap text-sm leading-6 text-slate-100">{message.prompt}</p>
          </Card>
          {assistantText[message.id] ? (
            <Card className="p-3">
              <h3 className="mb-1 text-xs font-medium text-slate-400">Deputy response</h3>
              <p className="whitespace-pre-wrap text-sm leading-6 text-slate-100">{assistantText[message.id]}</p>
            </Card>
          ) : null}
          <Diagnostics events={diagnostics[message.id] ?? []} />
        </div>
      ))}
      {!props.messages.length ? <p className="text-sm text-slate-500">No messages yet.</p> : null}
    </section>
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

function Artifacts(props: { artifacts: Artifact[] }) {
  return (
    <aside className="border-t border-slate-800 bg-slate-950/40 p-4 lg:border-l lg:border-t-0">
      <h2 className="text-sm font-semibold">Context</h2>
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
    </aside>
  );
}

function upsertEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (events.some((current) => current.sequence === event.sequence)) return events;
  return [...events, event].sort((a, b) => a.sequence - b.sequence);
}

function shouldRefreshSessionDetail(eventType: string): boolean {
  return new Set(['message_created', 'message_started', 'message_completed', 'message_failed', 'artifact_created']).has(eventType);
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
    if (event.type !== 'agent_text_delta') continue;

    const text = event.payload.text;
    if (typeof text !== 'string') continue;
    const messageId = event.messageId || currentMessageId || messageIdsBySequence[currentSequence];
    if (!messageId) continue;
    outputByMessageId[messageId] = `${outputByMessageId[messageId] ?? ''}${text}`;
  }

  return outputByMessageId;
}

function groupDiagnosticsByMessage(events: AgentEvent[]): Record<string, AgentEvent[]> {
  const messageIdsBySequence: Record<number, string> = {};
  const grouped: Record<string, AgentEvent[]> = {};
  let currentMessageId = '';
  let currentSequence = 0;

  for (const event of events) {
    const maybeSequence = event.payload.sequence;
    if (typeof maybeSequence === 'number') {
      currentSequence = maybeSequence;
      if (event.messageId) messageIdsBySequence[maybeSequence] = event.messageId;
    }
    if (event.messageId) currentMessageId = event.messageId;

    const messageId = event.messageId || currentMessageId || messageIdsBySequence[currentSequence];
    if (!messageId || event.type === 'message_created' || event.type === 'agent_text_delta') continue;
    grouped[messageId] = [...(grouped[messageId] ?? []), event];
  }

  return grouped;
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
