import { useEffect, useMemo, useState } from 'react';
import type { Group, Skill } from './api.js';
import {
  groupsPanelOpenStorageKey,
  selectedSkillStorageKey,
  setupGuideOpenStorageKey,
  sidebarPanelStorageKey,
} from './app-helpers.js';
import { useAppNavigation, type SidebarPanel } from './app-navigation.js';
import { useSessionSkillCatalog } from './session-skill-catalog.js';
import { useSkillInvocationCandidates } from './skill-invocation-candidates.js';
import { useSkillsAdmin } from './skills-admin.js';

type StateUpdate<T> = T | ((current: T) => T);

export type SkillWorkspaceNavigation = {
  setupGuideOpen: boolean;
  groupsPanelOpen: boolean;
  sidebarPanel: SidebarPanel;
  isCreatingThread: boolean;
  selectedEnvironmentId: string;
  selectedEnvironmentRevisionId: string;
  selectedSkillId: string;
  selectedSkillRevisionId: string;
};

export function useSkillsWorkspace<T extends SkillWorkspaceNavigation>(input: {
  token: string;
  groups: Group[];
  canCallApi: boolean;
  canCreateThread: boolean;
  newThreadOwnerGroupId: string;
  selectedSessionId: string;
  navigation: T;
  setNavigation: (update: (current: T) => T) => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  onError: (error: unknown) => void;
  canNavigate: (navigation: T) => boolean;
}) {
  const [editorDirty, setEditorDirty] = useState(false);
  const [newThreadError, setNewThreadError] = useState('');
  const { selectedSkillId, selectedSkillRevisionId } = input.navigation;

  function setSelectedSkillId(next: StateUpdate<string>) {
    input.setNavigation((current) => {
      const selectedSkillId = typeof next === 'function' ? next(current.selectedSkillId) : next;
      return {
        ...current,
        selectedSkillId,
        selectedSkillRevisionId: selectedSkillId === current.selectedSkillId ? current.selectedSkillRevisionId : '',
      };
    });
  }

  const admin = useSkillsAdmin({
    token: input.token,
    groups: input.groups,
    canCallApi: input.canCallApi,
    selectedSkillId,
    setSelectedSkillId,
    onError: input.onError,
  });
  const canView = input.canCallApi && admin.available === true;
  const sessionCatalog = useSessionSkillCatalog({
    enabled: canView,
    sessionId: input.selectedSessionId,
    token: input.token,
  });
  const newSessionCatalog = useSkillInvocationCandidates({
    enabled: input.canCreateThread && (input.navigation.isCreatingThread || !input.selectedSessionId),
    ownerGroupId: input.newThreadOwnerGroupId,
    token: input.token,
  });
  const openableManagedSkillIds = useMemo(
    () => new Set(admin.skills.filter((skill) => skill.source !== 'repo' && skill.canManage).map((skill) => skill.id)),
    [admin.skills],
  );

  function confirmDiscard(): boolean {
    if (!editorDirty) return true;
    if (!window.confirm('Discard unsaved skill changes?')) return false;
    setEditorDirty(false);
    return true;
  }

  const navigation = useAppNavigation({
    navigation: input.navigation,
    onNavigationChange: (next) => input.setNavigation(() => next),
    canNavigate: (next) => {
      const leavingDirtySkill =
        input.navigation.sidebarPanel === 'skills' &&
        (next.sidebarPanel !== 'skills' ||
          next.selectedSkillId !== input.navigation.selectedSkillId ||
          next.selectedSkillRevisionId !== input.navigation.selectedSkillRevisionId);
      if (leavingDirtySkill && !confirmDiscard()) return false;
      return input.canNavigate(next);
    },
  });

  useEffect(() => {
    if (!input.canCallApi) return;
    void admin.refresh();
  }, [
    input.canCallApi,
    input.token,
    input.groups.map((group) => `${group.id}:${group.membershipRole ?? ''}:${group.archivedAt ?? ''}`).join('|'),
  ]);

  useEffect(() => {
    if (admin.available !== false || input.navigation.sidebarPanel !== 'skills') return;
    sessionStorage.setItem(sidebarPanelStorageKey, 'sessions');
    sessionStorage.removeItem(selectedSkillStorageKey);
    clearResourceSearchParams();
    input.setNavigation((current) => ({
      ...current,
      sidebarPanel: 'sessions',
      selectedSkillId: '',
      selectedSkillRevisionId: '',
    }));
  }, [admin.available, input.navigation.sidebarPanel]);

  function navigateToSkill(skillId: string, revisionId = '', replace = false): boolean {
    const nextNavigation = {
      ...input.navigation,
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'skills' as const,
      isCreatingThread: false,
      selectedSkillId: skillId,
      selectedSkillRevisionId: revisionId,
    };
    return navigation.navigate(nextNavigation, { type: 'skill', id: skillId, revisionId }, replace);
  }

  function navigateToEnvironment(environmentId: string, revisionId = '', replace = false): boolean {
    const nextNavigation = {
      ...input.navigation,
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'environments' as const,
      isCreatingThread: false,
      selectedEnvironmentId: environmentId,
      selectedEnvironmentRevisionId: environmentId === input.navigation.selectedEnvironmentId ? revisionId : '',
    };
    return navigation.navigate(
      nextNavigation,
      {
        type: 'environment',
        id: environmentId,
        revisionId: nextNavigation.selectedEnvironmentRevisionId,
      },
      replace,
    );
  }

  function open() {
    if (!canView) return;
    if (input.navigation.sidebarPanel !== 'skills' && !confirmDiscard()) return;
    const desktop = isDesktopViewport();
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'skills');
    if (selectedSkillId) {
      if (!navigateToSkill(selectedSkillId)) return;
    } else {
      clearResourceSearchParams();
      input.setNavigation((current) => ({
        ...current,
        setupGuideOpen: false,
        groupsPanelOpen: false,
        sidebarPanel: 'skills',
        isCreatingThread: false,
      }));
    }
    input.setSidebarCollapsed(false);
    input.setSidebarOpen(!desktop);
  }

  function create() {
    if (!input.canCallApi || !confirmDiscard()) return;
    sessionStorage.removeItem(selectedSkillStorageKey);
    clearResourceSearchParams();
    sessionStorage.setItem(sidebarPanelStorageKey, 'skills');
    input.setNavigation((current) => ({
      ...current,
      setupGuideOpen: false,
      groupsPanelOpen: false,
      sidebarPanel: 'skills',
      isCreatingThread: false,
      selectedSkillId: '',
      selectedSkillRevisionId: '',
    }));
    if (!isDesktopViewport()) input.setSidebarOpen(false);
  }

  function select(skillId: string, revisionId = '') {
    if (!canView) return;
    sessionStorage.removeItem(setupGuideOpenStorageKey);
    sessionStorage.removeItem(groupsPanelOpenStorageKey);
    sessionStorage.setItem(sidebarPanelStorageKey, 'skills');
    sessionStorage.setItem(selectedSkillStorageKey, skillId);
    if (!navigateToSkill(skillId, revisionId)) return;
    input.setSidebarCollapsed(false);
    if (!isDesktopViewport()) input.setSidebarOpen(false);
  }

  function saved(skill: Skill) {
    setEditorDirty(false);
    admin.changed(skill);
    sessionStorage.setItem(selectedSkillStorageKey, skill.id);
    navigateToSkill(skill.id, '', true);
    void admin.refresh();
  }

  function changed(skill: Skill) {
    setEditorDirty(false);
    admin.changed(skill);
    void admin.refresh();
  }

  async function archiveFromSidebar(skillId: string) {
    if (
      skillId === selectedSkillId &&
      editorDirty &&
      !window.confirm('Discard unsaved changes and archive this skill?')
    )
      return;
    if (skillId === selectedSkillId) setEditorDirty(false);
    await admin.archive(skillId);
  }

  function reset() {
    setEditorDirty(false);
    setNewThreadError('');
    sessionCatalog.setError('');
    admin.reset();
  }

  return {
    model: {
      skills: admin.skills,
      selectedSkill: admin.selectedSkill,
      available: admin.available,
      canView,
      canCreate: input.canCallApi,
      loading: admin.loading,
      loaded: admin.loaded,
      selectedSkillId,
      selectedRevisionId: selectedSkillRevisionId,
      openableManagedSkillIds,
      newSessionCatalog: {
        skills: newSessionCatalog.skills,
        enabled: newSessionCatalog.available !== false,
        loading: newSessionCatalog.loading,
        error: newThreadError || newSessionCatalog.error,
      },
      sessionCatalog: {
        skills: sessionCatalog.skills,
        loading: sessionCatalog.loading,
        error: sessionCatalog.error,
      },
    },
    actions: {
      refresh: admin.refresh,
      reset,
      confirmDiscard,
      open,
      create,
      select,
      selectRevision: (revisionId: string) => navigateToSkill(selectedSkillId, revisionId),
      navigateToEnvironment,
      saved,
      changed,
      archive: admin.archive,
      archiveFromSidebar,
      restore: admin.restore,
      setEditorDirty,
      setNewThreadError,
      setSessionError: sessionCatalog.setError,
      invalidateSessionCatalog: sessionCatalog.invalidate,
    },
  };
}

function clearResourceSearchParams() {
  const url = new URL(window.location.href);
  for (const param of ['session', 'group', 'automation', 'environment', 'skill', 'revision']) {
    url.searchParams.delete(param);
  }
  window.history.replaceState(window.history.state, '', url);
}

function isDesktopViewport(): boolean {
  return window.matchMedia?.('(min-width: 768px)').matches ?? true;
}
