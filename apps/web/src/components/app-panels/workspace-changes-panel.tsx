import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, FileCode2, GitBranch, RefreshCw } from 'lucide-react';
import {
  ApiError,
  getWorkspaceChangePatch,
  getWorkspaceChanges,
  type WorkspaceChangeFile,
  type WorkspaceChangePatch,
  type WorkspaceChanges,
  type WorkspaceChangesRepository,
  type WorkspacePatchLayer,
} from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';

type SelectedChange = { repositoryId: string; fileId: string };
type LoadChangesOptions = {
  background?: boolean;
  supersede?: boolean;
  notifyWorkspaceConnected?: boolean;
};

export type WorkspaceChangesSnapshot = {
  changes: WorkspaceChanges;
  patches: WorkspaceChangePatch[];
};

const maxRenderedDiffLines = 3_000;

function patchKey(repositoryId: string, fileId: string, layer: WorkspacePatchLayer): string {
  return `${repositoryId}\0${fileId}\0${layer}`;
}

export function WorkspaceChangesPanel(props: {
  sessionId: string;
  token: string;
  active: boolean;
  snapshot?: WorkspaceChangesSnapshot;
  onWorkspaceConnected?: () => void;
}) {
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null);
  const [selected, setSelected] = useState<SelectedChange | null>(null);
  const [layer, setLayer] = useState<WorkspacePatchLayer>('combined');
  const [patch, setPatch] = useState<WorkspaceChangePatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [patchLoading, setPatchLoading] = useState(false);
  const [error, setError] = useState('');
  const [patchError, setPatchError] = useState('');
  const [mobileFileListOpen, setMobileFileListOpen] = useState(true);
  const wasActiveRef = useRef(props.active);
  const pendingPatchNotificationRef = useRef<string | null>(null);
  const onWorkspaceConnectedRef = useRef(props.onWorkspaceConnected);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const summaryGenerationRef = useRef(0);
  onWorkspaceConnectedRef.current = props.onWorkspaceConnected;

  const loadChanges = useCallback(
    async (options: LoadChangesOptions = {}) => {
      const { background = false, supersede = true, notifyWorkspaceConnected = false } = options;
      if (props.snapshot) {
        setChanges(props.snapshot.changes);
        setError('');
        setLoading(false);
        setRefreshing(false);
        return;
      }
      if (!supersede && summaryAbortRef.current) return;
      summaryAbortRef.current?.abort();
      const controller = new AbortController();
      const generation = summaryGenerationRef.current + 1;
      summaryGenerationRef.current = generation;
      summaryAbortRef.current = controller;
      if (background) setRefreshing(true);
      else setLoading(true);
      try {
        const result = await getWorkspaceChanges({
          sessionId: props.sessionId,
          token: props.token,
          signal: controller.signal,
        });
        if (controller.signal.aborted || summaryGenerationRef.current !== generation) return;
        setChanges(result);
        setError('');
        if (notifyWorkspaceConnected) onWorkspaceConnectedRef.current?.();
      } catch (cause) {
        if (!controller.signal.aborted && summaryGenerationRef.current === generation)
          setError(workspaceErrorMessage(cause));
      } finally {
        if (summaryGenerationRef.current === generation) {
          summaryAbortRef.current = null;
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [props.sessionId, props.snapshot, props.token],
  );

  useEffect(() => {
    setChanges(null);
    setSelected(null);
    setPatch(null);
    setError('');
    setMobileFileListOpen(true);
    pendingPatchNotificationRef.current = null;
    void loadChanges({ notifyWorkspaceConnected: true });
    return () => {
      summaryGenerationRef.current += 1;
      summaryAbortRef.current?.abort();
      summaryAbortRef.current = null;
    };
  }, [loadChanges]);

  useEffect(() => {
    if (!props.active || props.snapshot) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadChanges({ background: true, supersede: false });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadChanges, props.active, props.snapshot]);

  useEffect(() => {
    if (props.snapshot) {
      wasActiveRef.current = props.active;
      return;
    }
    if (wasActiveRef.current && !props.active) void loadChanges({ background: true, notifyWorkspaceConnected: true });
    wasActiveRef.current = props.active;
  }, [loadChanges, props.active, props.snapshot]);

  useEffect(() => {
    if (!changes) return;
    const currentFile = changes.repositories
      .find((repository) => repository.id === selected?.repositoryId)
      ?.files.find((file) => file.id === selected?.fileId);
    if (currentFile) {
      if (!layerAvailable(currentFile, layer)) {
        pendingPatchNotificationRef.current = null;
        setLayer(defaultLayer(currentFile));
      }
      return;
    }
    const repository = changes.repositories.find((candidate) => candidate.files.length > 0);
    const file = repository?.files[0];
    pendingPatchNotificationRef.current = null;
    setSelected(repository && file ? { repositoryId: repository.id, fileId: file.id } : null);
    if (file) setLayer(defaultLayer(file));
  }, [changes, layer, selected]);

  const selectedRepository = changes?.repositories.find((repository) => repository.id === selected?.repositoryId);
  const selectedFile = selectedRepository?.files.find((file) => file.id === selected?.fileId);

  useEffect(() => {
    if (!selectedRepository || !selectedFile) {
      setPatch(null);
      return;
    }
    const controller = new AbortController();
    const requestKey = patchKey(selectedRepository.id, selectedFile.id, layer);
    setPatch(null);
    setPatchLoading(true);
    setPatchError('');
    if (props.snapshot) {
      const capturedPatch = props.snapshot.patches.find(
        (candidate) =>
          candidate.repositoryId === selectedRepository.id &&
          candidate.fileId === selectedFile.id &&
          candidate.layer === layer,
      );
      setPatch(capturedPatch ?? null);
      setPatchLoading(false);
      return;
    }
    getWorkspaceChangePatch({
      sessionId: props.sessionId,
      repositoryId: selectedRepository.id,
      fileId: selectedFile.id,
      layer,
      token: props.token,
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setPatch(result);
          if (pendingPatchNotificationRef.current === requestKey) {
            pendingPatchNotificationRef.current = null;
            onWorkspaceConnectedRef.current?.();
          }
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setPatch(null);
          setPatchError(workspaceErrorMessage(cause));
          if (pendingPatchNotificationRef.current === requestKey) pendingPatchNotificationRef.current = null;
          if (cause instanceof ApiError && cause.code === 'file_not_changed') void loadChanges({ background: true });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPatchLoading(false);
      });
    return () => controller.abort();
  }, [layer, loadChanges, props.sessionId, props.snapshot, props.token, selectedFile, selectedRepository]);

  function selectChange(repository: WorkspaceChangesRepository, file: WorkspaceChangeFile) {
    const nextLayer = defaultLayer(file);
    if (selected?.repositoryId === repository.id && selected.fileId === file.id && layer === nextLayer) {
      setMobileFileListOpen(false);
      return;
    }
    pendingPatchNotificationRef.current = patchKey(repository.id, file.id, nextLayer);
    setSelected({ repositoryId: repository.id, fileId: file.id });
    setLayer(nextLayer);
    setMobileFileListOpen(false);
  }

  const fileCount = changes?.repositories.reduce((total, repository) => total + repository.files.length, 0) ?? 0;
  const repositoryCount = changes?.repositories.filter((repository) => repository.files.length > 0).length ?? 0;
  const partial = changes?.repositories.some((repository) => !repository.complete) ?? false;

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
      aria-label="Workspace changes"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <h3 className="font-semibold text-card-foreground">Workspace Changes</h3>
          <p className="text-xs text-muted-foreground">
            {changes
              ? `${fileCount} changed ${fileCount === 1 ? 'file' : 'files'}${partial ? ' shown' : ''}${repositoryCount > 1 ? ` across ${repositoryCount} repositories` : ''}`
              : props.snapshot
                ? 'Captured changes from this session'
                : 'Live uncommitted changes in the sandbox'}
          </p>
        </div>
        {props.snapshot ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading || refreshing}
            onClick={() => void loadChanges({ background: true, notifyWorkspaceConnected: true })}
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Refresh
          </Button>
        )}
      </header>
      {error && changes ? (
        <p className="border-b border-border bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          Refresh failed; the displayed changes may be stale. {error}
        </p>
      ) : null}

      {loading && !changes ? (
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-sm text-muted-foreground">
          Inspecting workspace…
        </div>
      ) : error && !changes ? (
        <EmptyState icon={<AlertTriangle className="h-5 w-5" />} title="Changes unavailable" detail={error} />
      ) : changes ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)]">
          <nav
            className={cn(
              'min-h-0 overflow-y-auto border-b border-border bg-background/40 md:block md:border-b-0 md:border-r',
              !mobileFileListOpen && 'hidden',
            )}
            aria-label="Changed files"
          >
            {changes.repositories.map((repository) => (
              <RepositoryChanges
                key={repository.id}
                repository={repository}
                selected={selected}
                onSelect={selectChange}
              />
            ))}
            {changes.repositories.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No configured repositories are available in this workspace.
              </p>
            ) : fileCount === 0 && changes.repositories.every((repository) => repository.status === 'ready') ? (
              <p className="p-4 text-sm text-muted-foreground">
                The configured repositories have no uncommitted changes.
              </p>
            ) : null}
          </nav>

          <div className={cn('min-h-0 min-w-0 flex-col md:flex', mobileFileListOpen ? 'hidden' : 'flex')}>
            {selectedRepository && selectedFile ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <Button
                      className="-ml-2 shrink-0 md:hidden"
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setMobileFileListOpen(true)}
                    >
                      <ChevronLeft className="h-4 w-4" /> Files
                    </Button>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" title={selectedFile.path}>
                        {selectedFile.path}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {selectedRepository.owner}/{selectedRepository.name}
                      </p>
                    </div>
                  </div>
                  <LayerPicker
                    file={selectedFile}
                    layer={layer}
                    onChange={(nextLayer) => {
                      if (nextLayer === layer) return;
                      pendingPatchNotificationRef.current = patchKey(selectedRepository.id, selectedFile.id, nextLayer);
                      setLayer(nextLayer);
                    }}
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-auto bg-background">
                  {patchLoading ? (
                    <div className="grid min-h-40 place-items-center text-sm text-muted-foreground">Loading patch…</div>
                  ) : patchError ? (
                    <EmptyState
                      icon={<AlertTriangle className="h-5 w-5" />}
                      title="Patch unavailable"
                      detail={patchError}
                    />
                  ) : patch?.binary ? (
                    <EmptyState
                      icon={<FileCode2 className="h-5 w-5" />}
                      title="Binary file"
                      detail="A textual diff is not available for this file."
                    />
                  ) : patch?.patch ? (
                    <DiffView patch={patch.patch} />
                  ) : (
                    <EmptyState
                      icon={<FileCode2 className="h-5 w-5" />}
                      title="No changes in this layer"
                      detail="Choose another comparison to view this file's changes."
                    />
                  )}
                </div>
                {patch?.truncated ? (
                  <p className="border-t border-border bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
                    This patch was truncated at the live preview limit. Open VS Code to inspect the remainder.
                  </p>
                ) : null}
              </>
            ) : (
              <EmptyState
                icon={<FileCode2 className="h-5 w-5" />}
                title={fileCount ? 'Select a changed file' : 'No changes to show'}
                detail={
                  fileCount
                    ? 'Choose a file from the workspace changes list.'
                    : 'Changes will appear here as the sandbox worktree is updated.'
                }
              />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RepositoryChanges(props: {
  repository: WorkspaceChangesRepository;
  selected: SelectedChange | null;
  onSelect: (repository: WorkspaceChangesRepository, file: WorkspaceChangeFile) => void;
}) {
  const repository = props.repository;
  const [open, setOpen] = useState(repository.isPrimary);
  return (
    <details
      className="group border-b border-border last:border-b-0"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none select-none px-3 py-2 hover:bg-accent/60 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {repository.owner}/{repository.name}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">{repository.files.length}</span>
        </span>
        <span className="ml-11 block truncate text-xs text-muted-foreground">
          {repository.status === 'ready'
            ? `${repository.branch || 'detached HEAD'}${repository.isPrimary ? ' · primary' : ''}`
            : repositoryStatusText(repository.status)}
        </span>
      </summary>
      {repository.truncated ? (
        <p className="border-t border-border bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          Showing the first {repository.files.length} changed files.
        </p>
      ) : null}
      <div>
        {repository.files.map((file) => {
          const isSelected = props.selected?.repositoryId === repository.id && props.selected.fileId === file.id;
          return (
            <button
              key={file.id}
              type="button"
              className={cn(
                'flex w-full items-center gap-2 border-t border-border/60 px-3 py-1.5 text-left text-sm hover:bg-accent/60',
                isSelected && 'bg-accent text-accent-foreground',
              )}
              aria-current={isSelected ? 'true' : undefined}
              onClick={() => props.onSelect(repository, file)}
            >
              <span
                className="w-7 shrink-0 font-mono text-xs font-semibold text-muted-foreground"
                title={changeDescription(file)}
              >
                {changeCode(file)}
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              >
                {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              </span>
            </button>
          );
        })}
      </div>
    </details>
  );
}

function LayerPicker(props: {
  file: WorkspaceChangeFile;
  layer: WorkspacePatchLayer;
  onChange: (layer: WorkspacePatchLayer) => void;
}) {
  const options: Array<{ id: WorkspacePatchLayer; label: string }> = [];
  if (props.file.indexChange && props.file.worktreeChange) options.push({ id: 'combined', label: 'All' });
  if (props.file.indexChange) options.push({ id: 'index', label: 'Staged' });
  if (props.file.worktreeChange) options.push({ id: 'worktree', label: 'Unstaged' });
  if (options.length <= 1) return null;
  return (
    <div className="flex rounded-md border border-border bg-background p-0.5" role="group" aria-label="Diff comparison">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={cn(
            'rounded-sm px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground',
            props.layer === option.id && 'bg-secondary text-secondary-foreground',
          )}
          aria-pressed={props.layer === option.id}
          onClick={() => props.onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type DiffLine = {
  text: string;
  oldLine: number | null;
  newLine: number | null;
  kind: 'add' | 'delete' | 'context' | 'hunk' | 'meta';
};

function DiffView(props: { patch: string }) {
  const lines = useMemo(() => parseDiff(props.patch, maxRenderedDiffLines + 1), [props.patch]);
  const renderingTruncated = lines.length > maxRenderedDiffLines;
  const renderedLines = renderingTruncated ? lines.slice(0, maxRenderedDiffLines) : lines;
  return (
    <>
      <div className="min-w-max py-1 font-mono text-xs leading-5" role="table" aria-label="Unified diff">
        {renderedLines.map((line, index) => (
          <div
            key={`${index}:${line.text}`}
            className={cn(
              'grid grid-cols-[3.25rem_3.25rem_minmax(0,1fr)]',
              line.kind === 'add' && 'bg-success/15',
              line.kind === 'delete' && 'bg-destructive/15',
              line.kind === 'hunk' && 'bg-info/15 text-info',
              line.kind === 'meta' && 'text-muted-foreground',
            )}
            role="row"
          >
            <span
              className="select-none border-r border-border/60 px-2 text-right text-muted-foreground/70"
              role="cell"
            >
              {line.oldLine ?? ''}
            </span>
            <span
              className="select-none border-r border-border/60 px-2 text-right text-muted-foreground/70"
              role="cell"
            >
              {line.newLine ?? ''}
            </span>
            <span className="whitespace-pre px-2" role="cell">
              {line.text || ' '}
            </span>
          </div>
        ))}
      </div>
      {renderingTruncated ? (
        <p className="border-t border-border bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          Rendering the first {maxRenderedDiffLines.toLocaleString()} lines of this patch.
        </p>
      ) : null}
    </>
  );
}

export function parseDiff(patch: string, maxLines?: number): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return patch
    .replace(/\n$/, '')
    .split('\n', maxLines)
    .map((text) => {
      if (text.startsWith('diff --git ') || text.startsWith('diff --cc ') || text.startsWith('diff --combined ')) {
        inHunk = false;
        return { text, oldLine: null, newLine: null, kind: 'meta' as const };
      }
      const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        return { text, oldLine: null, newLine: null, kind: 'hunk' as const };
      }
      if (inHunk && text.startsWith('+')) return { text, oldLine: null, newLine: newLine++, kind: 'add' as const };
      if (inHunk && text.startsWith('-')) return { text, oldLine: oldLine++, newLine: null, kind: 'delete' as const };
      if (inHunk && text.startsWith(' '))
        return { text, oldLine: oldLine++, newLine: newLine++, kind: 'context' as const };
      if (
        text.startsWith('diff ') ||
        text.startsWith('index ') ||
        text.startsWith('--- ') ||
        text.startsWith('+++ ') ||
        text.startsWith('new file ') ||
        text.startsWith('deleted file ') ||
        text.startsWith('similarity ') ||
        text.startsWith('rename ')
      )
        return { text, oldLine: null, newLine: null, kind: 'meta' as const };
      return { text, oldLine: null, newLine: null, kind: 'meta' as const };
    });
}

function EmptyState(props: { icon: React.ReactNode; title: string; detail: string }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto mb-2 grid h-9 w-9 place-items-center rounded-full bg-muted text-muted-foreground">
          {props.icon}
        </span>
        <p className="text-sm font-medium">{props.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{props.detail}</p>
      </div>
    </div>
  );
}

function defaultLayer(file: WorkspaceChangeFile): WorkspacePatchLayer {
  if (file.indexChange && !file.worktreeChange) return 'index';
  if (file.worktreeChange && !file.indexChange) return 'worktree';
  return 'combined';
}

function layerAvailable(file: WorkspaceChangeFile, layer: WorkspacePatchLayer): boolean {
  if (layer === 'index') return Boolean(file.indexChange);
  if (layer === 'worktree') return Boolean(file.worktreeChange);
  return Boolean(file.indexChange && file.worktreeChange);
}

function changeCode(file: WorkspaceChangeFile): string {
  if (file.worktreeChange === 'untracked') return '??';
  return `${changeInitial(file.indexChange)}${changeInitial(file.worktreeChange)}`;
}

function changeInitial(change: WorkspaceChangeFile['indexChange'] | WorkspaceChangeFile['worktreeChange']): string {
  return change
    ? (
        {
          added: 'A',
          modified: 'M',
          deleted: 'D',
          renamed: 'R',
          copied: 'C',
          type_changed: 'T',
          unmerged: 'U',
          untracked: '?',
        } as const
      )[change]
    : ' ';
}

function changeDescription(file: WorkspaceChangeFile): string {
  if (file.worktreeChange === 'untracked') return 'Untracked';
  return [
    file.indexChange ? `Staged: ${file.indexChange.replace('_', ' ')}` : '',
    file.worktreeChange ? `Unstaged: ${file.worktreeChange.replace('_', ' ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function repositoryStatusText(status: WorkspaceChangesRepository['status']): string {
  if (status === 'not_repository') return 'Repository is not available in this workspace';
  if (status === 'timed_out') return 'Inspection timed out';
  return 'Inspection failed';
}

function workspaceErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'sandbox_not_ready')
      return 'The sandbox is stopped or not ready. Start a run to resume the workspace.';
    if (cause.code === 'sandbox_unavailable') return 'This session does not have a live sandbox workspace.';
    if (cause.code === 'sandbox_inspection_unsupported')
      return 'Native changes are not supported by this sandbox provider yet. Use VS Code instead.';
    if (cause.status === 403) return 'Write access is required to inspect workspace source.';
    return cause.message;
  }
  return cause instanceof Error ? cause.message : 'Workspace changes could not be loaded.';
}
