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
  archiveEnvironment,
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
  unarchiveEnvironment,
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
  type ReasoningLevel,
  type RepositoryOption,
  type SessionSearchResult,
  type SessionTagSummary,
  type SetupStatus,
  type WorkspaceToolId,
} from './api.js';
import { useAccessGroupsAdmin } from './access-groups-admin.js';
import { useAutomationsAdmin } from './automations-admin.js';
import { useSkillsWorkspace } from './skills-workspace.js';
import { resolveSidebarNavigation, type SidebarPanel } from './app-navigation.js';
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
import { reasoningLevelFromContext } from './components/app-panels/reasoning-level.js';
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
  loadInitialSelectedEnvironmentRevisionId,
  loadInitialSelectedSkillId,
  loadInitialSelectedSkillRevisionId,
  loadInitialSetupGuideOpen,
  loadInitialSelectedSessionId,
  loadStoredToken,
  loadThemePreference,
  newSessionSelectedStorageKey,
  realtimeReconnectInitialDelayMs,
  realtimeReconnectMaxDelayMs,
  selectedAutomationStorageKey,
  selectedEnvironmentStorageKey,
  selectedSkillStorageKey,
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
  SkillsPanel,
  SkillsSidebar,
  GroupsPanel,
  GroupsSidebar,
  StartupLoadingPanel,
  ThreadHeader,
  ThreadSidebar,
  type SidebarFooterProps,
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
  selectedEnvironmentRevisionId: string;
  selectedSkillId: string;
  selectedSkillRevisionId: string;
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
    selectedEnvironmentRevisionId: loadInitialSelectedEnvironmentRevisionId(),
    selectedSkillId: loadInitialSelectedSkillId(),
    selectedSkillRevisionId: loadInitialSelectedSkillRevisionId(),
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
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const environmentEditorDirtyRef = useRef(false);
  function setEnvironmentEditorDirty(dirty: boolean) {
    environmentEditorDirtyRef.current = dirty;
  }
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
  const [newThreadReasoningLevel, setNewThreadReasoningLevel] = useState<ReasoningLevel | ''>('');
  const [newThreadEnvironmentId, setNewThreadEnvironmentId] = useState('');
  const [newThreadEnvironmentBranchOverrides, setNewThreadEnvironmentBranchOverrides] =
    useState<EnvironmentBranchOverrides>({});
  const [newThreadBranch, setNewThreadBranch] = useState('');
  const [newThreadPrompt, setNewThreadPrompt] = useState('');
  const [newThreadRepository, setNewThreadRepository] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultReasoningLevel, setDefaultReasoningLevel] = useState<ReasoningLevel | ''>('');
  const [followUpEnvironmentId, setFollowUpEnvironmentId] = useState('');
  const [followUpEnvironmentBranchOverrides, setFollowUpEnvironmentBranchOverrides] =
    useState<EnvironmentBranchOverrides>({});
  const [followUpRepository, setFollowUpRepository] = useState('');
  const [followUpBranch, setFollowUpBranch] = useState('');
  const [followUpModel, setFollowUpModel] = useState('');
  const [followUpReasoningLevel, setFollowUpReasoningLevel] = useState<ReasoningLevel | ''>('');
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
  const [childSessionCursors, setChildSessionCursors] = useState(new Map<string, string | null>());
  const [childSessionsLoading, setChildSessionsLoading] = useState(new Set<string>());
  const [archivedSessionsNextCursor, setArchivedSessionsNextCursor] = useState<string | null>(null);
  const [archivedSessionsLoaded, setArchivedSessionsLoaded] = useState(false);
  const [archivedSessionsLoading, setArchivedSessionsLoading] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [sessionSearchResults, setSessionSearchResults] = useState<SessionSearchResult[]>([]);
  const [sessionSearchNextCursor, setSessionSearchNextCursor] = useState<string | null>(null);
  const [sessionSearchLoading, setSessionSearchLoading] = useState(false);
  const [sessionSearchLoadingMore, setSessionSearchLoadingMore] = useState(false);
  const [sessionSearchRefreshVersion, setSessionSearchRefreshVersion] = useState(0);
  const [revealedSessionLineage, setRevealedSessionLineage] = useState<Session[]>([]);
  const [revealedSessionLineageSearchQuery, setRevealedSessionLineageSearchQuery] = useState('');
  const [supplementalSelectedSession, setSupplementalSelectedSession] = useState<Session | null>(null);
  const [selectedSessionParent, setSelectedSessionParent] = useState<Session | null>(null);
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
    selectedEnvironmentRevisionId,
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
  const sessionSelectionVersionRef = useRef(0);
  const detailLoadedSessionIdRef = useRef(detailLoadedSessionId);
  const pendingCreatedSessionIdRef = useRef('');
  const sessionsRef = useRef(sessions);
  const sessionsNextCursorRef = useRef(sessionsNextCursor);
  const sessionFiltersRef = useRef(sessionFilters);
  const sessionSearchQueryRef = useRef(sessionSearchQuery);
  const sessionSearchNextCursorRef = useRef(sessionSearchNextCursor);
  const messagesRef = useRef(messages);
  const archivedSessionsOpenRef = useRef(archivedSessionsOpen);
  archivedSessionsOpenRef.current = archivedSessionsOpen;
  const createSessionInFlightRef = useRef(false);
  const sendMessageInFlightRef = useRef(false);
  const sessionsRefreshTimerRef = useRef<number | null>(null);
  const sessionsRefreshInFlightRef = useRef(false);
  const sessionsRefreshQueuedRef = useRef(false);
  const sessionsRefreshRequestRef = useRef(0);
  const archivedSessionsRequestRef = useRef(0);
  const sessionSummaryRefreshInFlightRef = useRef(new Set<string>());
  const sessionSummaryRefreshQueuedRef = useRef(new Set<string>());
  const sessionStatusMutationPendingRef = useRef(new Map<string, number>());
  const canonicalSessionMutationPendingRef = useRef(new Map<string, number>());
  const sessionSummaryAuthorityEpochRef = useRef(0);
  const sessionSearchRequestRef = useRef(0);
  const lineageRevealRequestRef = useRef(0);
  const childSessionRequestEpochRef = useRef(0);
  const selectedSessionParentRequestRef = useRef({ key: '', requestId: 0 });
  const selectedSessionParentRef = useRef(selectedSessionParent);
  selectedSessionParentRef.current = selectedSessionParent;
  const supplementalSelectedSessionRef = useRef(supplementalSelectedSession);
  supplementalSelectedSessionRef.current = supplementalSelectedSession;
  const sessionMutationVersionRef = useRef(new Map<string, number>());
  const sessionSummaryMutationVersionRef = useRef(new Map<string, number>());
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
  const skillCreatableGroups = sessionAuthRequired
    ? activeGroups.filter(
        (group) =>
          currentUser?.role === 'super_admin' || group.membershipRole === 'member' || group.membershipRole === 'admin',
      )
    : activeGroups;
  const newThreadEffectiveGroupId = newThreadGroupId || creatableGroups[0]?.id || '';
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
  const skillsWorkspace = useSkillsWorkspace({
    token,
    groups,
    canCallApi,
    canCreateThread,
    newThreadOwnerGroupId: newThreadEffectiveGroupId,
    selectedSessionId,
    navigation,
    setNavigation: setWorkspaceNavigation,
    setSidebarOpen,
    setSidebarCollapsed,
    onError: handleApiError,
    canNavigate: (next) => {
      const leavingDirtyEnvironment =
        navigation.sidebarPanel === 'environments' &&
        (next.sidebarPanel !== 'environments' ||
          next.selectedEnvironmentId !== navigation.selectedEnvironmentId ||
          next.selectedEnvironmentRevisionId !== navigation.selectedEnvironmentRevisionId);
      if (leavingDirtyEnvironment && environmentEditorDirtyRef.current) {
        if (!window.confirm('Discard unsaved environment changes?')) return false;
        setEnvironmentEditorDirty(false);
      }
      return true;
    },
  });
  const canViewSkills = skillsWorkspace.model.canView;
  const canManageGroups = canManageAllGroups || (canCallApi && manageableGroups.length > 0);
  const canViewGroups = canManageGroups || (canCallApi && sessionAuthRequired && groups.length > 0);
  const canViewEnvironments =
    canCallApi &&
    (!sessionAuthRequired ||
      currentUser?.role === 'super_admin' ||
      groups.some((group) => !group.archivedAt && Boolean(group.membershipRole)));
  const canCreateEnvironments = canCallApi && groups.some((group) => !group.archivedAt && group.canManage);
  const canonicalRevealedSessionLineage = useMemo(
    () =>
      revealedSessionLineage.map(
        (revealedSession) => sessions.find((session) => session.id === revealedSession.id) ?? revealedSession,
      ),
    [revealedSessionLineage, sessions],
  );
  const selectedSession = useMemo(
    () =>
      sessions.find((session) => session.id === selectedSessionId) ??
      canonicalRevealedSessionLineage.find((session) => session.id === selectedSessionId) ??
      (supplementalSelectedSession?.id === selectedSessionId ? supplementalSelectedSession : null) ??
      null,
    [sessions, canonicalRevealedSessionLineage, supplementalSelectedSession, selectedSessionId],
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
  const selectedSessionReasoningLevel = reasoningLevelFromContext(selectedSession?.context?.reasoningLevel);
  const selectedFollowUpReasoningLevel = followUpReasoningLevel || selectedSessionReasoningLevel;
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
  const sidebarSessions = useMemo(
    () =>
      canonicalRevealedSessionLineage.length
        ? mergeSessionsById(canonicalRevealedSessionLineage, displayedSessions)
        : displayedSessions,
    [displayedSessions, canonicalRevealedSessionLineage],
  );
  const activeSessionFilterCount = sessionFilterCount(sessionFilters);
  const selectedSessionLineage: SessionLineage | undefined = selectedSession
    ? {
        current: selectedSession,
        parent: selectedSession.parentSessionId
          ? (sidebarSessions.find((session) => session.id === selectedSession.parentSessionId) ??
            (selectedSessionParent?.id === selectedSession.parentSessionId ? selectedSessionParent : undefined))
          : undefined,
        children: sidebarSessions.filter((session) => session.parentSessionId === selectedSession.id),
        onSelectSession: selectSessionFromSidebar,
      }
    : undefined;

  function updateNavigation(next: Partial<NavigationState>) {
    if (navigationLeavesSessions(next)) exitSessionLineageReveal();
    setNavigation((current) => ({ ...current, ...next }));
  }

  function setWorkspaceNavigation(update: (current: NavigationState) => NavigationState) {
    const next = update(navigationRef.current);
    if (navigationLeavesSessions(next)) exitSessionLineageReveal();
    setNavigation(update);
  }

  function navigationLeavesSessions(next: Partial<NavigationState>) {
    return (
      next.setupGuideOpen === true ||
      next.groupsPanelOpen === true ||
      (next.sidebarPanel && next.sidebarPanel !== 'sessions')
    );
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

  function exitSessionLineageReveal(options: { clearFilters?: boolean; restoreSearch?: boolean } = {}) {
    const searchQuery = options.restoreSearch ? revealedSessionLineageSearchQuery : '';
    lineageRevealRequestRef.current += 1;
    setRevealedSessionLineage([]);
    setRevealedSessionLineageSearchQuery('');
    if (options.clearFilters) applySessionFilters(emptySessionFilters, { preserveLineage: true });
    if (options.restoreSearch) setSessionSearchQuery(searchQuery);
  }

  function invalidateChildSessionRequests() {
    childSessionRequestEpochRef.current += 1;
    setChildSessionCursors(new Map());
    setChildSessionsLoading(new Set());
  }

  function resetAuthBoundSessionState() {
    sessionSummaryAuthorityEpochRef.current += 1;
    sessionsRefreshRequestRef.current += 1;
    archivedSessionsRequestRef.current += 1;
    sessionSearchRequestRef.current += 1;
    lineageRevealRequestRef.current += 1;
    selectedSessionParentRequestRef.current = {
      key: '',
      requestId: selectedSessionParentRequestRef.current.requestId + 1,
    };
    selectedSessionParentRef.current = null;
    supplementalSelectedSessionRef.current = null;
    sessionsRef.current = [];
    for (const [key, version] of sessionMutationVersionRef.current) {
      sessionMutationVersionRef.current.set(key, version + 1);
    }
    sessionStatusMutationPendingRef.current.clear();
    canonicalSessionMutationPendingRef.current.clear();
    sessionSummaryRefreshQueuedRef.current.clear();
    invalidateChildSessionRequests();
    setSessions([]);
    setSessionSearchResults([]);
    setSessionsLoadingMore(false);
    setArchivedSessionsLoading(false);
    setSessionSearchLoading(false);
    setSessionSearchLoadingMore(false);
    setRevealedSessionLineage([]);
    setRevealedSessionLineageSearchQuery('');
    setSelectedSessionParent(null);
    setSupplementalSelectedSession(null);
    sessionMilestoneInteractionRef.current?.abort('selection_change');
    sessionMilestoneInteractionRef.current = null;
    detailLoadedSessionIdRef.current = '';
    detailRefreshInFlightRef.current = null;
    detailRefreshQueuedSessionIdRef.current = null;
    setDetailLoadedSessionId('');
    clearSessionDetail();
  }

  function applySessionFilters(filters: SessionFilters, options: { preserveLineage?: boolean } = {}) {
    if (!options.preserveLineage) exitSessionLineageReveal();
    sessionFiltersRef.current = filters;
    sessionStorage.setItem(sessionFiltersStorageKey, JSON.stringify(filters));
    sessionsRefreshRequestRef.current += 1;
    archivedSessionsRequestRef.current += 1;
    sessionSearchRequestRef.current += 1;
    invalidateChildSessionRequests();
    setSessionsLoadingMore(false);
    setArchivedSessionsLoading(false);
    setSessionSearchLoading(false);
    setSessionSearchLoadingMore(false);
    setSessionFilters(filters);
  }

  function handleSessionSearchChange(query: string) {
    exitSessionLineageReveal();
    setSessionSearchQuery(query);
  }

  async function showSessionInTree(session: Session) {
    const requestId = lineageRevealRequestRef.current + 1;
    lineageRevealRequestRef.current = requestId;
    const lineage = [session];
    const visited = new Set([session.id]);
    let current = session;

    try {
      while (current.parentSessionId && !visited.has(current.parentSessionId)) {
        visited.add(current.parentSessionId);
        const cached = [...sessionsRef.current, ...lineage].find(
          (candidate) => candidate.id === current.parentSessionId,
        );
        const parent = cached ?? (await getSession({ sessionId: current.parentSessionId, token }));
        if (lineageRevealRequestRef.current !== requestId) return;
        lineage.push(parent);
        current = parent;
      }
      if (lineageRevealRequestRef.current !== requestId) return;
      setRevealedSessionLineage(lineage);
      setRevealedSessionLineageSearchQuery(sessionSearchQuery);
      setSessionSearchQuery('');
      selectSession(session.id, { keepSidebarOpen: true });
    } catch (err) {
      if (lineageRevealRequestRef.current === requestId) handleApiError(err);
    }
  }

  function sessionMutationKey(sessionId: string, kind: 'star' | 'status' | 'tags'): string {
    return `${sessionId}:${kind}`;
  }

  function nextSessionMutationVersion(sessionId: string, kind: 'star' | 'status' | 'tags'): number {
    const key = sessionMutationKey(sessionId, kind);
    const next = (sessionMutationVersionRef.current.get(key) ?? 0) + 1;
    sessionMutationVersionRef.current.set(key, next);
    return next;
  }

  function isCurrentSessionMutation(sessionId: string, kind: 'star' | 'status' | 'tags', version: number): boolean {
    return sessionMutationVersionRef.current.get(sessionMutationKey(sessionId, kind)) === version;
  }

  function beginSessionStatusMutation(sessionId: string, version: number) {
    sessionStatusMutationPendingRef.current.set(sessionId, version);
    beginCanonicalSessionMutation(sessionId, 'status', version);
  }

  function finishSessionStatusMutation(sessionId: string, version: number) {
    if (sessionStatusMutationPendingRef.current.get(sessionId) !== version) return;
    sessionStatusMutationPendingRef.current.delete(sessionId);
    finishCanonicalSessionMutation(sessionId, 'status', version);
    if (!sessionSummaryRefreshQueuedRef.current.delete(sessionId)) return;
    void refreshLoadedSessionSummary(sessionId);
  }

  function beginCanonicalSessionMutation(sessionId: string, kind: 'star' | 'status' | 'tags', version: number) {
    canonicalSessionMutationPendingRef.current.set(sessionMutationKey(sessionId, kind), version);
    sessionsRefreshRequestRef.current += 1;
    archivedSessionsRequestRef.current += 1;
    sessionSearchRequestRef.current += 1;
    invalidateChildSessionRequests();
    setSessionsLoadingMore(false);
    setArchivedSessionsLoading(false);
    setSessionSearchLoading(false);
    setSessionSearchLoadingMore(false);
  }

  function finishCanonicalSessionMutation(sessionId: string, kind: 'star' | 'status' | 'tags', version: number) {
    const key = sessionMutationKey(sessionId, kind);
    if (canonicalSessionMutationPendingRef.current.get(key) !== version) return;
    canonicalSessionMutationPendingRef.current.delete(key);
    if (canonicalSessionMutationPendingRef.current.size) return;
    scheduleSessionsRefresh(0);
    setSessionSearchRefreshVersion((current) => current + 1);
    if (archivedSessionsOpenRef.current) void loadArchivedSessions(true);
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
    resetAuthBoundSessionState();
  }, [canCallApi, token]);

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
      if (canonicalSessionMutationPendingRef.current.size) {
        setSessionSearchLoading(false);
        return;
      }
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
  }, [sessionSearchQuery, sessionSearchRefreshVersion, canCallApi, token, sessionFilters]);

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
        setDefaultReasoningLevel(models.defaultReasoningLevel ?? '');
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

  useEffect(() => {
    const parentSessionId = selectedSession?.parentSessionId;
    if (!parentSessionId) {
      selectedSessionParentRequestRef.current = {
        key: '',
        requestId: selectedSessionParentRequestRef.current.requestId + 1,
      };
      setSelectedSessionParent(null);
      return;
    }

    const loadedParent = [...sessions, ...canonicalRevealedSessionLineage].find(
      (session) => session.id === parentSessionId,
    );
    if (loadedParent) {
      selectedSessionParentRequestRef.current = {
        key: '',
        requestId: selectedSessionParentRequestRef.current.requestId + 1,
      };
      setSelectedSessionParent(loadedParent);
      return;
    }
    if (selectedSessionParentRef.current?.id === parentSessionId || !canCallApi) return;

    const key = `${selectedSession.id}:${parentSessionId}:${token}`;
    if (selectedSessionParentRequestRef.current.key === key) return;
    const requestId = selectedSessionParentRequestRef.current.requestId + 1;
    selectedSessionParentRequestRef.current = { key, requestId };
    setSelectedSessionParent(null);
    void getSession({ sessionId: parentSessionId, token })
      .then((parent) => {
        if (selectedSessionParentRequestRef.current.requestId !== requestId) return;
        if (selectedSessionIdRef.current !== selectedSession.id) return;
        selectedSessionParentRequestRef.current = { key: '', requestId };
        setSelectedSessionParent(parent);
      })
      .catch((err) => {
        if (selectedSessionParentRequestRef.current.requestId !== requestId) return;
        if (selectedSessionIdRef.current !== selectedSession.id) return;
        selectedSessionParentRequestRef.current = { key: '', requestId };
        if (!(err instanceof ApiError && (err.status === 403 || err.status === 404))) handleApiError(err);
      });
  }, [selectedSession, sessions, canonicalRevealedSessionLineage, canCallApi, token]);

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
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    let reconnectDelayMs = realtimeReconnectInitialDelayMs;

    const runStreamLoop = async () => {
      while (!abort.signal.aborted) {
        try {
          await streamGlobalEvents({
            after: globalEventCursor.current,
            token,
            signal: abort.signal,
            onEvent: (event) => {
              if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return;
              reconnectDelayMs = realtimeReconnectInitialDelayMs;
              if (typeof event.id === 'number')
                globalEventCursor.current = Math.max(globalEventCursor.current, event.id);

              const activeSessionId = selectedSessionIdRef.current;
              if (event.type === 'skills_loaded' && event.sessionId === activeSessionId) {
                skillsWorkspace.actions.invalidateSessionCatalog();
              }
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
          if (abort.signal.aborted || sessionSummaryAuthorityEpochRef.current !== authorityEpoch) break;
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
    if (canonicalSessionMutationPendingRef.current.size) {
      sessionsRefreshQueuedRef.current = true;
      return;
    }
    const requestId = sessionsRefreshRequestRef.current + 1;
    sessionsRefreshRequestRef.current = requestId;
    invalidateChildSessionRequests();
    if (sessionsRefreshInFlightRef.current) {
      sessionsRefreshQueuedRef.current = true;
      return;
    }

    sessionsRefreshInFlightRef.current = true;
    setLoading(true);
    setError('');
    const refreshStartCursor = sessionsNextCursorRef.current;
    const filters = sessionFiltersRef.current;
    const filtersActive = hasActiveSessionFilters(filters);
    const filterOptions = sessionFilterRequestOptions(filters);
    const summaryMutationVersionsAtStart = new Map(sessionSummaryMutationVersionRef.current);
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
      if (selectedSessionIdRef.current !== selectedId) return;
      if (sessionsRefreshRequestRef.current !== requestId) return;
      const cursorAdvancedDuringRefresh = sessionsNextCursorRef.current !== refreshStartCursor;
      const selectedSummaryChanged =
        selectedId &&
        sessionSummaryMutationVersionRef.current.get(selectedId) !== summaryMutationVersionsAtStart.get(selectedId);
      if (!selectedSummaryChanged) {
        setSupplementalSelectedSession(filtersActive && selected && !selectedRemoved ? selected : null);
      }
      invalidateChildSessionRequests();
      setSessions((current) => {
        const incoming = selected && !filtersActive ? [...page.sessions, selected] : page.sessions;
        const next = filtersActive
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
    if (inFlight.has(sessionId) || sessionStatusMutationPendingRef.current.has(sessionId)) {
      sessionSummaryRefreshQueuedRef.current.add(sessionId);
      return;
    }
    const mutationGeneration = sessionSummaryMutationVersionRef.current.get(sessionId) ?? 0;
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    inFlight.add(sessionId);
    try {
      const session = await getSession({ sessionId, token });
      if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return;
      if (
        sessionStatusMutationPendingRef.current.has(sessionId) ||
        (sessionSummaryMutationVersionRef.current.get(sessionId) ?? 0) !== mutationGeneration
      ) {
        sessionSummaryRefreshQueuedRef.current.add(sessionId);
        return;
      }
      setSessions((current) => mergeSessionsById(current, [session]));
    } catch (err) {
      if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return;
      if (
        sessionStatusMutationPendingRef.current.has(sessionId) ||
        (sessionSummaryMutationVersionRef.current.get(sessionId) ?? 0) !== mutationGeneration
      ) {
        sessionSummaryRefreshQueuedRef.current.add(sessionId);
        return;
      }
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setSessions((current) => current.filter((session) => session.id !== sessionId));
        if (selectedSessionIdRef.current === sessionId) setSelectedSessionId('');
      } else {
        handleApiError(err);
      }
    } finally {
      inFlight.delete(sessionId);
      if (
        sessionSummaryAuthorityEpochRef.current === authorityEpoch &&
        sessionSummaryRefreshQueuedRef.current.delete(sessionId) &&
        !sessionStatusMutationPendingRef.current.has(sessionId)
      ) {
        void refreshLoadedSessionSummary(sessionId);
      }
    }
  }

  async function loadMoreSessions() {
    if (!sessionsNextCursor || sessionsLoadingMore || !canCallApi || canonicalSessionMutationPendingRef.current.size)
      return;
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
      if (sessionsRefreshRequestRef.current !== requestId) return;
      handleApiError(err);
    } finally {
      if (sessionsRefreshRequestRef.current === requestId) setSessionsLoadingMore(false);
    }
  }

  async function loadChildSessions(parent: Session) {
    if (childSessionsLoading.has(parent.id) || !canCallApi) return;
    const requestEpoch = childSessionRequestEpochRef.current;
    const cursor = childSessionCursors.get(parent.id);
    const filters = sessionFiltersRef.current;
    setChildSessionsLoading((current) => new Set(current).add(parent.id));
    setError('');
    try {
      const page = await listSessions(token, {
        parentSessionId: parent.id,
        ...(cursor ? { cursor } : {}),
        limit: sessionListPageSize,
        archived: parent.status === 'archived',
        ...sessionFilterRequestOptions(filters),
      });
      if (childSessionRequestEpochRef.current !== requestEpoch) return;
      setSessions((current) => mergeSessionsById(current, page.sessions));
      if (sessionListHovered) {
        setSessionOrderIds((current) => [
          ...current,
          ...page.sessions.map((session) => session.id).filter((id) => !current.includes(id)),
        ]);
      }
      setChildSessionCursors((current) => new Map(current).set(parent.id, page.nextCursor));
    } catch (err) {
      if (childSessionRequestEpochRef.current !== requestEpoch) return;
      handleApiError(err);
    } finally {
      if (childSessionRequestEpochRef.current === requestEpoch) {
        setChildSessionsLoading((current) => {
          const next = new Set(current);
          next.delete(parent.id);
          return next;
        });
      }
    }
  }

  async function loadArchivedSessions(reset = false) {
    if (
      archivedSessionsLoading ||
      canonicalSessionMutationPendingRef.current.size ||
      (!reset && archivedSessionsLoaded && !archivedSessionsNextCursor)
    )
      return;
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
      if (archivedSessionsRequestRef.current !== requestId) return;
      handleApiError(err);
    } finally {
      if (archivedSessionsRequestRef.current === requestId) setArchivedSessionsLoading(false);
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
    if (!query || !cursor || sessionSearchLoadingMore || !canCallApi || canonicalSessionMutationPendingRef.current.size)
      return;
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
      if (sessionSearchRequestRef.current !== requestId) return;
      handleApiError(err);
    } finally {
      if (sessionSearchRequestRef.current === requestId) setSessionSearchLoadingMore(false);
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
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    try {
      const loaded = await loadSessionDetailPhases({ sessionId, token, ...(signal ? { signal } : {}) }).allReady;
      if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return null;
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
      if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return null;
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
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    const requestIsCurrent = () =>
      sessionSummaryAuthorityEpochRef.current === authorityEpoch && selectedSessionIdRef.current === sessionId;
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
        if (!requestIsCurrent()) {
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
        if (!requestIsCurrent()) return;
        milestones.detail.error(componentName(err, 'render'));
        handleApiError(componentCause(err));
        return null;
      });

    const outputsPromise = phases.outputsReady
      .then(async (outputs) => {
        const detail = await detailReadyPromise;
        if (!detail) {
          if (requestIsCurrent()) milestones.outputs.error('render');
          return;
        }
        if (!requestIsCurrent()) {
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
        if (!requestIsCurrent()) return;
        milestones.outputs.error(componentName(err, 'render'));
        handleApiError(componentCause(err));
      });

    const servicesLoadPromise = phases.servicesReady
      .then(async (nextServices) => {
        if (!(await detailReadyPromise)) {
          if (requestIsCurrent()) milestones.services.error('render');
          return;
        }
        if (!requestIsCurrent()) {
          milestones.services.abort('selection_change');
          return;
        }
        setSessionDetail((current) => ({ ...current, services: nextServices }));
        milestones.services.success({ serviceCount: nextServices.length });
      })
      .catch((err) => {
        if (!requestIsCurrent()) return;
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

    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    detailRefreshInFlightRef.current = sessionId;
    try {
      const [nextMessages, nextArtifacts, nextServices, nextExternalResources, nextCallbacks] = await Promise.all([
        listMessages(sessionId, token),
        listArtifacts(sessionId, token),
        listServices(sessionId, token),
        listExternalResources(sessionId, token),
        listCallbacks(sessionId, token),
      ]);
      if (sessionSummaryAuthorityEpochRef.current === authorityEpoch && selectedSessionIdRef.current === sessionId) {
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
      if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return;
      detailRefreshInFlightRef.current = null;
      const queuedSessionId = detailRefreshQueuedSessionIdRef.current;
      detailRefreshQueuedSessionIdRef.current = null;
      if (queuedSessionId && queuedSessionId === selectedSessionIdRef.current) {
        refreshSessionOutputs(queuedSessionId).catch(() => undefined);
      }
    }
  }

  async function handleCreateThread(input: {
    prompt: string;
    skills: string[];
    skillRefs: Array<{ id: string; name: string }>;
  }): Promise<boolean> {
    const firstPrompt = input.prompt.trim();
    if (createSessionInFlightRef.current || !canCreateThread || (!firstPrompt && !input.skills.length)) return false;
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
    skillsWorkspace.actions.setNewThreadError('');
    const previousSelectedSessionId = selectedSessionIdRef.current;
    let enqueueCleanupError: unknown;
    try {
      const session = await createSession({
        title: titleFromPrompt(firstPrompt || input.skills.join(', ')),
        token,
        ownerGroupId: newThreadGroupId,
      });
      // Mark the new session as the active realtime target before enqueueing the
      // first message. Fast deployments can emit completion events before React
      // commits the selected-session state below; the pending ref lets the SSE
      // handler accept only this new session without treating full detail as loaded.
      sessionSelectionVersionRef.current += 1;
      selectedSessionIdRef.current = session.id;
      pendingCreatedSessionIdRef.current = session.id;
      eventCursor.current = 0;
      let message: Message;
      try {
        message = await enqueueMessage({
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
          ...(newThreadReasoningLevel ? { reasoningLevel: newThreadReasoningLevel } : {}),
          ...(!firstEnvironmentId && firstBranch ? { branch: firstBranch } : {}),
          ...(input.skills.length ? { skills: input.skills, skillRefs: input.skillRefs } : {}),
        });
      } catch (err) {
        if (userCanWriteSession(session)) {
          try {
            await archiveSession({ sessionId: session.id, token });
          } catch (cleanupError) {
            enqueueCleanupError = cleanupError;
          }
        }
        throw err;
      }
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
      return true;
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
      if (err instanceof ApiError && err.code === 'unknown_skill' && input.skills.length)
        skillsWorkspace.actions.setNewThreadError(errorMessage(err));
      else if (enqueueCleanupError) {
        if (err instanceof ApiError && err.status === 401) signOut();
        if (enqueueCleanupError instanceof ApiError && enqueueCleanupError.status === 401) signOut();
        setError(
          `${errorMessage(err)} The empty session also could not be archived: ${errorMessage(enqueueCleanupError)}`,
        );
      } else handleApiError(err);
      return false;
    } finally {
      setLoading(false);
      createSessionInFlightRef.current = false;
    }
  }

  async function handleSendMessage(input: {
    prompt: string;
    skills: string[];
    skillRefs: Array<{ id: string; name: string }>;
  }): Promise<boolean> {
    const messagePrompt = input.prompt.trim();
    if (
      sendMessageInFlightRef.current ||
      !canWriteSelectedSession ||
      !selectedSessionId ||
      selectedSessionArchived ||
      (!messagePrompt && !input.skills.length)
    )
      return false;
    sendMessageInFlightRef.current = true;
    setError('');
    skillsWorkspace.actions.setSessionError('');
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
        ...(selectedFollowUpReasoningLevel ? { reasoningLevel: selectedFollowUpReasoningLevel } : {}),
        ...(!followUpEnvironmentId && followUpBranch ? { branch: followUpBranch } : {}),
        ...(input.skills.length ? { skills: input.skills, skillRefs: input.skillRefs } : {}),
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
      if (err instanceof ApiError && err.code === 'unknown_skill' && input.skills.length)
        skillsWorkspace.actions.setSessionError(errorMessage(err));
      else handleApiError(err);
      return false;
    } finally {
      sendMessageInFlightRef.current = false;
    }
  }

  function handleNewThreadGroupChange(value: string) {
    setNewThreadGroupId(value);
    skillsWorkspace.actions.setNewThreadError('');
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
    const sessionId = selectedSessionId;
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    const supplementalOnly = isSupplementalSession(sessionId);
    setError('');
    try {
      const session = await updateSession({ sessionId, title: nextTitle, token });
      if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return false;
      const current =
        sessionsRef.current.find((candidate) => candidate.id === sessionId) ??
        (supplementalSelectedSessionRef.current?.id === sessionId ? supplementalSelectedSessionRef.current : null);
      applySessionListUpdate({ ...(current ?? session), title: nextTitle }, { supplementalOnly });
      return true;
    } catch (err) {
      if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return false;
      handleApiError(err);
      return false;
    }
  }

  async function handleUpdateSessionTags(tags: string[]): Promise<boolean> {
    if (!selectedSessionId) return false;
    const mutationVersion = nextSessionMutationVersion(selectedSessionId, 'tags');
    beginCanonicalSessionMutation(selectedSessionId, 'tags', mutationVersion);
    const supplementalOnly = isSupplementalSession(selectedSessionId);
    const previous =
      sessionsRef.current.find((session) => session.id === selectedSessionId) ??
      (supplementalSelectedSessionRef.current?.id === selectedSessionId
        ? supplementalSelectedSessionRef.current
        : null);
    if (previous) {
      adjustLoadedParentDirectChildCount(previous, { ...previous, tags });
      applySessionListUpdate({ ...previous, tags }, { forceKeep: true, supplementalOnly });
    }
    setError('');
    try {
      const session = await updateSessionTags({ sessionId: selectedSessionId, tags, token });
      if (!isCurrentSessionMutation(selectedSessionId, 'tags', mutationVersion)) return true;
      const current =
        sessionsRef.current.find((candidate) => candidate.id === selectedSessionId) ??
        (supplementalSelectedSessionRef.current?.id === selectedSessionId
          ? supplementalSelectedSessionRef.current
          : null);
      if (previous) adjustLoadedParentDirectChildCount({ ...previous, tags }, { ...previous, tags: session.tags });
      applySessionListUpdate({ ...(current ?? session), tags: session.tags }, { supplementalOnly });
      listSessionTags(token)
        .then(setSessionTagOptions)
        .catch(() => undefined);
      return true;
    } catch (err) {
      if (!isCurrentSessionMutation(selectedSessionId, 'tags', mutationVersion)) return true;
      if (previous) {
        const current =
          sessionsRef.current.find((session) => session.id === selectedSessionId) ??
          (supplementalSelectedSessionRef.current?.id === selectedSessionId
            ? supplementalSelectedSessionRef.current
            : null);
        adjustLoadedParentDirectChildCount({ ...previous, tags }, previous);
        applySessionListUpdate(
          { ...(current ?? previous), tags: previous.tags ?? [] },
          { forceKeep: true, supplementalOnly },
        );
      }
      handleApiError(err);
      return false;
    } finally {
      finishCanonicalSessionMutation(selectedSessionId, 'tags', mutationVersion);
    }
  }

  async function handleSetSessionStarred(sessionId: string, starred: boolean) {
    const mutationVersion = nextSessionMutationVersion(sessionId, 'star');
    beginCanonicalSessionMutation(sessionId, 'star', mutationVersion);
    const supplementalOnly = isSupplementalSession(sessionId);
    const previous =
      sessionsRef.current.find((session) => session.id === sessionId) ??
      (supplementalSelectedSessionRef.current?.id === sessionId ? supplementalSelectedSessionRef.current : null);
    if (previous) {
      adjustLoadedParentDirectChildCount(previous, { ...previous, starred });
      applySessionListUpdate({ ...previous, starred }, { forceKeep: true, supplementalOnly });
    }
    setError('');
    try {
      const nextStarred = await setSessionStarred({ sessionId, starred, token });
      if (!isCurrentSessionMutation(sessionId, 'star', mutationVersion)) return;
      const current =
        sessionsRef.current.find((session) => session.id === sessionId) ??
        (supplementalSelectedSessionRef.current?.id === sessionId ? supplementalSelectedSessionRef.current : null);
      if (current) {
        if (previous) {
          adjustLoadedParentDirectChildCount({ ...previous, starred }, { ...previous, starred: nextStarred });
        }
        applySessionListUpdate({ ...current, starred: nextStarred }, { supplementalOnly });
      }
    } catch (err) {
      if (!isCurrentSessionMutation(sessionId, 'star', mutationVersion)) return;
      if (previous) {
        const current =
          sessionsRef.current.find((session) => session.id === sessionId) ??
          (supplementalSelectedSessionRef.current?.id === sessionId ? supplementalSelectedSessionRef.current : null);
        adjustLoadedParentDirectChildCount({ ...previous, starred }, previous);
        applySessionListUpdate(
          { ...(current ?? previous), starred: previous.starred === true },
          { forceKeep: true, supplementalOnly },
        );
      }
      handleApiError(err);
    } finally {
      finishCanonicalSessionMutation(sessionId, 'star', mutationVersion);
    }
  }

  async function handleArchiveSession() {
    if (!canWriteSelectedSession || !selectedSessionId) return;
    const sessionId = selectedSessionId;
    const mutationVersion = nextSessionMutationVersion(sessionId, 'status');
    beginSessionStatusMutation(sessionId, mutationVersion);
    const supplementalOnly = isSupplementalSession(sessionId);
    setError('');
    const rollback = archiveOptimistically(sessionId, supplementalOnly);
    try {
      const session = await archiveSession({ sessionId, token });
      if (!isCurrentSessionMutation(sessionId, 'status', mutationVersion)) return;
      applyArchivedSession(session, { supplementalOnly });
      void loadArchivedSessions(true);
    } catch (err) {
      if (!isCurrentSessionMutation(sessionId, 'status', mutationVersion)) return;
      if (rollback) restoreSessionStatusRollback(rollback);
      handleApiError(err);
    } finally {
      finishSessionStatusMutation(sessionId, mutationVersion);
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
    const editingMessage = messages.find((message) => message.id === editingMessageId);
    const hasSkills = Array.isArray(editingMessage?.context?.skills) && editingMessage.context.skills.length > 0;
    if (!canWriteSelectedSession || !selectedSessionId || !editingMessageId || (!messageDraft.trim() && !hasSkills))
      return;
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
    resetAuthBoundSessionState();
    localStorage.setItem(tokenStorageKey, nextToken);
    setToken(nextToken);
    setError('');
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const user = await login({ username: loginUsername.trim(), password: loginPassword });
      resetAuthBoundSessionState();
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
    resetAuthBoundSessionState();
    sessionSelectionVersionRef.current += 1;
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
    sessionStorage.removeItem(selectedSkillStorageKey);
    sessionStorage.removeItem(archivedAutomationsOpenStorageKey);
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    setSessions([]);
    setChildSessionCursors(new Map());
    setChildSessionsLoading(new Set());
    setSessionsNextCursor(null);
    setArchivedSessionsNextCursor(null);
    setArchivedSessionsLoaded(false);
    setSessionSearchQuery('');
    setSessionSearchResults([]);
    setSessionSearchNextCursor(null);
    exitSessionLineageReveal();
    resetAutomationsAdmin();
    skillsWorkspace.actions.reset();
    setGroups([]);
    setEnvironmentsState({ data: [], loading: false, error: '' });
    resetAccessGroupsAdmin();
    setSessionsLoaded(false);
    setDetailLoadedSessionId('');
    updateNavigation({
      selectedSessionId: '',
      selectedAutomationId: '',
      selectedEnvironmentId: '',
      selectedEnvironmentRevisionId: '',
      selectedSkillId: '',
      selectedSkillRevisionId: '',
      sidebarPanel: 'sessions',
      isCreatingThread: false,
      setupGuideOpen: false,
      groupsPanelOpen: false,
    });
    setNewThreadEnvironmentId('');
    setNewThreadEnvironmentBranchOverrides({});
    setFollowUpEnvironmentId('');
    setFollowUpEnvironmentBranchOverrides({});
    skillsWorkspace.actions.setNewThreadError('');
    skillsWorkspace.actions.setSessionError('');
    clearSessionDetail();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    setSetupStatus(null);
    setSetupStatusError('');
  }

  function startNewThread() {
    if (!canCreateThread) return;
    sessionSelectionVersionRef.current += 1;
    selectedSessionIdRef.current = '';
    exitSessionLineageReveal();
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
    setFollowUpReasoningLevel('');
    skillsWorkspace.actions.setNewThreadError('');
    skillsWorkspace.actions.setSessionError('');
    clearSessionDetail();
    eventCursor.current = 0;
  }

  function selectSession(sessionId: string, options: { keepSidebarOpen?: boolean } = {}) {
    if (selectedSessionIdRef.current !== sessionId) abortCreatedSessionBackfill();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    autoScrolledSessionId.current = '';
    if (selectedSessionIdRef.current !== sessionId) pendingSessionMilestoneTriggerRef.current = 'selection';
    sessionSelectionVersionRef.current += 1;
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
    setFollowUpReasoningLevel('');
    skillsWorkspace.actions.setSessionError('');
    if (!options.keepSidebarOpen) setSidebarOpen(false);
  }

  function selectSessionFromSidebar(sessionId: string) {
    const revealed = revealedSessionLineage.find((session) => session.id === sessionId);
    const supplementalSession =
      revealed ?? (selectedSessionParent?.id === sessionId ? selectedSessionParent : undefined);
    if (supplementalSession && !sessionsRef.current.some((session) => session.id === sessionId)) {
      setSupplementalSelectedSession(supplementalSession);
    } else if (!revealed) {
      setSupplementalSelectedSession(null);
      exitSessionLineageReveal();
    }
    selectSession(sessionId);
  }

  function openSetupGuide() {
    if (!confirmDiscardEditorChanges()) return;
    sessionStorage.setItem(setupGuideOpenStorageKey, 'true');
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    updateNavigation({ setupGuideOpen: true, groupsPanelOpen: false });
    setSidebarOpen(false);
  }

  function openGroupsPanel() {
    if (!canViewGroups) return;
    if (!confirmDiscardEditorChanges()) return;
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
    if (!confirmDiscardEditorChanges()) return;
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
    if (sidebarPanel !== 'environments' && !confirmDiscardEditorChanges()) return;
    const desktop = isDesktopViewport();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'environments');
    if (selectedEnvironmentId) {
      if (!skillsWorkspace.actions.navigateToEnvironment(selectedEnvironmentId, selectedEnvironmentRevisionId)) return;
    } else {
      clearResourceSearchParams();
      updateNavigation({
        setupGuideOpen: false,
        groupsPanelOpen: false,
        sidebarPanel: 'environments',
        isCreatingThread: false,
      });
    }
    setSidebarCollapsed(false);
    setSidebarOpen(!desktop);
  }

  function startNewEnvironment(): boolean {
    if (!canCreateEnvironments) return false;
    if (!confirmDiscardEditorChanges()) return false;
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
      selectedEnvironmentRevisionId: '',
    });
    if (!isDesktopViewport()) setSidebarOpen(false);
    return true;
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
    if (!skillsWorkspace.actions.navigateToEnvironment(environmentId)) return;
    sessionStorage.setItem(selectedEnvironmentStorageKey, environmentId);
    if (!isDesktopViewport()) setSidebarOpen(false);
  }

  function handleEnvironmentSaved(environment: Environment) {
    setEnvironmentEditorDirty(false);
    handleEnvironmentChanged(environment);
    sessionStorage.setItem(selectedEnvironmentStorageKey, environment.id);
    skillsWorkspace.actions.navigateToEnvironment(environment.id, '', true);
  }

  async function handleArchiveEnvironment(environmentId: string) {
    if (environmentId === selectedEnvironmentId && !confirmDiscardEditorChanges()) return;
    try {
      handleEnvironmentChanged(await archiveEnvironment({ environmentId, token }));
    } catch (error) {
      handleApiError(error);
    }
  }

  async function handleRestoreEnvironment(environmentId: string) {
    try {
      handleEnvironmentChanged(await unarchiveEnvironment({ environmentId, token }));
    } catch (error) {
      handleApiError(error);
    }
  }

  function handleAutomationSessionCreated(session: Session) {
    setSessions((current) => [session, ...current.filter((candidate) => candidate.id !== session.id)]);
    selectSession(session.id);
  }

  function showSessionsSidebar() {
    if (!confirmDiscardEditorChanges()) return;
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
    if (!confirmDiscardEditorChanges()) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'sessions');
    if (selectedSessionId) setSessionSearchParam(selectedSessionId);
    else clearResourceSearchParams();
    updateNavigation({ setupGuideOpen: false, groupsPanelOpen: false, sidebarPanel: 'sessions' });
    setSidebarCollapsed(false);
    setSidebarOpen(true);
  }

  function confirmDiscardEditorChanges(): boolean {
    if (sidebarPanel === 'skills' && !skillsWorkspace.actions.confirmDiscard()) return false;
    if (sidebarPanel === 'environments' && environmentEditorDirtyRef.current) {
      if (!window.confirm('Discard unsaved environment changes?')) return false;
      setEnvironmentEditorDirty(false);
    }
    return true;
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
    supplementalOnly: boolean;
    wasSelected: boolean;
    selectionVersion: number;
  };

  function archiveOptimistically(sessionId: string, supplementalOnly = false): SessionStatusRollback | null {
    const session =
      sessions.find((candidate) => candidate.id === sessionId) ??
      (supplementalSelectedSessionRef.current?.id === sessionId ? supplementalSelectedSessionRef.current : null);
    if (!session) return null;
    const rollback: SessionStatusRollback = {
      isCreatingThread,
      selectedSessionId,
      sessionDetail,
      session,
      supplementalOnly,
      wasSelected: selectedSessionIdRef.current === sessionId,
      selectionVersion: sessionSelectionVersionRef.current,
    };
    applyArchivedSession({ ...session, status: 'archived' }, { supplementalOnly });
    rollback.selectionVersion = sessionSelectionVersionRef.current;
    return rollback;
  }

  function restoreSessionStatusRollback(rollback: SessionStatusRollback) {
    const restoreSelection = rollback.wasSelected && sessionSelectionVersionRef.current === rollback.selectionVersion;
    const current =
      sessionsRef.current.find((session) => session.id === rollback.session.id) ??
      (supplementalSelectedSessionRef.current?.id === rollback.session.id
        ? supplementalSelectedSessionRef.current
        : null);
    const restoredSession = { ...(current ?? rollback.session), status: rollback.session.status };
    if (restoredSession.directChildCount === undefined && rollback.session.directChildCount !== undefined) {
      restoredSession.directChildCount = rollback.session.directChildCount;
    }
    if (restoreSelection && rollback.supplementalOnly) {
      supplementalSelectedSessionRef.current = restoredSession;
      setSupplementalSelectedSession(restoredSession);
    }
    applySessionStatusUpdate(restoredSession, {
      supplementalOnly: rollback.supplementalOnly,
      preserveDirectChildCount: true,
    });
    if (restoreSelection) {
      selectedSessionIdRef.current = rollback.selectedSessionId;
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

  function unarchiveOptimistically(sessionId: string, supplementalOnly = false): SessionStatusRollback | null {
    const session =
      sessions.find((candidate) => candidate.id === sessionId) ??
      (supplementalSelectedSessionRef.current?.id === sessionId ? supplementalSelectedSessionRef.current : null);
    if (!session) return null;
    const rollback = {
      isCreatingThread,
      selectedSessionId,
      sessionDetail,
      session,
      supplementalOnly,
      wasSelected: selectedSessionIdRef.current === sessionId,
      selectionVersion: sessionSelectionVersionRef.current,
    };
    applySessionStatusUpdate({ ...session, status: 'idle' }, { supplementalOnly });
    return rollback;
  }

  function applyArchivedSession(session: Session, options: { supplementalOnly?: boolean } = {}) {
    applySessionStatusUpdate(session, options);
    if (selectedSessionIdRef.current === session.id) {
      sessionSelectionVersionRef.current += 1;
      selectedSessionIdRef.current = '';
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
    const mutationVersion = nextSessionMutationVersion(sessionId, 'status');
    beginSessionStatusMutation(sessionId, mutationVersion);
    setError('');
    const rollback = archiveOptimistically(sessionId);
    try {
      const session = await archiveSession({ sessionId, token });
      if (!isCurrentSessionMutation(sessionId, 'status', mutationVersion)) return;
      applyArchivedSession(session);
      void loadArchivedSessions(true);
    } catch (err) {
      if (!isCurrentSessionMutation(sessionId, 'status', mutationVersion)) return;
      if (rollback) restoreSessionStatusRollback(rollback);
      handleApiError(err);
    } finally {
      finishSessionStatusMutation(sessionId, mutationVersion);
    }
  }

  async function unarchiveFromList(sessionId: string) {
    const sessionToUnarchive = sessions.find((candidate) => candidate.id === sessionId);
    if (!sessionToUnarchive || !userCanWriteSession(sessionToUnarchive)) return;
    const mutationVersion = nextSessionMutationVersion(sessionId, 'status');
    beginSessionStatusMutation(sessionId, mutationVersion);
    setError('');
    const rollback = unarchiveOptimistically(sessionId);
    try {
      const session = await unarchiveSession({ sessionId, token });
      if (!isCurrentSessionMutation(sessionId, 'status', mutationVersion)) return;
      applySessionStatusUpdate(session);
      void refreshSessions();
    } catch (err) {
      if (!isCurrentSessionMutation(sessionId, 'status', mutationVersion)) return;
      if (rollback) restoreSessionStatusRollback(rollback);
      handleApiError(err);
    } finally {
      finishSessionStatusMutation(sessionId, mutationVersion);
    }
  }

  async function restoreSelectedSession() {
    if (!canWriteSelectedSession || !selectedSessionId) return;
    const sessionId = selectedSessionId;
    const mutationVersion = nextSessionMutationVersion(sessionId, 'status');
    beginSessionStatusMutation(sessionId, mutationVersion);
    const supplementalOnly = isSupplementalSession(sessionId);
    setError('');
    const rollback = unarchiveOptimistically(sessionId, supplementalOnly);
    try {
      const session = await unarchiveSession({ sessionId, token });
      if (!isCurrentSessionMutation(sessionId, 'status', mutationVersion)) return;
      applySessionStatusUpdate(session, { supplementalOnly });
      void refreshSessions();
    } catch (err) {
      if (!isCurrentSessionMutation(sessionId, 'status', mutationVersion)) return;
      if (rollback) restoreSessionStatusRollback(rollback);
      handleApiError(err);
    } finally {
      finishSessionStatusMutation(sessionId, mutationVersion);
    }
  }

  function sessionMatchesVisibleFilters(session: Session): boolean {
    const filters = sessionFiltersRef.current;
    if (filters.tags.length && !filters.tags.every((tag) => (session.tags ?? []).includes(tag))) return false;
    if (filters.starredByMe && !session.starred) return false;
    return true;
  }

  function isSupplementalSession(sessionId: string): boolean {
    return (
      supplementalSelectedSessionRef.current?.id === sessionId &&
      !sessionsRef.current.some((session) => session.id === sessionId)
    );
  }

  function adjustLoadedParentDirectChildCount(previous: Session, next: Session) {
    if (!previous.parentSessionId || !sessionsRef.current.some((session) => session.id === previous.id)) return;
    const parent = sessionsRef.current.find((session) => session.id === previous.parentSessionId);
    if (!parent || parent.directChildCount === undefined) return;
    const parentShowsArchivedChildren = parent.status === 'archived';
    const previousMatches =
      parentShowsArchivedChildren === (previous.status === 'archived') && sessionMatchesVisibleFilters(previous);
    const nextMatches =
      parentShowsArchivedChildren === (next.status === 'archived') && sessionMatchesVisibleFilters(next);
    if (previousMatches === nextMatches) return;
    invalidateChildSessionRequests();
    sessionSummaryMutationVersionRef.current.set(
      parent.id,
      (sessionSummaryMutationVersionRef.current.get(parent.id) ?? 0) + 1,
    );
    setSessions((sessions) =>
      sessions.map((candidate) =>
        candidate.id === parent.id
          ? {
              ...candidate,
              directChildCount: Math.max(
                0,
                candidate.directChildCount! + Number(nextMatches) - Number(previousMatches),
              ),
            }
          : candidate,
      ),
    );
  }

  function applySessionStatusUpdate(
    session: Session,
    options: { supplementalOnly?: boolean; preserveDirectChildCount?: boolean } = {},
  ) {
    const current =
      sessionsRef.current.find((candidate) => candidate.id === session.id) ??
      (supplementalSelectedSessionRef.current?.id === session.id ? supplementalSelectedSessionRef.current : null);
    const updated = { ...(current ?? session), status: session.status };
    if (current && current.status !== session.status) {
      if (options.preserveDirectChildCount && session.directChildCount !== undefined) {
        updated.directChildCount = session.directChildCount;
      } else {
        delete updated.directChildCount;
      }
      sessionsRefreshRequestRef.current += 1;
      invalidateChildSessionRequests();
      adjustLoadedParentDirectChildCount(current, updated);
      setChildSessionCursors((cursors) => {
        const next = new Map(cursors);
        next.delete(session.id);
        if (current.parentSessionId) next.delete(current.parentSessionId);
        return next;
      });
    }
    applySessionListUpdate(updated, options.supplementalOnly ? { supplementalOnly: true } : {});
  }

  function applySessionListUpdate(session: Session, options: { forceKeep?: boolean; supplementalOnly?: boolean } = {}) {
    sessionSummaryMutationVersionRef.current.set(
      session.id,
      (sessionSummaryMutationVersionRef.current.get(session.id) ?? 0) + 1,
    );
    const isSupplementalSelection =
      !sessionsRef.current.some((candidate) => candidate.id === session.id) &&
      (options.supplementalOnly ||
        (supplementalSelectedSessionRef.current?.id === session.id && selectedSessionIdRef.current === session.id));
    if (isSupplementalSelection) {
      setSupplementalSelectedSession((current) => {
        if (current?.id !== session.id) return current;
        supplementalSelectedSessionRef.current = session;
        return session;
      });
      setSessionSearchResults((current) => updateSearchResultSession(current, session));
      return;
    }
    if (options.supplementalOnly) {
      setSessions((current) => current.map((candidate) => (candidate.id === session.id ? session : candidate)));
      setSessionSearchResults((current) => updateSearchResultSession(current, session));
      return;
    }
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

  const sidebarNavigation = resolveSidebarNavigation({
    panel: sidebarPanel,
    showingSetupGuide,
    visible: {
      groups: canViewGroups,
      automations: canViewAutomations,
      environments: canViewEnvironments,
      skills: canViewSkills,
    },
  });
  const footerProps: SidebarFooterProps = {
    authRequired: bearerAuthRequired || sessionAuthRequired,
    canViewGroups,
    canViewAutomations,
    canViewEnvironments,
    canViewSkills,
    canViewSetup,
    health,
    navPage: sidebarNavigation.navPage,
    themePreference,
    token,
    onOpenGroups: openGroupsPanel,
    onOpenAutomations: openAutomationsPanel,
    onOpenEnvironments: openEnvironmentsPanel,
    onOpenSkills: skillsWorkspace.actions.open,
    onOpenSessions: showSessionsSidebar,
    onOpenSetup: openSetupGuide,
    onSignOut: signOut,
    onThemeChange: setThemePreference,
  };

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
                  aria-label={sidebarNavigation.expandLabel}
                  title={sidebarNavigation.expandLabel}
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
                    canCreateGroups={canManageAllGroups}
                    currentUser={currentUser}
                    footerProps={footerProps}
                    groups={groups}
                    selectedGroupId={selectedGroupId}
                    selectedView={groupsPanelView}
                    superAdminUsers={currentSuperAdminUsers}
                    onBackToSessions={backToSessionsSidebar}
                    onCollapse={collapseSidebar}
                    onArchiveGroup={fireAndForget(handleArchiveGroup)}
                    onCreateGroup={startNewGroup}
                    onSelectGroup={selectGroupPanel}
                    onSelectSuperAdmins={selectSuperAdminsPanel}
                  />
                ) : sidebarPanel === 'automations' && canViewAutomations ? (
                  <AutomationsSidebar
                    archivedAutomationsOpen={archivedAutomationsOpen || selectedAutomationArchived}
                    automations={automations}
                    canCallApi={canViewAutomations}
                    canCreateAutomations={canCreateAutomations}
                    footerProps={footerProps}
                    groups={groups}
                    loading={automationsLoading}
                    selectedAutomationId={selectedAutomationId}
                    onBackToSessions={backToSessionsSidebar}
                    onArchiveAutomation={fireAndForget(handleArchiveAutomation)}
                    onArchivedAutomationsOpenChange={setArchivedAutomationsOpen}
                    onCollapse={collapseSidebar}
                    onCreateAutomation={startNewAutomation}
                    onSelectAutomation={selectAutomationPanel}
                    onUnarchiveAutomation={fireAndForget(handleUnarchiveAutomation)}
                  />
                ) : sidebarPanel === 'environments' && canViewEnvironments ? (
                  <EnvironmentsSidebar
                    canCallApi={canViewEnvironments}
                    canCreateEnvironments={canCreateEnvironments}
                    environments={environments}
                    footerProps={footerProps}
                    loading={environmentsLoading}
                    selectedEnvironmentId={selectedEnvironmentId}
                    onArchiveEnvironment={fireAndForget(handleArchiveEnvironment)}
                    onBackToSessions={backToSessionsSidebar}
                    onCollapse={collapseSidebar}
                    onCreateEnvironment={startNewEnvironment}
                    onRestoreEnvironment={fireAndForget(handleRestoreEnvironment)}
                    onSelectEnvironment={selectEnvironmentPanel}
                  />
                ) : sidebarPanel === 'skills' && canViewSkills ? (
                  <SkillsSidebar
                    canCallApi={canCallApi}
                    canCreateSkills={skillsWorkspace.model.canCreate}
                    footerProps={footerProps}
                    groups={groups}
                    loading={skillsWorkspace.model.loading}
                    skills={skillsWorkspace.model.skills}
                    selectedSkillId={skillsWorkspace.model.selectedSkillId}
                    onBackToSessions={backToSessionsSidebar}
                    onArchiveSkill={fireAndForget(skillsWorkspace.actions.archiveFromSidebar)}
                    onCollapse={collapseSidebar}
                    onCreateSkill={skillsWorkspace.actions.create}
                    onRestoreSkill={fireAndForget(skillsWorkspace.actions.restore)}
                    onSelectSkill={skillsWorkspace.actions.select}
                  />
                ) : (
                  <ThreadSidebar
                    archivedSessionsOpen={archivedSessionsOpen || Boolean(selectedSessionArchived)}
                    canCallApi={canCallApi}
                    canStartNewThread={canCreateThread}
                    canWriteSession={userCanWriteSession}
                    archivedSessionsLoaded={archivedSessionsLoaded}
                    archivedSessionsLoading={archivedSessionsLoading}
                    hasMoreArchivedSessions={Boolean(archivedSessionsNextCursor)}
                    hasMoreSessions={Boolean(sessionsNextCursor)}
                    loading={loading}
                    loadingMoreSessions={sessionsLoadingMore}
                    childSessionCursors={childSessionCursors}
                    childSessionsLoading={childSessionsLoading}
                    revealedLineage={canonicalRevealedSessionLineage}
                    revealedLineageSearchQuery={revealedSessionLineageSearchQuery}
                    footerProps={footerProps}
                    searchQuery={sessionSearchQuery}
                    searchResults={sessionSearchResults}
                    searchLoading={sessionSearchLoading || sessionSearchLoadingMore}
                    hasMoreSearchResults={Boolean(sessionSearchNextCursor)}
                    sessions={sidebarSessions}
                    sessionFilters={sessionFilters}
                    sessionFilterCount={activeSessionFilterCount}
                    sessionTagOptions={sessionTagOptions}
                    selectedSessionId={selectedSessionId}
                    onArchive={fireAndForget(archiveFromList)}
                    onArchivedSessionsOpenChange={handleArchivedSessionsOpenChange}
                    onCollapse={collapseSidebar}
                    onLoadMoreArchivedSessions={() => void loadArchivedSessions(false)}
                    onLoadMoreSearchResults={fireAndForget(loadMoreSessionSearchResults)}
                    onLoadMoreSessions={fireAndForget(loadMoreSessions)}
                    onLoadChildSessions={fireAndForget(loadChildSessions)}
                    onNewThread={startNewThread}
                    onRefresh={fireAndForget(refreshSessions)}
                    onClearLineageFilters={() => exitSessionLineageReveal({ clearFilters: true, restoreSearch: true })}
                    onClearLineageSearch={() => exitSessionLineageReveal()}
                    onDismissLineageReveal={() => exitSessionLineageReveal({ restoreSearch: true })}
                    onSelect={selectSessionFromSidebar}
                    onSearchChange={handleSessionSearchChange}
                    onShowInTree={fireAndForget(showSessionInTree)}
                    onSessionFiltersChange={applySessionFilters}
                    onSessionFiltersClear={() => applySessionFilters(emptySessionFilters)}
                    onSessionListHoverChange={setSessionListHovered}
                    onSessionStarChange={fireAndForget(handleSetSessionStarred)}
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
                    openSidebarLabel={sidebarNavigation.openLabel}
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
                    defaultReasoningLevel={defaultReasoningLevel}
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
                    selectedRevisionId={selectedEnvironmentRevisionId}
                    canCallApi={canViewEnvironments}
                    groups={groups}
                    token={token}
                    repositoryOptions={repositoryOptions}
                    repositoryOptionsLoading={repositoryOptionsLoading}
                    repositoryOptionsError={repositoryOptionsError}
                    showOpenSidebar={!sidebarOpen}
                    openSidebarLabel="Open environments"
                    onCreateEnvironment={startNewEnvironment}
                    onDirtyChange={setEnvironmentEditorDirty}
                    onEnvironmentChanged={handleEnvironmentSaved}
                    onOpenSidebar={expandSidebar}
                    onSelectRevision={(revisionId) =>
                      skillsWorkspace.actions.navigateToEnvironment(selectedEnvironmentId, revisionId)
                    }
                    onError={handleApiError}
                  />
                ) : sidebarPanel === 'skills' && canViewSkills ? (
                  <SkillsPanel
                    skill={skillsWorkspace.model.selectedSkill}
                    selectedSkillId={skillsWorkspace.model.selectedSkillId}
                    selectedRevisionId={skillsWorkspace.model.selectedRevisionId}
                    loaded={skillsWorkspace.model.loaded}
                    loading={skillsWorkspace.model.loading}
                    token={token}
                    groups={groups}
                    creatableGroups={skillCreatableGroups}
                    showOpenSidebar={!sidebarOpen}
                    onOpenSidebar={expandSidebar}
                    onSkillChanged={skillsWorkspace.actions.changed}
                    onSkillSaved={skillsWorkspace.actions.saved}
                    onArchiveSkill={fireAndForget(skillsWorkspace.actions.archive)}
                    onDirtyChange={skillsWorkspace.actions.setEditorDirty}
                    onRestoreSkill={fireAndForget(skillsWorkspace.actions.restore)}
                    onSelectRevision={skillsWorkspace.actions.selectRevision}
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
                    reasoningLevel={newThreadReasoningLevel}
                    defaultReasoningLevel={defaultReasoningLevel}
                    skills={skillsWorkspace.model.newSessionCatalog.skills}
                    skillsEnabled={skillsWorkspace.model.newSessionCatalog.enabled}
                    skillsLoading={skillsWorkspace.model.newSessionCatalog.loading}
                    skillError={skillsWorkspace.model.newSessionCatalog.error}
                    showOpenSidebar={!sidebarOpen}
                    openSidebarLabel={sidebarNavigation.openLabel}
                    onOpenSidebar={expandSidebar}
                    onGroupChange={handleNewThreadGroupChange}
                    onPromptChange={setNewThreadPrompt}
                    onCodebaseChange={handleNewThreadCodebaseChange}
                    onEnvironmentBranchOverridesChange={setNewThreadEnvironmentBranchOverrides}
                    onEnvironmentRepositoryBranchesLoad={loadEnvironmentRepositoryBranches}
                    onBranchChange={setNewThreadBranch}
                    onModelChange={setNewThreadModel}
                    onReasoningLevelChange={setNewThreadReasoningLevel}
                    onSubmit={handleCreateThread}
                  />
                ) : (
                  <section className="flex h-full min-h-0 flex-col">
                    <ThreadHeader
                      selectedSession={selectedSession}
                      canWriteSession={canWriteSelectedSession}
                      showOpenSidebar={!sidebarOpen}
                      openSidebarLabel={sidebarNavigation.openLabel}
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
                                  openableManagedSkillIds={skillsWorkspace.model.openableManagedSkillIds}
                                  onOpenSkill={skillsWorkspace.actions.select}
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
                            reasoningLevel={followUpReasoningLevel}
                            inheritedReasoningLevel={selectedSessionReasoningLevel}
                            defaultReasoningLevel={defaultReasoningLevel}
                            skills={skillsWorkspace.model.sessionCatalog.skills}
                            skillsEnabled={canViewSkills}
                            skillsLoading={skillsWorkspace.model.sessionCatalog.loading}
                            skillError={skillsWorkspace.model.sessionCatalog.error}
                            onCodebaseChange={handleFollowUpCodebaseChange}
                            onEnvironmentBranchOverridesChange={setFollowUpEnvironmentBranchOverrides}
                            onEnvironmentRepositoryBranchesLoad={loadEnvironmentRepositoryBranches}
                            onBranchChange={setFollowUpBranch}
                            onModelChange={setFollowUpModel}
                            onReasoningLevelChange={setFollowUpReasoningLevel}
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
  for (const session of incoming) {
    const existing = byId.get(session.id);
    const existingDirectChildCount = existing?.directChildCount;
    const preserveDirectChildCount =
      existing !== undefined &&
      existingDirectChildCount !== undefined &&
      session.directChildCount === undefined &&
      existing.status === session.status;
    byId.set(
      session.id,
      preserveDirectChildCount ? { ...session, directChildCount: existingDirectChildCount } : session,
    );
  }
  const incomingIds = new Set(incoming.map((session) => session.id));
  return [
    ...incoming.map((session) => byId.get(session.id) ?? session),
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

function setResourceSearchParam(param: 'session' | 'group' | 'automation' | 'environment' | 'skill', value: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete('session');
  url.searchParams.delete('group');
  url.searchParams.delete('automation');
  url.searchParams.delete('environment');
  url.searchParams.delete('skill');
  url.searchParams.delete('revision');
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
  url.searchParams.delete('skill');
  url.searchParams.delete('revision');
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
    searchParams.has('environment') ||
    searchParams.has('skill')
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
