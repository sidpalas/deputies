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
  archiveGroup,
  archiveSession,
  cancelCurrentRun,
  cancelMessage,
  createGroup,
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
  listGroupMembers,
  listGroups,
  listEvents,
  listExternalResources,
  listMessages,
  listRepositoryOptions,
  listServices,
  listSessions,
  listUsers,
  logout,
  openWorkspaceTool,
  pauseQueue,
  replayCallback,
  removeGroupMember,
  resumeQueue,
  retryMessage,
  streamGlobalEvents,
  unarchiveSession,
  updateMessage,
  updateGroup,
  updateSession,
  updateSessionAccess,
  updateUserRole,
  upsertGroupMember,
  type Health,
  type AuthUser,
  type BranchOption,
  type Group,
  type GroupMember,
  type GroupRole,
  type ModelChoice,
  type RepositoryOption,
  type SetupStatus,
  type SessionVisibility,
  type SessionWritePolicy,
  type WorkspaceToolId,
} from './api.js';
import {
  activeProgressDisplayText,
  appendActiveProgressEvents,
  buildActiveProgress,
  canWriteSession,
  errorMessage,
  filterActiveProgressEvents,
  groupCanManage,
  groupNameValidationError,
  isWorkspaceToolPreflightError,
  modelUnavailableReason,
  nextAccessGroupName,
  normalizeModelChoices,
  omitActiveProgress,
  repositoryLabel,
  resolveSelectableModel,
  shouldRefreshSessionDetail,
  shouldRefreshSessions,
  shouldUseActiveProgressEvent,
  sortSessionsByLastActivity,
  titleFromPrompt,
  upsertAuthUser,
  upsertEvent,
  waitForRealtimeReconnect,
  type ActiveProgressByMessageId,
} from './app-state.js';
import { Button } from './components/ui/button.js';
import {
  archivedSessionsOpenStorageKey,
  applyThemePreference,
  connectionDelayedMessage,
  groupsPanelOpenStorageKey,
  groupsPanelSelectedGroupStorageKey,
  groupsPanelViewStorageKey,
  initialConnectionStatus,
  isPageVisible,
  isStreamConnectionOk,
  isThreadComposerFocused,
  isThreadNearBottom,
  isWakeRecoveryStatus,
  loadInitialGroupsPanelOpen,
  loadInitialGroupsPanelSelectedGroupId,
  loadInitialGroupsPanelView,
  loadInitialIsCreatingThread,
  loadInitialSidebarPanel,
  loadInitialSetupGuideOpen,
  loadInitialSelectedSessionId,
  loadStoredToken,
  loadThemePreference,
  newSessionSelectedStorageKey,
  realtimeReconnectInitialDelayMs,
  realtimeReconnectMaxDelayMs,
  selectedSessionStorageKey,
  setupGuideOpenStorageKey,
  sidebarPanelStorageKey,
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
  SessionAccessPanel,
  SessionAuthPanel,
  SetupGuidePanel,
  GroupsPanel,
  GroupsSidebar,
  StartupLoadingPanel,
  ThreadHeader,
  ThreadSidebar,
  type AccessGroupFormState,
  type AccessGroupMemberSearchState,
  type AccessGroupUserSearchState,
} from './components/app-panels.js';
import { cn } from './lib/utils.js';
import { ChatPanel, DesktopContextPanel, MobileContextPanel } from './components/thread/thread-content.js';

type AsyncState<T> = {
  data: T;
  loading: boolean;
  error: string;
};

type StateUpdate<T> = T | ((current: T) => T);

type SidebarPanel = 'sessions' | 'groups';
type GroupsPanelView = 'group' | 'super_admins';

type NavigationState = {
  selectedSessionId: string;
  sidebarPanel: SidebarPanel;
  isCreatingThread: boolean;
  setupGuideOpen: boolean;
  groupsPanelOpen: boolean;
  groupsPanelView: GroupsPanelView;
  selectedGroupId: string;
};

const activeProgressBatchDelayMs = 100;

type SessionDetailState = {
  messages: Message[];
  events: AgentEvent[];
  activeProgress: ActiveProgressByMessageId;
  artifacts: Artifact[];
  services: SandboxService[];
  externalResources: ExternalResource[];
  callbacks: CallbackDelivery[];
};

type AccessGroupsState = {
  groupForm: AccessGroupFormState;
  memberSearch: AccessGroupMemberSearchState;
  superAdminSearch: AccessGroupUserSearchState;
  roleManagementUsers: AuthUser[];
};

function resolveStateUpdate<T>(next: StateUpdate<T>, current: T): T {
  return typeof next === 'function' ? (next as (current: T) => T)(current) : next;
}

function emptySessionDetail(): SessionDetailState {
  return {
    messages: [],
    events: [],
    activeProgress: {},
    artifacts: [],
    services: [],
    externalResources: [],
    callbacks: [],
  };
}

function emptyAccessGroupsState(): AccessGroupsState {
  return {
    groupForm: {
      name: '',
      visibility: 'organization',
      writePolicy: 'group_members',
      serverError: '',
    },
    memberSearch: {
      query: '',
      loading: false,
      userId: '',
      role: 'viewer',
      options: [],
    },
    superAdminSearch: {
      query: '',
      loading: false,
      userId: '',
      options: [],
    },
    roleManagementUsers: [],
  };
}

