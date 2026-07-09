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
  createSession,
  enqueueMessage,
  extendSandbox,
  getCurrentUser,
  getArtifactPreview,
  getHealth,
  getSession,
  getModelChoices,
  getSetupStatus,
  listBranches,
  login,
  listArtifacts,
  listCallbacks,
  listEnvironments,
  listGroups,
  listSessionTags,
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
  searchSessions,
  setSessionStarred,
  retryMessage,
  streamGlobalEvents,
  unarchiveSession,
  updateMessage,
  updateSession,
  updateSessionAccess,
  updateSessionTags,
  type Automation,
  type Environment,
  type EnvironmentBranchOverrideInput,
  type Health,
  type AuthUser,
  type BranchOption,
  type Group,
  type ModelChoice,
  type RepositoryOption,
  type SessionSearchResult,
  type SessionTagSummary,
  type SetupStatus,
  type WorkspaceToolId,
} from './api.js';
import { useAccessGroupsAdmin } from './access-groups-admin.js';
import { useAutomationsAdmin } from './automations-admin.js';
import { isInlineDisplayableArtifact } from './artifact-display.js';
import {
  startSessionMilestoneInteraction,
  type BrowserMilestoneTrigger,
  type SessionMilestoneInteraction,
} from './telemetry.js';
import { componentCause, componentName, loadSessionDetailPhases } from './session-detail-loader.js';
import {
  activeProgressDisplayText,
  applyFrozenSessionOrder,
  appendActiveProgressEvents,
  buildActiveProgress,
  canWriteSession,
  errorMessage,
  filterActiveProgressEvents,
  groupCanManage,
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
  upsertEvent,
  waitForRealtimeReconnect,
  type ActiveProgressByMessageId,
} from './app-state.js';
import { Button } from './components/ui/button.js';
import {
  archivedSessionsOpenStorageKey,
  archivedAutomationsOpenStorageKey,
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
  loadInitialSelectedAutomationId,
  loadInitialSelectedEnvironmentId,
  loadInitialSetupGuideOpen,
  loadInitialSelectedSessionId,
  loadStoredToken,
  loadThemePreference,
  newSessionSelectedStorageKey,
  realtimeReconnectInitialDelayMs,
  realtimeReconnectMaxDelayMs,
  selectedAutomationStorageKey,
  selectedEnvironmentStorageKey,
  selectedSessionStorageKey,
  sessionFiltersStorageKey,
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
  AutomationsPanel,
  AutomationsSidebar,
  BearerAuthPanel,
  ConnectionStatusBanner,
  EnvironmentsPanel,
  EnvironmentsSidebar,
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
} from './components/app-panels.js';
import {
  environmentRepositoryKey,
  type EnvironmentBranchOverrides,
  type EnvironmentBranchOverrideRepository,
  type EnvironmentBranchOverrideTarget,
} from './components/app-panels/environment-branch-overrides.js';
import { parseCodebasePickerValue } from './components/app-panels/option-picker.js';
import { cn } from './lib/utils.js';
import {
  ChatPanel,
  DesktopContextPanel,
  MobileContextPanel,
  type ContextEnvironment,
  type SessionLineage,
} from './components/thread/thread-content.js';

type AsyncState<T> = {
  data: T;
  loading: boolean;
  error: string;
};

type StateUpdate<T> = T | ((current: T) => T);

type SidebarPanel = 'sessions' | 'groups' | 'automations' | 'environments';
type GroupsPanelView = 'group' | 'super_admins' | 'new_group';

type NavigationState = {
  selectedSessionId: string;
  sidebarPanel: SidebarPanel;
  isCreatingThread: boolean;
  setupGuideOpen: boolean;
  groupsPanelOpen: boolean;
  groupsPanelView: GroupsPanelView;
  selectedGroupId: string;
  selectedAutomationId: string;
  selectedEnvironmentId: string;
};

const activeProgressBatchDelayMs = 100;
const createdSessionBackfillAttempts = 20;
const createdSessionBackfillDelayMs = 250;
const sessionListPageSize = 50;
const sessionSearchPageSize = 20;

type SessionFilters = {
  tags: string[];
  createdByMe: boolean;
  participatedByMe: boolean;
  starredByMe: boolean;
};

const emptySessionFilters: SessionFilters = {
  tags: [],
  createdByMe: false,
  participatedByMe: false,
  starredByMe: false,
};

type SessionDetailState = {
  messages: Message[];
  events: AgentEvent[];
  activeProgress: ActiveProgressByMessageId;
  artifacts: Artifact[];
  services: SandboxService[];
  externalResources: ExternalResource[];
  callbacks: CallbackDelivery[];
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

function countInlineArtifacts(artifacts: Artifact[], messages: Message[], events: AgentEvent[]): number {
  const messageIds = new Set(messages.map((message) => message.id));
  const runIds = new Set(events.flatMap((event) => (event.runId ? [event.runId] : [])));
  return artifacts.filter((artifact) => {
    if (!isInlineDisplayableArtifact(artifact)) return false;
    if (artifact.runId && runIds.has(artifact.runId)) return true;
    return Boolean(artifact.messageId && messageIds.has(artifact.messageId));
  }).length;
}

function isTerminalMessageStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isTerminalMessageEvent(event: AgentEvent, messageId: string): boolean {
  return (
    event.messageId === messageId &&
    (event.type === 'agent_response_final' ||
      event.type === 'message_completed' ||
      event.type === 'message_failed' ||
      event.type === 'message_cancelled' ||
      event.type === 'run_failed' ||
      event.type === 'run_cancelled')
  );
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
    selectedAutomationId: loadInitialSelectedAutomationId(),
    selectedEnvironmentId: loadInitialSelectedEnvironmentId(),
  };
}

function loadInitialSessionFilters(): SessionFilters {
  const raw = sessionStorage.getItem(sessionFiltersStorageKey);
  if (!raw) return emptySessionFilters;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionFilters>;
    return {
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      createdByMe: parsed.createdByMe === true,
      participatedByMe: parsed.participatedByMe === true,
      starredByMe: parsed.starredByMe === true,
    };
  } catch {
    return emptySessionFilters;
  }
}

function sessionFilterRequestOptions(filters: SessionFilters) {
  return {
    ...(filters.tags.length ? { tags: filters.tags } : {}),
    ...(filters.createdByMe ? { createdBy: 'me' as const } : {}),
    ...(filters.participatedByMe ? { participant: 'me' as const } : {}),
    ...(filters.starredByMe ? { starred: 'me' as const } : {}),
  };
}

function hasActiveSessionFilters(filters: SessionFilters): boolean {
  return filters.tags.length > 0 || filters.createdByMe || filters.participatedByMe || filters.starredByMe;
}

