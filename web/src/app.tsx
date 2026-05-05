import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
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

const tokenStorageKey = 'flue-bg-agents-api-token';

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [token, setToken] = useState(() => localStorage.getItem(tokenStorageKey) ?? '');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [newThreadPrompt, setNewThreadPrompt] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [prompt, setPrompt] = useState('');
  const [draftToken, setDraftToken] = useState(token);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const eventCursor = useRef(0);

  const authRequired = health?.apiAuthMode === 'bearer';
  const canCallApi = Boolean(health) && (!authRequired || Boolean(token));
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const activeSessions = sessions.filter((session) => session.status !== 'archived');
  const archivedSessions = sessions.filter((session) => session.status === 'archived');

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
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Flue Control Plane</p>
          <h1>Background agent runs without losing the thread.</h1>
          <p className="lede">Create sessions, send follow-ups, watch live events, and inspect produced artifacts.</p>
        </div>
        <div className="status-card">
          <span className={health?.status === 'ok' ? 'dot ok' : 'dot'} />
          <div>
            <strong>{health ? `API ${health.status}` : 'Checking API'}</strong>
            <span>{getApiBaseUrl()}</span>
            {health ? <span>{health.runMode} mode · auth {health.apiAuthMode}</span> : null}
          </div>
          {authRequired && token ? <button className="clear-token" type="button" onClick={signOut}>Clear token</button> : null}
        </div>
      </header>

      {authRequired && !token ? <AuthPanel draftToken={draftToken} setDraftToken={setDraftToken} saveToken={saveToken} /> : null}
      {error ? <div className="error">{error}</div> : null}

      <section className="layout">
        <aside className="panel sessions-panel">
          <div className="panel-heading">
            <h2>Sessions</h2>
            <div className="session-actions">
              <button className="icon-button" type="button" onClick={startNewThread} disabled={!canCallApi} aria-label="New thread">+</button>
              <button type="button" onClick={refreshSessions} disabled={!canCallApi || loading}>Refresh</button>
            </div>
          </div>
          <div className="session-list">
            {activeSessions.map((session) => (
              <SessionButton
                key={session.id}
                session={session}
                selected={session.id === selectedSessionId}
                onArchive={archiveFromList}
                onSelect={selectSession}
              />
            ))}
            {!activeSessions.length ? <p className="empty">No active sessions.</p> : null}
          </div>
          {archivedSessions.length ? (
            <details className="archived-nav">
              <summary>Archived · {archivedSessions.length}</summary>
              <div className="session-list archived-list">
                {archivedSessions.map((session) => (
                  <SessionButton
                    key={session.id}
                    session={session}
                    selected={session.id === selectedSessionId}
                    onSelect={selectSession}
                    onUnarchive={unarchiveFromList}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </aside>

        <section className="workspace">
          {isCreatingThread ? (
            <section className="panel new-thread-state">
              <p className="eyebrow">New Thread</p>
              <h2>What should the agent do?</h2>
              <form className="new-thread" onSubmit={handleCreateThread}>
                <textarea
                  value={newThreadPrompt}
                  onChange={(event) => setNewThreadPrompt(event.target.value)}
                  onKeyDown={(event) => submitOnModifierEnter(event)}
                  placeholder="Ask the agent to investigate, change code, or answer a question..."
                  disabled={!canCallApi}
                  autoFocus
                />
                <button type="submit" disabled={!canCallApi || loading || !newThreadPrompt.trim()}>Start thread</button>
              </form>
            </section>
          ) : selectedSession ? (
            <>
              <section className="panel detail-header">
                <div>
                  <p className="eyebrow">Selected Session</p>
                  {editingTitle ? (
                    <form className="title-editor" onSubmit={handleUpdateTitle}>
                      <input value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} autoFocus />
                      <button type="submit" disabled={!titleDraft.trim()}>Save</button>
                      <button type="button" className="subtle-button" onClick={() => setEditingTitle(false)}>Cancel</button>
                    </form>
                  ) : (
                    <div className="title-row">
                      <h2>{selectedSession.title || 'Untitled session'}</h2>
                      <button type="button" className="subtle-button" onClick={() => setEditingTitle(true)}>Edit title</button>
                    </div>
                  )}
                  <p>{selectedSession.id}</p>
                </div>
                <div className="detail-actions">
                  <span className="badge">{selectedSession.status}</span>
                  {selectedSession.status !== 'archived' ? <button type="button" className="subtle-button" onClick={handleArchiveSession}>Archive</button> : null}
                </div>
              </section>

              <form className="panel composer" onSubmit={handleSendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => submitOnModifierEnter(event)}
                  placeholder="Ask the agent to investigate, change code, or follow up..."
                />
                <button type="submit" disabled={!prompt.trim()}>Send message</button>
              </form>

              <div className="columns">
                <ChatPanel events={events} messages={messages} />
                <Artifacts artifacts={artifacts} />
              </div>
            </>
          ) : (
            <section className="panel empty-state">
              <h2>Select a session or start a new thread</h2>
              <p>The UI will stream events once a thread is active.</p>
              <button type="button" onClick={startNewThread} disabled={!canCallApi}>+ New thread</button>
            </section>
          )}
        </section>
      </section>
    </main>
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
    <div className={props.selected ? 'session selected' : 'session'}>
      <button className="session-main" type="button" onClick={() => props.onSelect(props.session.id)}>
        <strong>{props.session.title || 'Untitled session'}</strong>
        <span>{props.session.status} · {formatDate(props.session.updatedAt)}</span>
      </button>
      {props.onArchive ? (
        <button className="session-archive" type="button" onClick={() => props.onArchive?.(props.session.id)} aria-label={`Archive ${props.session.title || 'session'}`}>
          Archive
        </button>
      ) : null}
      {props.onUnarchive ? (
        <button className="session-archive" type="button" onClick={() => props.onUnarchive?.(props.session.id)} aria-label={`Unarchive ${props.session.title || 'session'}`}>
          Restore
        </button>
      ) : null}
    </div>
  );
}

function AuthPanel(props: { draftToken: string; setDraftToken: (value: string) => void; saveToken: (event: FormEvent) => void }) {
  return (
    <form className="auth-panel" onSubmit={props.saveToken}>
      <div>
        <strong>API token required</strong>
        <p>Enter the backend bearer token. It stays in this browser's local storage.</p>
      </div>
      <input type="password" value={props.draftToken} onChange={(event) => props.setDraftToken(event.target.value)} placeholder="Bearer token" />
      <button type="submit">Use token</button>
    </form>
  );
}

function ChatPanel(props: { events: AgentEvent[]; messages: Message[] }) {
  const assistantText = buildAssistantText(props.events);

  return (
    <section className="panel chat-panel">
      <div className="panel-heading"><h2>Chat</h2></div>
      {props.messages.map((message) => (
        <div className="turn" key={message.id}>
          <article className="bubble user-bubble">
            <h3>Message {message.sequence} <span>{message.status}</span></h3>
            <p>{message.prompt}</p>
          </article>
          {assistantText[message.id] ? (
            <article className="bubble assistant-bubble">
              <h3>Agent response</h3>
              <p>{assistantText[message.id]}</p>
            </article>
          ) : null}
        </div>
      ))}
      {!props.messages.length ? <p className="empty">No messages yet.</p> : null}
      <details className="timeline-details">
        <summary>Diagnostics timeline · {props.events.length} events</summary>
        <div className="timeline-events">
          {props.events.map((event) => (
            <article className="event" key={`${event.sessionId}-${event.sequence}`}>
              <span>#{event.sequence} · {formatDate(event.createdAt)}</span>
              <strong>{event.type}</strong>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}

function Artifacts(props: { artifacts: Artifact[] }) {
  return (
    <section className="panel artifacts">
      <div className="panel-heading"><h2>Artifacts</h2></div>
      {props.artifacts.map((artifact) => (
        <article className="artifact" key={artifact.id}>
          <span>{artifact.type} · {formatDate(artifact.createdAt)}</span>
          <strong>{artifact.title || artifact.url || artifact.id}</strong>
          {artifact.url ? <a href={artifact.url} target="_blank" rel="noreferrer">Open artifact</a> : null}
          <pre>{JSON.stringify(artifact.payload, null, 2)}</pre>
        </article>
      ))}
      {!props.artifacts.length ? <p className="empty">No artifacts yet.</p> : null}
    </section>
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

function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 61)}...`;
}

function submitOnModifierEnter(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }).format(new Date(value));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}
