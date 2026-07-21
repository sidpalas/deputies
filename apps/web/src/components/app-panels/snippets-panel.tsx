import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, PanelLeftOpen, RotateCcw, Save } from 'lucide-react';
import type { Snippet } from '../../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';
import { slugNameValidationError } from './shared.js';
import { useEditorDirty } from './use-editor-dirty.js';

export function SnippetsPanel(props: {
  snippet: Snippet | null;
  selectedId: string;
  loading: boolean;
  mutationPending: boolean;
  readOnly?: boolean;
  showOpenSidebar: boolean;
  onOpenSidebar: () => void;
  onSave: (input: { snippetId?: string; name?: string; body?: string }) => Promise<Snippet | null>;
  onChanged: (snippet: Snippet) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  const selectedIdRef = useRef(props.selectedId);
  const editVersionRef = useRef(0);
  const editorKeyRef = useRef(`${props.selectedId}\u0000${props.snippet?.id ?? ''}`);
  selectedIdRef.current = props.selectedId;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    const editorKey = `${props.selectedId}\u0000${props.snippet?.id ?? ''}`;
    if (editorKeyRef.current !== editorKey) {
      editorKeyRef.current = editorKey;
      editVersionRef.current += 1;
    }
    setName(props.snippet?.name ?? '');
    setBody(props.snippet?.body ?? '');
  }, [props.snippet?.id, props.snippet?.updatedAt]);
  const dirty = name !== (props.snippet?.name ?? '') || body !== (props.snippet?.body ?? '');
  useEditorDirty(dirty, props.onDirtyChange);
  const nameError = slugNameValidationError(name);
  const valid = Boolean(name) && !nameError && Boolean(body.trim()) && new TextEncoder().encode(body).length <= 65536;
  async function save() {
    if (props.readOnly || !valid || !dirty || saving || props.mutationPending) return;
    const selectedId = props.selectedId;
    const editVersion = editVersionRef.current;
    setSaving(true);
    try {
      const snippet = await props.onSave(
        props.snippet
          ? {
              snippetId: props.snippet.id,
              ...(name !== props.snippet.name ? { name } : {}),
              ...(body !== props.snippet.body ? { body } : {}),
            }
          : { name, body },
      );
      if (
        !snippet ||
        !mountedRef.current ||
        selectedIdRef.current !== selectedId ||
        editVersionRef.current !== editVersion
      )
        return;
      setName(snippet.name);
      setBody(snippet.body);
      props.onChanged(snippet);
    } catch (error) {
      if (mountedRef.current && selectedIdRef.current === selectedId && editVersionRef.current === editVersion)
        props.onError(error);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="h-full overflow-y-auto px-4 py-6 md:px-8 xl:px-14">
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex items-start gap-3">
          {props.showOpenSidebar ? (
            <Button variant="ghost" size="icon" onClick={props.onOpenSidebar} aria-label="Open snippets">
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          ) : null}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">Snippets</p>
            <h1 className="mt-1 text-2xl font-semibold">Prompt snippets</h1>
            <p className="text-sm text-muted-foreground">
              Personal reusable text expanded with <code>//name</code>.
            </p>
          </div>
        </div>
        {props.selectedId && !props.snippet ? (
          <Card className="p-5">{props.loading ? 'Loading snippet' : 'Snippet not found'}</Card>
        ) : (
          <Card className="p-5">
            <h2 className="text-lg font-semibold">{props.snippet ? 'Edit snippet' : 'New snippet'}</h2>
            {props.snippet?.archivedAt ? (
              <p className="mt-3 rounded border p-3 text-sm text-muted-foreground">
                This snippet is archived. Restore it before editing.
              </p>
            ) : null}
            <form
              className="mt-5 grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label className="grid gap-1 text-sm font-medium">
                Name
                <Input
                  aria-label="Name"
                  value={name}
                  onChange={(e) => {
                    editVersionRef.current += 1;
                    setName(e.target.value);
                  }}
                  disabled={props.readOnly || saving || props.mutationPending || Boolean(props.snippet?.archivedAt)}
                  aria-invalid={Boolean(nameError)}
                  aria-describedby={nameError ? 'snippet-name-error' : undefined}
                />
                {nameError ? (
                  <p id="snippet-name-error" className="text-xs font-normal text-destructive">
                    {nameError}
                  </p>
                ) : (
                  <p className="text-xs font-normal text-muted-foreground">
                    {name ? (
                      <>
                        Insert with <code>//{name}</code>.
                      </>
                    ) : (
                      'Enter the name without the // prefix.'
                    )}
                  </p>
                )}
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Body
                <Textarea
                  aria-label="Body"
                  className="min-h-80"
                  value={body}
                  onChange={(e) => {
                    editVersionRef.current += 1;
                    setBody(e.target.value);
                  }}
                  disabled={props.readOnly || saving || props.mutationPending || Boolean(props.snippet?.archivedAt)}
                />
              </label>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={
                    props.readOnly ||
                    !valid ||
                    !dirty ||
                    saving ||
                    props.mutationPending ||
                    Boolean(props.snippet?.archivedAt)
                  }
                >
                  <Save className="h-4 w-4" />
                  {props.snippet ? 'Save snippet' : 'Create snippet'}
                </Button>
                {props.snippet && !props.readOnly ? (
                  props.snippet.archivedAt ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={dirty || saving || props.mutationPending}
                      onClick={() => props.onRestore(props.snippet!.id)}
                    >
                      <RotateCcw className="h-4 w-4" />
                      Restore snippet
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={dirty || saving || props.mutationPending}
                      onClick={() => props.onArchive(props.snippet!.id)}
                    >
                      <Archive className="h-4 w-4" />
                      Archive snippet
                    </Button>
                  )
                ) : null}
              </div>
            </form>
          </Card>
        )}
      </div>
    </section>
  );
}

export function useFilteredSnippets(snippets: Snippet[], search: string) {
  return useMemo(
    () =>
      snippets.filter(
        (item) => !search.trim() || `${item.name} ${item.body}`.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [snippets, search],
  );
}
