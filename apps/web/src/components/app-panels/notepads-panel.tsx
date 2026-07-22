import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  ApiError,
  getExplicitNotepad,
  getSessionNotepad,
  getSessionNotepadMetadata,
  listSessionNotepadAssociations,
  replaceExplicitNotepad,
  replaceSessionNotepad,
  type ExplicitNotepad,
  type Session,
  type SessionNotepad,
  type SessionNotepadMetadata,
  type SessionNotepadAssociation,
} from '../../api.js';
import { MarkdownText } from '../thread/thread-content.js';

const maxBytes = 256 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const button = 'rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50';

export function ResponsiveNotepadsPanel(props: {
  session: Session;
  token: string;
  canWrite: boolean;
  changeRevisions?: ReadonlyMap<string, number>;
  associationVersion?: number;
  mobileHost: RefObject<HTMLDivElement | null>;
  desktopHost: RefObject<HTMLDivElement | null>;
}) {
  const [container] = useState(() => document.createElement('div'));

  useEffect(() => {
    const desktop = window.matchMedia?.('(min-width: 1280px)');
    function moveToVisibleHost() {
      const host =
        (desktop?.matches ?? window.innerWidth >= 1280) ? props.desktopHost.current : props.mobileHost.current;
      if (!host || container.parentElement === host) return;
      const focused = container.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
      const selection: [number, number] | undefined =
        focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] : undefined;
      const activeInteraction = Boolean(focused || document.querySelector('[data-expanded-notepad]'));
      const mobileDetails = host === props.mobileHost.current ? host.closest('details') : null;
      if (activeInteraction && mobileDetails instanceof HTMLDetailsElement) mobileDetails.open = true;

      const movableHost = host as HTMLDivElement & {
        moveBefore?: (node: Node, child: Node | null) => void;
      };
      if (movableHost.moveBefore && container.isConnected && host.isConnected) movableHost.moveBefore(container, null);
      else host.append(container);
      if (focused && document.activeElement !== focused) {
        focused.focus();
        if (focused instanceof HTMLTextAreaElement && selection) focused.setSelectionRange(selection[0], selection[1]);
      }
    }
    moveToVisibleHost();
    if (desktop) desktop.addEventListener('change', moveToVisibleHost);
    else window.addEventListener('resize', moveToVisibleHost);
    return () => {
      if (desktop) desktop.removeEventListener('change', moveToVisibleHost);
      else window.removeEventListener('resize', moveToVisibleHost);
      container.remove();
    };
  }, [container, props.desktopHost, props.mobileHost]);

  return createPortal(
    <NotepadsPanel
      session={props.session}
      token={props.token}
      canWrite={props.canWrite}
      {...(props.changeRevisions ? { changeRevisions: props.changeRevisions } : {})}
      associationVersion={props.associationVersion ?? 0}
    />,
    container,
  );
}

