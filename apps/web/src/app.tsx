import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, PanelLeftOpen } from 'lucide-react';
import {
  ApiError,
  AgentEvent,
  Artifact,
  CallbackDelivery,
  ExternalResource,
  Message,
  SandboxService,
  Session,
  apiConnectionDelayedEvent,
  apiConnectionOkEvent,
  archiveSession,
  cancelCurrentRun,
  cancelMessage,
  createSession,
  enqueueMessage,
  extendSandbox,
  getCurrentUser,
  getArtifactPreview,
  getHealth,
  getModelChoices,
  getSetupStatus,
  listBranches,
  login,
  listArtifacts,
  listCallbacks,
  listEvents,
  listExternalResources,
  listMessages,
  listRepositoryOptions,
  listServices,
  listSessions,
  logout,
  openWorkspaceTool,
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
  type BranchOption,
  type ModelChoice,
  type RepositoryOption,
  type SetupStatus,
  type WorkspaceToolId,
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
  AppNoticesBanner,
  BearerAuthPanel,
  ConnectionStatusBanner,
  LocalSandboxWarning,
  MessageComposer,
  NewThreadPanel,
  SessionAuthPanel,
  SetupGuidePanel,
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
  const [activeProgress, setActiveProgress] = useState<ActiveProgressByMessageId>({});
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [services, setServices] = useState<SandboxService[]>([]);
  const [externalResources, setExternalResources] = useState<ExternalResource[]>([]);
  const [callbacks, setCallbacks] = useState<CallbackDelivery[]>([]);
  const [repositoryOptions, setRepositoryOptions] = useState<RepositoryOption[]>([]);
  const [branchOptions, setBranchOptions] = useState<BranchOption[]>([]);
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([]);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupStatusLoading, setSetupStatusLoading] = useState(false);
  const [setupStatusError, setSetupStatusError] = useState('');
  const [setupGuideOpen, setSetupGuideOpen] = useState(false);
  const [repositoryOptionsLoading, setRepositoryOptionsLoading] = useState(false);
  const [repositoryOptionsError, setRepositoryOptionsError] = useState('');
  const [branchOptionsLoading, setBranchOptionsLoading] = useState(false);
  const [branchOptionsError, setBranchOptionsError] = useState('');
  const [newThreadModel, setNewThreadModel] = useState('');
  const [newThreadBranch, setNewThreadBranch] = useState('');
  const [newThreadPrompt, setNewThreadPrompt] = useState('');
  const [newThreadRepository, setNewThreadRepository] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [followUpRepository, setFollowUpRepository] = useState('');
  const [followUpBranch, setFollowUpBranch] = useState('');
  const [followUpModel, setFollowUpModel] = useState('');
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
  const messagesRef = useRef(messages);
  const createSessionInFlightRef = useRef(false);
  const sendMessageInFlightRef = useRef(false);
  const sessionsRefreshTimerRef = useRef<number | null>(null);
  const sessionsRefreshInFlightRef = useRef(false);
  const sessionsRefreshQueuedRef = useRef(false);
  const detailRefreshInFlightRef = useRef<string | null>(null);
  const detailRefreshQueuedSessionIdRef = useRef<string | null>(null);
  const branchOptionsRepositoryRef = useRef('');
  const defaultSetupGuideOpenedRef = useRef(false);

  const bearerAuthRequired = health?.apiAuthMode === 'bearer';
  const sessionAuthRequired = health?.apiAuthMode === 'session';
  const waitingForAuth = !healthChecked || (health && sessionAuthRequired && !authChecked);
  const canCallApi =
    Boolean(health) && (!bearerAuthRequired || Boolean(token)) && (!sessionAuthRequired || Boolean(currentUser));
  const canAdmin = canCallApi && (!sessionAuthRequired || currentUser?.role === 'admin');
  const canViewSetup = canCallApi;
  const defaultSetupGuidePending = Boolean(
    canViewSetup && health && !health.hideSetupPage && !defaultSetupGuideOpenedRef.current,
  );
  const showingSetupGuide = setupGuideOpen || defaultSetupGuidePending;
  const startupLoading = waitingForAuth || (canCallApi && !sessionsLoaded);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const selectedRepository = repositoryLabel(selectedSession?.context?.repository);
  const selectedSessionModel = typeof selectedSession?.context?.model === 'string' ? selectedSession.context.model : '';
  const availableModelValues = modelChoices.filter((model) => model.available).map((model) => model.value);
  const selectedFollowUpModel = resolveSelectableModel(
    followUpModel,
    selectedSessionModel,
    defaultModel,
    availableModelValues,
  );
  const newThreadModelUnavailableReason = modelUnavailableReason(newThreadModel || defaultModel, modelChoices);
  const followUpModelUnavailableReason = modelUnavailableReason(selectedFollowUpModel || defaultModel, modelChoices);
  const selectedSessionBranch =
    typeof selectedSession?.context?.branch === 'string' ? selectedSession.context.branch : '';
  const selectedSessionArchived = selectedSession?.status === 'archived';
  const selectedSessionHasMessages = messages.some((message) => message.sessionId === selectedSessionId);
  const selectedSessionDetailLoading = Boolean(
    selectedSessionId && detailLoadedSessionId !== selectedSessionId && !selectedSessionHasMessages,
  );
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
    if (!canCallApi) return;
    let cancelled = false;

    setRepositoryOptionsLoading(true);
    setRepositoryOptionsError('');
    Promise.all([listRepositoryOptions(token), getModelChoices(token)])
      .then(([repositories, models]) => {
        if (cancelled) return;
        setRepositoryOptions(repositories);
        const choices = normalizeModelChoices(models);
        const availableModels = choices.filter((model) => model.available).map((model) => model.value);
        setModelChoices(choices);
        setDefaultModel(models.defaultModel ?? models.models[0] ?? '');
        setNewThreadModel((current) => {
          if (current && availableModels.includes(current)) return current;
          if (models.defaultModel && availableModels.includes(models.defaultModel)) return models.defaultModel;
          return availableModels[0] ?? '';
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setRepositoryOptionsError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setRepositoryOptionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [canCallApi, token]);

  useEffect(() => {
    if (!canViewSetup || !health || health.hideSetupPage || defaultSetupGuideOpenedRef.current) return;
    defaultSetupGuideOpenedRef.current = true;
    setSetupGuideOpen(true);
  }, [canViewSetup, health]);

  useEffect(() => {
    if (!canViewSetup || !showingSetupGuide) return;
    void refreshSetupStatus();
  }, [canViewSetup, showingSetupGuide, token]);

  useEffect(() => {
    const repository =
      isCreatingThread || !selectedSessionId ? newThreadRepository : followUpRepository || selectedRepository || '';
    if (branchOptionsRepositoryRef.current !== repository) {
      branchOptionsRepositoryRef.current = repository;
      setBranchOptions([]);
      setBranchOptionsError('');
      if (isCreatingThread || !selectedSessionId) setNewThreadBranch('');
      else if (followUpRepository) setFollowUpBranch('');
    }
    if (!canCallApi || !repository) {
      setBranchOptionsLoading(false);
      return;
    }
    let cancelled = false;
    setBranchOptionsLoading(true);
    setBranchOptionsError('');
    listBranches({ repository, token })
      .then((branches) => {
        if (cancelled) return;
        setBranchOptions(branches);
        const setBranch = isCreatingThread || !selectedSessionId ? setNewThreadBranch : setFollowUpBranch;
        setBranch((current) => {
          if (current && branches.some((branch) => branch.name === current)) return current;
          if (!isCreatingThread && !selectedSessionId) return '';
          if (!isCreatingThread && !followUpRepository) return '';
          const repo = repositoryOptions.find((option) => option.fullName === repository);
          return repo?.defaultBranch ?? branches[0]?.name ?? '';
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBranchOptions([]);
        setBranchOptionsError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setBranchOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    canCallApi,
    token,
    isCreatingThread,
    selectedSessionId,
    selectedSessionBranch,
    newThreadRepository,
    followUpRepository,
    selectedRepository,
    repositoryOptions,
  ]);

  useEffect(() => {
    const appShell = appShellRef.current;
    if (!appShell) return;

    appShell.addEventListener('wheel', handleAppWheel, { capture: true, passive: false });
    return () => appShell.removeEventListener('wheel', handleAppWheel, { capture: true });
  });

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
    messagesRef.current = messages;
  }, [messages]);

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
    setDetailLoadedSessionId((current) => (current === selectedSessionId ? current : ''));
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
  }, [selectedSessionId, messages.length, events.length, activeProgress, composerFocused]);

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
              const activeSessionHasMessages = messagesRef.current.some(
                (message) => message.sessionId === activeSessionId,
              );
              if (
                event.sessionId === activeSessionId &&
                (detailLoadedSessionIdRef.current === activeSessionId || activeSessionHasMessages)
              ) {
                eventCursor.current = Math.max(eventCursor.current, event.sequence);
                if (shouldUseActiveProgressEvent(event, messagesRef.current)) {
                  setActiveProgress((current) => appendActiveProgress(current, event));
                } else {
                  if (event.type === 'agent_response_final' && event.messageId) {
                    setActiveProgress((current) => omitActiveProgress(current, event.messageId!));
                  }
                  setEvents((current) => upsertEvent(current, event));
                }
                if (
                  (event.type === 'sandbox_ready' &&
                    (event.payload.created === true || event.payload.restarted === true)) ||
                  event.type === 'sandbox_stopped' ||
                  event.type === 'sandbox_destroyed'
                ) {
                  setServices([]);
                }
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
      const [nextMessages, nextEvents, nextArtifacts, nextServices, nextExternalResources, nextCallbacks] =
        await Promise.all([
          listMessages(sessionId, token),
          listEvents(sessionId, token),
          listArtifacts(sessionId, token),
          listServices(sessionId, token),
          listExternalResources(sessionId, token),
          listCallbacks(sessionId, token),
        ]);
      if (selectedSessionIdRef.current !== sessionId) return;
      eventCursor.current = nextEvents.at(-1)?.sequence ?? 0;
      setMessages(nextMessages);
      setEvents(filterActiveProgressEvents(nextEvents, nextMessages));
      setActiveProgress(buildActiveProgress(nextEvents, nextMessages));
      setArtifacts(nextArtifacts);
      setServices(nextServices);
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
      const [nextMessages, nextArtifacts, nextServices, nextExternalResources, nextCallbacks] = await Promise.all([
        listMessages(sessionId, token),
        listArtifacts(sessionId, token),
        listServices(sessionId, token),
        listExternalResources(sessionId, token),
        listCallbacks(sessionId, token),
      ]);
      if (selectedSessionIdRef.current === sessionId) {
        setMessages(nextMessages);
        setArtifacts(nextArtifacts);
        setServices(nextServices);
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
    if (createSessionInFlightRef.current || !canAdmin || !firstPrompt) return;
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
        ...(newThreadModel ? { model: newThreadModel } : {}),
        ...(newThreadBranch ? { branch: newThreadBranch } : {}),
      });
      setSessions((current) => [
        { ...session, status: session.status === 'active' ? 'active' : 'queued', updatedAt: message.createdAt },
        ...current,
      ]);
      selectSession(session.id);
      setMessages([message]);
      setEvents([]);
      setActiveProgress({});
      setArtifacts([]);
      setServices([]);
      setExternalResources([]);
      setCallbacks([]);
      eventCursor.current = 0;
      detailLoadedSessionIdRef.current = session.id;
      setDetailLoadedSessionId(session.id);
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

  async function handleSendMessage(input: { prompt: string }): Promise<boolean> {
    const messagePrompt = input.prompt.trim();
    if (sendMessageInFlightRef.current || !canAdmin || !selectedSessionId || selectedSessionArchived || !messagePrompt)
      return false;
    sendMessageInFlightRef.current = true;
    setError('');
    try {
      const message = await enqueueMessage({
        sessionId: selectedSessionId,
        prompt: messagePrompt,
        token,
        ...(followUpRepository.trim() ? { repository: followUpRepository.trim() } : {}),
        ...(selectedFollowUpModel ? { model: selectedFollowUpModel } : {}),
        ...(followUpBranch ? { branch: followUpBranch } : {}),
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

  function handleFollowUpRepositoryChange(value: string) {
    const nextRepository = value === selectedRepository ? '' : value;
    setFollowUpRepository(nextRepository);
    setFollowUpBranch('');
  }

  async function handleUpdateTitle(title: string): Promise<boolean> {
    const nextTitle = title.trim();
    if (!canAdmin || !selectedSessionId || !nextTitle) return false;
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
    if (!canAdmin || !selectedSessionId) return;
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
    if (!canAdmin || !selectedSessionId || message.status !== 'pending') return;
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
    if (!canAdmin || !selectedSessionId || !editingMessageId) return;
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
    if (!canAdmin || !selectedSessionId || !editingMessageId || !messageDraft.trim()) return;
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
    if (!canAdmin || !selectedSessionId) return;
    setError('');
    try {
      const message = await cancelMessage({ sessionId: selectedSessionId, messageId, token });
      setMessages((current) => current.map((candidate) => (candidate.id === message.id ? message : candidate)));
    } catch (err) {
      handleApiError(err);
    }
  }

  async function retryFailedMessages(messageIds: string[]) {
    if (!canAdmin || !selectedSessionId || selectedSessionArchived || !messageIds.length) return;
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
    if (!canAdmin || !selectedSessionId) return;
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
    setActiveProgress({});
    setArtifacts([]);
    setServices([]);
    setExternalResources([]);
    setCallbacks([]);
    setSetupGuideOpen(false);
    setSetupStatus(null);
    setSetupStatusError('');
  }

  function startNewThread() {
    if (!canAdmin) return;
    setSetupGuideOpen(false);
    setSidebarOpen(false);
    setSidebarCollapsed(false);
    localStorage.removeItem(selectedSessionStorageKey);
    clearSessionSearchParam();
    localStorage.setItem(newSessionSelectedStorageKey, 'true');
    setSelectedSessionId('');
    setIsCreatingThread(true);
    setFollowUpRepository('');
    setFollowUpBranch('');
    setFollowUpModel('');
    setMessages([]);
    setEvents([]);
    setActiveProgress({});
    setArtifacts([]);
    setServices([]);
    setExternalResources([]);
    setCallbacks([]);
    eventCursor.current = 0;
  }

  function selectSession(sessionId: string) {
    setSetupGuideOpen(false);
    autoScrolledSessionId.current = '';
    selectedSessionIdRef.current = sessionId;
    localStorage.setItem(selectedSessionStorageKey, sessionId);
    setSessionSearchParam(sessionId);
    localStorage.removeItem(newSessionSelectedStorageKey);
    setSelectedSessionId(sessionId);
    setIsCreatingThread(false);
    setFollowUpRepository('');
    setFollowUpBranch('');
    setFollowUpModel('');
    setSidebarOpen(false);
  }

  function openSetupGuide() {
    setSetupGuideOpen(true);
    setSidebarOpen(false);
  }

  async function refreshSetupStatus() {
    if (!canViewSetup || setupStatusLoading) return;
    setSetupStatusLoading(true);
    setSetupStatusError('');
    try {
      setSetupStatus(await getSetupStatus(token));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) signOut();
      setSetupStatusError(errorMessage(err));
    } finally {
      setSetupStatusLoading(false);
    }
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

  function handleAppWheel(event: globalThis.WheelEvent): void {
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
    services: SandboxService[];
    externalResources: ExternalResource[];
    callbacks: CallbackDelivery[];
    events: AgentEvent[];
    activeProgress: ActiveProgressByMessageId;
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
      services,
      externalResources,
      callbacks,
      events,
      activeProgress,
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
      setActiveProgress(rollback.activeProgress);
      setArtifacts(rollback.artifacts);
      setServices(rollback.services);
      setExternalResources(rollback.externalResources);
      setCallbacks(rollback.callbacks);
    }
  }

  function unarchiveOptimistically(sessionId: string): SessionStatusRollback | null {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return null;
    const rollback = {
      artifacts,
      services,
      externalResources,
      callbacks,
      events,
      activeProgress,
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
      setActiveProgress({});
      setArtifacts([]);
      setServices([]);
      setExternalResources([]);
      setCallbacks([]);
      eventCursor.current = 0;
    }
  }

  async function archiveFromList(sessionId: string) {
    if (!canAdmin) return;
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
    if (!canAdmin) return;
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
    if (!canAdmin) return;
    if (!canAdmin || !selectedSessionId) return;
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
    if (!canAdmin) return;
    if (!canAdmin || !selectedSessionId) return;
    setError('');
    try {
      const callback = await replayCallback({ sessionId: selectedSessionId, callbackId, token });
      setCallbacks((current) => current.map((candidate) => (candidate.id === callback.id ? callback : candidate)));
      await refreshSessionDetail(selectedSessionId);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleExtendSandbox(port?: number) {
    if (!canAdmin) return;
    if (!canAdmin || !selectedSessionId) return;
    setError('');
    try {
      await extendSandbox({ sessionId: selectedSessionId, token, seconds: 600, ...(port ? { port } : {}) });
      await refreshSessionOutputs(selectedSessionId);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleOpenWorkspaceTool(toolId: WorkspaceToolId) {
    if (!canAdmin) return;
    if (!canAdmin || !selectedSessionId) return;
    setError('');
    const opened = window.open('about:blank', '_blank');
    writeWorkspaceToolTabMessage(
      opened,
      'Starting workspace tool...',
      'The sandbox tool is starting. This can take a few seconds.',
    );
    try {
      const result = await openWorkspaceTool({ sessionId: selectedSessionId, toolId, token });
      setSessions((current) =>
        current.map((candidate) => (candidate.id === result.session.id ? result.session : candidate)),
      );
      setServices((current) => [result.service, ...current.filter((service) => service.port !== result.service.port)]);
      if (opened) {
        opened.opener = null;
        opened.location.href = result.service.url;
      } else {
        window.open(result.service.url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      if (isWorkspaceToolPreflightError(err)) opened?.close();
      else writeWorkspaceToolTabMessage(opened, 'Workspace tool failed to open', errorMessage(err));
      handleApiError(err);
    }
  }

  function handleApiError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) signOut();
    setError(errorMessage(err));
  }

  return (
    <main ref={appShellRef} className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {!startupLoading && connectionStatus.state !== 'ok' ? <ConnectionStatusBanner status={connectionStatus} /> : null}
      {!startupLoading && currentUser?.role === 'viewer' ? <ReadOnlyModeBanner /> : null}

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
                  canAdmin={canAdmin}
                  canViewSetup={canViewSetup}
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
                  onOpenSetup={openSetupGuide}
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
              <AppNoticesBanner notices={health?.notices ?? []} />
              {health?.sandboxProvider === 'unsafe-local' ? <LocalSandboxWarning /> : null}
              <div className="min-h-0 flex-1 overflow-hidden">
                {showingSetupGuide ? (
                  <SetupGuidePanel
                    loading={setupStatusLoading}
                    setupStatus={setupStatus}
                    setupError={setupStatusError}
                    onRefresh={refreshSetupStatus}
                    onStartNewThread={startNewThread}
                    canStartNewThread={canAdmin}
                  />
                ) : isCreatingThread || !selectedSession ? (
                  <NewThreadPanel
                    canCallApi={canAdmin}
                    readOnly={!canAdmin}
                    loading={loading}
                    prompt={newThreadPrompt}
                    repository={newThreadRepository}
                    repositoryOptions={repositoryOptions}
                    repositoryOptionsLoading={repositoryOptionsLoading}
                    repositoryOptionsError={repositoryOptionsError}
                    branch={newThreadBranch}
                    branchOptions={branchOptions}
                    branchOptionsLoading={branchOptionsLoading}
                    branchOptionsError={branchOptionsError}
                    model={newThreadModel}
                    modelChoices={modelChoices}
                    modelUnavailableReason={newThreadModelUnavailableReason}
                    showOpenSidebar={!sidebarOpen}
                    onOpenSidebar={expandSidebar}
                    onPromptChange={setNewThreadPrompt}
                    onRepositoryChange={setNewThreadRepository}
                    onBranchChange={setNewThreadBranch}
                    onModelChange={setNewThreadModel}
                    onSubmit={handleCreateThread}
                  />
                ) : (
                  <section className="flex h-full min-h-0 flex-col">
                    <ThreadHeader
                      selectedSession={selectedSession}
                      canAdmin={canAdmin}
                      showOpenSidebar={!sidebarOpen}
                      onArchive={handleArchiveSession}
                      onOpenSidebar={expandSidebar}
                      onUpdateTitle={handleUpdateTitle}
                      onOpenWorkspaceTool={handleOpenWorkspaceTool}
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
                                  branch={selectedSessionBranch || null}
                                  artifacts={artifacts}
                                  services={services}
                                  externalResources={externalResources}
                                  callbacks={callbacks}
                                  canAdmin={canAdmin}
                                  onExtendSandbox={handleExtendSandbox}
                                  onReplayCallback={handleReplayCallback}
                                />
                                <ChatPanel
                                  artifacts={artifacts}
                                  services={services}
                                  editingMessageId={editingMessageId}
                                  activeProgress={activeProgressDisplayText(activeProgress, messages)}
                                  events={events}
                                  messageDraft={messageDraft}
                                  messages={messages}
                                  canRetryMessages={canAdmin && !selectedSessionArchived}
                                  canAdmin={canAdmin}
                                  onCancelEdit={() => finishEditingMessage(true)}
                                  onCancelQueuedMessage={cancelQueuedMessage}
                                  onCancelRun={cancelRun}
                                  onEditMessage={startEditingMessage}
                                  onMessageDraftChange={setMessageDraft}
                                  onRetryFailedMessages={retryFailedMessages}
                                  onSaveEdit={saveMessageEdit}
                                  onExtendSandbox={handleExtendSandbox}
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
                            readOnly={!canAdmin}
                            hasSelectedRepository={Boolean(selectedRepository)}
                            repository={followUpRepository}
                            inheritedRepository={selectedRepository || ''}
                            repositoryOptions={repositoryOptions}
                            repositoryOptionsLoading={repositoryOptionsLoading}
                            repositoryOptionsError={repositoryOptionsError}
                            branch={followUpBranch}
                            inheritedBranch={selectedSessionBranch}
                            branchOptions={branchOptions}
                            branchOptionsLoading={branchOptionsLoading}
                            branchOptionsError={branchOptionsError}
                            model={selectedFollowUpModel}
                            inheritedModel={selectedSessionModel || defaultModel}
                            modelChoices={modelChoices}
                            modelUnavailableReason={followUpModelUnavailableReason}
                            onBranchChange={setFollowUpBranch}
                            onModelChange={setFollowUpModel}
                            onRepositoryChange={handleFollowUpRepositoryChange}
                            onFocusChange={setComposerFocused}
                            onSubmit={handleSendMessage}
                          />
                        )}
                      </section>
                      {selectedSessionDetailLoading ? null : (
                        <DesktopContextPanel
                          repository={selectedRepository}
                          branch={selectedSessionBranch || null}
                          artifacts={artifacts}
                          services={services}
                          externalResources={externalResources}
                          callbacks={callbacks}
                          canAdmin={canAdmin}
                          onExtendSandbox={handleExtendSandbox}
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

function ReadOnlyModeBanner() {
  return (
    <div
      className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning-foreground dark:text-warning"
      role="status"
    >
      <strong>Read-only mode:</strong> You can inspect sessions, messages, artifacts, and service metadata. Only admins
      can start work, modify sessions, or open sandbox services.
    </div>
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

type ActiveProgress = { text: string; omitted: number };
type ActiveProgressByMessageId = Record<string, ActiveProgress>;

const activeProgressMaxChars = 20_000;

function shouldUseActiveProgressEvent(event: AgentEvent, messages: Message[]): boolean {
  return event.type === 'agent_text_delta' && Boolean(activeProgressMessageId(event, messages));
}

function appendActiveProgress(progress: ActiveProgressByMessageId, event: AgentEvent): ActiveProgressByMessageId {
  const messageId = event.messageId;
  const text = event.payload.text;
  if (!messageId || typeof text !== 'string') return progress;

  const current = progress[messageId] ?? { text: '', omitted: 0 };
  const next = truncateActiveProgress(current.text + text, current.omitted);
  return { ...progress, [messageId]: next };
}

function omitActiveProgress(progress: ActiveProgressByMessageId, messageId: string): ActiveProgressByMessageId {
  if (!progress[messageId]) return progress;
  const { [messageId]: _removed, ...next } = progress;
  return next;
}

function buildActiveProgress(events: AgentEvent[], messages: Message[]): ActiveProgressByMessageId {
  let progress: ActiveProgressByMessageId = {};
  for (const event of events) {
    if (shouldUseActiveProgressEvent(event, messages)) {
      progress = appendActiveProgress(progress, event);
    } else if (event.type === 'agent_response_final' && event.messageId) {
      progress = omitActiveProgress(progress, event.messageId);
    }
  }
  return progress;
}

function filterActiveProgressEvents(events: AgentEvent[], messages: Message[]): AgentEvent[] {
  return events.filter((event) => !shouldUseActiveProgressEvent(event, messages));
}

function activeProgressDisplayText(progress: ActiveProgressByMessageId, messages: Message[]): Record<string, string> {
  const activeMessageIds = new Set(messages.filter(isActiveProgressMessage).map((message) => message.id));
  return Object.fromEntries(
    Object.entries(progress)
      .filter(([messageId]) => activeMessageIds.has(messageId))
      .map(([messageId, value]) => [messageId, formatActiveProgressText(value)]),
  );
}

function activeProgressMessageId(event: AgentEvent, messages: Message[]): string | null {
  if (!event.messageId || typeof event.payload.text !== 'string') return null;
  const message = messages.find((candidate) => candidate.id === event.messageId);
  return message && isActiveProgressMessage(message) ? event.messageId : null;
}

function isActiveProgressMessage(message: Message): boolean {
  return message.status === 'processing' || message.status === 'cancelling';
}

function truncateActiveProgress(text: string, omitted: number): ActiveProgress {
  if (text.length <= activeProgressMaxChars) return { text, omitted };
  const nextOmitted = omitted + text.length - activeProgressMaxChars;
  return { text: text.slice(-activeProgressMaxChars), omitted: nextOmitted };
}

function formatActiveProgressText(progress: ActiveProgress): string {
  if (progress.omitted <= 0) return progress.text;
  return `Showing latest deputy progress; ${progress.omitted.toLocaleString()} earlier characters hidden while the run is active.\n\n…${progress.text}`;
}

function shouldRefreshSessionDetail(eventType: string): boolean {
  return new Set([
    'message_created',
    'message_started',
    'message_completed',
    'message_failed',
    'message_cancelled',
    'sandbox_ready',
    'sandbox_stopped',
    'sandbox_destroyed',
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
    'sandbox_ready',
    'sandbox_stopped',
    'sandbox_destroyed',
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

function resolveSelectableModel(current: string, inherited: string, fallback: string, options: string[]): string {
  for (const model of [current, inherited, fallback]) {
    if (model && options.includes(model)) return model;
  }
  return options[0] ?? '';
}

function normalizeModelChoices(models: { models: string[]; modelChoices?: ModelChoice[] }): ModelChoice[] {
  return (
    models.modelChoices ??
    models.models.map((model) => ({ value: model, label: formatModelLabel(model), available: true }))
  );
}

function modelUnavailableReason(model: string, choices: ModelChoice[]): string {
  const choice = choices.find((candidate) => candidate.value === model);
  if (!choice || choice.available) return '';
  return choice.action
    ? `${choice.unavailableReason ?? 'This model is unavailable'} ${choice.action}`
    : (choice.unavailableReason ?? 'This model is unavailable');
}

function formatModelLabel(model: string): string {
  const separator = model.indexOf('/');
  if (separator === -1) return model.replace(/-/g, ' ');

  return `${model.slice(separator + 1).replace(/-/g, ' ')} (${formatModelProvider(model.slice(0, separator))})`;
}

function formatModelProvider(provider: string): string {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'openai-codex') return 'OpenAI Codex';
  if (provider === 'opencode') return 'OpenCode Zen';
  return provider.replace(/-/g, ' ');
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

function isWorkspaceToolPreflightError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 401);
}

function writeWorkspaceToolTabMessage(tab: Window | null, title: string, message: string): void {
  if (!tab) return;
  tab.document.title = title;
  tab.document.body.innerHTML = '';
  tab.document.body.style.margin = '0';
  tab.document.body.style.fontFamily = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
  tab.document.body.style.background = '#0f172a';
  tab.document.body.style.color = '#e2e8f0';

  const container = tab.document.createElement('main');
  container.style.minHeight = '100vh';
  container.style.display = 'grid';
  container.style.placeItems = 'center';
  container.style.padding = '24px';

  const card = tab.document.createElement('section');
  card.style.maxWidth = '520px';
  card.style.border = '1px solid rgba(148, 163, 184, 0.35)';
  card.style.borderRadius = '12px';
  card.style.background = 'rgba(15, 23, 42, 0.92)';
  card.style.padding = '24px';

  const heading = tab.document.createElement('h1');
  heading.textContent = title;
  heading.style.margin = '0 0 8px';
  heading.style.fontSize = '18px';

  const body = tab.document.createElement('p');
  body.textContent = message;
  body.style.margin = '0';
  body.style.color = '#cbd5e1';
  body.style.lineHeight = '1.5';

  card.append(heading, body);
  container.append(card);
  tab.document.body.append(container);
}
