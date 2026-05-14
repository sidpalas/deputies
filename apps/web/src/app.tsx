import { FormEvent, WheelEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, PanelLeftOpen } from 'lucide-react';
import {
  ApiError,
  AgentEvent,
  Artifact,
  CallbackDelivery,
  ExternalResource,
  Message,
  SandboxPreview,
  Session,
  apiConnectionDelayedEvent,
  apiConnectionOkEvent,
  archiveSession,
  cancelCurrentRun,
  cancelMessage,
  createSession,
  enqueueMessage,
  getCurrentUser,
  getArtifactPreview,
  getHealth,
  login,
  listArtifacts,
  listCallbacks,
  listEvents,
  listExternalResources,
  listMessages,
  listPreviews,
  listSessions,
  logout,
  pauseQueue,
  replayCallback,
  resumeQueue,
  retryMessage,
  streamGlobalEvents,
  unarchiveSession,
  updateMessage,
  updateSession,
  type Health,
  type AuthUser,
} from './api.js';
import { Button } from './components/ui/button.js';
import {
  archivedSessionsOpenStorageKey,
  applyThemePreference,
  connectionDelayedMessage,
  initialConnectionStatus,
  isPageVisible,
  isStreamConnectionOk,
  isThreadComposerFocused,
  isThreadNearBottom,
  isWakeRecoveryStatus,
  loadInitialIsCreatingThread,
  loadInitialSelectedSessionId,
  loadStoredToken,
  loadThemePreference,
  newSessionSelectedStorageKey,
  realtimeReconnectInitialDelayMs,
  realtimeReconnectMaxDelayMs,
  scrollThreadByWheel,
  selectedSessionStorageKey,
  shouldLetWheelTargetHandleScroll,
  startupConnectionDelayMs,
  startupDelayedConnectionStatus,
  themeStorageKey,
  tokenStorageKey,
  wakeRecoveryConnectionStatus,
  wakeRecoveryThresholdMs,
  type ConnectionStatus,
  type ThemePreference,
} from './app-helpers.js';
import {
  ArchivedSessionNotice,
  BearerAuthPanel,
  ConnectionStatusBanner,
  LocalSandboxWarning,
  MessageComposer,
  NewThreadPanel,
  SessionAuthPanel,
  StartupLoadingPanel,
  ThreadHeader,
  ThreadSidebar,
} from './components/app-panels.js';
import { cn } from './lib/utils.js';
import { ChatPanel, DesktopContextPanel, MobileContextPanel } from './components/thread/thread-content.js';

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState(loadStoredToken);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(loadInitialSelectedSessionId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isCreatingThread, setIsCreatingThread] = useState(loadInitialIsCreatingThread);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [previews, setPreviews] = useState<SandboxPreview[]>([]);
  const [externalResources, setExternalResources] = useState<ExternalResource[]>([]);
  const [callbacks, setCallbacks] = useState<CallbackDelivery[]>([]);
  const [newThreadPrompt, setNewThreadPrompt] = useState('');
  const [newThreadRepository, setNewThreadRepository] = useState('');
  const [editingMessageId, setEditingMessageId] = useState('');
  const [messageDraft, setMessageDraft] = useState('');
  const [draftToken, setDraftToken] = useState(token);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [archivedSessionsOpen, setArchivedSessionsOpen] = useState(
    () => localStorage.getItem(archivedSessionsOpenStorageKey) === 'true',
  );
  const [themePreference, setThemePreference] = useState<ThemePreference>(loadThemePreference);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [detailLoadedSessionId, setDetailLoadedSessionId] = useState('');
  const [healthChecked, setHealthChecked] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [pageVisible, setPageVisible] = useState(isPageVisible);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(initialConnectionStatus);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const eventCursor = useRef(0);
  const globalEventCursor = useRef(0);
  const lastBackgroundedAt = useRef<number | null>(null);
  const wasPageHiddenRef = useRef(!isPageVisible());
  const wakeRecoveryActive = useRef(false);
  const appShellRef = useRef<HTMLElement | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const threadAutoFollowRef = useRef(true);
  const autoScrolledSessionId = useRef('');
  const selectedSessionIdRef = useRef(selectedSessionId);
  const detailLoadedSessionIdRef = useRef(detailLoadedSessionId);
  const createSessionInFlightRef = useRef(false);
  const sendMessageInFlightRef = useRef(false);
  const sessionsRefreshTimerRef = useRef<number | null>(null);
  const sessionsRefreshInFlightRef = useRef(false);
  const sessionsRefreshQueuedRef = useRef(false);
  const detailRefreshInFlightRef = useRef<string | null>(null);
  const detailRefreshQueuedSessionIdRef = useRef<string | null>(null);

  const bearerAuthRequired = health?.apiAuthMode === 'bearer';
  const sessionAuthRequired = health?.apiAuthMode === 'session';
  const waitingForAuth = !healthChecked || (health && sessionAuthRequired && !authChecked);
  const canCallApi =
    Boolean(health) && (!bearerAuthRequired || Boolean(token)) && (!sessionAuthRequired || Boolean(currentUser));
  const startupLoading = waitingForAuth || (canCallApi && !sessionsLoaded);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const selectedRepository = repositoryLabel(selectedSession?.context?.repository);
  const selectedSessionArchived = selectedSession?.status === 'archived';
  const selectedSessionDetailLoading = Boolean(selectedSessionId && detailLoadedSessionId !== selectedSessionId);
  const sortedSessions = useMemo(() => sortSessionsByLastActivity(sessions), [sessions]);

  useEffect(() => {
    if (!startupLoading || connectionStatus.state !== 'ok') return;
    const timeout = window.setTimeout(() => {
      setConnectionStatus(startupDelayedConnectionStatus());
    }, startupConnectionDelayMs);
    return () => window.clearTimeout(timeout);
  }, [startupLoading, connectionStatus.state]);

  useEffect(() => {
    return () => {
      if (sessionsRefreshTimerRef.current !== null) window.clearTimeout(sessionsRefreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    applyThemePreference(themePreference);
    localStorage.setItem(themeStorageKey, themePreference);

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;

    const handleSystemThemeChange = () => {
      if (themePreference === 'system') applyThemePreference(themePreference);
    };

    media.addEventListener('change', handleSystemThemeChange);
    return () => media.removeEventListener('change', handleSystemThemeChange);
  }, [themePreference]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
    detailLoadedSessionIdRef.current = detailLoadedSessionId;
  }, [selectedSessionId, detailLoadedSessionId]);

  useEffect(() => {
    const handleConnectionOk = (event: Event) => {
      setConnectionStatus((current) => {
        if (isWakeRecoveryStatus(current)) {
          wakeRecoveryActive.current = false;
          return initialConnectionStatus();
        }
        if (current.state === 'reconnecting' && !isStreamConnectionOk(event)) return current;
        wakeRecoveryActive.current = false;
        return initialConnectionStatus();
      });
    };
    const handleConnectionDelayed = (event: Event) => {
      setConnectionStatus((current) => {
        if (wakeRecoveryActive.current && isWakeRecoveryStatus(current)) return current;
        return {
          state: 'delayed',
          message: connectionDelayedMessage(event),
        };
      });
    };
    window.addEventListener(apiConnectionOkEvent, handleConnectionOk);
    window.addEventListener(apiConnectionDelayedEvent, handleConnectionDelayed);
    return () => {
      window.removeEventListener(apiConnectionOkEvent, handleConnectionOk);
      window.removeEventListener(apiConnectionDelayedEvent, handleConnectionDelayed);
    };
  }, []);

  useEffect(() => {
    const markWakeRecovery = () => {
      wakeRecoveryActive.current = true;
      setConnectionStatus(wakeRecoveryConnectionStatus());
    };
    const handlePageMayResume = () => {
      if (isPageVisible()) {
        const backgroundedAt = lastBackgroundedAt.current;
        if (backgroundedAt && Date.now() - backgroundedAt >= wakeRecoveryThresholdMs) markWakeRecovery();
        lastBackgroundedAt.current = null;
      } else {
        lastBackgroundedAt.current = Date.now();
      }
      setPageVisible(isPageVisible());
    };
    let lastTick = Date.now();
    const interval = window.setInterval(() => {
      const now = Date.now();
      if (isPageVisible() && now - lastTick >= wakeRecoveryThresholdMs) markWakeRecovery();
      lastTick = now;
    }, 1_000);
    const handleVisibilityChange = handlePageMayResume;
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', markWakeRecovery);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', markWakeRecovery);
    };
  }, []);

  useEffect(() => {
    if (!pageVisible || !canCallApi || !isWakeRecoveryStatus(connectionStatus)) return;
    refreshSessions().catch(() => undefined);
    if (selectedSessionId) refreshSessionDetail(selectedSessionId).catch(() => undefined);
  }, [pageVisible, canCallApi, selectedSessionId, token, connectionStatus.state, connectionStatus.message]);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setHealthChecked(true));
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
    if (!pageVisible) {
      wasPageHiddenRef.current = true;
      return;
    }
    if (!wasPageHiddenRef.current || !canCallApi || !sessionsLoaded) return;

    wasPageHiddenRef.current = false;
    refreshSessions().catch(() => undefined);
    if (selectedSessionId) refreshSessionDetail(selectedSessionId).catch(() => undefined);
  }, [pageVisible, canCallApi, sessionsLoaded, selectedSessionId, token]);

  useEffect(() => {
    if (!selectedSessionId || !canCallApi) return;
    setDetailLoadedSessionId('');
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

    if (composerFocused || isThreadComposerFocused()) {
      setThreadAutoFollowEnabled(false);
      setShowJumpToLatest(false);
      return;
    }

    if (threadAutoFollowRef.current || isThreadNearBottom(container)) {
      scrollThreadToBottom();
      return;
    }

    setShowJumpToLatest(true);
  }, [selectedSessionId, messages.length, events.length, composerFocused]);

  useEffect(() => {
    if (!pageVisible || !canCallApi || !sessionsLoaded) return;

    const abort = new AbortController();
    let reconnectDelayMs = realtimeReconnectInitialDelayMs;

    const runStreamLoop = async () => {
      while (!abort.signal.aborted) {
        try {
          await streamGlobalEvents({
            after: globalEventCursor.current,
            token,
            signal: abort.signal,
            onEvent: (event) => {
              reconnectDelayMs = realtimeReconnectInitialDelayMs;
              if (typeof event.id === 'number')
                globalEventCursor.current = Math.max(globalEventCursor.current, event.id);

              const activeSessionId = selectedSessionIdRef.current;
              if (event.sessionId === activeSessionId && detailLoadedSessionIdRef.current === activeSessionId) {
                eventCursor.current = Math.max(eventCursor.current, event.sequence);
                setEvents((current) => upsertEvent(current, event));
                if (shouldRefreshSessionDetail(event.type)) {
                  refreshSessionOutputs(activeSessionId).catch(() => undefined);
                }
              }

              if (shouldRefreshSessions(event.type)) scheduleSessionsRefresh();
            },
          });
        } catch (err: unknown) {
          if (abort.signal.aborted) break;
          scheduleSessionsRefresh(0);
          setConnectionStatus({ state: 'reconnecting', message: errorMessage(err) });
        }

        if (abort.signal.aborted) break;
        await waitForRealtimeReconnect(reconnectDelayMs, abort.signal);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, realtimeReconnectMaxDelayMs);
      }
    };

    runStreamLoop().catch(() => undefined);

    return () => {
      abort.abort();
      clearScheduledSessionsRefresh();
    };
  }, [pageVisible, canCallApi, sessionsLoaded, token]);

  function clearScheduledSessionsRefresh() {
    if (sessionsRefreshTimerRef.current === null) return;
    window.clearTimeout(sessionsRefreshTimerRef.current);
    sessionsRefreshTimerRef.current = null;
  }

  function scheduleSessionsRefresh(delayMs = 300) {
    clearScheduledSessionsRefresh();
    sessionsRefreshTimerRef.current = window.setTimeout(() => {
      sessionsRefreshTimerRef.current = null;
      refreshSessions().catch(() => undefined);
    }, delayMs);
  }

  async function refreshSessions() {
    if (sessionsRefreshInFlightRef.current) {
      sessionsRefreshQueuedRef.current = true;
      return;
    }

    sessionsRefreshInFlightRef.current = true;
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
      setSessionsLoaded(true);
      handleApiError(err);
    } finally {
      setLoading(false);
      sessionsRefreshInFlightRef.current = false;
      if (sessionsRefreshQueuedRef.current) {
        sessionsRefreshQueuedRef.current = false;
        scheduleSessionsRefresh(0);
      }
    }
  }

  async function refreshSessionDetail(sessionId: string) {
    setError('');
    try {
      const [nextMessages, nextEvents, nextArtifacts, nextPreviews, nextExternalResources, nextCallbacks] =
        await Promise.all([
          listMessages(sessionId, token),
          listEvents(sessionId, token),
          listArtifacts(sessionId, token),
          listPreviews(sessionId, token),
          listExternalResources(sessionId, token),
          listCallbacks(sessionId, token),
        ]);
      if (selectedSessionIdRef.current !== sessionId) return;
      eventCursor.current = nextEvents.at(-1)?.sequence ?? 0;
      setMessages(nextMessages);
      setEvents(nextEvents);
      setArtifacts(nextArtifacts);
      setPreviews(nextPreviews);
      setExternalResources(nextExternalResources);
      setCallbacks(nextCallbacks);
      setDetailLoadedSessionId(sessionId);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function refreshSessionOutputs(sessionId: string) {
    if (detailRefreshInFlightRef.current) {
      detailRefreshQueuedSessionIdRef.current = sessionId;
      return;
    }

    detailRefreshInFlightRef.current = sessionId;
    try {
      const [nextMessages, nextArtifacts, nextPreviews, nextExternalResources, nextCallbacks] = await Promise.all([
        listMessages(sessionId, token),
        listArtifacts(sessionId, token),
        listPreviews(sessionId, token),
        listExternalResources(sessionId, token),
        listCallbacks(sessionId, token),
      ]);
      if (selectedSessionIdRef.current === sessionId) {
        setMessages(nextMessages);
        setArtifacts(nextArtifacts);
        setPreviews(nextPreviews);
        setExternalResources(nextExternalResources);
        setCallbacks(nextCallbacks);
      }
    } finally {
      detailRefreshInFlightRef.current = null;
      const queuedSessionId = detailRefreshQueuedSessionIdRef.current;
      detailRefreshQueuedSessionIdRef.current = null;
      if (queuedSessionId && queuedSessionId === selectedSessionIdRef.current) {
        refreshSessionOutputs(queuedSessionId).catch(() => undefined);
      }
    }
  }

  async function handleCreateThread(event: FormEvent) {
    event.preventDefault();
    const firstPrompt = newThreadPrompt.trim();
    if (createSessionInFlightRef.current || !firstPrompt) return;
    createSessionInFlightRef.current = true;
    const firstRepository = newThreadRepository.trim();
    blurFocusedTextControl();
    setNewThreadPrompt('');
    setNewThreadRepository('');
    setLoading(true);
    setError('');
    try {
      const session = await createSession({ title: titleFromPrompt(firstPrompt), token });
      const message = await enqueueMessage({
        sessionId: session.id,
        prompt: firstPrompt,
        token,
        ...(firstRepository ? { repository: firstRepository } : {}),
      });
      setSessions((current) => [
        { ...session, status: session.status === 'active' ? 'active' : 'queued', updatedAt: message.createdAt },
        ...current,
      ]);
      selectSession(session.id);
      setMessages([message]);
      setEvents([]);
      setArtifacts([]);
      setPreviews([]);
      setExternalResources([]);
      setCallbacks([]);
      eventCursor.current = 0;
      setIsCreatingThread(false);
    } catch (err) {
      setNewThreadPrompt(firstPrompt);
      setNewThreadRepository(firstRepository);
      handleApiError(err);
    } finally {
      setLoading(false);
      createSessionInFlightRef.current = false;
    }
  }

  async function handleSendMessage(input: { prompt: string; repository: string }): Promise<boolean> {
    const messagePrompt = input.prompt.trim();
    if (sendMessageInFlightRef.current || !selectedSessionId || selectedSessionArchived || !messagePrompt) return false;
    sendMessageInFlightRef.current = true;
    setError('');
    try {
      const repositoryInput = input.repository.trim();
      const message = await enqueueMessage({
        sessionId: selectedSessionId,
        prompt: messagePrompt,
        token,
        ...(repositoryInput ? { repository: repositoryInput } : {}),
      });
      setMessages((current) => [...current, message]);
      setSessions((current) =>
        current.map((session) =>
          session.id === selectedSessionId && session.status !== 'active'
            ? { ...session, status: 'queued', updatedAt: message.createdAt }
            : session,
        ),
      );
      setThreadAutoFollowEnabled(true);
      await refreshSessions();
      await refreshSessionDetail(selectedSessionId);
      return true;
    } catch (err) {
      handleApiError(err);
      return false;
    } finally {
      sendMessageInFlightRef.current = false;
    }
  }

  async function handleUpdateTitle(title: string): Promise<boolean> {
    const nextTitle = title.trim();
    if (!selectedSessionId || !nextTitle) return false;
    setError('');
    try {
      const session = await updateSession({ sessionId: selectedSessionId, title: nextTitle, token });
      setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
      return true;
    } catch (err) {
      handleApiError(err);
      return false;
    }
  }

  async function handleArchiveSession() {
    if (!selectedSessionId) return;
    setError('');
    const rollback = archiveOptimistically(selectedSessionId);
    try {
      const session = await archiveSession({ sessionId: selectedSessionId, token });
      applyArchivedSession(session);
    } catch (err) {
      if (rollback) restoreSessionStatusRollback(rollback);
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
      const message = await updateMessage({
        sessionId: selectedSessionId,
        messageId: editingMessageId,
        prompt: messageDraft.trim(),
        token,
      });
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

  async function retryFailedMessages(messageIds: string[]) {
    if (!selectedSessionId || selectedSessionArchived || !messageIds.length) return;
    setLoading(true);
    setError('');
    try {
      const retriedMessages: Message[] = [];
      for (const messageId of messageIds) {
        retriedMessages.push(await retryMessage({ sessionId: selectedSessionId, messageId, token }));
      }
      setMessages((current) => [...current, ...retriedMessages]);
      setThreadAutoFollowEnabled(true);
      await refreshSessions();
      await refreshSessionDetail(selectedSessionId);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  async function cancelRun() {
    if (!selectedSessionId) return;
    setError('');
    try {
      const cancelledMessages = await cancelCurrentRun({ sessionId: selectedSessionId, token });
      setMessages((current) =>
        current.map((candidate) => cancelledMessages.find((message) => message.id === candidate.id) ?? candidate),
      );
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
    clearSessionSearchParam();
    localStorage.removeItem(newSessionSelectedStorageKey);
    setSessions([]);
    setSessionsLoaded(false);
    setSelectedSessionId('');
    setIsCreatingThread(false);
    setMessages([]);
    setEvents([]);
    setArtifacts([]);
    setPreviews([]);
    setExternalResources([]);
    setCallbacks([]);
  }

  function startNewThread() {
    setSidebarOpen(false);
    setSidebarCollapsed(false);
    localStorage.removeItem(selectedSessionStorageKey);
    clearSessionSearchParam();
    localStorage.setItem(newSessionSelectedStorageKey, 'true');
    setSelectedSessionId('');
    setIsCreatingThread(true);
    setMessages([]);
    setEvents([]);
    setArtifacts([]);
    setPreviews([]);
    setExternalResources([]);
    setCallbacks([]);
    eventCursor.current = 0;
  }

  function selectSession(sessionId: string) {
    autoScrolledSessionId.current = '';
    localStorage.setItem(selectedSessionStorageKey, sessionId);
    setSessionSearchParam(sessionId);
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

  function handleAppWheel(event: WheelEvent<HTMLElement>): void {
    if (!event.deltaY || event.defaultPrevented) return;
    const appShell = appShellRef.current;
    const threadScroll = threadScrollRef.current;
    if (
      !appShell ||
      !threadScroll ||
      shouldLetWheelTargetHandleScroll(event.target, appShell, threadScroll, event.deltaY)
    )
      return;

    event.preventDefault();
    scrollThreadByWheel(threadScroll, event.deltaY);
    handleThreadScroll();
  }

  function jumpToLatestThreadActivity() {
    setThreadAutoFollowEnabled(true);
    scrollThreadToBottom('smooth');
  }

  function scrollThreadToBottom(behavior: ScrollBehavior = 'auto') {
    threadEndRef.current?.scrollIntoView({ block: 'end', behavior });
  }

  function collapseSidebar() {
    setSidebarOpen(false);
    setSidebarCollapsed(isDesktopViewport());
  }

  function expandSidebar() {
    setSidebarCollapsed(false);
    setSidebarOpen(true);
  }

  type SessionStatusRollback = {
    artifacts: Artifact[];
    previews: SandboxPreview[];
    externalResources: ExternalResource[];
    callbacks: CallbackDelivery[];
    events: AgentEvent[];
    isCreatingThread: boolean;
    messages: Message[];
    selectedSessionId: string;
    session: Session;
  };

  function archiveOptimistically(sessionId: string): SessionStatusRollback | null {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return null;
    const rollback = {
      artifacts,
      previews,
      externalResources,
      callbacks,
      events,
      isCreatingThread,
      messages,
      selectedSessionId,
      session,
    };
    applyArchivedSession({ ...session, status: 'archived' });
    return rollback;
  }

  function restoreSessionStatusRollback(rollback: SessionStatusRollback) {
    setSessions((current) =>
      current.map((candidate) => (candidate.id === rollback.session.id ? rollback.session : candidate)),
    );
    if (rollback.selectedSessionId === rollback.session.id) {
      localStorage.setItem(selectedSessionStorageKey, rollback.selectedSessionId);
      setSessionSearchParam(rollback.selectedSessionId);
      localStorage.removeItem(newSessionSelectedStorageKey);
      setSelectedSessionId(rollback.selectedSessionId);
      setIsCreatingThread(rollback.isCreatingThread);
      setMessages(rollback.messages);
      setEvents(rollback.events);
      setArtifacts(rollback.artifacts);
      setPreviews(rollback.previews);
      setExternalResources(rollback.externalResources);
      setCallbacks(rollback.callbacks);
    }
  }

  function unarchiveOptimistically(sessionId: string): SessionStatusRollback | null {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return null;
    const rollback = {
      artifacts,
      previews,
      externalResources,
      callbacks,
      events,
      isCreatingThread,
      messages,
      selectedSessionId,
      session,
    };
    setSessions((current) =>
      current.map((candidate) => (candidate.id === sessionId ? { ...candidate, status: 'idle' } : candidate)),
    );
    return rollback;
  }

  function applyArchivedSession(session: Session) {
    setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
    if (selectedSessionId === session.id) {
      localStorage.removeItem(selectedSessionStorageKey);
      clearSessionSearchParam();
      localStorage.setItem(newSessionSelectedStorageKey, 'true');
      setSelectedSessionId('');
      setIsCreatingThread(true);
      setMessages([]);
      setEvents([]);
      setArtifacts([]);
      setPreviews([]);
      setExternalResources([]);
      setCallbacks([]);
      eventCursor.current = 0;
    }
  }

  async function archiveFromList(sessionId: string) {
    setError('');
    const rollback = archiveOptimistically(sessionId);
    try {
      const session = await archiveSession({ sessionId, token });
      applyArchivedSession(session);
    } catch (err) {
      if (rollback) restoreSessionStatusRollback(rollback);
      handleApiError(err);
    }
  }

  async function unarchiveFromList(sessionId: string) {
    setError('');
    const rollback = unarchiveOptimistically(sessionId);
    try {
      const session = await unarchiveSession({ sessionId, token });
      setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
    } catch (err) {
      if (rollback) restoreSessionStatusRollback(rollback);
      handleApiError(err);
    }
  }

  async function restoreSelectedSession() {
    if (!selectedSessionId) return;
    setError('');
    const rollback = unarchiveOptimistically(selectedSessionId);
    try {
      const session = await unarchiveSession({ sessionId: selectedSessionId, token });
      setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
    } catch (err) {
      if (rollback) restoreSessionStatusRollback(rollback);
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
    <main
      ref={appShellRef}
      onWheelCapture={handleAppWheel}
      className="flex h-screen flex-col overflow-hidden bg-background text-foreground"
    >
      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {!startupLoading && connectionStatus.state !== 'ok' ? <ConnectionStatusBanner status={connectionStatus} /> : null}

      {startupLoading ? (
        <StartupLoadingPanel connectionStatus={connectionStatus} />
      ) : bearerAuthRequired && !token ? (
        <BearerAuthPanel draftToken={draftToken} setDraftToken={setDraftToken} saveToken={saveToken} />
      ) : sessionAuthRequired && !currentUser ? (
        <SessionAuthPanel
          password={loginPassword}
          provider={health?.authProvider ?? 'static'}
          username={loginUsername}
          onPasswordChange={setLoginPassword}
          onSubmit={handleLogin}
          onUsernameChange={setLoginUsername}
        />
      ) : (
        <>
          <section
            className={cn(
              'grid min-h-0 flex-1 grid-cols-1',
              sidebarCollapsed ? 'md:grid-cols-[3.75rem_minmax(0,1fr)]' : 'md:grid-cols-[18rem_minmax(0,1fr)]',
            )}
          >
            {sidebarCollapsed ? (
              <aside className="hidden min-h-0 border-r border-border bg-card/95 p-3 md:flex">
                <Button
                  className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
                  variant="ghost"
                  size="icon"
                  onClick={expandSidebar}
                  aria-label="Expand sessions"
                  title="Expand sessions"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </Button>
              </aside>
            ) : (
              <aside
                className={cn(
                  'fixed left-2 top-2 z-40 hidden h-[calc(100dvh_-_1rem_-_env(safe-area-inset-bottom))] max-h-[calc(100dvh_-_1rem_-_env(safe-area-inset-bottom))] min-h-0 w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-border bg-card p-3 shadow-2xl md:static md:z-auto md:block md:h-full md:max-h-none md:w-auto md:rounded-none md:border-y-0 md:border-l-0 md:shadow-none',
                  sidebarOpen && 'block',
                )}
              >
                <ThreadSidebar
                  archivedSessionsOpen={archivedSessionsOpen || Boolean(selectedSessionArchived)}
                  authRequired={bearerAuthRequired || sessionAuthRequired}
                  canCallApi={canCallApi}
                  health={health}
                  connectionStatus={connectionStatus}
                  loading={loading}
                  sessions={sortedSessions}
                  selectedSessionId={selectedSessionId}
                  token={token}
                  onArchive={archiveFromList}
                  onArchivedSessionsOpenChange={setArchivedSessionsOpen}
                  onCollapse={collapseSidebar}
                  onNewThread={startNewThread}
                  onRefresh={refreshSessions}
                  onSelect={selectSession}
                  onSignOut={signOut}
                  onThemeChange={setThemePreference}
                  themePreference={themePreference}
                  onUnarchive={unarchiveFromList}
                />
              </aside>
            )}

            <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
              {health?.sandboxProvider === 'local' ? <LocalSandboxWarning /> : null}
              <div className="min-h-0 flex-1 overflow-hidden">
                {isCreatingThread || !selectedSession ? (
                  <NewThreadPanel
                    canCallApi={canCallApi}
                    loading={loading}
                    prompt={newThreadPrompt}
                    repository={newThreadRepository}
                    showOpenSidebar={!sidebarOpen}
                    onOpenSidebar={expandSidebar}
                    onPromptChange={setNewThreadPrompt}
                    onRepositoryChange={setNewThreadRepository}
                    onSubmit={handleCreateThread}
                  />
                ) : (
                  <section className="flex h-full min-h-0 flex-col">
                    <ThreadHeader
                      selectedSession={selectedSession}
                      showOpenSidebar={!sidebarOpen}
                      onArchive={handleArchiveSession}
                      onOpenSidebar={expandSidebar}
                      onUpdateTitle={handleUpdateTitle}
                    />
                    <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_20rem]">
                      <section className="flex min-h-0 min-w-0 flex-col px-3 pt-4 md:px-8 xl:px-20">
                        <div className="relative min-h-0 flex-1">
                          <div
                            className="h-full overflow-auto pb-4"
                            ref={threadScrollRef}
                            onScroll={handleThreadScroll}
                            role="log"
                            aria-label="Session messages"
                          >
                            {selectedSessionDetailLoading ? (
                              <ThreadDetailLoadingPanel />
                            ) : (
                              <>
                                <MobileContextPanel
                                  repository={selectedRepository}
                                  artifacts={artifacts}
                                  previews={previews}
                                  externalResources={externalResources}
                                  callbacks={callbacks}
                                  onReplayCallback={handleReplayCallback}
                                />
                                <ChatPanel
                                  artifacts={artifacts}
                                  previews={previews}
                                  editingMessageId={editingMessageId}
                                  events={events}
                                  messageDraft={messageDraft}
                                  messages={messages}
                                  canRetryMessages={!selectedSessionArchived}
                                  onCancelEdit={() => finishEditingMessage(true)}
                                  onCancelQueuedMessage={cancelQueuedMessage}
                                  onCancelRun={cancelRun}
                                  onEditMessage={startEditingMessage}
                                  onMessageDraftChange={setMessageDraft}
                                  onRetryFailedMessages={retryFailedMessages}
                                  onSaveEdit={saveMessageEdit}
                                  onLoadArtifactPreview={(artifact) =>
                                    getArtifactPreview({
                                      sessionId: artifact.sessionId,
                                      artifactId: artifact.id,
                                      token,
                                    })
                                  }
                                />
                              </>
                            )}
                            <div ref={threadEndRef} />
                          </div>
                          {showJumpToLatest ? (
                            <Button
                              className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 shadow-xl"
                              type="button"
                              variant="secondary"
                              onClick={jumpToLatestThreadActivity}
                            >
                              <ChevronDown className="h-4 w-4" /> Jump to latest
                            </Button>
                          ) : null}
                        </div>
                        {selectedSessionArchived ? <ArchivedSessionNotice onRestore={restoreSelectedSession} /> : null}
                        {selectedSessionDetailLoading ? null : (
                          <MessageComposer
                            key={selectedSession.id}
                            archived={selectedSessionArchived}
                            hasSelectedRepository={Boolean(selectedRepository)}
                            onFocusChange={setComposerFocused}
                            onSubmit={handleSendMessage}
                          />
                        )}
                      </section>
                      {selectedSessionDetailLoading ? null : (
                        <DesktopContextPanel
                          repository={selectedRepository}
                          artifacts={artifacts}
                          previews={previews}
                          externalResources={externalResources}
                          callbacks={callbacks}
                          onReplayCallback={handleReplayCallback}
                        />
                      )}
                    </div>
                  </section>
                )}
              </div>
            </section>
          </section>
        </>
      )}
    </main>
  );
}

function ThreadDetailLoadingPanel() {
  return (
    <section className="grid min-h-full place-items-center px-4 py-10" aria-busy="true" aria-live="polite">
      <div className="w-full max-w-xl rounded-lg border border-border bg-card p-5 text-center shadow-sm">
        <h3 className="text-sm font-semibold text-foreground">Loading session</h3>
        <p className="mt-2 text-sm text-muted-foreground">Fetching the latest messages and activity.</p>
        <div className="mt-5 grid gap-2" aria-hidden="true">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </section>
  );
}

function setSessionSearchParam(sessionId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('session', sessionId);
  window.history.replaceState({}, '', url);
}

function clearSessionSearchParam() {
  const url = new URL(window.location.href);
  url.searchParams.delete('session');
  window.history.replaceState({}, '', url);
}

function isDesktopViewport(): boolean {
  if (typeof window.matchMedia === 'function') return window.matchMedia('(min-width: 768px)').matches;
  return window.innerWidth >= 768;
}

function upsertEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (events.some((current) => current.sequence === event.sequence)) return events;
  return [...events, event].sort((a, b) => a.sequence - b.sequence);
}

function shouldRefreshSessionDetail(eventType: string): boolean {
  return new Set([
    'message_created',
    'message_started',
    'message_completed',
    'message_failed',
    'message_cancelled',
    'session_updated',
    'run_cancel_requested',
    'run_cancelled',
    'artifact_created',
    'external_resource_created',
    'callback_sent',
    'callback_retry_scheduled',
    'callback_failed',
    'callback_replay_requested',
  ]).has(eventType);
}

function shouldRefreshSessions(eventType: string): boolean {
  return new Set([
    'session_created',
    'session_updated',
    'session_archived',
    'session_unarchived',
    'session_queue_paused',
    'session_queue_resumed',
    'message_created',
    'message_started',
    'message_completed',
    'message_failed',
    'message_cancelled',
    'run_failed',
    'run_cancelled',
  ]).has(eventType);
}

function waitForRealtimeReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, delayMs);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function repositoryLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const repository = value as Record<string, unknown>;
  if (repository.provider !== 'github') return null;
  const owner = typeof repository.owner === 'string' ? repository.owner : '';
  const repo = typeof repository.repo === 'string' ? repository.repo : '';
  return owner && repo ? `${owner}/${repo}` : null;
}

function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 61)}...`;
}

function sortSessionsByLastActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function blurFocusedTextControl(): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLTextAreaElement || activeElement instanceof HTMLInputElement) activeElement.blur();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}
