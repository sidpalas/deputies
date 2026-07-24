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
  archiveSession,
  archiveSnippet,
  cancelCurrentRun,
  cancelMessage,
  createSession,
  createSnippet,
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
  listIncrementalEvents,
  listSessionTags,
  listExternalResources,
  listMessages,
  listRepositoryOptions,
  listServices,
  listSessions,
  listSnippets,
  logout,
  openWorkspaceTool,
  pauseQueue,
  promoteSession,
  replayCallback,
  restoreSnippet,
  resumeQueue,
  searchSessions,
  setSessionStarred,
  retryMessage,
  streamGlobalEvents,
  unarchiveEnvironment,
  unarchiveSession,
  updateMessage,
  updateMessageSteering,
  updateSession,
  updateSessionTags,
  updateSnippet,
  type Automation,
  type Environment,
  type EnvironmentBranchOverrideInput,
  type Health,
  type AuthUser,
  type BranchOption,
  type ModelChoice,
  type ReasoningLevel,
  type RepositoryOption,
  type SessionSearchResult,
  type SessionTagSummary,
  type SetupStatus,
  type Snippet,
  type WorkspaceToolId,
} from './api.js';
import { isSnippetMutationAuthoritative, isSnippetMutationCurrent } from './app-state.js';
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
  planSessionEvent,
  type DetailResource,
  type DirectSessionAction,
  type SessionPresentationEffect,
} from './session-event-plan.js';
import { SelectedResourceCoordinator, type SelectedResourceContext } from './selected-resource-coordinator.js';
import {
  SessionIndexCoordinator,
  type SessionIndexContext,
  type SessionIndexListResult,
  type SessionIndexTicket,
} from './session-index-coordinator.js';
import {
  activeProgressDisplayText,
  applyFrozenSessionOrder,
  appendActiveProgressEvents,
  buildActiveProgress,
  canWriteSession,
  errorMessage,
  filterActiveProgressEvents,
  isWorkspaceToolPreflightError,
  modelUnavailableReason,
  normalizeModelChoices,
  omitActiveProgress,
  repositoryLabel,
  resolveSelectableModel,
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
  initialConnectionStatus,
  isPageVisible,
  isStreamConnectionOk,
  isThreadComposerFocused,
  isThreadNearBottom,
  isWakeRecoveryStatus,
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
  SessionAuthPanel,
  SetupGuidePanel,
  SkillsPanel,
  SkillsSidebar,
  SnippetsPanel,
  SnippetsSidebar,
  InstanceAccessPanel,
  StartupLoadingPanel,
  ThreadHeader,
  ThreadSidebar,
  type SidebarFooterProps,
} from './components/app-panels.js';
import { ResponsiveNotepadsPanel } from './components/app-panels/notepads-panel.js';
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

type NavigationState = {
  selectedSessionId: string;
  sidebarPanel: SidebarPanel;
  isCreatingThread: boolean;
  setupGuideOpen: boolean;
  instanceAccessOpen: boolean;
  selectedAutomationId: string;
  selectedEnvironmentId: string;
  selectedEnvironmentRevisionId: string;
  selectedSkillId: string;
  selectedSkillRevisionId: string;
  selectedSnippetId: string;
};