function loadInitialNavigationState(): NavigationState {
  return {
    selectedSessionId: loadInitialSelectedSessionId(),
    sidebarPanel: loadInitialSidebarPanel(),
    isCreatingThread: loadInitialIsCreatingThread(),
    setupGuideOpen: loadInitialSetupGuideOpen(),
    groupsPanelOpen: loadInitialGroupsPanelOpen(),
    groupsPanelView: loadInitialGroupsPanelView(),
    selectedGroupId: loadInitialGroupsPanelSelectedGroupId(),
  };
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState(loadStoredToken);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [navigation, setNavigation] = useState<NavigationState>(loadInitialNavigationState);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailState>(emptySessionDetail);
  const [accessGroupsState, setAccessGroupsState] = useState<AccessGroupsState>(emptyAccessGroupsState);
  const [repositoryOptionsState, setRepositoryOptionsState] = useState<AsyncState<RepositoryOption[]>>({
    data: [],
    loading: false,
    error: '',
  });
  const [branchOptionsState, setBranchOptionsState] = useState<AsyncState<BranchOption[]>>({
    data: [],
    loading: false,
    error: '',
  });
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([]);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupStatusLoading, setSetupStatusLoading] = useState(false);
  const [setupStatusError, setSetupStatusError] = useState('');
  const [newThreadGroupId, setNewThreadGroupId] = useState('');
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
    () => sessionStorage.getItem(archivedSessionsOpenStorageKey) === 'true',
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
  const {
    selectedSessionId,
    sidebarPanel,
    isCreatingThread,
    setupGuideOpen,
    groupsPanelOpen,
    groupsPanelView,
    selectedGroupId,
  } = navigation;
  const { messages, events, activeProgress, artifacts, services, externalResources, callbacks } = sessionDetail;
  const { groupForm, memberSearch, superAdminSearch, roleManagementUsers } = accessGroupsState;
  const eventCursor = useRef(0);
  const globalEventCursor = useRef(0);
  const lastBackgroundedAt = useRef<number | null>(null);
  const wasPageHiddenRef = useRef(!isPageVisible());
  const wakeRecoveryActive = useRef(false);
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
  const activeProgressTimerRef = useRef<number | null>(null);
  const queuedActiveProgressRef = useRef<AgentEvent[]>([]);

  const repositoryOptions = repositoryOptionsState.data;
  const repositoryOptionsLoading = repositoryOptionsState.loading;
  const repositoryOptionsError = repositoryOptionsState.error;
  const branchOptions = branchOptionsState.data;
  const branchOptionsLoading = branchOptionsState.loading;
  const branchOptionsError = branchOptionsState.error;

  const bearerAuthRequired = health?.apiAuthMode === 'bearer';
  const sessionAuthRequired = health?.apiAuthMode === 'session';
  const waitingForAuth = !healthChecked || (health && sessionAuthRequired && !authChecked);
  const canCallApi =
    Boolean(health) && (!bearerAuthRequired || Boolean(token)) && (!sessionAuthRequired || Boolean(currentUser));
  const activeGroups = groups.filter((group) => !group.archivedAt);
  const creatableGroups = sessionAuthRequired ? activeGroups.filter((group) => group.canCreateSessions) : activeGroups;
  const manageableGroups = groups.filter((group) => group.canManage);
  const currentSuperAdminUsers = useMemo(() => {
    const superAdmins = roleManagementUsers.filter((user) => user.role === 'super_admin');
    if (currentUser?.role !== 'super_admin' || superAdmins.some((user) => user.id === currentUser.id))
      return superAdmins;
    return upsertAuthUser(superAdmins, currentUser);
  }, [currentUser, roleManagementUsers]);
  const canManageAllGroups = canCallApi && (!sessionAuthRequired || currentUser?.role === 'super_admin');
  const canManageGroups = canManageAllGroups || (canCallApi && manageableGroups.length > 0);
  const canViewGroups = canManageGroups || (canCallApi && sessionAuthRequired && groups.length > 0);
  const groupFormValidationError = groupNameValidationError(groups, selectedGroupId, groupForm.name);
  const groupFormError = groupFormValidationError || groupForm.serverError;
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const canCreateThread =
    canCallApi &&
    (!sessionAuthRequired ||
      (currentUser?.role === 'super_admin' && activeGroups.length > 0) ||
      creatableGroups.length > 0);
  const canWriteSelectedSession = selectedSession ? userCanWriteSession(selectedSession) : canCreateThread;
  const canManageSelectedSessionAccess = Boolean(
    selectedSession &&
    canCallApi &&
    (!sessionAuthRequired ||
      currentUser?.role === 'super_admin' ||
      groupCanManage(groups, selectedSession.ownerGroupId)),
  );
  const canViewSetup = canCallApi;
  const defaultSetupGuidePending = Boolean(
    canViewSetup && health && !health.hideSetupPage && !defaultSetupGuideOpenedRef.current,
  );
  const showingSetupGuide = setupGuideOpen || defaultSetupGuidePending;
  const startupLoading = waitingForAuth || (canCallApi && !sessionsLoaded);
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

  function updateNavigation(next: Partial<NavigationState>) {
    setNavigation((current) => ({ ...current, ...next }));
  }

  function setSelectedSessionId(next: StateUpdate<string>) {
    setNavigation((current) => ({
      ...current,
      selectedSessionId: resolveStateUpdate(next, current.selectedSessionId),
    }));
  }

  function setSetupGuideOpen(setupGuideOpen: boolean) {
    updateNavigation({ setupGuideOpen });
  }

  function setSelectedGroupId(next: StateUpdate<string>) {
    setNavigation((current) => ({
      ...current,
      selectedGroupId: resolveStateUpdate(next, current.selectedGroupId),
    }));
  }

  function updateGroupForm(next: Partial<AccessGroupFormState>) {
    setAccessGroupsState((current) => ({ ...current, groupForm: { ...current.groupForm, ...next } }));
  }

  function updateMemberSearch(next: Partial<AccessGroupMemberSearchState>) {
    setAccessGroupsState((current) => ({ ...current, memberSearch: { ...current.memberSearch, ...next } }));
  }

  function updateSuperAdminSearch(next: Partial<AccessGroupUserSearchState>) {
    setAccessGroupsState((current) => ({
      ...current,
      superAdminSearch: { ...current.superAdminSearch, ...next },
    }));
  }

  function setGroupFormVisibility(visibility: SessionVisibility) {
    updateGroupForm({ visibility });
  }

  function setGroupFormWritePolicy(writePolicy: SessionWritePolicy) {
    updateGroupForm({ writePolicy });
  }

  function setMemberSearchQuery(query: string) {
    updateMemberSearch({ query });
  }

  function setMemberUserId(userId: string) {
    updateMemberSearch({ userId });
  }

  function setMemberRole(role: GroupRole) {
    updateMemberSearch({ role });
  }

  function setSuperAdminSearchQuery(query: string) {
    updateSuperAdminSearch({ query });
  }

  function setSuperAdminUserId(userId: string) {
    updateSuperAdminSearch({ userId });
  }

  function setUserOptions(next: StateUpdate<AuthUser[]>) {
    setAccessGroupsState((current) => ({
      ...current,
      memberSearch: {
        ...current.memberSearch,
        options: resolveStateUpdate(next, current.memberSearch.options),
      },
    }));
  }

  function setSuperAdminUserOptions(next: StateUpdate<AuthUser[]>) {
    setAccessGroupsState((current) => ({
      ...current,
      superAdminSearch: {
        ...current.superAdminSearch,
        options: resolveStateUpdate(next, current.superAdminSearch.options),
      },
    }));
  }

  function setRoleManagementUsers(next: StateUpdate<AuthUser[]>) {
    setAccessGroupsState((current) => ({
      ...current,
      roleManagementUsers: resolveStateUpdate(next, current.roleManagementUsers),
    }));
  }

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
    if (!canCallApi) {
      setRepositoryOptionsState((current) => ({ ...current, loading: false }));
      return;
    }
    let cancelled = false;

    setRepositoryOptionsState((current) => ({ ...current, loading: true, error: '' }));
    Promise.all([listRepositoryOptions(token), getModelChoices(token)])
      .then(([repositories, models]) => {
        if (cancelled) return;
        setRepositoryOptionsState({ data: repositories, loading: false, error: '' });
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
        if (!cancelled) {
          setRepositoryOptionsState((current) => ({ ...current, loading: false, error: errorMessage(err) }));
        }
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
      setBranchOptionsState((current) => ({ ...current, data: [], error: '' }));
      if (isCreatingThread || !selectedSessionId) setNewThreadBranch('');
      else if (followUpRepository) setFollowUpBranch('');
    }
    if (!canCallApi || !repository) {
      setBranchOptionsState((current) => ({ ...current, loading: false }));
      return;
    }
    let cancelled = false;
    setBranchOptionsState((current) => ({ ...current, loading: true, error: '' }));
    listBranches({ repository, token })
      .then((branches) => {
        if (cancelled) return;
        setBranchOptionsState({ data: branches, loading: false, error: '' });
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
        setBranchOptionsState({ data: [], loading: false, error: errorMessage(err) });
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

  useEffect(
    () => () => {
      if (activeProgressTimerRef.current !== null) window.clearTimeout(activeProgressTimerRef.current);
      activeProgressTimerRef.current = null;
      queuedActiveProgressRef.current = [];
    },
    [],
  );

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
    if (!canCallApi) return;
    refreshGroups().catch(() => undefined);
  }, [canCallApi, token]);

  useEffect(() => {
    const group = groupsPanelView === 'group' ? groups.find((candidate) => candidate.id === selectedGroupId) : null;
    if (!group) {
      setGroupMembers([]);
      return;
    }
    updateGroupForm({
      name: group.name,
      visibility: group.defaultVisibility,
      writePolicy: group.defaultWritePolicy,
      serverError: '',
    });
    if (!groupsPanelOpen || !group.canManage) return;
    listGroupMembers({ groupId: group.id, token }).then(setGroupMembers).catch(handleApiError);
  }, [groupsPanelOpen, groups, groupsPanelView, selectedGroupId, token]);

  useEffect(() => {
    if (!groupsPanelOpen || !canManageAllGroups) {
      setRoleManagementUsers([]);
      return;
    }

    let cancelled = false;
    listUsers({ token })
      .then((users) => {
        if (!cancelled) setRoleManagementUsers(users);
      })
      .catch(() => {
        if (!cancelled) setRoleManagementUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [groupsPanelOpen, canManageAllGroups, token]);

  useEffect(() => {
    const query = memberSearch.query.trim();
    const group = groups.find((candidate) => candidate.id === selectedGroupId);
    if (groupsPanelView !== 'group' || !groupsPanelOpen || !group?.canManage) {
      updateMemberSearch({ options: [], loading: false });
      return;
    }
    if (query.length < 2) {
      updateMemberSearch({ loading: false });
      return;
    }

    let cancelled = false;
    updateMemberSearch({ loading: true });
    listUsers({ query, token })
      .then((users) => {
        if (!cancelled) updateMemberSearch({ options: users });
      })
      .catch(() => {
        if (!cancelled) updateMemberSearch({ options: [] });
      })
      .finally(() => {
        if (!cancelled) updateMemberSearch({ loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [groupsPanelOpen, groups, groupsPanelView, memberSearch.query, selectedGroupId, token]);

  useEffect(() => {
    const query = superAdminSearch.query.trim();
    if (!groupsPanelOpen || !canManageAllGroups) {
      updateSuperAdminSearch({ options: [], loading: false });
      return;
    }
    if (query.length < 2) {
      updateSuperAdminSearch({ loading: false });
      return;
    }

    let cancelled = false;
    updateSuperAdminSearch({ loading: true });
    listUsers({ query, token })
      .then((users) => {
        if (!cancelled) updateSuperAdminSearch({ options: users });
      })
      .catch(() => {
        if (!cancelled) updateSuperAdminSearch({ options: [] });
      })
      .finally(() => {
        if (!cancelled) updateSuperAdminSearch({ loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [groupsPanelOpen, canManageAllGroups, superAdminSearch.query, token]);

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
                  queueActiveProgressEvent(event);
                } else {
                  if (event.type === 'agent_response_final' && event.messageId) {
                    discardQueuedActiveProgress(event.messageId);
                  }
                  setSessionDetail((current) => ({
                    ...current,
                    activeProgress:
                      event.type === 'agent_response_final' && event.messageId
                        ? omitActiveProgress(current.activeProgress, event.messageId)
                        : current.activeProgress,
                    events: upsertEvent(current.events, event),
                  }));
                }
                if (
                  (event.type === 'sandbox_ready' &&
                    (event.payload.created === true || event.payload.restarted === true)) ||
                  event.type === 'sandbox_stopped' ||
                  event.type === 'sandbox_destroyed'
                ) {
                  setSessionDetail((current) => ({ ...current, services: [] }));
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

  function queueActiveProgressEvent(event: AgentEvent) {
    queuedActiveProgressRef.current.push(event);
    if (activeProgressTimerRef.current !== null) return;

    activeProgressTimerRef.current = window.setTimeout(flushActiveProgressEvents, activeProgressBatchDelayMs);
  }

  function flushActiveProgressEvents() {
    if (activeProgressTimerRef.current !== null) window.clearTimeout(activeProgressTimerRef.current);
    activeProgressTimerRef.current = null;

    const activeSessionId = selectedSessionIdRef.current;
    const progressEvents = queuedActiveProgressRef.current.filter(
      (event) => event.sessionId === activeSessionId && shouldUseActiveProgressEvent(event, messagesRef.current),
    );
    queuedActiveProgressRef.current = [];
    if (progressEvents.length === 0) return;

    setSessionDetail((current) => ({
      ...current,
      activeProgress: appendActiveProgressEvents(current.activeProgress, progressEvents),
    }));
  }

  function discardQueuedActiveProgress(messageId: string) {
    queuedActiveProgressRef.current = queuedActiveProgressRef.current.filter((event) => event.messageId !== messageId);
  }

  function clearQueuedActiveProgress() {
    if (activeProgressTimerRef.current !== null) window.clearTimeout(activeProgressTimerRef.current);
    activeProgressTimerRef.current = null;
    queuedActiveProgressRef.current = [];
  }

  function userCanWriteSession(session: Session): boolean {
    return canCallApi && (!sessionAuthRequired || canWriteSession(currentUser, session, groups));
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
        if (sessionStorage.getItem(newSessionSelectedStorageKey) === 'true') return '';
        const next = nextSessions[0]?.id ?? '';
        if (next) sessionStorage.setItem(selectedSessionStorageKey, next);
        else sessionStorage.removeItem(selectedSessionStorageKey);
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

  async function refreshGroups() {
    try {
      const nextGroups = await listGroups(token);
      setGroups(nextGroups);
      setNewThreadGroupId((current) => {
        if (
          current &&
          nextGroups.some((group) => group.id === current && group.canCreateSessions && !group.archivedAt)
        ) {
          return current;
        }
        return nextGroups.find((group) => group.canCreateSessions && !group.archivedAt)?.id ?? '';
      });
      setSelectedGroupId((current) => {
        const nextGroupId =
          current && nextGroups.some((group) => group.id === current)
            ? current
            : (nextGroups.find((group) => group.canManage)?.id ?? nextGroups[0]?.id ?? '');
        if (nextGroupId) sessionStorage.setItem(groupsPanelSelectedGroupStorageKey, nextGroupId);
        else sessionStorage.removeItem(groupsPanelSelectedGroupStorageKey);
        return nextGroupId;
      });
    } catch (err) {
      handleApiError(err);
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
      setSessionDetail({
        messages: nextMessages,
        events: filterActiveProgressEvents(nextEvents, nextMessages),
        activeProgress: buildActiveProgress(nextEvents, nextMessages),
        artifacts: nextArtifacts,
        services: nextServices,
        externalResources: nextExternalResources,
        callbacks: nextCallbacks,
      });
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
        setSessionDetail((current) => ({
          ...current,
          messages: nextMessages,
          artifacts: nextArtifacts,
          services: nextServices,
          externalResources: nextExternalResources,
          callbacks: nextCallbacks,
        }));
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
    if (createSessionInFlightRef.current || !canCreateThread || !firstPrompt) return;
    createSessionInFlightRef.current = true;
    const firstRepository = newThreadRepository.trim();
    blurFocusedTextControl();
    setNewThreadPrompt('');
    setNewThreadRepository('');
    setLoading(true);
    setError('');
    try {
      const session = await createSession({
        title: titleFromPrompt(firstPrompt),
        token,
        ownerGroupId: newThreadGroupId,
      });
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
      setSessionDetail({ ...emptySessionDetail(), messages: [message] });
      eventCursor.current = 0;
      detailLoadedSessionIdRef.current = session.id;
      setDetailLoadedSessionId(session.id);
      updateNavigation({ isCreatingThread: false });
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
    if (
      sendMessageInFlightRef.current ||
      !canWriteSelectedSession ||
      !selectedSessionId ||
      selectedSessionArchived ||
      !messagePrompt
    )
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
      setSessionDetail((current) => ({ ...current, messages: [...current.messages, message] }));
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
    if (!canWriteSelectedSession || !selectedSessionId || !nextTitle) return false;
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
    if (!canWriteSelectedSession || !selectedSessionId) return;
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
    if (!canWriteSelectedSession || !selectedSessionId || message.status !== 'pending') return;
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
    if (!canWriteSelectedSession || !selectedSessionId || !editingMessageId) return;
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
    if (!canWriteSelectedSession || !selectedSessionId || !editingMessageId || !messageDraft.trim()) return;
    setError('');
    try {
      const message = await updateMessage({
        sessionId: selectedSessionId,
        messageId: editingMessageId,
        prompt: messageDraft.trim(),
        token,
      });
      setSessionDetail((current) => ({
        ...current,
        messages: current.messages.map((candidate) => (candidate.id === message.id ? message : candidate)),
      }));
      await finishEditingMessage(true);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function cancelQueuedMessage(messageId: string) {
    if (!canWriteSelectedSession || !selectedSessionId) return;
    setError('');
    try {
      const message = await cancelMessage({ sessionId: selectedSessionId, messageId, token });
      setSessionDetail((current) => ({
        ...current,
        messages: current.messages.map((candidate) => (candidate.id === message.id ? message : candidate)),
      }));
    } catch (err) {
      handleApiError(err);
    }
  }

  async function retryFailedMessages(messageIds: string[]) {
    if (!canWriteSelectedSession || !selectedSessionId || selectedSessionArchived || !messageIds.length) return;
    setLoading(true);
    setError('');
    try {
      const retriedMessages: Message[] = [];
      for (const messageId of messageIds) {
        retriedMessages.push(await retryMessage({ sessionId: selectedSessionId, messageId, token }));
      }
      setSessionDetail((current) => ({ ...current, messages: [...current.messages, ...retriedMessages] }));
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
    if (!canWriteSelectedSession || !selectedSessionId) return;
    setError('');
    try {
      const cancelledMessages = await cancelCurrentRun({ sessionId: selectedSessionId, token });
      setSessionDetail((current) => ({
        ...current,
        messages: current.messages.map(
          (candidate) => cancelledMessages.find((message) => message.id === candidate.id) ?? candidate,
        ),
      }));
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

  function clearSessionDetail() {
    clearQueuedActiveProgress();
    setSessionDetail(emptySessionDetail());
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
    sessionStorage.removeItem(selectedSessionStorageKey);
    clearSessionSearchParam();
    sessionStorage.removeItem(newSessionSelectedStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.removeItem(sidebarPanelStorageKey);
    sessionStorage.removeItem(groupsPanelViewStorageKey);
    sessionStorage.removeItem(groupsPanelSelectedGroupStorageKey);
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    setSessions([]);
    setGroups([]);
    setGroupMembers([]);
    setAccessGroupsState(emptyAccessGroupsState());
    setSessionsLoaded(false);
    updateNavigation({
      selectedSessionId: '',
      isCreatingThread: false,
      setupGuideOpen: false,
      groupsPanelOpen: false,
    });
    clearSessionDetail();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    setSetupStatus(null);
    setSetupStatusError('');
  }

  function startNewThread() {
    if (!canCreateThread) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    setSidebarOpen(false);
    setSidebarCollapsed(false);
    sessionStorage.removeItem(selectedSessionStorageKey);
    clearSessionSearchParam();
    sessionStorage.setItem(newSessionSelectedStorageKey, 'true');
    updateNavigation({
      selectedSessionId: '',
      isCreatingThread: true,
      setupGuideOpen: false,
      groupsPanelOpen: false,
    });
    setFollowUpRepository('');
    setFollowUpBranch('');
    setFollowUpModel('');
    clearSessionDetail();
    eventCursor.current = 0;
  }

  function selectSession(sessionId: string) {
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    autoScrolledSessionId.current = '';
    selectedSessionIdRef.current = sessionId;
    sessionStorage.setItem(selectedSessionStorageKey, sessionId);
    setSessionSearchParam(sessionId);
    sessionStorage.removeItem(newSessionSelectedStorageKey);
    updateNavigation({
      selectedSessionId: sessionId,
      isCreatingThread: false,
      setupGuideOpen: false,
      groupsPanelOpen: false,
    });
    setFollowUpRepository('');
    setFollowUpBranch('');
    setFollowUpModel('');
    setSidebarOpen(false);
  }

  function openSetupGuide() {
    sessionStorage.setItem(setupGuideOpenStorageKey, 'true');
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    updateNavigation({ setupGuideOpen: true, groupsPanelOpen: false });
    setSidebarOpen(false);
  }

  function openGroupsPanel() {
    if (!canViewGroups) return;
    const desktop = isDesktopViewport();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.setItem(groupsPanelOpenStorageKey, 'true');
    sessionStorage.setItem(sidebarPanelStorageKey, 'groups');
    updateNavigation({ setupGuideOpen: false, groupsPanelOpen: true, sidebarPanel: 'groups' });
    setSidebarCollapsed(false);
    setSidebarOpen(!desktop);
  }

  function showSessionsSidebar() {
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'sessions');
    updateNavigation({ setupGuideOpen: false, groupsPanelOpen: false, sidebarPanel: 'sessions' });
    setSidebarCollapsed(false);
    setSidebarOpen(true);
  }

  function backToSessionsSidebar() {
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'sessions');
    updateNavigation({ setupGuideOpen: false, groupsPanelOpen: false, sidebarPanel: 'sessions' });
    setSidebarCollapsed(false);
    setSidebarOpen(true);
  }

  async function handleCreateGroup() {
    if (!canManageAllGroups) return;
    const name = nextAccessGroupName(groups);
    setError('');
    try {
      const group = await createGroup({
        name,
        defaultVisibility: 'organization',
        defaultWritePolicy: 'group_members',
        token,
      });
      await refreshGroups();
      sessionStorage.setItem(groupsPanelViewStorageKey, 'group');
      sessionStorage.setItem(groupsPanelSelectedGroupStorageKey, group.id);
      updateNavigation({ groupsPanelView: 'group', selectedGroupId: group.id });
    } catch (err) {
      handleApiError(err);
    }
  }

  function handleGroupFormNameChange(value: string) {
    updateGroupForm({ name: value, serverError: '' });
  }

  async function handleSaveGroup() {
    const group = groups.find((candidate) => candidate.id === selectedGroupId);
    if (!group?.canManage || !groupForm.name.trim()) return;
    const validationError = groupNameValidationError(groups, group.id, groupForm.name);
    if (validationError) {
      updateGroupForm({ serverError: validationError });
      return;
    }
    setError('');
    updateGroupForm({ serverError: '' });
    try {
      const updated = await updateGroup({
        groupId: group.id,
        name: groupForm.name.trim(),
        defaultVisibility: groupForm.visibility,
        defaultWritePolicy: groupForm.writePolicy,
        token,
      });
      setGroups((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        updateGroupForm({ serverError: 'An access group with this name already exists.' });
        return;
      }
      handleApiError(err);
    }
  }

  async function handleArchiveGroup(groupId: string, archived: boolean) {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group?.canManage) return;
    setError('');
    try {
      const updated = await archiveGroup({ groupId, archived, token });
      setGroups((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
      if (newThreadGroupId === updated.id && updated.archivedAt) {
        setNewThreadGroupId(
          groups.find(
            (candidate) => candidate.id !== updated.id && candidate.canCreateSessions && !candidate.archivedAt,
          )?.id ?? '',
        );
      }
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleAddGroupMember() {
    const group = groups.find((candidate) => candidate.id === selectedGroupId);
    const userId = memberSearch.userId.trim();
    if (!group?.canManage || !userId) return;
    setError('');
    try {
      const member = await upsertGroupMember({ groupId: group.id, userId, role: memberSearch.role, token });
      setGroupMembers((current) => [member, ...current.filter((candidate) => candidate.userId !== member.userId)]);
      updateMemberSearch({ userId: '', query: '', options: [] });
      await refreshGroups();
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleUpdateGroupMemberRole(userId: string, role: GroupRole) {
    const group = groups.find((candidate) => candidate.id === selectedGroupId);
    if (!group?.canManage) return;
    setError('');
    try {
      const member = await upsertGroupMember({ groupId: group.id, userId, role, token });
      setGroupMembers((current) => current.map((candidate) => (candidate.userId === userId ? member : candidate)));
      await refreshGroups();
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleRemoveGroupMember(userId: string) {
    const group = groups.find((candidate) => candidate.id === selectedGroupId);
    if (!group?.canManage) return;
    setError('');
    try {
      await removeGroupMember({ groupId: group.id, userId, token });
      setGroupMembers((current) => current.filter((candidate) => candidate.userId !== userId));
      await refreshGroups();
    } catch (err) {
      handleApiError(err);
    }
  }

  function selectMemberUser(userId: string) {
    updateMemberSearch({ userId, query: '' });
  }

  async function handlePromoteSuperAdmin() {
    const userId = superAdminSearch.userId.trim();
    if (!canManageAllGroups || !userId) return;
    setError('');
    try {
      const promoted = await updateUserRole({ userId, role: 'super_admin', token });
      if (currentUser?.id === promoted.id) setCurrentUser({ ...currentUser, role: promoted.role });
      setRoleManagementUsers((current) => upsertAuthUser(current, promoted));
      setSuperAdminUserOptions((current) =>
        current.map((candidate) => (candidate.id === promoted.id ? { ...candidate, role: promoted.role } : candidate)),
      );
      setUserOptions((current) =>
        current.map((candidate) => (candidate.id === promoted.id ? { ...candidate, role: promoted.role } : candidate)),
      );
      updateSuperAdminSearch({ userId: '', query: '', options: [] });
    } catch (err) {
      handleApiError(err);
    }
  }

  function selectSuperAdminUser(userId: string) {
    updateSuperAdminSearch({ userId, query: '' });
  }

  async function handleRemoveSuperAdmin(userId: string) {
    if (!canManageAllGroups || userId === currentUser?.id) return;
    setError('');
    try {
      const updated = await updateUserRole({ userId, role: 'user', token });
      setRoleManagementUsers((current) => upsertAuthUser(current, updated));
      setSuperAdminUserOptions((current) =>
        current.map((candidate) => (candidate.id === updated.id ? { ...candidate, role: updated.role } : candidate)),
      );
      setUserOptions((current) =>
        current.map((candidate) => (candidate.id === updated.id ? { ...candidate, role: updated.role } : candidate)),
      );
    } catch (err) {
      handleApiError(err);
    }
  }

  function selectGroupPanel(groupId: string) {
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.setItem(groupsPanelOpenStorageKey, 'true');
    sessionStorage.setItem(sidebarPanelStorageKey, 'groups');
    sessionStorage.setItem(groupsPanelViewStorageKey, 'group');
    sessionStorage.setItem(groupsPanelSelectedGroupStorageKey, groupId);
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: true,
      sidebarPanel: 'groups',
      groupsPanelView: 'group',
      selectedGroupId: groupId,
    });
    if (!isDesktopViewport()) setSidebarOpen(false);
  }

  function selectSuperAdminsPanel() {
    if (!canManageAllGroups) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.setItem(groupsPanelOpenStorageKey, 'true');
    sessionStorage.setItem(sidebarPanelStorageKey, 'groups');
    sessionStorage.setItem(groupsPanelViewStorageKey, 'super_admins');
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: true,
      sidebarPanel: 'groups',
      groupsPanelView: 'super_admins',
    });
    if (!isDesktopViewport()) setSidebarOpen(false);
  }

  async function handleUpdateSessionAccess(input: { ownerGroupId: string }): Promise<boolean> {
    if (!selectedSession || !canManageSelectedSessionAccess) return false;
    setError('');
    try {
      const session = await updateSessionAccess({ sessionId: selectedSession.id, token, ...input });
      setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
      return true;
    } catch (err) {
      handleApiError(err);
      return false;
    }
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
    isCreatingThread: boolean;
    selectedSessionId: string;
    sessionDetail: SessionDetailState;
    session: Session;
  };

  function archiveOptimistically(sessionId: string): SessionStatusRollback | null {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return null;
    const rollback = {
      isCreatingThread,
      selectedSessionId,
      sessionDetail,
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
      sessionStorage.setItem(selectedSessionStorageKey, rollback.selectedSessionId);
      setSessionSearchParam(rollback.selectedSessionId);
      sessionStorage.removeItem(newSessionSelectedStorageKey);
      updateNavigation({
        selectedSessionId: rollback.selectedSessionId,
        isCreatingThread: rollback.isCreatingThread,
      });
      setSessionDetail(rollback.sessionDetail);
    }
  }

  function unarchiveOptimistically(sessionId: string): SessionStatusRollback | null {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return null;
    const rollback = {
      isCreatingThread,
      selectedSessionId,
      sessionDetail,
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
      sessionStorage.removeItem(selectedSessionStorageKey);
      clearSessionSearchParam();
      sessionStorage.setItem(newSessionSelectedStorageKey, 'true');
      updateNavigation({ selectedSessionId: '', isCreatingThread: true });
      clearSessionDetail();
      eventCursor.current = 0;
    }
  }

  async function archiveFromList(sessionId: string) {
    const sessionToArchive = sessions.find((candidate) => candidate.id === sessionId);
    if (!sessionToArchive || !userCanWriteSession(sessionToArchive)) return;
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
    const sessionToUnarchive = sessions.find((candidate) => candidate.id === sessionId);
    if (!sessionToUnarchive || !userCanWriteSession(sessionToUnarchive)) return;
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
    if (!canWriteSelectedSession || !selectedSessionId) return;
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
    if (!canWriteSelectedSession || !selectedSessionId) return;
    setError('');
    try {
      const callback = await replayCallback({ sessionId: selectedSessionId, callbackId, token });
      setSessionDetail((current) => ({
        ...current,
        callbacks: current.callbacks.map((candidate) => (candidate.id === callback.id ? callback : candidate)),
      }));
      await refreshSessionDetail(selectedSessionId);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleExtendSandbox(port?: number) {
    if (!canWriteSelectedSession || !selectedSessionId) return;
    setError('');
    try {
      await extendSandbox({ sessionId: selectedSessionId, token, seconds: 600, ...(port ? { port } : {}) });
      await refreshSessionOutputs(selectedSessionId);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleOpenWorkspaceTool(toolId: WorkspaceToolId) {
    if (!canWriteSelectedSession || !selectedSessionId) return;
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
      setSessionDetail((current) => ({
        ...current,
        services: [result.service, ...current.services.filter((service) => service.port !== result.service.port)],
      }));
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
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
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
                  aria-label={sidebarPanel === 'groups' ? 'Expand access' : 'Expand sessions'}
                  title={sidebarPanel === 'groups' ? 'Expand access' : 'Expand sessions'}
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
                {sidebarPanel === 'groups' && canViewGroups ? (
                  <GroupsSidebar
                    authRequired={bearerAuthRequired || sessionAuthRequired}
                    canCreateGroups={canManageAllGroups}
                    canViewGroups={canViewGroups}
                    canViewSetup={canViewSetup}
                    connectionStatus={connectionStatus}
                    currentUser={currentUser}
                    groups={groups}
                    health={health}
                    selectedGroupId={selectedGroupId}
                    selectedView={groupsPanelView}
                    superAdminUsers={currentSuperAdminUsers}
                    themePreference={themePreference}
                    token={token}
                    navPage={showingSetupGuide ? 'setup' : groupsPanelOpen ? 'groups' : 'sessions'}
                    onBackToSessions={backToSessionsSidebar}
                    onCollapse={collapseSidebar}
                    onCreateGroup={handleCreateGroup}
                    onOpenGroups={openGroupsPanel}
                    onOpenSessions={showSessionsSidebar}
                    onOpenSetup={openSetupGuide}
                    onSelectGroup={selectGroupPanel}
                    onSelectSuperAdmins={selectSuperAdminsPanel}
                    onSignOut={signOut}
                    onThemeChange={setThemePreference}
                  />
                ) : (
                  <ThreadSidebar
                    archivedSessionsOpen={archivedSessionsOpen || Boolean(selectedSessionArchived)}
                    authRequired={bearerAuthRequired || sessionAuthRequired}
                    canCallApi={canCallApi}
                    canViewGroups={canViewGroups}
                    canStartNewThread={canCreateThread}
                    canViewSetup={canViewSetup}
                    canWriteSession={userCanWriteSession}
                    health={health}
                    connectionStatus={connectionStatus}
                    loading={loading}
                    navPage={showingSetupGuide ? 'setup' : 'sessions'}
                    sessions={sortedSessions}
                    selectedSessionId={selectedSessionId}
                    token={token}
                    onArchive={archiveFromList}
                    onArchivedSessionsOpenChange={setArchivedSessionsOpen}
                    onCollapse={collapseSidebar}
                    onNewThread={startNewThread}
                    onOpenGroups={openGroupsPanel}
                    onOpenSessions={showSessionsSidebar}
                    onOpenSetup={openSetupGuide}
                    onRefresh={refreshSessions}
                    onSelect={selectSession}
                    onSignOut={signOut}
                    onThemeChange={setThemePreference}
                    themePreference={themePreference}
                    onUnarchive={unarchiveFromList}
                  />
                )}
              </aside>
            )}

            <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
              <AppNoticesBanner notices={health?.notices ?? []} />
              {health?.sandboxProvider === 'unsafe-local' ? <LocalSandboxWarning /> : null}
              <div className="min-h-0 flex-1 overflow-hidden">
                {groupsPanelOpen ? (
                  <GroupsPanel
                    canCreateGroups={canManageAllGroups}
                    currentUser={currentUser}
                    groupMembers={groupMembers}
                    groups={groups}
                    groupForm={groupForm}
                    groupFormError={groupFormError}
                    memberSearch={memberSearch}
                    selectedView={groupsPanelView}
                    selectedGroupId={selectedGroupId}
                    superAdminSearch={superAdminSearch}
                    superAdminUsers={currentSuperAdminUsers}
                    showOpenSidebar={!sidebarOpen}
                    onAddMember={handleAddGroupMember}
                    onArchiveGroup={handleArchiveGroup}
                    onCreateGroup={handleCreateGroup}
                    onGroupFormNameChange={handleGroupFormNameChange}
                    onGroupFormVisibilityChange={setGroupFormVisibility}
                    onGroupFormWritePolicyChange={setGroupFormWritePolicy}
                    onMemberRoleChange={setMemberRole}
                    onMemberSearchQueryChange={setMemberSearchQuery}
                    onMemberUserIdChange={setMemberUserId}
                    onOpenSidebar={expandSidebar}
                    onSelectMemberUser={selectMemberUser}
                    onPromoteSuperAdmin={handlePromoteSuperAdmin}
                    onRemoveMember={handleRemoveGroupMember}
                    onRemoveSuperAdmin={handleRemoveSuperAdmin}
                    onSaveGroup={handleSaveGroup}
                    onSelectGroup={selectGroupPanel}
                    onSelectSuperAdminUser={selectSuperAdminUser}
                    onSelectSuperAdmins={selectSuperAdminsPanel}
                    onSuperAdminSearchQueryChange={setSuperAdminSearchQuery}
                    onSuperAdminUserIdChange={setSuperAdminUserId}
                    onUpdateMemberRole={handleUpdateGroupMemberRole}
                  />
                ) : showingSetupGuide ? (
                  <SetupGuidePanel
                    loading={setupStatusLoading}
                    setupStatus={setupStatus}
                    setupError={setupStatusError}
                    showOpenSidebar={!sidebarOpen}
                    openSidebarLabel={sidebarPanel === 'groups' && canViewGroups ? 'Open access' : 'Open sessions'}
                    onOpenSidebar={expandSidebar}
                    onRefresh={refreshSetupStatus}
                    onStartNewThread={startNewThread}
                    canStartNewThread={canCreateThread}
                  />
                ) : isCreatingThread || !selectedSession ? (
                  <NewThreadPanel
                    canCallApi={canCreateThread}
                    readOnly={!canCreateThread}
                    groupId={newThreadGroupId}
                    groups={creatableGroups}
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
                    openSidebarLabel={sidebarPanel === 'groups' && canViewGroups ? 'Open access' : 'Open sessions'}
                    onOpenSidebar={expandSidebar}
                    onGroupChange={setNewThreadGroupId}
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
                      canWriteSession={canWriteSelectedSession}
                      showOpenSidebar={!sidebarOpen}
                      openSidebarLabel={sidebarPanel === 'groups' && canViewGroups ? 'Open access' : 'Open sessions'}
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
                                  accessPanel={
                                    <SessionAccessPanel
                                      canManageAccess={canManageSelectedSessionAccess}
                                      groups={groups}
                                      session={selectedSession}
                                      onUpdateAccess={handleUpdateSessionAccess}
                                    />
                                  }
                                  repository={selectedRepository}
                                  branch={selectedSessionBranch || null}
                                  artifacts={artifacts}
                                  services={services}
                                  externalResources={externalResources}
                                  callbacks={callbacks}
                                  canWriteSession={canWriteSelectedSession}
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
                                  canRetryMessages={canWriteSelectedSession && !selectedSessionArchived}
                                  canWriteSession={canWriteSelectedSession}
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
                            readOnly={!canWriteSelectedSession}
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
                          accessPanel={
                            <SessionAccessPanel
                              canManageAccess={canManageSelectedSessionAccess}
                              groups={groups}
                              session={selectedSession}
                              onUpdateAccess={handleUpdateSessionAccess}
                            />
                          }
                          repository={selectedRepository}
                          branch={selectedSessionBranch || null}
                          artifacts={artifacts}
                          services={services}
                          externalResources={externalResources}
                          callbacks={callbacks}
                          canWriteSession={canWriteSelectedSession}
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

function blurFocusedTextControl(): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLTextAreaElement || activeElement instanceof HTMLInputElement) activeElement.blur();
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
