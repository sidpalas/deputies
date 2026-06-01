export const tokenStorageKey = 'deputies-api-token';
export const selectedSessionStorageKey = 'deputies-selected-session-id';
export const newSessionSelectedStorageKey = 'deputies-new-session-selected';
export const setupGuideOpenStorageKey = 'deputies-setup-guide-open';
export const groupsPanelOpenStorageKey = 'deputies-groups-panel-open';
export const sidebarPanelStorageKey = 'deputies-sidebar-panel';
export const groupsPanelViewStorageKey = 'deputies-groups-panel-view';
export const groupsPanelSelectedGroupStorageKey = 'deputies-groups-panel-selected-group-id';
export const archivedSessionsOpenStorageKey = 'deputies-archived-sessions-open';
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
  return (
    new URLSearchParams(window.location.search).get('session') ??
    sessionStorage.getItem(selectedSessionStorageKey) ??
    ''
  );
}

export function loadInitialIsCreatingThread(): boolean {
  return (
    !new URLSearchParams(window.location.search).get('session') &&
    sessionStorage.getItem(newSessionSelectedStorageKey) === 'true'
  );
}

export function loadInitialSetupGuideOpen(): boolean {
  return sessionStorage.getItem(setupGuideOpenStorageKey) === 'true';
}

export function loadInitialGroupsPanelOpen(): boolean {
  return sessionStorage.getItem(groupsPanelOpenStorageKey) === 'true';
}

export function loadInitialSidebarPanel(): 'sessions' | 'groups' {
  const stored = sessionStorage.getItem(sidebarPanelStorageKey);
  if (stored === 'sessions' || stored === 'groups') return stored;
  return loadInitialGroupsPanelOpen() ? 'groups' : 'sessions';
}

export function loadInitialGroupsPanelView(): 'group' | 'super_admins' {
  return sessionStorage.getItem(groupsPanelViewStorageKey) === 'super_admins' ? 'super_admins' : 'group';
}

export function loadInitialGroupsPanelSelectedGroupId(): string {
  return sessionStorage.getItem(groupsPanelSelectedGroupStorageKey) ?? '';
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

function isScrollableElement(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const overflowY = window.getComputedStyle(element).overflowY;
  return ['auto', 'scroll', 'overlay'].includes(overflowY) && element.scrollHeight > element.clientHeight;
}

function canScrollElementByWheel(element: HTMLElement, deltaY: number): boolean {
  if (deltaY < 0) return element.scrollTop > 0;
  if (deltaY > 0) return element.scrollTop + element.clientHeight < element.scrollHeight;
  return false;
}

function findScrollableAncestor(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;

  for (let element: Element | null = target; element && element !== root; element = element.parentElement) {
    if (isScrollableElement(element)) return element;
  }

  return null;
}

export function shouldLetWheelTargetHandleScroll(
  target: EventTarget | null,
  root: HTMLElement,
  threadScroll: HTMLElement,
  deltaY: number,
): boolean {
  if (!(target instanceof Element)) return false;

  const excludedPane = target.closest('[data-thread-scroll-exclude="true"]');
  if (excludedPane instanceof HTMLElement) {
    const scrollablePane =
      findScrollableAncestor(target, excludedPane) ?? (isScrollableElement(excludedPane) ? excludedPane : null);
    return Boolean(scrollablePane);
  }

  const scrollable = findScrollableAncestor(target, root);
  if (!scrollable) return false;
  if (scrollable === threadScroll) return true;
  return canScrollElementByWheel(scrollable, deltaY);
}

export function scrollThreadByWheel(container: HTMLElement, deltaY: number): void {
  if (typeof container.scrollBy === 'function') {
    container.scrollBy({ top: deltaY, behavior: 'auto' });
    return;
  }

  container.scrollTop += deltaY;
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