function sessionFilterCount(filters: SessionFilters): number {
  return (
    filters.tags.length + Number(filters.createdByMe) + Number(filters.participatedByMe) + Number(filters.starredByMe)
  );
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState(loadStoredToken);
  const [groups, setGroups] = useState<Group[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [navigation, setNavigation] = useState<NavigationState>(loadInitialNavigationState);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailState>(emptySessionDetail);
  const [repositoryOptionsState, setRepositoryOptionsState] = useState<AsyncState<RepositoryOption[]>>({
    data: [],
    loading: false,
    error: '',
  });
  const [environmentsState, setEnvironmentsState] = useState<AsyncState<Environment[]>>({
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
  const [newThreadEnvironmentId, setNewThreadEnvironmentId] = useState('');
  const [newThreadEnvironmentBranchOverrides, setNewThreadEnvironmentBranchOverrides] =
    useState<EnvironmentBranchOverrides>({});
  const [newThreadBranch, setNewThreadBranch] = useState('');
  const [newThreadPrompt, setNewThreadPrompt] = useState('');
  const [newThreadRepository, setNewThreadRepository] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [followUpEnvironmentId, setFollowUpEnvironmentId] = useState('');
  const [followUpEnvironmentBranchOverrides, setFollowUpEnvironmentBranchOverrides] =
    useState<EnvironmentBranchOverrides>({});
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
  const [sessionsNextCursor, setSessionsNextCursor] = useState<string | null>(null);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [archivedSessionsNextCursor, setArchivedSessionsNextCursor] = useState<string | null>(null);
  const [archivedSessionsLoaded, setArchivedSessionsLoaded] = useState(false);
  const [archivedSessionsLoading, setArchivedSessionsLoading] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [sessionSearchResults, setSessionSearchResults] = useState<SessionSearchResult[]>([]);
  const [sessionSearchNextCursor, setSessionSearchNextCursor] = useState<string | null>(null);
  const [sessionSearchLoading, setSessionSearchLoading] = useState(false);
  const [sessionSearchLoadingMore, setSessionSearchLoadingMore] = useState(false);
  const [sessionFilters, setSessionFilters] = useState<SessionFilters>(loadInitialSessionFilters);
  const [sessionTagOptions, setSessionTagOptions] = useState<SessionTagSummary[]>([]);
  const [sessionListHovered, setSessionListHovered] = useState(false);
  const [sessionOrderIds, setSessionOrderIds] = useState<string[]>([]);
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
    selectedAutomationId,
    selectedEnvironmentId,
  } = navigation;
  const { messages, events, activeProgress, artifacts, services, externalResources, callbacks } = sessionDetail;
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
  const pendingCreatedSessionIdRef = useRef('');
  const sessionsRef = useRef(sessions);
  const sessionsNextCursorRef = useRef(sessionsNextCursor);
  const sessionFiltersRef = useRef(sessionFilters);
  const sessionSearchQueryRef = useRef(sessionSearchQuery);
  const sessionSearchNextCursorRef = useRef(sessionSearchNextCursor);
  const messagesRef = useRef(messages);
  const createSessionInFlightRef = useRef(false);
  const sendMessageInFlightRef = useRef(false);
  const sessionsRefreshTimerRef = useRef<number | null>(null);
  const sessionsRefreshInFlightRef = useRef(false);
  const sessionsRefreshQueuedRef = useRef(false);
  const sessionsRefreshRequestRef = useRef(0);
  const archivedSessionsRequestRef = useRef(0);
  const sessionSummaryRefreshInFlightRef = useRef(new Set<string>());
  const sessionSearchRequestRef = useRef(0);
  const sessionMutationVersionRef = useRef(new Map<string, number>());
  const detailRefreshInFlightRef = useRef<string | null>(null);
  const detailRefreshQueuedSessionIdRef = useRef<string | null>(null);
  const sessionMilestoneInteractionRef = useRef<SessionMilestoneInteraction | null>(null);
  const sessionDetailMilestoneStartedRef = useRef(false);
  const pendingSessionMilestoneTriggerRef = useRef<BrowserMilestoneTrigger | null>(
    selectedSessionId ? 'startup_selection' : null,
  );
  const branchOptionsRepositoryRef = useRef('');
  const defaultSetupGuideOpenedRef = useRef(false);
  const activeProgressTimerRef = useRef<number | null>(null);
  const queuedActiveProgressRef = useRef<AgentEvent[]>([]);
  const createdSessionBackfillAbortRef = useRef<AbortController | null>(null);
  const initialResourceDeepLinkRef = useRef(hasResourceSearchParam());
  const initialAutomationDeepLinkRef = useRef(new URLSearchParams(window.location.search).has('automation'));

  const repositoryOptions = repositoryOptionsState.data;
  const repositoryOptionsLoading = repositoryOptionsState.loading;
  const repositoryOptionsError = repositoryOptionsState.error;
  const environments = environmentsState.data;
  const environmentsLoading = environmentsState.loading;
  const environmentsError = environmentsState.error;
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
  const automationCreatableGroups = sessionAuthRequired
    ? activeGroups.filter((group) => group.canCreateAutomations)
    : activeGroups;
  const manageableGroups = groups.filter((group) => group.canManage);
  const canManageAllGroups = canCallApi && (!sessionAuthRequired || currentUser?.role === 'super_admin');
  const canCreateThread =
    canCallApi &&
    (!sessionAuthRequired ||
      (currentUser?.role === 'super_admin' && activeGroups.length > 0) ||
      creatableGroups.length > 0);
  const canViewAutomations = canCreateThread;
  const canCreateAutomations = canCallApi && (!sessionAuthRequired || automationCreatableGroups.length > 0);
  const {
    currentSuperAdminUsers,
    groupForm,
    groupFormError,
    groupMembers,
    memberSearch,
    superAdminSearch,
    addGroupMember,
    createAccessGroup,
    prepareNewGroupForm,
    promoteSuperAdmin,
    removeSelectedGroupMember,
    removeSuperAdmin,
    resetAccessGroupsAdmin,
    saveSelectedGroup,
    selectMemberUser,
    selectSuperAdminUser,
    setGroupFormAutomationCreateRequiredRole,
    setGroupFormName,
    setGroupFormVisibility,
    setGroupFormWritePolicy,
    setMemberRole,
    setMemberSearchQuery,
    setMemberUserId,
    setSuperAdminSearchQuery,
    setSuperAdminUserId,
    updateGroupMemberRole,
  } = useAccessGroupsAdmin({
    canManageAllGroups,
    currentUser,
    groups,
    groupsPanelOpen,
    groupsPanelView,
    selectedGroupId,
    token,
    handleApiError,
    refreshGroups,
    setCurrentUser,
    setError,
    setGroups,
  });
  const {
    automations,
    selectedAutomation,
    archivedAutomationsOpen,
    setArchivedAutomationsOpen,
    automationsLoading,
    automationsLoaded,
    refreshAutomations,
    handleAutomationChanged,
    handleArchiveAutomation,
    handleUnarchiveAutomation,
    reset: resetAutomationsAdmin,
  } = useAutomationsAdmin({
    token,
    canViewAutomations,
    selectedAutomationId,
    initialAutomationDeepLinkRef,
    clearResourceSearchParams,
    handleApiError,
    setError,
    setSelectedAutomationId,
  });
  const canManageGroups = canManageAllGroups || (canCallApi && manageableGroups.length > 0);
  const canViewGroups = canManageGroups || (canCallApi && sessionAuthRequired && groups.length > 0);
  const canViewEnvironments =
    canCallApi &&
    (!sessionAuthRequired ||
      currentUser?.role === 'super_admin' ||
      groups.some((group) => !group.archivedAt && Boolean(group.membershipRole)));
  const canCreateEnvironments = canCallApi && groups.some((group) => !group.archivedAt && group.canManage);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
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
    canViewSetup &&
    health &&
    !health.hideSetupPage &&
    !defaultSetupGuideOpenedRef.current &&
    !initialResourceDeepLinkRef.current,
  );
  const showingSetupGuide = setupGuideOpen || defaultSetupGuidePending;
  const startupLoading = waitingForAuth || (canCallApi && !sessionsLoaded);
  const selectedRepository = repositoryLabel(selectedSession?.context?.repository);
  const selectedSessionEnvironment = sessionContextEnvironment(selectedSession?.context?.environment);
  const selectedSessionEnvironmentId = selectedSessionEnvironment?.id ?? '';
  const selectedSessionCodebaseLabel = selectedSessionEnvironment
    ? `${selectedSessionEnvironment.name} · ${selectedSessionEnvironment.repositories.length} repo${
        selectedSessionEnvironment.repositories.length === 1 ? '' : 's'
      }`
    : (selectedRepository ?? '');
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
  const selectedAutomationArchived = Boolean(selectedAutomation?.archivedAt);
  const activeEnvironmentOptions = environments.filter((environment) => !environment.archivedAt);
  const newThreadEffectiveGroupId = newThreadGroupId || creatableGroups[0]?.id || '';
  const newThreadEnvironmentOptions = activeEnvironmentOptions.filter((environment) =>
    environmentAvailableToGroup(environment, newThreadEffectiveGroupId),
  );
  const followUpEnvironmentOptions = selectedSession
    ? activeEnvironmentOptions.filter((environment) =>
        environmentAvailableToGroup(environment, selectedSession.ownerGroupId),
      )
    : activeEnvironmentOptions;
  const selectedSessionHasMessages = messages.some((message) => message.sessionId === selectedSessionId);
  const selectedSessionDetailLoading = Boolean(
    selectedSessionId && detailLoadedSessionId !== selectedSessionId && !selectedSessionHasMessages,
  );
  const sortedSessions = useMemo(() => sortSessionsByLastActivity(sessions), [sessions]);
  const displayedSessions = useMemo(
    () => applyFrozenSessionOrder(sessions, sessionOrderIds, { frozen: sessionListHovered }).sessions,
    [sessions, sessionOrderIds, sessionListHovered],
  );
  const activeSessionFilterCount = sessionFilterCount(sessionFilters);
  const selectedSessionLineage: SessionLineage | undefined = selectedSession
    ? {
        current: selectedSession,
        parent: selectedSession.parentSessionId
          ? sessions.find((session) => session.id === selectedSession.parentSessionId)
          : undefined,
        children: sessions.filter((session) => session.parentSessionId === selectedSession.id),
        onSelectSession: selectSession,
      }
    : undefined;

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

  function setSelectedAutomationId(next: StateUpdate<string>) {
    setNavigation((current) => ({
      ...current,
      selectedAutomationId: resolveStateUpdate(next, current.selectedAutomationId),
    }));
  }

  function applySessionFilters(filters: SessionFilters) {
    sessionFiltersRef.current = filters;
    sessionStorage.setItem(sessionFiltersStorageKey, JSON.stringify(filters));
    sessionsRefreshRequestRef.current += 1;
    archivedSessionsRequestRef.current += 1;
    sessionSearchRequestRef.current += 1;
    setSessionFilters(filters);
  }

  function sessionMutationKey(sessionId: string, kind: 'star' | 'tags'): string {
    return `${sessionId}:${kind}`;
  }

  function nextSessionMutationVersion(sessionId: string, kind: 'star' | 'tags'): number {
    const key = sessionMutationKey(sessionId, kind);
    const next = (sessionMutationVersionRef.current.get(key) ?? 0) + 1;
    sessionMutationVersionRef.current.set(key, next);
    return next;
  }

  function isCurrentSessionMutation(sessionId: string, kind: 'star' | 'tags', version: number): boolean {
    return sessionMutationVersionRef.current.get(sessionMutationKey(sessionId, kind)) === version;
  }

  useEffect(() => {
    if (!startupLoading || connectionStatus.state !== 'ok') return;
    const timeout = window.setTimeout(() => {
      setConnectionStatus(startupDelayedConnectionStatus());
    }, startupConnectionDelayMs);
    return () => window.clearTimeout(timeout);
  }, [startupLoading, connectionStatus.state]);

  useEffect(() => {
    if (sessionListHovered) return;
    setSessionOrderIds(sortedSessions.map((session) => session.id));
  }, [sessionListHovered, sortedSessions]);

  useEffect(() => {
    sessionFiltersRef.current = sessionFilters;
    sessionStorage.setItem(sessionFiltersStorageKey, JSON.stringify(sessionFilters));
    sessionsRefreshRequestRef.current += 1;
    archivedSessionsRequestRef.current += 1;
    sessionSearchRequestRef.current += 1;
    if (!canCallApi) return;
    setSessions([]);
    setSessionsNextCursor(null);
    setArchivedSessionsNextCursor(null);
    setArchivedSessionsLoaded(false);
    setSessionSearchResults([]);
    setSessionSearchNextCursor(null);
    setSessionOrderIds([]);
    setSessionListHovered(false);
    refreshSessions().catch(() => undefined);
  }, [canCallApi, token, sessionFilters]);

  useEffect(() => {
    if (!canCallApi || sidebarPanel !== 'sessions') return;
    listSessionTags(token)
      .then(setSessionTagOptions)
      .catch(() => undefined);
  }, [canCallApi, sidebarPanel, token]);

  useEffect(() => {
    const query = sessionSearchQuery.trim();
    const requestId = sessionSearchRequestRef.current + 1;
    sessionSearchRequestRef.current = requestId;
    if (!query || !canCallApi) {
      setSessionSearchResults([]);
      setSessionSearchNextCursor(null);
      setSessionSearchLoading(false);
      return;
    }
    setSessionSearchLoading(true);
    const timeout = window.setTimeout(() => {
      searchSessions(token, { query, limit: sessionSearchPageSize, ...sessionFilterRequestOptions(sessionFilters) })
        .then((page) => {
          if (sessionSearchRequestRef.current !== requestId) return;
          setSessionSearchResults(page.results);
          setSessions((current) =>
            mergeSessionsById(
              current,
              page.results.map((result) => result.session),
            ),
          );
          setSessionSearchNextCursor(page.nextCursor);
        })
        .catch((err) => {
          if (sessionSearchRequestRef.current === requestId) handleApiError(err);
        })
        .finally(() => {
          if (sessionSearchRequestRef.current === requestId) setSessionSearchLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [sessionSearchQuery, canCallApi, token, sessionFilters]);

  useEffect(() => {
    if (!archivedSessionsOpen || !canCallApi || archivedSessionsLoaded || archivedSessionsLoading) return;
    loadArchivedSessions(true).catch(() => undefined);
  }, [archivedSessionsOpen, canCallApi, archivedSessionsLoaded, archivedSessionsLoading, token]);

  useEffect(() => {
    return () => {
      if (sessionsRefreshTimerRef.current !== null) window.clearTimeout(sessionsRefreshTimerRef.current);
      abortCreatedSessionBackfill();
      sessionMilestoneInteractionRef.current?.abort('unmount');
      sessionMilestoneInteractionRef.current = null;
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
    if (!canCallApi) {
      setEnvironmentsState((current) => ({ ...current, loading: false }));
      return;
    }
    let cancelled = false;

    setEnvironmentsState((current) => ({ ...current, loading: true, error: '' }));
    listEnvironments(token)
      .then((nextEnvironments) => {
        if (cancelled) return;
        setEnvironmentsState({ data: nextEnvironments, loading: false, error: '' });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEnvironmentsState((current) => ({ ...current, loading: false, error: errorMessage(err) }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canCallApi, token]);

  useEffect(() => {
    if (
      !canViewSetup ||
      !health ||
      health.hideSetupPage ||
      defaultSetupGuideOpenedRef.current ||
      initialResourceDeepLinkRef.current
    )
      return;
    defaultSetupGuideOpenedRef.current = true;
    setSetupGuideOpen(true);
  }, [canViewSetup, health]);

  useEffect(() => {
    if (!canViewSetup || !showingSetupGuide) return;
    void refreshSetupStatus();
  }, [canViewSetup, showingSetupGuide, token]);

  useEffect(() => {
    if (!newThreadEnvironmentId) return;
    if (!newThreadEnvironmentOptions.some((environment) => environment.id === newThreadEnvironmentId)) {
      setNewThreadEnvironmentId('');
      setNewThreadEnvironmentBranchOverrides({});
    }
  }, [newThreadEnvironmentId, newThreadEnvironmentOptions]);

  useEffect(() => {
    if (!followUpEnvironmentId) return;
    if (!followUpEnvironmentOptions.some((environment) => environment.id === followUpEnvironmentId)) {
      setFollowUpEnvironmentId('');
      setFollowUpEnvironmentBranchOverrides({});
    }
  }, [followUpEnvironmentId, followUpEnvironmentOptions]);

  useEffect(() => {
    const repository =
      isCreatingThread || !selectedSessionId
        ? newThreadEnvironmentId
          ? ''
          : newThreadRepository
        : followUpEnvironmentId || (!followUpRepository && selectedSessionEnvironment)
          ? ''
          : followUpRepository || selectedRepository || '';
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
    newThreadEnvironmentId,
    newThreadRepository,
    followUpEnvironmentId,
    followUpRepository,
    selectedSessionEnvironmentId,
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

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    sessionsNextCursorRef.current = sessionsNextCursor;
  }, [sessionsNextCursor]);

  useEffect(() => {
    sessionFiltersRef.current = sessionFilters;
    sessionStorage.setItem(sessionFiltersStorageKey, JSON.stringify(sessionFilters));
  }, [sessionFilters]);

  useEffect(() => {
    sessionSearchQueryRef.current = sessionSearchQuery;
  }, [sessionSearchQuery]);

  useEffect(() => {
    sessionSearchNextCursorRef.current = sessionSearchNextCursor;
  }, [sessionSearchNextCursor]);

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
    refreshGroups().catch(() => undefined);
  }, [canCallApi, token]);

  useEffect(() => {
    if (!canViewAutomations || sidebarPanel !== 'automations') return;
    refreshAutomations().catch(() => undefined);
  }, [canViewAutomations, sidebarPanel, token]);

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
    if (!selectedSessionId || !canCallApi) {
      sessionMilestoneInteractionRef.current?.abort('selection_change');
      sessionMilestoneInteractionRef.current = null;
      return;
    }
    setDetailLoadedSessionId((current) => (current === selectedSessionId ? current : ''));
    const trigger = pendingSessionMilestoneTriggerRef.current ?? 'selection';
    pendingSessionMilestoneTriggerRef.current = null;
    sessionDetailMilestoneStartedRef.current = true;
    void refreshSessionDetail(selectedSessionId, trigger);
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
                (detailLoadedSessionIdRef.current === activeSessionId ||
                  activeSessionHasMessages ||
                  pendingCreatedSessionIdRef.current === activeSessionId)
              ) {
                const shouldResetPendingDetail =
                  pendingCreatedSessionIdRef.current === activeSessionId &&
                  detailLoadedSessionIdRef.current !== activeSessionId &&
                  !activeSessionHasMessages;
                eventCursor.current = Math.max(eventCursor.current, event.sequence);
                if (shouldUseActiveProgressEvent(event, messagesRef.current)) {
                  queueActiveProgressEvent(event);
                } else {
                  if (event.type === 'agent_response_final' && event.messageId) {
                    discardQueuedActiveProgress(event.messageId);
                  }
                  setSessionDetail((current) => {
                    const base = shouldResetPendingDetail ? emptySessionDetail() : current;
                    return {
                      ...base,
                      activeProgress:
                        event.type === 'agent_response_final' && event.messageId
                          ? omitActiveProgress(base.activeProgress, event.messageId)
                          : base.activeProgress,
                      events: upsertEvent(base.events, event),
                    };
                  });
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

              if (shouldRefreshSessions(event.type)) {
                refreshLoadedSessionSummary(event.sessionId).catch(() => undefined);
                scheduleSessionsRefresh();
              }
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

  function abortCreatedSessionBackfill() {
    createdSessionBackfillAbortRef.current?.abort();
    createdSessionBackfillAbortRef.current = null;
  }

  function waitForCreatedSessionBackfillDelay(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timeout: number | undefined;
      const finish = () => {
        if (timeout !== undefined) window.clearTimeout(timeout);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      timeout = window.setTimeout(finish, createdSessionBackfillDelayMs);
      signal.addEventListener('abort', finish, { once: true });
    });
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
    const requestId = sessionsRefreshRequestRef.current + 1;
    sessionsRefreshRequestRef.current = requestId;
    if (sessionsRefreshInFlightRef.current) {
      sessionsRefreshQueuedRef.current = true;
      return;
    }

    sessionsRefreshInFlightRef.current = true;
    setLoading(true);
    setError('');
    const refreshStartCursor = sessionsNextCursorRef.current;
    const filters = sessionFiltersRef.current;
    const filterOptions = sessionFilterRequestOptions(filters);
    try {
      const page = await listSessions(token, { limit: sessionListPageSize, ...filterOptions });
      if (sessionsRefreshRequestRef.current !== requestId) return;
      const selectedId = selectedSessionIdRef.current;
      let selected: Session | null = null;
      let selectedRemoved = false;
      if (selectedId && !page.sessions.some((session) => session.id === selectedId)) {
        try {
          selected = await getSession({ sessionId: selectedId, token });
        } catch (err) {
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            selectedRemoved = true;
          } else {
            throw err;
          }
        }
      }
      if (sessionsRefreshRequestRef.current !== requestId) return;
      const cursorAdvancedDuringRefresh = sessionsNextCursorRef.current !== refreshStartCursor;
      setSessions((current) => {
        const incoming = selected ? [...page.sessions, selected] : page.sessions;
        const next = hasActiveSessionFilters(filters)
          ? mergeSessionsById(
              cursorAdvancedDuringRefresh ? current : current.filter((session) => session.status === 'archived'),
              incoming,
            )
          : mergeSessionsById(current, incoming);
        return selectedRemoved && selectedId ? next.filter((session) => session.id !== selectedId) : next;
      });
      setSessionsNextCursor((current) => {
        const next = current !== refreshStartCursor ? current : page.nextCursor;
        sessionsNextCursorRef.current = next;
        return next;
      });
      setSessionsLoaded(true);
      setSelectedSessionId((current) => {
        if (selectedRemoved && current === selectedId) {
          sessionStorage.removeItem(selectedSessionStorageKey);
          return '';
        }
        if (current) return current;
        if (sessionStorage.getItem(newSessionSelectedStorageKey) === 'true') return '';
        const next = page.sessions[0]?.id ?? selected?.id ?? '';
        if (next) {
          pendingSessionMilestoneTriggerRef.current = sessionDetailMilestoneStartedRef.current
            ? 'selection'
            : 'startup_selection';
          sessionStorage.setItem(selectedSessionStorageKey, next);
        } else {
          sessionStorage.removeItem(selectedSessionStorageKey);
        }
        return next;
      });
    } catch (err) {
      if (sessionsRefreshRequestRef.current === requestId) {
        setSessionsLoaded(true);
        handleApiError(err);
      }
    } finally {
      if (sessionsRefreshRequestRef.current === requestId || !sessionsRefreshQueuedRef.current) setLoading(false);
      sessionsRefreshInFlightRef.current = false;
      if (sessionsRefreshQueuedRef.current) {
        sessionsRefreshQueuedRef.current = false;
        scheduleSessionsRefresh(0);
      }
    }
  }

  async function refreshLoadedSessionSummary(sessionId: string) {
    if (!sessionId || !sessionsRef.current.some((session) => session.id === sessionId)) return;
    if (hasActiveSessionFilters(sessionFiltersRef.current)) return;
    const inFlight = sessionSummaryRefreshInFlightRef.current;
    if (inFlight.has(sessionId)) return;
    inFlight.add(sessionId);
    try {
      const session = await getSession({ sessionId, token });
      setSessions((current) => mergeSessionsById(current, [session]));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setSessions((current) => current.filter((session) => session.id !== sessionId));
        if (selectedSessionIdRef.current === sessionId) setSelectedSessionId('');
      } else {
        handleApiError(err);
      }
    } finally {
      inFlight.delete(sessionId);
    }
  }

  async function loadMoreSessions() {
    if (!sessionsNextCursor || sessionsLoadingMore || !canCallApi) return;
    const requestId = sessionsRefreshRequestRef.current;
    const filters = sessionFiltersRef.current;
    setSessionsLoadingMore(true);
    setError('');
    try {
      const page = await listSessions(token, {
        cursor: sessionsNextCursor,
        limit: sessionListPageSize,
        ...sessionFilterRequestOptions(filters),
      });
      if (sessionsRefreshRequestRef.current !== requestId) return;
      setSessions((current) => mergeSessionsById(current, page.sessions));
      if (sessionListHovered) {
        setSessionOrderIds((current) => [
          ...current,
          ...page.sessions.map((session) => session.id).filter((id) => !current.includes(id)),
        ]);
      }
      sessionsNextCursorRef.current = page.nextCursor;
      setSessionsNextCursor(page.nextCursor);
    } catch (err) {
      handleApiError(err);
    } finally {
      setSessionsLoadingMore(false);
    }
  }

  async function loadArchivedSessions(reset = false) {
    if (archivedSessionsLoading || (!reset && archivedSessionsLoaded && !archivedSessionsNextCursor)) return;
    const requestId = archivedSessionsRequestRef.current + 1;
    archivedSessionsRequestRef.current = requestId;
    const filters = sessionFiltersRef.current;
    const cursor = archivedSessionsNextCursor;
    setArchivedSessionsLoading(true);
    setError('');
    try {
      const page = await listSessions(token, {
        archived: true,
        limit: sessionListPageSize,
        ...sessionFilterRequestOptions(filters),
        ...(reset || !cursor ? {} : { cursor }),
      });
      if (archivedSessionsRequestRef.current !== requestId) return;
      setSessions((current) => mergeSessionsById(current, page.sessions));
      if (sessionListHovered) {
        setSessionOrderIds((current) => [
          ...current,
          ...page.sessions.map((session) => session.id).filter((id) => !current.includes(id)),
        ]);
      }
      setArchivedSessionsNextCursor(page.nextCursor);
      setArchivedSessionsLoaded(true);
    } catch (err) {
      handleApiError(err);
    } finally {
      setArchivedSessionsLoading(false);
    }
  }

  function handleArchivedSessionsOpenChange(open: boolean) {
    setArchivedSessionsOpen(open);
    if (open && canCallApi && !archivedSessionsLoaded) loadArchivedSessions(true).catch(() => undefined);
  }

  async function loadMoreSessionSearchResults() {
    const query = sessionSearchQueryRef.current.trim();
    const cursor = sessionSearchNextCursorRef.current;
    const requestId = sessionSearchRequestRef.current;
    if (!query || !cursor || sessionSearchLoadingMore || !canCallApi) return;
    setSessionSearchLoadingMore(true);
    setError('');
    try {
      const page = await searchSessions(token, {
        query,
        cursor,
        limit: sessionSearchPageSize,
        ...sessionFilterRequestOptions(sessionFiltersRef.current),
      });
      if (sessionSearchRequestRef.current !== requestId || sessionSearchQueryRef.current.trim() !== query) return;
      setSessionSearchResults((current) => mergeSessionSearchResultsById(current, page.results));
      setSessions((current) =>
        mergeSessionsById(
          current,
          page.results.map((result) => result.session),
        ),
      );
      setSessionSearchNextCursor(page.nextCursor);
    } catch (err) {
      handleApiError(err);
    } finally {
      setSessionSearchLoadingMore(false);
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
        if (groupsPanelOpen || sidebarPanel === 'groups') {
          if (groupsPanelView === 'group' && nextGroupId) setGroupSearchParam(nextGroupId);
          else clearResourceSearchParams();
        }
        return nextGroupId;
      });
    } catch (err) {
      handleApiError(componentCause(err));
    }
  }

  async function refreshSessionDetail(sessionId: string, trigger?: BrowserMilestoneTrigger) {
    setError('');
    if (!trigger) {
      await refreshSessionDetailWithoutMilestones(sessionId);
      return;
    }

    await refreshSessionDetailWithMilestones(sessionId, trigger);
  }

  async function refreshSessionDetailWithoutMilestones(sessionId: string) {
    await loadAndApplySessionDetail(sessionId, true);
  }

  async function loadAndApplySessionDetail(sessionId: string, handleErrors = false, signal?: AbortSignal) {
    try {
      const loaded = await loadSessionDetailPhases({ sessionId, token, ...(signal ? { signal } : {}) }).allReady;
      if (signal?.aborted) return null;
      if (selectedSessionIdRef.current !== sessionId) return null;
      eventCursor.current = loaded.events.at(-1)?.sequence ?? 0;
      setSessionDetail({
        messages: loaded.messages,
        events: filterActiveProgressEvents(loaded.events, loaded.messages),
        activeProgress: buildActiveProgress(loaded.events, loaded.messages),
        artifacts: loaded.artifacts,
        services: loaded.services,
        externalResources: loaded.externalResources,
        callbacks: loaded.callbacks,
      });
      setDetailLoadedSessionId(sessionId);
      return loaded;
    } catch (err) {
      if (handleErrors && !signal?.aborted) handleApiError(err);
      return null;
    }
  }

  async function backfillCreatedSessionUntilSettled(sessionId: string, messageId: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < createdSessionBackfillAttempts; attempt += 1) {
      if (signal.aborted || selectedSessionIdRef.current !== sessionId) return;
      const loaded = await loadAndApplySessionDetail(sessionId, false, signal);
      if (signal.aborted) return;
      const message = loaded?.messages.find((candidate) => candidate.id === messageId);
      if (message && isTerminalMessageStatus(message.status)) return;
      if (loaded?.events.some((event) => isTerminalMessageEvent(event, messageId))) return;
      await waitForCreatedSessionBackfillDelay(signal);
    }
  }

  async function refreshSessionDetailWithMilestones(sessionId: string, trigger: BrowserMilestoneTrigger) {
    sessionMilestoneInteractionRef.current?.abort('selection_change');
    const milestones = startSessionMilestoneInteraction({ token, trigger });
    sessionMilestoneInteractionRef.current = milestones;

    const phases = loadSessionDetailPhases({
      sessionId,
      token,
      traceparents: {
        detail: () => milestones.detail.traceparent(),
        outputs: () => milestones.outputs.traceparent(),
        services: () => milestones.services.traceparent(),
      },
    });
    void phases.allReady.catch(() => undefined);

    const detailReadyPromise = phases.detailReady
      .then((detail) => {
        if (selectedSessionIdRef.current !== sessionId) {
          milestones.abort('selection_change');
          return null;
        }
        eventCursor.current = detail.events.at(-1)?.sequence ?? 0;
        setSessionDetail({
          messages: detail.messages,
          events: filterActiveProgressEvents(detail.events, detail.messages),
          activeProgress: buildActiveProgress(detail.events, detail.messages),
          artifacts: [],
          services: [],
          externalResources: [],
          callbacks: [],
        });
        setDetailLoadedSessionId(sessionId);
        milestones.detail.success({
          messageCount: detail.messages.length,
          eventCount: detail.events.length,
        });
        return detail;
      })
      .catch((err) => {
        if (selectedSessionIdRef.current !== sessionId) return;
        milestones.detail.error(componentName(err, 'render'));
        handleApiError(componentCause(err));
        return null;
      });

    const outputsPromise = phases.outputsReady
      .then(async (outputs) => {
        const detail = await detailReadyPromise;
        if (!detail) {
          if (selectedSessionIdRef.current === sessionId) milestones.outputs.error('render');
          return;
        }
        if (selectedSessionIdRef.current !== sessionId) {
          milestones.outputs.abort('selection_change');
          return;
        }
        setSessionDetail((current) => ({
          ...current,
          artifacts: outputs.artifacts,
          externalResources: outputs.externalResources,
          callbacks: outputs.callbacks,
        }));
        milestones.outputs.success({
          inlineArtifactCount: countInlineArtifacts(outputs.artifacts, detail.messages, detail.events),
          artifactCount: outputs.artifacts.length,
          externalResourceCount: outputs.externalResources.length,
          callbackCount: outputs.callbacks.length,
        });
      })
      .catch((err) => {
        if (selectedSessionIdRef.current !== sessionId) return;
        milestones.outputs.error(componentName(err, 'render'));
        handleApiError(componentCause(err));
      });

    const servicesLoadPromise = phases.servicesReady
      .then(async (nextServices) => {
        if (!(await detailReadyPromise)) {
          if (selectedSessionIdRef.current === sessionId) milestones.services.error('render');
          return;
        }
        if (selectedSessionIdRef.current !== sessionId) {
          milestones.services.abort('selection_change');
          return;
        }
        setSessionDetail((current) => ({ ...current, services: nextServices }));
        milestones.services.success({ serviceCount: nextServices.length });
      })
      .catch((err) => {
        if (selectedSessionIdRef.current !== sessionId) return;
        milestones.services.error(componentName(err, 'services'));
        handleApiError(componentCause(err));
      });

    void Promise.all([detailReadyPromise, outputsPromise, servicesLoadPromise]).then(() => {
      if (sessionMilestoneInteractionRef.current === milestones) sessionMilestoneInteractionRef.current = null;
    });

    await detailReadyPromise;
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
    abortCreatedSessionBackfill();
    const firstEnvironmentId = newThreadEnvironmentId;
    const firstEnvironment = firstEnvironmentId
      ? (environments.find((environment) => environment.id === firstEnvironmentId) ?? null)
      : null;
    const firstEnvironmentBranchOverrides = environmentBranchOverrideInputs(
      firstEnvironment,
      newThreadEnvironmentBranchOverrides,
    );
    const previousEnvironmentBranchOverrides = newThreadEnvironmentBranchOverrides;
    const firstRepository = newThreadRepository.trim();
    const firstBranch = newThreadBranch;
    blurFocusedTextControl();
    setNewThreadPrompt('');
    setNewThreadEnvironmentId('');
    setNewThreadEnvironmentBranchOverrides({});
    setNewThreadRepository('');
    setNewThreadBranch('');
    setLoading(true);
    setError('');
    const previousSelectedSessionId = selectedSessionIdRef.current;
    try {
      const session = await createSession({
        title: titleFromPrompt(firstPrompt),
        token,
        ownerGroupId: newThreadGroupId,
      });
      // Mark the new session as the active realtime target before enqueueing the
      // first message. Fast deployments can emit completion events before React
      // commits the selected-session state below; the pending ref lets the SSE
      // handler accept only this new session without treating full detail as loaded.
      selectedSessionIdRef.current = session.id;
      pendingCreatedSessionIdRef.current = session.id;
      eventCursor.current = 0;
      const message = await enqueueMessage({
        sessionId: session.id,
        prompt: firstPrompt,
        token,
        ...(firstEnvironmentId
          ? {
              environmentId: firstEnvironmentId,
              ...(firstEnvironmentBranchOverrides.length
                ? { environmentBranchOverrides: firstEnvironmentBranchOverrides }
                : {}),
            }
          : firstRepository
            ? { repository: firstRepository }
            : {}),
        ...(newThreadModel ? { model: newThreadModel } : {}),
        ...(!firstEnvironmentId && firstBranch ? { branch: firstBranch } : {}),
      });
      const sessionContext = mergeDisplaySessionContext(
        session.context,
        message.context,
        firstEnvironmentId ? 'environment' : firstRepository ? 'repository' : undefined,
      );
      setSessions((current) => [
        {
          ...session,
          ...(sessionContext ? { context: sessionContext } : {}),
          status: session.status === 'active' ? 'active' : 'queued',
          updatedAt: message.createdAt,
          lastActivityAt: message.createdAt,
        },
        ...current,
      ]);
      selectSession(session.id);
      setSessionDetail((current) => {
        const scopedMessages = current.messages.filter((candidate) => candidate.sessionId === session.id);
        const nextMessages = scopedMessages.some((candidate) => candidate.id === message.id)
          ? scopedMessages
          : [...scopedMessages, message].sort((left, right) => left.sequence - right.sequence);
        const nextEvents = current.events.filter((event) => event.sessionId === session.id);
        return {
          ...emptySessionDetail(),
          messages: nextMessages,
          events: nextEvents,
          activeProgress: buildActiveProgress(nextEvents, nextMessages),
        };
      });
      pendingCreatedSessionIdRef.current = '';
      detailLoadedSessionIdRef.current = session.id;
      setDetailLoadedSessionId(session.id);
      const backfillAbort = new AbortController();
      createdSessionBackfillAbortRef.current = backfillAbort;
      backfillCreatedSessionUntilSettled(session.id, message.id, backfillAbort.signal)
        .catch(() => undefined)
        .finally(() => {
          if (createdSessionBackfillAbortRef.current === backfillAbort) createdSessionBackfillAbortRef.current = null;
        });
      updateNavigation({ isCreatingThread: false });
    } catch (err) {
      if (pendingCreatedSessionIdRef.current) {
        pendingCreatedSessionIdRef.current = '';
        selectedSessionIdRef.current = previousSelectedSessionId;
      }
      setNewThreadPrompt(firstPrompt);
      setNewThreadEnvironmentId(firstEnvironmentId);
      setNewThreadEnvironmentBranchOverrides(previousEnvironmentBranchOverrides);
      setNewThreadRepository(firstRepository);
      setNewThreadBranch(firstBranch);
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
      const followUpEnvironment = followUpEnvironmentId
        ? (environments.find((environment) => environment.id === followUpEnvironmentId) ?? null)
        : null;
      const environmentBranchOverrides = environmentBranchOverrideInputs(
        followUpEnvironment,
        followUpEnvironmentBranchOverrides,
      );
      const message = await enqueueMessage({
        sessionId: selectedSessionId,
        prompt: messagePrompt,
        token,
        ...(followUpEnvironmentId
          ? {
              environmentId: followUpEnvironmentId,
              ...(environmentBranchOverrides.length ? { environmentBranchOverrides } : {}),
            }
          : followUpRepository.trim()
            ? { repository: followUpRepository.trim() }
            : {}),
        ...(selectedFollowUpModel ? { model: selectedFollowUpModel } : {}),
        ...(!followUpEnvironmentId && followUpBranch ? { branch: followUpBranch } : {}),
      });
      setSessionDetail((current) => ({ ...current, messages: [...current.messages, message] }));
      setSessions((current) =>
        current.map((session) => {
          if (session.id !== selectedSessionId) return session;
          const sessionContext = mergeDisplaySessionContext(
            session.context,
            message.context,
            followUpEnvironmentId ? 'environment' : followUpRepository.trim() ? 'repository' : undefined,
          );
          return {
            ...session,
            ...(sessionContext ? { context: sessionContext } : {}),
            status: session.status === 'active' ? session.status : 'queued',
            updatedAt: message.createdAt,
            lastActivityAt: message.createdAt,
          };
        }),
      );
      setThreadAutoFollowEnabled(true);
      await refreshSessions();
      await refreshSessionDetail(selectedSessionId, 'refresh');
      return true;
    } catch (err) {
      handleApiError(err);
      return false;
    } finally {
      sendMessageInFlightRef.current = false;
    }
  }

  function handleNewThreadGroupChange(value: string) {
    setNewThreadGroupId(value);
    setNewThreadEnvironmentId((current) => {
      if (!current) return current;
      const environment = environments.find((candidate) => candidate.id === current);
      if (environment && environmentAvailableToGroup(environment, value)) return current;
      setNewThreadEnvironmentBranchOverrides({});
      return '';
    });
  }

  function handleNewThreadCodebaseChange(value: string) {
    const selection = parseCodebasePickerValue(value);
    setNewThreadEnvironmentBranchOverrides({});
    setNewThreadBranch('');
    if (selection?.kind === 'environment') {
      setNewThreadEnvironmentId(selection.environmentId);
      setNewThreadRepository('');
      return;
    }
    setNewThreadEnvironmentId('');
    setNewThreadRepository(selection?.kind === 'repository' ? selection.repository : '');
  }

  function handleFollowUpCodebaseChange(value: string) {
    const selection = parseCodebasePickerValue(value);
    setFollowUpEnvironmentBranchOverrides({});
    setFollowUpBranch('');
    if (!selection) {
      setFollowUpEnvironmentId('');
      setFollowUpRepository('');
      return;
    }
    if (selection.kind === 'environment') {
      setFollowUpEnvironmentId(selection.environmentId === selectedSessionEnvironmentId ? '' : selection.environmentId);
      setFollowUpRepository('');
      return;
    }
    setFollowUpEnvironmentId('');
    setFollowUpRepository(
      !selectedSessionEnvironmentId && selection.repository === selectedRepository ? '' : selection.repository,
    );
  }

  function loadEnvironmentRepositoryBranches(repository: EnvironmentBranchOverrideRepository): Promise<BranchOption[]> {
    return listBranches({ repository: `${repository.owner}/${repository.repo}`, token });
  }

  function handleEnvironmentChanged(environment: Environment) {
    setEnvironmentsState((current) => ({
      ...current,
      data: [environment, ...current.data.filter((candidate) => candidate.id !== environment.id)].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    }));
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

  async function handleUpdateSessionTags(tags: string[]): Promise<boolean> {
    if (!selectedSessionId) return false;
    const mutationVersion = nextSessionMutationVersion(selectedSessionId, 'tags');
    const previous = sessionsRef.current.find((session) => session.id === selectedSessionId) ?? null;
    if (previous) applySessionListUpdate({ ...previous, tags }, { forceKeep: true });
    setError('');
    try {
      const session = await updateSessionTags({ sessionId: selectedSessionId, tags, token });
      if (!isCurrentSessionMutation(selectedSessionId, 'tags', mutationVersion)) return true;
      applySessionListUpdate(session);
      listSessionTags(token)
        .then(setSessionTagOptions)
        .catch(() => undefined);
      return true;
    } catch (err) {
      if (!isCurrentSessionMutation(selectedSessionId, 'tags', mutationVersion)) return true;
      if (previous) {
        const current = sessionsRef.current.find((session) => session.id === selectedSessionId);
        applySessionListUpdate({ ...(current ?? previous), tags: previous.tags ?? [] }, { forceKeep: true });
      }
      handleApiError(err);
      return false;
    }
  }

  async function handleSetSessionStarred(sessionId: string, starred: boolean) {
    const mutationVersion = nextSessionMutationVersion(sessionId, 'star');
    const previous = sessionsRef.current.find((session) => session.id === sessionId) ?? null;
    if (previous) applySessionListUpdate({ ...previous, starred }, { forceKeep: true });
    setError('');
    try {
      const nextStarred = await setSessionStarred({ sessionId, starred, token });
      if (!isCurrentSessionMutation(sessionId, 'star', mutationVersion)) return;
      const current = sessionsRef.current.find((session) => session.id === sessionId);
      if (current) applySessionListUpdate({ ...current, starred: nextStarred });
    } catch (err) {
      if (!isCurrentSessionMutation(sessionId, 'star', mutationVersion)) return;
      if (previous) {
        const current = sessionsRef.current.find((session) => session.id === sessionId);
        applySessionListUpdate({ ...(current ?? previous), starred: previous.starred === true }, { forceKeep: true });
      }
      handleApiError(err);
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
      await refreshSessionDetail(selectedSessionId, 'refresh');
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
    abortCreatedSessionBackfill();
    selectedSessionIdRef.current = '';
    detailLoadedSessionIdRef.current = '';
    pendingCreatedSessionIdRef.current = '';
    eventCursor.current = 0;
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
    sessionStorage.removeItem(selectedAutomationStorageKey);
    sessionStorage.removeItem(selectedEnvironmentStorageKey);
    sessionStorage.removeItem(archivedAutomationsOpenStorageKey);
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    setSessions([]);
    setSessionsNextCursor(null);
    setArchivedSessionsNextCursor(null);
    setArchivedSessionsLoaded(false);
    setSessionSearchQuery('');
    setSessionSearchResults([]);
    setSessionSearchNextCursor(null);
    resetAutomationsAdmin();
    setGroups([]);
    setEnvironmentsState({ data: [], loading: false, error: '' });
    resetAccessGroupsAdmin();
    setSessionsLoaded(false);
    setDetailLoadedSessionId('');
    updateNavigation({
      selectedSessionId: '',
      selectedAutomationId: '',
      selectedEnvironmentId: '',
      sidebarPanel: 'sessions',
      isCreatingThread: false,
      setupGuideOpen: false,
      groupsPanelOpen: false,
    });
    setNewThreadEnvironmentId('');
    setNewThreadEnvironmentBranchOverrides({});
    setFollowUpEnvironmentId('');
    setFollowUpEnvironmentBranchOverrides({});
    clearSessionDetail();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    setSetupStatus(null);
    setSetupStatusError('');
  }

  function startNewThread() {
    if (!canCreateThread) return;
    abortCreatedSessionBackfill();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    setSidebarOpen(false);
    setSidebarCollapsed(false);
    sessionStorage.removeItem(selectedSessionStorageKey);
    clearSessionSearchParam();
    sessionStorage.setItem(newSessionSelectedStorageKey, 'true');
    updateNavigation({
      selectedSessionId: '',
      sidebarPanel: 'sessions',
      isCreatingThread: true,
      setupGuideOpen: false,
      groupsPanelOpen: false,
    });
    setNewThreadEnvironmentId('');
    setNewThreadEnvironmentBranchOverrides({});
    setFollowUpRepository('');
    setFollowUpEnvironmentId('');
    setFollowUpEnvironmentBranchOverrides({});
    setFollowUpBranch('');
    setFollowUpModel('');
    clearSessionDetail();
    eventCursor.current = 0;
  }

  function selectSession(sessionId: string) {
    if (selectedSessionIdRef.current !== sessionId) abortCreatedSessionBackfill();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    autoScrolledSessionId.current = '';
    if (selectedSessionIdRef.current !== sessionId) pendingSessionMilestoneTriggerRef.current = 'selection';
    selectedSessionIdRef.current = sessionId;
    sessionStorage.setItem(selectedSessionStorageKey, sessionId);
    sessionStorage.setItem(sidebarPanelStorageKey, 'sessions');
    setSessionSearchParam(sessionId);
    sessionStorage.removeItem(newSessionSelectedStorageKey);
    updateNavigation({
      selectedSessionId: sessionId,
      sidebarPanel: 'sessions',
      isCreatingThread: false,
      setupGuideOpen: false,
      groupsPanelOpen: false,
    });
    setFollowUpEnvironmentId('');
    setFollowUpEnvironmentBranchOverrides({});
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
    if (selectedGroupId) setGroupSearchParam(selectedGroupId);
    else clearResourceSearchParams();
    updateNavigation({ setupGuideOpen: false, groupsPanelOpen: true, sidebarPanel: 'groups' });
    setSidebarCollapsed(false);
    setSidebarOpen(!desktop);
  }

  function openAutomationsPanel() {
    if (!canViewAutomations) return;
    const desktop = isDesktopViewport();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'automations');
    if (selectedAutomationId) setAutomationSearchParam(selectedAutomationId);
    else clearResourceSearchParams();
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'automations',
      isCreatingThread: false,
    });
    setSidebarCollapsed(false);
    setSidebarOpen(!desktop);
  }

  function openEnvironmentsPanel() {
    if (!canViewEnvironments) return;
    const desktop = isDesktopViewport();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'environments');
    if (selectedEnvironmentId) setEnvironmentSearchParam(selectedEnvironmentId);
    else clearResourceSearchParams();
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'environments',
      isCreatingThread: false,
    });
    setSidebarCollapsed(false);
    setSidebarOpen(!desktop);
  }

  function startNewEnvironment() {
    if (!canCreateEnvironments) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.removeItem(selectedEnvironmentStorageKey);
    clearResourceSearchParams();
    sessionStorage.setItem(sidebarPanelStorageKey, 'environments');
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'environments',
      isCreatingThread: false,
      selectedEnvironmentId: '',
    });
    if (!isDesktopViewport()) setSidebarOpen(false);
  }

  function startNewAutomation() {
    if (!canCreateAutomations) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.removeItem(selectedAutomationStorageKey);
    clearResourceSearchParams();
    sessionStorage.setItem(sidebarPanelStorageKey, 'automations');
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'automations',
      isCreatingThread: false,
      selectedAutomationId: '',
    });
    if (!isDesktopViewport()) setSidebarOpen(false);
  }

  function selectAutomationPanel(automationId: string) {
    if (!canViewAutomations) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'automations');
    sessionStorage.setItem(selectedAutomationStorageKey, automationId);
    setAutomationSearchParam(automationId);
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'automations',
      isCreatingThread: false,
      selectedAutomationId: automationId,
    });
    if (!isDesktopViewport()) setSidebarOpen(false);
  }

  function handleAutomationSaved(automation: Automation) {
    handleAutomationChanged(automation);
    sessionStorage.setItem(selectedAutomationStorageKey, automation.id);
    setAutomationSearchParam(automation.id);
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'automations',
      isCreatingThread: false,
      selectedAutomationId: automation.id,
    });
  }

  function selectEnvironmentPanel(environmentId: string) {
    if (!canViewEnvironments) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'environments');
    sessionStorage.setItem(selectedEnvironmentStorageKey, environmentId);
    setEnvironmentSearchParam(environmentId);
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'environments',
      isCreatingThread: false,
      selectedEnvironmentId: environmentId,
    });
    if (!isDesktopViewport()) setSidebarOpen(false);
  }

  function handleEnvironmentSaved(environment: Environment) {
    handleEnvironmentChanged(environment);
    sessionStorage.setItem(selectedEnvironmentStorageKey, environment.id);
    setEnvironmentSearchParam(environment.id);
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'environments',
      isCreatingThread: false,
      selectedEnvironmentId: environment.id,
    });
  }

  function handleAutomationSessionCreated(session: Session) {
    setSessions((current) => [session, ...current.filter((candidate) => candidate.id !== session.id)]);
    selectSession(session.id);
  }

  function showSessionsSidebar() {
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'sessions');
    if (selectedSessionId) setSessionSearchParam(selectedSessionId);
    else clearResourceSearchParams();
    updateNavigation({ setupGuideOpen: false, groupsPanelOpen: false, sidebarPanel: 'sessions' });
    setSidebarCollapsed(false);
    setSidebarOpen(true);
  }

  function backToSessionsSidebar() {
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'sessions');
    if (selectedSessionId) setSessionSearchParam(selectedSessionId);
    else clearResourceSearchParams();
    updateNavigation({ setupGuideOpen: false, groupsPanelOpen: false, sidebarPanel: 'sessions' });
    setSidebarCollapsed(false);
    setSidebarOpen(true);
  }

  function startNewGroup() {
    if (!canManageAllGroups) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.setItem(groupsPanelOpenStorageKey, 'true');
    sessionStorage.setItem(sidebarPanelStorageKey, 'groups');
    sessionStorage.removeItem(groupsPanelViewStorageKey);
    clearResourceSearchParams();
    prepareNewGroupForm(nextAccessGroupName(groups));
    updateNavigation({
      setupGuideOpen: false,
      groupsPanelOpen: true,
      sidebarPanel: 'groups',
      groupsPanelView: 'new_group',
    });
    setSidebarCollapsed(false);
    if (!isDesktopViewport()) setSidebarOpen(false);
  }

  async function handleCreateGroup() {
    const group = await createAccessGroup();
    if (!group) return;
    sessionStorage.setItem(groupsPanelViewStorageKey, 'group');
    sessionStorage.setItem(groupsPanelSelectedGroupStorageKey, group.id);
    setGroupSearchParam(group.id);
    updateNavigation({ groupsPanelView: 'group', selectedGroupId: group.id });
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

  function selectGroupPanel(groupId: string) {
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.setItem(groupsPanelOpenStorageKey, 'true');
    sessionStorage.setItem(sidebarPanelStorageKey, 'groups');
    sessionStorage.setItem(groupsPanelViewStorageKey, 'group');
    sessionStorage.setItem(groupsPanelSelectedGroupStorageKey, groupId);
    setGroupSearchParam(groupId);
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
    clearResourceSearchParams();
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
    applySessionListUpdate(rollback.session);
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
    applySessionListUpdate({ ...session, status: 'idle' });
    return rollback;
  }

  function applyArchivedSession(session: Session) {
    applySessionListUpdate(session);
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
      applySessionListUpdate(session);
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
      applySessionListUpdate(session);
    } catch (err) {
      if (rollback) restoreSessionStatusRollback(rollback);
      handleApiError(err);
    }
  }

  function sessionMatchesVisibleFilters(session: Session): boolean {
    const filters = sessionFiltersRef.current;
    if (filters.tags.length && !filters.tags.every((tag) => (session.tags ?? []).includes(tag))) return false;
    if (filters.starredByMe && !session.starred) return false;
    return true;
  }

  function applySessionListUpdate(session: Session, options: { forceKeep?: boolean } = {}) {
    const keepVisible =
      options.forceKeep || selectedSessionIdRef.current === session.id || sessionMatchesVisibleFilters(session);
    setSessions((current) =>
      keepVisible ? mergeSessionsById(current, [session]) : current.filter((candidate) => candidate.id !== session.id),
    );
    setSessionSearchResults((current) => {
      const updated = updateSearchResultSession(current, session);
      return keepVisible ? updated : updated.filter((result) => result.session.id !== session.id);
    });
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
      await refreshSessionDetail(selectedSessionId, 'refresh');
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
          onSubmit={fireAndForget(handleLogin)}
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
                  aria-label={
                    sidebarPanel === 'groups'
                      ? 'Expand access'
                      : sidebarPanel === 'automations'
                        ? 'Expand automations'
                        : sidebarPanel === 'environments'
                          ? 'Expand environments'
                          : 'Expand sessions'
                  }
                  title={
                    sidebarPanel === 'groups'
                      ? 'Expand access'
                      : sidebarPanel === 'automations'
                        ? 'Expand automations'
                        : sidebarPanel === 'environments'
                          ? 'Expand environments'
                          : 'Expand sessions'
                  }
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
                    canViewAutomations={canViewAutomations}
                    canViewEnvironments={canViewEnvironments}
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
                    onArchiveGroup={fireAndForget(handleArchiveGroup)}
                    onCreateGroup={startNewGroup}
                    onOpenAutomations={openAutomationsPanel}
                    onOpenEnvironments={openEnvironmentsPanel}
                    onOpenGroups={openGroupsPanel}
                    onOpenSessions={showSessionsSidebar}
                    onOpenSetup={openSetupGuide}
                    onSelectGroup={selectGroupPanel}
                    onSelectSuperAdmins={selectSuperAdminsPanel}
                    onSignOut={signOut}
                    onThemeChange={setThemePreference}
                  />
                ) : sidebarPanel === 'automations' && canViewAutomations ? (
                  <AutomationsSidebar
                    archivedAutomationsOpen={archivedAutomationsOpen || selectedAutomationArchived}
                    authRequired={bearerAuthRequired || sessionAuthRequired}
                    automations={automations}
                    canCallApi={canViewAutomations}
                    canCreateAutomations={canCreateAutomations}
                    canViewGroups={canViewGroups}
                    canViewAutomations={canViewAutomations}
                    canViewEnvironments={canViewEnvironments}
                    canViewSetup={canViewSetup}
                    connectionStatus={connectionStatus}
                    groups={groups}
                    health={health}
                    loading={automationsLoading}
                    navPage={showingSetupGuide ? 'setup' : 'automations'}
                    selectedAutomationId={selectedAutomationId}
                    themePreference={themePreference}
                    token={token}
                    onBackToSessions={backToSessionsSidebar}
                    onArchiveAutomation={fireAndForget(handleArchiveAutomation)}
                    onArchivedAutomationsOpenChange={setArchivedAutomationsOpen}
                    onCollapse={collapseSidebar}
                    onCreateAutomation={startNewAutomation}
                    onOpenAutomations={openAutomationsPanel}
                    onOpenEnvironments={openEnvironmentsPanel}
                    onOpenGroups={openGroupsPanel}
                    onOpenSessions={showSessionsSidebar}
                    onOpenSetup={openSetupGuide}
                    onSelectAutomation={selectAutomationPanel}
                    onSignOut={signOut}
                    onThemeChange={setThemePreference}
                    onUnarchiveAutomation={fireAndForget(handleUnarchiveAutomation)}
                  />
                ) : sidebarPanel === 'environments' && canViewEnvironments ? (
                  <EnvironmentsSidebar
                    authRequired={bearerAuthRequired || sessionAuthRequired}
                    canCallApi={canViewEnvironments}
                    canCreateEnvironments={canCreateEnvironments}
                    canViewGroups={canViewGroups}
                    canViewAutomations={canViewAutomations}
                    canViewEnvironments={canViewEnvironments}
                    canViewSetup={canViewSetup}
                    connectionStatus={connectionStatus}
                    environments={environments}
                    health={health}
                    loading={environmentsLoading}
                    navPage={showingSetupGuide ? 'setup' : 'environments'}
                    selectedEnvironmentId={selectedEnvironmentId}
                    themePreference={themePreference}
                    token={token}
                    onBackToSessions={backToSessionsSidebar}
                    onCollapse={collapseSidebar}
                    onCreateEnvironment={startNewEnvironment}
                    onOpenAutomations={openAutomationsPanel}
                    onOpenEnvironments={openEnvironmentsPanel}
                    onOpenGroups={openGroupsPanel}
                    onOpenSessions={showSessionsSidebar}
                    onOpenSetup={openSetupGuide}
                    onSelectEnvironment={selectEnvironmentPanel}
                    onSignOut={signOut}
                    onThemeChange={setThemePreference}
                  />
                ) : (
                  <ThreadSidebar
                    archivedSessionsOpen={archivedSessionsOpen || Boolean(selectedSessionArchived)}
                    authRequired={bearerAuthRequired || sessionAuthRequired}
                    canCallApi={canCallApi}
                    canViewGroups={canViewGroups}
                    canViewAutomations={canViewAutomations}
                    canViewEnvironments={canViewEnvironments}
                    canStartNewThread={canCreateThread}
                    canViewSetup={canViewSetup}
                    canWriteSession={userCanWriteSession}
                    health={health}
                    connectionStatus={connectionStatus}
                    archivedSessionsLoaded={archivedSessionsLoaded}
                    archivedSessionsLoading={archivedSessionsLoading}
                    hasMoreArchivedSessions={Boolean(archivedSessionsNextCursor)}
                    hasMoreSessions={Boolean(sessionsNextCursor)}
                    loading={loading}
                    loadingMoreSessions={sessionsLoadingMore}
                    navPage={
                      showingSetupGuide
                        ? 'setup'
                        : sidebarPanel === 'environments'
                          ? 'environments'
                          : sidebarPanel === 'automations'
                            ? 'automations'
                            : 'sessions'
                    }
                    searchQuery={sessionSearchQuery}
                    searchResults={sessionSearchResults}
                    searchLoading={sessionSearchLoading || sessionSearchLoadingMore}
                    hasMoreSearchResults={Boolean(sessionSearchNextCursor)}
                    sessions={displayedSessions}
                    sessionFilters={sessionFilters}
                    sessionFilterCount={activeSessionFilterCount}
                    sessionTagOptions={sessionTagOptions}
                    selectedSessionId={selectedSessionId}
                    token={token}
                    onArchive={fireAndForget(archiveFromList)}
                    onArchivedSessionsOpenChange={handleArchivedSessionsOpenChange}
                    onCollapse={collapseSidebar}
                    onLoadMoreArchivedSessions={() => void loadArchivedSessions(false)}
                    onLoadMoreSearchResults={fireAndForget(loadMoreSessionSearchResults)}
                    onLoadMoreSessions={fireAndForget(loadMoreSessions)}
                    onNewThread={startNewThread}
                    onOpenAutomations={openAutomationsPanel}
                    onOpenEnvironments={openEnvironmentsPanel}
                    onOpenGroups={openGroupsPanel}
                    onOpenSessions={showSessionsSidebar}
                    onOpenSetup={openSetupGuide}
                    onRefresh={fireAndForget(refreshSessions)}
                    onSelect={selectSession}
                    onSearchChange={setSessionSearchQuery}
                    onSessionFiltersChange={applySessionFilters}
                    onSessionFiltersClear={() => applySessionFilters(emptySessionFilters)}
                    onSessionListHoverChange={setSessionListHovered}
                    onSessionStarChange={fireAndForget(handleSetSessionStarred)}
                    onSignOut={signOut}
                    onThemeChange={setThemePreference}
                    themePreference={themePreference}
                    onUnarchive={fireAndForget(unarchiveFromList)}
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
                    onAddMember={fireAndForget(addGroupMember)}
                    onArchiveGroup={fireAndForget(handleArchiveGroup)}
                    onCreateGroup={fireAndForget(handleCreateGroup)}
                    onGroupFormAutomationCreateRequiredRoleChange={setGroupFormAutomationCreateRequiredRole}
                    onGroupFormNameChange={setGroupFormName}
                    onGroupFormVisibilityChange={setGroupFormVisibility}
                    onGroupFormWritePolicyChange={setGroupFormWritePolicy}
                    onMemberRoleChange={setMemberRole}
                    onMemberSearchQueryChange={setMemberSearchQuery}
                    onMemberUserIdChange={setMemberUserId}
                    onOpenSidebar={expandSidebar}
                    onSelectMemberUser={selectMemberUser}
                    onPromoteSuperAdmin={fireAndForget(promoteSuperAdmin)}
                    onRemoveMember={fireAndForget(removeSelectedGroupMember)}
                    onRemoveSuperAdmin={fireAndForget(removeSuperAdmin)}
                    onSaveGroup={fireAndForget(saveSelectedGroup)}
                    onSelectGroup={selectGroupPanel}
                    onSelectSuperAdminUser={selectSuperAdminUser}
                    onSelectSuperAdmins={selectSuperAdminsPanel}
                    onSuperAdminSearchQueryChange={setSuperAdminSearchQuery}
                    onSuperAdminUserIdChange={setSuperAdminUserId}
                    onUpdateMemberRole={fireAndForget(updateGroupMemberRole)}
                  />
                ) : showingSetupGuide ? (
                  <SetupGuidePanel
                    loading={setupStatusLoading}
                    setupStatus={setupStatus}
                    setupError={setupStatusError}
                    showOpenSidebar={!sidebarOpen}
                    openSidebarLabel={
                      sidebarPanel === 'groups' && canViewGroups
                        ? 'Open access'
                        : sidebarPanel === 'automations' && canViewAutomations
                          ? 'Open automations'
                          : sidebarPanel === 'environments' && canViewEnvironments
                            ? 'Open environments'
                            : 'Open sessions'
                    }
                    onOpenSidebar={expandSidebar}
                    onRefresh={fireAndForget(refreshSetupStatus)}
                    onStartNewThread={startNewThread}
                    canStartNewThread={canCreateThread}
                  />
                ) : sidebarPanel === 'automations' && canViewAutomations ? (
                  <AutomationsPanel
                    automation={selectedAutomation}
                    automationsLoaded={automationsLoaded}
                    automationsLoading={automationsLoading}
                    canCallApi={canViewAutomations}
                    canCreateAutomations={canCreateAutomations}
                    groups={groups}
                    token={token}
                    environmentOptions={activeEnvironmentOptions}
                    environmentOptionsLoading={environmentsLoading}
                    environmentOptionsError={environmentsError}
                    repositoryOptions={repositoryOptions}
                    repositoryOptionsLoading={repositoryOptionsLoading}
                    repositoryOptionsError={repositoryOptionsError}
                    modelChoices={modelChoices}
                    selectedAutomationId={selectedAutomationId}
                    showOpenSidebar={!sidebarOpen}
                    openSidebarLabel="Open automations"
                    onAutomationChanged={handleAutomationChanged}
                    onArchiveAutomation={fireAndForget(handleArchiveAutomation)}
                    onAutomationSaved={handleAutomationSaved}
                    onOpenSidebar={expandSidebar}
                    onSessionCreated={handleAutomationSessionCreated}
                    onSelectSession={selectSession}
                    onUnarchiveAutomation={fireAndForget(handleUnarchiveAutomation)}
                    onError={handleApiError}
                  />
                ) : sidebarPanel === 'environments' && canViewEnvironments ? (
                  <EnvironmentsPanel
                    environments={environments}
                    environmentsLoading={environmentsLoading}
                    environmentsError={environmentsError}
                    selectedEnvironmentId={selectedEnvironmentId}
                    canCallApi={canViewEnvironments}
                    groups={groups}
                    token={token}
                    repositoryOptions={repositoryOptions}
                    repositoryOptionsLoading={repositoryOptionsLoading}
                    repositoryOptionsError={repositoryOptionsError}
                    showOpenSidebar={!sidebarOpen}
                    openSidebarLabel="Open environments"
                    onCreateEnvironment={startNewEnvironment}
                    onEnvironmentChanged={handleEnvironmentSaved}
                    onOpenSidebar={expandSidebar}
                    onError={handleApiError}
                  />
                ) : isCreatingThread || !selectedSession ? (
                  <NewThreadPanel
                    canCallApi={canCreateThread}
                    readOnly={!canCreateThread}
                    groupId={newThreadGroupId}
                    groups={creatableGroups}
                    loading={loading}
                    prompt={newThreadPrompt}
                    environmentId={newThreadEnvironmentId}
                    environmentBranchOverrides={newThreadEnvironmentBranchOverrides}
                    environmentOptions={newThreadEnvironmentOptions}
                    environmentOptionsLoading={environmentsLoading}
                    environmentOptionsError={environmentsError}
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
                    openSidebarLabel={
                      sidebarPanel === 'groups' && canViewGroups
                        ? 'Open access'
                        : sidebarPanel === 'automations' && canViewAutomations
                          ? 'Open automations'
                          : sidebarPanel === 'environments' && canViewEnvironments
                            ? 'Open environments'
                            : 'Open sessions'
                    }
                    onOpenSidebar={expandSidebar}
                    onGroupChange={handleNewThreadGroupChange}
                    onPromptChange={setNewThreadPrompt}
                    onCodebaseChange={handleNewThreadCodebaseChange}
                    onEnvironmentBranchOverridesChange={setNewThreadEnvironmentBranchOverrides}
                    onEnvironmentRepositoryBranchesLoad={loadEnvironmentRepositoryBranches}
                    onBranchChange={setNewThreadBranch}
                    onModelChange={setNewThreadModel}
                    onSubmit={fireAndForget(handleCreateThread)}
                  />
                ) : (
                  <section className="flex h-full min-h-0 flex-col">
                    <ThreadHeader
                      selectedSession={selectedSession}
                      canWriteSession={canWriteSelectedSession}
                      showOpenSidebar={!sidebarOpen}
                      openSidebarLabel={
                        sidebarPanel === 'groups' && canViewGroups
                          ? 'Open access'
                          : sidebarPanel === 'automations' && canViewAutomations
                            ? 'Open automations'
                            : sidebarPanel === 'environments' && canViewEnvironments
                              ? 'Open environments'
                              : 'Open sessions'
                      }
                      onArchive={fireAndForget(handleArchiveSession)}
                      onSessionStarChange={fireAndForget(handleSetSessionStarred)}
                      onOpenSidebar={expandSidebar}
                      onUpdateTags={handleUpdateSessionTags}
                      onUpdateTitle={handleUpdateTitle}
                      sessionTagOptions={sessionTagOptions}
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
                                  lineage={selectedSessionLineage}
                                  environment={selectedSessionEnvironment}
                                  repository={selectedRepository}
                                  branch={selectedSessionBranch || null}
                                  artifacts={artifacts}
                                  services={services}
                                  externalResources={externalResources}
                                  callbacks={callbacks}
                                  canWriteSession={canWriteSelectedSession}
                                  onExtendSandbox={fireAndForget(handleExtendSandbox)}
                                  onReplayCallback={fireAndForget(handleReplayCallback)}
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
                                  onCancelEdit={() => void finishEditingMessage(true)}
                                  onCancelQueuedMessage={fireAndForget(cancelQueuedMessage)}
                                  onCancelRun={fireAndForget(cancelRun)}
                                  onEditMessage={fireAndForget(startEditingMessage)}
                                  onMessageDraftChange={setMessageDraft}
                                  onRetryFailedMessages={fireAndForget(retryFailedMessages)}
                                  onSaveEdit={fireAndForget(saveMessageEdit)}
                                  onExtendSandbox={fireAndForget(handleExtendSandbox)}
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
                        {selectedSessionArchived ? (
                          <ArchivedSessionNotice onRestore={fireAndForget(restoreSelectedSession)} />
                        ) : null}
                        {selectedSessionDetailLoading ? null : (
                          <MessageComposer
                            key={selectedSession.id}
                            archived={selectedSessionArchived}
                            readOnly={!canWriteSelectedSession}
                            environmentId={followUpEnvironmentId}
                            environmentBranchOverrides={followUpEnvironmentBranchOverrides}
                            environmentOptions={followUpEnvironmentOptions}
                            environmentOptionsLoading={environmentsLoading}
                            environmentOptionsError={environmentsError}
                            repository={followUpRepository}
                            inheritedEnvironment={selectedSessionEnvironment}
                            inheritedCodebaseLabel={selectedSessionCodebaseLabel}
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
                            onCodebaseChange={handleFollowUpCodebaseChange}
                            onEnvironmentBranchOverridesChange={setFollowUpEnvironmentBranchOverrides}
                            onEnvironmentRepositoryBranchesLoad={loadEnvironmentRepositoryBranches}
                            onBranchChange={setFollowUpBranch}
                            onModelChange={setFollowUpModel}
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
                          lineage={selectedSessionLineage}
                          environment={selectedSessionEnvironment}
                          repository={selectedRepository}
                          branch={selectedSessionBranch || null}
                          artifacts={artifacts}
                          services={services}
                          externalResources={externalResources}
                          callbacks={callbacks}
                          canWriteSession={canWriteSelectedSession}
                          onExtendSandbox={fireAndForget(handleExtendSandbox)}
                          onReplayCallback={fireAndForget(handleReplayCallback)}
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

function fireAndForget<Args extends unknown[]>(handler: (...args: Args) => Promise<unknown>): (...args: Args) => void {
  return (...args) => {
    void handler(...args);
  };
}

function mergeSessionsById(current: Session[], incoming: Session[]): Session[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map((session) => [session.id, session]));
  for (const session of incoming) byId.set(session.id, session);
  const incomingIds = new Set(incoming.map((session) => session.id));
  return [
    ...incoming,
    ...current.filter((session) => !incomingIds.has(session.id)).map((session) => byId.get(session.id) ?? session),
  ];
}

function mergeSessionSearchResultsById(
  current: SessionSearchResult[],
  incoming: SessionSearchResult[],
): SessionSearchResult[] {
  if (!incoming.length) return current;
  const incomingIds = new Set(incoming.map((result) => result.session.id));
  return [...current.filter((result) => !incomingIds.has(result.session.id)), ...incoming];
}

function updateSearchResultSession(current: SessionSearchResult[], session: Session): SessionSearchResult[] {
  let changed = false;
  const next = current.map((result) => {
    if (result.session.id !== session.id) return result;
    changed = true;
    return { ...result, session };
  });
  return changed ? next : current;
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
  setResourceSearchParam('session', sessionId);
}

function setGroupSearchParam(groupId: string) {
  setResourceSearchParam('group', groupId);
}

function setAutomationSearchParam(automationId: string) {
  setResourceSearchParam('automation', automationId);
}

function setEnvironmentSearchParam(environmentId: string) {
  setResourceSearchParam('environment', environmentId);
}

function setResourceSearchParam(param: 'session' | 'group' | 'automation' | 'environment', value: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete('session');
  url.searchParams.delete('group');
  url.searchParams.delete('automation');
  url.searchParams.delete('environment');
  url.searchParams.set(param, value);
  window.history.replaceState({}, '', url);
}

function clearSessionSearchParam() {
  clearResourceSearchParams();
}

function clearResourceSearchParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete('session');
  url.searchParams.delete('group');
  url.searchParams.delete('automation');
  url.searchParams.delete('environment');
  window.history.replaceState({}, '', url);
}

function environmentAvailableToGroup(environment: Environment, groupId: string): boolean {
  if (!groupId || environment.archivedAt) return false;
  return (
    environment.ownerGroupId === groupId ||
    environment.shareMode === 'all_groups' ||
    environment.sharedGroupIds.includes(groupId)
  );
}

function environmentBranchOverrideInputs(
  environment: EnvironmentBranchOverrideTarget | null,
  overrides: EnvironmentBranchOverrides,
): EnvironmentBranchOverrideInput[] {
  if (!environment) return [];
  return environment.repositories.flatMap((repository) => {
    const branch = overrides[environmentRepositoryKey(repository)]?.trim();
    if (!branch) return [];
    return [
      {
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo,
        branch,
      },
    ];
  });
}

function sessionContextEnvironment(value: unknown): (ContextEnvironment & EnvironmentBranchOverrideTarget) | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : '';
  const name = typeof value.name === 'string' ? value.name : '';
  const codebase = isRecord(value.codebase) ? value.codebase : null;
  const rawRepositories = Array.isArray(codebase?.repositories) ? codebase.repositories : [];
  const repositories = rawRepositories.flatMap((rawRepository, index): EnvironmentBranchOverrideRepository[] => {
    if (!isRecord(rawRepository)) return [];
    if (rawRepository.provider !== 'github') return [];
    const owner = typeof rawRepository.owner === 'string' ? rawRepository.owner : '';
    const repo = typeof rawRepository.repo === 'string' ? rawRepository.repo : '';
    if (!owner || !repo) return [];
    return [
      {
        provider: 'github',
        owner,
        repo,
        primary: rawRepository.primary === true,
        position: typeof rawRepository.position === 'number' ? rawRepository.position : index,
        ...(typeof rawRepository.branch === 'string' && rawRepository.branch ? { branch: rawRepository.branch } : {}),
      },
    ];
  });

  if (!id || !name || repositories.length === 0) return null;
  return { id, name, repositories };
}

function mergeDisplaySessionContext(
  sessionContext: Record<string, unknown> | undefined,
  messageContext: Record<string, unknown> | undefined,
  codebaseKind?: 'environment' | 'repository',
): Record<string, unknown> | undefined {
  if (!messageContext) return sessionContext;
  const nextContext = { ...(sessionContext ?? {}) };
  for (const key of ['repository', 'model', 'branch', 'environment']) {
    if (Object.prototype.hasOwnProperty.call(messageContext, key)) nextContext[key] = messageContext[key];
  }
  if (codebaseKind === 'environment') {
    delete nextContext.repository;
    delete nextContext.branch;
  } else if (codebaseKind === 'repository') {
    delete nextContext.environment;
  }
  return nextContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasResourceSearchParam(): boolean {
  const searchParams = new URLSearchParams(window.location.search);
  return (
    searchParams.has('session') ||
    searchParams.has('group') ||
    searchParams.has('automation') ||
    searchParams.has('environment')
  );
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
