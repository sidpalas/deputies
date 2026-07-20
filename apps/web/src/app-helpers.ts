export const tokenStorageKey = 'deputies-api-token';
export const selectedSessionStorageKey = 'deputies-selected-session-id';
export const newSessionSelectedStorageKey = 'deputies-new-session-selected';
export const setupGuideOpenStorageKey = 'deputies-setup-guide-open';
export const groupsPanelOpenStorageKey = 'deputies-groups-panel-open';
export const sidebarPanelStorageKey = 'deputies-sidebar-panel';
export const groupsPanelViewStorageKey = 'deputies-groups-panel-view';
export const groupsPanelSelectedGroupStorageKey = 'deputies-groups-panel-selected-group-id';
export const selectedAutomationStorageKey = 'deputies-selected-automation-id';
export const selectedEnvironmentStorageKey = 'deputies-selected-environment-id';
export const selectedSkillStorageKey = 'deputies-selected-skill-id';
export const archivedSessionsOpenStorageKey = 'deputies-archived-sessions-open';
export const sessionFiltersStorageKey = 'deputies-session-filters';
export const archivedAutomationsOpenStorageKey = 'deputies-archived-automations-open';
export const themeStorageKey = 'deputies-theme';

export const startupConnectionDelayMs = 3_000;
export const wakeRecoveryThresholdMs = 5_000;
export const realtimeReconnectInitialDelayMs = 500;
export const realtimeReconnectMaxDelayMs = 5_000;

const threadAutoFollowThreshold = 160;
const liveConnectionMessage = 'Live updates connected.';
const wakeRecoveryMessage = 'Reconnecting after your computer was asleep or offline.';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ConnectionState = 'ok' | 'delayed' | 'reconnecting';

export type ConnectionStatus = {
  state: ConnectionState;
  message: string;
};

type ApiConnectionOkDetail = {
  source?: unknown;
};

type ApiConnectionDelayedDetail = {
  message?: unknown;
};

export function loadStoredToken(): string {
  return localStorage.getItem(tokenStorageKey) ?? '';
}

export function loadInitialSelectedSessionId(): string {
  const query = new URLSearchParams(window.location.search);
  if (
    query.get('group') ||
    query.get('automation') ||
    query.get('environment') ||
    query.get('skill') ||
    query.get('snippet')
  )
    return '';
  return query.get('session') ?? sessionStorage.getItem(selectedSessionStorageKey) ?? '';
}

export function loadInitialIsCreatingThread(): boolean {
  return (
    !new URLSearchParams(window.location.search).get('session') &&
    !new URLSearchParams(window.location.search).get('group') &&
    !new URLSearchParams(window.location.search).get('automation') &&
    !new URLSearchParams(window.location.search).get('environment') &&
    !new URLSearchParams(window.location.search).get('skill') &&
    !new URLSearchParams(window.location.search).get('snippet') &&
    sessionStorage.getItem(newSessionSelectedStorageKey) === 'true'
  );
}

export function loadInitialSetupGuideOpen(): boolean {
  const query = new URLSearchParams(window.location.search);
  if (
    query.get('session') ||
    query.get('group') ||
    query.get('automation') ||
    query.get('environment') ||
    query.get('skill') ||
    query.get('snippet')
  )
    return false;
  return sessionStorage.getItem(setupGuideOpenStorageKey) === 'true';
}

export function loadInitialGroupsPanelOpen(): boolean {
  const query = new URLSearchParams(window.location.search);
  if (
    query.get('session') ||
    query.get('automation') ||
    query.get('environment') ||
    query.get('skill') ||
    query.get('snippet')
  )
    return false;
  if (query.get('group')) return true;
  return sessionStorage.getItem(groupsPanelOpenStorageKey) === 'true';
}

