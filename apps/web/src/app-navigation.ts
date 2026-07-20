import { useEffect, useRef } from 'react';

export type SidebarPanel = 'sessions' | 'groups' | 'automations' | 'environments' | 'skills' | 'snippets';

const sidebarPanelLabels: Record<SidebarPanel, string> = {
  sessions: 'sessions',
  groups: 'access',
  automations: 'automations',
  environments: 'environments',
  skills: 'skills',
  snippets: 'snippets',
};

const navigationStateKey = 'deputiesNavigation';
const navigationIndexStateKey = 'deputiesNavigationIndex';

type HistoryEntry<T> = {
  index: number;
  navigation: T;
  url: string;
};

export type RevisionResource = {
  type: 'environment' | 'skill' | 'snippet';
  id: string;
  revisionId?: string;
};

export function useAppNavigation<T>(input: {
  navigation: T;
  onNavigationChange: (navigation: T) => void;
  canNavigate: (navigation: T) => boolean;
}) {
  const inputRef = useRef(input);
  const entryRef = useRef<HistoryEntry<T>>({
    index: historyIndex(window.history.state),
    navigation: input.navigation,
    url: window.location.href,
  });
  const restoringRef = useRef(false);
  inputRef.current = input;

  useEffect(() => {
    const entry = entryRef.current;
    window.history.replaceState(
      {
        ...window.history.state,
        [navigationStateKey]: entry.navigation,
        [navigationIndexStateKey]: entry.index,
      },
      '',
      entry.url,
    );

    function restoreNavigation(event: PopStateEvent) {
      const state = event.state as Record<string, unknown> | null;
      const navigation = state?.[navigationStateKey] as T | undefined;
      if (!navigation) return;
      const targetIndex = historyIndex(state);
      if (restoringRef.current) {
        restoringRef.current = false;
        return;
      }
      if (!inputRef.current.canNavigate(navigation)) {
        const delta = entryRef.current.index - targetIndex;
        if (delta) {
          restoringRef.current = true;
          window.history.go(delta);
        } else {
          const current = entryRef.current;
          window.history.pushState(
            {
              ...window.history.state,
              [navigationStateKey]: current.navigation,
              [navigationIndexStateKey]: current.index,
            },
            '',
            current.url,
          );
        }
        return;
      }
      entryRef.current = { index: targetIndex, navigation, url: window.location.href };
      inputRef.current.onNavigationChange(navigation);
    }

    window.addEventListener('popstate', restoreNavigation);
    return () => window.removeEventListener('popstate', restoreNavigation);
  }, []);

  useEffect(() => {
    if (entryRef.current.navigation === input.navigation) return;
    const current = entryRef.current;
    const url = window.location.href;
    entryRef.current = { ...current, navigation: input.navigation, url };
    window.history.replaceState(
      {
        ...window.history.state,
        [navigationStateKey]: input.navigation,
        [navigationIndexStateKey]: current.index,
      },
      '',
      url,
    );
  }, [input.navigation]);

  function navigate(navigation: T, resource: RevisionResource, replace = false): boolean {
    if (!inputRef.current.canNavigate(navigation)) return false;
    const url = resourceUrl(resource);
    const current = entryRef.current;
    const nextIndex = replace ? current.index : current.index + 1;
    const nextState = {
      ...window.history.state,
      [navigationStateKey]: navigation,
      [navigationIndexStateKey]: nextIndex,
    };
    if (replace) {
      window.history.replaceState(nextState, '', url);
    } else {
      const currentState = {
        ...window.history.state,
        [navigationStateKey]: inputRef.current.navigation,
        [navigationIndexStateKey]: current.index,
      };
      window.history.replaceState(currentState, '', current.url);
      window.history.pushState(nextState, '', url);
    }
    entryRef.current = { index: nextIndex, navigation, url: url.href };
    inputRef.current.onNavigationChange(navigation);
    return true;
  }

  return { navigate };
}

export function resolveSidebarNavigation(input: {
  panel: SidebarPanel;
  showingSetupGuide: boolean;
  visible: Record<Exclude<SidebarPanel, 'sessions'>, boolean>;
}) {
  const panel = input.panel === 'sessions' || input.visible[input.panel] ? input.panel : 'sessions';
  return {
    panel,
    navPage: input.showingSetupGuide ? ('setup' as const) : panel,
    openLabel: `Open ${sidebarPanelLabels[panel]}`,
    expandLabel: `Expand ${sidebarPanelLabels[panel]}`,
  };
}

function historyIndex(state: unknown): number {
  if (!state || typeof state !== 'object') return 0;
  const index = (state as Record<string, unknown>)[navigationIndexStateKey];
  return typeof index === 'number' ? index : 0;
}

function resourceUrl(resource: RevisionResource): URL {
  const url = new URL(window.location.href);
  for (const param of ['session', 'group', 'automation', 'environment', 'skill', 'snippet', 'revision']) {
    url.searchParams.delete(param);
  }
  if (resource.id) url.searchParams.set(resource.type, resource.id);
  if (resource.revisionId) url.searchParams.set('revision', resource.revisionId);
  return url;
}
