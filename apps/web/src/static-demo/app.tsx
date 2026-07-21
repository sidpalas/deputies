import { useEffect, useMemo, useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import type { ArtifactPreview, ModelChoice, Session, SessionSearchResult, SessionTagSummary } from '../api.js';
import {
  AutomationsPanel,
  AutomationsSidebar,
  EnvironmentsPanel,
  EnvironmentsSidebar,
  GroupsPanel,
  GroupsSidebar,
  MessageComposer,
  SkillsPanel,
  SkillsSidebar,
  SnippetsPanel,
  SnippetsSidebar,
  ThreadHeader,
  ThreadSidebar,
} from '../components/app-panels.js';
import type { SidebarFooterProps, ThemePreference } from '../components/app-panels.js';
import type { NavigationPage } from '../components/app-panels/sidebar-footer.js';
import { ChatPanel, DesktopContextPanel, MobileContextPanel } from '../components/thread/thread-content.js';
import { Button } from '../components/ui/button.js';
import {
  demoAutomations,
  demoCurrentUser,
  demoEnvironments,
  demoGroupMembers,
  demoGroups,
  demoShowcaseSessions,
  demoSkills,
  demoSnippets,
  loadDemoAutomationInvocations,
  loadDemoEnvironmentRevisions,
} from './showcase-data.js';
import type { StaticDemoData, StaticDemoSession } from './types.js';

type StaticDemoPage = Exclude<NavigationPage, 'setup'>;

type StaticSessionFilters = {
  tags: string[];
  createdByMe: boolean;
  participatedByMe: boolean;
  starredByMe: boolean;
};

const emptyStaticSessionFilters: StaticSessionFilters = {
  tags: [],
  createdByMe: false,
  participatedByMe: false,
  starredByMe: false,
};

const demoManagedSkillIds = new Set(demoSkills.map((skill) => skill.id));

const fallbackPreview: ArtifactPreview = {
  text: 'Artifact preview is not included in the static demo export.',
  contentType: 'text/plain',
  truncated: false,
  sizeBytes: 0,
};

export function StaticDemoApp() {
  const [data, setData] = useState<StaticDemoData | null>(null);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => shouldOpenSessionsOnMobile());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [page, setPage] = useState<StaticDemoPage>(getInitialPage);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedAutomationId, setSelectedAutomationId] = useState(() =>
    getInitialResourceId('automation', demoAutomations),
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(() =>
    getInitialResourceId('environment', demoEnvironments),
  );
  const [selectedEnvironmentRevisionId, setSelectedEnvironmentRevisionId] = useState(() =>
    getInitialRevisionId('environments'),
  );
  const [selectedSkillId, setSelectedSkillId] = useState(() => getInitialResourceId('skill', demoSkills));
  const [selectedSkillRevisionId, setSelectedSkillRevisionId] = useState(() => getInitialRevisionId('skills'));
  const [selectedSnippetId, setSelectedSnippetId] = useState(() => getInitialResourceId('snippet', demoSnippets));
  const [selectedGroupId, setSelectedGroupId] = useState(() => getInitialResourceId('group', demoGroups));
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [sessionFilters, setSessionFilters] = useState<StaticSessionFilters>(emptyStaticSessionFilters);
  const [sessionStarOverrides, setSessionStarOverrides] = useState<Record<string, boolean>>({});
  const [themePreference, setThemePreference] = useState<ThemePreference>('system');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolveThemePreference(themePreference) === 'dark');
  }, [themePreference]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}demo/sessions.json`, { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`Demo data request failed with ${response.status}`);
        return response.json() as Promise<StaticDemoData>;
      })
      .then((nextData) => {
        if (cancelled) return;
        setData(nextData);
        setSelectedSessionId((current) => current || getInitialSessionId(nextData));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load static demo data.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const demoSessions = useMemo(() => mergeDemoSessions(data), [data]);
  const sessions = useMemo(
    () =>
      demoSessions.map((item) => {
        const session = withSessionDefaults(item.session);
        const starred = sessionStarOverrides[session.id];
        return starred === undefined ? session : { ...session, starred };
      }),
    [demoSessions, sessionStarOverrides],
  );
  const demoSessionsById = useMemo(() => new Map(demoSessions.map((item) => [item.session.id, item])), [demoSessions]);
  const filteredSessions = useMemo(() => {
    const matching = sessions.filter((session) =>
      matchesStaticSessionFilters(session, demoSessionsById.get(session.id), sessionFilters),
    );
    const matchingChildCount = new Map<string, number>();
    for (const session of matching) {
      if (!session.parentSessionId) continue;
      matchingChildCount.set(session.parentSessionId, (matchingChildCount.get(session.parentSessionId) ?? 0) + 1);
    }
    return matching.map((session) => ({
      ...session,
      directChildCount: matchingChildCount.get(session.id) ?? 0,
    }));
  }, [demoSessionsById, sessionFilters, sessions]);
  const sessionTagOptions = useMemo<SessionTagSummary[]>(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      for (const tag of new Set(session.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return Array.from(counts, ([tag, sessionCount]) => ({ tag, sessionCount })).sort((left, right) =>
      left.tag.localeCompare(right.tag),
    );
  }, [sessions]);
  const activeSessionFilterCount =
    sessionFilters.tags.length +
    Number(sessionFilters.createdByMe) +
    Number(sessionFilters.participatedByMe) +
    Number(sessionFilters.starredByMe);
  const searchResults = useMemo<SessionSearchResult[]>(() => {
    const query = sessionSearchQuery.trim().toLowerCase();
    if (!query) return [];
    return filteredSessions.flatMap((session) => {
      const demoSession = demoSessionsById.get(session.id);
      const match = staticSessionSearchMatch(session, demoSession, query);
      return match ? [{ session, ...match, score: 1 }] : [];
    });
  }, [demoSessionsById, filteredSessions, sessionSearchQuery]);

  useEffect(() => {
    function restoreNavigation() {
      const nextPage = getInitialPage();
      const params = new URLSearchParams(window.location.search);
      setPage(nextPage);
      setSelectedAutomationId(getInitialResourceId('automation', demoAutomations));
      setSelectedEnvironmentId(getInitialResourceId('environment', demoEnvironments));
      setSelectedEnvironmentRevisionId(nextPage === 'environments' ? (params.get('revision') ?? '') : '');
      setSelectedSkillId(getInitialResourceId('skill', demoSkills));
      setSelectedSkillRevisionId(nextPage === 'skills' ? (params.get('revision') ?? '') : '');
      setSelectedSnippetId(getInitialResourceId('snippet', demoSnippets));
      setSelectedGroupId(getInitialResourceId('group', demoGroups));
      if (nextPage === 'sessions') {
        const requestedSessionId = params.get('session') ?? '';
        const requestedSession = sessions.find((session) => session.id === requestedSessionId);
        setSelectedSessionId(requestedSession?.id ?? sessions[0]?.id ?? '');
      }
    }

    window.addEventListener('popstate', restoreNavigation);
    return () => window.removeEventListener('popstate', restoreNavigation);
  }, [sessions]);

  const selectedRaw = demoSessions.find((item) => item.session.id === selectedSessionId) ?? demoSessions[0] ?? null;
  const selected = selectedRaw
    ? {
        ...selectedRaw,
        session:
          sessions.find((session) => session.id === selectedRaw.session.id) ?? withSessionDefaults(selectedRaw.session),
      }
    : null;
  const selectedAutomation = demoAutomations.find((automation) => automation.id === selectedAutomationId) ?? null;
  const selectedSkill = demoSkills.find((skill) => skill.id === selectedSkillId) ?? null;
  const selectedSnippet = demoSnippets.find((snippet) => snippet.id === selectedSnippetId) ?? null;
  const selectedGroup = demoGroups.find((group) => group.id === selectedGroupId) ?? null;

  function navigate(nextPage: StaticDemoPage) {
    setPage(nextPage);
    setSidebarOpen(false);
    updateDemoUrl(nextPage, selectedResourceForPage(nextPage), selectedRevisionForPage(nextPage));
  }

  function selectResource(page: StaticDemoPage, id: string, select: (id: string) => void) {
    setPage(page);
    select(id);
    if (page === 'environments') setSelectedEnvironmentRevisionId('');
    if (page === 'skills') setSelectedSkillRevisionId('');
    setSidebarOpen(false);
    updateDemoUrl(page, id);
  }

  function changeSessionStar(sessionId: string, starred: boolean) {
    setSessionStarOverrides((current) => ({ ...current, [sessionId]: starred }));
  }

  const footerProps: SidebarFooterProps = {
    authRequired: false,
    canViewGroups: true,
    canViewAutomations: true,
    canViewEnvironments: true,
    canViewSkills: true,
    canViewSnippets: true,
    canViewSetup: false,
    health: { status: 'ok', runMode: 'static-demo', apiAuthMode: 'none' },
    navPage: page,
    themePreference,
    token: '',
    onOpenGroups: () => navigate('groups'),
    onOpenAutomations: () => navigate('automations'),
    onOpenEnvironments: () => navigate('environments'),
    onOpenSkills: () => navigate('skills'),
    onOpenSnippets: () => navigate('snippets'),
    onOpenSessions: () => navigate('sessions'),
    onOpenSetup: () => undefined,
    onSignOut: () => undefined,
    onThemeChange: setThemePreference,
  };

  function selectedResourceForPage(nextPage: StaticDemoPage): string {
    if (nextPage === 'automations') return selectedAutomationId;
    if (nextPage === 'environments') return selectedEnvironmentId;
    if (nextPage === 'skills') return selectedSkillId;
    if (nextPage === 'snippets') return selectedSnippetId;
    if (nextPage === 'groups') return selectedGroupId;
    return selected?.session.id ?? '';
  }

  function selectedRevisionForPage(nextPage: StaticDemoPage): string {
    if (nextPage === 'environments') return selectedEnvironmentRevisionId;
    if (nextPage === 'skills') return selectedSkillRevisionId;
    return '';
  }

  if (error) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </p>
      </main>
    );
  }

  if (!data || !selected) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-sm text-muted-foreground">
        Loading demo session...
      </main>
    );
  }

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <section
        className={
          sidebarCollapsed
            ? 'grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[3.75rem_minmax(0,1fr)]'
            : 'grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)]'
        }
      >
        {sidebarCollapsed ? (
          <aside className="hidden min-h-0 border-r border-border bg-card/95 p-3 md:flex">
            <Button
              className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
              variant="ghost"
              size="icon"
              onClick={() => setSidebarCollapsed(false)}
              aria-label={`Expand ${page}`}
              title={`Expand ${page}`}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          </aside>
        ) : (
          <aside
            className={
              sidebarOpen
                ? 'fixed left-2 top-2 z-40 block h-[calc(100dvh_-_1rem_-_env(safe-area-inset-bottom))] max-h-[calc(100dvh_-_1rem_-_env(safe-area-inset-bottom))] min-h-0 w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-border bg-card p-3 shadow-2xl md:static md:z-auto md:block md:h-full md:max-h-none md:w-auto md:rounded-none md:border-y-0 md:border-l-0 md:shadow-none'
                : 'fixed left-2 top-2 z-40 hidden h-[calc(100dvh_-_1rem_-_env(safe-area-inset-bottom))] max-h-[calc(100dvh_-_1rem_-_env(safe-area-inset-bottom))] min-h-0 w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-border bg-card p-3 shadow-2xl md:static md:z-auto md:block md:h-full md:max-h-none md:w-auto md:rounded-none md:border-y-0 md:border-l-0 md:shadow-none'
            }
          >
            {page === 'automations' ? (
              <AutomationsSidebar
                archivedAutomationsOpen={false}
                automations={demoAutomations}
                canCallApi={false}
                canCreateAutomations={false}
                footerProps={footerProps}
                groups={demoGroups}
                loading={false}
                selectedAutomationId={selectedAutomationId}
                onArchiveAutomation={() => undefined}
                onArchivedAutomationsOpenChange={() => undefined}
                onBackToSessions={() => navigate('sessions')}
                onCollapse={collapseSidebar}
                onCreateAutomation={() => undefined}
                onSelectAutomation={(id) => selectResource('automations', id, setSelectedAutomationId)}
                onUnarchiveAutomation={() => undefined}
              />
            ) : page === 'environments' ? (
              <EnvironmentsSidebar
                canCallApi={false}
                canCreateEnvironments={false}
                environments={demoEnvironments}
                footerProps={footerProps}
                loading={false}
                selectedEnvironmentId={selectedEnvironmentId}
                onArchiveEnvironment={() => undefined}
                onBackToSessions={() => navigate('sessions')}
                onCollapse={collapseSidebar}
                onCreateEnvironment={() => undefined}
                onRestoreEnvironment={() => undefined}
                onSelectEnvironment={(id) => selectResource('environments', id, setSelectedEnvironmentId)}
              />
            ) : page === 'skills' ? (
              <SkillsSidebar
                canCallApi={false}
                canCreateSkills={false}
                readOnly
                footerProps={footerProps}
                groups={demoGroups}
                loading={false}
                skills={demoSkills}
                selectedSkillId={selectedSkillId}
                onBackToSessions={() => navigate('sessions')}
                onArchiveSkill={() => undefined}
                onCollapse={collapseSidebar}
                onCreateSkill={() => undefined}
                onRestoreSkill={() => undefined}
                onSelectSkill={(id) => selectResource('skills', id, setSelectedSkillId)}
              />
            ) : page === 'snippets' ? (
              <SnippetsSidebar
                readOnly
                snippets={demoSnippets}
                selectedId={selectedSnippetId}
                loading={false}
                mutationPending={false}
                footerProps={footerProps}
                onSelect={(id) => selectResource('snippets', id, setSelectedSnippetId)}
                onCreate={() => undefined}
                onBack={() => navigate('sessions')}
                onCollapse={collapseSidebar}
                onArchive={() => undefined}
                onRestore={() => undefined}
              />
            ) : page === 'groups' ? (
              <GroupsSidebar
                canCreateGroups={false}
                currentUser={demoCurrentUser}
                footerProps={footerProps}
                groups={demoGroups}
                selectedGroupId={selectedGroupId}
                selectedView="group"
                superAdminUsers={[]}
                onBackToSessions={() => navigate('sessions')}
                onCollapse={collapseSidebar}
                onArchiveGroup={() => undefined}
                onCreateGroup={() => undefined}
                onSelectGroup={(id) => selectResource('groups', id, setSelectedGroupId)}
                onSelectSuperAdmins={() => undefined}
              />
            ) : (
              <ThreadSidebar
                archivedSessionsOpen
                canCallApi={false}
                canStartNewThread={false}
                canWriteSession={() => false}
                archivedSessionsLoaded
                archivedSessionsLoading={false}
                hasMoreArchivedSessions={false}
                hasMoreSessions={false}
                loading={false}
                loadingMoreSessions={false}
                childSessionCursors={new Map()}
                childSessionsLoading={new Set()}
                revealedLineage={[]}
                revealedLineageSearchQuery=""
                footerProps={footerProps}
                searchQuery={sessionSearchQuery}
                searchResults={searchResults}
                searchLoading={false}
                hasMoreSearchResults={false}
                sessionFilters={sessionFilters}
                sessionFilterCount={activeSessionFilterCount}
                sessionTagOptions={sessionTagOptions}
                sessions={filteredSessions}
                selectedSessionId={selected.session.id}
                onArchive={() => undefined}
                onArchivedSessionsOpenChange={() => undefined}
                onCollapse={collapseSidebar}
                onLoadMoreArchivedSessions={() => undefined}
                onLoadMoreSearchResults={() => undefined}
                onLoadMoreSessions={() => undefined}
                onLoadChildSessions={() => undefined}
                onNewThread={() => undefined}
                onRefresh={() => undefined}
                onClearLineageFilters={() => undefined}
                onClearLineageSearch={() => undefined}
                onDismissLineageReveal={() => undefined}
                onSearchChange={setSessionSearchQuery}
                onShowInTree={(session) => {
                  setSessionSearchQuery('');
                  setSessionFilters(emptyStaticSessionFilters);
                  selectResource('sessions', session.id, setSelectedSessionId);
                }}
                onSessionFiltersChange={setSessionFilters}
                onSessionFiltersClear={() => setSessionFilters(emptyStaticSessionFilters)}
                onSessionListHoverChange={() => undefined}
                onSessionStarChange={changeSessionStar}
                onSelect={(id) => selectResource('sessions', id, setSelectedSessionId)}
                onUnarchive={() => undefined}
              />
            )}
          </aside>
        )}
        {page === 'automations' ? (
          <AutomationsPanel
            automation={selectedAutomation}
            automationsLoaded
            automationsLoading={false}
            canCallApi={false}
            canCreateAutomations={false}
            groups={demoGroups}
            token=""
            environmentOptions={demoEnvironments}
            environmentOptionsLoading={false}
            environmentOptionsError=""
            repositoryOptions={[]}
            repositoryOptionsLoading={false}
            repositoryOptionsError=""
            modelChoices={[]}
            defaultReasoningLevel=""
            selectedAutomationId={selectedAutomationId}
            showOpenSidebar={!sidebarOpen}
            openSidebarLabel="Open automations"
            loadInvocationPage={loadDemoAutomationInvocations}
            onAutomationChanged={() => undefined}
            onArchiveAutomation={() => undefined}
            onAutomationSaved={() => undefined}
            onOpenSidebar={() => setSidebarOpen(true)}
            onSessionCreated={() => undefined}
            onSelectSession={(id) => {
              const demoSession = sessions.find((session) => session.id === id);
              if (demoSession) selectResource('sessions', demoSession.id, setSelectedSessionId);
            }}
            onUnarchiveAutomation={() => undefined}
            onError={() => undefined}
          />
        ) : page === 'environments' ? (
          <EnvironmentsPanel
            environments={demoEnvironments}
            environmentsLoading={false}
            environmentsError=""
            selectedEnvironmentId={selectedEnvironmentId}
            selectedRevisionId={selectedEnvironmentRevisionId}
            canCallApi={false}
            groups={demoGroups}
            token=""
            repositoryOptions={[]}
            repositoryOptionsLoading={false}
            repositoryOptionsError=""
            showOpenSidebar={!sidebarOpen}
            openSidebarLabel="Open environments"
            loadRevisionHistory={loadDemoEnvironmentRevisions}
            onCreateEnvironment={() => false}
            onDirtyChange={() => undefined}
            onEnvironmentChanged={() => undefined}
            onOpenSidebar={() => setSidebarOpen(true)}
            onSelectRevision={(revisionId) => {
              setSelectedEnvironmentRevisionId(revisionId);
              updateDemoUrl('environments', selectedEnvironmentId, revisionId);
            }}
            onError={() => undefined}
          />
        ) : page === 'skills' ? (
          <SkillsPanel
            skill={selectedSkill}
            selectedSkillId={selectedSkillId}
            selectedRevisionId={selectedSkillRevisionId}
            loaded
            loading={false}
            readOnly
            token=""
            groups={demoGroups}
            creatableGroups={[]}
            showOpenSidebar={!sidebarOpen}
            onOpenSidebar={() => setSidebarOpen(true)}
            onSkillChanged={() => undefined}
            onSkillSaved={() => undefined}
            onArchiveSkill={() => undefined}
            onDirtyChange={() => undefined}
            onRestoreSkill={() => undefined}
            onSelectRevision={setSelectedSkillRevisionId}
            onError={() => undefined}
          />
        ) : page === 'snippets' ? (
          <SnippetsPanel
            readOnly
            snippet={selectedSnippet}
            selectedId={selectedSnippetId}
            loading={false}
            mutationPending={false}
            showOpenSidebar={!sidebarOpen}
            onOpenSidebar={() => setSidebarOpen(true)}
            onSave={async () => null}
            onChanged={() => undefined}
            onArchive={() => undefined}
            onRestore={() => undefined}
            onDirtyChange={() => undefined}
            onError={() => undefined}
          />
        ) : page === 'groups' ? (
          <GroupsPanel
            canCreateGroups={false}
            currentUser={demoCurrentUser}
            groupMembers={demoGroupMembers}
            groups={demoGroups}
            groupForm={{
              name: selectedGroup?.name ?? '',
              visibility: selectedGroup?.defaultVisibility ?? 'organization',
              writePolicy: selectedGroup?.defaultWritePolicy ?? 'group_members',
              automationCreateRequiredRole: selectedGroup?.automationCreateRequiredRole ?? 'member',
              serverError: '',
            }}
            groupFormError=""
            memberSearch={{ query: '', loading: false, userId: '', role: 'viewer', options: [] }}
            selectedGroupId={selectedGroupId}
            selectedView="group"
            superAdminSearch={{ query: '', loading: false, userId: '', options: [] }}
            superAdminUsers={[]}
            showOpenSidebar={!sidebarOpen}
            onAddMember={() => undefined}
            onArchiveGroup={() => undefined}
            onCreateGroup={() => undefined}
            onGroupFormAutomationCreateRequiredRoleChange={() => undefined}
            onGroupFormNameChange={() => undefined}
            onGroupFormVisibilityChange={() => undefined}
            onGroupFormWritePolicyChange={() => undefined}
            onMemberRoleChange={() => undefined}
            onMemberSearchQueryChange={() => undefined}
            onMemberUserIdChange={() => undefined}
            onOpenSidebar={() => setSidebarOpen(true)}
            onPromoteSuperAdmin={() => undefined}
            onRemoveMember={() => undefined}
            onRemoveSuperAdmin={() => undefined}
            onSaveGroup={() => undefined}
            onSelectGroup={(id) => selectResource('groups', id, setSelectedGroupId)}
            onSelectMemberUser={() => undefined}
            onSelectSuperAdminUser={() => undefined}
            onSelectSuperAdmins={() => undefined}
            onSuperAdminSearchQueryChange={() => undefined}
            onSuperAdminUserIdChange={() => undefined}
            onUpdateMemberRole={() => undefined}
          />
        ) : (
          <StaticSessionView
            demoSession={selected}
            onOpenSidebar={() => setSidebarOpen(true)}
            onSessionStarChange={changeSessionStar}
            onOpenSkill={(skillId, revisionId) => {
              if (!demoManagedSkillIds.has(skillId)) return;
              setPage('skills');
              setSelectedSkillId(skillId);
              setSelectedSkillRevisionId(revisionId);
              setSidebarOpen(false);
              updateDemoUrl('skills', skillId, revisionId);
            }}
          />
        )}
      </section>
    </main>
  );

  function collapseSidebar() {
    setSidebarOpen(false);
    if (window.matchMedia('(min-width: 768px)').matches) setSidebarCollapsed(true);
  }
}

function StaticSessionView(props: {
  demoSession: StaticDemoSession;
  onOpenSidebar: () => void;
  onSessionStarChange: (sessionId: string, starred: boolean) => void;
  onOpenSkill: (skillId: string, revisionId: string) => void;
}) {
  const { session } = props.demoSession;
  const repository = repositoryLabel(session.context?.repository);
  const branch = typeof session.context?.branch === 'string' ? session.context.branch : null;
  const model = typeof session.context?.model === 'string' ? session.context.model : '';
  const modelChoices = model ? [modelChoice(model)] : [];
  const services = props.demoSession.services ?? [];

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <ThreadHeader
        selectedSession={session}
        canWriteSession={false}
        canOpenWorkspaceTools
        workspaceToolsDisabled
        showOpenSidebar
        workspaceToolsUnavailableReason=""
        onArchive={() => undefined}
        onSessionStarChange={props.onSessionStarChange}
        onOpenSidebar={props.onOpenSidebar}
        onUpdateTags={async () => false}
        onUpdateTitle={async () => false}
        onOpenWorkspaceTool={async () => undefined}
        sessionTagOptions={[]}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden px-3 pt-4 md:px-8 xl:px-16">
          <div className="min-h-0 flex-1 overflow-auto pb-5" role="log" aria-label="Static demo session messages">
            <MobileContextPanel
              environment={null}
              repository={repository}
              branch={branch}
              artifacts={props.demoSession.artifacts}
              services={services}
              serviceLinksDisabled
              externalResources={props.demoSession.externalResources}
              callbacks={props.demoSession.callbacks}
              canWriteSession={false}
              onExtendSandbox={() => undefined}
              onReplayCallback={() => undefined}
            />
            <ChatPanel
              activeProgress={{}}
              artifacts={props.demoSession.artifacts}
              canWriteSession={false}
              services={services}
              serviceLinksDisabled
              canRetryMessages={false}
              editingMessageId=""
              events={props.demoSession.events}
              messageDraft=""
              messages={props.demoSession.messages}
              onCancelEdit={() => undefined}
              onCancelQueuedMessage={() => undefined}
              onCancelRun={() => undefined}
              onEditMessage={() => undefined}
              onToggleSteering={() => undefined}
              steeringMessageIds={new Set()}
              onMessageDraftChange={() => undefined}
              onRetryFailedMessages={() => undefined}
              onSaveEdit={() => undefined}
              onExtendSandbox={() => undefined}
              onLoadArtifactPreview={loadStaticArtifactPreview}
              openableManagedSkillIds={demoManagedSkillIds}
              onOpenSkill={props.onOpenSkill}
            />
          </div>
          <MessageComposer
            key={session.id}
            archived={session.status === 'archived'}
            readOnly
            compactInput
            environmentId=""
            environmentBranchOverrides={{}}
            environmentOptions={[]}
            environmentOptionsLoading={false}
            environmentOptionsError=""
            repository=""
            inheritedEnvironment={null}
            inheritedCodebaseLabel={repository ?? ''}
            inheritedRepository={repository ?? ''}
            repositoryOptions={[]}
            repositoryOptionsLoading={false}
            repositoryOptionsError=""
            branch=""
            inheritedBranch={branch ?? ''}
            branchOptions={[]}
            branchOptionsLoading={false}
            branchOptionsError=""
            model={model}
            inheritedModel={model}
            modelChoices={modelChoices}
            modelUnavailableReason=""
            reasoningLevel=""
            inheritedReasoningLevel=""
            defaultReasoningLevel=""
            skills={[]}
            skillsEnabled={false}
            onCodebaseChange={() => undefined}
            onEnvironmentBranchOverridesChange={() => undefined}
            onEnvironmentRepositoryBranchesLoad={async () => []}
            onBranchChange={() => undefined}
            onModelChange={() => undefined}
            onReasoningLevelChange={() => undefined}
            onFocusChange={() => undefined}
            onSubmit={async () => false}
          />
        </section>
        <DesktopContextPanel
          environment={null}
          repository={repository}
          branch={branch}
          artifacts={props.demoSession.artifacts}
          services={services}
          serviceLinksDisabled
          externalResources={props.demoSession.externalResources}
          callbacks={props.demoSession.callbacks}
          canWriteSession={false}
          onExtendSandbox={() => undefined}
          onReplayCallback={() => undefined}
        />
      </div>
    </section>
  );
}

async function loadStaticArtifactPreview(artifact: StaticDemoSession['artifacts'][number]): Promise<ArtifactPreview> {
  if (!artifact.url) return fallbackPreview;
  const response = await fetch(artifact.url);
  if (!response.ok) throw new Error(`Artifact preview request failed with ${response.status}`);
  const text = await response.text();
  return {
    text,
    contentType: response.headers.get('content-type') ?? stringPayload(artifact.payload.contentType) ?? 'text/plain',
    truncated: false,
    sizeBytes: new TextEncoder().encode(text).byteLength,
  };
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function repositoryLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const repository = value as Record<string, unknown>;
  if (repository.provider !== 'github') return null;
  const owner = typeof repository.owner === 'string' ? repository.owner : '';
  const repo = typeof repository.repo === 'string' ? repository.repo : '';
  return owner && repo ? `${owner}/${repo}` : null;
}

function modelChoice(model: string): ModelChoice {
  return { value: model, label: formatModelLabel(model), available: true };
}

function withSessionDefaults(session: Session): Session {
  return {
    ...session,
    lastActivityAt: session.lastActivityAt ?? session.updatedAt,
    tags: session.tags ?? [],
  };
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

function shouldOpenSessionsOnMobile(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get('openSessionsOnMobile') === '1' && (window.matchMedia?.('(max-width: 767px)').matches ?? false);
}

function getInitialPage(): StaticDemoPage {
  const params = new URLSearchParams(window.location.search);
  const requestedPage = params.get('page');
  if (isStaticDemoPage(requestedPage)) return requestedPage;
  if (params.has('automation')) return 'automations';
  if (params.has('environment')) return 'environments';
  if (params.has('skill')) return 'skills';
  if (params.has('snippet')) return 'snippets';
  if (params.has('group')) return 'groups';
  return 'sessions';
}

function isStaticDemoPage(value: string | null): value is StaticDemoPage {
  return (
    value === 'sessions' ||
    value === 'automations' ||
    value === 'environments' ||
    value === 'skills' ||
    value === 'snippets' ||
    value === 'groups'
  );
}

function getInitialResourceId<T extends { id: string }>(queryKey: string, resources: T[]): string {
  const requestedId = new URLSearchParams(window.location.search).get(queryKey) ?? '';
  return resources.some((resource) => resource.id === requestedId) ? requestedId : (resources[0]?.id ?? '');
}

function getInitialRevisionId(page: 'environments' | 'skills'): string {
  return getInitialPage() === page ? (new URLSearchParams(window.location.search).get('revision') ?? '') : '';
}

function updateDemoUrl(page: StaticDemoPage, resourceId: string, revisionId = '') {
  const url = new URL(window.location.href);
  for (const key of ['page', 'session', 'automation', 'environment', 'skill', 'snippet', 'group', 'revision']) {
    url.searchParams.delete(key);
  }
  if (page !== 'sessions') url.searchParams.set('page', page);
  const resourceKey = resourceQueryKey(page);
  if (resourceId) url.searchParams.set(resourceKey, resourceId);
  if (revisionId && (page === 'environments' || page === 'skills')) url.searchParams.set('revision', revisionId);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  if (nextUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.pushState({}, '', nextUrl);
  }
}

function resourceQueryKey(page: StaticDemoPage): string {
  if (page === 'automations') return 'automation';
  if (page === 'environments') return 'environment';
  if (page === 'skills') return 'skill';
  if (page === 'snippets') return 'snippet';
  if (page === 'groups') return 'group';
  return 'session';
}

function getInitialSessionId(data: StaticDemoData): string {
  const params = new URLSearchParams(window.location.search);
  const requestedSessionId = params.get('session') ?? '';
  const sessions = mergeDemoSessions(data);

  if (requestedSessionId && sessions.some((item) => item.session.id === requestedSessionId)) {
    return requestedSessionId;
  }

  return sessions[0]?.session.id || '';
}

function mergeDemoSessions(data: StaticDemoData | null): StaticDemoSession[] {
  const exportedSessions = data?.sessions ?? [];
  const exportedIds = new Set(exportedSessions.map((item) => item.session.id));
  return [...exportedSessions, ...demoShowcaseSessions.filter((item) => !exportedIds.has(item.session.id))];
}

function matchesStaticSessionFilters(
  session: Session,
  demoSession: StaticDemoSession | undefined,
  filters: StaticSessionFilters,
): boolean {
  if (filters.tags.some((tag) => !session.tags.includes(tag))) return false;
  if (filters.starredByMe && !session.starred) return false;
  if (filters.createdByMe && session.createdByUserId !== demoCurrentUser.id) return false;
  if (
    filters.participatedByMe &&
    !demoSession?.messages.some((message) => message.authorUserId === demoCurrentUser.id)
  ) {
    return false;
  }
  return true;
}

function staticSessionSearchMatch(
  session: Session,
  demoSession: StaticDemoSession | undefined,
  query: string,
): Pick<SessionSearchResult, 'matchKind' | 'snippet'> | null {
  const title = session.title ?? 'Untitled session';
  if (title.toLowerCase().includes(query)) return { matchKind: 'title', snippet: title };

  const prompt = demoSession?.messages.find((message) => message.prompt.toLowerCase().includes(query))?.prompt;
  if (prompt) return { matchKind: 'prompt', snippet: prompt };

  const response = demoSession?.events.find(
    (event) =>
      event.type === 'agent_response_final' &&
      String(event.payload.text ?? '')
        .toLowerCase()
        .includes(query),
  )?.payload.text;
  return typeof response === 'string' ? { matchKind: 'response', snippet: response } : null;
}

function resolveThemePreference(theme: ThemePreference): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