export function NotepadsPanel(props: {
  session: Session;
  token: string;
  canWrite: boolean;
  changeRevisions?: ReadonlyMap<string, number>;
  associationVersion?: number;
}) {
  const [notepad, setNotepad] = useState<SessionNotepadMetadata | null>(null);
  const [associations, setAssociations] = useState<SessionNotepadAssociation[]>([]);
  const [associationCursor, setAssociationCursor] = useState<string | null>(null);
  const [associationsHaveMore, setAssociationsHaveMore] = useState(false);
  const [loadingMoreAssociations, setLoadingMoreAssociations] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadedSessionId, setLoadedSessionId] = useState(props.session.id);
  const epoch = useRef(0);
  const associationEpoch = useRef(0);
  const observedAssociationVersion = useRef(props.associationVersion ?? 0);

  async function reload() {
    const current = ++epoch.current;
    const currentAssociation = ++associationEpoch.current;
    setLoading(true);
    setError('');
    try {
      const [next, linked] = await Promise.all([
        getSessionNotepadMetadata({ sessionId: props.session.id, token: props.token }),
        listSessionNotepadAssociations({ sessionId: props.session.id, token: props.token }),
      ]);
      if (current !== epoch.current) return;
      setNotepad(next);
      if (currentAssociation === associationEpoch.current) {
        setAssociations(linked.items);
        setAssociationsHaveMore(linked.hasMore);
        setAssociationCursor(linked.nextCursor);
      }
      setLoadedSessionId(props.session.id);
    } catch (reason) {
      if (current === epoch.current) setError(message(reason));
    } finally {
      if (current === epoch.current) setLoading(false);
    }
  }

  useEffect(() => {
    setNotepad(null);
    setAssociations([]);
    setAssociationsHaveMore(false);
    setAssociationCursor(null);
    void reload();
    return () => void ++epoch.current;
  }, [props.session.id, props.token]);

  useEffect(() => {
    const version = props.associationVersion ?? 0;
    if (observedAssociationVersion.current === version) return;
    observedAssociationVersion.current = version;
    const current = epoch.current;
    const currentAssociation = ++associationEpoch.current;
    setLoadingMoreAssociations(false);
    setError('');
    void listSessionNotepadAssociations({ sessionId: props.session.id, token: props.token })
      .then((linked) => {
        if (current !== epoch.current || currentAssociation !== associationEpoch.current) return;
        setAssociations(linked.items);
        setAssociationsHaveMore(linked.hasMore);
        setAssociationCursor(linked.nextCursor);
      })
      .catch((reason) => {
        if (current === epoch.current && currentAssociation === associationEpoch.current) setError(message(reason));
      });
  }, [props.associationVersion, props.session.id, props.token]);

  const writable = props.canWrite && props.session.status !== 'archived';
  const currentNotepad = loadedSessionId === props.session.id ? notepad : null;
  const currentAssociations = loadedSessionId === props.session.id ? associations : [];
  async function loadMoreAssociations() {
    if (!associationCursor || loadingMoreAssociations) return;
    const current = epoch.current;
    const currentAssociation = associationEpoch.current;
    setLoadingMoreAssociations(true);
    setError('');
    try {
      const page = await listSessionNotepadAssociations({
        sessionId: props.session.id,
        token: props.token,
        cursor: associationCursor,
      });
      if (current !== epoch.current || currentAssociation !== associationEpoch.current) return;
      setAssociations((existing) => {
        const visibleIds = new Set(existing.map((item) => item.notepadId));
        const additions = page.items.filter((item) => {
          if (visibleIds.has(item.notepadId)) return false;
          visibleIds.add(item.notepadId);
          return true;
        });
        return [...existing, ...additions];
      });
      setAssociationsHaveMore(page.hasMore);
      setAssociationCursor(page.nextCursor);
    } catch (reason) {
      if (current === epoch.current && currentAssociation === associationEpoch.current) setError(message(reason));
    } finally {
      if (current === epoch.current && currentAssociation === associationEpoch.current)
        setLoadingMoreAssociations(false);
    }
  }
  return (
    <section className="mt-4 grid min-w-0 gap-3 overflow-hidden border-t border-border pt-4" aria-label="Notepads">
      <strong className="text-xs text-foreground">Notepads</strong>
      <div className="grid min-w-0 gap-2">
        <SessionRow
          key={props.session.id}
          metadata={currentNotepad}
          sessionId={props.session.id}
          token={props.token}
          writable={writable}
          {...remoteRevision(props.changeRevisions?.get(`session:${props.session.id}`))}
        />
        {loading ? <span className="text-xs text-muted-foreground">Loading notepads…</span> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {currentAssociations.map((association) => (
          <ExplicitRow
            key={association.notepadId}
            association={association}
            sessionId={props.session.id}
            token={props.token}
            writable={writable}
            {...remoteRevision(props.changeRevisions?.get(`explicit:${association.notepadId}`))}
          />
        ))}
        {associationsHaveMore && associationCursor ? (
          <button
            type="button"
            className={`${button} justify-self-start`}
            disabled={loadingMoreAssociations}
            onClick={() => void loadMoreAssociations()}
          >
            {loadingMoreAssociations ? 'Loading…' : 'Load more'}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function SessionRow(props: {
  metadata: SessionNotepadMetadata | null;
  sessionId: string;
  token: string;
  writable: boolean;
  remoteRevision?: number;
}) {
  const [openRequest, setOpenRequest] = useState(0);
  const [value, setValue] = useState<SessionNotepad | null>(null);
  const [error, setError] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const readGeneration = useRef(0);
  async function select() {
    const generation = ++readGeneration.current;
    setError('');
    try {
      const latest = await getSessionNotepad({ sessionId: props.sessionId, token: props.token });
      if (generation !== readGeneration.current) return;
      setValue(latest);
      setOpenRequest((request) => request + 1);
    } catch (reason) {
      if (generation === readGeneration.current) setError(message(reason));
    }
  }
  useEffect(() => () => void ++readGeneration.current, [props.sessionId, props.token]);
  const metadata = value ?? props.metadata;
  const newestKnownRevision = Math.max(props.remoteRevision ?? 0, props.metadata?.revision ?? 0);
  const changed = newestKnownRevision > (value?.revision ?? props.metadata?.revision ?? 0);
  return (
    <div>
      <button
        ref={opener}
        type="button"
        aria-label="Open Session Notepad in expanded view"
        className="grid w-full min-w-0 cursor-pointer gap-0.5 overflow-hidden rounded border border-border p-2 text-left hover:bg-accent"
        onClick={() => void select()}
      >
        <span className="flex items-center justify-between gap-2">
          <strong className="min-w-0 truncate text-sm text-foreground">Session Notepad</strong>
          <span className="flex shrink-0 items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full bg-warning ${changed ? '' : 'invisible'}`}
              aria-label={changed ? 'Newer revision available' : undefined}
              aria-hidden={changed ? undefined : true}
              title={changed ? 'Newer revision available' : undefined}
            />
            <span className="text-[10px] uppercase text-muted-foreground">
              {props.writable ? 'Editable' : 'Read only'}
            </span>
          </span>
        </span>
        <span className="block truncate whitespace-nowrap text-[10px] text-muted-foreground">
          Updated {metadata ? new Date(metadata.updatedAt).toLocaleString() : 'never'}
        </span>
      </button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {value ? (
        <NotepadEditor
          label="Session Notepad"
          value={value}
          writable={props.writable}
          empty="Durable working memory shared by agents and humans. It is created on first write."
          save={(content, expectedRevision) =>
            replaceSessionNotepad({
              sessionId: props.sessionId,
              content,
              expectedRevision,
              token: props.token,
            })
          }
          reload={() => getSessionNotepad({ sessionId: props.sessionId, token: props.token })}
          onChange={setValue}
          readGeneration={readGeneration}
          remoteRevision={newestKnownRevision}
          initiallyExpanded
          openRequest={openRequest}
          compact={false}
          onClose={() => {
            opener.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function ExplicitRow(props: {
  association: SessionNotepadAssociation;
  sessionId: string;
  token: string;
  writable: boolean;
  remoteRevision?: number;
}) {
  const [openRequest, setOpenRequest] = useState(0);
  const [value, setValue] = useState<ExplicitNotepad | null>(null);
  const [error, setError] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const readGeneration = useRef(0);
  async function select() {
    const generation = ++readGeneration.current;
    setError('');
    try {
      const latest = await getExplicitNotepad({
        id: props.association.notepad.id,
        token: props.token,
        associatedSessionId: props.sessionId,
      });
      if (generation !== readGeneration.current) return;
      setValue(latest);
      setOpenRequest((request) => request + 1);
    } catch (reason) {
      if (generation === readGeneration.current) setError(message(reason));
    }
  }
  useEffect(() => () => void ++readGeneration.current, [props.association.notepad.id, props.sessionId, props.token]);
  const n = props.association.notepad;
  const metadata = value ?? n;
  const writable = props.writable && props.association.canWrite;
  const changed = (props.remoteRevision ?? 0) > metadata.revision;
  return (
    <div className="group relative min-w-0">
      <button
        ref={opener}
        type="button"
        aria-label={`Open ${n.title} in expanded view`}
        className="grid w-full min-w-0 cursor-pointer gap-0.5 overflow-hidden rounded border border-border p-2 text-left hover:bg-accent"
        onClick={() => void select()}
      >
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{n.title}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full bg-warning ${changed ? '' : 'invisible'}`}
              aria-label={changed ? 'Newer revision available' : undefined}
              aria-hidden={changed ? undefined : true}
              title={changed ? 'Newer revision available' : undefined}
            />
            <span className="text-[10px] uppercase text-muted-foreground">{writable ? 'Editable' : 'Read only'}</span>
          </span>
        </span>
        <span className="block truncate whitespace-nowrap text-[10px] text-muted-foreground">
          Updated {new Date(metadata.updatedAt).toLocaleString()}
        </span>
      </button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {value ? (
        <NotepadEditor
          key={value.id}
          label={value.title}
          value={value}
          writable={writable}
          empty="This Notepad is empty."
          save={(content, expectedRevision) =>
            replaceExplicitNotepad({
              id: value.id,
              content,
              expectedRevision,
              token: props.token,
              associatedSessionId: props.sessionId,
            })
          }
          reload={() => getExplicitNotepad({ id: value.id, token: props.token, associatedSessionId: props.sessionId })}
          onChange={setValue}
          readGeneration={readGeneration}
          {...remoteRevision(props.remoteRevision)}
          initiallyExpanded
          openRequest={openRequest}
          compact={false}
          onClose={() => opener.current?.focus()}
        />
      ) : null}
    </div>
  );
}

function NotepadEditor<T extends SessionNotepad | ExplicitNotepad>(props: {
  label: string;
  value: T | null;
  writable: boolean;
  empty: string;
  save: (content: string, revision: number) => Promise<T>;
  reload: () => Promise<T>;
  onChange: (value: T) => void;
  readGeneration: { current: number };
  remoteRevision?: number;
  initiallyExpanded?: boolean;
  openRequest?: number;
  compact?: boolean;
  onClose?: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(''),
    [error, setError] = useState('');
  const [conflict, setConflict] = useState<T | null>(null);
  const [stale, setStale] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const mutationPendingRef = useRef(false);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [baseContent, setBaseContent] = useState('');
  const [expanded, setExpanded] = useState(Boolean(props.initiallyExpanded));
  const expandButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const size = bytes(draft);
  const changedElsewhere = (props.remoteRevision ?? 0) > (props.value?.revision ?? 0);

  useEffect(() => {
    if (props.openRequest) setExpanded(true);
  }, [props.openRequest]);

  function closeExpanded() {
    setExpanded(false);
    props.onClose?.();
  }

  function trapFocus(event: {
    key: string;
    shiftKey: boolean;
    target: EventTarget | null;
    preventDefault: () => void;
  }) {
    if (event.key !== 'Tab') return;
    const focusable = [
      ...(dialog.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ].filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const focused = event.target instanceof HTMLElement ? event.target : document.activeElement;
    if (!dialog.current?.contains(focused)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && focused === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && focused === last) {
      event.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    if (
      editing &&
      props.value &&
      !stale &&
      !conflict &&
      baseRevision !== null &&
      (props.value.revision !== baseRevision || props.value.content !== baseContent)
    ) {
      setConflict(props.value);
      setStale(true);
      setError('This Notepad changed elsewhere. Your draft is preserved.');
    }
  }, [baseContent, baseRevision, conflict, editing, props.value, stale]);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeExpanded();
        return;
      }
      if (!event.defaultPrevented) trapFocus(event);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      if (expandButton.current?.isConnected) expandButton.current.focus();
    };
  }, [expanded]);

  async function save() {
    if (!props.writable || baseRevision === null || mutationPendingRef.current) return;
    mutationPendingRef.current = true;
    setMutationPending(true);
    setError('');
    try {
      const next = await props.save(draft, baseRevision);
      props.onChange(next);
      setBaseRevision(next.revision);
      setBaseContent(next.content);
      setConflict(null);
      setStale(false);
      setEditing(false);
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.code === 'stale_revision'
          ? 'This Notepad changed elsewhere. Your draft is preserved.'
          : message(reason),
      );
      if (reason instanceof ApiError && reason.code === 'stale_revision') {
        setConflict(null);
        setStale(true);
      }
    } finally {
      mutationPendingRef.current = false;
      setMutationPending(false);
    }
  }
  async function reloadLatest() {
    const generation = ++props.readGeneration.current;
    try {
      const latest = await props.reload();
      if (generation !== props.readGeneration.current) return;
      setConflict(latest);
      setError('Latest revision loaded separately. Choose which content to keep.');
    } catch (reason) {
      if (generation === props.readGeneration.current) setError(message(reason));
    }
  }
  async function refreshLatest() {
    const generation = ++props.readGeneration.current;
    setError('');
    try {
      const latest = await props.reload();
      if (generation === props.readGeneration.current) props.onChange(latest);
    } catch (reason) {
      if (generation === props.readGeneration.current) setError(message(reason));
    }
  }
  function useLatest() {
    if (!conflict) return;
    props.onChange(conflict);
    setDraft(conflict.content);
    setBaseRevision(conflict.revision);
    setBaseContent(conflict.content);
    setConflict(null);
    setStale(false);
    setError('Using the latest server revision.');
  }
  async function overwriteLatest() {
    if (
      !props.writable ||
      !conflict ||
      mutationPendingRef.current ||
      !window.confirm('Overwrite the latest server revision with your stale draft?')
    )
      return;
    mutationPendingRef.current = true;
    setMutationPending(true);
    setError('');
    try {
      const next = await props.save(draft, conflict.revision);
      props.onChange(next);
      setBaseRevision(next.revision);
      setBaseContent(next.content);
      setConflict(null);
      setStale(false);
      setEditing(false);
    } catch (reason) {
      setError(message(reason));
    } finally {
      mutationPendingRef.current = false;
      setMutationPending(false);
    }
  }
  const editor = (
    <div className={expanded ? 'flex h-full min-h-0 flex-col gap-3' : 'grid gap-2'}>
      <div className="flex items-center justify-between gap-2">
        <strong className={`${expanded ? 'text-lg' : 'text-sm'} min-w-0 truncate text-foreground`} title={props.label}>
          {props.label}
        </strong>
        <div className="flex shrink-0 gap-1">
          {props.value && props.writable && !editing ? (
            <button
              className={button}
              onClick={() => {
                setDraft(props.value?.content ?? '');
                setBaseRevision(props.value?.revision ?? null);
                setBaseContent(props.value?.content ?? '');
                setEditing(true);
                setError('');
                setStale(false);
                setConflict(null);
              }}
            >
              Edit
            </button>
          ) : null}
          {expanded ? (
            <button ref={closeButton} className={button} onClick={closeExpanded}>
              Close
            </button>
          ) : props.value ? (
            <button
              ref={expandButton}
              className={button}
              aria-label={`Open ${props.label} in expanded view`}
              onClick={() => setExpanded(true)}
            >
              Expand
            </button>
          ) : null}
        </div>
      </div>
      {changedElsewhere && !editing ? (
        <div className="flex items-center justify-between gap-3 rounded border border-warning/50 bg-warning/10 p-2 text-xs text-warning-foreground">
          <span>Updated elsewhere. Refresh to view revision {props.remoteRevision}.</span>
          <button className={button} onClick={() => void refreshLatest()}>
            Refresh
          </button>
        </div>
      ) : null}
      {editing ? (
        <>
          <textarea
            aria-label={`${props.label} Markdown`}
            className={`${expanded ? 'min-h-0 flex-1 resize-none text-sm' : 'min-h-32 text-xs'} w-full rounded border border-border bg-background p-2 font-mono text-foreground`}
            value={draft}
            readOnly={!props.writable}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex items-center justify-between">
            <span className={size > maxBytes ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {size.toLocaleString()} / {maxBytes.toLocaleString()} bytes
            </span>
            <div className="flex gap-1">
              <button className={button} disabled={mutationPending} onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                className={button}
                disabled={!props.writable || size > maxBytes || stale || changedElsewhere || mutationPending}
                onClick={() => void save()}
              >
                Save
              </button>
            </div>
          </div>
        </>
      ) : props.value?.content ? (
        <div
          className={
            expanded ? 'min-h-0 flex-1 overflow-auto rounded border border-border p-4' : 'max-h-80 overflow-auto'
          }
        >
          <MarkdownText text={props.value.content} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{props.empty}</p>
      )}
      {error || (editing && (changedElsewhere || !props.writable)) ? (
        <div className={`${expanded ? 'min-h-0 overflow-y-auto' : ''} text-xs text-destructive`}>
          {editing && !props.writable
            ? 'This Notepad is now read-only. Your draft is preserved.'
            : editing && changedElsewhere
              ? 'This Notepad changed elsewhere. Your draft is preserved.'
              : error}{' '}
          {editing && (changedElsewhere || error.includes('changed elsewhere')) ? (
            <button className="underline" onClick={() => void reloadLatest()}>
              Reload latest
            </button>
          ) : null}
          {editing && conflict ? (
            <div className="mt-2 grid gap-2 rounded border border-border p-2 text-foreground">
              <strong>Latest server content (revision {conflict.revision})</strong>
              <div className="max-h-40 overflow-auto">
                <MarkdownText text={conflict.content} />
              </div>
              <strong>Your unsaved draft</strong>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">{draft}</pre>
              <div className="flex gap-2">
                <button className={button} disabled={mutationPending} onClick={useLatest}>
                  Use latest
                </button>
                <button
                  className={button}
                  disabled={!props.writable || mutationPending}
                  onClick={() => void overwriteLatest()}
                >
                  Overwrite latest
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
  if (!expanded) {
    if (props.compact === false) return null;
    return (
      <button
        ref={expandButton}
        type="button"
        aria-label={`Open ${props.label} in expanded view`}
        className="grid w-full gap-1 rounded border border-border p-3 text-left hover:bg-accent"
        onClick={() => setExpanded(true)}
      >
        <span className="flex items-center justify-between gap-2">
          <strong className="min-w-0 truncate text-sm text-foreground">{props.label}</strong>
          <span className="flex shrink-0 items-center gap-1.5">
            {changedElsewhere ? (
              <span
                className="h-2 w-2 rounded-full bg-warning"
                aria-label="Newer revision available"
                title="Newer revision available"
              />
            ) : null}
            <span className="text-[10px] uppercase text-muted-foreground">
              {props.writable ? 'Editable' : 'Read only'}
            </span>
          </span>
        </span>
        <span className="text-[10px] text-muted-foreground">
          Updated {props.value ? new Date(props.value.updatedAt).toLocaleString() : 'never'}
        </span>
      </button>
    );
  }
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-2 md:p-6"
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) closeExpanded();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`${props.label} expanded editor`}
        data-expanded-notepad
        onKeyDown={trapFocus}
        className="h-[calc(100dvh-1rem)] w-full min-w-0 overflow-hidden rounded-lg border border-border bg-card p-4 text-card-foreground shadow-2xl md:h-[calc(100dvh-3rem)] md:w-[min(92vw,90rem)] md:p-6"
      >
        {editor}
      </div>
    </div>,
    document.body,
  );
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : 'Notepad request failed.';
}

function remoteRevision(value: number | undefined): { remoteRevision?: number } {
  return value === undefined ? {} : { remoteRevision: value };
}