export function loadInitialSidebarPanel():
  | 'sessions'
  | 'groups'
  | 'automations'
  | 'environments'
  | 'skills'
  | 'snippets' {
  const query = new URLSearchParams(window.location.search);
  if (query.get('session')) return 'sessions';
  if (query.get('automation')) return 'automations';
  if (query.get('environment')) return 'environments';
  if (query.get('skill')) return 'skills';
  if (query.get('snippet')) return 'snippets';
  if (query.get('group')) return 'groups';
  const stored = sessionStorage.getItem(sidebarPanelStorageKey);
  if (
    stored === 'sessions' ||
    stored === 'groups' ||
    stored === 'automations' ||
    stored === 'environments' ||
    stored === 'snippets' ||
    stored === 'skills'
  ) {
    return stored;
  }
  return loadInitialGroupsPanelOpen() ? 'groups' : 'sessions';
}

export function loadInitialGroupsPanelView(): 'group' | 'super_admins' {
  if (new URLSearchParams(window.location.search).get('group')) return 'group';
  return sessionStorage.getItem(groupsPanelViewStorageKey) === 'super_admins' ? 'super_admins' : 'group';
}

export function loadInitialGroupsPanelSelectedGroupId(): string {
  const groupId = new URLSearchParams(window.location.search).get('group');
  if (groupId) return groupId;
  return sessionStorage.getItem(groupsPanelSelectedGroupStorageKey) ?? '';
}

export function loadInitialSelectedAutomationId(): string {
  const automationId = new URLSearchParams(window.location.search).get('automation');
  if (automationId) return automationId;
  return sessionStorage.getItem(selectedAutomationStorageKey) ?? '';
}

export function loadInitialSelectedEnvironmentId(): string {
  const environmentId = new URLSearchParams(window.location.search).get('environment');
  if (environmentId) return environmentId;
  return sessionStorage.getItem(selectedEnvironmentStorageKey) ?? '';
}

export function loadInitialSelectedEnvironmentRevisionId(): string {
  const query = new URLSearchParams(window.location.search);
  return query.get('environment') ? (query.get('revision') ?? '') : '';
}

export function loadInitialSelectedSkillId(): string {
  const skillId = new URLSearchParams(window.location.search).get('skill');
  if (skillId) return skillId;
  return sessionStorage.getItem(selectedSkillStorageKey) ?? '';
}

export function loadInitialSelectedSkillRevisionId(): string {
  const query = new URLSearchParams(window.location.search);
  return query.get('skill') ? (query.get('revision') ?? '') : '';
}

export function loadThemePreference(): ThemePreference {
  const stored = localStorage.getItem(themeStorageKey);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

export function resolveThemePreference(theme: ThemePreference): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyThemePreference(theme: ThemePreference) {
  document.documentElement.classList.toggle('dark', resolveThemePreference(theme) === 'dark');
}

export function isPageVisible(): boolean {
  return document.visibilityState !== 'hidden';
}

export function isThreadNearBottom(container: HTMLElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threadAutoFollowThreshold;
}

export function isThreadComposerFocused(): boolean {
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLElement && Boolean(activeElement.closest('[data-thread-composer="true"]'));
}

export function initialConnectionStatus(): ConnectionStatus {
  return { state: 'ok', message: liveConnectionMessage };
}

export function startupDelayedConnectionStatus(): ConnectionStatus {
  return { state: 'delayed', message: 'Still waiting for the API to respond.' };
}

export function wakeRecoveryConnectionStatus(): ConnectionStatus {
  return { state: 'reconnecting', message: wakeRecoveryMessage };
}

export function isStreamConnectionOk(event: Event): boolean {
  const detail = event instanceof CustomEvent ? (event.detail as ApiConnectionOkDetail) : undefined;
  return detail?.source === 'stream';
}

export function connectionDelayedMessage(event: Event): string {
  const detail = event instanceof CustomEvent ? (event.detail as ApiConnectionDelayedDetail) : undefined;
  return typeof detail?.message === 'string' ? detail.message : 'API requests are taking longer than expected.';
}

export function isWakeRecoveryStatus(status: ConnectionStatus): boolean {
  return status.state === 'reconnecting' && status.message === wakeRecoveryMessage;
}
