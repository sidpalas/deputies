import { useEffect, useMemo, useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import type { ArtifactPreview, ModelOption, Session } from '../api.js';
import { MessageComposer, ThreadHeader, ThreadSidebar } from '../components/app-panels.js';
import type { ThemePreference } from '../components/app-panels.js';
import { ChatPanel, DesktopContextPanel, MobileContextPanel } from '../components/thread/thread-content.js';
import { Button } from '../components/ui/button.js';
import type { StaticDemoData, StaticDemoSession } from './types.js';

const fallbackPreview: ArtifactPreview = {
  text: 'Artifact preview is not included in the static demo export.',
  contentType: 'text/plain',
  truncated: false,
  sizeBytes: 0,
};

export function StaticDemoApp() {
  const [data, setData] = useState<StaticDemoData | null>(null);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState('');
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
        setSelectedSessionId((current) => current || nextData.sessions[0]?.session.id || '');
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load static demo data.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sessions = useMemo(() => data?.sessions.map((item) => item.session) ?? [], [data]);
  const selected = data?.sessions.find((item) => item.session.id === selectedSessionId) ?? data?.sessions[0] ?? null;

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
              aria-label="Expand sessions"
              title="Expand sessions"
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
            <ThreadSidebar
              archivedSessionsOpen
              authRequired={false}
              canAdmin={false}
              canCallApi={false}
              canViewSetup={false}
              connectionStatus={{ state: 'ok', message: 'Static demo data loaded.' }}
              health={{ status: 'ok', runMode: 'static-demo', apiAuthMode: 'none' }}
              loading={false}
              sessions={sessions}
              selectedSessionId={selected.session.id}
              themePreference={themePreference}
              token=""
              onArchive={() => undefined}
              onArchivedSessionsOpenChange={() => undefined}
              onCollapse={() => {
                setSidebarOpen(false);
                if (window.matchMedia('(min-width: 768px)').matches) setSidebarCollapsed(true);
              }}
              onNewThread={() => undefined}
              onOpenSetup={() => undefined}
              onRefresh={() => undefined}
              onSelect={(sessionId) => {
                setSelectedSessionId(sessionId);
                setSidebarOpen(false);
              }}
              onSignOut={() => undefined}
              onThemeChange={setThemePreference}
              onUnarchive={() => undefined}
            />
          </aside>
        )}
        <StaticSessionView demoSession={selected} onOpenSidebar={() => setSidebarOpen(true)} />
      </section>
    </main>
  );
}

function StaticSessionView(props: { demoSession: StaticDemoSession; onOpenSidebar: () => void }) {
  const { session } = props.demoSession;
  const repository = repositoryLabel(session.context?.repository);
  const branch = typeof session.context?.branch === 'string' ? session.context.branch : null;
  const model = typeof session.context?.model === 'string' ? session.context.model : '';
  const modelOptions = model ? [modelOption(model)] : [];
  const services = props.demoSession.services ?? [];

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <ThreadHeader
        selectedSession={session}
        canAdmin={false}
        canOpenWorkspaceTools
        workspaceToolsDisabled
        showOpenSidebar
        workspaceToolsUnavailableReason=""
        onArchive={() => undefined}
        onOpenSidebar={props.onOpenSidebar}
        onUpdateTitle={async () => false}
        onOpenWorkspaceTool={async () => undefined}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden px-3 pt-4 md:px-8 xl:px-16">
          <div className="min-h-0 flex-1 overflow-auto pb-5" role="log" aria-label="Static demo session messages">
            <MobileContextPanel
              repository={repository}
              branch={branch}
              artifacts={props.demoSession.artifacts}
              services={services}
              externalResources={props.demoSession.externalResources}
              callbacks={props.demoSession.callbacks}
              canAdmin={false}
              onExtendSandbox={() => undefined}
              onReplayCallback={() => undefined}
            />
            <ChatPanel
              artifacts={props.demoSession.artifacts}
              canAdmin={false}
              services={services}
              canRetryMessages={false}
              editingMessageId=""
              events={props.demoSession.events}
              messageDraft=""
              messages={props.demoSession.messages}
              onCancelEdit={() => undefined}
              onCancelQueuedMessage={() => undefined}
              onCancelRun={() => undefined}
              onEditMessage={() => undefined}
              onMessageDraftChange={() => undefined}
              onRetryFailedMessages={() => undefined}
              onSaveEdit={() => undefined}
              onExtendSandbox={() => undefined}
              onLoadArtifactPreview={loadStaticArtifactPreview}
            />
          </div>
          <MessageComposer
            key={session.id}
            archived={session.status === 'archived'}
            readOnly
            hasSelectedRepository={Boolean(repository)}
            repository=""
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
            modelOptions={modelOptions}
            modelUnavailableReason=""
            onBranchChange={() => undefined}
            onModelChange={() => undefined}
            onRepositoryChange={() => undefined}
            onFocusChange={() => undefined}
            onSubmit={async () => false}
          />
        </section>
        <DesktopContextPanel
          repository={repository}
          branch={branch}
          artifacts={props.demoSession.artifacts}
          services={services}
          externalResources={props.demoSession.externalResources}
          callbacks={props.demoSession.callbacks}
          canAdmin={false}
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

function modelOption(model: string): ModelOption {
  return { value: model, label: model.replace(/^[^/]+\//, '').replace(/-/g, ' '), available: true };
}

function resolveThemePreference(theme: ThemePreference): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