const activeProgressBatchDelayMs = 100;
const createdSessionBackfillAttempts = 10;
const createdSessionBackfillDelayMs = 500;
const submissionEventFallbackDelayMs = 875;
const sessionListPageSize = 50;
const sessionSearchPageSize = 20;
const selectedDetailResources: DetailResource[] = [
  'messages',
  'artifacts',
  'services',
  'externalResources',
  'callbacks',
];

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
    instanceAccessOpen: false,
    selectedAutomationId: loadInitialSelectedAutomationId(),
    selectedEnvironmentId: loadInitialSelectedEnvironmentId(),
    selectedEnvironmentRevisionId: loadInitialSelectedEnvironmentRevisionId(),
    selectedSkillId: loadInitialSelectedSkillId(),
    selectedSkillRevisionId: loadInitialSelectedSkillRevisionId(),
    selectedSnippetId: new URLSearchParams(window.location.search).get('snippet') ?? '',
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
  const [promotingSessionId, setPromotingSessionId] = useState('');
  const [token, setToken] = useState(loadStoredToken);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [snippetsLoading, setSnippetsLoading] = useState(false);
  const snippetRefreshVersionRef = useRef(0);
  const [snippetMutationPending, setSnippetMutationPending] = useState(false);
  const snippetMutationVersionRef = useRef(0);
  const snippetDirtyRef = useRef(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [navigation, setNavigation] = useState<NavigationState>(loadInitialNavigationState);
  const snippetAuthority = currentUser ? `${currentUser.id}\u0000${token}` : '';
  const snippetAuthorityRef = useRef(snippetAuthority);
  snippetAuthorityRef.current = snippetAuthority;
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const snippetEditorKey = `${navigation.sidebarPanel}\u0000${navigation.selectedSnippetId}`;
  const snippetEditorKeyRef = useRef(snippetEditorKey);
  const snippetEditorEpochRef = useRef(0);
  if (snippetEditorKeyRef.current !== snippetEditorKey) {
    snippetEditorKeyRef.current = snippetEditorKey;
    snippetEditorEpochRef.current += 1;
  }
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
  const [steeringMessageIds, setSteeringMessageIds] = useState<Set<string>>(() => new Set());
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
  const [selectedSessionParentRefreshVersion, setSelectedSessionParentRefreshVersion] = useState(0);
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
  const [notepadChangeRevisions, setNotepadChangeRevisions] = useState(new Map<string, number>());
  const [notepadAssociationVersions, setNotepadAssociationVersions] = useState(new Map<string, number>());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const {
    selectedSessionId,
    sidebarPanel,
    isCreatingThread,
    setupGuideOpen,
    instanceAccessOpen,
    selectedAutomationId,
    selectedEnvironmentId,
    selectedEnvironmentRevisionId,
  } = navigation;
  const { messages, events, activeProgress, artifacts, services, externalResources, callbacks } = sessionDetail;
  const eventCursor = useRef(0);
  const mountedRef = useRef(false);
  const appliedSelectedEventSequencesRef = useRef(new Set<number>());
  const globalEventCursor = useRef(0);
  const wasPageHiddenRef = useRef(!isPageVisible());
  const wakeRecoveryActive = useRef(false);
  const recoveryGenerationRef = useRef(0);
  const recoveryPendingRef = useRef(false);
  const recoveryRunningRef = useRef(false);
  const recoveryListAuthorityGenerationRef = useRef(0);
  const recoveryPresentationEffectsRef = useRef(new Map<string, SessionPresentationEffect>());
  const recoveryRestartRequestedRef = useRef(false);
  const recoveryAbortRef = useRef<AbortController | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const [streamRestartGeneration, setStreamRestartGeneration] = useState(0);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const mobileNotepadsHostRef = useRef<HTMLDivElement | null>(null);
  const desktopNotepadsHostRef = useRef<HTMLDivElement | null>(null);
  const threadAutoFollowRef = useRef(true);
  const autoScrolledSessionId = useRef('');
  const selectedSessionIdRef = useRef(selectedSessionId);
  const sessionSelectionVersionRef = useRef(0);
  const sessionDetailLoadGenerationRef = useRef(0);
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
  const sessionsRefreshWaitersRef = useRef<Array<() => void>>([]);
  const sessionsRefreshRequestRef = useRef(0);
  const archivedSessionsRequestRef = useRef(0);
  const sessionSummaryRefreshInFlightRef = useRef(
    new Map<string, { operation: symbol; promise: Promise<void>; resolve: () => void }>(),
  );
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
  const titleMutationQueuesRef = useRef(
    new Map<string, { latest: string | null; running: boolean; waiters: Array<(saved: boolean) => void> }>(),
  );
  const sessionSummaryMutationVersionRef = useRef(new Map<string, number>());
  const sessionSummaryApplicationVersionRef = useRef(new Map<string, number>());
  const sessionSearchSummaryEpochRef = useRef(0);
  const handleApiErrorRef = useRef<(error: unknown) => void>(() => undefined);
  const selectedResourceCoordinatorRef = useRef<SelectedResourceCoordinator | null>(null);
  const sessionIndexCoordinatorRef = useRef<SessionIndexCoordinator | null>(null);
  const activeFirstPageIdsRef = useRef(new Set<string>());
  const activePaginationIdsRef = useRef(new Set<string>());
  const archivedSessionIdsRef = useRef(new Set<string>());
  const childSessionIdsRef = useRef(new Map<string, Set<string>>());
  const searchSessionIdsRef = useRef(new Set<string>());
  const lineageSessionIdsRef = useRef(new Set<string>());
  const selectedSnapshotDisplacementRef = useRef({ contextKey: '', resources: new Set<DetailResource>() });
  function createSelectedResourceCoordinator(): SelectedResourceCoordinator {
    return new SelectedResourceCoordinator({
      load: (resource, sessionId) => loadSelectedResource(resource, sessionId, tokenRef.current),
      apply: (resource, value, context) => {
        if (
          selectedSessionIdRef.current !== context.sessionId ||
          sessionSelectionVersionRef.current !== context.selectionVersion ||
          sessionSummaryAuthorityEpochRef.current !== context.authorityEpoch
        ) {
          return;
        }
        setSessionDetail((current) => applySelectedResource(current, resource, value));
      },
      onError: (error) => handleApiErrorRef.current(error),
    });
  }
  function selectedResourceContext(sessionId: string): SelectedResourceContext {
    return {
      sessionId,
      authorityEpoch: sessionSummaryAuthorityEpochRef.current,
      selectionVersion: sessionSelectionVersionRef.current,
    };
  }
  function isSelectedResourceContextCurrent(context: SelectedResourceContext): boolean {
    return (
      mountedRef.current &&
      selectedSessionIdRef.current === context.sessionId &&
      sessionSummaryAuthorityEpochRef.current === context.authorityEpoch &&
      sessionSelectionVersionRef.current === context.selectionVersion
    );
  }
  function captureSelectedResourceVersions(context: SelectedResourceContext): Map<DetailResource, number> {
    return new Map(
      selectedDetailResources.map((resource) => [
        resource,
        selectedResourceCoordinatorRef.current?.captureVersion(context, resource) ?? 0,
      ]),
    );
  }
  function selectedResourceContextKey(context: SelectedResourceContext): string {
    return `${context.authorityEpoch}:${context.selectionVersion}:${context.sessionId}`;
  }
  function supersedeForSelectedSnapshot(
    context: SelectedResourceContext,
    resources: ReadonlySet<DetailResource>,
  ): ReadonlySet<DetailResource> {
    const contextKey = selectedResourceContextKey(context);
    if (selectedSnapshotDisplacementRef.current.contextKey !== contextKey) {
      selectedSnapshotDisplacementRef.current = { contextKey, resources: new Set() };
    }
    const displaced = selectedResourceCoordinatorRef.current?.supersede(context, resources) ?? new Set();
    for (const resource of displaced) selectedSnapshotDisplacementRef.current.resources.add(resource);
    return new Set(selectedSnapshotDisplacementRef.current.resources);
  }
  function satisfySelectedSnapshotDisplacement(resources: ReadonlySet<DetailResource>) {
    for (const resource of resources) selectedSnapshotDisplacementRef.current.resources.delete(resource);
  }
  function supersedeSelectedResources(
    context: SelectedResourceContext,
    resources: ReadonlySet<DetailResource>,
  ): ReadonlySet<DetailResource> {
    const displaced = selectedResourceCoordinatorRef.current?.supersede(context, resources) ?? new Set();
    satisfySelectedSnapshotDisplacement(resources);
    return displaced;
  }
  function applySelectedResourceMutation(
    context: SelectedResourceContext,
    resources: ReadonlySet<DetailResource>,
    update: (current: SessionDetailState) => SessionDetailState,
  ) {
    const displaced = supersedeSelectedResources(context, resources);
    setSessionDetail(update);
    selectedResourceCoordinatorRef.current?.invalidate(context, displaced);
  }
  function selectedResourceVersionIsCurrent(
    context: SelectedResourceContext,
    versions: Map<DetailResource, number>,
    resource: DetailResource,
  ): boolean {
    const version = versions.get(resource);
    return (
      version !== undefined &&
      (selectedResourceCoordinatorRef.current?.isVersionCurrent(context, resource, version) ?? false)
    );
  }
  function restoreDisplacedSelectedResources(
    context: SelectedResourceContext,
    displaced: ReadonlySet<DetailResource>,
    versions: Map<DetailResource, number>,
    candidates: ReadonlySet<DetailResource> = new Set(selectedDetailResources),
  ) {
    const resources = new Set(
      [...candidates].filter(
        (resource) => displaced.has(resource) && selectedResourceVersionIsCurrent(context, versions, resource),
      ),
    );
    selectedResourceCoordinatorRef.current?.invalidate(context, resources);
    satisfySelectedSnapshotDisplacement(candidates);
  }
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
  const observedMessageCreatedIdsRef = useRef(new Set<string>());
  const submissionFallbacksRef = useRef(
    new Map<
      string,
      {
        context: SelectedResourceContext;
        messageId: string;
        after: number;
        abort: AbortController;
      }
    >(),
  );
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
  const canManageTenantResources =
    canCallApi && (!sessionAuthRequired || currentUser?.role === 'member' || currentUser?.role === 'admin');
  const canManageSkills = canCallApi && (!sessionAuthRequired || Boolean(currentUser));
  const canManagePersonalResources = canCallApi && Boolean(currentUser);
  const canCreateThread =
    canCallApi && (!sessionAuthRequired || currentUser?.role === 'member' || currentUser?.role === 'admin');
  const canViewAutomations = canCallApi;
  const canCreateAutomations = canManageTenantResources;
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
    canManage: canManageSkills,
    canCallApi,
    canCreateThread,
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
      const leavingDirtySnippet =
        navigation.sidebarPanel === 'snippets' &&
        (next.sidebarPanel !== 'snippets' || next.selectedSnippetId !== navigation.selectedSnippetId);
      if (leavingDirtySnippet && snippetDirtyRef.current) {
        if (!window.confirm('Discard unsaved snippet changes?')) return false;
        snippetDirtyRef.current = false;
      }
      return true;
    },
  });
  const canViewSkills = skillsWorkspace.model.canView;
  const canViewInstanceAccess = canCallApi && currentUser?.role === 'admin';
  const canViewEnvironments =
    canCallApi &&
    (!sessionAuthRequired ||
      currentUser?.role === 'viewer' ||
      currentUser?.role === 'member' ||
      currentUser?.role === 'admin');
  const canCreateEnvironments = canManageTenantResources;
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
  const canViewSetup = canCallApi && (!sessionAuthRequired || currentUser?.role === 'admin');
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
  const newThreadEnvironmentOptions = activeEnvironmentOptions;
  const followUpEnvironmentOptions = activeEnvironmentOptions;
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
      next.instanceAccessOpen === true ||
      (next.sidebarPanel && next.sidebarPanel !== 'sessions')
    );
  }

  function setSelectedSessionId(next: StateUpdate<string>) {
    const nextSessionId = resolveStateUpdate(next, navigationRef.current.selectedSessionId);
    if (nextSessionId !== selectedSessionIdRef.current) {
      resetIncrementalRecovery();
      sessionSelectionVersionRef.current += 1;
      sessionDetailLoadGenerationRef.current += 1;
      selectedSessionIdRef.current = nextSessionId;
      selectedResourceCoordinatorRef.current?.setContext(selectedResourceContext(nextSessionId));
      clearSessionDetail();
      eventCursor.current = 0;
    }
    navigationRef.current = { ...navigationRef.current, selectedSessionId: nextSessionId };
    setNavigation((current) => ({ ...current, selectedSessionId: nextSessionId }));
  }

  function setSetupGuideOpen(setupGuideOpen: boolean) {
    updateNavigation({ setupGuideOpen });
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
    const releasedIds = new Set(lineageSessionIdsRef.current);
    lineageSessionIdsRef.current.clear();
    removeUnownedSessions(releasedIds);
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
    abortTitleMutationQueues();
    abortSubmissionFallback();
    abortCreatedSessionBackfill();
    resetIncrementalRecovery();
    sessionSummaryAuthorityEpochRef.current += 1;
    sessionIndexCoordinatorRef.current?.setContext({
      authorityEpoch: sessionSummaryAuthorityEpochRef.current,
      viewKey: 'session-index',
    });
    sessionDetailLoadGenerationRef.current += 1;
    eventCursor.current = 0;
    globalEventCursor.current = 0;
    selectedResourceCoordinatorRef.current?.setContext(selectedResourceContext(selectedSessionIdRef.current));
    sessionsRefreshRequestRef.current += 1;
    sessionsRefreshQueuedRef.current = false;
    clearScheduledSessionsRefresh();
    for (const resolve of sessionsRefreshWaitersRef.current.splice(0)) resolve();
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
    activeFirstPageIdsRef.current.clear();
    activePaginationIdsRef.current.clear();
    archivedSessionIdsRef.current.clear();
    childSessionIdsRef.current.clear();
    searchSessionIdsRef.current.clear();
    lineageSessionIdsRef.current.clear();
    for (const [key, version] of sessionMutationVersionRef.current) {
      sessionMutationVersionRef.current.set(key, version + 1);
    }
    sessionStatusMutationPendingRef.current.clear();
    canonicalSessionMutationPendingRef.current.clear();
    for (const operation of sessionSummaryRefreshInFlightRef.current.values()) operation.resolve();
    sessionSummaryRefreshInFlightRef.current.clear();
    sessionSummaryRefreshQueuedRef.current.clear();
    sessionSummaryApplicationVersionRef.current.clear();
    invalidateChildSessionRequests();
    setSessions([]);
    setSessionSearchResults([]);
    setSessionsLoadingMore(false);
    setArchivedSessionsLoading(false);
    setSessionSearchLoading(false);
    setSessionSearchLoadingMore(false);
    setSessionTagOptions([]);
    setRevealedSessionLineage([]);
    setRevealedSessionLineageSearchQuery('');
    setSelectedSessionParent(null);
    setSupplementalSelectedSession(null);
    sessionMilestoneInteractionRef.current?.abort('selection_change');
    sessionMilestoneInteractionRef.current = null;
    detailLoadedSessionIdRef.current = '';
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
    activeFirstPageIdsRef.current.clear();
    activePaginationIdsRef.current.clear();
    archivedSessionIdsRef.current.clear();
    childSessionIdsRef.current.clear();
    searchSessionIdsRef.current.clear();
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
    const ticket = captureIndexTicket('lineage', { kind: 'lineage', selected: session.id, requestId });
    if (!ticket) return;

    try {
      while (current.parentSessionId && !visited.has(current.parentSessionId)) {
        visited.add(current.parentSessionId);
        const cached = [...sessionsRef.current, ...lineage].find(
          (candidate) => candidate.id === current.parentSessionId,
        );
        const parent = cached ?? (await getSession({ sessionId: current.parentSessionId, token }));
        if (indexTicketEligibleRows(ticket, [parent]).length === 0) return;
        if (lineageRevealRequestRef.current !== requestId) return;
        lineage.push(parent);
        current = parent;
      }
      if (lineageRevealRequestRef.current !== requestId) return;
      if (indexTicketEligibleRows(ticket, lineage).length !== lineage.length) return;
      lineageSessionIdsRef.current = new Set(lineage.map((row) => row.id));
      setRevealedSessionLineage(lineage);
      setRevealedSessionLineageSearchQuery(sessionSearchQuery);
      setSessionSearchQuery('');
      selectSession(session.id, { keepSidebarOpen: true });
    } catch (err) {
      if (lineageRevealRequestRef.current === requestId) handleApiError(err);
    } finally {
      sessionIndexCoordinatorRef.current?.release(ticket);
    }
  }

  function sessionMutationKey(sessionId: string, kind: 'star' | 'status' | 'tags' | 'title'): string {
    return `${sessionId}:${kind}`;
  }

  function nextSessionMutationVersion(sessionId: string, kind: 'star' | 'status' | 'tags' | 'title'): number {
    const key = sessionMutationKey(sessionId, kind);
    const next = (sessionMutationVersionRef.current.get(key) ?? 0) + 1;
    sessionMutationVersionRef.current.set(key, next);
    return next;
  }

  function isCurrentSessionMutation(
    sessionId: string,
    kind: 'star' | 'status' | 'tags' | 'title',
    version: number,
  ): boolean {
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

  function beginCanonicalSessionMutation(
    sessionId: string,
    kind: 'star' | 'status' | 'tags' | 'title',
    version: number,
  ) {
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

  function finishCanonicalSessionMutation(
    sessionId: string,
    kind: 'star' | 'status' | 'tags' | 'title',
    version: number,
  ) {
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

  async function refreshSnippets(clear = false) {
    const authority = snippetAuthority;
    const version = ++snippetRefreshVersionRef.current;
    if (clear) setSnippets([]);
    if (!canCallApi || !currentUser) {
      setSnippetsLoading(false);
      return;
    }
    setSnippetsLoading(true);
    try {
      const items = await listSnippets({ token });
      if (snippetAuthorityRef.current === authority && snippetRefreshVersionRef.current === version) setSnippets(items);
    } catch (error) {
      if (snippetAuthorityRef.current === authority && snippetRefreshVersionRef.current === version)
        handleApiError(error);
    } finally {
      if (snippetAuthorityRef.current === authority && snippetRefreshVersionRef.current === version)
        setSnippetsLoading(false);
    }
  }

  useEffect(() => {
    snippetMutationVersionRef.current += 1;
    setSnippetMutationPending(false);
    void refreshSnippets(true);
  }, [canCallApi, currentUser?.id, token, snippetAuthority]);

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
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    listSessionTags(token)
      .then((tags) => {
        if (sessionSummaryAuthorityEpochRef.current === authorityEpoch) setSessionTagOptions(tags);
      })
      .catch(() => undefined);
  }, [canCallApi, currentUser?.id, sidebarPanel, token]);

  useEffect(() => {
    const query = sessionSearchQuery.trim();
    const requestId = sessionSearchRequestRef.current + 1;
    sessionSearchRequestRef.current = requestId;
    if (!query || !canCallApi) {
      const releasedIds = new Set(searchSessionIdsRef.current);
      searchSessionIdsRef.current.clear();
      removeUnownedSessions(releasedIds);
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
      const summaryEpoch = sessionSearchSummaryEpochRef.current;
      const ticket = captureIndexTicket('search:first', {
        kind: 'search',
        query,
        filters: sessionFilters,
        cursor: null,
      });
      if (!ticket) return;
      searchSessions(token, { query, limit: sessionSearchPageSize, ...sessionFilterRequestOptions(sessionFilters) })
        .then((page) => {
          if (sessionSearchRequestRef.current !== requestId) return;
          if (!sessionIndexCoordinatorRef.current?.isTicketCurrent(ticket)) return;
          const rows = page.results.map((result) => result.session);
          const eligible = indexTicketEligibleRows(ticket, rows);
          if (eligible.length !== rows.length) {
            sessionIndexCoordinatorRef.current?.release(ticket);
            setSessionSearchRefreshVersion((current) => current + 1);
            return;
          }
          if (sessionSearchSummaryEpochRef.current !== summaryEpoch) {
            sessionIndexCoordinatorRef.current?.release(ticket);
            setSessionSearchRefreshVersion((current) => current + 1);
            return;
          }
          for (const session of eligible) markSessionSummaryApplied(session.id);
          setSessionSearchResults(page.results);
          replaceSessionOwnerRows(searchSessionIdsRef, new Set(rows.map((session) => session.id)), eligible);
          setSessionSearchNextCursor(page.nextCursor);
        })
        .catch((err) => {
          if (sessionSearchRequestRef.current === requestId) handleApiError(err);
        })
        .finally(() => {
          sessionIndexCoordinatorRef.current?.release(ticket);
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

  useLayoutEffect(() => {
    mountedRef.current = true;
    const coordinator = createSelectedResourceCoordinator();
    const indexCoordinator = new SessionIndexCoordinator({
      loadList: async (ticket) => refreshSessionsWithTicket(ticket),
      loadSummary: async (sessionId, generation, context) =>
        refreshLoadedSessionSummary(sessionId, true, { generation, context }),
      onError: (error) => handleApiErrorRef.current(error),
    });
    selectedResourceCoordinatorRef.current = coordinator;
    sessionIndexCoordinatorRef.current = indexCoordinator;
    coordinator.setContext(selectedResourceContext(selectedSessionIdRef.current));
    indexCoordinator.setContext({ authorityEpoch: sessionSummaryAuthorityEpochRef.current, viewKey: 'session-index' });
    return () => {
      mountedRef.current = false;
      abortTitleMutationQueues();
      abortSubmissionFallback();
      abortCreatedSessionBackfill();
      resetIncrementalRecovery();
      coordinator.dispose();
      indexCoordinator.dispose();
      if (selectedResourceCoordinatorRef.current === coordinator) selectedResourceCoordinatorRef.current = null;
      if (sessionIndexCoordinatorRef.current === indexCoordinator) sessionIndexCoordinatorRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    selectedResourceCoordinatorRef.current?.setContext(selectedResourceContext(selectedSessionId));
  }, [selectedSessionId, token, canCallApi]);

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
    const handlePageMayResume = () => {
      if (isPageVisible()) {
        if (wasPageHiddenRef.current) requestIncrementalRecovery(true);
        wasPageHiddenRef.current = false;
      } else {
        wasPageHiddenRef.current = true;
      }
      setPageVisible(isPageVisible());
    };
    let lastTick = Date.now();
    const interval = window.setInterval(() => {
      const now = Date.now();
      if (isPageVisible() && now - lastTick >= wakeRecoveryThresholdMs) requestIncrementalRecovery(true);
      lastTick = now;
    }, 1_000);
    const handleVisibilityChange = handlePageMayResume;
    const handleOnline = () => requestIncrementalRecovery(true);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

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
    if (!canViewAutomations || sidebarPanel !== 'automations') return;
    refreshAutomations().catch(() => undefined);
  }, [canViewAutomations, sidebarPanel, token]);

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
    const ticket = captureIndexTicket('selected-parent', {
      kind: 'selected-parent',
      selected: selectedSession.id,
      parent: parentSessionId,
    });
    if (!ticket) return;
    setSelectedSessionParent(null);
    void getSession({ sessionId: parentSessionId, token })
      .then((parent) => {
        if (selectedSessionParentRequestRef.current.requestId !== requestId) return;
        if (selectedSessionIdRef.current !== selectedSession.id) return;
        if (!sessionIndexCoordinatorRef.current?.isTicketCurrent(ticket)) return;
        if (indexTicketEligibleRows(ticket, [parent]).length === 0) {
          sessionIndexCoordinatorRef.current?.release(ticket);
          selectedSessionParentRequestRef.current = { key: '', requestId };
          setSelectedSessionParentRefreshVersion((current) => current + 1);
          return;
        }
        selectedSessionParentRequestRef.current = { key: '', requestId };
        setSelectedSessionParent(parent);
      })
      .catch((err) => {
        if (selectedSessionParentRequestRef.current.requestId !== requestId) return;
        if (selectedSessionIdRef.current !== selectedSession.id) return;
        selectedSessionParentRequestRef.current = { key: '', requestId };
        if (!(err instanceof ApiError && (err.status === 403 || err.status === 404))) handleApiError(err);
      })
      .finally(() => sessionIndexCoordinatorRef.current?.release(ticket));
  }, [
    selectedSession,
    sessions,
    canonicalRevealedSessionLineage,
    canCallApi,
    token,
    selectedSessionParentRefreshVersion,
  ]);

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
    streamAbortRef.current = abort;
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    let reconnectDelayMs = realtimeReconnectInitialDelayMs;

    const runStreamLoop = async () => {
      while (!abort.signal.aborted) {
        try {
          await streamGlobalEvents({
            after: globalEventCursor.current,
            token,
            signal: abort.signal,
            onOpen: () => {
              reconnectDelayMs = realtimeReconnectInitialDelayMs;
              recoveryRestartRequestedRef.current = false;
              runIncrementalRecoveryAfterStreamOpen();
            },
            onEvent: (event) => {
              if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return;
              reconnectDelayMs = realtimeReconnectInitialDelayMs;
              if (typeof event.id === 'number')
                globalEventCursor.current = Math.max(globalEventCursor.current, event.id);
              applySynchronizedSessionEvent(event, true);
            },
          });
          if (!abort.signal.aborted && sessionSummaryAuthorityEpochRef.current === authorityEpoch) {
            recoveryRestartRequestedRef.current = false;
            requestIncrementalRecovery(false);
            setConnectionStatus({ state: 'reconnecting', message: 'Realtime connection interrupted.' });
          }
        } catch (err: unknown) {
          if (abort.signal.aborted || sessionSummaryAuthorityEpochRef.current !== authorityEpoch) break;
          recoveryRestartRequestedRef.current = false;
          requestIncrementalRecovery(false);
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
      if (streamAbortRef.current === abort) streamAbortRef.current = null;
      if (sessionsRefreshWaitersRef.current.length === 0) clearScheduledSessionsRefresh();
    };
  }, [pageVisible, canCallApi, sessionsLoaded, token, streamRestartGeneration]);

  function recordNotepadChange(event: AgentEvent) {
    if (event.type === 'notepad_associations_changed') {
      setNotepadAssociationVersions((current) => {
        if ((current.get(event.sessionId) ?? 0) >= event.sequence) return current;
        const next = new Map(current);
        next.set(event.sessionId, event.sequence);
        return next;
      });
      return;
    }
    if (event.type !== 'notepad_changed') return;
    const { notepadKind, notepadId, revision } = event.payload;
    if (
      (notepadKind !== 'session' && notepadKind !== 'explicit') ||
      typeof notepadId !== 'string' ||
      !notepadId ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      return;
    const key = `${notepadKind}:${notepadId}`;
    setNotepadChangeRevisions((current) => {
      if ((current.get(key) ?? 0) >= revision) return current;
      const next = new Map(current);
      next.set(key, revision);
      return next;
    });
  }

  function applySynchronizedSessionEvent(event: AgentEvent, reconcilePresentation: boolean) {
    recordNotepadChange(event);
    const activeSessionId = selectedSessionIdRef.current;
    if (event.type === 'message_created' && event.messageId && event.sessionId === activeSessionId) {
      observedMessageCreatedIdsRef.current.add(event.messageId);
      const fallback = submissionFallbacksRef.current.get(event.messageId);
      if (fallback?.context.sessionId === event.sessionId && fallback.messageId === event.messageId) {
        fallback.abort.abort();
        submissionFallbacksRef.current.delete(event.messageId);
      }
    }
    const selectedEventAlreadyApplied =
      event.sessionId === activeSessionId && appliedSelectedEventSequencesRef.current.has(event.sequence);
    if (event.sessionId === activeSessionId && !selectedEventAlreadyApplied) {
      appliedSelectedEventSequencesRef.current.add(event.sequence);
    }
    if (event.type === 'skills_loaded' && event.sessionId === activeSessionId && !selectedEventAlreadyApplied) {
      skillsWorkspace.actions.invalidateSessionCatalog();
    }
    const activeSessionHasMessages = messagesRef.current.some((message) => message.sessionId === activeSessionId);
    const eventPlan = planSessionEvent(event);
    if (event.type === 'session_visibility_changed' && sidebarPanel === 'sessions') {
      const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
      void listSessionTags(token)
        .then((tags) => {
          if (sessionSummaryAuthorityEpochRef.current === authorityEpoch) setSessionTagOptions(tags);
        })
        .catch(() => undefined);
    }
    if (event.sessionId === activeSessionId && !selectedEventAlreadyApplied) {
      const shouldResetPendingDetail =
        pendingCreatedSessionIdRef.current === activeSessionId &&
        detailLoadedSessionIdRef.current !== activeSessionId &&
        !activeSessionHasMessages;
      eventCursor.current = Math.max(eventCursor.current, event.sequence);
      if (shouldUseActiveProgressEvent(event, messagesRef.current)) {
        queueActiveProgressEvent(event);
      } else {
        if (event.type === 'agent_response_final' && event.messageId) discardQueuedActiveProgress(event.messageId);
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
      if (eventPlan.directActions.length > 0) {
        applySelectedResourceMutation(
          selectedResourceContext(activeSessionId),
          directActionResources(eventPlan.directActions),
          (current) => applyDirectSessionActions(current, eventPlan.directActions),
        );
      }
      if (eventPlan.detailResources.size > 0) {
        selectedResourceCoordinatorRef.current?.invalidate(
          selectedResourceContext(activeSessionId),
          eventPlan.detailResources,
        );
      }
    }

    if (reconcilePresentation && eventPlan.sessionEffect !== 'none') {
      const recoveryListGeneration = recoveryListAuthorityGenerationRef.current;
      if (recoveryListGeneration !== 0) {
        deferRecoveryPresentationEffect(event.sessionId, eventPlan.sessionEffect);
        return;
      }
      markSessionSummaryChanged(event.sessionId);
      sessionIndexCoordinatorRef.current?.requestInvalidation(
        event.sessionId,
        eventPlan.sessionEffect,
        sessionHasAnyIndexOwner(event.sessionId) || Boolean(loadedSessionSummary(event.sessionId)),
        hasActiveSessionFilters(sessionFiltersRef.current),
      );
    }
  }

  function deferRecoveryPresentationEffect(sessionId: string, effect: SessionPresentationEffect) {
    const current = recoveryPresentationEffectsRef.current.get(sessionId);
    if (current !== 'list') recoveryPresentationEffectsRef.current.set(sessionId, effect);
  }

  function flushRecoveryPresentationEffects() {
    const entries = [...recoveryPresentationEffectsRef.current];
    recoveryPresentationEffectsRef.current.clear();
    if (entries.length === 0) return;
    for (const [sessionId, effect] of entries) {
      if (effect === 'none') continue;
      markSessionSummaryChanged(sessionId);
      sessionIndexCoordinatorRef.current?.requestInvalidation(
        sessionId,
        effect,
        sessionHasAnyIndexOwner(sessionId) || Boolean(loadedSessionSummary(sessionId)),
        hasActiveSessionFilters(sessionFiltersRef.current),
      );
    }
  }

  function requestIncrementalRecovery(restartStream: boolean) {
    if (recoveryPendingRef.current) {
      if (!restartStream && recoveryRunningRef.current) {
        recoveryGenerationRef.current += 1;
        recoveryRunningRef.current = false;
        recoveryAbortRef.current?.abort();
        recoveryAbortRef.current = null;
        return;
      }
      if (restartStream && !recoveryRunningRef.current) {
        if (recoveryRestartRequestedRef.current) return;
        recoveryRestartRequestedRef.current = true;
        wakeRecoveryActive.current = true;
        setConnectionStatus(wakeRecoveryConnectionStatus());
        streamAbortRef.current?.abort();
        setStreamRestartGeneration((current) => current + 1);
      }
      return;
    }
    recoveryGenerationRef.current += 1;
    recoveryPendingRef.current = true;
    recoveryRunningRef.current = false;
    if (!restartStream) return;
    recoveryRestartRequestedRef.current = true;
    wakeRecoveryActive.current = true;
    setConnectionStatus(wakeRecoveryConnectionStatus());
    streamAbortRef.current?.abort();
    setStreamRestartGeneration((current) => current + 1);
  }

  function resetIncrementalRecovery() {
    recoveryGenerationRef.current += 1;
    recoveryPendingRef.current = false;
    recoveryRunningRef.current = false;
    recoveryListAuthorityGenerationRef.current = 0;
    recoveryPresentationEffectsRef.current.clear();
    recoveryRestartRequestedRef.current = false;
    recoveryAbortRef.current?.abort();
    recoveryAbortRef.current = null;
  }

  function incrementalRecoveryIsCurrent(
    generation: number,
    authorityEpoch: number,
    context: SelectedResourceContext,
  ): boolean {
    return (
      recoveryGenerationRef.current === generation &&
      recoveryPendingRef.current &&
      sessionSummaryAuthorityEpochRef.current === authorityEpoch &&
      isSelectedResourceContextCurrent(context)
    );
  }

  function runIncrementalRecoveryAfterStreamOpen() {
    if (!recoveryPendingRef.current || recoveryRunningRef.current) return;
    const generation = recoveryGenerationRef.current;
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    const sessionId = selectedSessionIdRef.current;
    const context = selectedResourceContext(sessionId);
    const abort = new AbortController();
    recoveryAbortRef.current?.abort();
    recoveryAbortRef.current = abort;
    recoveryRunningRef.current = true;

    void (async () => {
      try {
        recoveryListAuthorityGenerationRef.current = generation;
        try {
          await refreshSessions();
        } finally {
          if (recoveryListAuthorityGenerationRef.current === generation) {
            recoveryListAuthorityGenerationRef.current = 0;
            flushRecoveryPresentationEffects();
          }
        }
        if (!incrementalRecoveryIsCurrent(generation, authorityEpoch, context) || abort.signal.aborted) return;
        if (!sessionId) return;

        if (detailLoadedSessionIdRef.current !== sessionId) {
          await loadAndApplySessionDetail(sessionId, true, abort.signal);
          return;
        }

        const after = eventCursor.current;
        const recoveredEvents = await listIncrementalEvents(sessionId, tokenRef.current, after, {
          signal: abort.signal,
        });
        if (!incrementalRecoveryIsCurrent(generation, authorityEpoch, context) || abort.signal.aborted) return;
        for (const event of recoveredEvents) applySynchronizedSessionEvent(event, false);
      } catch (err) {
        if (incrementalRecoveryIsCurrent(generation, authorityEpoch, context) && !abort.signal.aborted) {
          handleApiError(err);
        }
      } finally {
        if (recoveryGenerationRef.current === generation) {
          recoveryPendingRef.current = false;
          recoveryRunningRef.current = false;
          if (recoveryAbortRef.current === abort) recoveryAbortRef.current = null;
        }
      }
    })();
  }

  function clearScheduledSessionsRefresh() {
    if (sessionsRefreshTimerRef.current === null) return;
    window.clearTimeout(sessionsRefreshTimerRef.current);
    sessionsRefreshTimerRef.current = null;
  }

  function abortCreatedSessionBackfill() {
    createdSessionBackfillAbortRef.current?.abort();
    createdSessionBackfillAbortRef.current = null;
  }

  function abortSubmissionFallback() {
    for (const fallback of submissionFallbacksRef.current.values()) fallback.abort.abort();
    submissionFallbacksRef.current.clear();
  }

  function waitForSynchronizationDelay(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timeout: number | undefined;
      const finish = () => {
        if (timeout !== undefined) window.clearTimeout(timeout);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      timeout = window.setTimeout(finish, delayMs);
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  function reconcileSelectedMessagesAndSummaryOnce(context: SelectedResourceContext) {
    if (!isSelectedResourceContextCurrent(context)) return;
    selectedResourceCoordinatorRef.current?.invalidate(context, new Set<DetailResource>(['messages']));
    markSessionSummaryChanged(context.sessionId);
    void refreshLoadedSessionSummary(context.sessionId);
  }

  function startSubmissionEventFallback(context: SelectedResourceContext, messageId: string, after: number) {
    if (observedMessageCreatedIdsRef.current.has(messageId) || !isSelectedResourceContextCurrent(context)) return;
    const fallback = { context, messageId, after, abort: new AbortController() };
    submissionFallbacksRef.current.set(messageId, fallback);

    void (async () => {
      try {
        await waitForSynchronizationDelay(submissionEventFallbackDelayMs, fallback.abort.signal);
        if (
          fallback.abort.signal.aborted ||
          submissionFallbacksRef.current.get(messageId) !== fallback ||
          !isSelectedResourceContextCurrent(context) ||
          observedMessageCreatedIdsRef.current.has(messageId)
        ) {
          return;
        }

        try {
          const recoveredEvents = await listIncrementalEvents(context.sessionId, tokenRef.current, after, {
            signal: fallback.abort.signal,
          });
          if (
            fallback.abort.signal.aborted ||
            submissionFallbacksRef.current.get(messageId) !== fallback ||
            !isSelectedResourceContextCurrent(context)
          ) {
            return;
          }
          for (const event of recoveredEvents) applySynchronizedSessionEvent(event, true);
        } catch {
          if (fallback.abort.signal.aborted) return;
        }

        if (
          submissionFallbacksRef.current.get(messageId) === fallback &&
          isSelectedResourceContextCurrent(context) &&
          !observedMessageCreatedIdsRef.current.has(messageId)
        ) {
          reconcileSelectedMessagesAndSummaryOnce(context);
        }
      } finally {
        if (submissionFallbacksRef.current.get(messageId) === fallback) {
          submissionFallbacksRef.current.delete(messageId);
        }
      }
    })();
  }

  function scheduleSessionsRefresh(delayMs = 300) {
    clearScheduledSessionsRefresh();
    sessionsRefreshTimerRef.current = window.setTimeout(() => {
      sessionsRefreshTimerRef.current = null;
      refreshSessions().catch(() => undefined);
    }, delayMs);
  }

  function markSessionSummaryChanged(sessionId: string) {
    sessionIndexCoordinatorRef.current?.markSummaryChanged(sessionId);
    sessionSearchSummaryEpochRef.current += 1;
    sessionSummaryMutationVersionRef.current.set(
      sessionId,
      (sessionSummaryMutationVersionRef.current.get(sessionId) ?? 0) + 1,
    );
  }

  function captureIndexTicket(owner: string, view: unknown): SessionIndexTicket | null {
    return sessionIndexCoordinatorRef.current?.captureTicket(owner, JSON.stringify(view)) ?? null;
  }

  function indexTicketEligibleRows(ticket: SessionIndexTicket, rows: Session[]): Session[] {
    const coordinator = sessionIndexCoordinatorRef.current;
    if (!coordinator?.isTicketCurrent(ticket)) return [];
    return rows.filter((row) => {
      if (coordinator.isRowCurrent(ticket, row.id)) return true;
      // A list snapshot may complete after an invalidation but still carry a newer
      // server revision. Accept only that demonstrably newer direct authority.
      const current = loadedSessionSummary(row.id);
      return Boolean(current && sessionUpdatedAfter(row, current));
    });
  }

  function sessionOwnedOutsideFirstPage(sessionId: string): boolean {
    return (
      activePaginationIdsRef.current.has(sessionId) ||
      archivedSessionIdsRef.current.has(sessionId) ||
      [...childSessionIdsRef.current.values()].some((ids) => ids.has(sessionId)) ||
      searchSessionIdsRef.current.has(sessionId) ||
      lineageSessionIdsRef.current.has(sessionId) ||
      selectedSessionParentRef.current?.id === sessionId ||
      supplementalSelectedSessionRef.current?.id === sessionId
    );
  }

  function sessionHasAnyIndexOwner(sessionId: string): boolean {
    return activeFirstPageIdsRef.current.has(sessionId) || sessionOwnedOutsideFirstPage(sessionId);
  }

  function removeUnownedSessions(candidateIds: ReadonlySet<string>) {
    if (candidateIds.size === 0) return;
    setSessions((current) =>
      current.filter(
        (session) =>
          !candidateIds.has(session.id) ||
          sessionHasAnyIndexOwner(session.id) ||
          selectedSessionIdRef.current === session.id,
      ),
    );
  }

  function replaceSessionOwnerRows(ownerRef: { current: Set<string> }, nextIds: Set<string>, incoming: Session[]) {
    const previousIds = new Set(ownerRef.current);
    ownerRef.current = nextIds;
    setSessions((current) =>
      mergeSessionsById(
        current.filter(
          (session) =>
            !previousIds.has(session.id) ||
            nextIds.has(session.id) ||
            sessionHasAnyIndexOwner(session.id) ||
            selectedSessionIdRef.current === session.id,
        ),
        incoming,
      ),
    );
  }

  function reconcileRejectedIndexRows(ticket: SessionIndexTicket, rows: Session[], eligible: Session[]) {
    const eligibleIds = new Set(eligible.map((session) => session.id));
    if (!sessionIndexCoordinatorRef.current?.isTicketCurrent(ticket)) return;
    for (const session of rows) {
      if (!eligibleIds.has(session.id) && loadedSessionSummary(session.id)) {
        void refreshLoadedSessionSummary(session.id);
      }
    }
  }

  function markSessionSummaryApplied(sessionId: string) {
    sessionSummaryApplicationVersionRef.current.set(
      sessionId,
      (sessionSummaryApplicationVersionRef.current.get(sessionId) ?? 0) + 1,
    );
  }

  function captureSessionSummaryVersions(): Map<string, number> {
    return new Map(sessionSummaryMutationVersionRef.current);
  }

  function sessionSummaryVersionIsCurrent(versions: Map<string, number>, sessionId: string): boolean {
    return sessionSummaryMutationVersionRef.current.get(sessionId) === versions.get(sessionId);
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
    return canCallApi && (!sessionAuthRequired || canWriteSession(currentUser, session));
  }

  async function refreshSessions() {
    await refreshSessionsWithTicket();
  }

  async function refreshSessionsWithTicket(coordinatorTicket?: SessionIndexTicket): Promise<SessionIndexListResult> {
    if (canonicalSessionMutationPendingRef.current.size) {
      await new Promise<void>((resolve) => sessionsRefreshWaitersRef.current.push(resolve));
      if (coordinatorTicket && sessionIndexCoordinatorRef.current?.isTicketCurrent(coordinatorTicket)) {
        return refreshSessionsWithTicket(coordinatorTicket);
      }
      return { satisfiedIds: new Set() };
    }
    if (sessionsRefreshInFlightRef.current) {
      const waitingAuthorityEpoch = sessionSummaryAuthorityEpochRef.current;
      await new Promise<void>((resolve) => sessionsRefreshWaitersRef.current.push(resolve));
      if (coordinatorTicket && sessionIndexCoordinatorRef.current?.isTicketCurrent(coordinatorTicket)) {
        return refreshSessionsWithTicket(coordinatorTicket);
      }
      if (!coordinatorTicket && mountedRef.current && sessionSummaryAuthorityEpochRef.current === waitingAuthorityEpoch)
        return refreshSessionsWithTicket();
      return { satisfiedIds: new Set() };
    }

    const filters = sessionFiltersRef.current;
    const ticketOwner = 'active:first';
    const ticket = coordinatorTicket ?? captureIndexTicket(ticketOwner, { kind: 'active', filters, cursor: null });
    if (!ticket) return { satisfiedIds: new Set() };

    const completionWaiters = sessionsRefreshWaitersRef.current.splice(0);
    const requestId = sessionsRefreshRequestRef.current + 1;
    sessionsRefreshRequestRef.current = requestId;
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    invalidateChildSessionRequests();
    sessionsRefreshInFlightRef.current = true;
    setLoading(true);
    setError('');
    const refreshStartCursor = sessionsNextCursorRef.current;
    const filtersActive = hasActiveSessionFilters(filters);
    const filterOptions = sessionFilterRequestOptions(filters);
    const summaryMutationVersionsAtStart = captureSessionSummaryVersions();
    let satisfiedIds = new Set<string>();
    try {
      const page = await listSessions(tokenRef.current, { limit: sessionListPageSize, ...filterOptions });
      const eligiblePageSessions = indexTicketEligibleRows(ticket, page.sessions);
      if (eligiblePageSessions.length !== page.sessions.length) {
        if (coordinatorTicket) {
          const eligibleIds = new Set(eligiblePageSessions.map((session) => session.id));
          for (const session of page.sessions) {
            if (eligibleIds.has(session.id)) continue;
            sessionIndexCoordinatorRef.current?.requestInvalidation(
              session.id,
              'list',
              sessionHasAnyIndexOwner(session.id) || Boolean(loadedSessionSummary(session.id)),
              filtersActive,
            );
          }
        } else {
          sessionsRefreshQueuedRef.current = true;
        }
        return { satisfiedIds };
      }
      if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return { satisfiedIds };
      if (sessionsRefreshRequestRef.current !== requestId) return { satisfiedIds };
      const selectedId = selectedSessionIdRef.current;
      let selected: Session | null = null;
      let selectedRemoved = false;
      if (selectedId && !page.sessions.some((session) => session.id === selectedId)) {
        try {
          selected = await getSession({ sessionId: selectedId, token: tokenRef.current });
        } catch (err) {
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            selectedRemoved = true;
          } else {
            throw err;
          }
        }
      }
      if (selectedSessionIdRef.current !== selectedId) return { satisfiedIds };
      if (sessionsRefreshRequestRef.current !== requestId) return { satisfiedIds };
      const eligibleSelected = selected ? (indexTicketEligibleRows(ticket, [selected])[0] ?? null) : null;
      if (selected && !eligibleSelected) {
        if (coordinatorTicket) {
          sessionIndexCoordinatorRef.current?.requestInvalidation(
            selected.id,
            'list',
            sessionHasAnyIndexOwner(selected.id) || Boolean(loadedSessionSummary(selected.id)),
            filtersActive,
          );
        } else {
          sessionsRefreshQueuedRef.current = true;
        }
        return { satisfiedIds };
      }
      const cursorAdvancedDuringRefresh = sessionsNextCursorRef.current !== refreshStartCursor;
      selected = eligibleSelected;
      const selectedSummaryChanged =
        selectedId &&
        sessionSummaryMutationVersionRef.current.get(selectedId) !== summaryMutationVersionsAtStart.get(selectedId);
      const selectedWasRemoved = selectedRemoved && !selectedSummaryChanged;
      if (!selectedSummaryChanged) {
        setSupplementalSelectedSession(filtersActive && selected && !selectedWasRemoved ? selected : null);
      }
      for (const session of selected ? [...eligiblePageSessions, selected] : eligiblePageSessions) {
        markSessionSummaryApplied(session.id);
      }
      invalidateChildSessionRequests();
      const incomingIds = new Set(eligiblePageSessions.map((session) => session.id));
      const oldFirstPageIds = new Set(activeFirstPageIdsRef.current);
      const releasedChildIds = new Set<string>();
      for (const ids of childSessionIdsRef.current.values()) {
        for (const id of ids) releasedChildIds.add(id);
      }
      childSessionIdsRef.current.clear();
      for (const id of incomingIds) activePaginationIdsRef.current.delete(id);
      satisfiedIds = new Set(incomingIds);
      if (selected) satisfiedIds.add(selected.id);
      if (!cursorAdvancedDuringRefresh) {
        for (const id of oldFirstPageIds) {
          if (!incomingIds.has(id) && !sessionOwnedOutsideFirstPage(id)) satisfiedIds.add(id);
        }
      }
      setSessions((current) => {
        const incoming = selected && !filtersActive ? [...eligiblePageSessions, selected] : eligiblePageSessions;
        const withoutOmittedFirstPage = cursorAdvancedDuringRefresh
          ? current
          : current.filter(
              (session) =>
                !oldFirstPageIds.has(session.id) ||
                incomingIds.has(session.id) ||
                sessionOwnedOutsideFirstPage(session.id),
            );
        const withoutReleasedChildren = withoutOmittedFirstPage.filter(
          (session) =>
            !releasedChildIds.has(session.id) ||
            sessionHasAnyIndexOwner(session.id) ||
            selectedSessionIdRef.current === session.id,
        );
        const next = filtersActive
          ? mergeSessionsById(
              cursorAdvancedDuringRefresh
                ? withoutReleasedChildren
                : withoutReleasedChildren.filter(
                    (session) =>
                      session.status === 'archived' ||
                      !sessionSummaryVersionIsCurrent(summaryMutationVersionsAtStart, session.id),
                  ),
              incoming,
            )
          : mergeSessionsById(withoutReleasedChildren, incoming);
        if (!cursorAdvancedDuringRefresh) activeFirstPageIdsRef.current = incomingIds;
        return selectedWasRemoved && selectedId ? next.filter((session) => session.id !== selectedId) : next;
      });
      if (!coordinatorTicket) reconcileRejectedIndexRows(ticket, page.sessions, eligiblePageSessions);
      setSessionsNextCursor((current) => {
        const next = current !== refreshStartCursor ? current : page.nextCursor;
        sessionsNextCursorRef.current = next;
        return next;
      });
      setSessionsLoaded(true);
      setSelectedSessionId((current) => {
        if (selectedWasRemoved && current === selectedId) {
          sessionStorage.removeItem(selectedSessionStorageKey);
          return '';
        }
        if (current) return current;
        if (sessionStorage.getItem(newSessionSelectedStorageKey) === 'true') return '';
        const next = eligiblePageSessions[0]?.id ?? selected?.id ?? '';
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
      return { satisfiedIds };
    } catch (err) {
      if (
        sessionSummaryAuthorityEpochRef.current === authorityEpoch &&
        sessionsRefreshRequestRef.current === requestId
      ) {
        setSessionsLoaded(true);
        handleApiError(err);
      }
      return { satisfiedIds };
    } finally {
      if (!coordinatorTicket) sessionIndexCoordinatorRef.current?.release(ticket);
      if (sessionsRefreshRequestRef.current === requestId || !sessionsRefreshQueuedRef.current) setLoading(false);
      sessionsRefreshInFlightRef.current = false;
      for (const resolve of [...completionWaiters, ...sessionsRefreshWaitersRef.current.splice(0)]) resolve();
      if (sessionsRefreshQueuedRef.current) {
        sessionsRefreshQueuedRef.current = false;
        scheduleSessionsRefresh(0);
      }
    }
  }

  async function refreshLoadedSessionSummary(
    sessionId: string,
    includeUnloaded = false,
    coordinatorAuthority?: { generation: number; context: SessionIndexContext },
  ) {
    if (!sessionId || (!includeUnloaded && !sessionsRef.current.some((session) => session.id === sessionId))) return;
    if (
      coordinatorAuthority &&
      !sessionIndexCoordinatorRef.current?.isSummaryCurrent(
        sessionId,
        coordinatorAuthority.generation,
        coordinatorAuthority.context,
      )
    )
      return;
    const inFlight = sessionSummaryRefreshInFlightRef.current;
    const currentOperation = inFlight.get(sessionId);
    if (currentOperation) {
      if (coordinatorAuthority) {
        await currentOperation.promise;
        if (
          mountedRef.current &&
          sessionIndexCoordinatorRef.current?.isSummaryCurrent(
            sessionId,
            coordinatorAuthority.generation,
            coordinatorAuthority.context,
          )
        ) {
          await refreshLoadedSessionSummary(sessionId, includeUnloaded, coordinatorAuthority);
        }
      } else {
        sessionSummaryRefreshQueuedRef.current.add(sessionId);
      }
      return;
    }
    if (sessionStatusMutationPendingRef.current.has(sessionId)) {
      sessionSummaryRefreshQueuedRef.current.add(sessionId);
      return;
    }
    const mutationGeneration = sessionSummaryMutationVersionRef.current.get(sessionId) ?? 0;
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    const operation = Symbol(sessionId);
    let resolveOperation: () => void = () => undefined;
    const operationPromise = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    inFlight.set(sessionId, { operation, promise: operationPromise, resolve: resolveOperation });
    try {
      const session = await getSession({ sessionId, token: tokenRef.current });
      if (!mountedRef.current || sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return;
      if (
        coordinatorAuthority &&
        !sessionIndexCoordinatorRef.current?.satisfyDirectSummary(
          sessionId,
          coordinatorAuthority.generation,
          coordinatorAuthority.context,
        )
      )
        return;
      if (
        sessionStatusMutationPendingRef.current.has(sessionId) ||
        (sessionSummaryMutationVersionRef.current.get(sessionId) ?? 0) !== mutationGeneration
      ) {
        sessionSummaryRefreshQueuedRef.current.add(sessionId);
        return;
      }
      applySessionListUpdate(session);
    } catch (err) {
      if (!mountedRef.current || sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return;
      if (
        coordinatorAuthority &&
        !sessionIndexCoordinatorRef.current?.isSummaryCurrent(
          sessionId,
          coordinatorAuthority.generation,
          coordinatorAuthority.context,
        )
      )
        return;
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
      const finishingOperation = inFlight.get(sessionId);
      if (finishingOperation?.operation === operation) {
        inFlight.delete(sessionId);
        finishingOperation.resolve();
      }
      if (
        mountedRef.current &&
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
    const filters = sessionFiltersRef.current;
    const cursor = sessionsNextCursor;
    const ticket = captureIndexTicket('active:more', { kind: 'active', filters, cursor });
    if (!ticket) return;
    const requestId = sessionsRefreshRequestRef.current;
    let retry = false;
    setSessionsLoadingMore(true);
    setError('');
    try {
      const page = await listSessions(token, {
        cursor,
        limit: sessionListPageSize,
        ...sessionFilterRequestOptions(filters),
      });
      if (!sessionIndexCoordinatorRef.current?.isTicketCurrent(ticket)) return;
      const eligible = indexTicketEligibleRows(ticket, page.sessions);
      if (eligible.length !== page.sessions.length) {
        retry = true;
        return;
      }
      if (sessionsRefreshRequestRef.current !== requestId) return;
      for (const session of eligible) markSessionSummaryApplied(session.id);
      setSessions((current) => mergeSessionsById(current, eligible));
      for (const session of eligible) activePaginationIdsRef.current.add(session.id);
      setSessionOrderIds((current) => [
        ...current,
        ...eligible.map((session) => session.id).filter((id) => !current.includes(id)),
      ]);
      sessionsNextCursorRef.current = page.nextCursor;
      setSessionsNextCursor(page.nextCursor);
    } catch (err) {
      if (sessionsRefreshRequestRef.current !== requestId) return;
      handleApiError(err);
    } finally {
      sessionIndexCoordinatorRef.current?.release(ticket);
      if (sessionsRefreshRequestRef.current === requestId) setSessionsLoadingMore(false);
      if (retry && mountedRef.current && sessionsRefreshRequestRef.current === requestId) {
        window.setTimeout(() => void loadMoreSessions(), 0);
      }
    }
  }

  async function loadChildSessions(parent: Session) {
    if (childSessionsLoading.has(parent.id) || !canCallApi) return;
    const requestEpoch = childSessionRequestEpochRef.current;
    const cursor = childSessionCursors.get(parent.id);
    const filters = sessionFiltersRef.current;
    const ticket = captureIndexTicket(`children:${parent.id}`, {
      kind: 'children',
      parent: parent.id,
      archived: parent.status === 'archived',
      filters,
      cursor: cursor ?? null,
    });
    if (!ticket) return;
    let retry = false;
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
      if (!sessionIndexCoordinatorRef.current?.isTicketCurrent(ticket)) return;
      const eligible = indexTicketEligibleRows(ticket, page.sessions);
      if (eligible.length !== page.sessions.length) {
        retry = true;
        return;
      }
      if (childSessionRequestEpochRef.current !== requestEpoch) return;
      for (const session of eligible) markSessionSummaryApplied(session.id);
      const previousOwned = new Set(childSessionIdsRef.current.get(parent.id));
      const owned = cursor ? new Set(previousOwned) : new Set<string>();
      for (const session of eligible) owned.add(session.id);
      childSessionIdsRef.current.set(parent.id, owned);
      setSessions((current) =>
        mergeSessionsById(
          current.filter(
            (session) =>
              Boolean(cursor) ||
              !previousOwned.has(session.id) ||
              owned.has(session.id) ||
              sessionHasAnyIndexOwner(session.id) ||
              selectedSessionIdRef.current === session.id,
          ),
          eligible,
        ),
      );
      setSessionOrderIds((current) => [
        ...current,
        ...eligible.map((session) => session.id).filter((id) => !current.includes(id)),
      ]);
      setChildSessionCursors((current) => new Map(current).set(parent.id, page.nextCursor));
    } catch (err) {
      if (childSessionRequestEpochRef.current !== requestEpoch) return;
      handleApiError(err);
    } finally {
      sessionIndexCoordinatorRef.current?.release(ticket);
      if (childSessionRequestEpochRef.current === requestEpoch) {
        setChildSessionsLoading((current) => {
          const next = new Set(current);
          next.delete(parent.id);
          return next;
        });
        if (retry && mountedRef.current) window.setTimeout(() => void loadChildSessions(parent), 0);
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
    const requestCursor = reset ? null : cursor;
    const ticket = captureIndexTicket('archived', {
      kind: 'archived',
      filters,
      cursor: requestCursor,
    });
    if (!ticket) return;
    let retry = false;
    setArchivedSessionsLoading(true);
    setError('');
    try {
      const page = await listSessions(token, {
        archived: true,
        limit: sessionListPageSize,
        ...sessionFilterRequestOptions(filters),
        ...(reset || !cursor ? {} : { cursor }),
      });
      if (!sessionIndexCoordinatorRef.current?.isTicketCurrent(ticket)) return;
      const eligible = indexTicketEligibleRows(ticket, page.sessions);
      if (eligible.length !== page.sessions.length) {
        retry = true;
        return;
      }
      if (archivedSessionsRequestRef.current !== requestId) return;
      for (const session of eligible) markSessionSummaryApplied(session.id);
      if (reset || !cursor) {
        replaceSessionOwnerRows(archivedSessionIdsRef, new Set(eligible.map((session) => session.id)), eligible);
      } else {
        for (const session of eligible) archivedSessionIdsRef.current.add(session.id);
        setSessions((current) => mergeSessionsById(current, eligible));
      }
      setSessionOrderIds((current) => [
        ...current,
        ...eligible.map((session) => session.id).filter((id) => !current.includes(id)),
      ]);
      setArchivedSessionsNextCursor(page.nextCursor);
      setArchivedSessionsLoaded(true);
    } catch (err) {
      if (archivedSessionsRequestRef.current !== requestId) return;
      handleApiError(err);
    } finally {
      sessionIndexCoordinatorRef.current?.release(ticket);
      if (archivedSessionsRequestRef.current === requestId) setArchivedSessionsLoading(false);
      if (retry && mountedRef.current && archivedSessionsRequestRef.current === requestId) {
        window.setTimeout(() => void loadArchivedSessions(reset), 0);
      }
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
    const ticket = captureIndexTicket('search:more', {
      kind: 'search',
      query,
      filters: sessionFiltersRef.current,
      cursor,
    });
    if (!ticket) return;
    setSessionSearchLoadingMore(true);
    setError('');
    const summaryEpoch = sessionSearchSummaryEpochRef.current;
    try {
      const page = await searchSessions(token, {
        query,
        cursor,
        limit: sessionSearchPageSize,
        ...sessionFilterRequestOptions(sessionFiltersRef.current),
      });
      if (sessionSearchRequestRef.current !== requestId || sessionSearchQueryRef.current.trim() !== query) return;
      if (!sessionIndexCoordinatorRef.current?.isTicketCurrent(ticket)) return;
      const rows = page.results.map((result) => result.session);
      const eligible = indexTicketEligibleRows(ticket, rows);
      if (eligible.length !== rows.length) {
        sessionIndexCoordinatorRef.current?.release(ticket);
        setSessionSearchRefreshVersion((current) => current + 1);
        return;
      }
      if (sessionSearchSummaryEpochRef.current !== summaryEpoch) {
        sessionIndexCoordinatorRef.current?.release(ticket);
        setSessionSearchRefreshVersion((current) => current + 1);
        return;
      }
      for (const session of eligible) markSessionSummaryApplied(session.id);
      setSessionSearchResults((current) => mergeSessionSearchResultsById(current, page.results));
      for (const session of eligible) searchSessionIdsRef.current.add(session.id);
      setSessions((current) => mergeSessionsById(current, eligible));
      setSessionSearchNextCursor(page.nextCursor);
    } catch (err) {
      if (sessionSearchRequestRef.current !== requestId) return;
      handleApiError(err);
    } finally {
      sessionIndexCoordinatorRef.current?.release(ticket);
      if (sessionSearchRequestRef.current === requestId) setSessionSearchLoadingMore(false);
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
    const context = selectedResourceContext(sessionId);
    if (!isSelectedResourceContextCurrent(context)) return null;
    const loadGeneration = sessionDetailLoadGenerationRef.current + 1;
    sessionDetailLoadGenerationRef.current = loadGeneration;
    const displacedResources = supersedeForSelectedSnapshot(context, new Set(selectedDetailResources));
    const resourceVersions = captureSelectedResourceVersions(context);
    try {
      const loaded = await loadSessionDetailPhases({ sessionId, token, ...(signal ? { signal } : {}) }).allReady;
      if (sessionSummaryAuthorityEpochRef.current !== authorityEpoch) return null;
      if (sessionDetailLoadGenerationRef.current !== loadGeneration) return null;
      if (signal?.aborted) return null;
      if (selectedSessionIdRef.current !== sessionId) return null;
      eventCursor.current = Math.max(eventCursor.current, loaded.events.at(-1)?.sequence ?? 0);
      for (const event of loaded.events) {
        recordNotepadChange(event);
        appliedSelectedEventSequencesRef.current.add(event.sequence);
      }
      setSessionDetail((current) => {
        const messages = selectedResourceVersionIsCurrent(context, resourceVersions, 'messages')
          ? loaded.messages
          : current.messages;
        const mergedEvents = mergeEventsBySequence(current.events, loaded.events);
        const events = filterActiveProgressEvents(mergedEvents, messages);
        return {
          messages,
          events,
          activeProgress: buildActiveProgress(mergedEvents, messages),
          artifacts: selectedResourceVersionIsCurrent(context, resourceVersions, 'artifacts')
            ? mergeEntitiesById(loaded.artifacts, current.artifacts)
            : current.artifacts,
          services: selectedResourceVersionIsCurrent(context, resourceVersions, 'services')
            ? loaded.services
            : current.services,
          externalResources: selectedResourceVersionIsCurrent(context, resourceVersions, 'externalResources')
            ? mergeEntitiesById(loaded.externalResources, current.externalResources)
            : current.externalResources,
          callbacks: selectedResourceVersionIsCurrent(context, resourceVersions, 'callbacks')
            ? loaded.callbacks
            : current.callbacks,
        };
      });
      satisfySelectedSnapshotDisplacement(new Set(selectedDetailResources));
      detailLoadedSessionIdRef.current = sessionId;
      setDetailLoadedSessionId(sessionId);
      return loaded;
    } catch (err) {
      if (
        !isSelectedResourceContextCurrent(context) ||
        sessionDetailLoadGenerationRef.current !== loadGeneration ||
        signal?.aborted
      ) {
        return null;
      }
      restoreDisplacedSelectedResources(context, displacedResources, resourceVersions);
      if (handleErrors && !signal?.aborted) handleApiError(err);
      return null;
    }
  }

  async function backfillCreatedSessionUntilSettled(
    context: SelectedResourceContext,
    messageId: string,
    signal: AbortSignal,
  ) {
    for (let attempt = 0; attempt < createdSessionBackfillAttempts; attempt += 1) {
      if (signal.aborted || !isSelectedResourceContextCurrent(context)) return;
      try {
        const recoveredEvents = await listIncrementalEvents(context.sessionId, tokenRef.current, eventCursor.current, {
          signal,
        });
        if (signal.aborted || !isSelectedResourceContextCurrent(context)) return;
        let reconcileSummary = false;
        for (const event of recoveredEvents) {
          applySynchronizedSessionEvent(event, false);
          if (planSessionEvent(event).sessionEffect === 'summary') reconcileSummary = true;
        }
        if (reconcileSummary) {
          markSessionSummaryChanged(context.sessionId);
          void refreshLoadedSessionSummary(context.sessionId);
        }
        if (recoveredEvents.some((event) => isTerminalMessageEvent(event, messageId))) return;
      } catch {
        if (signal.aborted || !isSelectedResourceContextCurrent(context)) return;
      }
      if (messagesRef.current.some((message) => message.id === messageId && isTerminalMessageStatus(message.status)))
        return;
      await waitForSynchronizationDelay(createdSessionBackfillDelayMs, signal);
    }
    if (!signal.aborted) reconcileSelectedMessagesAndSummaryOnce(context);
  }

  async function refreshSessionDetailWithMilestones(sessionId: string, trigger: BrowserMilestoneTrigger) {
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    const context = selectedResourceContext(sessionId);
    if (!isSelectedResourceContextCurrent(context)) return;
    const loadGeneration = sessionDetailLoadGenerationRef.current + 1;
    sessionDetailLoadGenerationRef.current = loadGeneration;
    const displacedResources = supersedeForSelectedSnapshot(context, new Set(selectedDetailResources));
    const resourceVersions = captureSelectedResourceVersions(context);
    const requestIsCurrent = () =>
      sessionSummaryAuthorityEpochRef.current === authorityEpoch &&
      sessionDetailLoadGenerationRef.current === loadGeneration &&
      selectedSessionIdRef.current === sessionId;
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
        eventCursor.current = Math.max(eventCursor.current, detail.events.at(-1)?.sequence ?? 0);
        for (const event of detail.events) {
          recordNotepadChange(event);
          appliedSelectedEventSequencesRef.current.add(event.sequence);
        }
        setSessionDetail((current) => {
          const messages = selectedResourceVersionIsCurrent(context, resourceVersions, 'messages')
            ? detail.messages
            : current.messages;
          const mergedEvents = mergeEventsBySequence(current.events, detail.events);
          const events = filterActiveProgressEvents(mergedEvents, messages);
          return {
            ...current,
            messages,
            events,
            activeProgress: buildActiveProgress(mergedEvents, messages),
          };
        });
        satisfySelectedSnapshotDisplacement(new Set(['messages']));
        detailLoadedSessionIdRef.current = sessionId;
        setDetailLoadedSessionId(sessionId);
        milestones.detail.success({
          messageCount: detail.messages.length,
          eventCount: detail.events.length,
        });
        return detail;
      })
      .catch((err) => {
        if (!requestIsCurrent()) return;
        restoreDisplacedSelectedResources(context, displacedResources, resourceVersions, new Set(['messages']));
        milestones.detail.error(componentName(err, 'render'));
        handleApiError(componentCause(err));
        return null;
      });

    const outputsPromise = phases.outputsReady
      .then(async (outputs) => {
        const detail = await detailReadyPromise;
        if (!detail) {
          if (requestIsCurrent()) {
            restoreDisplacedSelectedResources(
              context,
              displacedResources,
              resourceVersions,
              new Set(['artifacts', 'externalResources', 'callbacks']),
            );
            milestones.outputs.error('render');
          }
          return;
        }
        if (!requestIsCurrent()) {
          milestones.outputs.abort('selection_change');
          return;
        }
        setSessionDetail((current) => ({
          ...current,
          artifacts: selectedResourceVersionIsCurrent(context, resourceVersions, 'artifacts')
            ? mergeEntitiesById(outputs.artifacts, current.artifacts)
            : current.artifacts,
          externalResources: selectedResourceVersionIsCurrent(context, resourceVersions, 'externalResources')
            ? mergeEntitiesById(outputs.externalResources, current.externalResources)
            : current.externalResources,
          callbacks: selectedResourceVersionIsCurrent(context, resourceVersions, 'callbacks')
            ? outputs.callbacks
            : current.callbacks,
        }));
        satisfySelectedSnapshotDisplacement(new Set(['artifacts', 'externalResources', 'callbacks']));
        milestones.outputs.success({
          inlineArtifactCount: countInlineArtifacts(outputs.artifacts, detail.messages, detail.events),
          artifactCount: outputs.artifacts.length,
          externalResourceCount: outputs.externalResources.length,
          callbackCount: outputs.callbacks.length,
        });
      })
      .catch((err) => {
        if (!requestIsCurrent()) return;
        restoreDisplacedSelectedResources(
          context,
          displacedResources,
          resourceVersions,
          new Set(['artifacts', 'externalResources', 'callbacks']),
        );
        milestones.outputs.error(componentName(err, 'render'));
        handleApiError(componentCause(err));
      });

    const servicesLoadPromise = phases.servicesReady
      .then(async (nextServices) => {
        if (!(await detailReadyPromise)) {
          if (requestIsCurrent()) {
            restoreDisplacedSelectedResources(context, displacedResources, resourceVersions, new Set(['services']));
            milestones.services.error('render');
          }
          return;
        }
        if (!requestIsCurrent()) {
          milestones.services.abort('selection_change');
          return;
        }
        if (selectedResourceVersionIsCurrent(context, resourceVersions, 'services')) {
          setSessionDetail((current) => ({ ...current, services: nextServices }));
        }
        satisfySelectedSnapshotDisplacement(new Set(['services']));
        milestones.services.success({ serviceCount: nextServices.length });
      })
      .catch((err) => {
        if (!requestIsCurrent()) return;
        restoreDisplacedSelectedResources(context, displacedResources, resourceVersions, new Set(['services']));
        milestones.services.error(componentName(err, 'services'));
        handleApiError(componentCause(err));
      });

    void Promise.all([detailReadyPromise, outputsPromise, servicesLoadPromise]).then(() => {
      if (sessionMilestoneInteractionRef.current === milestones) sessionMilestoneInteractionRef.current = null;
    });

    await detailReadyPromise;
  }

  async function handleCreateThread(input: {
    prompt: string;
    skills: string[];
    skillRefs: Array<{ id: string; name: string }>;
    visibility: 'tenant' | 'private';
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
        visibility: input.visibility,
        token,
      });
      markSessionSummaryChanged(session.id);
      // Mark the new session as the active realtime target before enqueueing the
      // first message. Fast deployments can emit completion events before React
      // commits the selected-session state below; the pending ref lets the SSE
      // handler accept only this new session without treating full detail as loaded.
      resetIncrementalRecovery();
      sessionSelectionVersionRef.current += 1;
      sessionDetailLoadGenerationRef.current += 1;
      selectedSessionIdRef.current = session.id;
      selectedResourceCoordinatorRef.current?.setContext(selectedResourceContext(session.id));
      pendingCreatedSessionIdRef.current = session.id;
      eventCursor.current = 0;
      let message: Message;
      try {
        message = await enqueueMessage({
          sessionId: session.id,
          prompt: firstPrompt,
          token,
          ...(firstPrompt ? { generateTitle: true } : {}),
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
            const archivedSession = await archiveSession({ sessionId: session.id, token });
            markSessionSummaryChanged(archivedSession.id);
            setSessions((current) => current.filter((candidate) => candidate.id !== archivedSession.id));
            setSessionSearchResults((current) => current.filter((result) => result.session.id !== archivedSession.id));
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
      markSessionSummaryChanged(session.id);
      setSessions((current) => [
        {
          ...session,
          ...(sessionContext ? { context: sessionContext } : {}),
          status: session.status === 'active' ? 'active' : 'queued',
          updatedAt: message.createdAt,
          lastActivityAt: message.createdAt,
        },
        ...current.filter((candidate) => candidate.id !== session.id),
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
      backfillCreatedSessionUntilSettled(selectedResourceContext(session.id), message.id, backfillAbort.signal)
        .catch(() => undefined)
        .finally(() => {
          if (createdSessionBackfillAbortRef.current === backfillAbort) createdSessionBackfillAbortRef.current = null;
        });
      updateNavigation({ isCreatingThread: false });
      return true;
    } catch (err) {
      if (pendingCreatedSessionIdRef.current) {
        pendingCreatedSessionIdRef.current = '';
        resetIncrementalRecovery();
        sessionSelectionVersionRef.current += 1;
        sessionDetailLoadGenerationRef.current += 1;
        selectedSessionIdRef.current = previousSelectedSessionId;
        selectedResourceCoordinatorRef.current?.setContext(selectedResourceContext(previousSelectedSessionId));
        eventCursor.current = 0;
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
    const context = selectedResourceContext(selectedSessionId);
    const fallbackAfter = eventCursor.current;
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
      if (!isSelectedResourceContextCurrent(context) || message.sessionId !== context.sessionId) return false;
      applySelectedResourceMutation(context, new Set<DetailResource>(['messages']), (current) => ({
        ...current,
        messages: upsertById(current.messages, message),
      }));
      startSubmissionEventFallback(context, message.id, fallbackAfter);
      const currentSession = sessionsRef.current.find((session) => session.id === selectedSessionId);
      if (currentSession) {
        const sessionContext = mergeDisplaySessionContext(
          currentSession.context,
          message.context,
          followUpEnvironmentId ? 'environment' : followUpRepository.trim() ? 'repository' : undefined,
        );
        applySessionListUpdate({
          ...currentSession,
          ...(sessionContext ? { context: sessionContext } : {}),
          status: currentSession.status === 'active' ? currentSession.status : 'queued',
          updatedAt: message.createdAt,
          lastActivityAt: message.createdAt,
        });
      }
      setThreadAutoFollowEnabled(true);
      return true;
    } catch (err) {
      if (!isSelectedResourceContextCurrent(context)) return false;
      if (err instanceof ApiError && err.code === 'unknown_skill' && input.skills.length)
        skillsWorkspace.actions.setSessionError(errorMessage(err));
      else handleApiError(err);
      return false;
    } finally {
      sendMessageInFlightRef.current = false;
    }
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

  function abortTitleMutationQueues() {
    for (const queue of titleMutationQueuesRef.current.values()) {
      for (const resolve of queue.waiters) resolve(false);
    }
    titleMutationQueuesRef.current.clear();
  }

  function handleUpdateTitle(title: string): Promise<boolean> {
    const nextTitle = title.trim();
    if (!canWriteSelectedSession || !selectedSessionId || !nextTitle) return Promise.resolve(false);
    const sessionId = selectedSessionId;
    const supplementalOnly = isSupplementalSession(sessionId);
    let queue = titleMutationQueuesRef.current.get(sessionId);
    if (!queue) {
      queue = { latest: null, running: false, waiters: [] };
      titleMutationQueuesRef.current.set(sessionId, queue);
    }
    queue.latest = nextTitle;
    const result = new Promise<boolean>((resolve) => queue.waiters.push(resolve));
    if (!queue.running) void runTitleMutationQueue(sessionId, supplementalOnly, queue);
    return result;
  }

  async function runTitleMutationQueue(
    sessionId: string,
    supplementalOnly: boolean,
    queue: { latest: string | null; running: boolean; waiters: Array<(saved: boolean) => void> },
  ) {
    queue.running = true;
    const authorityEpoch = sessionSummaryAuthorityEpochRef.current;
    let saved = false;
    try {
      while (queue.latest && mountedRef.current && sessionSummaryAuthorityEpochRef.current === authorityEpoch) {
        const nextTitle = queue.latest;
        queue.latest = null;
        const mutationVersion = nextSessionMutationVersion(sessionId, 'title');
        markSessionSummaryChanged(sessionId);
        setError('');
        try {
          const session = await updateSession({ sessionId, title: nextTitle, token: tokenRef.current });
          if (
            sessionSummaryAuthorityEpochRef.current !== authorityEpoch ||
            !isCurrentSessionMutation(sessionId, 'title', mutationVersion)
          )
            break;
          if (queue.latest) continue;
          if (selectedSessionIdRef.current === sessionId) {
            const current = loadedSessionSummary(sessionId);
            applySessionListUpdate({ ...(current ?? session), title: nextTitle }, { supplementalOnly });
          }
          saved = true;
        } catch (err) {
          if (queue.latest) continue;
          if (sessionSummaryAuthorityEpochRef.current === authorityEpoch) handleApiError(err);
          saved = false;
        }
      }
    } finally {
      if (titleMutationQueuesRef.current.get(sessionId) === queue) titleMutationQueuesRef.current.delete(sessionId);
      for (const resolve of queue.waiters) resolve(saved);
      queue.waiters = [];
      queue.running = false;
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

  async function handlePromoteSession() {
    if (
      !selectedSessionId ||
      selectedSession?.visibility !== 'private' ||
      selectedSession.ownerUserId !== currentUser?.id ||
      promotingSessionId
    ) {
      return;
    }
    const sessionId = selectedSessionId;
    setPromotingSessionId(sessionId);
    setError('');
    try {
      const promoted = await promoteSession({ sessionId, token });
      markSessionSummaryChanged(sessionId);
      applySessionListUpdate(promoted, { forceKeep: true, supplementalOnly: isSupplementalSession(sessionId) });
    } catch (err) {
      handleApiError(err);
    } finally {
      setPromotingSessionId((current) => (current === sessionId ? '' : current));
    }
  }

  async function startEditingMessage(message: Message) {
    if (!canWriteSelectedSession || !selectedSessionId || message.status !== 'pending') return;
    const context = selectedResourceContext(selectedSessionId);
    const summaryVersion = sessionSummaryMutationVersionRef.current.get(selectedSessionId) ?? 0;
    const summaryApplicationVersion = sessionSummaryApplicationVersionRef.current.get(selectedSessionId) ?? 0;
    const summaryAtStart = loadedSessionSummary(selectedSessionId);
    setError('');
    try {
      const session = await pauseQueue({ sessionId: selectedSessionId, token });
      if (!isSelectedResourceContextCurrent(context) || session.id !== context.sessionId) return;
      applySessionMutationResponse(session, context, summaryVersion, summaryApplicationVersion, summaryAtStart);
      setEditingMessageId(message.id);
      setMessageDraft(message.prompt);
    } catch (err) {
      if (isSelectedResourceContextCurrent(context)) handleApiError(err);
    }
  }

  async function finishEditingMessage(resume: boolean) {
    if (!canWriteSelectedSession || !selectedSessionId || !editingMessageId) return;
    const context = selectedResourceContext(selectedSessionId);
    const summaryVersion = sessionSummaryMutationVersionRef.current.get(selectedSessionId) ?? 0;
    const summaryApplicationVersion = sessionSummaryApplicationVersionRef.current.get(selectedSessionId) ?? 0;
    const summaryAtStart = loadedSessionSummary(selectedSessionId);
    setError('');
    try {
      if (resume) {
        const session = await resumeQueue({ sessionId: selectedSessionId, token });
        if (!isSelectedResourceContextCurrent(context) || session.id !== context.sessionId) return;
        applySessionMutationResponse(session, context, summaryVersion, summaryApplicationVersion, summaryAtStart);
      }
      setEditingMessageId('');
      setMessageDraft('');
    } catch (err) {
      if (isSelectedResourceContextCurrent(context)) handleApiError(err);
    }
  }

  async function saveMessageEdit() {
    const editingMessage = messages.find((message) => message.id === editingMessageId);
    const hasSkills = Array.isArray(editingMessage?.context?.skills) && editingMessage.context.skills.length > 0;
    if (!canWriteSelectedSession || !selectedSessionId || !editingMessageId || (!messageDraft.trim() && !hasSkills))
      return;
    const context = selectedResourceContext(selectedSessionId);
    setError('');
    try {
      const message = await updateMessage({
        sessionId: selectedSessionId,
        messageId: editingMessageId,
        prompt: messageDraft.trim(),
        token,
      });
      if (!isSelectedResourceContextCurrent(context) || message.sessionId !== context.sessionId) return;
      applySelectedResourceMutation(context, new Set<DetailResource>(['messages']), (current) => ({
        ...current,
        messages: current.messages.map((candidate) => (candidate.id === message.id ? message : candidate)),
      }));
      await finishEditingMessage(true);
    } catch (err) {
      if (isSelectedResourceContextCurrent(context)) handleApiError(err);
    }
  }

  async function cancelQueuedMessage(messageId: string) {
    if (!canWriteSelectedSession || !selectedSessionId) return;
    const context = selectedResourceContext(selectedSessionId);
    setError('');
    try {
      const message = await cancelMessage({ sessionId: selectedSessionId, messageId, token });
      if (!isSelectedResourceContextCurrent(context) || message.sessionId !== context.sessionId) return;
      applySelectedResourceMutation(context, new Set<DetailResource>(['messages']), (current) => ({
        ...current,
        messages: current.messages.map((candidate) => (candidate.id === message.id ? message : candidate)),
      }));
    } catch (err) {
      if (isSelectedResourceContextCurrent(context)) handleApiError(err);
    }
  }

  async function toggleMessageSteering(selectedMessage: Message) {
    if (
      !canWriteSelectedSession ||
      !selectedSessionId ||
      selectedMessage.status !== 'pending' ||
      steeringMessageIds.has(selectedMessage.id)
    )
      return;
    const context = selectedResourceContext(selectedSessionId);
    const messagesVersion = selectedResourceCoordinatorRef.current?.captureVersion(context, 'messages') ?? -1;
    setSteeringMessageIds((current) => new Set(current).add(selectedMessage.id));
    setError('');
    try {
      const message = await updateMessageSteering({
        sessionId: selectedSessionId,
        messageId: selectedMessage.id,
        steering: !selectedMessage.steering,
        token,
      });
      if (!isSelectedResourceContextCurrent(context) || message.sessionId !== context.sessionId) return;
      if (!(selectedResourceCoordinatorRef.current?.isVersionCurrent(context, 'messages', messagesVersion) ?? false)) {
        selectedResourceCoordinatorRef.current?.invalidate(context, new Set(['messages']));
        return;
      }
      applySelectedResourceMutation(context, new Set<DetailResource>(['messages']), (current) => ({
        ...current,
        messages: current.messages.map((candidate) => (candidate.id === message.id ? message : candidate)),
      }));
    } catch (err) {
      if (isSelectedResourceContextCurrent(context)) handleApiError(err);
    } finally {
      setSteeringMessageIds((current) => {
        const next = new Set(current);
        next.delete(selectedMessage.id);
        return next;
      });
    }
  }

  async function retryFailedMessages(messageIds: string[]) {
    if (!canWriteSelectedSession || !selectedSessionId || selectedSessionArchived || !messageIds.length) return;
    const context = selectedResourceContext(selectedSessionId);
    setLoading(true);
    setError('');
    try {
      const retriedMessages: Message[] = [];
      for (const messageId of messageIds) {
        const message = await retryMessage({ sessionId: selectedSessionId, messageId, token });
        if (!isSelectedResourceContextCurrent(context) || message.sessionId !== context.sessionId) return;
        retriedMessages.push(message);
      }
      applySelectedResourceMutation(context, new Set<DetailResource>(['messages']), (current) => ({
        ...current,
        messages: retriedMessages.reduce(upsertById, current.messages),
      }));
      setThreadAutoFollowEnabled(true);
    } catch (err) {
      if (isSelectedResourceContextCurrent(context)) handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  async function cancelRun() {
    if (!canWriteSelectedSession || !selectedSessionId) return;
    const context = selectedResourceContext(selectedSessionId);
    setError('');
    try {
      const cancelledMessages = await cancelCurrentRun({ sessionId: selectedSessionId, token });
      if (!isSelectedResourceContextCurrent(context)) return;
      setSessionDetail((current) => ({
        ...current,
        messages: current.messages.map(
          (candidate) => cancelledMessages.find((message) => message.id === candidate.id) ?? candidate,
        ),
      }));
      selectedResourceCoordinatorRef.current?.invalidate(context, new Set<DetailResource>(['messages']));
      markSessionSummaryChanged(context.sessionId);
      await refreshLoadedSessionSummary(context.sessionId);
    } catch (err) {
      if (isSelectedResourceContextCurrent(context)) handleApiError(err);
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
    abortSubmissionFallback();
    clearQueuedActiveProgress();
    messagesRef.current = [];
    appliedSelectedEventSequencesRef.current.clear();
    observedMessageCreatedIdsRef.current.clear();
    detailLoadedSessionIdRef.current = '';
    setSessionDetail(emptySessionDetail());
  }

  function signOut() {
    abortCreatedSessionBackfill();
    resetAuthBoundSessionState();
    sessionSelectionVersionRef.current += 1;
    sessionDetailLoadGenerationRef.current += 1;
    selectedSessionIdRef.current = '';
    selectedResourceCoordinatorRef.current?.setContext(selectedResourceContext(''));
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
    snippetMutationVersionRef.current += 1;
    setSnippetMutationPending(false);
    setSnippetsLoading(false);
    setSnippets([]);
    snippetDirtyRef.current = false;
    setToken('');
    setDraftToken('');
    sessionStorage.removeItem(selectedSessionStorageKey);
    clearSessionSearchParam();
    sessionStorage.removeItem(newSessionSelectedStorageKey);
    sessionStorage.removeItem(sidebarPanelStorageKey);
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
    setEnvironmentsState({ data: [], loading: false, error: '' });
    setSessionsLoaded(false);
    setDetailLoadedSessionId('');
    updateNavigation({
      selectedSessionId: '',
      selectedAutomationId: '',
      selectedEnvironmentId: '',
      selectedEnvironmentRevisionId: '',
      selectedSkillId: '',
      selectedSkillRevisionId: '',
      selectedSnippetId: '',
      sidebarPanel: 'sessions',
      isCreatingThread: false,
      setupGuideOpen: false,
      instanceAccessOpen: false,
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
    resetIncrementalRecovery();
    sessionSelectionVersionRef.current += 1;
    sessionDetailLoadGenerationRef.current += 1;
    selectedSessionIdRef.current = '';
    selectedResourceCoordinatorRef.current?.setContext(selectedResourceContext(''));
    exitSessionLineageReveal();
    abortCreatedSessionBackfill();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
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
      instanceAccessOpen: false,
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
    const selectionChanged = selectedSessionIdRef.current !== sessionId;
    if (selectionChanged) abortCreatedSessionBackfill();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    autoScrolledSessionId.current = '';
    if (selectionChanged) {
      resetIncrementalRecovery();
      pendingSessionMilestoneTriggerRef.current = 'selection';
      sessionSelectionVersionRef.current += 1;
      sessionDetailLoadGenerationRef.current += 1;
      selectedSessionIdRef.current = sessionId;
      selectedResourceCoordinatorRef.current?.setContext(selectedResourceContext(sessionId));
      clearSessionDetail();
      eventCursor.current = 0;
    }
    sessionStorage.setItem(selectedSessionStorageKey, sessionId);
    sessionStorage.setItem(sidebarPanelStorageKey, 'sessions');
    setSessionSearchParam(sessionId);
    sessionStorage.removeItem(newSessionSelectedStorageKey);
    updateNavigation({
      selectedSessionId: sessionId,
      sidebarPanel: 'sessions',
      isCreatingThread: false,
      setupGuideOpen: false,
      instanceAccessOpen: false,
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
    updateNavigation({ setupGuideOpen: true, instanceAccessOpen: false });
    setSidebarOpen(false);
  }

  function openInstanceAccessPanel() {
    if (!canViewInstanceAccess || !confirmDiscardEditorChanges()) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    clearResourceSearchParams();
    updateNavigation({ setupGuideOpen: false, instanceAccessOpen: true, sidebarPanel: 'sessions' });
    setSidebarOpen(false);
  }

  function openAutomationsPanel() {
    if (!canViewAutomations) return;
    if (!confirmDiscardEditorChanges()) return;
    const desktop = isDesktopViewport();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'automations');
    if (selectedAutomationId) setAutomationSearchParam(selectedAutomationId);
    else clearResourceSearchParams();
    updateNavigation({
      setupGuideOpen: false,
      instanceAccessOpen: false,
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
    sessionStorage.setItem(sidebarPanelStorageKey, 'environments');
    if (selectedEnvironmentId) {
      if (!skillsWorkspace.actions.navigateToEnvironment(selectedEnvironmentId, selectedEnvironmentRevisionId)) return;
    } else {
      clearResourceSearchParams();
      updateNavigation({
        setupGuideOpen: false,
        instanceAccessOpen: false,
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
    sessionStorage.removeItem(selectedEnvironmentStorageKey);
    clearResourceSearchParams();
    sessionStorage.setItem(sidebarPanelStorageKey, 'environments');
    updateNavigation({
      setupGuideOpen: false,
      instanceAccessOpen: false,
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
    sessionStorage.removeItem(selectedAutomationStorageKey);
    clearResourceSearchParams();
    sessionStorage.setItem(sidebarPanelStorageKey, 'automations');
    updateNavigation({
      setupGuideOpen: false,
      instanceAccessOpen: false,
      sidebarPanel: 'automations',
      isCreatingThread: false,
      selectedAutomationId: '',
    });
    if (!isDesktopViewport()) setSidebarOpen(false);
  }

  function selectAutomationPanel(automationId: string) {
    if (!canViewAutomations) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'automations');
    sessionStorage.setItem(selectedAutomationStorageKey, automationId);
    setAutomationSearchParam(automationId);
    updateNavigation({
      setupGuideOpen: false,
      instanceAccessOpen: false,
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
      instanceAccessOpen: false,
      sidebarPanel: 'automations',
      isCreatingThread: false,
      selectedAutomationId: automation.id,
    });
  }

  function selectEnvironmentPanel(environmentId: string) {
    if (!canViewEnvironments) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
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
    markSessionSummaryChanged(session.id);
    setSessions((current) => [session, ...current.filter((candidate) => candidate.id !== session.id)]);
    selectSession(session.id);
  }

  function showSessionsSidebar() {
    if (!confirmDiscardEditorChanges()) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'sessions');
    if (selectedSessionId) setSessionSearchParam(selectedSessionId);
    else clearResourceSearchParams();
    updateNavigation({ setupGuideOpen: false, instanceAccessOpen: false, sidebarPanel: 'sessions' });
    setSidebarCollapsed(false);
    setSidebarOpen(true);
  }

  function backToSessionsSidebar() {
    if (!confirmDiscardEditorChanges()) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'sessions');
    if (selectedSessionId) setSessionSearchParam(selectedSessionId);
    else clearResourceSearchParams();
    updateNavigation({ setupGuideOpen: false, instanceAccessOpen: false, sidebarPanel: 'sessions' });
    setSidebarCollapsed(false);
    setSidebarOpen(true);
  }

  function confirmDiscardEditorChanges(): boolean {
    if (sidebarPanel === 'skills' && !skillsWorkspace.actions.confirmDiscard()) return false;
    if (sidebarPanel === 'snippets' && snippetDirtyRef.current) {
      if (!window.confirm('Discard unsaved snippet changes?')) return false;
      snippetDirtyRef.current = false;
    }
    if (sidebarPanel === 'environments' && environmentEditorDirtyRef.current) {
      if (!window.confirm('Discard unsaved environment changes?')) return false;
      setEnvironmentEditorDirty(false);
    }
    return true;
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
      resetIncrementalRecovery();
      sessionSelectionVersionRef.current += 1;
      sessionDetailLoadGenerationRef.current += 1;
      selectedSessionIdRef.current = rollback.selectedSessionId;
      selectedResourceCoordinatorRef.current?.setContext(selectedResourceContext(rollback.selectedSessionId));
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
    markSessionSummaryChanged(parent.id);
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
    markSessionSummaryChanged(session.id);
    markSessionSummaryApplied(session.id);
    setRevealedSessionLineage((current) =>
      current.map((candidate) => (candidate.id === session.id ? session : candidate)),
    );
    setSelectedSessionParent((current) => {
      if (current?.id !== session.id) return current;
      selectedSessionParentRef.current = session;
      return session;
    });
    setSupplementalSelectedSession((current) => {
      if (current?.id !== session.id) return current;
      supplementalSelectedSessionRef.current = session;
      return session;
    });
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

  function applySessionMutationResponse(
    session: Session,
    context: SelectedResourceContext,
    summaryVersion: number,
    summaryApplicationVersion: number,
    summaryAtStart: Session | null,
  ): boolean {
    if (!isSelectedResourceContextCurrent(context) || session.id !== context.sessionId) return false;
    const current = loadedSessionSummary(session.id);
    const applicationChanged =
      (sessionSummaryApplicationVersionRef.current.get(session.id) ?? 0) !== summaryApplicationVersion;
    if (applicationChanged) {
      void refreshLoadedSessionSummary(session.id, true);
      return false;
    }
    const summaryChanged =
      (sessionSummaryMutationVersionRef.current.get(session.id) ?? 0) !== summaryVersion || current !== summaryAtStart;
    if (summaryChanged && (!current || !sessionUpdatedAfter(session, current))) {
      void refreshLoadedSessionSummary(session.id, true);
      return false;
    }
    applySessionListUpdate(session);
    return true;
  }

  function loadedSessionSummary(sessionId: string): Session | null {
    return (
      sessionsRef.current.find((candidate) => candidate.id === sessionId) ??
      sessionSearchResults.find((result) => result.session.id === sessionId)?.session ??
      revealedSessionLineage.find((candidate) => candidate.id === sessionId) ??
      (selectedSessionParentRef.current?.id === sessionId ? selectedSessionParentRef.current : null) ??
      (supplementalSelectedSessionRef.current?.id === sessionId ? supplementalSelectedSessionRef.current : null)
    );
  }

  async function handleReplayCallback(callbackId: string) {
    if (!canWriteSelectedSession || !selectedSessionId) return;
    const context = selectedResourceContext(selectedSessionId);
    setError('');
    try {
      const callback = await replayCallback({ sessionId: selectedSessionId, callbackId, token });
      if (!isSelectedResourceContextCurrent(context) || callback.sessionId !== context.sessionId) return;
      applySelectedResourceMutation(context, new Set<DetailResource>(['callbacks']), (current) => ({
        ...current,
        callbacks: upsertById(current.callbacks, callback),
      }));
    } catch (err) {
      if (isSelectedResourceContextCurrent(context)) handleApiError(err);
    }
  }

  async function handleExtendSandbox(port?: number) {
    if (!canWriteSelectedSession || !selectedSessionId) return;
    const context = selectedResourceContext(selectedSessionId);
    setError('');
    try {
      await extendSandbox({ sessionId: selectedSessionId, token, seconds: 600, ...(port ? { port } : {}) });
      if (!isSelectedResourceContextCurrent(context)) return;
      selectedResourceCoordinatorRef.current?.invalidate(context, new Set<DetailResource>(['services']));
      markSessionSummaryChanged(context.sessionId);
      void refreshLoadedSessionSummary(context.sessionId);
    } catch (err) {
      if (isSelectedResourceContextCurrent(context)) handleApiError(err);
    }
  }

  async function handleOpenWorkspaceTool(toolId: WorkspaceToolId) {
    if (!canWriteSelectedSession || !selectedSessionId) return;
    const context = selectedResourceContext(selectedSessionId);
    const summaryVersion = sessionSummaryMutationVersionRef.current.get(selectedSessionId) ?? 0;
    const summaryApplicationVersion = sessionSummaryApplicationVersionRef.current.get(selectedSessionId) ?? 0;
    const summaryAtStart = loadedSessionSummary(selectedSessionId);
    setError('');
    const opened = window.open('about:blank', '_blank');
    writeWorkspaceToolTabMessage(
      opened,
      'Starting workspace tool...',
      'The sandbox tool is starting. This can take a few seconds.',
    );
    try {
      const result = await openWorkspaceTool({ sessionId: selectedSessionId, toolId, token });
      if (!isSelectedResourceContextCurrent(context) || result.session.id !== context.sessionId) {
        opened?.close();
        return;
      }
      applySessionMutationResponse(result.session, context, summaryVersion, summaryApplicationVersion, summaryAtStart);
      applySelectedResourceMutation(context, new Set<DetailResource>(['services']), (current) => ({
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
      if (isSelectedResourceContextCurrent(context)) handleApiError(err);
    }
  }

  function handleApiError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) signOut();
    setError(errorMessage(err));
  }
  handleApiErrorRef.current = handleApiError;

  const canViewSnippets = Boolean(canCallApi && currentUser);
  const { selectedSnippetId } = navigation;
  const selectedSnippet = snippets.find((item) => item.id === selectedSnippetId) ?? null;
  function selectSnippet(id: string) {
    if (!skillsWorkspace.actions.navigateToSnippet(id)) return;
    sessionStorage.setItem(sidebarPanelStorageKey, 'snippets');
    if (!isDesktopViewport()) setSidebarOpen(false);
  }
  function openSnippets() {
    if (!canViewSnippets) return;
    selectSnippet(selectedSnippetId);
    setSidebarCollapsed(false);
    void refreshSnippets();
  }
  function snippetChanged(snippet: Snippet) {
    if (!currentUser || snippetAuthorityRef.current !== snippetAuthority) return;
    mergeSnippetIntoCache(snippet);
    snippetDirtyRef.current = false;
    if (selectedSnippetId !== snippet.id) {
      sessionStorage.setItem(sidebarPanelStorageKey, 'snippets');
      skillsWorkspace.actions.navigateToSnippet(snippet.id, true);
    }
  }
  function mergeSnippetIntoCache(snippet: Snippet) {
    snippetRefreshVersionRef.current += 1;
    setSnippetsLoading(false);
    setSnippets((items) => [snippet, ...items.filter((item) => item.id !== snippet.id)]);
  }
  async function saveSnippet(input: { snippetId?: string; name?: string; body?: string }): Promise<Snippet | null> {
    if (!canManagePersonalResources || snippetMutationPending) return null;
    const authority = snippetAuthority;
    const version = ++snippetMutationVersionRef.current;
    const origin = {
      authority,
      version,
      editorEpoch: snippetEditorEpochRef.current,
      panel: navigation.sidebarPanel,
      selectedSnippetId,
    };
    setSnippetMutationPending(true);
    try {
      const snippet = input.snippetId
        ? await updateSnippet({
            token,
            snippetId: input.snippetId,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
          })
        : await createSnippet({ token, name: input.name ?? '', body: input.body ?? '' });
      const current = navigationRef.current;
      const currentContext = {
        authority: snippetAuthorityRef.current,
        version: snippetMutationVersionRef.current,
        editorEpoch: snippetEditorEpochRef.current,
        panel: current.sidebarPanel,
        selectedSnippetId: current.selectedSnippetId,
      };
      if (isSnippetMutationAuthoritative(origin, currentContext)) mergeSnippetIntoCache(snippet);
      return isSnippetMutationCurrent(origin, currentContext) ? snippet : null;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        snippetAuthorityRef.current === authority &&
        snippetMutationVersionRef.current === version
      ) {
        handleApiError(error);
        return null;
      }
      throw error;
    } finally {
      if (snippetMutationVersionRef.current === version) setSnippetMutationPending(false);
    }
  }
  async function mutateSnippet(id: string, restore: boolean) {
    if (!canManagePersonalResources || snippetMutationPending) return;
    if (!restore && id === selectedSnippetId && snippetDirtyRef.current) {
      if (!window.confirm('Discard unsaved snippet changes?')) return;
      snippetDirtyRef.current = false;
    }
    const authority = snippetAuthority;
    const version = ++snippetMutationVersionRef.current;
    const origin = {
      authority,
      version,
      editorEpoch: snippetEditorEpochRef.current,
      panel: navigation.sidebarPanel,
      selectedSnippetId,
    };
    setSnippetMutationPending(true);
    try {
      const snippet = await (restore ? restoreSnippet : archiveSnippet)({ token, snippetId: id });
      const current = navigationRef.current;
      const currentContext = {
        authority: snippetAuthorityRef.current,
        version: snippetMutationVersionRef.current,
        editorEpoch: snippetEditorEpochRef.current,
        panel: current.sidebarPanel,
        selectedSnippetId: current.selectedSnippetId,
      };
      if (isSnippetMutationAuthoritative(origin, currentContext)) mergeSnippetIntoCache(snippet);
      if (isSnippetMutationCurrent(origin, currentContext)) snippetDirtyRef.current = false;
    } catch (error) {
      if (snippetAuthorityRef.current === authority && snippetMutationVersionRef.current === version)
        handleApiError(error);
    } finally {
      if (snippetMutationVersionRef.current === version) setSnippetMutationPending(false);
    }
  }

  const sidebarNavigation = resolveSidebarNavigation({
    panel: sidebarPanel,
    showingSetupGuide,
    visible: {
      groups: canViewInstanceAccess,
      automations: canViewAutomations,
      environments: canViewEnvironments,
      skills: canViewSkills,
      snippets: canViewSnippets,
    },
  });
  const footerProps: SidebarFooterProps = {
    authRequired: bearerAuthRequired || sessionAuthRequired,
    canViewGroups: canViewInstanceAccess,
    canViewAutomations,
    canViewEnvironments,
    canViewSkills,
    canViewSnippets,
    canViewSetup,
    health,
    navPage: instanceAccessOpen ? 'groups' : sidebarNavigation.navPage,
    themePreference,
    token,
    onOpenGroups: openInstanceAccessPanel,
    onOpenAutomations: openAutomationsPanel,
    onOpenEnvironments: openEnvironmentsPanel,
    onOpenSkills: skillsWorkspace.actions.open,
    onOpenSnippets: openSnippets,
    onOpenSessions: showSessionsSidebar,
    onOpenSetup: openSetupGuide,
    onSignOut: () => {
      if (confirmDiscardEditorChanges()) signOut();
    },
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
                {sidebarPanel === 'automations' && canViewAutomations ? (
                  <AutomationsSidebar
                    archivedAutomationsOpen={archivedAutomationsOpen || selectedAutomationArchived}
                    automations={automations}
                    canCallApi={canViewAutomations}
                    canCreateAutomations={canCreateAutomations}
                    canManageTenantResources={canManageTenantResources}
                    footerProps={footerProps}
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
                    readOnly={!canManageSkills}
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
                ) : sidebarPanel === 'snippets' && canViewSnippets ? (
                  <SnippetsSidebar
                    snippets={snippets}
                    selectedId={selectedSnippetId}
                    loading={snippetsLoading}
                    mutationPending={snippetMutationPending}
                    readOnly={!canManagePersonalResources}
                    footerProps={footerProps}
                    onSelect={selectSnippet}
                    onCreate={() => selectSnippet('')}
                    onBack={backToSessionsSidebar}
                    onCollapse={collapseSidebar}
                    onArchive={(id) => void mutateSnippet(id, false)}
                    onRestore={(id) => void mutateSnippet(id, true)}
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
                {instanceAccessOpen && currentUser?.role === 'admin' ? (
                  <InstanceAccessPanel
                    token={token}
                    currentUser={currentUser}
                    showOpenSidebar={!sidebarOpen}
                    onOpenSidebar={expandSidebar}
                    onCurrentUserChanged={setCurrentUser}
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
                    canManageTenantResources={canManageTenantResources}
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
                    canManageTenantResources={canManageTenantResources}
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
                    readOnly={!canManageSkills}
                    canCreateTenantSkills={canManageTenantResources}
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
                ) : sidebarPanel === 'snippets' && canViewSnippets ? (
                  <SnippetsPanel
                    snippet={selectedSnippet}
                    selectedId={selectedSnippetId}
                    loading={snippetsLoading}
                    mutationPending={snippetMutationPending}
                    readOnly={!canManagePersonalResources}
                    showOpenSidebar={!sidebarOpen}
                    onOpenSidebar={expandSidebar}
                    onSave={saveSnippet}
                    onChanged={snippetChanged}
                    onArchive={(id) => void mutateSnippet(id, false)}
                    onRestore={(id) => void mutateSnippet(id, true)}
                    onDirtyChange={(dirty) => {
                      snippetDirtyRef.current = dirty;
                    }}
                    onError={(error) => {
                      if (snippetAuthorityRef.current === snippetAuthority) handleApiError(error);
                    }}
                  />
                ) : isCreatingThread || !selectedSession ? (
                  <NewThreadPanel
                    canCallApi={canCreateThread}
                    canCreatePrivateSession={
                      Boolean(health?.privateSessionsEnabled) && sessionAuthRequired && Boolean(currentUser)
                    }
                    readOnly={!canCreateThread}
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
                    snippets={snippets}
                    snippetsEnabled={Boolean(currentUser)}
                    skillsLoading={skillsWorkspace.model.newSessionCatalog.loading}
                    skillError={skillsWorkspace.model.newSessionCatalog.error}
                    showOpenSidebar={!sidebarOpen}
                    openSidebarLabel={sidebarNavigation.openLabel}
                    onOpenSidebar={expandSidebar}
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
                      canPromoteSession={
                        selectedSession.visibility === 'private' &&
                        selectedSession.ownerUserId === currentUser?.id &&
                        canWriteSelectedSession
                      }
                      promotingSession={promotingSessionId === selectedSession.id}
                      showOpenSidebar={!sidebarOpen}
                      openSidebarLabel={sidebarNavigation.openLabel}
                      onArchive={fireAndForget(handleArchiveSession)}
                      onPromoteSession={fireAndForget(handlePromoteSession)}
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
                                  notepadsHostRef={mobileNotepadsHostRef}
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
                                  onToggleSteering={fireAndForget(toggleMessageSteering)}
                                  steeringMessageIds={steeringMessageIds}
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
                            snippets={snippets}
                            snippetsEnabled={Boolean(currentUser)}
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
                          notepadsHostRef={desktopNotepadsHostRef}
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
                      {selectedSessionDetailLoading ? null : (
                        <ResponsiveNotepadsPanel
                          key={selectedSession.id}
                          session={selectedSession}
                          token={token}
                          canWrite={canWriteSelectedSession}
                          changeRevisions={notepadChangeRevisions}
                          associationVersion={notepadAssociationVersions.get(selectedSession.id) ?? 0}
                          mobileHost={mobileNotepadsHostRef}
                          desktopHost={desktopNotepadsHostRef}
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

function sessionUpdatedAfter(candidate: Session, current: Session): boolean {
  const candidateTime = Date.parse(candidate.updatedAt);
  const currentTime = Date.parse(current.updatedAt);
  return Number.isFinite(candidateTime) && Number.isFinite(currentTime) && candidateTime > currentTime;
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

function applyDirectSessionActions(
  current: SessionDetailState,
  actions: readonly DirectSessionAction[],
): SessionDetailState {
  return actions.reduce((next, action) => {
    switch (action.type) {
      case 'upsertArtifact':
        return { ...next, artifacts: upsertById(next.artifacts, action.artifact) };
      case 'upsertExternalResource':
        return { ...next, externalResources: upsertById(next.externalResources, action.resource) };
      case 'clearServices':
        return next.services.length > 0 ? { ...next, services: [] } : next;
    }
  }, current);
}

function directActionResources(actions: readonly DirectSessionAction[]): ReadonlySet<DetailResource> {
  return new Set(
    actions.map((action): DetailResource => {
      switch (action.type) {
        case 'upsertArtifact':
          return 'artifacts';
        case 'upsertExternalResource':
          return 'externalResources';
        case 'clearServices':
          return 'services';
      }
    }),
  );
}

function loadSelectedResource(resource: DetailResource, sessionId: string, token: string): Promise<unknown> {
  switch (resource) {
    case 'messages':
      return listMessages(sessionId, token);
    case 'artifacts':
      return listArtifacts(sessionId, token);
    case 'services':
      return listServices(sessionId, token);
    case 'externalResources':
      return listExternalResources(sessionId, token);
    case 'callbacks':
      return listCallbacks(sessionId, token);
  }
}

function applySelectedResource(
  current: SessionDetailState,
  resource: DetailResource,
  value: unknown,
): SessionDetailState {
  switch (resource) {
    case 'messages':
      return { ...current, messages: value as Message[] };
    case 'artifacts':
      return { ...current, artifacts: mergeEntitiesById(value as Artifact[], current.artifacts) };
    case 'services':
      return { ...current, services: value as SandboxService[] };
    case 'externalResources':
      return {
        ...current,
        externalResources: mergeEntitiesById(value as ExternalResource[], current.externalResources),
      };
    case 'callbacks':
      return { ...current, callbacks: value as CallbackDelivery[] };
  }
}

function upsertById<T extends { id: string }>(current: T[], entity: T): T[] {
  const index = current.findIndex((candidate) => candidate.id === entity.id);
  if (index === -1) return [...current, entity];
  return current.map((candidate, candidateIndex) => (candidateIndex === index ? entity : candidate));
}

function mergeEntitiesById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return incoming.reduce(upsertById, current);
}

function mergeEventsBySequence(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) {
    if (!bySequence.has(event.sequence)) bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
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
  url.searchParams.delete('snippet');
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
  url.searchParams.delete('snippet');
  url.searchParams.delete('revision');
  window.history.replaceState({}, '', url);
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
    searchParams.has('snippet') ||
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
