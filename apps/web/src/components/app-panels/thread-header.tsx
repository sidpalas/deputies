import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Archive, ChevronDown, Code2, GitCompare, PanelLeftOpen, Pencil, Plus, Star, Wrench, X } from 'lucide-react';
import type { Session, SessionTagSummary, WorkspaceToolId } from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { sessionDisplayStatus, sessionDisplayTooltip, statusTextClass } from './shared.js';

type ThreadHeaderProps = {
  canWriteSession: boolean;
  canOpenWorkspaceTools?: boolean;
  workspaceToolsDisabled?: boolean;
  selectedSession: Session;
  showOpenSidebar: boolean;
  openSidebarLabel?: string;
  workspaceToolsUnavailableReason?: string;
  onArchive: () => void;
  onSessionStarChange: (sessionId: string, starred: boolean) => void;
  onOpenSidebar: () => void;
  onUpdateTags: (tags: string[]) => Promise<boolean>;
  onUpdateTitle: (title: string) => Promise<boolean>;
  onOpenWorkspaceTool: (toolId: WorkspaceToolId) => Promise<void>;
  sessionTagOptions: SessionTagSummary[];
};

const workspaceToolOptions = [
  { id: 'ide' as const, label: 'VS Code', Icon: Code2 },
  { id: 'diff' as const, label: 'Hunk Diff', Icon: GitCompare },
];

export function ThreadHeader(props: ThreadHeaderProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [tagPopoverLeft, setTagPopoverLeft] = useState(0);
  const [savingTags, setSavingTags] = useState(false);
  const [titleDraft, setTitleDraft] = useState(props.selectedSession.title ?? '');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [openingWorkspaceTool, setOpeningWorkspaceTool] = useState<WorkspaceToolId | ''>('');
  const toolsRef = useRef<HTMLDivElement>(null);
  const tagEditorRef = useRef<HTMLDivElement>(null);
  const tagButtonRef = useRef<HTMLButtonElement>(null);
  const canOpenWorkspaceTools = props.canOpenWorkspaceTools ?? props.canWriteSession;
  const workspaceToolsDisabled = Boolean(props.workspaceToolsDisabled);
  const sessionTags = props.selectedSession.tags ?? [];
  const workspaceUnavailableReason =
    props.workspaceToolsUnavailableReason ?? workspaceToolUnavailableReason(props.selectedSession);
  const tagQuery = normalizeTagDraft(tagDraft);
  const availableTagOptions = props.sessionTagOptions.filter((option) => !sessionTags.includes(option.tag));
  const filteredTagOptions = availableTagOptions
    .filter((option) => !tagQuery || option.tag.includes(tagQuery))
    .slice(0, 8);
  const canCreateTag = Boolean(
    tagQuery && !sessionTags.includes(tagQuery) && !availableTagOptions.some((option) => option.tag === tagQuery),
  );
  let tagPickerEmptyMessage = 'Type a tag name to create it.';
  if (tagQuery && sessionTags.includes(tagQuery)) {
    tagPickerEmptyMessage = 'Tag is already on this session.';
  } else if (props.sessionTagOptions.length && !availableTagOptions.length) {
    tagPickerEmptyMessage = 'All known tags are already on this session. Type a tag name to create it.';
  }

  useEffect(() => {
    setEditingTitle(false);
    setTitleDraft(props.selectedSession.title ?? '');
    setTagDraft('');
    setTagPopoverOpen(false);
  }, [props.selectedSession.id, props.selectedSession.title]);

  useEffect(() => {
    if (!tagPopoverOpen) return;

    updateTagPopoverPosition();

    function closeOnOutsideClick(event: MouseEvent) {
      if (event.target instanceof Node && tagEditorRef.current?.contains(event.target)) return;
      setTagPopoverOpen(false);
      setTagDraft('');
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setTagPopoverOpen(false);
      setTagDraft('');
    }

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', updateTagPopoverPosition);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', updateTagPopoverPosition);
    };
  }, [tagPopoverOpen]);

  useEffect(() => {
    if (!toolsOpen) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (event.target instanceof Node && toolsRef.current?.contains(event.target)) return;
      setToolsOpen(false);
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setToolsOpen(false);
    }

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [toolsOpen]);

  function startEditingTitle() {
    if (!props.canWriteSession) return;
    setTitleDraft(props.selectedSession.title ?? '');
    setEditingTitle(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = await props.onUpdateTitle(titleDraft);
    if (saved) setEditingTitle(false);
  }

  async function saveTags(tags: string[]) {
    setSavingTags(true);
    try {
      return await props.onUpdateTags(tags);
    } finally {
      setSavingTags(false);
    }
  }

  async function addTag(value: string) {
    const tag = normalizeTagDraft(value);
    if (!tag || sessionTags.includes(tag)) return;
    const saved = await saveTags([...sessionTags, tag].sort(compareTagNames));
    if (saved) {
      setTagDraft('');
      setTagPopoverOpen(false);
    }
  }

  async function openWorkspaceTool(toolId: WorkspaceToolId) {
    setToolsOpen(false);
    if (!canOpenWorkspaceTools || workspaceToolsDisabled) return;
    setOpeningWorkspaceTool(toolId);
    try {
      await props.onOpenWorkspaceTool(toolId);
    } finally {
      setOpeningWorkspaceTool('');
    }
  }

  function archiveSession() {
    setToolsOpen(false);
    if (!props.canWriteSession) return;
    props.onArchive();
  }

  function updateTagPopoverPosition() {
    const row = tagEditorRef.current;
    const button = tagButtonRef.current;
    if (!row || !button) return;

    const rowRect = row.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const popoverWidth = Math.min(320, rowRect.width);
    const desiredLeft = buttonRect.left - rowRect.left;
    const maxLeft = Math.max(0, rowRect.width - popoverWidth);
    setTagPopoverLeft(Math.min(Math.max(0, desiredLeft), maxLeft));
  }

  return (
    <section className="sticky top-0 z-20 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
      <div className="flex min-w-0 items-start gap-2">
        {props.showOpenSidebar ? (
          <Button
            className="self-center h-8 w-8 shrink-0 p-0 md:hidden"
            variant="ghost"
            size="icon"
            onClick={props.onOpenSidebar}
            aria-label={props.openSidebarLabel ?? 'Open sessions'}
            title={props.openSidebarLabel ?? 'Open sessions'}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Session</p>
          {editingTitle ? (
            <form
              className="mt-1 flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                void handleSubmit(event);
              }}
            >
              <Input
                className="max-w-xl"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                autoFocus
              />
              <Button type="submit" disabled={!titleDraft.trim()}>
                Save
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditingTitle(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="mt-1 flex min-w-0 items-center gap-1">
              <h2 className="min-w-0 truncate text-base font-semibold text-foreground">
                {props.selectedSession.title || 'Untitled session'}
              </h2>
              {props.canWriteSession ? (
                <Button
                  className="h-7 w-7 shrink-0 p-0"
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={startEditingTitle}
                  aria-label="Edit title"
                  title="Edit title"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </div>
      <div className="grid min-h-9 shrink-0 grid-cols-[auto_auto] items-center justify-items-end gap-2 justify-self-end">
        <Badge
          className={cn('col-start-1', statusTextClass(sessionDisplayStatus(props.selectedSession)))}
          title={sessionDisplayTooltip(props.selectedSession)}
        >
          {sessionDisplayStatus(props.selectedSession)}
        </Badge>
        <div className="col-start-2 flex justify-end gap-2">
          <Button
            className="h-9 gap-2"
            type="button"
            variant="secondary"
            onClick={() => props.onSessionStarChange(props.selectedSession.id, !props.selectedSession.starred)}
            aria-pressed={props.selectedSession.starred === true}
            title={props.selectedSession.starred ? 'Unstar session' : 'Star session'}
          >
            <Star className={cn('h-4 w-4', props.selectedSession.starred && 'fill-current text-warning')} />
            <span className="hidden sm:inline">{props.selectedSession.starred ? 'Starred' : 'Star'}</span>
          </Button>
          {canOpenWorkspaceTools ? (
            <div className="relative" ref={toolsRef}>
              <Button
                className="h-9 gap-2"
                type="button"
                variant="secondary"
                onClick={() => setToolsOpen((open) => !open)}
                aria-expanded={toolsOpen}
                aria-haspopup="menu"
                title="Tools"
              >
                <Wrench className="h-4 w-4" />
                <span className="hidden sm:inline">Tools</span>
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
              {toolsOpen ? (
                <div
                  className="absolute right-0 top-11 z-30 w-56 rounded-md border border-border bg-card p-1 text-sm text-card-foreground shadow-lg"
                  role="menu"
                >
                  <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Workspace Tools</p>
                  {workspaceUnavailableReason ? (
                    <p className="px-2 py-2 text-muted-foreground">{workspaceUnavailableReason}</p>
                  ) : (
                    workspaceToolOptions.map(({ id, label, Icon }) => (
                      <button
                        key={id}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={workspaceToolsDisabled || Boolean(openingWorkspaceTool)}
                        role="menuitem"
                        onClick={() => {
                          void openWorkspaceTool(id);
                        }}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="min-w-0 flex-1">{label}</span>
                        {openingWorkspaceTool === id ? (
                          <span className="text-xs text-muted-foreground">Opening...</span>
                        ) : null}
                      </button>
                    ))
                  )}
                  {props.selectedSession.status !== 'archived' ? (
                    <>
                      <div className="my-1 h-px bg-border" />
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={!props.canWriteSession}
                        role="menuitem"
                        onClick={archiveSession}
                      >
                        <Archive className="h-4 w-4" />
                        <span className="min-w-0 flex-1">Archive session</span>
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="relative col-span-2 row-start-2 flex flex-wrap items-center gap-1.5" ref={tagEditorRef}>
        {sessionTags.map((tag) => (
          <Badge key={tag} className="gap-1 border border-border bg-background text-foreground">
            {tag}
            {props.canWriteSession && props.selectedSession.status !== 'archived' ? (
              <button
                type="button"
                className="hover:text-foreground"
                disabled={savingTags}
                onClick={() => {
                  void saveTags(sessionTags.filter((candidate) => candidate !== tag));
                }}
                aria-label={`Remove ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </Badge>
        ))}
        {props.canWriteSession && props.selectedSession.status !== 'archived' ? (
          <>
            <button
              ref={tagButtonRef}
              className="group inline-flex rounded-md border-0 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={savingTags}
              onClick={() => setTagPopoverOpen((open) => !open)}
              aria-expanded={tagPopoverOpen}
              aria-haspopup="listbox"
            >
              <Badge className="border border-dashed border-muted-foreground/40 bg-muted/30 text-muted-foreground group-hover:border-muted-foreground/70 group-hover:bg-muted/60 group-hover:text-foreground">
                + Tag
              </Badge>
            </button>
            {tagPopoverOpen ? (
              <div
                className="absolute top-[calc(100%+0.5rem)] z-40 w-80 max-w-full rounded-md border border-border bg-card p-2 text-sm text-card-foreground shadow-lg"
                style={{ left: tagPopoverLeft }}
              >
                <Input
                  className="h-8 text-xs"
                  placeholder="Search or create tag..."
                  value={tagDraft}
                  disabled={savingTags}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    void addTag(tagDraft);
                  }}
                />
                <div className="mt-2 max-h-52 overflow-auto" role="listbox">
                  {filteredTagOptions.map((option) => (
                    <button
                      key={option.tag}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={savingTags}
                      role="option"
                      onClick={() => {
                        void addTag(option.tag);
                      }}
                    >
                      <span className="min-w-0 truncate">{option.tag}</span>
                    </button>
                  ))}
                  {canCreateTag ? (
                    <button
                      type="button"
                      className="mt-1 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={savingTags}
                      onClick={() => {
                        void addTag(tagDraft);
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span className="min-w-0 truncate">Create "{tagQuery}"</span>
                    </button>
                  ) : null}
                  {!filteredTagOptions.length && !canCreateTag ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">{tagPickerEmptyMessage}</p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function normalizeTagDraft(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function compareTagNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function workspaceToolUnavailableReason(session: Session): string {
  if (!session.sandbox) return 'Start a run to create a workspace before opening tools.';
  if (session.sandbox.status === 'destroyed') return 'This workspace was destroyed. Start a fresh run to use tools.';
  return '';
}
